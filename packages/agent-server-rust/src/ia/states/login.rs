use crate::ia::helpers::find_frame_for;
use crate::ia::selectors::{query_selector};
use crate::ia::types::*;
use crate::tools::qr::decode_qr_from_base64;
use super::base::extract_window_control_bounds;

/// login_qr: WeChat shows a QR code to scan.
struct LoginQrState;

impl IAState for LoginQrState {
    fn fsm(&self) -> &str { "mainWindow" }
    fn id(&self) -> &str { "login_qr" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        let scan_label = query_selector(args.a11y, r#"label[name*="Scan to log in"]"#);
        if scan_label.is_none() {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        let has_transfer = query_selector(args.a11y, r#"push-button[name*="Transfer files only"]"#).is_some();
        if !has_transfer {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        let qr = decode_qr_from_base64(args.screenshot);
        let has_wechat_qr = qr.as_ref().map(|r| r.data.starts_with("http://weixin.qq.com/x/")).unwrap_or(false);
        if !has_wechat_qr {
            return Ok(IdentifyResult { identified: false, frame: None });
        }

        Ok(IdentifyResult { identified: true, frame: find_frame_for(args.a11y, r#"label[name*="Scan to log in"]"#) })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let screenshot_b64 = base64::engine::general_purpose::STANDARD.encode(args.screenshot);
        let qr = decode_qr_from_base64(&screenshot_b64);
        let wb = extract_window_control_bounds(None);

        let mut state = args.prev.clone();
        state.main_window.view = MainWindowView::LoginQr;
        state.main_window.is_logged_in = false;
        if let Some(qr_result) = qr {
            state.main_window.qr_data = Some(qr_result.data);
            state.main_window.qr_binary_data = Some(qr_result.binary_data);
        }
        state.main_window.close_button_bounds = wb.close_button_bounds;
        state.main_window.minimize_button_bounds = wb.minimize_button_bounds;
        state.main_window.maximize_button_bounds = wb.maximize_button_bounds;
        state
    }
}

/// login_account: WeChat shows a saved account to confirm.
struct LoginAccountState;

impl IAState for LoginAccountState {
    fn fsm(&self) -> &str { "mainWindow" }
    fn id(&self) -> &str { "login_account" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        let Some(frame) = crate::ia::actions::find_saved_account_login_frame(args.a11y) else {
            return Ok(IdentifyResult { identified: false, frame: None });
        };
        Ok(IdentifyResult {
            identified: true,
            frame: crate::ia::helpers::frame_hint_from_node(frame),
        })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let name_el = query_selector(args.a11y, r#"label[name*="Current User"]"#);
        let account_name = name_el
            .map(|n| n.name.replace("Current User", "").trim().to_string())
            .filter(|s| !s.is_empty());

        let mut state = args.prev.clone();
        state.main_window.view = MainWindowView::LoginAccount;
        state.main_window.is_logged_in = false;
        state.main_window.account_name = account_name;
        state
    }
}

/// login_phone_confirm: User needs to confirm on phone.
struct LoginPhoneConfirmState;

impl IAState for LoginPhoneConfirmState {
    fn fsm(&self) -> &str { "mainWindow" }
    fn id(&self) -> &str { "login_phone_confirm" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        let confirm = query_selector(args.a11y, r#"label[name=/Comfirm on phone|Confirm.*phone|手机确认/i]"#);
        Ok(IdentifyResult {
            identified: confirm.is_some(),
            frame: if confirm.is_some() { find_frame_for(args.a11y, r#"label[name=/Comfirm on phone|Confirm.*phone|手机确认/i]"#) } else { None },
        })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let mut state = args.prev.clone();
        state.main_window.view = MainWindowView::LoginPhoneConfirm;
        state.main_window.is_logged_in = false;
        state
    }
}

/// login_loading: Transitional state while logging in.
struct LoginLoadingState;

impl IAState for LoginLoadingState {
    fn fsm(&self) -> &str { "mainWindow" }
    fn id(&self) -> &str { "login_loading" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        // Case 1: "Entering" or "Loading X%" labels
        if query_selector(args.a11y, r#"label[name="Entering"]"#).is_some() {
            return Ok(IdentifyResult { identified: true, frame: find_frame_for(args.a11y, r#"label[name="Entering"]"#) });
        }
        if query_selector(args.a11y, r#"label[name*="Loading"]"#).is_some() {
            return Ok(IdentifyResult { identified: true, frame: find_frame_for(args.a11y, r#"label[name*="Loading"]"#) });
        }

        // Case 2: Nav buttons but no Chats list
        let main_btn = query_selector(args.a11y, r#"push-button[name="Weixin"]"#)
            .or_else(|| query_selector(args.a11y, r#"push-button[name="WeChat"]"#));
        let has_contacts = query_selector(args.a11y, r#"push-button[name="Contacts"]"#).is_some();
        let has_chats = query_selector(args.a11y, r#"list[name="Chats"]"#).is_some();

        if main_btn.is_some() && has_contacts && !has_chats {
            return Ok(IdentifyResult { identified: true, frame: find_frame_for(args.a11y, r#"push-button[name="Contacts"]"#) });
        }

        Ok(IdentifyResult { identified: false, frame: None })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let mut state = args.prev.clone();
        state.main_window.view = MainWindowView::LoginLoading;
        state.main_window.is_logged_in = false;
        state
    }
}

/// network_proxy_settings: WeChat network proxy settings page.
struct NetworkProxySettingsState;

impl IAState for NetworkProxySettingsState {
    fn fsm(&self) -> &str { "mainWindow" }
    fn id(&self) -> &str { "network_proxy_settings" }

    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String> {
        let title = query_selector(args.a11y, r#"label[name="Network proxy settings"]"#);
        let checkbox = query_selector(args.a11y, r#"check-box[name="Use proxy"]"#);
        let identified = title.is_some() && checkbox.is_some();
        Ok(IdentifyResult {
            identified,
            frame: if identified { find_frame_for(args.a11y, r#"label[name="Network proxy settings"]"#) } else { None },
        })
    }

    fn reduce(&self, args: &ReduceArgs) -> AppState {
        let checkbox = query_selector(args.a11y, r#"check-box[name="Use proxy"]"#);
        let is_checked = checkbox
            .and_then(|n| n.states.as_ref())
            .map(|s| s.iter().any(|st| st == "CHECKED"))
            .unwrap_or(false);

        let has_discard = query_selector(args.a11y, r#"label[name="Discard changes?"]"#).is_some();

        let mut state = args.prev.clone();
        state.main_window.view = MainWindowView::NetworkProxySettings;
        state.main_window.proxy_enabled = Some(is_checked);
        state.main_window.proxy_save_failed = Some(has_discard);
        state
    }
}

use base64::Engine;

/// All login states (order matters — first match wins).
pub static LOGIN_STATES: std::sync::LazyLock<Vec<Box<dyn IAState>>> = std::sync::LazyLock::new(|| {
    vec![
        Box::new(NetworkProxySettingsState),
        Box::new(LoginQrState),
        Box::new(LoginAccountState),
        Box::new(LoginPhoneConfirmState),
        Box::new(LoginLoadingState),
    ]
});

#[cfg(test)]
mod tests {
    use crate::ia::actions::{
        click_login, click_switch_account, saved_account_login_click,
        SAVED_ACCOUNT_LOGIN_IN_FRAME_SELECTOR, SAVED_ACCOUNT_LOGIN_SELECTOR,
        SWITCH_ACCOUNT_SELECTOR,
    };
    use crate::ia::identify_states;
    use crate::ia::selectors::query_selector;
    use crate::ia::types::{A11yNode, Action, Bounds};

    fn node(role: &str, name: &str, children: Option<Vec<A11yNode>>) -> A11yNode {
        A11yNode {
            role: role.into(),
            name: name.into(),
            bounds: Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 40.0,
            }),
            children,
            parent_index: None,
            window: None,
            states: None,
        }
    }

    fn login_account_tree(login: &str, switch: &str) -> A11yNode {
        node(
            "desktop-frame",
            "main",
            Some(vec![node(
                "application",
                "wechat",
                Some(vec![node(
                    "frame",
                    "WeChat",
                    Some(vec![
                        node("label", "Current User Test", None),
                        node("push-button", login, None),
                        node("push-button", switch, None),
                    ]),
                )]),
            )]),
        )
    }

    fn load_fixture(name: &str) -> A11yNode {
        let json = match name {
            "saved_account_enter_weixin" => {
                include_str!("test_fixtures/saved_account_enter_weixin.json")
            }
            _ => panic!("unknown fixture {name}"),
        };
        serde_json::from_str(json).expect("fixture parses")
    }

    fn ghost_then_wechat_tree(ghost_login: bool, wechat_login: bool, wechat_switch: bool) -> A11yNode {
        let mut wechat_kids = vec![node("label", "Current User Test", None)];
        if wechat_login {
            wechat_kids.push(A11yNode {
                role: "push-button".into(),
                name: "Log In".into(),
                bounds: Some(Bounds {
                    x: 640.0,
                    y: 480.0,
                    width: 80.0,
                    height: 32.0,
                }),
                children: None,
                parent_index: None,
                window: None,
                states: None,
            });
        }
        if wechat_switch {
            wechat_kids.push(node("push-button", "Switch Account", None));
        }
        let ghost = if ghost_login {
            node(
                "frame",
                "OtherApp",
                Some(vec![A11yNode {
                    role: "push-button".into(),
                    name: "Log In".into(),
                    bounds: Some(Bounds {
                        x: 10.0,
                        y: 10.0,
                        width: 40.0,
                        height: 20.0,
                    }),
                    children: None,
                    parent_index: None,
                    window: None,
                    states: None,
                }]),
            )
        } else {
            node("frame", "OtherApp", None)
        };
        node(
            "desktop-frame",
            "main",
            Some(vec![ghost, node("frame", "WeChat", Some(wechat_kids))]),
        )
    }

    fn identified_main_id(tree: &A11yNode) -> Option<String> {
        identify_states(tree, "").main_window.map(|s| s.state_id)
    }

    #[test]
    fn identifies_english_log_in_with_switch_account() {
        let tree = login_account_tree("Log In", "Switch Account");
        assert_eq!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn identifies_open_wechat_with_switch_account() {
        let tree = login_account_tree("Open WeChat", "Switch Account");
        assert_eq!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn identifies_enter_wechat_with_switch_account() {
        let tree = login_account_tree("Enter WeChat", "Switch Account");
        assert_eq!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn identifies_enter_weixin_with_switch_account() {
        let tree = login_account_tree("Enter Weixin", "Switch Account");
        assert_eq!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn identifies_captured_enter_weixin_saved_account_fixture() {
        let tree = load_fixture("saved_account_enter_weixin");
        assert_eq!(identified_main_id(&tree).as_deref(), Some("login_account"));

        let action = saved_account_login_click(&tree).expect("saved account login click");
        let Action::ClickCoords { x, y } = action else {
            panic!("expected exact bounds click");
        };
        assert_eq!((x, y), (640.0, 487.0));
    }

    #[test]
    fn identifies_chinese_login_with_switch_account() {
        let tree = login_account_tree("登录", "切换账号");
        assert_eq!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn identifies_chinese_login_with_variant_switch_account() {
        let tree = login_account_tree("打开微信", "切换帐号");
        assert_eq!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn does_not_identify_log_in_without_switch_account() {
        let tree = node(
            "desktop-frame",
            "main",
            Some(vec![node("push-button", "Log In", None)]),
        );
        assert_ne!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn click_login_selector_is_frame_scoped_and_skips_switch() {
        let Action::ClickSelector { selector } = click_login() else {
            panic!("click_login must be ClickSelector");
        };
        assert_eq!(selector, SAVED_ACCOUNT_LOGIN_IN_FRAME_SELECTOR);

        for name in [
            "Log In",
            "Open WeChat",
            "Enter WeChat",
            "Enter Weixin",
            "登录",
            "打开微信",
        ] {
            let tree = node("push-button", name, None);
            assert!(query_selector(&tree, SAVED_ACCOUNT_LOGIN_SELECTOR).is_some());
        }

        let switch = node("push-button", "Switch Account", None);
        assert!(query_selector(&switch, SAVED_ACCOUNT_LOGIN_SELECTOR).is_none());
        assert!(query_selector(&switch, &selector).is_none());
    }

    #[test]
    fn ghost_log_in_without_paired_wechat_controls_is_not_login_account() {
        let tree = ghost_then_wechat_tree(true, false, true);
        assert_ne!(identified_main_id(&tree).as_deref(), Some("login_account"));
    }

    #[test]
    fn two_paired_wechat_frames_are_ambiguous_and_not_identified() {
        let one = node(
            "frame",
            "WeChat",
            Some(vec![
                node("push-button", "Log In", None),
                node("push-button", "Switch Account", None),
            ]),
        );
        let two = node(
            "frame",
            "Weixin",
            Some(vec![
                node("push-button", "Log In", None),
                node("push-button", "Switch Account", None),
            ]),
        );
        let tree = node("desktop-frame", "main", Some(vec![one, two]));
        assert_ne!(identified_main_id(&tree).as_deref(), Some("login_account"));
        assert!(saved_account_login_click(&tree).is_none());
    }

    #[test]
    fn duplicate_login_controls_in_one_frame_fail_closed() {
        let tree = node(
            "desktop-frame",
            "main",
            Some(vec![node(
                "frame",
                "WeChat",
                Some(vec![
                    node("push-button", "Log In", None),
                    node("push-button", "Open WeChat", None),
                    node("push-button", "Switch Account", None),
                ]),
            )]),
        );
        assert_ne!(identified_main_id(&tree).as_deref(), Some("login_account"));
        assert!(saved_account_login_click(&tree).is_none());
    }

    #[test]
    fn paired_wechat_controls_win_over_earlier_ghost_log_in() {
        let tree = ghost_then_wechat_tree(true, true, true);
        let states = identify_states(&tree, "");
        assert_eq!(
            states.main_window.as_ref().map(|s| s.state_id.as_str()),
            Some("login_account")
        );
        let action = saved_account_login_click(&tree).expect("paired login click");
        let Action::ClickCoords { x, y } = action else {
            panic!("expected exact bounds click");
        };
        assert_eq!((x, y), (680.0, 496.0));
    }

    #[test]
    fn click_switch_account_selector_matches_en_and_zh() {
        let Action::ClickSelector { selector } = click_switch_account() else {
            panic!("click_switch_account must be ClickSelector");
        };
        assert_eq!(selector, SWITCH_ACCOUNT_SELECTOR);
        for name in ["Switch Account", "切换账号", "切换帐号"] {
            let tree = node("push-button", name, None);
            assert!(query_selector(&tree, &selector).is_some());
        }
        let login = node("push-button", "Log In", None);
        assert!(query_selector(&login, &selector).is_none());
    }
}
