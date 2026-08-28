use crate::ia::selectors::query_selector;
use crate::ia::helpers::frame_hint_from_node;
use crate::ia::types::*;

/// Security / risk-control popup. Identified first so we freeze outbound
/// instead of clicking OK.
struct PopupSecurityState;

impl IAState for PopupSecurityState {
    fn fsm(&self) -> &str { "popup" }
    fn id(&self) -> &str { "popup_security" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        if has_settings_frame(args.a11y) {
            return Ok(IdentifyResult { identified: false, frame: None });
        }
        let text = collect_popup_text(args.a11y);
        Ok(IdentifyResult {
            identified: crate::risk::is_security_text(&text),
            frame: None,
        })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let mut state = args.prev.clone();
        state.popup = Some(PopupState {
            popup_type: PopupType::Error,
            message: Some(collect_popup_text(args.a11y)),
        });
        state
    }
}

fn collect_popup_text(a11y: &A11yNode) -> String {
    let mut parts = Vec::new();
    collect_names(a11y, &mut parts);
    parts.join(" ")
}

fn collect_names(node: &A11yNode, out: &mut Vec<String>) {
    if matches!(node.role.as_str(), "static" | "label" | "heading") && !node.name.is_empty() {
        out.push(node.name.clone());
    }
    if let Some(children) = &node.children {
        for child in children {
            collect_names(child, out);
        }
    }
}

/// Error popup.
struct PopupErrorState;

/// Check if Settings frame is present (popups inside Settings are handled by settings FSM).
fn has_settings_frame(a11y: &A11yNode) -> bool {
    query_selector(a11y, r#"frame[name="Settings"]"#).is_some()
}

impl IAState for PopupErrorState {
    fn fsm(&self) -> &str { "popup" }
    fn id(&self) -> &str { "popup_error" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        // Exclude matches when Settings frame is open (settings_modal handles those)
        if has_settings_frame(args.a11y) {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        let ok_btn = query_selector(args.a11y, r#"push-button[name="OK"]"#);
        let error_text = query_selector(args.a11y, r#"static[name=/error|failed|timeout|失败|错误/i]"#)
            .or_else(|| query_selector(args.a11y, r#"label[name=/error|failed|timeout|失败|错误/i]"#));

        Ok(IdentifyResult {
            identified: ok_btn.is_some() && error_text.is_some(),
            frame: None,
        })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let error_text = query_selector(args.a11y, r#"static[name=/error|failed|timeout|失败|错误/i]"#)
            .or_else(|| query_selector(args.a11y, r#"label[name=/error|failed|timeout|失败|错误/i]"#));

        let mut state = args.prev.clone();
        state.popup = Some(PopupState {
            popup_type: PopupType::Error,
            message: error_text.map(|n| n.name.clone()),
        });
        state
    }
}

/// Confirm/Tip popup.
struct PopupConfirmState;

impl IAState for PopupConfirmState {
    fn fsm(&self) -> &str { "popup" }
    fn id(&self) -> &str { "popup_confirm" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        // Exclude matches when Settings frame is open (settings_modal handles those)
        if has_settings_frame(args.a11y) {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        let ok_btn = query_selector(args.a11y, r#"push-button[name=/OK|Confirm|确定|确认/i]"#);
        if ok_btn.is_none() {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        let error_in_static = query_selector(args.a11y, r#"static[name=/error|failed|timeout|失败|错误/i]"#).is_some();
        let error_in_label = query_selector(args.a11y, r#"label[name=/error|failed|timeout|失败|错误/i]"#).is_some();
        if error_in_static || error_in_label {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        Ok(IdentifyResult { identified: true, frame: None })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let message_el = query_selector(args.a11y, r#"static[name=/.+/]"#)
            .or_else(|| query_selector(args.a11y, r#"label[name=/^(?!Tip$).+/]"#));

        let mut state = args.prev.clone();
        state.popup = Some(PopupState {
            popup_type: PopupType::Confirm,
            message: message_el.map(|n| n.name.clone()),
        });
        state
    }
}

/// Update/about overlay that can sit on top of the chat UI after app upgrades.
struct WeixinUpdatePopupState;

fn has_weixin_update_frame(frame: &A11yNode) -> bool {
    if frame.role != "frame" || !matches!(frame.name.as_str(), "Weixin" | "WeChat") {
        return false;
    }
    if !frame.states.as_ref().is_some_and(|states| states.iter().any(|state| state == "ACTIVE")) {
        return false;
    }
    query_selector(frame, r#"tool-bar push-button[name="Disable"]"#).is_some()
        && query_selector(frame, r#"label[name=/^Weixin\s+\d+\.\d+\.\d+/]"#).is_some()
}

fn find_weixin_update_frame(node: &A11yNode) -> Option<&A11yNode> {
    if has_weixin_update_frame(node) {
        return Some(node);
    }
    node.children
        .as_ref()?
        .iter()
        .find_map(find_weixin_update_frame)
}

impl IAState for WeixinUpdatePopupState {
    fn fsm(&self) -> &str { "popup" }
    fn id(&self) -> &str { "popup_weixin_update" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        if has_settings_frame(args.a11y) {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        let frame = match find_weixin_update_frame(args.a11y) {
            Some(frame) => frame,
            None => return Ok(IdentifyResult { identified: false, frame: None }),
        };
        Ok(IdentifyResult {
            identified: true,
            frame: frame_hint_from_node(frame),
        })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let mut parts = Vec::new();
        if let Some(frame) = find_weixin_update_frame(args.a11y) {
            collect_names(frame, &mut parts);
        }
        let mut state = args.prev.clone();
        state.popup = Some(PopupState {
            popup_type: PopupType::Info,
            message: Some(parts.join(" ")),
        });
        state
    }
}

pub static POPUP_STATES: std::sync::LazyLock<Vec<Box<dyn IAState>>> = std::sync::LazyLock::new(|| {
    vec![
        Box::new(PopupSecurityState),
        Box::new(PopupErrorState),
        Box::new(PopupConfirmState),
        Box::new(WeixinUpdatePopupState),
    ]
});

#[cfg(test)]
mod tests {
    use crate::ia::identify_states;
    use crate::ia::types::A11yNode;

    fn load_fixture(name: &str) -> A11yNode {
        let json = match name {
            "chat_with_update_overlay.json" => include_str!("test_fixtures/chat_with_update_overlay.json"),
            _ => panic!("Unknown fixture: {name}"),
        };
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn test_weixin_update_overlay_is_identified_as_popup() {
        let a11y = load_fixture("chat_with_update_overlay.json");
        let states = identify_states(&a11y, "");
        assert_eq!(states.main_window.as_ref().unwrap().state_id, "chat");
        assert_eq!(states.popup.as_ref().unwrap().state_id, "popup_weixin_update");
        assert!(states.settings.is_none());
    }
}
