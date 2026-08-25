pub mod auth;
mod chats;
mod contacts;
mod debug;
mod events;
mod group_members;
mod messages;
mod sync;
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
        .route("/api/status/auth/reset", post(status::reset_auth))
        // Chats
        .route("/api/chats", get(chats::list_chats))
        .route("/api/chats/{id}", get(chats::get_chat))
        .route("/api/chats/find", get(chats::find_chats))
        .route("/api/chats/{id}/open", post(chats::open_chat))
        .route("/api/chats/{id}/mark-read", post(chats::mark_read))
        .route(
            "/api/groups/{id}/members",
            get(group_members::list_group_members),
        )
        // Contacts
        .route("/api/contacts", get(contacts::list_contacts))
        .route("/api/contacts/find", get(contacts::find_contacts))
        // Messages
        .route("/api/messages/{chat_id}", get(messages::list_messages))
        .route("/api/sync/{chat_id}", get(sync::sync_chat))
        .route(
            "/api/messages/{chat_id}/media/{local_id}",
            get(messages::get_media),
        )
        .route("/api/messages/send", post(messages::send_message))
        // Debug
        .route("/api/debug/screenshot", get(debug::screenshot))
        .route("/api/debug/a11y", get(debug::a11y))
        // WebSocket for login subscription
        .route("/api/ws/login", get(status::login_ws))
        // Events WebSocket
        .route("/api/events", get(events::list_events))
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

    async fn init_test_server_state() -> std::sync::MutexGuard<'static, ()> {
        let guard = crate::outbound::lock_idempotency_tests();
        let db_dir = TEST_DB_DIR.get_or_init(|| tempfile::TempDir::new().unwrap());
        std::env::set_var("AGENT_DB_PATH", db_dir.path().join("agent.db"));
        std::env::set_var("AGENT_WECHAT_TOKEN", "test-token");
        std::env::set_var("AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS", "1000");
        std::env::set_var("AGENT_WECHAT_OUTBOUND_JITTER_MS", "0");
        std::env::set_var("AGENT_WECHAT_OUTBOUND_TASK_TTL_MS", "5000");
        // This test exercises pause/resume, not the host's local quiet-hours clock.
        std::env::set_var("AGENT_WECHAT_QUIET_START_MIN", "0");
        std::env::set_var("AGENT_WECHAT_QUIET_END_MIN", "0");
        std::env::remove_var("AGENT_WECHAT_OUTBOUND_DISABLED");
        std::env::remove_var("AGENT_WECHAT_READ_ONLY");
        auth::init_token();
        let _ = crate::db::init_db();
        let _ = crate::sessions::manager::get_or_create_default_session().await;
        guard
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
    async fn outbound_status_contains_only_redacted_diagnostics() {
        let _idempotency_lock = init_test_server_state().await;
        let response = build_router()
            .oneshot(authed("GET", "/api/status/outbound", Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert!(body["diagnostics"].is_object());
        assert!(body["chatSelectDiagnostics"].is_object());
        let serialized = serde_json::to_string(&body).unwrap();
        for sensitive in [
            "message text",
            "contact display name",
            "/tmp/send_file_secret.pdf",
            "Bearer secret-token",
            "data:image/png;base64",
            "qrData",
        ] {
            assert!(!serialized.contains(sensitive));
        }
    }

    #[tokio::test]
    async fn blank_chat_or_text_is_rejected_before_outbound_execution() {
        let _idempotency_lock = init_test_server_state().await;
        let app = build_router();
        for (payload, code) in [
            (r#"{"chatId":" ","text":"hello"}"#, "INVALID_CHAT_ID"),
            (r#"{"chatId":"chat","text":" \n\t "}"#, "INVALID_TEXT"),
        ] {
            let response = app
                .clone()
                .oneshot(authed("POST", "/api/messages/send", Body::from(payload)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = json_response(response).await;
            assert_eq!(body["success"], false);
            assert_eq!(body["errorCode"], code);
            assert_eq!(body["commitAttempted"], false);
        }
    }

    #[tokio::test]
    async fn authenticated_outbound_pause_rejects_queued_send_until_explicit_resume() {
        let _idempotency_lock = init_test_server_state().await;
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
        let _idempotency_lock = init_test_server_state().await;
        {
            let db = crate::db::get_db();
            db.execute(
                "DELETE FROM outbound_idempotency WHERE key = 'route-redact'",
                [],
            )
            .unwrap();
            let generation = crate::db::queries::insert_outbound_queued(
                &db,
                "route-redact",
                std::time::Duration::from_secs(60),
            )
            .unwrap()
            .unwrap();
            assert!(
                crate::db::queries::mark_outbound_sending(&db, "route-redact", generation).unwrap()
            );
            crate::db::queries::complete_outbound_result(
                &db,
                "route-redact",
                generation,
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
        let _idempotency_lock = init_test_server_state().await;
        let app = build_router();
        {
            let db = crate::db::get_db();
            db.execute(
                "DELETE FROM outbound_idempotency WHERE key = 'media-terminal'",
                [],
            )
            .unwrap();
            let generation = crate::db::queries::insert_outbound_queued(
                &db,
                "media-terminal",
                std::time::Duration::from_secs(60),
            )
            .unwrap()
            .unwrap();
            assert!(
                crate::db::queries::mark_outbound_sending(&db, "media-terminal", generation)
                    .unwrap()
            );
            crate::db::queries::complete_outbound_result(
                &db,
                "media-terminal",
                generation,
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
        let _idempotency_lock = init_test_server_state().await;
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
    async fn invalid_image_base64_after_claim_is_rejected_and_reclaimable() {
        let _idempotency_lock = init_test_server_state().await;
        crate::outbound::outbound_sender().resume();
        let app = build_router();
        let key = "media-invalid-image";
        {
            let db = crate::db::get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }

        let response = app
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(
                    r#"{"chatId":"chat","idempotencyKey":"media-invalid-image","image":{"mimeType":"image/png","data":"%%%not-base64%%%"}}"#,
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["errorCode"], "IMAGE_BASE64_DECODE_FAILED");
        let record = crate::outbound::get_idempotency_status(key).unwrap();
        assert_eq!(
            record.state,
            crate::db::queries::OutboundIdempotencyState::Rejected
        );

        match crate::outbound::outbound_sender().admit_idempotency_key(key) {
            crate::outbound::IdempotencyAdmission::Claimed(mut lease) => lease.disarm(),
            _ => panic!("rejected materialization failure must be reclaimable after restart"),
        }
        assert_eq!(
            crate::outbound::get_idempotency_status(key).unwrap().state,
            crate::db::queries::OutboundIdempotencyState::Queued
        );
    }

    #[tokio::test]
    async fn invalid_file_base64_after_claim_does_not_leave_queued() {
        let _idempotency_lock = init_test_server_state().await;
        crate::outbound::outbound_sender().resume();
        let app = build_router();
        let key = "media-invalid-file";
        {
            let db = crate::db::get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }

        let response = app
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(
                    r#"{"chatId":"chat","idempotencyKey":"media-invalid-file","file":{"filename":"x.txt","data":"%%%not-base64%%%"}}"#,
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["errorCode"], "FILE_BASE64_DECODE_FAILED");
        assert_eq!(
            crate::outbound::get_idempotency_status(key).unwrap().state,
            crate::db::queries::OutboundIdempotencyState::Rejected
        );
    }

    #[tokio::test]
    async fn temp_file_write_failure_after_claim_is_rejected_and_reclaimable() {
        let _idempotency_lock = init_test_server_state().await;
        crate::outbound::outbound_sender().resume();
        let app = build_router();
        let key = "media-write-fail";
        {
            let db = crate::db::get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }
        let long_filename = "a".repeat(300);
        let payload = serde_json::json!({
            "chatId": "chat",
            "idempotencyKey": key,
            "file": {
                "filename": long_filename,
                "data": "aGVsbG8="
            }
        });

        let response = app
            .oneshot(authed(
                "POST",
                "/api/messages/send",
                Body::from(payload.to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["errorCode"], "TEMP_FILE_WRITE_FAILED");
        assert_eq!(
            crate::outbound::get_idempotency_status(key).unwrap().state,
            crate::db::queries::OutboundIdempotencyState::Rejected
        );

        match crate::outbound::outbound_sender().admit_idempotency_key(key) {
            crate::outbound::IdempotencyAdmission::Claimed(mut lease) => lease.disarm(),
            _ => panic!("write failure rejection must be reclaimable after restart"),
        }
    }

    #[tokio::test]
    async fn send_and_lookup_reject_invalid_idempotency_keys() {
        let _idempotency_lock = init_test_server_state().await;
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
        let _idempotency_lock = init_test_server_state().await;
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

    #[test]
    fn ordinary_read_routes_have_no_key_acquisition_capability() {
        let sources = [
            include_str!("chats.rs"),
            include_str!("contacts.rs"),
            include_str!("messages.rs"),
            include_str!("sync.rs"),
        ];
        for source in sources {
            assert!(!source.contains("extract_keys_async"));
            assert!(!source.contains("store_keys"));
            assert!(!source.contains("find_wechat_pid"));
        }
    }

    #[tokio::test]
    async fn list_routes_reject_invalid_limits_and_cursors() {
        let _idempotency_lock = init_test_server_state().await;
        let app = build_router();
        for uri in [
            "/api/chats?limit=0",
            "/api/chats?cursor=not-a-cursor",
            "/api/contacts?limit=201",
            "/api/contacts?cursor=not-a-cursor",
            "/api/messages/chat?limit=-1",
            "/api/messages/chat?cursor=not-a-cursor",
        ] {
            let response = app
                .clone()
                .oneshot(authed("GET", uri, Body::empty()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
            let body = json_response(response).await;
            assert!(
                matches!(
                    body["errorCode"].as_str(),
                    Some("INVALID_LIMIT" | "INVALID_CURSOR")
                ),
                "{uri}: {body}"
            );
        }
    }

    #[tokio::test]
    async fn message_cursor_is_bound_to_its_chat() {
        let _idempotency_lock = init_test_server_state().await;
        let cursor = crate::tools::page_cursor::encode(
            "messages:first",
            ("2026-01-01T00:00:00+00:00", 7_i64),
        )
        .unwrap();
        let uri = format!("/api/messages/second?cursor={cursor}");
        let response = build_router()
            .oneshot(authed("GET", &uri, Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_response(response).await["errorCode"], "INVALID_CURSOR");
    }

    #[tokio::test]
    async fn manual_reconcile_failure_response_and_log_code_are_redacted() {
        let _idempotency_lock = init_test_server_state().await;
        let app = build_router();
        let key = "hostile-secret-key";
        {
            let db = crate::db::get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
            crate::db::queries::insert_outbound_queued(
                &db,
                key,
                std::time::Duration::from_secs(60),
            )
            .unwrap();
        }

        crate::outbound::fail_next_manual_reconcile_with_hostile_error();
        let response = app
            .oneshot(authed(
                "POST",
                "/api/status/outbound/idempotency/hostile-secret-key/reconcile",
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_response(response).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["error"], "IDEMPOTENCY_RECONCILE_FAILED");
        assert!(body.get("key").is_none());
        assert!(body.get("detail").is_none());
        let serialized = serde_json::to_string(&body).unwrap();
        for forbidden in [
            "hostile-secret-key",
            "/Users/kyan/private/agent.db",
            "UPDATE outbound_idempotency",
            "sqlcipher",
            "provider",
        ] {
            assert!(!serialized.contains(forbidden), "{forbidden}");
        }

        let hostile = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ffi::ErrorCode::DatabaseCorrupt,
                extended_code: 0,
            },
            Some(
                "path=/Users/kyan/private/agent.db SQL=UPDATE outbound_idempotency provider=sqlcipher key=hostile-secret-key"
                    .to_string(),
            ),
        );
        let log_code = status::reconciliation_failure_log_code(&hostile);
        assert_eq!(log_code, "IDEMPOTENCY_RECONCILE_FAILED");
        for forbidden in [
            "hostile-secret-key",
            "/Users/kyan/private/agent.db",
            "UPDATE outbound_idempotency",
            "sqlcipher",
            "provider",
        ] {
            assert!(!log_code.contains(forbidden), "{forbidden}");
        }
    }
}
