use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::Deserialize;

use crate::db::get_db;
use crate::ia::types::{ChatSyncPage, MediaReference, SyncReadState};
use crate::sessions::manager::get_session;
use crate::tools::wechat_chats;
use crate::tools::wechat_keys::get_stored_keys;
use crate::tools::wechat_messages;

#[derive(Deserialize)]
pub struct SyncParams {
    #[serde(default = "default_limit")]
    limit: i64,
    cursor: Option<String>,
    since: Option<String>,
    #[serde(rename = "from")]
    from_timestamp: Option<String>,
    #[serde(rename = "to")]
    to_timestamp: Option<String>,
}

fn default_limit() -> i64 { 50 }

fn error_page(code: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "schemaVersion": 1, "errorCode": code })),
    ).into_response()
}

fn empty_page(code: &str) -> Response {
    Json(serde_json::json!({
        "schemaVersion": 1,
        "errorCode": code,
        "items": [],
        "nextCursor": null,
        "syncToken": "",
        "media": [],
        "readState": { "unreadCount": 0, "observedAt": Utc::now().to_rfc3339() },
    })).into_response()
}

type SyncCursor = (String, i64);

fn sync_token(chat_id: &str, chat: &crate::ia::types::Chat, newest: Option<&crate::ia::types::Message>) -> String {
    let watermark = newest.map(|message| {
        chrono::DateTime::parse_from_rfc3339(&message.timestamp)
            .map(|timestamp| (timestamp.timestamp(), message.local_id))
            .unwrap_or((0, message.local_id))
    }).or_else(|| {
        chat.last_activity_at.as_deref().and_then(|timestamp| {
            chrono::DateTime::parse_from_rfc3339(timestamp)
                .ok()
                .map(|parsed| (parsed.timestamp(), chat.last_msg_local_id.unwrap_or(0)))
        })
    }).unwrap_or((0, chat.last_msg_local_id.unwrap_or(0)));
    crate::tools::page_cursor::encode(&format!("sync:{chat_id}"), watermark).unwrap_or_default()
}

pub async fn sync_chat(Path(chat_id): Path<String>, Query(params): Query<SyncParams>) -> Response {
    if !(1..=200).contains(&params.limit) {
        return error_page("INVALID_LIMIT");
    }
    let kind = format!("sync:{chat_id}");
    let decoded_cursor = if let Some(raw) = params.cursor.as_deref() {
        match crate::tools::page_cursor::decode::<SyncCursor>(&kind, raw) {
            Ok(value) => Some(value),
            Err(_) => return error_page("INVALID_CURSOR"),
        }
    } else { None };
    if decoded_cursor.is_some() && params.since.is_some() {
        return error_page("CURSOR_AND_SYNC_TOKEN_CONFLICT");
    }
    if params.since.is_some() && (params.from_timestamp.is_some() || params.to_timestamp.is_some()) {
        return error_page("SYNC_TOKEN_AND_TIME_RANGE_CONFLICT");
    }
    let since = if let Some(raw) = params.since.as_deref() {
        match crate::tools::page_cursor::decode::<(i64, i64)>(&kind, raw) {
            Ok(value) => Some(value),
            Err(_) => return error_page("INVALID_SYNC_TOKEN"),
        }
    } else { None };
    for value in [params.from_timestamp.as_deref(), params.to_timestamp.as_deref()].into_iter().flatten() {
        if chrono::DateTime::parse_from_rfc3339(value).is_err() {
            return error_page("INVALID_TIMESTAMP");
        }
    }

    let session = match get_session("default") {
        Some(session) => session,
        None => return empty_page("SESSION_UNAVAILABLE"),
    };
    let logged_in_user = match &session.logged_in_user {
        Some(user) => user.clone(),
        None => return empty_page("NOT_LOGGED_IN"),
    };
    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, &logged_in_user)
    };
    let Some(chat) = wechat_chats::get_chat_by_username(&logged_in_user, &keys, &chat_id) else {
        return error_page("TARGET_NOT_FOUND");
    };

    // The existing message reader owns SQLCipher access and stable keyset pagination.
    // Sync keeps that ordering and applies the optional time window after decoding.
    let message_cursor = decoded_cursor.as_ref().and_then(|value| {
        crate::tools::page_cursor::encode(&format!("messages:{chat_id}"), value.clone()).ok()
    });
    let mut items = if let Some((since_timestamp, since_local_id)) = since {
        wechat_messages::list_messages_since(&logged_in_user, &keys, &chat_id, params.limit + 1, since_timestamp, since_local_id)
    } else {
        wechat_messages::list_messages_in_range(
            &logged_in_user,
            &keys,
            &chat_id,
            params.limit + 1,
            message_cursor.as_deref(),
            params.from_timestamp.as_deref(),
            params.to_timestamp.as_deref(),
        )
    };
    let has_more = crate::tools::page_cursor::truncate_lookahead(&mut items, params.limit);
    let last = items.last();
    let next_cursor = has_more.then(|| last).flatten().and_then(|message| {
        crate::tools::page_cursor::encode(&kind, (message.timestamp.clone(), message.local_id)).ok()
    });
    let media = items.iter().filter(|message| matches!(message.msg_type, 3 | 34 | 43 | 49)).map(|message| MediaReference {
        local_id: message.local_id,
        url: format!("/api/messages/{}/media/{}", chat_id, message.local_id),
    }).collect();
    let token = sync_token(&chat_id, &chat, items.first());
    let response = ChatSyncPage {
        schema_version: 1,
        chat: Some(chat.clone()),
        items,
        next_cursor,
        sync_token: token,
        read_state: SyncReadState { unread_count: chat.unread_count, observed_at: Utc::now().to_rfc3339() },
        media,
    };
    Json(response).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_token_is_bound_to_chat_and_cursor_kind() {
        let cursor = crate::tools::page_cursor::encode("sync:one", ("2026-01-01T00:00:00Z".to_string(), 4_i64)).unwrap();
        assert!(crate::tools::page_cursor::decode::<SyncCursor>("sync:two", &cursor).is_err());
    }

    #[test]
    fn timestamp_ranges_require_rfc3339() {
        assert!(chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339("not-a-date").is_err());
    }
}
