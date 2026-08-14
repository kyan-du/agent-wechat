use super::types::{Action, Bounds};

// ============================================
// Common Actions
// ============================================

pub fn wait(ms: u64) -> Action {
    Action::Wait { ms }
}

pub fn wait_short() -> Action {
    Action::Wait { ms: 200 }
}

pub fn wait_long() -> Action {
    Action::Wait { ms: 1000 }
}

// ============================================
// Window Control Actions
// ============================================

pub fn maximize() -> Action {
    Action::ClickSelector {
        selector: r#"tool-bar push-button[name="Maximize"]"#.to_string(),
    }
}

pub fn minimize() -> Action {
    Action::ClickSelector {
        selector: r#"tool-bar push-button[name="Minimize"]"#.to_string(),
    }
}

pub fn close_window() -> Action {
    Action::ClickSelector {
        selector: r#"tool-bar push-button[name="Disable"]"#.to_string(),
    }
}

// ============================================
// Login Actions
// ============================================

/// Saved-account login on the official Linux client (EN / ZH).
pub const SAVED_ACCOUNT_LOGIN_SELECTOR: &str =
    r#"push-button[name=/^(Log In|Open WeChat|登录|打开微信)$/]"#;

/// Adjacent switch-account control (EN / ZH). Auto-resume never clicks this.
pub const SWITCH_ACCOUNT_SELECTOR: &str =
    r#"push-button[name=/^(Switch Account|切换账号|切换帐号)$/]"#;

pub fn click_login() -> Action {
    Action::ClickSelector {
        selector: SAVED_ACCOUNT_LOGIN_SELECTOR.to_string(),
    }
}

pub fn click_switch_account() -> Action {
    Action::ClickSelector {
        selector: SWITCH_ACCOUNT_SELECTOR.to_string(),
    }
}

// ============================================
// Popup Actions
// ============================================

pub fn dismiss_popup() -> Action {
    Action::ClickSelector {
        selector: r#"push-button[name=/OK|Confirm|确定|确认/i]"#.to_string(),
    }
}

pub fn cancel_popup() -> Action {
    Action::ClickSelector {
        selector: r#"push-button[name=/Cancel|取消/i]"#.to_string(),
    }
}

// ============================================
// Helpers
// ============================================

pub fn click_at(x: f64, y: f64) -> Action {
    Action::ClickCoords { x, y }
}

pub fn click_bounds(bounds: &Bounds) -> Action {
    click_at(
        (bounds.x + bounds.width / 2.0).round(),
        (bounds.y + bounds.height / 2.0).round(),
    )
}

/// Click inside the node instead of the exact center every time.
pub fn click_bounds_jitter(bounds: &Bounds) -> Action {
    let (x, y) = jittered_point(bounds);
    click_at(x, y)
}

pub fn jittered_point(bounds: &Bounds) -> (f64, f64) {
    let jx = (next_jitter() % 7) as f64 - 3.0;
    let jy = (next_jitter() % 5) as f64 - 2.0;
    let x = (bounds.x + bounds.width / 2.0 + jx)
        .clamp(bounds.x + 2.0, bounds.x + bounds.width.max(3.0) - 1.0)
        .round();
    let y = (bounds.y + bounds.height / 2.0 + jy)
        .clamp(bounds.y + 2.0, bounds.y + bounds.height.max(3.0) - 1.0)
        .round();
    (x, y)
}

pub fn next_jitter() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.subsec_nanos() ^ (d.as_secs() as u32).wrapping_mul(0x9E37)) as u32)
        .unwrap_or(3)
}

pub fn click_selector(selector: &str) -> Action {
    Action::ClickSelector {
        selector: selector.to_string(),
    }
}

pub fn click_back() -> Action {
    click_selector(r#"push-button[name="Back"]"#)
}

pub fn sequence(actions: Vec<Action>) -> Action {
    Action::Sequence { actions }
}
