pub mod auth;
mod chats;
mod contacts;
mod debug;
mod events;
mod messages;
mod sessions;
mod status;
mod vnc;

use axum::{
    extract::DefaultBodyLimit,
    http::Method,
    routing::{get, post},
    Json, Router,
};
use tower_http::cors::{Any, CorsLayer};

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok"}))
}

/// Build the full axum Router.
pub fn build_router() -> Router {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_origin(Any)
        .allow_headers(Any);

    Router::new()
        // Health (exempt from auth via middleware check)
        .route("/health", get(health))
        // Status
        .route("/api/status", get(status::get_status))
        .route("/api/status/auth", get(status::auth_status))
        .route("/api/status/outbound", get(status::outbound_status))
        .route("/api/status/outbound/pause", post(status::pause_outbound))
        .route("/api/status/outbound/resume", post(status::resume_outbound))
        .route("/api/status/login", post(status::login))
        .route("/api/status/logout", post(status::logout))
        // Chats
        .route("/api/chats", get(chats::list_chats))
        .route("/api/chats/{id}", get(chats::get_chat))
        .route("/api/chats/find", get(chats::find_chats))
        .route("/api/chats/{id}/open", post(chats::open_chat))
        // Contacts
        .route("/api/contacts", get(contacts::list_contacts))
        .route("/api/contacts/find", get(contacts::find_contacts))
        // Messages
        .route("/api/messages/{chat_id}", get(messages::list_messages))
        .route(
            "/api/messages/{chat_id}/media/{local_id}",
            get(messages::get_media),
        )
        .route("/api/messages/send", post(messages::send_message))
        // Debug
        .route("/api/debug/screenshot", get(debug::screenshot))
        .route("/api/debug/a11y", get(debug::a11y))
        // Sessions
        .route(
            "/api/sessions",
            get(sessions::list_sessions).post(sessions::create_session),
        )
        .route(
            "/api/sessions/{id}",
            get(sessions::get_session).delete(sessions::delete_session),
        )
        .route("/api/sessions/{id}/start", post(sessions::start_session))
        .route("/api/sessions/{id}/stop", post(sessions::stop_session))
        // WebSocket for login subscription
        .route("/api/ws/login", get(status::login_ws))
        // Events WebSocket
        .route("/api/ws/events", get(events::events_ws))
        // VNC: WebSocket proxy + static files (behind auth)
        .route("/vnc/websockify", get(vnc::vnc_ws))
        .route("/vnc/{*path}", get(vnc::vnc_static))
        .route("/vnc/", get(vnc::vnc_static))
        // Middleware: auth → body limit → CORS (applied bottom-up)
        .layer(axum::middleware::from_fn(auth::auth_middleware))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024)) // 50 MB for media uploads
        .layer(cors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{header::AUTHORIZATION, Request, StatusCode},
    };
    use serde_json::Value;
    use std::sync::OnceLock;
    use tower::ServiceExt;

    static TEST_DB_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

    async fn init_test_server_state() {
        let db_dir = TEST_DB_DIR.get_or_init(|| tempfile::TempDir::new().unwrap());
        std::env::set_var("AGENT_DB_PATH", db_dir.path().join("agent.db"));
        std::env::set_var("AGENT_WECHAT_TOKEN", "test-token");
        std::env::set_var("AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS", "1000");
        std::env::set_var("AGENT_WECHAT_OUTBOUND_JITTER_MS", "0");
        std::env::set_var("AGENT_WECHAT_OUTBOUND_TASK_TTL_MS", "5000");
        std::env::remove_var("AGENT_WECHAT_OUTBOUND_DISABLED");
        std::env::remove_var("AGENT_WECHAT_READ_ONLY");
        auth::init_token();
        let _ = crate::db::init_db();
        let _ = crate::sessions::manager::get_or_create_default_session().await;
    }

    fn authed(method: &str, uri: &str, body: Body) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(AUTHORIZATION, "Bearer test-token")
            .header("content-type", "application/json")
            .body(body)
            .unwrap()
    }

    async fn json_response(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn authenticated_outbound_pause_rejects_queued_send_until_explicit_resume() {
        init_test_server_state().await;
        let app = build_router();

        let resume = app
            .clone()
            .oneshot(authed("POST", "/api/status/outbound/resume", Body::empty()))
            .await
            .unwrap();
        assert_eq!(resume.status(), StatusCode::OK);
        let resume_body = json_response(resume).await;
        assert_eq!(resume_body["runtimePaused"], false);

        let first = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(r#"{"chatId":"chat","text":"first"}"#),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let pending_app = app.clone();
        let pending = tokio::spawn(async move {
            pending_app
                .oneshot(authed(
                    "POST",
                    "/api/messages/send",
                    Body::from(r#"{"chatId":"chat","text":"second","idempotencyKey":"api-pause"}"#),
                ))
                .await
                .unwrap()
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let pause = app
            .clone()
            .oneshot(authed("POST", "/api/status/outbound/pause", Body::empty()))
            .await
            .unwrap();
        assert_eq!(pause.status(), StatusCode::OK);
        let pause_body = json_response(pause).await;
        assert_eq!(pause_body["readOnly"], true);
        assert_eq!(pause_body["runtimePaused"], true);

        let rejected = pending.await.unwrap();
        assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
        let rejected_body = json_response(rejected).await;
        assert_eq!(rejected_body["success"], false);
        assert_eq!(rejected_body["errorCode"], "OUTBOUND_DISABLED");

        let still_paused = app
            .clone()
            .oneshot(authed("GET", "/api/status/outbound", Body::empty()))
            .await
            .unwrap();
        assert_eq!(still_paused.status(), StatusCode::OK);
        let still_paused_body = json_response(still_paused).await;
        assert_eq!(still_paused_body["runtimePaused"], true);

        let blocked_new = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(r#"{"chatId":"chat","text":"third"}"#),
            ))
            .await
            .unwrap();
        assert_eq!(blocked_new.status(), StatusCode::SERVICE_UNAVAILABLE);
        let blocked_new_body = json_response(blocked_new).await;
        assert_eq!(blocked_new_body["errorCode"], "OUTBOUND_DISABLED");

        let explicit_resume = app
            .clone()
            .oneshot(authed("POST", "/api/status/outbound/resume", Body::empty()))
            .await
            .unwrap();
        assert_eq!(explicit_resume.status(), StatusCode::OK);
        let explicit_resume_body = json_response(explicit_resume).await;
        assert_eq!(explicit_resume_body["runtimePaused"], false);
        assert_eq!(explicit_resume_body["readOnly"], false);
    }
}
