use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Query},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::VecDeque, sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock}};
use tokio::sync::broadcast;

const EVENT_HISTORY_LIMIT: usize = 256;
const EVENT_CHANNEL_LIMIT: usize = 256;
const EVENT_TYPE_MAX_BYTES: usize = 96;
const EVENT_PAYLOAD_MAX_BYTES: usize = 64 * 1024;
const EVENT_PAYLOAD_MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub schema_version: i32,
    pub event_id: u64,
    pub event_type: String,
    pub occurred_at: String,
    pub data: Value,
}

#[derive(Debug)]
struct EventHub {
    next_id: AtomicU64,
    history: Mutex<VecDeque<AuditEvent>>,
    tx: broadcast::Sender<AuditEvent>,
    publish_lock: Mutex<()>,
}

impl EventHub {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(EVENT_CHANNEL_LIMIT);
        Self { next_id: AtomicU64::new(1), history: Mutex::new(VecDeque::with_capacity(EVENT_HISTORY_LIMIT)), tx, publish_lock: Mutex::new(()) }
    }

    fn publish(&self, event_type: impl Into<String>, data: Value) -> Result<AuditEvent, &'static str> {
        let event_type = event_type.into();
        validate_event(&event_type, &data)?;
        let _publish_lock = self.publish_lock.lock().map_err(|_| "EVENT_HUB_POISONED")?;
        let event = AuditEvent {
            schema_version: 1,
            event_id: self.next_id.fetch_add(1, Ordering::Relaxed),
            event_type,
            occurred_at: Utc::now().to_rfc3339(),
            data,
        };
        if let Ok(mut history) = self.history.lock() {
            history.push_back(event.clone());
            while history.len() > EVENT_HISTORY_LIMIT { history.pop_front(); }
        }
        let _ = self.tx.send(event.clone());
        Ok(event)
    }

    fn recent(&self, since: Option<u64>, limit: usize) -> Vec<AuditEvent> {
        self.history.lock().map(|history| history.iter()
            .filter(|event| since.is_none_or(|id| event.event_id > id))
            .rev().take(limit).cloned().collect::<Vec<_>>()).unwrap_or_default()
    }
}

fn validate_event(event_type: &str, data: &Value) -> Result<(), &'static str> {
    if event_type.is_empty() || event_type.len() > EVENT_TYPE_MAX_BYTES || !event_type.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')) { return Err("INVALID_EVENT_TYPE"); }
    if event_depth(data, 0) > EVENT_PAYLOAD_MAX_DEPTH { return Err("EVENT_PAYLOAD_TOO_DEEP"); }
    let bytes = serde_json::to_vec(data).map_err(|_| "EVENT_PAYLOAD_INVALID")?;
    if bytes.len() > EVENT_PAYLOAD_MAX_BYTES { return Err("EVENT_PAYLOAD_TOO_LARGE"); }
    Ok(())
}

fn event_depth(value: &Value, depth: usize) -> usize {
    match value {
        Value::Array(items) => items.iter().map(|item| event_depth(item, depth + 1)).max().unwrap_or(depth),
        Value::Object(items) => items.values().map(|item| event_depth(item, depth + 1)).max().unwrap_or(depth),
        _ => depth,
    }
}

static HUB: OnceLock<EventHub> = OnceLock::new();

fn hub() -> &'static EventHub { HUB.get_or_init(EventHub::new) }

pub fn publish_event(event_type: impl Into<String>, data: Value) -> Option<AuditEvent> {
    hub().publish(event_type, data).ok()
}

#[derive(Debug, Deserialize)]
pub struct EventQuery {
    since: Option<u64>,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize { 100 }

pub async fn list_events(Query(query): Query<EventQuery>) -> Json<Value> {
    let limit = query.limit.clamp(1, 100);
    Json(serde_json::json!({
        "schemaVersion": 1,
        "items": hub().recent(query.since, limit),
        "nextCursor": null,
    }))
}

pub async fn events_ws(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_events_ws)
}

async fn handle_events_ws(mut socket: WebSocket) {
    let mut receiver = hub().tx.subscribe();
    let hello = serde_json::json!({ "schemaVersion": 1, "eventType": "events.connected", "eventId": 0 });
    if socket.send(Message::Text(hello.to_string().into())).await.is_err() { return; }
    loop {
        match receiver.recv().await {
            Ok(event) => {
                if socket.send(Message::Text(serde_json::to_string(&event).unwrap_or_default().into())).await.is_err() { break; }
            }
            Err(broadcast::error::RecvError::Lagged(count)) => {
                let overflow = serde_json::json!({
                    "schemaVersion": 1,
                    "eventType": "events.overflow",
                    "eventId": 0,
                    "data": { "dropped": count },
                });
                if socket.send(Message::Text(overflow.to_string().into())).await.is_err() { break; }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_bounded_and_since_is_exclusive() {
        for index in 0..(EVENT_HISTORY_LIMIT + 3) { publish_event("test.event", serde_json::json!({ "index": index })).unwrap(); }
        let recent = hub().recent(Some(0), EVENT_HISTORY_LIMIT + 10);
        assert_eq!(recent.len(), EVENT_HISTORY_LIMIT);
        assert!(recent.windows(2).all(|window| window[0].event_id > window[1].event_id));
        let newest = recent.first().unwrap().event_id;
        assert!(hub().recent(Some(newest), EVENT_HISTORY_LIMIT).is_empty());
    }

    #[test]
    fn hostile_payloads_are_rejected_before_history_or_broadcast() {
        assert_eq!(hub().publish("bad type", serde_json::json!({})).unwrap_err(), "INVALID_EVENT_TYPE");
        assert_eq!(hub().publish("too.deep", serde_json::json!([[[[[[[[[0]]]]]]]]])).unwrap_err(), "EVENT_PAYLOAD_TOO_DEEP");
        assert_eq!(hub().publish("too.large", serde_json::json!({ "body": "x".repeat(EVENT_PAYLOAD_MAX_BYTES) })).unwrap_err(), "EVENT_PAYLOAD_TOO_LARGE");
    }

    #[test]
    fn published_event_has_stable_schema() {
        let event = publish_event("test.schema", serde_json::json!({ "safe": true })).unwrap();
        assert_eq!(event.schema_version, 1);
        assert_eq!(event.event_type, "test.schema");
        assert_eq!(event.data["safe"], true);
    }
}
