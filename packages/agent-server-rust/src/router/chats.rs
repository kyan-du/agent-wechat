use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::context::create_context;
use crate::db::get_db;
use crate::execution::run_execution_loop;
use crate::ia::types::{Chat, SubscriptionEvent};
use crate::plans::chat_open::{ChatOpenParams, ChatOpenPlan, COMPOSER_UNAVAILABLE};
use crate::sessions::manager::current_session;
use crate::tools::wechat_chats;
use crate::tools::wechat_keys::get_stored_keys;

#[derive(Deserialize)]
pub struct ListParams {
    #[serde(default = "default_limit")]
    limit: i64,
    cursor: Option<String>,
    #[serde(default, rename = "unreadOnly")]
    unread_only: bool,
}

fn default_limit() -> i64 {
    50
}

fn empty_page() -> Response {
    Json(serde_json::json!({ "schemaVersion": 1, "items": [], "nextCursor": null })).into_response()
}

fn error_page(code: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "schemaVersion": 1, "items": [], "nextCursor": null, "errorCode": code }))).into_response()
}

pub async fn list_chats(Query(params): Query<ListParams>) -> Response {
    if !(1..=100).contains(&params.limit) {
        return error_page("INVALID_LIMIT");
    }
    if let Some(cursor) = params.cursor.as_deref() {
        if crate::tools::page_cursor::decode::<(i64, String)>("chats", cursor).is_err() {
            return error_page("INVALID_CURSOR");
        }
    }
    let session = match current_session() {
        Some(s) => s,
        None => return empty_page(),
    };
    let logged_in_user = match &session.logged_in_user {
        Some(u) => u.clone(),
        None => return empty_page(),
    };

    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, &logged_in_user)
    };

    if !keys.contains_key("session.db") || !keys.contains_key("contact.db") {
        return empty_page();
    }

    let mut chats = wechat_chats::list_chats(
        &logged_in_user,
        &keys,
        params.limit + 1,
        params.cursor.as_deref(),
        params.unread_only,
    );
    let has_more = crate::tools::page_cursor::truncate_lookahead(&mut chats, params.limit);
    let next_cursor = has_more.then(|| chats.last()).flatten().and_then(|chat| {
        let sort = chat.sort_timestamp;
        crate::tools::page_cursor::encode("chats", (sort, chat.id.clone())).ok()
    });
    Json(serde_json::json!({ "schemaVersion": 1, "items": chats, "nextCursor": next_cursor }))
        .into_response()
}

pub async fn get_chat(Path(id): Path<String>) -> Json<Option<Chat>> {
    let session = match current_session() {
        Some(s) => s,
        None => return Json(None),
    };
    let logged_in_user = match &session.logged_in_user {
        Some(u) => u.clone(),
        None => return Json(None),
    };

    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, &logged_in_user)
    };

    Json(wechat_chats::get_chat_by_username(
        &logged_in_user,
        &keys,
        &id,
    ))
}

#[derive(Deserialize)]
pub struct FindParams {
    name: String,
}

pub async fn find_chats(Query(params): Query<FindParams>) -> Json<Vec<Chat>> {
    let session = match current_session() {
        Some(s) => s,
        None => return Json(Vec::new()),
    };
    let logged_in_user = match &session.logged_in_user {
        Some(u) => u.clone(),
        None => return Json(Vec::new()),
    };

    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, &logged_in_user)
    };

    Json(wechat_chats::find_chats_by_name(
        &logged_in_user,
        &keys,
        &params.name,
    ))
}

#[derive(Deserialize)]
pub struct OpenChatParams {
    #[serde(default, rename = "clearUnreads")]
    clear_unreads: bool,
}

fn chat_open_execution_error_code(error: Option<&str>) -> &'static str {
    match error {
        Some(message) if message.starts_with("Unknown state for") => "UNKNOWN_UI_STATE_TIMEOUT",
        Some(message) if message.starts_with("Execution timeout after") => "EXECUTION_TIMEOUT",
        Some("Aborted") => "ABORTED",
        _ => "CHAT_OPEN_FAILED",
    }
}

fn chat_open_error_code(plan_error: Option<&str>, execution_error: Option<&str>) -> &'static str {
    match plan_error {
        Some(COMPOSER_UNAVAILABLE) => COMPOSER_UNAVAILABLE,
        _ => chat_open_execution_error_code(execution_error),
    }
}

fn mark_read_error_code(plan_error: Option<&str>) -> &'static str {
    match plan_error {
        Some(COMPOSER_UNAVAILABLE) => COMPOSER_UNAVAILABLE,
        _ => "MARK_READ_UNVERIFIED",
    }
}

pub async fn mark_read(Path(chat_id): Path<String>) -> Json<serde_json::Value> {
    let session = match current_session() {
        Some(session) => session,
        None => {
            return Json(
                serde_json::json!({ "ok": false, "errorCode": "SESSION_NOT_FOUND", "error": "default session not found" }),
            )
        }
    };
    let logged_in_user = match &session.logged_in_user {
        Some(user) => user.clone(),
        None => {
            return Json(
                serde_json::json!({ "ok": false, "errorCode": "NOT_LOGGED_IN", "error": "not logged in" }),
            )
        }
    };
    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, &logged_in_user)
    };
    let Some(chat_before) = wechat_chats::get_chat_by_username(&logged_in_user, &keys, &chat_id)
    else {
        return Json(
            serde_json::json!({ "ok": false, "errorCode": "TARGET_NOT_FOUND", "error": "chat was not found" }),
        );
    };
    let before = chat_before.unread_count;
    if before == 0 {
        return Json(
            serde_json::json!({ "ok": true, "beforeUnread": 0, "afterUnread": 0, "verified": true }),
        );
    }
    let mut context = {
        let db = get_db();
        create_context(session, &db)
    };
    let plan = ChatOpenPlan;
    let params = ChatOpenParams {
        chat_id: chat_id.clone(),
        clear_unreads: true,
    };
    let cancel = CancellationToken::new();
    let emit = std::sync::Arc::new(|_: SubscriptionEvent| {});
    let (execution, plan_state) =
        run_execution_loop(&plan, &params, &mut context, emit, cancel).await;
    if !execution.success
        || !plan_state
            .result
            .as_ref()
            .is_some_and(|result| result.ok && result.verified.unwrap_or(false))
    {
        let error_code = mark_read_error_code(plan_state.diagnostic_error);
        let error = if error_code == COMPOSER_UNAVAILABLE {
            "Chat composer is unavailable"
        } else {
            "UI operation was not verified"
        };
        return Json(serde_json::json!({
            "ok": false,
            "errorCode": error_code,
            "error": error,
        }));
    }
    let after = wechat_chats::get_chat_by_username(&logged_in_user, &keys, &chat_id)
        .map(|chat| chat.unread_count)
        .unwrap_or(before);
    if after != 0 {
        return Json(
            serde_json::json!({ "ok": false, "errorCode": "MARK_READ_UNVERIFIED", "error": "unread count did not clear", "beforeUnread": before, "afterUnread": after }),
        );
    }
    Json(
        serde_json::json!({ "ok": true, "beforeUnread": before, "afterUnread": after, "verified": true }),
    )
}

pub async fn open_chat(
    Path(chat_id): Path<String>,
    Query(params): Query<OpenChatParams>,
) -> Json<serde_json::Value> {
    let clear_unreads = params.clear_unreads;
    let session = match current_session() {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "No session available"
            }))
        }
    };

    if session.logged_in_user.is_none() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "NOT_LOGGED_IN"
        }));
    }

    if chat_id.starts_with("gh_") {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Opening official accounts is not supported"
        }));
    }

    let mut context = {
        let db = get_db();
        create_context(session, &db)
    };

    let plan = ChatOpenPlan;
    let params = ChatOpenParams {
        chat_id,
        clear_unreads,
    };
    let cancel = CancellationToken::new();
    let noop_emit = std::sync::Arc::new(|_: SubscriptionEvent| {});

    let (result, plan_state) =
        run_execution_loop(&plan, &params, &mut context, noop_emit, cancel).await;

    if result.success {
        if let Some(open_result) = plan_state.result {
            Json(
                serde_json::to_value(open_result)
                    .unwrap_or_else(|_| serde_json::json!({"ok": true})),
            )
        } else {
            Json(serde_json::json!({ "ok": true }))
        }
    } else if let Some(plan_error) = plan_state.diagnostic_error {
        Json(serde_json::json!({
            "ok": false,
            "errorCode": chat_open_error_code(Some(plan_error), result.error.as_deref()),
            "error": "Chat composer is unavailable"
        }))
    } else if let Some(open_result) = plan_state.result {
        Json(serde_json::to_value(open_result).unwrap_or_else(|_| {
            serde_json::json!({
                "ok": false,
                "errorCode": "CHAT_OPEN_FAILED",
                "error": "Chat open failed"
            })
        }))
    } else {
        let error = result
            .error
            .unwrap_or_else(|| "Chat open failed".to_string());
        let error_code = chat_open_execution_error_code(Some(&error));
        Json(serde_json::json!({
            "ok": false,
            "errorCode": error_code,
            "error": error
        }))
    }
}

#[cfg(test)]
mod open_chat_tests {
    use super::*;

    #[test]
    fn maps_unknown_state_timeout_to_actionable_code() {
        assert_eq!(
            chat_open_execution_error_code(Some(
                "Unknown state for 60s - no matching IAState found"
            )),
            "UNKNOWN_UI_STATE_TIMEOUT"
        );
    }

    #[test]
    fn maps_execution_timeout_to_actionable_code() {
        assert_eq!(
            chat_open_execution_error_code(Some("Execution timeout after 300s")),
            "EXECUTION_TIMEOUT"
        );
    }

    #[test]
    fn composer_error_takes_precedence_over_generic_execution_error() {
        assert_eq!(
            chat_open_error_code(Some(COMPOSER_UNAVAILABLE), Some("No action selected")),
            COMPOSER_UNAVAILABLE
        );
    }

    #[test]
    fn mark_read_preserves_composer_unavailable_diagnostic() {
        assert_eq!(
            mark_read_error_code(Some(COMPOSER_UNAVAILABLE)),
            COMPOSER_UNAVAILABLE
        );
        assert_eq!(mark_read_error_code(None), "MARK_READ_UNVERIFIED");
        assert_eq!(
            mark_read_error_code(Some("UNRELATED_PLAN_ERROR")),
            "MARK_READ_UNVERIFIED"
        );
    }
}
