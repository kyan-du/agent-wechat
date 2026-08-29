use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::context::create_context;
use crate::db::get_db;
use crate::execution::{run_execution_loop, ExecutionResult};
use crate::ia::helpers::find_edit_and_send_button;
use crate::ia::types::*;
use crate::ia::{find_state_by_id, identify_states};
use crate::outbound::outbound_sender;
use crate::plans::login::{LoginParams, LoginPlan};
use crate::plans::logout::{LogoutParams, LogoutPlan};
use crate::sessions::manager::current_session;
use crate::tools::a11y::get_a11y_desktop;
use crate::tools::exec::ExecOptions;
use crate::tools::qr::{decode_qr_from_base64, to_data_url};
use crate::tools::screenshot::capture_screenshot;
use base64::Engine;

pub async fn get_status() -> Json<serde_json::Value> {
    let session = current_session();
    let login_status = session
        .as_ref()
        .and_then(|s| s.logged_in_user.as_ref())
        .map(|_| "logged_in".to_string())
        .unwrap_or_else(|| "logged_out".to_string());

    Json(serde_json::json!({
        "container": "running",
        "loginState": { "status": login_status },
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": 1,
        "outbound": crate::outbound::outbound_sender().status(),
    }))
}

pub async fn outbound_status() -> Json<crate::outbound::OutboundStatus> {
    Json(outbound_sender().status())
}

pub async fn outbound_idempotency_status(Path(key): Path<String>) -> impl IntoResponse {
    if crate::outbound::validate_idempotency_key(&key).is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "key": "",
                "state": "invalid",
                "error": "INVALID_IDEMPOTENCY_KEY",
            })),
        );
    }
    match crate::outbound::get_idempotency_status(&key) {
        Some(record) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "key": record.key,
                "state": record.state.as_str(),
                "result": record.result,
                "expiresAt": record.expires_at,
                "updatedAt": record.updated_at,
            })),
        ),
        None => (
            StatusCode::OK,
            Json(serde_json::json!({
                "key": key,
                "state": "unknown",
            })),
        ),
    }
}

pub async fn reconcile_outbound_idempotency(Path(key): Path<String>) -> impl IntoResponse {
    if crate::outbound::validate_idempotency_key(&key).is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "success": false,
                "error": "INVALID_IDEMPOTENCY_KEY",
            })),
        );
    }
    match crate::outbound::manually_reconcile_idempotency(&key, std::time::Duration::from_secs(600))
    {
        Ok(true) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "key": key,
                "state": "uncertain",
            })),
        ),
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "success": false,
                "key": key,
                "error": "IDEMPOTENCY_NOT_RECONCILABLE",
            })),
        ),
        Err(error) => {
            tracing::error!(
                error_code = reconciliation_failure_log_code(&error),
                "[status] outbound idempotency reconcile failed"
            );
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "success": false,
                    "error": "IDEMPOTENCY_RECONCILE_FAILED",
                })),
            )
        }
    }
}

pub(crate) fn reconciliation_failure_log_code(_: &rusqlite::Error) -> &'static str {
    "IDEMPOTENCY_RECONCILE_FAILED"
}

pub async fn pause_outbound() -> Json<crate::outbound::OutboundStatus> {
    Json(outbound_sender().pause())
}

pub async fn resume_outbound() -> Json<crate::outbound::OutboundStatus> {
    Json(outbound_sender().resume())
}

/// Check auth status via one FSM observation cycle.
///
/// Gets the a11y tree, identifies the current state, and runs
/// the reducer. Chat states set `is_logged_in = true`.
pub async fn auth_status() -> Json<serde_json::Value> {
    let session = match current_session() {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "status": "unknown",
            }))
        }
    };

    // Check if WeChat process is running first
    let wechat_running = crate::tools::wechat_db::find_wechat_pid().is_some();
    if !wechat_running {
        return Json(serde_json::json!({
            "status": "app_not_running",
            "loggedInUser": session.logged_in_user,
        }));
    }

    let exec_options = ExecOptions {
        session: Some(session.clone()),
        timeout_ms: 30_000,
    };

    // Run one observation: a11y → identify → reduce
    let a11y = match get_a11y_desktop(&exec_options).await {
        Ok(tree) => tree,
        Err(_) => {
            return Json(serde_json::json!({
                "status": "unknown",
                "loggedInUser": session.logged_in_user,
            }))
        }
    };

    let screenshot = capture_screenshot(&exec_options).await.unwrap_or_default();
    let identified = identify_states(&a11y, &screenshot);

    // Load persisted state and apply reduce
    let mut context = {
        let db = get_db();
        create_context(session.clone(), &db)
    };

    if let Some(ref mw) = identified.main_window {
        if let Some(state_impl) = find_state_by_id(&mw.state_id) {
            let screenshot_bytes = base64::engine::general_purpose::STANDARD
                .decode(&screenshot)
                .unwrap_or_default();
            context.state = state_impl.reduce(&ReduceArgs {
                prev: &context.state,
                a11y: &a11y,
                screenshot: &screenshot_bytes,
            });
        }
    }

    // Save updated state
    {
        let db = get_db();
        context.save(&db);
    }

    let status = if context.state.main_window.is_logged_in {
        "logged_in"
    } else {
        "logged_out"
    };

    let composer_ready =
        context.state.main_window.is_logged_in && context.state.popup.is_none() && find_edit_and_send_button(&a11y).is_some();
    let readiness = classify_auth_readiness(
        context.state.main_window.is_logged_in,
        context.state.popup.is_some(),
        composer_ready,
    );

    tracing::info!(
        "[auth_status] view={:?}, status={}, readiness={}, popup={}",
        context.state.main_window.view,
        status,
        readiness,
        context.state.popup.is_some(),
    );

    Json(serde_json::json!({
        "status": status,
        "loggedInUser": session.logged_in_user,
        "readiness": {
            "status": readiness,
            "composerReady": composer_ready,
            "errorCode": if readiness == "composer_unavailable" { Some("COMPOSER_UNAVAILABLE") } else { None },
        },
    }))
}

fn classify_auth_readiness(is_logged_in: bool, popup_present: bool, composer_ready: bool) -> &'static str {
    if !is_logged_in {
        "not_logged_in"
    } else if popup_present {
        "popup_blocked"
    } else if composer_ready {
        "ready"
    } else {
        "composer_unavailable"
    }
}

/// Log out of WeChat via FSM execution loop.
pub async fn logout() -> Json<serde_json::Value> {
    let session = match current_session() {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "success": false,
                "error": "No session available"
            }))
        }
    };

    // Quick auth check first
    let exec_options = ExecOptions {
        session: Some(session.clone()),
        timeout_ms: 30_000,
    };

    let a11y = match get_a11y_desktop(&exec_options).await {
        Ok(tree) => tree,
        Err(e) => {
            return Json(serde_json::json!({
                "success": false,
                "error": format!("Failed to get a11y tree: {e}")
            }))
        }
    };

    let screenshot = capture_screenshot(&exec_options).await.unwrap_or_default();
    let identified = identify_states(&a11y, &screenshot);

    // Load persisted state and check if logged in
    let mut context = {
        let db = get_db();
        create_context(session.clone(), &db)
    };

    if let Some(ref mw) = identified.main_window {
        if let Some(state_impl) = find_state_by_id(&mw.state_id) {
            let screenshot_bytes = base64::engine::general_purpose::STANDARD
                .decode(&screenshot)
                .unwrap_or_default();
            context.state = state_impl.reduce(&ReduceArgs {
                prev: &context.state,
                a11y: &a11y,
                screenshot: &screenshot_bytes,
            });
        }
    }

    if !context.state.main_window.is_logged_in {
        return Json(serde_json::json!({
            "success": false,
            "error": "Not logged in"
        }));
    }

    // Run logout FSM
    let cancel = CancellationToken::new();
    let plan = LogoutPlan;
    let params = LogoutParams;
    let emit = std::sync::Arc::new(|_event: SubscriptionEvent| {});
    let session_id = session.id.clone();
    let (result, _) = crate::execution::run_execution_loop_then(
        &plan,
        &params,
        &mut context,
        emit,
        cancel,
        |_context, result| apply_logout_user_clear(result, &session_id),
    )
    .await;

    Json(serde_json::json!({
        "success": result.success,
        "error": result.error
    }))
}

pub async fn reset_auth() -> Json<serde_json::Value> {
    let session = match current_session() {
        Some(session) => session,
        None => {
            return Json(
                serde_json::json!({ "success": false, "errorCode": "SESSION_NOT_FOUND", "error": "default session not found" }),
            )
        }
    };
    let stopped = crate::sessions::manager::stop_session(&session.id).await;
    if stopped.is_err() {
        return Json(
            serde_json::json!({ "success": false, "errorCode": "AUTH_RESET_STOP_FAILED", "error": "could not stop WeChat session" }),
        );
    }
    let reset = {
        let mut db = get_db();
        crate::db::queries::reset_session_auth_data(&mut db, &session.id)
    };
    match reset {
        Ok(()) => Json(serde_json::json!({ "success": true })),
        Err(code) => Json(
            serde_json::json!({ "success": false, "errorCode": code, "error": "authentication state reset failed" }),
        ),
    }
}

pub async fn login() -> Json<serde_json::Value> {
    let screenshot = capture_screenshot(&ExecOptions::default()).await;

    match screenshot {
        Ok(b64) => {
            if let Some(qr_result) = decode_qr_from_base64(&b64) {
                let data_url = to_data_url(&qr_result.data).ok();
                return Json(serde_json::json!({
                    "success": false,
                    "state": { "status": "qr_pending" },
                    "qrDataUrl": data_url
                }));
            }

            Json(serde_json::json!({
                "success": false,
                "state": { "status": "qr_pending" }
            }))
        }
        Err(_) => Json(serde_json::json!({
            "success": false,
            "state": { "status": "logged_out" }
        })),
    }
}

#[derive(Deserialize)]
pub struct LoginWsParams {
    #[serde(rename = "timeoutMs", default = "default_timeout")]
    timeout_ms: u64,
    #[serde(rename = "newAccount", default)]
    new_account: bool,
}

fn default_timeout() -> u64 {
    300_000
}

pub async fn login_ws(
    ws: WebSocketUpgrade,
    Query(params): Query<LoginWsParams>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_login_ws(socket, params))
}

async fn handle_login_ws(mut socket: WebSocket, params: LoginWsParams) {
    let session = match current_session() {
        Some(s) => s,
        None => {
            let msg = serde_json::to_string(&LoginSubscriptionEvent::Error {
                message: "No session available".to_string(),
            })
            .unwrap();
            let _ = socket.send(Message::Text(msg.into())).await;
            return;
        }
    };

    // Send initial status
    let msg = serde_json::to_string(&LoginSubscriptionEvent::Status {
        message: "Navigating login flow...".to_string(),
    })
    .unwrap();
    if socket.send(Message::Text(msg.into())).await.is_err() {
        return;
    }

    // Channel to bridge sync emit callback → async WebSocket sends
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SubscriptionEvent>();
    let cancel = CancellationToken::new();
    let cancel_for_exec = cancel.clone();
    let login_params = LoginParams {
        new_account: params.new_account,
    };

    // Spawn the execution loop in a separate task
    let exec_handle = tokio::spawn(async move {
        let mut context = {
            let db = get_db();
            create_context(session, &db)
        };
        let plan = LoginPlan;
        let emit = std::sync::Arc::new(move |event: SubscriptionEvent| {
            let _ = tx.send(event);
        });
        run_execution_loop(&plan, &login_params, &mut context, emit, cancel_for_exec)
            .await
            .0
    });

    // Main loop: bridge events to WebSocket, handle timeout + disconnect
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(params.timeout_ms));
    tokio::pin!(timeout);
    let mut sent_terminal = false;
    let mut client_disconnected = false;
    let mut server_timeout = false;

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(evt) => {
                        let ws_event = subscription_event_to_login_event(evt);
                        if is_terminal_login_event(&ws_event) {
                            sent_terminal = true;
                        }
                        let msg = serde_json::to_string(&ws_event).unwrap();
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            cancel.cancel();
                            client_disconnected = true;
                            break;
                        }
                    }
                    None => break, // channel closed = execution done
                }
            }
            _ = &mut timeout => {
                cancel.cancel();
                server_timeout = true;
                sent_terminal = true;
                let msg = serde_json::to_string(&LoginSubscriptionEvent::LoginTimeout).unwrap();
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    client_disconnected = true;
                }
                break;
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(_)) => continue,
                    _ => {
                        cancel.cancel();
                        client_disconnected = true;
                        break;
                    }
                }
            }
        }
    }

    // Wait for execution to finish and emit a fallback terminal event if needed.
    let exec_result = exec_handle.await.ok();
    if !client_disconnected && !sent_terminal {
        let fallback = match exec_result {
            Some(result) if result.success => {
                LoginSubscriptionEvent::LoginSuccess { user_id: None }
            }
            Some(result) => {
                let message = result.error.unwrap_or_else(|| "Login failed".to_string());
                if message.starts_with("Unknown state for")
                    || message.starts_with("Execution timeout after")
                    || (server_timeout && message == "Aborted")
                {
                    LoginSubscriptionEvent::LoginTimeout
                } else {
                    LoginSubscriptionEvent::Error { message }
                }
            }
            None => LoginSubscriptionEvent::Error {
                message: "Login execution task failed".to_string(),
            },
        };
        let msg = serde_json::to_string(&fallback).unwrap();
        let _ = socket.send(Message::Text(msg.into())).await;
    }
}

fn is_terminal_login_event(event: &LoginSubscriptionEvent) -> bool {
    matches!(
        event,
        LoginSubscriptionEvent::LoginSuccess { .. }
            | LoginSubscriptionEvent::LoginTimeout
            | LoginSubscriptionEvent::Error { .. }
    )
}

/// Convert generic SubscriptionEvent (from plans) to typed LoginSubscriptionEvent (for WS).
fn subscription_event_to_login_event(event: SubscriptionEvent) -> LoginSubscriptionEvent {
    match event.event_type.as_str() {
        "status" => LoginSubscriptionEvent::Status {
            message: event
                .data
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        },
        "qr" => {
            let qr_data = event
                .data
                .get("qrData")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let qr_data_url = to_data_url(&qr_data).ok();
            LoginSubscriptionEvent::Qr {
                qr_data,
                qr_binary_data: None,
                qr_data_url,
            }
        }
        "phone_confirm" => LoginSubscriptionEvent::PhoneConfirm {
            message: event
                .data
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        },
        "login_success" => LoginSubscriptionEvent::LoginSuccess {
            user_id: event
                .data
                .get("userId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        },
        "login_timeout" => LoginSubscriptionEvent::LoginTimeout,
        "error" => LoginSubscriptionEvent::Error {
            message: event
                .data
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        },
        _ => LoginSubscriptionEvent::Status {
            message: format!("Unknown event: {}", event.event_type),
        },
    }
}

/// Clear the saved user after a successful logout while PLAN_LOCK is still held.
/// A failed or no-op update must not report logout success.
pub(crate) fn apply_logout_user_clear(result: &mut ExecutionResult, session_id: &str) {
    apply_logout_clear_result(result, || {
        let db = get_db();
        crate::db::queries::update_session_logged_in_user(&db, session_id, None)
    });
}

pub(crate) fn apply_logout_clear_result(
    result: &mut ExecutionResult,
    clear: impl FnOnce() -> Result<(), &'static str>,
) {
    if !result.success {
        return;
    }
    if clear().is_err() {
        result.success = false;
        result.error = Some("LOGOUT_USER_CLEAR_FAILED".to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_reports_failure_when_saved_user_clear_fails() {
        let mut result = ExecutionResult {
            success: true,
            error: None,
        };
        apply_logout_clear_result(&mut result, || Err("SESSION_USER_UPDATE_MISMATCH"));
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("LOGOUT_USER_CLEAR_FAILED"));
    }

    #[test]
    fn logout_keeps_success_when_saved_user_clear_persists() {
        let mut result = ExecutionResult {
            success: true,
            error: None,
        };
        apply_logout_clear_result(&mut result, || Ok(()));
        assert!(result.success);
        assert!(result.error.is_none());
    }

    #[test]
    fn failed_logout_does_not_attempt_user_clear() {
        let mut result = ExecutionResult {
            success: false,
            error: Some("Aborted".into()),
        };
        let mut called = false;
        apply_logout_clear_result(&mut result, || {
            called = true;
            Ok(())
        });
        assert!(!called);
        assert!(!result.success);
    }

    #[test]
    fn auth_readiness_prefers_popup_blocked_over_composer_unavailable() {
        assert_eq!(classify_auth_readiness(true, true, false), "popup_blocked");
        assert_eq!(classify_auth_readiness(true, false, false), "composer_unavailable");
        assert_eq!(classify_auth_readiness(true, false, true), "ready");
        assert_eq!(classify_auth_readiness(false, true, true), "not_logged_in");
    }
}
