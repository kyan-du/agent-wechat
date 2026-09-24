use super::selectors::{is_send_button_name, query_selector};
use super::types::{A11yNode, Bounds, FrameHint, IdentifiedStates};

/// Generate a stable hash from a string.
fn hash_string(s: &str) -> String {
    let mut hash: i32 = 0;
    for ch in s.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as i32);
    }
    format!("{}", hash.unsigned_abs())
}

/// Extract active chat ID from message view header.
pub fn extract_active_chat_id(a11y: &A11yNode) -> Option<String> {
    let header = query_selector(a11y, "label[name=/.+/]")?;
    if !header.name.is_empty() {
        Some(format!("chat_{}", hash_string(&header.name)))
    } else {
        None
    }
}

/// Check if bounds are valid (non-zero size).
pub fn has_valid_bounds(bounds: &Option<Bounds>) -> bool {
    bounds
        .as_ref()
        .map(|b| b.width > 0.0 && b.height > 0.0)
        .unwrap_or(false)
}

/// Calculate center point of bounds.
pub fn get_bounds_center(bounds: &Bounds) -> (f64, f64) {
    (
        (bounds.x + bounds.width / 2.0).round(),
        (bounds.y + bounds.height / 2.0).round(),
    )
}

/// Check whether an a11y node carries the given state (e.g. "FOCUSED",
/// "DISABLED", "EDITABLE").
pub fn node_has_state(node: &A11yNode, state: &str) -> bool {
    node.states
        .as_ref()
        .map(|s| s.iter().any(|st| st == state))
        .unwrap_or(false)
}

/// The main application frame is named "Weixin" or "WeChat" depending on
/// build/locale (the in-repo fixtures use "WeChat"; chat.rs matches both
/// names for the nav button for the same reason).
fn is_main_frame(node: &A11yNode) -> bool {
    node.role == "frame" && (node.name == "Weixin" || node.name == "WeChat")
}

/// A candidate composer: the editable text input plus its sibling localized Send button.
struct ComposerPair<'a> {
    edit: &'a A11yNode,
    send: &'a A11yNode,
    /// True if this pair lives under the main application frame
    /// (as opposed to a detached/ghost chat frame leftover in the a11y tree).
    in_main_frame: bool,
}

/// Find the composer (editable + localized Send button) to operate on.
///
/// WeChat's accessibility tree can contain *multiple* edit+send pairs:
/// the live main-window composer plus stale "ghost" frames left behind by
/// chats that were previously detached into separate windows. A naive
/// depth-first "take the first pair" grabs the wrong (ghost) composer, whose
/// input never receives text and whose Send stays DISABLED forever, causing
/// plans to loop and ultimately fail with "No action selected".
///
/// To be robust we collect every candidate pair, then rank them so the
/// genuinely active composer wins:
///   1. editable currently FOCUSED          (strongest signal)
///   2. Send button NOT disabled            (composer already has text)
///   3. pair under the main application frame (not a ghost/detached frame)
/// The first pair (DFS order) breaks any remaining ties.
pub fn find_edit_and_send_button(a11y: &A11yNode) -> Option<(&A11yNode, &A11yNode)> {
    find_ranked_composer(a11y, false)
}

/// Find a composer that belongs to the live main WeChat frame. State
/// identification uses this stricter variant so a detached-window composer
/// cannot make an empty main window look like an open chat.
pub fn find_main_edit_and_send_button(a11y: &A11yNode) -> Option<(&A11yNode, &A11yNode)> {
    find_ranked_composer(a11y, true)
}

fn find_ranked_composer(a11y: &A11yNode, main_frame_only: bool) -> Option<(&A11yNode, &A11yNode)> {
    let mut candidates: Vec<ComposerPair> = Vec::new();
    collect_edit_send_pairs(a11y, false, &mut candidates);

    // Rank lexicographically; `false` sorts before `true`, so each criterion
    // is written as "false = preferred". DFS index breaks ties.
    candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| !main_frame_only || candidate.in_main_frame)
        .min_by_key(|(idx, c)| {
            (
                !node_has_state(c.edit, "FOCUSED"),
                node_has_state(c.send, "DISABLED"),
                !c.in_main_frame,
                *idx,
            )
        })
        .map(|(_, c)| (c.edit, c.send))
}

fn is_search_field(node: &A11yNode) -> bool {
    let name = node.name.trim();
    name.eq_ignore_ascii_case("Search") || name == "搜索"
}

fn is_composer_edit(node: &A11yNode) -> bool {
    node.role == "text" && node_has_state(node, "EDITABLE") && !is_search_field(node)
}

fn descendant_composer_edits<'a>(node: &'a A11yNode) -> Vec<&'a A11yNode> {
    let mut out = Vec::new();
    fn walk<'a>(node: &'a A11yNode, out: &mut Vec<&'a A11yNode>) {
        if is_composer_edit(node) {
            out.push(node);
        }
        if let Some(children) = &node.children {
            for child in children {
                walk(child, out);
            }
        }
    }
    walk(node, &mut out);
    out
}

fn descendant_send_buttons<'a>(node: &'a A11yNode) -> Vec<&'a A11yNode> {
    let mut out = Vec::new();
    fn walk<'a>(node: &'a A11yNode, out: &mut Vec<&'a A11yNode>) {
        if node.role == "push-button" && is_send_button_name(&node.name) {
            out.push(node);
        }
        if let Some(children) = &node.children {
            for child in children {
                walk(child, out);
            }
        }
    }
    walk(node, &mut out);
    out
}

fn bounds_center(bounds: &Bounds) -> (f64, f64) {
    (
        bounds.x + bounds.width / 2.0,
        bounds.y + bounds.height / 2.0,
    )
}

fn distance_sq(a: &A11yNode, b: &A11yNode) -> f64 {
    match (&a.bounds, &b.bounds) {
        (Some(ab), Some(bb)) => {
            let (ax, ay) = bounds_center(ab);
            let (bx, by) = bounds_center(bb);
            let dx = ax - bx;
            let dy = ay - by;
            dx * dx + dy * dy
        }
        _ => f64::MAX / 4.0,
    }
}

fn nearest_send<'a>(edit: &'a A11yNode, sends: &[&'a A11yNode]) -> Option<&'a A11yNode> {
    sends.iter().copied().min_by(|a, b| {
        distance_sq(edit, a)
            .partial_cmp(&distance_sq(edit, b))
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

/// Recursively collect all edit+send composer pairs, tracking whether each
/// pair is inside the main application frame.
///
/// WeChat 4.1.x often places the editable composer and the localized Send
/// button under different cousin branches (edit under a filler, Send under a
/// toolbar), so sibling-only matching misses the live composer. After the
/// legacy sibling pass we also pair non-Search editable text with the nearest
/// Send button under the same subtree when the pair has not already been
/// recorded.
fn collect_edit_send_pairs<'a>(
    node: &'a A11yNode,
    in_main_frame: bool,
    out: &mut Vec<ComposerPair<'a>>,
) {
    // Once we enter the main frame, everything below it is in-main.
    let in_main_frame = in_main_frame || is_main_frame(node);

    if let Some(children) = &node.children {
        let send_btn = children
            .iter()
            .find(|c| c.role == "push-button" && is_send_button_name(&c.name));
        let edit_node = children
            .iter()
            .find(|c| is_composer_edit(c));

        if let (Some(edit), Some(send)) = (edit_node, send_btn) {
            out.push(ComposerPair {
                edit,
                send,
                in_main_frame,
            });
        }

        for child in children {
            collect_edit_send_pairs(child, in_main_frame, out);
        }

        // Cousin/proximity fallback for layouts where edit + Send are not siblings.
        let edits = descendant_composer_edits(node);
        let sends = descendant_send_buttons(node);
        if !edits.is_empty() && !sends.is_empty() {
            for edit in edits {
                if out.iter().any(|pair| std::ptr::eq(pair.edit, edit)) {
                    continue;
                }
                if let Some(send) = nearest_send(edit, &sends) {
                    out.push(ComposerPair {
                        edit,
                        send,
                        in_main_frame,
                    });
                }
            }
        }
    }
}

/// Extract a FrameHint from an a11y frame node.
pub fn frame_hint_from_node(node: &A11yNode) -> Option<FrameHint> {
    let bounds = node.bounds.clone()?;
    Some(FrameHint {
        name: if node.name.is_empty() { None } else { Some(node.name.clone()) },
        bounds,
        pid: node.window.as_ref().map(|w| w.pid),
    })
}

/// Prefer a popup frame when one is identified; fall back to the main window.
pub fn action_frame(identified: &IdentifiedStates) -> Option<FrameHint> {
    identified
        .popup
        .as_ref()
        .and_then(|popup| popup.frame.clone())
        .or_else(|| identified.main_window.as_ref().and_then(|main| main.frame.clone()))
}

/// Find the innermost frame ancestor that contains a node matching `selector`.
/// Walks the tree top-down, preferring deeper frames so we get the tightest
/// enclosing frame (e.g. "Settings" frame, not the root desktop-frame).
pub fn find_frame_for(a11y: &A11yNode, selector: &str) -> Option<FrameHint> {
    fn walk<'a>(node: &'a A11yNode, selector: &str, current_frame: Option<&'a A11yNode>) -> Option<&'a A11yNode> {
        let frame = if node.role == "frame" { Some(node) } else { current_frame };

        // If this subtree contains the target, the deepest frame wins
        if query_selector(node, selector).is_some() {
            // Check children for a tighter frame
            if let Some(children) = &node.children {
                for child in children {
                    if let Some(deeper) = walk(child, selector, frame) {
                        return Some(deeper);
                    }
                }
            }
            // No deeper frame found — return current
            return frame;
        }
        None
    }
    walk(a11y, selector, None).and_then(frame_hint_from_node)
}


#[cfg(test)]
mod composer_tests {
    use super::*;

    fn node(role: &str, name: &str, states: &[&str], children: Vec<A11yNode>) -> A11yNode {
        A11yNode {
            role: role.into(),
            name: name.into(),
            bounds: None,
            children: (!children.is_empty()).then_some(children),
            parent_index: None,
            window: None,
            states: (!states.is_empty()).then(|| states.iter().map(|s| (*s).into()).collect()),
        }
    }

    fn composer_named(send_name: &str, focused: bool, disabled: bool) -> A11yNode {
        let mut edit_states = vec!["EDITABLE"];
        if focused { edit_states.push("FOCUSED"); }
        let send_states = if disabled { vec!["DISABLED"] } else { vec![] };
        node("panel", "", &[], vec![
            node("text", "composer", &edit_states, vec![]),
            node("push-button", send_name, &send_states, vec![]),
        ])
    }

    fn composer(focused: bool, disabled: bool) -> A11yNode {
        composer_named("Send(S)", focused, disabled)
    }

    #[test]
    fn focused_composer_wins_over_earlier_ghost_frame() {
        let tree = node("desktop-frame", "", &[], vec![
            node("frame", "Detached", &[], vec![composer(false, true)]),
            node("frame", "Weixin", &[], vec![composer(true, true)]),
        ]);
        let (edit, _) = find_edit_and_send_button(&tree).expect("composer");
        assert!(node_has_state(edit, "FOCUSED"));
    }

    #[test]
    fn main_frame_wins_when_other_signals_tie() {
        let tree = node("desktop-frame", "", &[], vec![
            node("frame", "Detached", &[], vec![composer(false, true)]),
            node("frame", "WeChat", &[], vec![composer(false, true)]),
        ]);
        let (edit, _) = find_edit_and_send_button(&tree).expect("composer");
        let main_edit = &tree.children.as_ref().unwrap()[1].children.as_ref().unwrap()[0]
            .children.as_ref().unwrap()[0];
        assert!(std::ptr::eq(edit, main_edit));
    }

    #[test]
    fn chinese_send_button_is_supported() {
        let tree = node(
            "frame",
            "Weixin",
            &[],
            vec![composer_named("发送(S)", true, false)],
        );
        assert!(find_edit_and_send_button(&tree).is_some());
    }
    fn node_with_bounds(
        role: &str,
        name: &str,
        states: &[&str],
        bounds: (f64, f64, f64, f64),
        children: Vec<A11yNode>,
    ) -> A11yNode {
        let mut n = node(role, name, states, children);
        n.bounds = Some(Bounds {
            x: bounds.0,
            y: bounds.1,
            width: bounds.2,
            height: bounds.3,
        });
        n
    }

    #[test]
    fn cousin_edit_and_send_under_toolbar_layout_are_paired() {
        // Mirrors WeChat 4.1.13: editable text and Send live under different fillers.
        let tree = node(
            "frame",
            "Weixin",
            &[],
            vec![node(
                "filler",
                "",
                &[],
                vec![
                    node(
                        "filler",
                        "edit-branch",
                        &[],
                        vec![node_with_bounds(
                            "text",
                            "File Transfer",
                            &["EDITABLE", "FOCUSED"],
                            (521.0, 588.0, 542.0, 79.0),
                            vec![],
                        )],
                    ),
                    node(
                        "tool-bar",
                        "",
                        &[],
                        vec![
                            node_with_bounds(
                                "push-button",
                                "Send Voice",
                                &[],
                                (966.0, 675.0, 28.0, 28.0),
                                vec![],
                            ),
                            node_with_bounds(
                                "push-button",
                                "Send",
                                &["DISABLED"],
                                (1004.0, 677.0, 55.0, 24.0),
                                vec![],
                            ),
                        ],
                    ),
                    node_with_bounds(
                        "text",
                        "Search",
                        &["EDITABLE"],
                        (299.0, 126.0, 148.0, 22.0),
                        vec![],
                    ),
                ],
            )],
        );
        let (edit, send) = find_edit_and_send_button(&tree).expect("cousin composer");
        assert_eq!(edit.name, "File Transfer");
        assert_eq!(send.name, "Send");
        assert!(find_main_edit_and_send_button(&tree).is_some());
    }

    fn main_only_composer_rejects_detached_window_pair() {
        let tree = node(
            "desktop-frame",
            "",
            &[],
            vec![node("frame", "Detached", &[], vec![composer(true, false)])],
        );
        assert!(find_edit_and_send_button(&tree).is_some());
        assert!(find_main_edit_and_send_button(&tree).is_none());
    }

}
