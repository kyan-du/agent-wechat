use super::Plan;
use crate::ia::actions;
use crate::ia::helpers::{find_edit_and_send_button, node_has_state};
use crate::ia::selectors::query_selector;
use crate::ia::types::*;
use crate::tools::chat_select::{confirm_target, open_chat, verify_active_chat, OpenChatResult};
use crate::tools::exec::{exec_command, ExecOptions};

pub struct SendMessagePlan;

pub struct SendMessageParams {
    pub chat_id: String,
    pub message: Option<String>,
    pub image_path: Option<String>,
    pub image_mime: Option<String>,
    pub file_path: Option<String>,
}

pub enum SendMessagePhase {
    Opening,
    Focusing,
    Inputting,
    Confirming,
    Done,
}

pub struct SendMessagePlanState {
    pub phase: SendMessagePhase,
    pub open_result: Option<OpenChatResult>,
    pub confirm_attempts: u32,
    /// Set before returning the action that commits the message to the UI.
    pub send_action_executed: bool,
    /// Stable diagnostic code returned when the plan fails closed.
    pub diagnostic_error: Option<String>,
}

fn target_confirmation_error(result: &OpenChatResult, chat_id: &str) -> Option<String> {
    confirm_target(result, chat_id)
        .err()
        .map(|error| format!("target_confirmation_{}", error.code()))
}

fn reset_after_popup(plan_state: &mut SendMessagePlanState) -> Result<(), &'static str> {
    if plan_state.send_action_executed {
        plan_state.diagnostic_error = Some("popup_after_send_action".to_string());
        return Err("popup_after_send_action");
    }
    plan_state.phase = SendMessagePhase::Opening;
    plan_state.open_result = None;
    Ok(())
}

fn arm_single_send(plan_state: &mut SendMessagePlanState) -> Result<(), &'static str> {
    if plan_state.send_action_executed {
        plan_state.diagnostic_error = Some("duplicate_send_action_suppressed".to_string());
        return Err("duplicate_send_action_suppressed");
    }
    plan_state.send_action_executed = true;
    Ok(())
}

#[async_trait::async_trait]
impl Plan for SendMessagePlan {
    type PlanState = SendMessagePlanState;
    type Params = SendMessageParams;

    fn id(&self) -> &str {
        "send_message"
    }

    fn initial_plan_state(&self) -> SendMessagePlanState {
        SendMessagePlanState {
            phase: SendMessagePhase::Opening,
            open_result: None,
            confirm_attempts: 0,
            send_action_executed: false,
            diagnostic_error: None,
        }
    }

    fn is_goal_reached(&self, _state: &AppState, plan_state: &SendMessagePlanState) -> bool {
        matches!(plan_state.phase, SendMessagePhase::Done)
    }

    async fn select_action(
        &self,
        state: &AppState,
        params: &SendMessageParams,
        identified: &IdentifiedStates,
        plan_state: &mut SendMessagePlanState,
        a11y: &A11yNode,
        _session_id: &str,
    ) -> Option<SelectedAction> {
        let main_state_id = identified.main_window.as_ref().map(|m| m.state_id.as_str());

        // Dismiss popups, then restart target selection. The conversation may
        // have changed while the popup was in front, so never resume from stale
        // Focusing/Inputting state.
        if state.popup.is_some() && identified.popup.is_some() {
            if reset_after_popup(plan_state).is_err() {
                return None;
            }
            return Some(SelectedAction {
                action: actions::dismiss_popup(),
                frame: identified
                    .main_window
                    .as_ref()
                    .and_then(|m| m.frame.clone()),
            });
        }

        loop {
            match &plan_state.phase {
                SendMessagePhase::Opening => {
                    if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
                        plan_state.diagnostic_error = Some("chat_ui_unavailable".to_string());
                        return None;
                    }

                    let chat_list_item = query_selector(a11y, r#"list[name="Chats"] > list-item"#);
                    let click_xy = chat_list_item.and_then(|item| {
                        item.bounds.as_ref().map(|b| {
                            (
                                (b.x + b.width / 2.0).round(),
                                (b.y + b.height / 2.0).round(),
                            )
                        })
                    });

                    // Always select, then require chat-select's live session
                    // rescan to prove the selected username equals the target.
                    let result = open_chat(&params.chat_id, true, click_xy).await;
                    if let Some(error) = target_confirmation_error(&result, &params.chat_id) {
                        tracing::warn!("[send] target confirmation failed: {error}");
                        plan_state.diagnostic_error = Some(error);
                        plan_state.open_result = Some(result);
                        return None;
                    }

                    let skipped = result.skipped.unwrap_or(false);
                    plan_state.open_result = Some(result);
                    plan_state.phase = SendMessagePhase::Focusing;

                    if !skipped {
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }
                    continue;
                }

                SendMessagePhase::Focusing => {
                    if main_state_id != Some("chat_open") {
                        plan_state.diagnostic_error = Some("target_ui_not_open".to_string());
                        return None;
                    }
                    if plan_state
                        .open_result
                        .as_ref()
                        .and_then(|result| target_confirmation_error(result, &params.chat_id))
                        .is_some()
                    {
                        plan_state.diagnostic_error = Some("target_confirmation_lost".to_string());
                        return None;
                    }

                    let (edit_node, _) = match find_edit_and_send_button(a11y) {
                        Some(found) => found,
                        None => {
                            plan_state.diagnostic_error =
                                Some("localized_composer_not_found".to_string());
                            return None;
                        }
                    };

                    plan_state.phase = SendMessagePhase::Inputting;

                    if node_has_state(edit_node, "FOCUSED") {
                        continue;
                    }

                    if let Some(bounds) = &edit_node.bounds {
                        return Some(SelectedAction {
                            action: actions::click_bounds(bounds),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }
                    plan_state.diagnostic_error = Some("composer_has_no_bounds".to_string());
                    return None;
                }

                SendMessagePhase::Inputting => {
                    if main_state_id != Some("chat_open") {
                        plan_state.diagnostic_error = Some("target_ui_not_open".to_string());
                        return None;
                    }
                    if plan_state
                        .open_result
                        .as_ref()
                        .and_then(|result| target_confirmation_error(result, &params.chat_id))
                        .is_some()
                    {
                        plan_state.diagnostic_error = Some("target_confirmation_lost".to_string());
                        return None;
                    }

                    // Re-scan immediately before the one action that can commit
                    // the message. This closes the window where a popup or user
                    // interaction changes conversations after the initial open.
                    let live_target = verify_active_chat(&params.chat_id).await;
                    if let Some(error) = target_confirmation_error(&live_target, &params.chat_id) {
                        tracing::warn!("[send] pre-send target rescan failed: {error}");
                        plan_state.diagnostic_error =
                            Some("pre_send_target_confirmation_failed".to_string());
                        return None;
                    }

                    if find_edit_and_send_button(a11y).is_none() {
                        plan_state.diagnostic_error =
                            Some("localized_composer_not_found".to_string());
                        return None;
                    }
                    if arm_single_send(plan_state).is_err() {
                        return None;
                    }

                    plan_state.phase = SendMessagePhase::Confirming;

                    if let Some(fp) = &params.file_path {
                        exec_command("paste-file", &[fp], &ExecOptions::default()).await;
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::Wait { ms: 100 },
                                Action::Key {
                                    combo: "Return".to_string(),
                                },
                            ]),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    if let Some(ip) = &params.image_path {
                        let mut args: Vec<&str> = vec![ip];
                        if let Some(mime) = &params.image_mime {
                            args.push(mime);
                        }
                        exec_command("paste-image", &args, &ExecOptions::default()).await;
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::Wait { ms: 100 },
                                Action::Key {
                                    combo: "Return".to_string(),
                                },
                            ]),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    if let Some(msg) = &params.message {
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::Key {
                                    combo: "ctrl+a".to_string(),
                                },
                                Action::Type {
                                    text: msg.clone(),
                                    selector: None,
                                },
                                Action::Wait { ms: 100 },
                                Action::Key {
                                    combo: "Return".to_string(),
                                },
                            ]),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    plan_state.diagnostic_error = Some("empty_send_payload".to_string());
                    return None;
                }

                SendMessagePhase::Confirming => {
                    let (_, send_btn) = match find_edit_and_send_button(a11y) {
                        Some(found) => found,
                        None => {
                            plan_state.diagnostic_error =
                                Some("composer_missing_during_confirmation".to_string());
                            return None;
                        }
                    };

                    if node_has_state(send_btn, "DISABLED") {
                        plan_state.phase = SendMessagePhase::Done;
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    plan_state.confirm_attempts += 1;
                    if plan_state.confirm_attempts >= 5 {
                        plan_state.diagnostic_error = Some("send_result_uncertain".to_string());
                        return None;
                    }

                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: identified
                            .main_window
                            .as_ref()
                            .and_then(|m| m.frame.clone()),
                    });
                }

                SendMessagePhase::Done => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_result(username: Option<&str>, verified: Option<bool>) -> OpenChatResult {
        OpenChatResult {
            ok: true,
            username: username.map(str::to_string),
            index: Some(1),
            skipped: Some(false),
            verified,
            error: None,
        }
    }

    #[test]
    fn target_mismatch_and_missing_confirmation_fail_closed() {
        assert_eq!(
            target_confirmation_error(&open_result(Some("other"), Some(true)), "target"),
            Some("target_confirmation_identity_mismatch".to_string())
        );
        assert_eq!(
            target_confirmation_error(&open_result(Some("target"), None), "target"),
            Some("target_confirmation_not_verified".to_string())
        );
    }

    #[test]
    fn popup_recovery_restarts_target_selection_before_send() {
        let mut state = SendMessagePlan.initial_plan_state();
        state.phase = SendMessagePhase::Inputting;
        state.open_result = Some(open_result(Some("target"), Some(true)));
        assert_eq!(reset_after_popup(&mut state), Ok(()));
        assert!(matches!(state.phase, SendMessagePhase::Opening));
        assert!(state.open_result.is_none());
    }

    #[test]
    fn popup_after_send_action_fails_closed() {
        let mut state = SendMessagePlan.initial_plan_state();
        state.send_action_executed = true;
        assert_eq!(
            reset_after_popup(&mut state),
            Err("popup_after_send_action")
        );
    }

    #[test]
    fn single_plan_can_arm_only_one_send_action() {
        let mut state = SendMessagePlan.initial_plan_state();
        assert_eq!(arm_single_send(&mut state), Ok(()));
        assert_eq!(
            arm_single_send(&mut state),
            Err("duplicate_send_action_suppressed")
        );
        assert_eq!(
            state.diagnostic_error.as_deref(),
            Some("duplicate_send_action_suppressed")
        );
    }
}
