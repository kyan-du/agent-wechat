use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::db::get_db;
use crate::ia::types::{MediaResult, SendParams, SendResult};
use crate::outbound::{
    cleanup_temp_files, outbound_sender, IdempotencyAdmission, IdempotencyClaimLease,
    OutboundError, OutboundSendResponse,
};
use crate::plans::send_message::SendMessageParams;
use crate::sessions::manager::get_session;
use crate::tools::wechat_keys::{get_image_keys, get_stored_keys};
use crate::tools::wechat_media::get_message_media;
use crate::tools::wechat_messages;

#[derive(Deserialize)]
pub struct ListParams {
    #[serde(default = "default_limit")]
    limit: i64,
    cursor: Option<String>,
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

pub async fn list_messages(
    Path(chat_id): Path<String>,
    Query(params): Query<ListParams>,
) -> Response {
    if !(1..=200).contains(&params.limit) {
        return error_page("INVALID_LIMIT");
    }
    if let Some(cursor) = params.cursor.as_deref() {
        let kind = format!("messages:{chat_id}");
        if crate::tools::page_cursor::decode::<(String, i64)>(&kind, cursor).is_err() {
            return error_page("INVALID_CURSOR");
        }
    }
    let session = match get_session("default") {
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

    if !keys.keys().any(|k| {
        k.starts_with("message_")
            && k.ends_with(".db")
            && !k.contains("fts")
            && !k.contains("resource")
    }) {
        return empty_page();
    }

    let mut messages = wechat_messages::list_messages(
        &logged_in_user,
        &keys,
        &chat_id,
        params.limit + 1,
        params.cursor.as_deref(),
    );
    let has_more = crate::tools::page_cursor::truncate_lookahead(&mut messages, params.limit);
    let next_cursor = has_more.then(|| messages.last()).flatten().and_then(|message| {
        crate::tools::page_cursor::encode(
            &format!("messages:{chat_id}"),
            (message.timestamp.clone(), message.local_id),
        ).ok()
    });
    Json(serde_json::json!({ "schemaVersion": 1, "items": messages, "nextCursor": next_cursor })).into_response()
}

pub async fn get_media(Path((chat_id, local_id)): Path<(String, i64)>) -> Json<MediaResult> {
    let session = match get_session("default") {
        Some(s) => s,
        None => {
            return Json(MediaResult {
                media_type: "unsupported".to_string(),
                data: None,
                url: None,
                format: String::new(),
                filename: String::new(),
                source: None,
                error_code: Some("SESSION_UNAVAILABLE".to_string()),
            })
        }
    };
    let logged_in_user = match &session.logged_in_user {
        Some(u) => u.clone(),
        None => {
            return Json(MediaResult {
                media_type: "unsupported".to_string(),
                data: None,
                url: None,
                format: String::new(),
                filename: String::new(),
                source: None,
                error_code: Some("NOT_LOGGED_IN".to_string()),
            })
        }
    };

    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, &logged_in_user)
    };

    let image_keys = {
        let db = get_db();
        get_image_keys(&db, &session.id, &logged_in_user)
    };

    Json(get_message_media(
        &logged_in_user,
        &keys,
        &chat_id,
        local_id,
        image_keys,
    ))
}

pub async fn send_message(Json(mut input): Json<SendParams>) -> OutboundSendResponse {
    input.chat_id = input.chat_id.trim().to_string();
    if input.chat_id.is_empty() {
        return OutboundSendResponse::Result(SendResult {
            success: false,
            error_code: Some("INVALID_CHAT_ID".to_string()),
            error: Some("chatId must contain non-whitespace characters".to_string()),
            commit_attempted: false,
        });
    }
    if let Some(text) = input.text.as_mut() {
        *text = text.trim().to_string();
        if text.is_empty() {
            return OutboundSendResponse::Result(SendResult {
                success: false,
                error_code: Some("INVALID_TEXT".to_string()),
                error: Some("text must contain non-whitespace characters".to_string()),
                commit_attempted: false,
            });
        }
    }

    if input.source.as_deref().is_some_and(|source| {
        source.is_empty()
            || source.len() > 64
            || !source
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    }) {
        return OutboundSendResponse::Result(SendResult {
            success: false,
            error_code: Some("INVALID_SOURCE".to_string()),
            error: Some("source must be 1-64 ASCII characters from [A-Za-z0-9._:-]".to_string()),
            commit_attempted: false,
        });
    }

    if input.text.is_none() && input.image.is_none() && input.file.is_none() {
        return OutboundSendResponse::Result(SendResult {
            success: false,
            error_code: Some("INVALID_REQUEST".to_string()),
            error: Some("No text, image, or file provided".to_string()),
            commit_attempted: false,
        });
    }

    let mut idempotency_lease: Option<IdempotencyClaimLease> = None;
    if let Some(key) = input.idempotency_key.as_deref() {
        match outbound_sender().admit_idempotency_key(key) {
            IdempotencyAdmission::Claimed(lease) => {
                idempotency_lease = Some(lease);
            }
            IdempotencyAdmission::Completed(result) => {
                return OutboundSendResponse::Result(result);
            }
            IdempotencyAdmission::InProgress => {
                return OutboundSendResponse::Rejected(OutboundError::duplicate_in_progress(
                    outbound_sender().retry_after(),
                ));
            }
            IdempotencyAdmission::Rejected(error) => {
                return OutboundSendResponse::Rejected(error);
            }
        }
    }

    // Decode base64 image to temp file
    let mut image_path: Option<String> = None;
    let mut image_mime: Option<String> = None;
    if let Some(ref img) = input.image {
        let ext = match img.mime_type.as_str() {
            "image/jpeg" => ".jpg",
            "image/gif" => ".gif",
            _ => ".png",
        };
        let path = format!(
            "/tmp/send_image_{}{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            ext
        );
        match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &img.data) {
            Ok(bytes) => match std::fs::write(&path, &bytes) {
                Ok(_) => {
                    image_mime = Some(img.mime_type.clone());
                    image_path = Some(path);
                }
                Err(e) => {
                    if let Err(error) = outbound_sender().reject_claimed_pre_execution(
                        &mut idempotency_lease,
                        "TEMP_FILE_WRITE_FAILED",
                    ) {
                        return OutboundSendResponse::Rejected(error);
                    }
                    return OutboundSendResponse::Result(SendResult {
                        success: false,
                        error_code: Some("TEMP_FILE_WRITE_FAILED".to_string()),
                        error: Some(format!("Failed to write temp image: {e}")),
                        commit_attempted: false,
                    });
                }
            },
            Err(e) => {
                if let Err(error) = outbound_sender().reject_claimed_pre_execution(
                    &mut idempotency_lease,
                    "IMAGE_BASE64_DECODE_FAILED",
                ) {
                    return OutboundSendResponse::Rejected(error);
                }
                return OutboundSendResponse::Result(SendResult {
                    success: false,
                    error_code: Some("IMAGE_BASE64_DECODE_FAILED".to_string()),
                    error: Some(format!("Failed to decode base64 image data: {e}")),
                    commit_attempted: false,
                });
            }
        }
    }

    // Decode base64 file to temp file
    let mut file_path: Option<String> = None;
    if let Some(ref f) = input.file {
        // Sanitize filename: keep ASCII alphanumerics, dot, hyphen, underscore;
        // replace everything else (including CJK) with underscore so the temp
        // path stays portable across locales.  The dot is preserved so that
        // file extensions survive (e.g. "遗憾.pdf" → "__.pdf"); the mangled
        // stem is acceptable since this is a transient temp path.
        let safe_name: String = f
            .filename
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let path = format!(
            "/tmp/send_file_{}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            safe_name
        );
        match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &f.data) {
            Ok(bytes) => match std::fs::write(&path, &bytes) {
                Ok(_) => {
                    file_path = Some(path);
                }
                Err(e) => {
                    cleanup_temp_files(&SendMessageParams {
                        chat_id: input.chat_id.clone(),
                        message: input.text.clone(),
                        image_path: image_path.clone(),
                        image_mime: image_mime.clone(),
                        file_path: file_path.clone(),
                        inbound_chars: None,
                        source: None,
                        similarity_confirmed: false,
                    });
                    if let Err(error) = outbound_sender().reject_claimed_pre_execution(
                        &mut idempotency_lease,
                        "TEMP_FILE_WRITE_FAILED",
                    ) {
                        return OutboundSendResponse::Rejected(error);
                    }
                    return OutboundSendResponse::Result(SendResult {
                        success: false,
                        error_code: Some("TEMP_FILE_WRITE_FAILED".to_string()),
                        error: Some(format!("Failed to write temp file: {e}")),
                        commit_attempted: false,
                    });
                }
            },
            Err(e) => {
                cleanup_temp_files(&SendMessageParams {
                    chat_id: input.chat_id.clone(),
                    message: input.text.clone(),
                    image_path: image_path.clone(),
                    image_mime: image_mime.clone(),
                    file_path: file_path.clone(),
                    inbound_chars: None,
                    source: None,
                    similarity_confirmed: false,
                });
                if let Err(error) = outbound_sender().reject_claimed_pre_execution(
                    &mut idempotency_lease,
                    "FILE_BASE64_DECODE_FAILED",
                ) {
                    return OutboundSendResponse::Rejected(error);
                }
                return OutboundSendResponse::Result(SendResult {
                    success: false,
                    error_code: Some("FILE_BASE64_DECODE_FAILED".to_string()),
                    error: Some(format!("Failed to decode base64 file data: {e}")),
                    commit_attempted: false,
                });
            }
        }
    }

    let params = SendMessageParams {
        chat_id: input.chat_id,
        message: input.text,
        image_path,
        image_mime,
        file_path,
        inbound_chars: input.inbound_chars.map(|n| n as usize),
        source: input.source,
        similarity_confirmed: input.similarity_confirmed.unwrap_or(false),
    };
    outbound_sender()
        .send_claimed(params, idempotency_lease)
        .await
}
