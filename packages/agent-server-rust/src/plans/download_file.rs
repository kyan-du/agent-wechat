use super::Plan;
use crate::ia::actions;
use crate::ia::helpers::action_frame;
use crate::ia::selectors::{unique_inbound_file_bubble, FileBubbleSelectError};
use crate::ia::types::*;
use crate::tools::chat_select::{confirm_target, open_chat, OpenChatResult};

pub struct DownloadFilePlan;

pub struct DownloadFileParams {
    pub chat_id: String,
    pub filename: Option<String>,
}

pub enum DownloadFilePhase {
    Opening,
    ClickingFile,
    WaitingMaterialize,
    Done,
}

pub struct DownloadFilePlanState {
    pub phase: DownloadFilePhase,
    pub result: Option<OpenChatResult>,
    pub clicked: bool,
    pub diagnostic_error: Option<&'static str>,
    click_attempts: u8,
}

pub const FILE_BUBBLE_NOT_FOUND: &str = "FILE_BUBBLE_NOT_FOUND";
pub const FILE_BUBBLE_AMBIGUOUS: &str = "FILE_BUBBLE_AMBIGUOUS";
const MAX_CLICK_ATTEMPTS: u8 = 3;

fn filename_param(params: &DownloadFileParams) -> Option<&str> {
    params
        .filename
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn fail(plan_state: &mut DownloadFilePlanState, code: &'static str) {
    plan_state.diagnostic_error = Some(code);
}

#[async_trait::async_trait]
impl Plan for DownloadFilePlan {
    type PlanState = DownloadFilePlanState;
    type Params = DownloadFileParams;

    fn id(&self) -> &str {
        "download_file"
    }

    fn initial_plan_state(&self) -> DownloadFilePlanState {
        DownloadFilePlanState {
            phase: DownloadFilePhase::Opening,
            result: None,
            clicked: false,
            diagnostic_error: None,
            click_attempts: 0,
        }
    }

    fn is_goal_reached(&self, _state: &AppState, plan_state: &DownloadFilePlanState) -> bool {
        matches!(plan_state.phase, DownloadFilePhase::Done)
    }

    async fn select_action(
        &self,
        _state: &AppState,
        params: &DownloadFileParams,
        identified: &IdentifiedStates,
        plan_state: &mut DownloadFilePlanState,
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
                DownloadFilePhase::Opening => {
                    if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
                        return None;
                    }

                    // Resolve a live non-selected click target inside chat-select.
                    let force = main_state_id == Some("chat");
                    let result = open_chat(&params.chat_id, force, None).await;
                    tracing::info!(
                        "[download_file] chat-select completed ok={} verified={:?} skipped={:?} code={:?} duration_ms={:?}",
                        result.ok,
                        result.verified,
                        result.skipped,
                        result.error_code,
                        result.duration_ms,
                    );

                    if let Err(error) = confirm_target(&result, &params.chat_id) {
                        tracing::warn!(
                            "[download_file] target confirmation failed code={}",
                            error.code(),
                        );
                        plan_state.result = Some(result);
                        return None;
                    }

                    let skipped = result.skipped.unwrap_or(false);
                    plan_state.result = Some(result);
                    plan_state.phase = DownloadFilePhase::ClickingFile;
                    tracing::info!("[download_file] Opening → ClickingFile skipped={}", skipped);
                    if !skipped {
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: action_frame(identified),
                        });
                    }
                    continue;
                }

                DownloadFilePhase::ClickingFile => {
                    if main_state_id != Some("chat_open") {
                        tracing::info!("[download_file] ClickingFile: wrong state {:?}", main_state_id);
                        return None;
                    }

                    match unique_inbound_file_bubble(a11y, filename_param(params)) {
                        Ok(node) => {
                            let Some(bounds) = node.bounds.as_ref() else {
                                fail(plan_state, FILE_BUBBLE_NOT_FOUND);
                                return None;
                            };
                            plan_state.clicked = true;
                            plan_state.phase = DownloadFilePhase::WaitingMaterialize;
                            tracing::info!(
                                "[download_file] ClickingFile → WaitingMaterialize filename={:?}",
                                inbound_name(&node.name),
                            );
                            return Some(SelectedAction {
                                action: actions::click_bounds(bounds),
                                frame: action_frame(identified),
                            });
                        }
                        Err(FileBubbleSelectError::Ambiguous { count }) => {
                            tracing::warn!(
                                "[download_file] file bubble ambiguous count={} filename={:?}",
                                count,
                                filename_param(params),
                            );
                            fail(plan_state, FILE_BUBBLE_AMBIGUOUS);
                            return None;
                        }
                        Err(FileBubbleSelectError::NotFound) => {
                            plan_state.click_attempts =
                                plan_state.click_attempts.saturating_add(1);
                            tracing::warn!(
                                "[download_file] file bubble not found attempt={}/{} filename={:?}",
                                plan_state.click_attempts,
                                MAX_CLICK_ATTEMPTS,
                                filename_param(params),
                            );
                            if plan_state.click_attempts >= MAX_CLICK_ATTEMPTS {
                                fail(plan_state, FILE_BUBBLE_NOT_FOUND);
                                return None;
                            }
                            return Some(SelectedAction {
                                action: actions::wait_short(),
                                frame: action_frame(identified),
                            });
                        }
                    }
                }

                DownloadFilePhase::WaitingMaterialize => {
                    plan_state.phase = DownloadFilePhase::Done;
                    tracing::info!("[download_file] WaitingMaterialize → Done");
                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: action_frame(identified),
                    });
                }

                DownloadFilePhase::Done => return None,
            }
        }
    }
}

fn inbound_name(name: &str) -> String {
    crate::ia::selectors::inbound_file_bubble_filename(name)
        .unwrap_or(name)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ia::types::{A11yNode, Bounds};

    fn node(role: &str, name: &str, bounds: Option<Bounds>, children: Vec<A11yNode>) -> A11yNode {
        A11yNode {
            role: role.into(),
            name: name.into(),
            bounds,
            children: if children.is_empty() { None } else { Some(children) },
            parent_index: None,
            window: None,
            states: None,
        }
    }

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> Bounds {
        Bounds { x, y, width, height }
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

    fn live_file_tree() -> A11yNode {
        node(
            "desktop-frame",
            "main",
            None,
            vec![
                node(
                    "list",
                    "Chats",
                    Some(bounds(212.0, 114.0, 210.0, 640.0)),
                    vec![node(
                        "list-item",
                        "File Transfer [Photo]  Friday",
                        Some(bounds(212.0, 318.0, 210.0, 68.0)),
                        vec![],
                    )],
                ),
                node(
                    "list",
                    "Messages",
                    Some(bounds(423.0, 115.0, 704.0, 490.0)),
                    vec![
                        node(
                            "list-item",
                            "15:20",
                            Some(bounds(423.0, 196.0, 704.0, 41.0)),
                            vec![],
                        ),
                        node(
                            "list-item",
                            "File\n南风少年研学团0814.pdf\n331.5K\n微信电脑版",
                            Some(bounds(423.0, 312.0, 704.0, 123.0)),
                            vec![],
                        ),
                        node(
                            "list-item",
                            "万，这份《南风少年研学团0814.pdf》我这边没下到，文件没落到本机。\n",
                            Some(bounds(423.0, 435.0, 704.0, 158.0)),
                            vec![],
                        ),
                    ],
                ),
            ],
        )
    }

    fn empty_messages_tree() -> A11yNode {
        node(
            "desktop-frame",
            "main",
            None,
            vec![node(
                "list",
                "Messages",
                Some(bounds(423.0, 115.0, 704.0, 490.0)),
                vec![node(
                    "list-item",
                    "15:20",
                    Some(bounds(423.0, 196.0, 704.0, 41.0)),
                    vec![],
                )],
            )],
        )
    }

    #[tokio::test]
    async fn clicking_file_clicks_unique_pdf_bubble() {
        let plan = DownloadFilePlan;
        let mut state = plan.initial_plan_state();
        state.phase = DownloadFilePhase::ClickingFile;
        let selected = plan
            .select_action(
                &AppState::default(),
                &DownloadFileParams {
                    chat_id: "34438530917@chatroom".into(),
                    filename: Some("南风少年研学团0814.pdf".into()),
                },
                &chat_open_states(),
                &mut state,
                &live_file_tree(),
                "test",
            )
            .await
            .expect("file bubble must be clickable");
        assert!(matches!(
            selected.action,
            Action::ClickCoords { x, y } if (x - 775.0).abs() < f64::EPSILON && (y - 374.0).abs() < f64::EPSILON
        ));
        assert!(state.clicked);
        assert!(matches!(state.phase, DownloadFilePhase::WaitingMaterialize));
    }

    #[tokio::test]
    async fn clicking_file_fails_closed_when_ambiguous() {
        let plan = DownloadFilePlan;
        let mut state = plan.initial_plan_state();
        state.phase = DownloadFilePhase::ClickingFile;
        let tree = node(
            "desktop-frame",
            "main",
            None,
            vec![node(
                "list",
                "Messages",
                None,
                vec![
                    node(
                        "list-item",
                        "File\na.pdf\n1K\n微信电脑版",
                        Some(bounds(423.0, 200.0, 704.0, 100.0)),
                        vec![],
                    ),
                    node(
                        "list-item",
                        "File\nb.pdf\n2K\n微信电脑版",
                        Some(bounds(423.0, 320.0, 704.0, 100.0)),
                        vec![],
                    ),
                ],
            )],
        );
        let selected = plan
            .select_action(
                &AppState::default(),
                &DownloadFileParams {
                    chat_id: "34438530917@chatroom".into(),
                    filename: None,
                },
                &chat_open_states(),
                &mut state,
                &tree,
                "test",
            )
            .await;
        assert!(selected.is_none());
        assert_eq!(state.diagnostic_error, Some(FILE_BUBBLE_AMBIGUOUS));
        assert!(!state.clicked);
    }

    #[tokio::test]
    async fn clicking_file_retries_then_fails_when_missing() {
        let plan = DownloadFilePlan;
        let mut state = plan.initial_plan_state();
        state.phase = DownloadFilePhase::ClickingFile;
        for attempt in 1..=2 {
            let selected = plan
                .select_action(
                    &AppState::default(),
                    &DownloadFileParams {
                        chat_id: "34438530917@chatroom".into(),
                        filename: Some("南风少年研学团0814.pdf".into()),
                    },
                    &chat_open_states(),
                    &mut state,
                    &empty_messages_tree(),
                    "test",
                )
                .await
                .expect("missing bubble should wait");
            assert!(matches!(selected.action, Action::Wait { ms: 200 }));
            assert_eq!(state.click_attempts, attempt);
            assert!(state.diagnostic_error.is_none());
        }
        let selected = plan
            .select_action(
                &AppState::default(),
                &DownloadFileParams {
                    chat_id: "34438530917@chatroom".into(),
                    filename: Some("南风少年研学团0814.pdf".into()),
                },
                &chat_open_states(),
                &mut state,
                &empty_messages_tree(),
                "test",
            )
            .await;
        assert!(selected.is_none());
        assert_eq!(state.diagnostic_error, Some(FILE_BUBBLE_NOT_FOUND));
    }

    #[tokio::test]
    async fn waiting_materialize_finishes_without_another_click() {
        let plan = DownloadFilePlan;
        let mut state = plan.initial_plan_state();
        state.phase = DownloadFilePhase::WaitingMaterialize;
        state.clicked = true;
        let selected = plan
            .select_action(
                &AppState::default(),
                &DownloadFileParams {
                    chat_id: "34438530917@chatroom".into(),
                    filename: None,
                },
                &chat_open_states(),
                &mut state,
                &live_file_tree(),
                "test",
            )
            .await
            .expect("wait after click");
        assert!(matches!(selected.action, Action::Wait { ms: 200 }));
        assert!(plan.is_goal_reached(&AppState::default(), &state));
    }
}
