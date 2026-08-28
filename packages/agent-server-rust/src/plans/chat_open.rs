use super::Plan;
use crate::ia::actions;
use crate::ia::helpers::{action_frame, find_edit_and_send_button};
use crate::ia::selectors::query_selector;
use crate::ia::types::*;
use crate::tools::chat_select::{confirm_target, open_chat, OpenChatResult};

pub struct ChatOpenPlan;

pub struct ChatOpenParams {
    pub chat_id: String,
    pub clear_unreads: bool,
}

pub struct ChatOpenPlanState {
    pub phase: ChatOpenPhase,
    pub result: Option<OpenChatResult>,
    pub focus_attempts: u8,
    pub diagnostic_error: Option<&'static str>,
}

pub enum ChatOpenPhase {
    Opening,
    Focusing,
    Done,
}

pub const COMPOSER_UNAVAILABLE: &str = "COMPOSER_UNAVAILABLE";
const MAX_FOCUS_ATTEMPTS: u8 = 3;

fn record_missing_composer(plan_state: &mut ChatOpenPlanState) -> bool {
    plan_state.focus_attempts = plan_state.focus_attempts.saturating_add(1);
    if plan_state.focus_attempts >= MAX_FOCUS_ATTEMPTS {
        plan_state.diagnostic_error = Some(COMPOSER_UNAVAILABLE);
        true
    } else {
        false
    }
}

fn find_edit_area(a11y: &A11yNode) -> Option<&A11yNode> {
    // Ghost-frame-aware: ranks all edit+send pairs so a stale detached-chat
    // composer is not picked over the live one (see ia::helpers).
    find_edit_and_send_button(a11y).map(|(edit, _)| edit)
}

#[async_trait::async_trait]
impl Plan for ChatOpenPlan {
    type PlanState = ChatOpenPlanState;
    type Params = ChatOpenParams;

    fn id(&self) -> &str {
        "chat_open"
    }

    fn initial_plan_state(&self) -> ChatOpenPlanState {
        ChatOpenPlanState {
            phase: ChatOpenPhase::Opening,
            result: None,
            focus_attempts: 0,
            diagnostic_error: None,
        }
    }

    fn is_goal_reached(&self, _state: &AppState, plan_state: &ChatOpenPlanState) -> bool {
        matches!(plan_state.phase, ChatOpenPhase::Done)
    }

    async fn select_action(
        &self,
        state: &AppState,
        params: &ChatOpenParams,
        identified: &IdentifiedStates,
        plan_state: &mut ChatOpenPlanState,
        a11y: &A11yNode,
        _session_id: &str,
    ) -> Option<SelectedAction> {
        // Dismiss popups
        if state.popup.is_some() && identified.popup.is_some() {
            let action = if identified.popup.as_ref().map(|popup| popup.state_id.as_str()) == Some("popup_weixin_update") {
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
                ChatOpenPhase::Opening => {
                    if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
                        return None;
                    }

                    // Find click target
                    let chat_list_item = query_selector(a11y, r#"list[name="Chats"] > list-item"#);
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
                        "[chat_open] chat-select completed ok={} verified={:?} skipped={:?} code={:?} duration_ms={:?} used_frida={:?} attach_count={:?}",
                        result.ok,
                        result.verified,
                        result.skipped,
                        result.error_code,
                        result.duration_ms,
                        result.used_frida,
                        result.frida_attach_count,
                    );

                    if let Err(error) = confirm_target(&result, &params.chat_id) {
                        tracing::warn!(
                            "[chat_open] target confirmation failed code={} result_ok={} result_verified={:?} result_code={:?}",
                            error.code(),
                            result.ok,
                            result.verified,
                            result.error_code,
                        );
                        plan_state.result = Some(result);
                        return None;
                    }

                    let skipped = result.skipped.unwrap_or(false);
                    plan_state.result = Some(result);

                    if params.clear_unreads {
                        plan_state.phase = ChatOpenPhase::Focusing;
                        tracing::info!("[chat_open] Opening → Focusing, skipped={}", skipped);
                        if !skipped {
                            return Some(SelectedAction {
                                action: actions::wait_short(),
                                frame: action_frame(identified),
                            });
                        }
                        continue;
                    }

                    // No clear_unreads — done
                    plan_state.phase = ChatOpenPhase::Done;
                    tracing::info!("[chat_open] Opening → Done (no clear_unreads)");
                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: action_frame(identified),
                    });
                }

                ChatOpenPhase::Focusing => {
                    if main_state_id != Some("chat_open") {
                        tracing::info!("[chat_open] Focusing: wrong state {:?}", main_state_id);
                        return None;
                    }

                    let edit_node = match find_edit_area(a11y) {
                        Some(n) => n,
                        None => {
                            let exhausted = record_missing_composer(plan_state);
                            tracing::warn!(
                                "[chat_open] composer unavailable attempt={}/{} exhausted={}",
                                plan_state.focus_attempts,
                                MAX_FOCUS_ATTEMPTS,
                                exhausted,
                            );
                            if exhausted {
                                return None;
                            }
                            return Some(SelectedAction {
                                action: actions::wait_short(),
                                frame: action_frame(identified),
                            });
                        }
                    };

                    // Focusing the verified target is sufficient to let WeChat clear the
                    // conversation unread count. Never click message content while marking read.
                    plan_state.phase = ChatOpenPhase::Done;
                    tracing::info!("[chat_open] Focusing → Done, composer_ready=true");

                    if let Some(bounds) = &edit_node.bounds {
                        return Some(SelectedAction {
                            action: actions::click_bounds(bounds),
                            frame: action_frame(identified),
                        });
                    }
                    continue;
                }

                ChatOpenPhase::Done => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_open_missing_edit_area_retries_then_fails_closed() {
        let plan = ChatOpenPlan;
        let mut state = plan.initial_plan_state();
        state.phase = ChatOpenPhase::Focusing;

        assert!(!record_missing_composer(&mut state));
        assert!(!record_missing_composer(&mut state));
        assert!(record_missing_composer(&mut state));
        assert_eq!(state.focus_attempts, MAX_FOCUS_ATTEMPTS);
        assert_eq!(state.diagnostic_error, Some(COMPOSER_UNAVAILABLE));
        assert!(!plan.is_goal_reached(&AppState::default(), &state));
    }
}
