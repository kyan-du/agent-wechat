use super::Plan;
use crate::ia::actions;
use crate::ia::helpers::{action_frame, frame_hint_from_node};
use crate::ia::selectors::{
    chat_history_detail_close_button, chat_history_detail_frame, chat_history_detail_list,
    chat_history_media_rows, messages_list, unique_chat_history_bubble, FileBubbleSelectError,
};
use crate::ia::types::*;
use crate::tools::chat_select::{confirm_target, open_chat, OpenChatResult};

pub struct MaterializeChatHistoryPlan;

pub struct MaterializeChatHistoryParams {
    pub chat_id: String,
    /// Optional card-title substring (e.g. `姐姐狐的聊天记录`).
    pub title: Option<String>,
    /// Optional message localId (logs only).
    pub local_id: Option<i64>,
}

pub enum MaterializeChatHistoryPhase {
    Opening,
    Finding,
    /// Scroll/click nested Image/File/Voice/Video rows inside the opened detail frame.
    MaterializingNested,
    ClosingDetail,
    Done,
}

pub struct MaterializeChatHistoryPlanState {
    pub phase: MaterializeChatHistoryPhase,
    pub result: Option<OpenChatResult>,
    pub clicked: bool,
    pub diagnostic_error: Option<&'static str>,
    scroll_attempts: u8,
    nested_wait_attempts: u8,
    nested_scroll_attempts: u8,
    nested_stagnant_scrolls: u8,
    nested_clicked_keys: std::collections::HashSet<String>,
    nested_last_fingerprint: String,
}

pub const CHAT_HISTORY_CARD_NOT_FOUND: &str = "CHAT_HISTORY_CARD_NOT_FOUND";
pub const CHAT_HISTORY_CARD_AMBIGUOUS: &str = "CHAT_HISTORY_CARD_AMBIGUOUS";
const MAX_SCROLL_ATTEMPTS: u8 = 10;
const MAX_NESTED_WAIT_ATTEMPTS: u8 = 20;
const MAX_NESTED_SCROLL_ATTEMPTS: u8 = 20;
const MAX_NESTED_STAGNANT_SCROLLS: u8 = 3;
const NESTED_WHEEL_AMOUNT: i32 = 8;

fn title_param(params: &MaterializeChatHistoryParams) -> Option<&str> {
    params
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn fail(plan_state: &mut MaterializeChatHistoryPlanState, code: &'static str) {
    plan_state.diagnostic_error = Some(code);
}

fn bubble_visible_in_messages(bubble: &A11yNode, messages: &A11yNode) -> bool {
    let (Some(bb), Some(mb)) = (bubble.bounds.as_ref(), messages.bounds.as_ref()) else {
        return true;
    };
    let mid_y = bb.y + bb.height / 2.0;
    mid_y >= mb.y && mid_y <= mb.y + mb.height
}

fn scroll_direction_for_attempt(attempt: u8) -> ScrollDirection {
    // Prefer older messages (Page_Up) first, then alternate.
    if attempt < MAX_SCROLL_ATTEMPTS / 2 {
        ScrollDirection::Up
    } else if attempt % 2 == 0 {
        ScrollDirection::Up
    } else {
        ScrollDirection::Down
    }
}

fn page_messages(messages: &A11yNode, direction: ScrollDirection) -> Option<Action> {
    let bounds = messages.bounds.as_ref()?;
    Some(actions::sequence(vec![
        actions::focus_messages_and_page(bounds, direction),
        actions::wait(120),
    ]))
}

#[async_trait::async_trait]
impl Plan for MaterializeChatHistoryPlan {
    type PlanState = MaterializeChatHistoryPlanState;
    type Params = MaterializeChatHistoryParams;

    fn id(&self) -> &str {
        "materialize_chat_history"
    }

    fn initial_plan_state(&self) -> MaterializeChatHistoryPlanState {
        MaterializeChatHistoryPlanState {
            phase: MaterializeChatHistoryPhase::Opening,
            result: None,
            clicked: false,
            diagnostic_error: None,
            scroll_attempts: 0,
            nested_wait_attempts: 0,
            nested_scroll_attempts: 0,
            nested_stagnant_scrolls: 0,
            nested_clicked_keys: std::collections::HashSet::new(),
            nested_last_fingerprint: String::new(),
        }
    }

    fn is_goal_reached(
        &self,
        _state: &AppState,
        plan_state: &MaterializeChatHistoryPlanState,
    ) -> bool {
        matches!(plan_state.phase, MaterializeChatHistoryPhase::Done)
    }

    async fn select_action(
        &self,
        _state: &AppState,
        params: &MaterializeChatHistoryParams,
        identified: &IdentifiedStates,
        plan_state: &mut MaterializeChatHistoryPlanState,
        a11y: &A11yNode,
        _session_id: &str,
    ) -> Option<SelectedAction> {
        if identified
            .popup
            .as_ref()
            .is_some_and(|popup| popup.state_id == "popup_security")
        {
            crate::outbound::outbound_sender().trip_kill_switch("security_popup");
            return None;
        }
        if identified.popup.is_some() {
            let action = if identified
                .popup
                .as_ref()
                .map(|popup| popup.state_id.as_str())
                == Some("popup_weixin_update")
            {
                actions::close_window()
            } else {
                actions::dismiss_popup()
            };
            return Some(SelectedAction {
                action,
                frame: action_frame(identified),
            });
        }

        let main_state_id = identified.main_window.as_ref().map(|m| m.state_id.as_str());

        loop {
            match &plan_state.phase {
                MaterializeChatHistoryPhase::Opening => {
                    if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
                        return None;
                    }

                    let chat_list_item = crate::ia::selectors::query_selector(
                        a11y,
                        r#"list[name="Chats"] > list-item"#,
                    );
                    let click_xy = chat_list_item.and_then(|item| {
                        item.bounds.as_ref().map(|b| {
                            (
                                (b.x + b.width / 2.0).round(),
                                (b.y + b.height / 2.0).round(),
                            )
                        })
                    });

                    let force = main_state_id == Some("chat");
                    let result = open_chat(&params.chat_id, force, click_xy).await;
                    tracing::info!(
                        "[materialize_chat_history] chat-select completed ok={} verified={:?} skipped={:?} code={:?} local_id={:?} title={:?} duration_ms={:?}",
                        result.ok,
                        result.verified,
                        result.skipped,
                        result.error_code,
                        params.local_id,
                        title_param(params),
                        result.duration_ms,
                    );

                    if let Err(error) = confirm_target(&result, &params.chat_id) {
                        tracing::warn!(
                            "[materialize_chat_history] target confirmation failed code={}",
                            error.code(),
                        );
                        plan_state.result = Some(result);
                        return None;
                    }

                    let skipped = result.skipped.unwrap_or(false);
                    plan_state.result = Some(result);
                    plan_state.phase = MaterializeChatHistoryPhase::Finding;
                    tracing::info!(
                        "[materialize_chat_history] Opening → Finding skipped={}",
                        skipped
                    );
                    if !skipped {
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: action_frame(identified),
                        });
                    }
                    continue;
                }

                MaterializeChatHistoryPhase::Finding => {
                    if main_state_id != Some("chat_open") {
                        tracing::info!(
                            "[materialize_chat_history] Finding: wrong state {:?}",
                            main_state_id
                        );
                        return None;
                    }

                    let messages = messages_list(a11y);
                    match unique_chat_history_bubble(a11y, title_param(params)) {
                        Ok(node) => {
                            let visible = messages
                                .map(|m| bubble_visible_in_messages(node, m))
                                .unwrap_or(true);
                            if !visible {
                                plan_state.scroll_attempts =
                                    plan_state.scroll_attempts.saturating_add(1);
                                if plan_state.scroll_attempts >= MAX_SCROLL_ATTEMPTS {
                                    fail(plan_state, CHAT_HISTORY_CARD_NOT_FOUND);
                                    return None;
                                }
                                let direction =
                                    scroll_direction_for_attempt(plan_state.scroll_attempts);
                                let Some(messages) = messages else {
                                    fail(plan_state, CHAT_HISTORY_CARD_NOT_FOUND);
                                    return None;
                                };
                                let Some(action) = page_messages(messages, direction) else {
                                    fail(plan_state, CHAT_HISTORY_CARD_NOT_FOUND);
                                    return None;
                                };
                                tracing::info!(
                                    "[materialize_chat_history] card off-viewport scroll_attempt={}/{}",
                                    plan_state.scroll_attempts,
                                    MAX_SCROLL_ATTEMPTS,
                                );
                                return Some(SelectedAction {
                                    action,
                                    frame: action_frame(identified),
                                });
                            }

                            let Some(bounds) = node.bounds.as_ref() else {
                                fail(plan_state, CHAT_HISTORY_CARD_NOT_FOUND);
                                return None;
                            };
                            plan_state.clicked = true;
                            plan_state.phase = MaterializeChatHistoryPhase::MaterializingNested;
                            let (x, y) = actions::chat_history_open_point(bounds);
                            tracing::info!(
                                "[materialize_chat_history] Finding → MaterializingNested click=({x},{y}) title={:?} local_id={:?}",
                                title_param(params),
                                params.local_id,
                            );
                            return Some(SelectedAction {
                                action: actions::double_click_chat_history_card(bounds),
                                frame: action_frame(identified),
                            });
                        }
                        Err(FileBubbleSelectError::Ambiguous { count }) => {
                            tracing::warn!(
                                "[materialize_chat_history] card ambiguous count={} title={:?}",
                                count,
                                title_param(params),
                            );
                            fail(plan_state, CHAT_HISTORY_CARD_AMBIGUOUS);
                            return None;
                        }
                        Err(FileBubbleSelectError::NotFound) => {
                            plan_state.scroll_attempts =
                                plan_state.scroll_attempts.saturating_add(1);
                            tracing::warn!(
                                "[materialize_chat_history] card not found scroll_attempt={}/{} title={:?}",
                                plan_state.scroll_attempts,
                                MAX_SCROLL_ATTEMPTS,
                                title_param(params),
                            );
                            if plan_state.scroll_attempts >= MAX_SCROLL_ATTEMPTS {
                                fail(plan_state, CHAT_HISTORY_CARD_NOT_FOUND);
                                return None;
                            }
                            let direction =
                                scroll_direction_for_attempt(plan_state.scroll_attempts);
                            if let Some(messages) = messages {
                                if let Some(action) = page_messages(messages, direction) {
                                    return Some(SelectedAction {
                                        action,
                                        frame: action_frame(identified),
                                    });
                                }
                            }
                            return Some(SelectedAction {
                                action: actions::wait_short(),
                                frame: action_frame(identified),
                            });
                        }
                    }
                }

                MaterializeChatHistoryPhase::MaterializingNested => {
                    let Some(title) = title_param(params) else {
                        // No title → cannot map the detail frame; keep legacy short wait.
                        plan_state.phase = MaterializeChatHistoryPhase::Done;
                        return Some(SelectedAction {
                            action: actions::wait_long(),
                            frame: action_frame(identified),
                        });
                    };

                    let Some(frame) = chat_history_detail_frame(a11y, title) else {
                        plan_state.nested_wait_attempts =
                            plan_state.nested_wait_attempts.saturating_add(1);
                        tracing::info!(
                            "[materialize_chat_history] waiting for detail frame attempt={}/{}",
                            plan_state.nested_wait_attempts,
                            MAX_NESTED_WAIT_ATTEMPTS,
                        );
                        if plan_state.nested_wait_attempts >= MAX_NESTED_WAIT_ATTEMPTS {
                            plan_state.phase = MaterializeChatHistoryPhase::Done;
                        }
                        return Some(SelectedAction {
                            action: actions::wait(200),
                            frame: action_frame(identified),
                        });
                    };
                    // Detail is its own window; clicks/scrolls must target it, not Weixin.
                    let detail_frame = frame_hint_from_node(frame);

                    // A leftover image lightbox steals wheel focus from the detail list.
                    if crate::ia::selectors::query_selector(
                        a11y,
                        r#"frame[name="Photos and Videos"]"#,
                    )
                    .is_some()
                    {
                        tracing::info!("[materialize_chat_history] dismissing photos lightbox");
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::Key {
                                    combo: "Escape".into(),
                                },
                                actions::wait(150),
                            ]),
                            frame: None,
                        });
                    }

                    let Some(list) = chat_history_detail_list(frame) else {
                        plan_state.nested_wait_attempts =
                            plan_state.nested_wait_attempts.saturating_add(1);
                        if plan_state.nested_wait_attempts >= MAX_NESTED_WAIT_ATTEMPTS {
                            plan_state.phase = MaterializeChatHistoryPhase::ClosingDetail;
                        }
                        return Some(SelectedAction {
                            action: actions::wait(200),
                            frame: detail_frame.clone(),
                        });
                    };

                    let rows = chat_history_media_rows(list);
                    for row in &rows {
                        let Some(bounds) = row.bounds.as_ref() else {
                            continue;
                        };
                        // Images/photos usually materialize from wheel-scroll alone;
                        // File/Voice/Video rows still need an explicit click.
                        let trimmed = row.name.trim_start();
                        let image_like = trimmed.starts_with("Image")
                            || trimmed.starts_with("Photo")
                            || trimmed.starts_with("图片")
                            || trimmed.starts_with("[Image]")
                            || trimmed.starts_with("[Photo]")
                            || trimmed.starts_with("[图片]");
                        if image_like {
                            continue;
                        }
                        // Names often collide; include y.
                        let key = format!("{}@{:.0}", row.name, bounds.y);
                        if plan_state.nested_clicked_keys.contains(&key) {
                            continue;
                        }
                        plan_state.nested_clicked_keys.insert(key);
                        tracing::info!(
                            "[materialize_chat_history] click nested media row clicked={}",
                            plan_state.nested_clicked_keys.len(),
                        );
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                actions::click_bounds(bounds),
                                actions::wait(220),
                            ]),
                            frame: detail_frame.clone(),
                        });
                    }

                    let fingerprint = rows
                        .iter()
                        .filter_map(|row| {
                            let bounds = row.bounds.as_ref()?;
                            Some(format!("{}@{:.0}", row.name, bounds.y))
                        })
                        .collect::<Vec<_>>()
                        .join("\x1e");
                    if fingerprint == plan_state.nested_last_fingerprint {
                        plan_state.nested_stagnant_scrolls =
                            plan_state.nested_stagnant_scrolls.saturating_add(1);
                    } else {
                        plan_state.nested_stagnant_scrolls = 0;
                        plan_state.nested_last_fingerprint = fingerprint;
                    }

                    plan_state.nested_scroll_attempts =
                        plan_state.nested_scroll_attempts.saturating_add(1);
                    // Image rows often share identical a11y names (`Image09-20 01:26`),
                    // so name@y fingerprints do not move when the list scrolls. Always
                    // spend the full wheel budget instead of trusting stagnant early-exit.
                    let budget_exhausted =
                        plan_state.nested_scroll_attempts >= MAX_NESTED_SCROLL_ATTEMPTS;
                    if budget_exhausted {
                        tracing::info!(
                            "[materialize_chat_history] MaterializingNested → ClosingDetail scrolls={} stagnant={} clicked={}",
                            plan_state.nested_scroll_attempts,
                            plan_state.nested_stagnant_scrolls,
                            plan_state.nested_clicked_keys.len(),
                        );
                        plan_state.phase = MaterializeChatHistoryPhase::ClosingDetail;
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: detail_frame.clone(),
                        });
                    }

                    let Some(list_bounds) = list.bounds.as_ref() else {
                        plan_state.phase = MaterializeChatHistoryPhase::ClosingDetail;
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: detail_frame.clone(),
                        });
                    };
                    tracing::info!(
                        "[materialize_chat_history] nested wheel scroll attempt={}/{}",
                        plan_state.nested_scroll_attempts,
                        MAX_NESTED_SCROLL_ATTEMPTS,
                    );
                    return Some(SelectedAction {
                        action: actions::sequence(vec![
                            actions::focus_list_and_wheel_scroll(
                                list_bounds,
                                ScrollDirection::Down,
                                NESTED_WHEEL_AMOUNT,
                            ),
                            actions::wait(220),
                        ]),
                        // No --window prefix: keep pointer where the list click left it.
                        frame: None,
                    });
                }

                MaterializeChatHistoryPhase::ClosingDetail => {
                    if let Some(title) = title_param(params) {
                        if let Some(frame) = chat_history_detail_frame(a11y, title) {
                            let detail_frame = frame_hint_from_node(frame);
                            if let Some(close) = chat_history_detail_close_button(frame) {
                                if let Some(bounds) = close.bounds.as_ref() {
                                    plan_state.phase = MaterializeChatHistoryPhase::Done;
                                    tracing::info!(
                                        "[materialize_chat_history] ClosingDetail → Done"
                                    );
                                    return Some(SelectedAction {
                                        action: actions::sequence(vec![
                                            actions::click_bounds(bounds),
                                            actions::wait(150),
                                        ]),
                                        frame: detail_frame,
                                    });
                                }
                            }
                        }
                    }
                    plan_state.phase = MaterializeChatHistoryPhase::Done;
                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: action_frame(identified),
                    });
                }

                MaterializeChatHistoryPhase::Done => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(role: &str, name: &str, bounds: Option<Bounds>, children: Vec<A11yNode>) -> A11yNode {
        A11yNode {
            role: role.into(),
            name: name.into(),
            bounds,
            children: if children.is_empty() {
                None
            } else {
                Some(children)
            },
            parent_index: None,
            window: None,
            states: None,
        }
    }

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    fn chat_open_states() -> IdentifiedStates {
        IdentifiedStates {
            main_window: Some(IdentifiedState {
                state_id: "chat_open".into(),
                fsm: "main".into(),
                frame: None,
            }),
            popup: None,
            contact_card: None,
            settings: None,
        }
    }

    fn live_card_tree() -> A11yNode {
        node(
            "desktop-frame",
            "main",
            None,
            vec![
                node(
                    "list",
                    "Messages",
                    Some(bounds(423.0, 115.0, 704.0, 490.0)),
                    vec![
                        node(
                            "list-item",
                            "14:50",
                            Some(bounds(423.0, 300.0, 704.0, 30.0)),
                            vec![],
                        ),
                        node(
                            "list-item",
                            "Chat History姐姐狐的聊天记录姐姐狐: [Photo]\n姐姐狐: [Photo]\n姐姐狐: [Photo]",
                            Some(bounds(423.0, 367.0, 704.0, 127.0)),
                            vec![],
                        ),
                        node(
                            "list-item",
                            "15:00",
                            Some(bounds(423.0, 500.0, 704.0, 30.0)),
                            vec![],
                        ),
                    ],
                ),
                node(
                    "push-button",
                    "Chat History",
                    Some(bounds(450.0, 700.0, 32.0, 32.0)),
                    vec![],
                ),
            ],
        )
    }

    #[test]
    fn open_point_uses_calibrated_fraction_of_width() {
        let b = bounds(423.0, 367.0, 704.0, 127.0);
        let (x, y) = actions::chat_history_open_point(&b);
        // 423 + 0.12*704 ≈ 507; live success was x=500. Failures were 440/460/480.
        assert!((500.0..520.0).contains(&x), "x={x}");
        assert!((y - 430.5).abs() < 1.0, "y={y}");
        assert!(x >= 423.0 + 704.0 * 0.10);
        assert!(x <= 423.0 + 704.0 * 0.15 + 0.5);
    }

    #[tokio::test]
    async fn finding_double_clicks_unique_visible_card() {
        let plan = MaterializeChatHistoryPlan;
        let mut state = plan.initial_plan_state();
        state.phase = MaterializeChatHistoryPhase::Finding;
        let selected = plan
            .select_action(
                &AppState::default(),
                &MaterializeChatHistoryParams {
                    chat_id: "vangie".into(),
                    title: Some("姐姐狐的聊天记录".into()),
                    local_id: Some(70),
                },
                &chat_open_states(),
                &mut state,
                &live_card_tree(),
                "test",
            )
            .await
            .expect("card must be clickable");
        match selected.action {
            Action::Sequence { actions } => {
                assert_eq!(actions.len(), 3);
                match (&actions[0], &actions[2]) {
                    (
                        Action::ClickCoords { x: x1, y: y1 },
                        Action::ClickCoords { x: x2, y: y2 },
                    ) => {
                        assert!((*x1 - 507.0).abs() < 1.0, "x1={x1}");
                        assert!((*x2 - 507.0).abs() < 1.0, "x2={x2}");
                        assert!((*y1 - 430.5).abs() < 1.0);
                        assert!((*y2 - 430.5).abs() < 1.0);
                    }
                    other => panic!("expected two click_coords, got {other:?}"),
                }
                assert!(matches!(actions[1], Action::Wait { ms: 60 }));
            }
            other => panic!("expected sequence, got {other:?}"),
        }
        assert!(state.clicked);
        assert!(matches!(
            state.phase,
            MaterializeChatHistoryPhase::MaterializingNested
        ));
    }

    #[tokio::test]
    async fn finding_scrolls_when_card_missing() {
        let plan = MaterializeChatHistoryPlan;
        let mut state = plan.initial_plan_state();
        state.phase = MaterializeChatHistoryPhase::Finding;
        let tree = node(
            "desktop-frame",
            "main",
            None,
            vec![node(
                "list",
                "Messages",
                Some(bounds(423.0, 115.0, 704.0, 490.0)),
                vec![node(
                    "list-item",
                    "14:50",
                    Some(bounds(423.0, 200.0, 704.0, 30.0)),
                    vec![],
                )],
            )],
        );
        let selected = plan
            .select_action(
                &AppState::default(),
                &MaterializeChatHistoryParams {
                    chat_id: "vangie".into(),
                    title: Some("姐姐狐的聊天记录".into()),
                    local_id: Some(70),
                },
                &chat_open_states(),
                &mut state,
                &tree,
                "test",
            )
            .await
            .expect("should scroll");
        assert!(matches!(selected.action, Action::Sequence { .. }));
        assert_eq!(state.scroll_attempts, 1);
        assert!(state.diagnostic_error.is_none());
    }

    #[tokio::test]
    async fn finding_fails_closed_when_ambiguous() {
        let plan = MaterializeChatHistoryPlan;
        let mut state = plan.initial_plan_state();
        state.phase = MaterializeChatHistoryPhase::Finding;
        let tree = node(
            "desktop-frame",
            "main",
            None,
            vec![node(
                "list",
                "Messages",
                Some(bounds(423.0, 115.0, 704.0, 490.0)),
                vec![
                    node(
                        "list-item",
                        "Chat HistoryAAA的聊天记录AAA: hi",
                        Some(bounds(423.0, 200.0, 704.0, 100.0)),
                        vec![],
                    ),
                    node(
                        "list-item",
                        "Chat HistoryBBB的聊天记录BBB: hi",
                        Some(bounds(423.0, 320.0, 704.0, 100.0)),
                        vec![],
                    ),
                ],
            )],
        );
        let selected = plan
            .select_action(
                &AppState::default(),
                &MaterializeChatHistoryParams {
                    chat_id: "vangie".into(),
                    title: None,
                    local_id: None,
                },
                &chat_open_states(),
                &mut state,
                &tree,
                "test",
            )
            .await;
        assert!(selected.is_none());
        assert_eq!(state.diagnostic_error, Some(CHAT_HISTORY_CARD_AMBIGUOUS));
    }
}
