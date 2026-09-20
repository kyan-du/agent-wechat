use super::types::{Action, Bounds, ScrollDirection};

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
    r#"push-button[name=/^(Log In|Open WeChat|Enter WeChat|Enter Weixin|登录|打开微信)$/]"#;

/// Adjacent switch-account control (EN / ZH). Auto-resume never clicks this.
pub const SWITCH_ACCOUNT_SELECTOR: &str =
    r#"push-button[name=/^(Switch Account|切换账号|切换帐号)$/]"#;

/// Frame-scoped login click so a ghost "Log In" outside WeChat is ignored.
pub const SAVED_ACCOUNT_LOGIN_IN_FRAME_SELECTOR: &str = concat!(
    r#"frame[name=/^(WeChat|Weixin)$/] "#,
    r#"push-button[name=/^(Log In|Open WeChat|Enter WeChat|Enter Weixin|登录|打开微信)$/]"#,
);

pub fn is_supported_wechat_frame(node: &super::types::A11yNode) -> bool {
    node.role == "frame" && (node.name == "WeChat" || node.name == "Weixin")
}

fn collect_saved_account_login_frames<'a>(
    node: &'a super::types::A11yNode,
    out: &mut Vec<&'a super::types::A11yNode>,
) {
    if is_supported_wechat_frame(node)
        && crate::ia::selectors::query_selector(node, SAVED_ACCOUNT_LOGIN_SELECTOR).is_some()
        && crate::ia::selectors::query_selector(node, SWITCH_ACCOUNT_SELECTOR).is_some()
    {
        out.push(node);
    }
    if let Some(children) = &node.children {
        for child in children {
            collect_saved_account_login_frames(child, out);
        }
    }
}

/// Unique WeChat/Weixin frame that contains exactly one Log In and one Switch Account.
pub fn find_saved_account_login_frame(a11y: &super::types::A11yNode) -> Option<&super::types::A11yNode> {
    let mut frames = Vec::new();
    collect_saved_account_login_frames(a11y, &mut frames);
    if frames.len() != 1 {
        return None;
    }
    let frame = frames[0];
    let logins = crate::ia::selectors::query_selector_all(frame, SAVED_ACCOUNT_LOGIN_SELECTOR);
    let switches = crate::ia::selectors::query_selector_all(frame, SWITCH_ACCOUNT_SELECTOR);
    if logins.len() != 1 || switches.len() != 1 {
        return None;
    }
    Some(frame)
}

/// Click the Log In control inside the paired saved-account frame.
pub fn saved_account_login_click(a11y: &super::types::A11yNode) -> Option<Action> {
    let frame = find_saved_account_login_frame(a11y)?;
    let button = crate::ia::selectors::query_selector(frame, SAVED_ACCOUNT_LOGIN_SELECTOR)?;
    let bounds = button.bounds.as_ref()?;
    if bounds.width <= 0.0 || bounds.height <= 0.0 {
        return None;
    }
    Some(click_bounds(bounds))
}

pub fn click_login() -> Action {
    Action::ClickSelector {
        selector: SAVED_ACCOUNT_LOGIN_IN_FRAME_SELECTOR.to_string(),
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

/// Live calibration (msg 70 / vangie): bounds x=423 w=704 → click x≈500 succeeds;
/// x=440/460/480 fail. Use ~12% of width (clamped to 10–15%), mid-height.
pub fn chat_history_open_point(bounds: &Bounds) -> (f64, f64) {
    let frac = 0.12_f64.clamp(0.10, 0.15);
    let x = (bounds.x + bounds.width * frac).round();
    let y = (bounds.y + bounds.height / 2.0).round();
    (x, y)
}

/// Two ClickCoords with a short wait — Sequence of two clicks is not a true OS
/// double-click, but matches the proven GUI materialization recipe.
pub fn double_click_chat_history_card(bounds: &Bounds) -> Action {
    let (x, y) = chat_history_open_point(bounds);
    sequence(vec![
        click_at(x, y),
        wait(60),
        click_at(x, y),
    ])
}

/// Nested Image rows: thumbnail sits on the LEFT. Center clicks (x≈640) do nothing;
/// left-band double-click opens `Photos and Videos` and re-downloads missing Rec files.
/// `list_bounds` clamps Y into the visible list viewport (rows often extend above it).
pub fn nested_image_thumb_point(row: &Bounds, list_bounds: &Bounds) -> Option<(f64, f64)> {
    let vis_top = row.y.max(list_bounds.y);
    let vis_bottom = (row.y + row.height).min(list_bounds.y + list_bounds.height);
    let vis_h = vis_bottom - vis_top;
    if vis_h < 24.0 {
        return None;
    }
    // ~23% of row width ≈ x+140 for w=596; calibrated open at (480–500, upper third).
    let x = (row.x + (row.width * 0.23).clamp(100.0, 160.0)).round();
    let y = (vis_top + (vis_h * 0.28).min(90.0)).round();
    Some((x, y))
}

/// Double-click nested image thumb, wait for re-download, dismiss Photos lightbox.
pub fn open_nested_image_for_download(row: &Bounds, list_bounds: &Bounds) -> Option<Action> {
    let (x, y) = nested_image_thumb_point(row, list_bounds)?;
    Some(sequence(vec![
        click_at(x, y),
        wait(60),
        click_at(x, y),
        // Photos open triggers CDN/Rec rewrite; Escape too early leaves files missing.
        wait(2200),
        Action::Key {
            combo: "Escape".into(),
        },
        wait(200),
    ]))
}

/// `/opt/tools/scroll` alone often does nothing until Messages is focused.
/// Recipe: click Messages list center, then Page_Up / Page_Down.
/// Nested 聊天记录 detail lists often need wheel scroll (Page_Down alone stalls).
/// Recipe: click list center (focus + cursor), then `/opt/tools/scroll` at the cursor.
/// Keep click and scroll adjacent; window-activate between them can move the cursor.
pub fn focus_list_and_wheel_scroll(list_bounds: &Bounds, direction: ScrollDirection, amount: i32) -> Action {
    let x = (list_bounds.x + list_bounds.width / 2.0).round();
    let y = (list_bounds.y + list_bounds.height / 2.0).round();
    sequence(vec![
        // Bare coords (no --window) so activate does not steal the pointer.
        Action::ClickCoords { x, y },
        wait(80),
        Action::Scroll {
            direction,
            x: Some(x),
            y: Some(y),
            amount: Some(amount.max(1)),
        },
        wait(80),
        Action::Scroll {
            direction,
            x: Some(x),
            y: Some(y),
            amount: Some(amount.max(1)),
        },
    ])
}

pub fn focus_messages_and_page(messages_bounds: &Bounds, direction: ScrollDirection) -> Action {
    let x = (messages_bounds.x + messages_bounds.width / 2.0).round();
    let y = (messages_bounds.y + messages_bounds.height / 2.0).round();
    let combo = match direction {
        ScrollDirection::Up => "Page_Up",
        ScrollDirection::Down => "Page_Down",
    };
    sequence(vec![
        click_at(x, y),
        wait(50),
        Action::Key {
            combo: combo.to_string(),
        },
    ])
}

