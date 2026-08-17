use super::all_ia_states;
use super::selectors::{is_send_button_name, query_selector};
use super::types::{A11yNode, Bounds, IdentifyArgs};
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;

const MAX_ROLE_COUNTS: usize = 16;
const MAX_FRAME_SUMMARIES: usize = 8;
const MAX_ERROR_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateIdentificationDiagnostics {
    pub screenshot_present: bool,
    pub screenshot_bytes: usize,
    pub tree: A11yTreeSummary,
    pub state_outcomes: Vec<StateOutcome>,
    pub chat_rules: ChatRuleDiagnostics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A11yTreeSummary {
    pub node_count: usize,
    pub max_depth: usize,
    pub role_counts: Vec<RoleCount>,
    pub frames: Vec<FrameSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleCount {
    pub role: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSummary {
    pub name_kind: String,
    pub bounds: Option<Bounds>,
    pub pid: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateOutcome {
    pub fsm: String,
    pub state_id: String,
    pub outcome: String,
    pub frame: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRuleDiagnostics {
    pub selectors: Vec<SelectorOutcome>,
    pub chats_list_item_count: usize,
    pub selected_chat_item_count: usize,
    pub editable_text_count: usize,
    pub send_button_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectorOutcome {
    pub selector: String,
    pub matched: bool,
}

pub fn identify_diagnostics(
    a11y_tree: &A11yNode,
    screenshot: &str,
) -> StateIdentificationDiagnostics {
    let args = IdentifyArgs {
        a11y: a11y_tree,
        screenshot,
    };

    let state_outcomes = all_ia_states()
        .iter()
        .map(|state| match state.identify(&args) {
            Ok(result) => StateOutcome {
                fsm: state.fsm().to_string(),
                state_id: state.id().to_string(),
                outcome: if result.identified {
                    "matched"
                } else {
                    "missed"
                }
                .to_string(),
                frame: result.frame.is_some(),
                error: None,
            },
            Err(error) => StateOutcome {
                fsm: state.fsm().to_string(),
                state_id: state.id().to_string(),
                outcome: "error".to_string(),
                frame: false,
                error: Some(truncate(&error, MAX_ERROR_CHARS)),
            },
        })
        .collect();

    StateIdentificationDiagnostics {
        screenshot_present: !screenshot.is_empty(),
        screenshot_bytes: decoded_screenshot_bytes(screenshot),
        tree: summarize_tree(a11y_tree),
        state_outcomes,
        chat_rules: chat_rule_diagnostics(a11y_tree),
    }
}

pub fn diagnostics_json(a11y_tree: &A11yNode, screenshot: &str) -> String {
    serde_json::to_string(&identify_diagnostics(a11y_tree, screenshot))
        .unwrap_or_else(|_| "{\"error\":\"failed_to_serialize_identify_diagnostics\"}".to_string())
}

fn decoded_screenshot_bytes(screenshot: &str) -> usize {
    if screenshot.is_empty() {
        return 0;
    }
    base64::engine::general_purpose::STANDARD
        .decode(screenshot)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

fn summarize_tree(a11y_tree: &A11yNode) -> A11yTreeSummary {
    let mut role_counts = HashMap::new();
    let mut frames = Vec::new();
    let mut node_count = 0;
    let mut max_depth = 0;
    collect_tree_summary(
        a11y_tree,
        0,
        &mut node_count,
        &mut max_depth,
        &mut role_counts,
        &mut frames,
    );

    let mut role_counts: Vec<RoleCount> = role_counts
        .into_iter()
        .map(|(role, count)| RoleCount { role, count })
        .collect();
    role_counts.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.role.cmp(&b.role)));
    role_counts.truncate(MAX_ROLE_COUNTS);

    A11yTreeSummary {
        node_count,
        max_depth,
        role_counts,
        frames,
    }
}

fn collect_tree_summary(
    node: &A11yNode,
    depth: usize,
    node_count: &mut usize,
    max_depth: &mut usize,
    role_counts: &mut HashMap<String, usize>,
    frames: &mut Vec<FrameSummary>,
) {
    *node_count += 1;
    *max_depth = (*max_depth).max(depth);
    *role_counts.entry(node.role.clone()).or_insert(0) += 1;

    if node.role == "frame" && frames.len() < MAX_FRAME_SUMMARIES {
        frames.push(FrameSummary {
            name_kind: frame_name_kind(&node.name).to_string(),
            bounds: node.bounds.clone(),
            pid: node.window.as_ref().map(|w| w.pid),
        });
    }

    if let Some(children) = &node.children {
        for child in children {
            collect_tree_summary(child, depth + 1, node_count, max_depth, role_counts, frames);
        }
    }
}

fn frame_name_kind(name: &str) -> &'static str {
    match name.trim() {
        "" => "empty",
        "Weixin" | "WeChat" => "wechat_main",
        "Settings" => "settings",
        "Network proxy settings" => "network_proxy_settings",
        _ => "other",
    }
}

fn chat_rule_diagnostics(a11y_tree: &A11yNode) -> ChatRuleDiagnostics {
    let selector_names = [
        r#"push-button[name="Weixin"]"#,
        r#"push-button[name="WeChat"]"#,
        r#"push-button[name="Contacts"]"#,
        r#"list[name="Chats"]"#,
        r#"tool-bar[name="Navigation"] push-button[name="More"]"#,
    ];
    let selectors = selector_names
        .iter()
        .map(|selector| SelectorOutcome {
            selector: (*selector).to_string(),
            matched: query_selector(a11y_tree, selector).is_some(),
        })
        .collect();

    let chats_list_item_count = query_selector(a11y_tree, r#"list[name="Chats"]"#)
        .and_then(|list| list.children.as_ref())
        .map(|children| {
            children
                .iter()
                .filter(|child| child.role == "list-item")
                .count()
        })
        .unwrap_or(0);
    let selected_chat_item_count = query_selector(a11y_tree, r#"list[name="Chats"]"#)
        .and_then(|list| list.children.as_ref())
        .map(|children| {
            children
                .iter()
                .filter(|child| {
                    child.role == "list-item"
                        && child
                            .states
                            .as_ref()
                            .map(|states| states.iter().any(|state| state == "SELECTED"))
                            .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);

    ChatRuleDiagnostics {
        selectors,
        chats_list_item_count,
        selected_chat_item_count,
        editable_text_count: count_nodes(a11y_tree, &|node| {
            node.role == "text"
                && node
                    .states
                    .as_ref()
                    .map(|states| states.iter().any(|state| state == "EDITABLE"))
                    .unwrap_or(false)
        }),
        send_button_count: count_nodes(a11y_tree, &|node| {
            node.role == "push-button" && is_send_button_name(&node.name)
        }),
    }
}

fn count_nodes(node: &A11yNode, predicate: &dyn Fn(&A11yNode) -> bool) -> usize {
    let mut count = usize::from(predicate(node));
    if let Some(children) = &node.children {
        for child in children {
            count += count_nodes(child, predicate);
        }
    }
    count
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ia::identify_states;

    fn load_fixture(name: &str) -> A11yNode {
        let json = match name {
            "chat_view" => include_str!("states/test_fixtures/chat_view.json"),
            "chat_open_view" => include_str!("states/test_fixtures/chat_open_view.json"),
            "unknown_chat_without_chats_name" => {
                include_str!("states/test_fixtures/unknown_chat_without_chats_name.json")
            }
            _ => panic!("unknown fixture {name}"),
        };
        serde_json::from_str(json).expect("fixture parses")
    }

    #[test]
    fn reports_positive_chat_rule_outcomes() {
        let tree = load_fixture("chat_view");
        let diagnostics = identify_diagnostics(&tree, "");

        assert_eq!(diagnostics.tree.node_count, 10);
        assert!(diagnostics
            .state_outcomes
            .iter()
            .any(|outcome| outcome.state_id == "chat" && outcome.outcome == "matched"));
        assert!(diagnostics
            .chat_rules
            .selectors
            .iter()
            .any(|selector| selector.selector == r#"list[name="Chats"]"# && selector.matched));
        assert_eq!(diagnostics.chat_rules.chats_list_item_count, 2);
    }

    #[test]
    fn reports_chat_open_selected_item_rule() {
        let tree = load_fixture("chat_open_view");
        let states = identify_states(&tree, "");
        let diagnostics = identify_diagnostics(&tree, "");

        assert_eq!(
            states
                .main_window
                .as_ref()
                .map(|state| state.state_id.as_str()),
            Some("chat_open")
        );
        assert_eq!(diagnostics.chat_rules.selected_chat_item_count, 1);
        assert!(diagnostics
            .state_outcomes
            .iter()
            .any(|outcome| outcome.state_id == "chat_open" && outcome.outcome == "matched"));
    }

    #[test]
    fn explains_unknown_chat_tree_without_sensitive_names() {
        let tree = load_fixture("unknown_chat_without_chats_name");
        let states = identify_states(&tree, "");
        let diagnostics = identify_diagnostics(&tree, "AQID");
        let json = serde_json::to_string(&diagnostics).expect("diagnostics serialize");

        assert!(states.main_window.is_none());
        assert!(diagnostics.screenshot_present);
        assert_eq!(diagnostics.screenshot_bytes, 3);
        assert!(diagnostics
            .chat_rules
            .selectors
            .iter()
            .any(|selector| selector.selector == r#"list[name="Chats"]"# && !selector.matched));
        assert!(json.contains("\"nameKind\":\"wechat_main\""));
        assert!(!json.contains("Private Chat"));
    }
}
