//! Client-pushed monitor interest (OpenClaw allowFrom / dmPolicy).
//!
//! agent-server's chat list otherwise only mirrors WeChat unread badges and
//! has no idea which senders OpenClaw will answer. Extensions PUT their
//! allowlists here; list_chats(?interestOnly=true) then hides out-of-interest
//! DMs so the poll loop is not fed sticky denied unreads.

use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::ia::types::Chat;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInterest {
    /// `allowlist` | `open` | `disabled` — mirrors OpenClaw dmPolicy.
    #[serde(default = "default_dm_policy")]
    pub dm_policy: String,
    #[serde(default)]
    pub dm_allow_from: Vec<String>,
    /// `allowlist` | `open` | `disabled` — mirrors OpenClaw groupPolicy.
    #[serde(default = "default_group_policy")]
    pub group_policy: String,
    #[serde(default)]
    pub group_allow_from: Vec<String>,
    /// Keep system feeds such as newsapp visible even under allowlist.
    #[serde(default = "default_true")]
    pub include_system_feeds: bool,
}

fn default_dm_policy() -> String {
    "disabled".into()
}

fn default_group_policy() -> String {
    "allowlist".into()
}

fn default_true() -> bool {
    true
}

static INTEREST: OnceLock<RwLock<Option<MonitorInterest>>> = OnceLock::new();

fn store() -> &'static RwLock<Option<MonitorInterest>> {
    INTEREST.get_or_init(|| RwLock::new(None))
}

pub fn get_interest() -> Option<MonitorInterest> {
    store().read().ok().and_then(|guard| guard.clone())
}

pub fn set_interest(interest: MonitorInterest) -> MonitorInterest {
    let normalized = normalize_interest(interest);
    if let Ok(mut guard) = store().write() {
        *guard = Some(normalized.clone());
    }
    normalized
}

pub fn clear_interest() {
    if let Ok(mut guard) = store().write() {
        *guard = None;
    }
}

fn strip_prefix(raw: &str) -> String {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["agent-wechat:", "wechat:"] {
        if lower.starts_with(prefix) {
            return trimmed[prefix.len()..].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn normalize_list(values: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let id = strip_prefix(value);
        if id.is_empty() {
            continue;
        }
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

fn normalize_policy(raw: &str, fallback: &str) -> String {
    match raw.trim() {
        "allowlist" | "open" | "disabled" => raw.trim().to_string(),
        _ => fallback.to_string(),
    }
}

pub fn normalize_interest(mut interest: MonitorInterest) -> MonitorInterest {
    interest.dm_policy = normalize_policy(&interest.dm_policy, "disabled");
    interest.group_policy = normalize_policy(&interest.group_policy, "allowlist");
    interest.dm_allow_from = normalize_list(&interest.dm_allow_from);
    interest.group_allow_from = normalize_list(&interest.group_allow_from);
    interest
}

const SYSTEM_FEEDS: &[&str] = &["newsapp"];

fn is_system_feed(chat_id: &str) -> bool {
    SYSTEM_FEEDS.iter().any(|id| *id == chat_id)
}

/// Whether a chat should appear in interest-filtered list results.
pub fn chat_matches_interest(chat: &Chat, interest: &MonitorInterest) -> bool {
    let chat_id = if chat.username.is_empty() {
        chat.id.as_str()
    } else {
        chat.username.as_str()
    };
    let chat_id = strip_prefix(chat_id);

    if interest.include_system_feeds && is_system_feed(&chat_id) {
        return true;
    }

    if chat.is_group || chat_id.contains("@chatroom") {
        return match interest.group_policy.as_str() {
            "open" => true,
            "disabled" => false,
            // groupAllowFrom is sender ids, not room ids — keep group unreads so
            // the extension can apply per-sender policy on messages.
            "allowlist" => true,
            _ => true,
        };
    }

    match interest.dm_policy.as_str() {
        "open" => true,
        "disabled" => false,
        "allowlist" => {
            interest.dm_allow_from.iter().any(|id| id == "*" || id == &chat_id)
        }
        _ => false,
    }
}

pub fn filter_chats_by_interest(chats: Vec<Chat>, interest_only: bool) -> Vec<Chat> {
    if !interest_only {
        return chats;
    }
    let Some(interest) = get_interest() else {
        // No interest pushed yet — do not hide anything (fail open for CLI).
        return chats;
    };
    if interest.dm_policy == "open" && interest.group_policy == "open" {
        return chats;
    }
    chats
        .into_iter()
        .filter(|chat| chat_matches_interest(chat, &interest))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, is_group: bool) -> Chat {
        Chat {
            id: id.into(),
            username: id.into(),
            name: id.into(),
            remark: None,
            last_message_preview: None,
            last_message_sender: None,
            last_activity_at: None,
            unread_count: 1,
            is_group,
            sort_timestamp: 0,
            last_msg_local_id: Some(1),
        }
    }

    #[test]
    fn allowlist_keeps_dm_and_drops_openim_outsider() {
        clear_interest();
        set_interest(MonitorInterest {
            dm_policy: "allowlist".into(),
            dm_allow_from: vec!["vangie".into(), "wechat:jessie_hu".into()],
            group_policy: "allowlist".into(),
            group_allow_from: vec![],
            include_system_feeds: true,
        });
        let interest = get_interest().unwrap();
        assert!(chat_matches_interest(&chat("vangie", false), &interest));
        assert!(chat_matches_interest(&chat("jessie_hu", false), &interest));
        assert!(!chat_matches_interest(
            &chat("25984984400696834@openim", false),
            &interest
        ));
        assert!(chat_matches_interest(&chat("newsapp", false), &interest));
        assert!(chat_matches_interest(&chat("123@chatroom", true), &interest));
    }

    #[test]
    fn filter_fail_open_without_interest() {
        clear_interest();
        let chats = vec![chat("vangie", false), chat("other", false)];
        assert_eq!(filter_chats_by_interest(chats.clone(), true).len(), 2);
    }
}
