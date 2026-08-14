use crate::ia::selectors::query_selector;
use crate::ia::types::{A11yNode, Action, FrameHint, SubscriptionEvent};
use crate::tools::exec::{exec_command, CommandResult, ExecOptions};
use std::future::Future;
use std::pin::Pin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionExecutionError {
    pub diagnostic: &'static str,
    pub commit_attempted: bool,
    pub detail: String,
}

pub type ActionExecutionResult = Result<bool, ActionExecutionError>;

fn window_geometry_args(hint: &FrameHint) -> Option<Vec<String>> {
    hint.pid.map(|pid| {
        vec![
            pid.to_string(),
            (hint.bounds.x as i32).to_string(),
            (hint.bounds.y as i32).to_string(),
            (hint.bounds.width as i32).to_string(),
            (hint.bounds.height as i32).to_string(),
        ]
    })
}

fn window_prefixed_args(hint: &FrameHint) -> Option<Vec<String>> {
    window_geometry_args(hint).map(|geometry| {
        let mut args = vec!["--window".to_string()];
        args.extend(geometry);
        args.push("--".to_string());
        args
    })
}

fn command_error(
    result: &CommandResult,
    diagnostic: &'static str,
    commit_attempted: bool,
) -> ActionExecutionError {
    let detail = if result.stderr.is_empty() {
        format!("command exited with code {}", result.exit_code)
    } else {
        result.stderr.clone()
    };
    ActionExecutionError {
        diagnostic,
        commit_attempted,
        detail,
    }
}

async fn checked_command(
    command: &str,
    args: &[&str],
    options: &ExecOptions,
    diagnostic: &'static str,
    commit_attempted: bool,
) -> ActionExecutionResult {
    let result = exec_command(command, args, options).await;
    if result.exit_code == 0 {
        Ok(commit_attempted)
    } else {
        Err(command_error(&result, diagnostic, commit_attempted))
    }
}

async fn activate_window(
    frame: Option<&FrameHint>,
    options: &ExecOptions,
) -> ActionExecutionResult {
    let Some(args) = frame.and_then(window_geometry_args) else {
        return Ok(false);
    };
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    checked_command(
        "window-activate",
        &args_ref,
        options,
        "window_activation_failed",
        false,
    )
    .await
}

/// Execute a single action against the WeChat UI.
/// `frame` is the target window hint from the plan — used for window activation.
/// The result records whether the irreversible send key was attempted, even if
/// the key command itself failed and its outcome is therefore uncertain.
pub fn execute_action<'a>(
    action: &'a Action,
    frame: Option<&'a FrameHint>,
    options: &'a ExecOptions,
    a11y: &'a A11yNode,
    emit: &'a (dyn Fn(SubscriptionEvent) + Send + Sync),
) -> Pin<Box<dyn Future<Output = ActionExecutionResult> + Send + 'a>> {
    Box::pin(async move {
        match action {
            Action::ClickSelector { selector } => {
                let node_match = query_selector(a11y, selector);

                if let Some(node) = node_match {
                    if let Some(bounds) = &node.bounds {
                        let cx = (bounds.x + bounds.width / 2.0).round() as i32;
                        let cy = (bounds.y + bounds.height / 2.0).round() as i32;
                        tracing::info!("[action] click selector '{selector}' -> ({cx}, {cy})");

                        let mut args = frame.and_then(window_prefixed_args).unwrap_or_default();
                        args.push(cx.to_string());
                        args.push(cy.to_string());
                        let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
                        checked_command("click", &args_ref, options, "click_action_failed", false)
                            .await
                    } else {
                        tracing::warn!(
                            "[action] click selector '{selector}' matched but no bounds"
                        );
                        Ok(false)
                    }
                } else {
                    tracing::warn!("[action] click selector '{selector}' - no match");
                    Ok(false)
                }
            }

            Action::ClickCoords { x, y } => {
                let mut args = frame.and_then(window_prefixed_args).unwrap_or_default();
                args.push((*x as i32).to_string());
                args.push((*y as i32).to_string());
                let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
                checked_command("click", &args_ref, options, "click_action_failed", false).await
            }

            Action::Type { text, selector: _ } => {
                activate_window(frame, options).await?;
                checked_command(
                    "input",
                    &[text.as_str()],
                    options,
                    "message_input_failed",
                    false,
                )
                .await
            }

            Action::PasteFile { path } => {
                activate_window(frame, options).await?;
                checked_command(
                    "paste-file",
                    &[path.as_str()],
                    options,
                    "file_paste_failed",
                    false,
                )
                .await
            }

            Action::PasteImage { path, mime } => {
                activate_window(frame, options).await?;
                let mut args = vec![path.as_str()];
                if let Some(mime) = mime {
                    args.push(mime.as_str());
                }
                checked_command("paste-image", &args, options, "image_paste_failed", false).await
            }

            Action::Key { combo } => {
                let mut args = frame.and_then(window_prefixed_args).unwrap_or_default();
                args.push(combo.clone());
                let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
                checked_command("key", &args_ref, options, "key_action_failed", false).await
            }

            Action::CommitKey { combo } => {
                let mut args = frame.and_then(window_prefixed_args).unwrap_or_default();
                args.push(combo.clone());
                let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
                let result = exec_command("key", &args_ref, options).await;
                if result.exit_code == 0 {
                    Ok(true)
                } else if result.exit_code == 10 {
                    Err(command_error(&result, "window_activation_failed", false))
                } else {
                    Err(command_error(&result, "send_commit_uncertain", true))
                }
            }

            Action::Scroll {
                direction,
                x: _,
                y: _,
                amount,
            } => {
                let dir = match direction {
                    crate::ia::types::ScrollDirection::Up => "up",
                    crate::ia::types::ScrollDirection::Down => "down",
                };
                let mut args = vec![dir.to_string()];
                if let Some(amt) = amount {
                    args.push(amt.to_string());
                }
                let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
                checked_command("scroll", &args_ref, options, "scroll_action_failed", false).await
            }

            Action::Wait { ms } => {
                tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
                Ok(false)
            }

            Action::Emit { event } => {
                emit(event.clone());
                Ok(false)
            }

            Action::Sequence { actions } => {
                let mut commit_attempted = false;
                for action in actions {
                    match execute_action(action, frame, options, a11y, emit).await {
                        Ok(attempted) => commit_attempted |= attempted,
                        Err(error) => return Err(error),
                    }
                }
                Ok(commit_attempted)
            }

            Action::PreCommitSequence { actions, cleanup } => {
                let mut commit_attempted = false;
                for action in actions {
                    match execute_action(action, frame, options, a11y, emit).await {
                        Ok(attempted) => commit_attempted |= attempted,
                        Err(error) => {
                            if !commit_attempted && !error.commit_attempted {
                                for cleanup_action in cleanup {
                                    if execute_action(cleanup_action, frame, options, a11y, emit)
                                        .await
                                        .is_err()
                                    {
                                        return Err(ActionExecutionError {
                                            diagnostic: "draft_cleanup_failed",
                                            commit_attempted: false,
                                            detail: "failed to clear pre-commit draft".to_string(),
                                        });
                                    }
                                }
                            }
                            return Err(error);
                        }
                    }
                }
                Ok(commit_attempted)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ia::types::Bounds;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    static PATH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn empty_a11y() -> A11yNode {
        A11yNode {
            role: "desktop".to_string(),
            name: String::new(),
            bounds: None,
            children: None,
            parent_index: None,
            window: None,
            states: None,
        }
    }

    fn frame() -> FrameHint {
        FrameHint {
            name: Some("WeChat".to_string()),
            bounds: Bounds {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            },
            pid: Some(99),
        }
    }

    fn write_tool(dir: &TempDir, name: &str, body: &str) {
        let path = dir.path().join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn with_test_path(dir: &TempDir) -> String {
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{old_path}", dir.path().display()));
        old_path
    }

    #[tokio::test]
    async fn paste_failure_stops_before_commit() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        write_tool(&dir, "paste-file", "exit 23");
        write_tool(&dir, "key", "exit 0");
        let old_path = with_test_path(&dir);
        let action = Action::Sequence {
            actions: vec![
                Action::PasteFile {
                    path: "/tmp/file".to_string(),
                },
                Action::CommitKey {
                    combo: "Return".to_string(),
                },
            ],
        };

        let result = execute_action(
            &action,
            None,
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        assert_eq!(
            result.unwrap_err(),
            ActionExecutionError {
                diagnostic: "file_paste_failed",
                commit_attempted: false,
                detail: "command exited with code 23".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn image_paste_failure_stops_before_commit() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        write_tool(&dir, "paste-image", "exit 27");
        write_tool(&dir, "key", "exit 0");
        let old_path = with_test_path(&dir);
        let action = Action::Sequence {
            actions: vec![
                Action::PasteImage {
                    path: "/tmp/image".to_string(),
                    mime: Some("image/png".to_string()),
                },
                Action::CommitKey {
                    combo: "Return".to_string(),
                },
            ],
        };

        let result = execute_action(
            &action,
            None,
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        let error = result.unwrap_err();
        assert_eq!(error.diagnostic, "image_paste_failed");
        assert!(!error.commit_attempted);
    }

    #[tokio::test]
    async fn input_failure_stops_before_commit() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        write_tool(&dir, "input", "exit 24");
        write_tool(&dir, "key", "exit 0");
        let old_path = with_test_path(&dir);
        let action = Action::Sequence {
            actions: vec![
                Action::Type {
                    text: "hello".to_string(),
                    selector: None,
                },
                Action::CommitKey {
                    combo: "Return".to_string(),
                },
            ],
        };

        let result = execute_action(
            &action,
            None,
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        let error = result.unwrap_err();
        assert_eq!(error.diagnostic, "message_input_failed");
        assert!(!error.commit_attempted);
    }

    #[tokio::test]
    async fn chunk_failure_clears_partial_draft_before_returning() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        let log_path = dir.path().join("keys.log");
        let count_path = dir.path().join("input-count");
        write_tool(
            &dir,
            "input",
            &format!(
                "count=$(cat '{}' 2>/dev/null || echo 0); count=$((count + 1)); echo $count > '{}'; [ $count -eq 1 ]",
                count_path.display(),
                count_path.display()
            ),
        );
        write_tool(
            &dir,
            "key",
            &format!("echo \"$1\" >> '{}'", log_path.display()),
        );
        let old_path = with_test_path(&dir);
        let action = Action::PreCommitSequence {
            actions: vec![
                Action::Type {
                    text: "first chunk".to_string(),
                    selector: None,
                },
                Action::Type {
                    text: "second chunk".to_string(),
                    selector: None,
                },
                Action::CommitKey {
                    combo: "Return".to_string(),
                },
            ],
            cleanup: vec![
                Action::Key {
                    combo: "ctrl+a".to_string(),
                },
                Action::Key {
                    combo: "BackSpace".to_string(),
                },
            ],
        };

        let result = execute_action(
            &action,
            None,
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        let error = result.unwrap_err();
        assert_eq!(error.diagnostic, "message_input_failed");
        assert!(!error.commit_attempted);
        assert_eq!(fs::read_to_string(log_path).unwrap(), "ctrl+a\nBackSpace\n");
    }

    #[tokio::test]
    async fn failed_draft_cleanup_is_reported_fail_closed() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        write_tool(&dir, "input", "exit 24");
        write_tool(&dir, "key", "exit 25");
        let old_path = with_test_path(&dir);
        let action = Action::PreCommitSequence {
            actions: vec![Action::Type {
                text: "partial".to_string(),
                selector: None,
            }],
            cleanup: vec![Action::Key {
                combo: "ctrl+a".to_string(),
            }],
        };

        let result = execute_action(
            &action,
            None,
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        let error = result.unwrap_err();
        assert_eq!(error.diagnostic, "draft_cleanup_failed");
        assert!(!error.commit_attempted);
    }

    #[tokio::test]
    async fn uncertain_commit_never_runs_draft_cleanup() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        let log_path = dir.path().join("keys.log");
        write_tool(&dir, "input", "exit 0");
        write_tool(
            &dir,
            "key",
            &format!(
                "echo \"$1\" >> '{}'; [ \"$1\" != Return ]",
                log_path.display()
            ),
        );
        let old_path = with_test_path(&dir);
        let action = Action::PreCommitSequence {
            actions: vec![
                Action::Type {
                    text: "complete draft".to_string(),
                    selector: None,
                },
                Action::CommitKey {
                    combo: "Return".to_string(),
                },
            ],
            cleanup: vec![
                Action::Key {
                    combo: "ctrl+a".to_string(),
                },
                Action::Key {
                    combo: "BackSpace".to_string(),
                },
            ],
        };

        let result = execute_action(
            &action,
            None,
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        let error = result.unwrap_err();
        assert!(error.commit_attempted);
        assert_eq!(fs::read_to_string(log_path).unwrap(), "Return\n");
    }

    #[tokio::test]
    async fn window_activation_failure_stops_before_commit() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        write_tool(&dir, "key", "exit 10");
        let old_path = with_test_path(&dir);

        let result = execute_action(
            &Action::CommitKey {
                combo: "Return".to_string(),
            },
            Some(&frame()),
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        let error = result.unwrap_err();
        assert_eq!(error.diagnostic, "window_activation_failed");
        assert!(!error.commit_attempted);
    }

    #[tokio::test]
    async fn failed_commit_is_still_marked_attempted() {
        let _path_guard = PATH_LOCK.lock().await;
        let dir = TempDir::new().unwrap();
        write_tool(&dir, "key", "exit 26");
        let old_path = with_test_path(&dir);

        let result = execute_action(
            &Action::CommitKey {
                combo: "Return".to_string(),
            },
            None,
            &ExecOptions::default(),
            &empty_a11y(),
            &|_| {},
        )
        .await;
        std::env::set_var("PATH", old_path);

        let error = result.unwrap_err();
        assert_eq!(error.diagnostic, "send_commit_uncertain");
        assert!(error.commit_attempted);
    }
}
