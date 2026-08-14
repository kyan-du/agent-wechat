use super::Plan;
use crate::db::get_db;
use crate::execution::actions::ActionExecutionResult;
use crate::ia::actions;
use crate::ia::helpers::{find_edit_and_send_button, node_has_state};
use crate::ia::selectors::query_selector;
use crate::ia::types::*;
use crate::sessions::manager::get_session;
use crate::tools::chat_select::{confirm_target, open_chat, verify_active_chat, OpenChatResult};
use crate::tools::wechat_keys::get_stored_keys;

pub struct SendMessagePlan;

const DEFAULT_TEXT_CHUNK_CHARS: usize = 24;
const DEFAULT_TEXT_CHUNK_PAUSE_MS: u64 = 45;
const DEFAULT_TEXT_CHUNK_JITTER_MS: u64 = 80;
const MAX_CHUNKED_TEXT_CHARS: usize = 4_096;

fn bounded_env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn bounded_env_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn text_input_actions(
    text: &str,
    chunk_chars: usize,
    pause_ms: u64,
    pause_jitter_ms: u64,
    mut jitter: impl FnMut() -> u64,
) -> Vec<Action> {
    let chars: Vec<char> = text.chars().collect();
    let effective_chunk_chars = if chars.len() > MAX_CHUNKED_TEXT_CHARS {
        chars.len()
    } else {
        chunk_chars.max(1)
    };
    let chunks: Vec<String> = chars
        .chunks(effective_chunk_chars)
        .map(|chunk| chunk.iter().collect())
        .collect();
    let mut actions = Vec::with_capacity(chunks.len().saturating_mul(2));
    for (index, chunk) in chunks.iter().enumerate() {
        actions.push(Action::Type {
            text: chunk.clone(),
            selector: None,
        });
        if index + 1 < chunks.len() {
            let extra = if pause_jitter_ms == 0 {
                0
            } else {
                jitter() % (pause_jitter_ms + 1)
            };
            actions.push(Action::Wait {
                ms: pause_ms + extra,
            });
        }
    }
    actions
}

#[derive(Clone)]
pub struct SendMessageParams {
    pub chat_id: String,
    pub message: Option<String>,
    pub image_path: Option<String>,
    pub image_mime: Option<String>,
    pub file_path: Option<String>,
    pub inbound_chars: Option<usize>,
    pub source: Option<String>,
    pub similarity_confirmed: bool,
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
    /// Set only once the irreversible Return/send command is attempted.
    pub send_action_executed: bool,
    /// Stable diagnostic code returned when the plan fails closed.
    pub diagnostic_error: Option<String>,
}

fn confirm_from_a11y_db(state: &AppState, chat_id: &str) -> Option<OpenChatResult> {
    let matches = load_matching_usernames(state.main_window.opened_chat_name.as_deref())?;
    crate::tools::chat_select::confirm_opened_name(
        state.main_window.opened_chat_name.as_deref(),
        chat_id,
        &matches,
    )
    .ok()?;
    Some(OpenChatResult {
        ok: true,
        username: Some(chat_id.to_string()),
        index: None,
        skipped: Some(true),
        verified: Some(true),
        error: None,
    })
}

fn load_matching_usernames(opened_name: Option<&str>) -> Option<Vec<String>> {
    let name = opened_name.map(str::trim).filter(|s| !s.is_empty())?;
    let session = get_session("default")?;
    let user = session.logged_in_user.as_ref()?;
    let keys = {
        let db = get_db();
        get_stored_keys(&db, &session.id, user)
    };
    if keys.is_empty() {
        return None;
    }
    Some(crate::tools::wechat_contacts::usernames_for_display_name(
        user, &keys, name,
    ))
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

fn allow_single_send(plan_state: &mut SendMessagePlanState) -> Result<(), &'static str> {
    if plan_state.send_action_executed {
        plan_state.diagnostic_error = Some("duplicate_send_action_suppressed".to_string());
        return Err("duplicate_send_action_suppressed");
    }
    Ok(())
}

fn record_action_result(plan_state: &mut SendMessagePlanState, result: &ActionExecutionResult) {
    match result {
        Ok(commit_attempted) => {
            if *commit_attempted {
                plan_state.send_action_executed = true;
                plan_state.phase = SendMessagePhase::Confirming;
            }
        }
        Err(error) => {
            if error.commit_attempted {
                plan_state.send_action_executed = true;
                plan_state.diagnostic_error = Some("send_commit_uncertain".to_string());
            } else {
                plan_state.diagnostic_error = Some(error.diagnostic.to_string());
            }
        }
    }
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

        // Security popups freeze outbound; do not click them away.
        if let Some(popup) = &state.popup {
            if crate::risk::is_security_popup(popup) {
                crate::outbound::outbound_sender().trip_kill_switch("security_popup");
                return None;
            }
        }
        // Dismiss other popups, then restart target selection. The conversation
        // may have changed while the popup was in front.
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

                    // Same-chat fast path: live a11y header + local DB only.
                    // Never treat /tmp cache or Frida as the cheap path.
                    if let Some(live) = confirm_from_a11y_db(state, &params.chat_id) {
                        plan_state.open_result = Some(live);
                        plan_state.phase = SendMessagePhase::Focusing;
                        continue;
                    }

                    let chat_list_item = query_selector(a11y, r#"list[name="Chats"] > list-item"#);
                    let click_xy = chat_list_item.and_then(|item| {
                        item.bounds
                            .as_ref()
                            .map(|b| crate::ia::actions::jittered_point(b))
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
                            action: actions::click_bounds_jitter(bounds),
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

                    // Re-check immediately before the one action that can commit.
                    // Prefer the same non-Frida live signal; Frida verify-only
                    // only if a11y/DB cannot uniquely identify the open chat.
                    if confirm_from_a11y_db(state, &params.chat_id).is_none() {
                        let live_target = verify_active_chat(&params.chat_id).await;
                        if let Some(error) =
                            target_confirmation_error(&live_target, &params.chat_id)
                        {
                            tracing::warn!("[send] pre-send target rescan failed: {error}");
                            plan_state.diagnostic_error =
                                Some("pre_send_target_confirmation_failed".to_string());
                            return None;
                        }
                    }

                    if find_edit_and_send_button(a11y).is_none() {
                        plan_state.diagnostic_error =
                            Some("localized_composer_not_found".to_string());
                        return None;
                    }
                    if allow_single_send(plan_state).is_err() {
                        return None;
                    }

                    let beat = 400 + (actions::next_jitter() % 500) as u64;

                    if let Some(fp) = &params.file_path {
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::PasteFile { path: fp.clone() },
                                Action::Wait { ms: beat },
                                Action::CommitKey {
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
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::PasteImage {
                                    path: ip.clone(),
                                    mime: params.image_mime.clone(),
                                },
                                Action::Wait { ms: beat },
                                Action::CommitKey {
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
                        let chunk_chars = bounded_env_usize(
                            "AGENT_WECHAT_TEXT_CHUNK_CHARS",
                            DEFAULT_TEXT_CHUNK_CHARS,
                            8,
                            64,
                        );
                        let pause_ms = bounded_env_u64(
                            "AGENT_WECHAT_TEXT_CHUNK_PAUSE_MS",
                            DEFAULT_TEXT_CHUNK_PAUSE_MS,
                            20,
                            500,
                        );
                        let pause_jitter_ms = bounded_env_u64(
                            "AGENT_WECHAT_TEXT_CHUNK_JITTER_MS",
                            DEFAULT_TEXT_CHUNK_JITTER_MS,
                            0,
                            500,
                        );
                        let mut input = vec![Action::Key {
                            combo: "ctrl+a".to_string(),
                        }];
                        input.extend(text_input_actions(
                            msg,
                            chunk_chars,
                            pause_ms,
                            pause_jitter_ms,
                            || actions::next_jitter() as u64,
                        ));
                        input.push(Action::Wait { ms: beat });
                        input.push(Action::CommitKey {
                            combo: "Return".to_string(),
                        });
                        return Some(SelectedAction {
                            action: Action::PreCommitSequence {
                                actions: input,
                                cleanup: vec![
                                    Action::Key {
                                        combo: "ctrl+a".to_string(),
                                    },
                                    Action::Key {
                                        combo: "BackSpace".to_string(),
                                    },
                                ],
                            },
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

    fn action_executed(
        &self,
        plan_state: &mut SendMessagePlanState,
        result: &ActionExecutionResult,
    ) -> bool {
        record_action_result(plan_state, result);
        true
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
    fn all_unverifiable_fallback_codes_are_safety_critical() {
        for code in [
            "CHAT_SELECT_FAILED",
            "CHAT_SELECT_TIMEOUT",
            "CHAT_SELECT_INVALID_RESPONSE",
            "FRIDA_ATTACH_TIMEOUT",
            "FRIDA_ATTACH_FAILED",
            "FRIDA_ENUMERATION_FAILED",
            "FRIDA_HOOK_FAILED",
            "FRIDA_SESSION_VECTOR_UNAVAILABLE",
            "TARGET_CONFIRMATION_FAILED",
            "CHAT_CLICK_TIMEOUT",
            "CHAT_CLICK_FAILED",
        ] {
            assert!(is_unverifiable_chat_selection(code), "{code}");
        }
        for ordinary in [
            "UNSUPPORTED_WECHAT_BUILD",
            "TARGET_NOT_FOUND",
            "OFFICIAL_ACCOUNT_UNSUPPORTED",
            "TARGET_NOT_ACTIVE",
            "INVALID_ARGUMENT",
        ] {
            assert!(!is_unverifiable_chat_selection(ordinary), "{ordinary}");
        }
    }

    #[test]
    fn text_chunking_is_unicode_safe_and_deterministic() {
        let actions = text_input_actions("你好abc世界def", 4, 40, 20, || 7);
        assert_eq!(actions.len(), 5);
        assert!(matches!(
            &actions[0],
            Action::Type { text, .. } if text == "你好ab"
        ));
        assert!(matches!(&actions[1], Action::Wait { ms: 47 }));
        assert!(matches!(
            &actions[2],
            Action::Type { text, .. } if text == "c世界d"
        ));
        assert!(matches!(&actions[3], Action::Wait { ms: 47 }));
        assert!(matches!(
            &actions[4],
            Action::Type { text, .. } if text == "ef"
        ));
    }

    #[test]
    fn very_long_text_falls_back_to_one_input_action() {
        let text = "界".repeat(MAX_CHUNKED_TEXT_CHARS + 1);
        let actions = text_input_actions(&text, 8, 45, 80, || 7);
        assert_eq!(actions.len(), 1);
        assert!(matches!(&actions[0], Action::Type { text: actual, .. } if actual == &text));
    }

    #[test]
    fn short_text_is_one_input_action_without_pause() {
        let actions = text_input_actions("hello", 24, 45, 80, || 999);
        assert_eq!(actions.len(), 1);
        assert!(matches!(&actions[0], Action::Type { text, .. } if text == "hello"));
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
    fn pre_send_failure_is_definite_and_does_not_arm_guard() {
        let mut state = SendMessagePlan.initial_plan_state();
        record_action_result(
            &mut state,
            &Err(crate::execution::actions::ActionExecutionError {
                diagnostic: "message_input_failed",
                commit_attempted: false,
                detail: "input failed".to_string(),
            }),
        );
        assert!(!state.send_action_executed);
        assert_eq!(
            state.diagnostic_error.as_deref(),
            Some("message_input_failed")
        );
        assert_eq!(allow_single_send(&mut state), Ok(()));
    }

    #[test]
    fn commit_attempt_arms_guard_and_suppresses_duplicate() {
        let mut state = SendMessagePlan.initial_plan_state();
        record_action_result(&mut state, &Ok(true));
        assert!(state.send_action_executed);
        assert!(matches!(state.phase, SendMessagePhase::Confirming));
        assert_eq!(
            allow_single_send(&mut state),
            Err("duplicate_send_action_suppressed")
        );
    }

    #[test]
    fn failed_commit_is_uncertain_and_arms_guard() {
        let mut state = SendMessagePlan.initial_plan_state();
        record_action_result(
            &mut state,
            &Err(crate::execution::actions::ActionExecutionError {
                diagnostic: "send_commit_uncertain",
                commit_attempted: true,
                detail: "key failed".to_string(),
            }),
        );
        assert!(state.send_action_executed);
        assert_eq!(
            state.diagnostic_error.as_deref(),
            Some("send_commit_uncertain")
        );
    }

    #[test]
    fn confirmation_diagnostics_after_successful_return_keep_commit_armed() {
        let mut state = SendMessagePlan.initial_plan_state();
        record_action_result(&mut state, &Ok(true));
        assert!(state.send_action_executed);
        assert!(matches!(state.phase, SendMessagePhase::Confirming));

        state.diagnostic_error = Some("composer_missing_during_confirmation".into());
        assert!(state.send_action_executed);
        assert_eq!(
            reset_after_popup(&mut state),
            Err("popup_after_send_action")
        );
        assert_eq!(
            state.diagnostic_error.as_deref(),
            Some("popup_after_send_action")
        );
        assert!(state.send_action_executed);
    }
}
