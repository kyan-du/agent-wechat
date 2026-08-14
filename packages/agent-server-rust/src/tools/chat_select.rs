use super::exec::{exec_command, ExecOptions};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

const CURRENT_CHAT_PATH: &str = "/tmp/agent-wechat-current-chat";
const CHAT_SELECT_TIMEOUT_MS: u64 = 50_000;

pub fn cached_current_chat() -> Option<String> {
    std::fs::read_to_string(CURRENT_CHAT_PATH)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn remember_current_chat(chat_id: &str) {
    let _ = std::fs::write(CURRENT_CHAT_PATH, chat_id);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenChatResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_frida: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frida_attach_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSelectDiagnostics {
    pub fallback_total: u64,
    pub attach_total: u64,
    pub timeout_total: u64,
    pub failure_total: u64,
    pub open_total: u64,
    pub verify_total: u64,
    pub last_duration_ms: u64,
}

static FALLBACK_TOTAL: AtomicU64 = AtomicU64::new(0);
static ATTACH_TOTAL: AtomicU64 = AtomicU64::new(0);
static TIMEOUT_TOTAL: AtomicU64 = AtomicU64::new(0);
static FAILURE_TOTAL: AtomicU64 = AtomicU64::new(0);
static OPEN_TOTAL: AtomicU64 = AtomicU64::new(0);
static VERIFY_TOTAL: AtomicU64 = AtomicU64::new(0);
static LAST_DURATION_MS: AtomicU64 = AtomicU64::new(0);

pub fn diagnostics() -> ChatSelectDiagnostics {
    let load = |value: &AtomicU64| value.load(Ordering::Relaxed);
    ChatSelectDiagnostics {
        fallback_total: load(&FALLBACK_TOTAL),
        attach_total: load(&ATTACH_TOTAL),
        timeout_total: load(&TIMEOUT_TOTAL),
        failure_total: load(&FAILURE_TOTAL),
        open_total: load(&OPEN_TOTAL),
        verify_total: load(&VERIFY_TOTAL),
        last_duration_ms: load(&LAST_DURATION_MS),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum TargetConfirmationError {
    OpenFailed,
    NotVerified,
    IdentityMismatch,
}

impl TargetConfirmationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::OpenFailed => "open_failed",
            Self::NotVerified => "not_verified",
            Self::IdentityMismatch => "identity_mismatch",
        }
    }
}

/// Require chat-select to prove that the live current conversation exactly
/// matches the requested target. A successful hook/click alone is not enough.
pub fn confirm_target(
    result: &OpenChatResult,
    expected_chat_id: &str,
) -> Result<(), TargetConfirmationError> {
    if !result.ok {
        return Err(TargetConfirmationError::OpenFailed);
    }
    if result.verified != Some(true) {
        return Err(TargetConfirmationError::NotVerified);
    }
    if result.username.as_deref() != Some(expected_chat_id) {
        return Err(TargetConfirmationError::IdentityMismatch);
    }
    Ok(())
}

/// Confirm the live current conversation without clicking or typing.
pub async fn verify_active_chat(chat_id: &str) -> OpenChatResult {
    run_chat_select(&["--verify-only", chat_id]).await
}

/// Live identity from the a11y header + every contact that can own that name.
/// A truncated session window is not sufficient: one Alice in the newest 200
/// sessions is not proof if another Alice exists anywhere.
pub fn confirm_opened_name(
    opened_name: Option<&str>,
    target: &str,
    matching_usernames: &[String],
) -> Result<(), TargetConfirmationError> {
    let name = opened_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(TargetConfirmationError::NotVerified)?;
    let _ = name;
    if matching_usernames.len() != 1 {
        return Err(TargetConfirmationError::NotVerified);
    }
    if matching_usernames[0] != target {
        return Err(TargetConfirmationError::IdentityMismatch);
    }
    Ok(())
}

pub fn identity_needs_frida(
    opened_name: Option<&str>,
    target: &str,
    matching_usernames: &[String],
) -> bool {
    confirm_opened_name(opened_name, target, matching_usernames).is_err()
}

/// Open a chat in the WeChat UI using the chat-select tool.
///
/// Args format: chat-select [--force] [--click-xy X Y] <username>
pub async fn open_chat(chat_id: &str, force: bool, click_xy: Option<(f64, f64)>) -> OpenChatResult {
    let mut args: Vec<String> = Vec::new();

    if force {
        args.push("--force".into());
    }

    if let Some((x, y)) = click_xy {
        args.push("--click-xy".into());
        args.push((x as i32).to_string());
        args.push((y as i32).to_string());
    }

    // chat_id is a positional arg — must be last
    args.push(chat_id.into());

    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_chat_select(&args_ref).await
}

fn positional_chat_id<'a>(args: &[&'a str]) -> Option<&'a str> {
    args.iter().rev().copied().find(|arg| !arg.starts_with('-'))
}

async fn run_chat_select(args: &[&str]) -> OpenChatResult {
    let verify_only = args.contains(&"--verify-only");
    if verify_only {
        VERIFY_TOTAL.fetch_add(1, Ordering::Relaxed);
    } else {
        OPEN_TOTAL.fetch_add(1, Ordering::Relaxed);
    }

    let result = exec_command(
        "chat-select",
        args,
        &ExecOptions {
            session: None,
            timeout_ms: CHAT_SELECT_TIMEOUT_MS,
        },
    )
    .await;

    // Result JSON is on stdout regardless of exit code.
    if let Ok(parsed) = serde_json::from_str::<OpenChatResult>(&result.stdout) {
        let attach_count = parsed.frida_attach_count.unwrap_or(0);
        if parsed.used_frida == Some(true) || attach_count > 0 {
            FALLBACK_TOTAL.fetch_add(1, Ordering::Relaxed);
        }
        ATTACH_TOTAL.fetch_add(attach_count, Ordering::Relaxed);
        LAST_DURATION_MS.store(parsed.duration_ms.unwrap_or(0), Ordering::Relaxed);
        if matches!(
            parsed.error_code.as_deref(),
            Some("FRIDA_ATTACH_TIMEOUT" | "CHAT_SELECT_TIMEOUT")
        ) {
            TIMEOUT_TOTAL.fetch_add(1, Ordering::Relaxed);
        }
        if !parsed.ok {
            FAILURE_TOTAL.fetch_add(1, Ordering::Relaxed);
        }
        if parsed.ok {
            if let Some(chat_id) = parsed
                .username
                .as_deref()
                .or_else(|| positional_chat_id(args))
            {
                remember_current_chat(chat_id);
            }
        }
        return parsed;
    }

    FAILURE_TOTAL.fetch_add(1, Ordering::Relaxed);
    let timed_out = result.stderr == "Command timed out";
    if timed_out {
        TIMEOUT_TOTAL.fetch_add(1, Ordering::Relaxed);
    }
    OpenChatResult {
        ok: false,
        username: None,
        index: None,
        skipped: None,
        verified: None,
        used_frida: None,
        frida_attach_count: None,
        duration_ms: None,
        error_code: Some(
            if timed_out {
                "CHAT_SELECT_TIMEOUT"
            } else {
                "CHAT_SELECT_INVALID_RESPONSE"
            }
            .to_string(),
        ),
        error: Some(if timed_out {
            "Chat selection timed out".to_string()
        } else {
            "Chat selection failed without a valid diagnostic response".to_string()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(username: Option<&str>, verified: Option<bool>) -> OpenChatResult {
        OpenChatResult {
            ok: true,
            username: username.map(str::to_string),
            index: Some(1),
            skipped: Some(true),
            verified,
            used_frida: Some(false),
            frida_attach_count: Some(0),
            duration_ms: Some(0),
            error_code: None,
            error: None,
        }
    }

    #[test]
    fn exact_verified_target_is_accepted() {
        assert_eq!(
            confirm_target(&result(Some("target"), Some(true)), "target"),
            Ok(())
        );
    }

    #[test]
    fn missing_confirmation_fails_closed() {
        assert_eq!(
            confirm_target(&result(Some("target"), None), "target"),
            Err(TargetConfirmationError::NotVerified)
        );
    }

    #[test]
    fn mismatched_identity_fails_closed() {
        assert_eq!(
            confirm_target(&result(Some("other"), Some(true)), "target"),
            Err(TargetConfirmationError::IdentityMismatch)
        );
    }

    #[test]
    fn unique_display_name_proves_target_without_frida() {
        let matches = vec!["wxid_a".to_string()];
        assert!(confirm_opened_name(Some("Alice"), "wxid_a", &matches).is_ok());
        assert!(!identity_needs_frida(Some("Alice"), "wxid_a", &matches));
    }

    #[test]
    fn unique_display_name_mismatch_fails_closed() {
        let matches = vec!["wxid_b".to_string()];
        assert_eq!(
            confirm_opened_name(Some("Bob"), "wxid_a", &matches),
            Err(TargetConfirmationError::IdentityMismatch)
        );
    }

    #[test]
    fn ambiguous_or_missing_name_is_not_proof() {
        let matches = vec!["wxid_a".to_string(), "wxid_c".to_string()];
        assert_eq!(
            confirm_opened_name(Some("Alice"), "wxid_a", &matches),
            Err(TargetConfirmationError::NotVerified)
        );
        assert!(identity_needs_frida(Some("Alice"), "wxid_a", &matches));
        assert!(identity_needs_frida(None, "wxid_a", &[]));
    }

    #[test]
    fn duplicate_outside_session_window_is_not_unique() {
        // Newest-200 session window would only see A. The live header is B,
        // another Alice outside that window. Full contact match must fail closed.
        let session_window_only = vec!["wxid_a".to_string()];
        assert!(
            confirm_opened_name(Some("Alice"), "wxid_a", &session_window_only).is_ok(),
            "truncated window would wrongly prove A"
        );
        let all_contacts = vec!["wxid_a".to_string(), "wxid_b".to_string()];
        assert_eq!(
            confirm_opened_name(Some("Alice"), "wxid_a", &all_contacts),
            Err(TargetConfirmationError::NotVerified)
        );
    }
}
