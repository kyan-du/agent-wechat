use axum::Json;

use crate::interest::{get_interest as load_interest, set_interest, MonitorInterest};

pub async fn get_interest() -> Json<serde_json::Value> {
    match load_interest() {
        Some(interest) => Json(serde_json::json!({ "ok": true, "interest": interest })),
        None => Json(serde_json::json!({ "ok": true, "interest": null })),
    }
}

pub async fn put_interest(Json(body): Json<MonitorInterest>) -> Json<serde_json::Value> {
    let interest = set_interest(body);
    tracing::info!(
        "[interest] updated dm_policy={} dm_allow_from={} group_policy={} group_allow_from={}",
        interest.dm_policy,
        interest.dm_allow_from.len(),
        interest.group_policy,
        interest.group_allow_from.len(),
    );
    Json(serde_json::json!({ "ok": true, "interest": interest }))
}
