use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::db::get_db;
use crate::sessions::manager::current_session;
use crate::tools::wechat_group_members::{self, GroupMemberQueryError};
use crate::tools::wechat_keys::get_stored_keys;

#[derive(Deserialize)]
pub struct ListParams {
    #[serde(default = "default_limit")]
    limit: i64,
    cursor: Option<String>,
}

fn default_limit() -> i64 {
    50
}

fn page(items: serde_json::Value, next_cursor: Option<String>) -> Response {
    Json(serde_json::json!({
        "schemaVersion": 1,
        "items": items,
        "nextCursor": next_cursor,
    }))
    .into_response()
}

fn error(status: StatusCode, code: &str) -> Response {
    (
        status,
        Json(serde_json::json!({
            "schemaVersion": 1,
            "items": [],
            "nextCursor": null,
            "errorCode": code,
        })),
    )
        .into_response()
}

pub async fn list_group_members(
    Path(group_id): Path<String>,
    Query(params): Query<ListParams>,
) -> Response {
    if !(1..=100).contains(&params.limit) {
        return error(StatusCode::BAD_REQUEST, "INVALID_LIMIT");
    }
    let Some(session) = current_session() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "SESSION_NOT_FOUND");
    };
    let Some(logged_in_user) = session.logged_in_user.as_ref() else {
        return error(StatusCode::UNAUTHORIZED, "NOT_LOGGED_IN");
    };
    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, logged_in_user)
    };
    let mut members = match wechat_group_members::list_group_members(
        logged_in_user,
        &keys,
        &group_id,
        params.limit + 1,
        params.cursor.as_deref(),
    ) {
        Ok(members) => members,
        Err(kind) => {
            let status = match kind {
                GroupMemberQueryError::NotGroup | GroupMemberQueryError::InvalidCursor => {
                    StatusCode::BAD_REQUEST
                }
                GroupMemberQueryError::GroupNotFound => StatusCode::NOT_FOUND,
                GroupMemberQueryError::NotMember => StatusCode::FORBIDDEN,
                GroupMemberQueryError::MissingDatabase => StatusCode::SERVICE_UNAVAILABLE,
            };
            return error(status, kind.code());
        }
    };
    let has_more = crate::tools::page_cursor::truncate_lookahead(&mut members, params.limit);
    let next_cursor = has_more
        .then(|| members.last())
        .flatten()
        .and_then(|member| {
            crate::tools::page_cursor::encode(
                "group_members",
                (group_id.clone(), member.member_id.clone()),
            )
            .ok()
        });
    page(
        serde_json::to_value(members).unwrap_or_else(|_| serde_json::json!([])),
        next_cursor,
    )
}
