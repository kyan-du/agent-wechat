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
        .route(
            "/api/status/outbound/idempotency/{key}",
            get(status::outbound_idempotency_status),
        )
        .route(
            "/api/status/outbound/idempotency/{key}/reconcile",
            post(status::reconcile_outbound_idempotency),
        )
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

    fn tmp_send_artifact_count() -> usize {
        std::fs::read_dir("/tmp")
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("send_image_") || name.starts_with("send_file_")
            })
            .count()
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

        let pause = app
            .clone()
            .oneshot(authed("POST", "/api/status/outbound/pause", Body::empty()))
            .await
            .unwrap();
        assert_eq!(pause.status(), StatusCode::OK);
        let pause_body = json_response(pause).await;
        assert_eq!(pause_body["readOnly"], true);
        assert_eq!(pause_body["runtimePaused"], true);

        let rejected = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(
                    r#"{"chatId":"chat","text":"second","idempotencyKey":"api-pause-route"}"#,
                ),
            ))
            .await
            .unwrap();
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

    #[tokio::test]
    async fn idempotency_status_requires_auth_and_redacts_sensitive_payload_data() {
        init_test_server_state().await;
        {
            let db = crate::db::get_db();
            db.execute(
                "DELETE FROM outbound_idempotency WHERE key = 'route-redact'",
                [],
            )
            .unwrap();
            crate::db::queries::insert_outbound_queued(
                &db,
                "route-redact",
                std::time::Duration::from_secs(60),
            )
            .unwrap();
            crate::db::queries::complete_outbound_result(
                &db,
                "route-redact",
                &crate::ia::types::SendResult {
                    success: false,
                    error_code: Some("TEMP_FILE_WRITE_FAILED".to_string()),
                    error: Some(
                        "failed /tmp/send_file_secret.pdf token=abc QR:base64,AAAA contact Alice"
                            .to_string(),
                    ),
                    commit_attempted: false,
                },
                std::time::Duration::from_secs(60),
            )
            .unwrap();
        }

        let app = build_router();
        let unauth = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/status/outbound/idempotency/route-redact")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        let authed_response = app
            .oneshot(authed(
                "GET",
                "/api/status/outbound/idempotency/route-redact",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(authed_response.status(), StatusCode::OK);
        let body = json_response(authed_response).await;
        assert_eq!(body["key"], "route-redact");
        assert_eq!(body["state"], "failed");
        assert_eq!(body["result"]["errorCode"], "TEMP_FILE_WRITE_FAILED");
        assert_eq!(body["result"]["error"], "TEMP_FILE_WRITE_FAILED");
        let serialized = serde_json::to_string(&body).unwrap();
        for forbidden in [
            "/tmp/send_file_secret.pdf",
            "abc",
            "AAAA",
            "Alice",
            "base64",
            "contact",
        ] {
            assert!(!serialized.contains(forbidden), "{forbidden}");
        }
    }

    #[tokio::test]
    async fn duplicate_terminal_media_request_replays_before_decode_or_temp_write() {
        init_test_server_state().await;
        let app = build_router();
        {
            let db = crate::db::get_db();
            db.execute(
                "DELETE FROM outbound_idempotency WHERE key = 'media-terminal'",
                [],
            )
            .unwrap();
            crate::db::queries::insert_outbound_queued(
                &db,
                "media-terminal",
                std::time::Duration::from_secs(60),
            )
            .unwrap();
            crate::db::queries::complete_outbound_result(
                &db,
                "media-terminal",
                &crate::ia::types::SendResult {
                    success: true,
                    error_code: None,
                    error: None,
                    commit_attempted: true,
                },
                std::time::Duration::from_secs(60),
            )
            .unwrap();
        }
        let before = tmp_send_artifact_count();
        let response = app
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(
                    r#"{"chatId":"chat","idempotencyKey":"media-terminal","image":{"mimeType":"image/png","data":"%%%not-base64%%%"}}"#,
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["success"], true);
        assert_eq!(tmp_send_artifact_count(), before);
    }

    #[tokio::test]
    async fn duplicate_in_progress_media_request_rejects_before_decode_or_temp_write() {
        init_test_server_state().await;
        let app = build_router();
        {
            let db = crate::db::get_db();
            db.execute(
                "DELETE FROM outbound_idempotency WHERE key = 'media-progress'",
                [],
            )
            .unwrap();
            crate::db::queries::insert_outbound_queued(
                &db,
                "media-progress",
                std::time::Duration::from_secs(60),
            )
            .unwrap();
        }
        let before = tmp_send_artifact_count();
        let response = app
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(
                    r#"{"chatId":"chat","idempotencyKey":"media-progress","file":{"filename":"x.txt","data":"%%%not-base64%%%"}}"#,
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = json_response(response).await;
        assert_eq!(body["errorCode"], "IDEMPOTENCY_IN_PROGRESS");
        assert_eq!(tmp_send_artifact_count(), before);
    }

    #[tokio::test]
    async fn send_and_lookup_reject_invalid_idempotency_keys() {
        init_test_server_state().await;
        let app = build_router();
        let response = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(
                    r#"{"chatId":"chat","text":"hi","idempotencyKey":"bad key","file":{"filename":"x.txt","data":"%%%not-base64%%%"}}"#,
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_response(response).await;
        assert_eq!(body["errorCode"], "INVALID_IDEMPOTENCY_KEY");

        let lookup = app
            .oneshot(authed(
                "GET",
                "/api/status/outbound/idempotency/bad%20key",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(lookup.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn manual_reconcile_route_marks_stuck_key_uncertain() {
        init_test_server_state().await;
        let app = build_router();
        {
            let db = crate::db::get_db();
            db.execute(
                "DELETE FROM outbound_idempotency WHERE key = 'route-reconcile'",
                [],
            )
            .unwrap();
            crate::db::queries::insert_outbound_queued(
                &db,
                "route-reconcile",
                std::time::Duration::from_secs(60),
            )
            .unwrap();
        }
        let response = app
            .clone()
            .oneshot(authed(
                "POST",
                "/api/status/outbound/idempotency/route-reconcile/reconcile",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["state"], "uncertain");

        let duplicate = app
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(
                    r#"{"chatId":"chat","text":"retry","idempotencyKey":"route-reconcile"}"#,
                ),
            ))
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::OK);
        let body = json_response(duplicate).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["errorCode"], "MANUAL_RECONCILIATION_REQUIRED");
        assert_eq!(crate::outbound::outbound_sender().status().queue_depth, 0);
    }
}
