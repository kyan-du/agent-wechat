use axum::{extract::Query, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

use crate::db::get_db;
use crate::ia::types::Contact;
use crate::sessions::manager::get_session;
use crate::tools::wechat_contacts;
use crate::tools::wechat_keys::get_stored_keys;

#[derive(Deserialize)]
pub struct ListParams {
    #[serde(default = "default_limit")]
    limit: i64,
    cursor: Option<String>,
}

fn default_limit() -> i64 {
    200
}

fn empty_page() -> Response {
    Json(serde_json::json!({ "schemaVersion": 1, "items": [], "nextCursor": null })).into_response()
}

fn error_page(code: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "schemaVersion": 1, "items": [], "nextCursor": null, "errorCode": code }))).into_response()
}

pub async fn list_contacts(Query(params): Query<ListParams>) -> Response {
    if !(1..=200).contains(&params.limit) {
        return error_page("INVALID_LIMIT");
    }
    if let Some(cursor) = params.cursor.as_deref() {
        if crate::tools::page_cursor::decode::<(bool, String, String)>("contacts", cursor).is_err() {
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

    if !keys.contains_key("contact.db") {
        return empty_page();
    }

    let mut contacts = wechat_contacts::list_contacts(
        &logged_in_user,
        &keys,
        params.limit + 1,
        params.cursor.as_deref(),
    );
    let has_more = crate::tools::page_cursor::truncate_lookahead(&mut contacts, params.limit);
    let next_cursor = has_more.then(|| contacts.last()).flatten().and_then(|contact| {
        let label = contact.remark.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| contact.nick_name.clone());
        crate::tools::page_cursor::encode("contacts", (contact.remark.is_none(), label.to_lowercase(), contact.username.clone())).ok()
    });
    Json(serde_json::json!({ "schemaVersion": 1, "items": contacts, "nextCursor": next_cursor })).into_response()
}

#[derive(Deserialize)]
pub struct FindParams {
    name: String,
}

pub async fn find_contacts(Query(params): Query<FindParams>) -> Json<Vec<Contact>> {
    let session = match get_session("default") {
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

    Json(wechat_contacts::find_contacts(
        &logged_in_user,
        &keys,
        &params.name,
    ))
}
