use crate::ia::types::Session;
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    task::JoinHandle,
};

const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const TERMINATE_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub struct ExecOptions {
    pub session: Option<Session>,
    pub timeout_ms: u64,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self {
            session: None,
            timeout_ms: 60_000,
        }
    }
}

struct SupervisedChild {
    child: Option<Child>,
    process_group: i32,
}

impl SupervisedChild {
    fn new(child: Child) -> Result<Self, ()> {
        let process_group = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .ok_or(())?;
        Ok(Self {
            child: Some(child),
            process_group,
        })
    }

    fn signal_group(&self, signal: i32) {
        signal_process(-self.process_group, signal);
    }

    async fn terminate_and_reap(&mut self) {
        if let Some(child) = self.child.take() {
            terminate_child_group(child, self.process_group).await;
        }
    }

    fn disarm(&mut self) {
        self.child = None;
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        let process_group = self.process_group;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(terminate_child_group(child, process_group));
        } else {
            signal_process(-process_group, libc::SIGKILL);
        }
    }
}

fn signal_process(pid: i32, signal: i32) {
    unsafe {
        libc::kill(pid, signal);
    }
}

#[cfg(target_os = "linux")]
fn process_group_members(process_group: i32) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<i32>().ok())
        .filter(|pid| *pid != process_group)
        .filter(|pid| {
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                return false;
            };
            let Some(after_name) = stat.rsplit_once(") ").map(|(_, rest)| rest) else {
                return false;
            };
            after_name
                .split_whitespace()
                .nth(2)
                .and_then(|field| field.parse::<i32>().ok())
                == Some(process_group)
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn process_group_members(_process_group: i32) -> Vec<i32> {
    Vec::new()
}

async fn terminate_child_group(mut child: Child, process_group: i32) {
    // Stop descendants first so the direct child can reap them before it exits.
    // This avoids leaving zombies behind under minimal container PID 1s.
    let descendants = process_group_members(process_group);
    for pid in &descendants {
        signal_process(*pid, libc::SIGTERM);
    }
    tokio::time::sleep(TERMINATE_GRACE).await;
    for pid in &descendants {
        signal_process(*pid, libc::SIGKILL);
    }

    if tokio::time::timeout(TERMINATE_GRACE, child.wait())
        .await
        .is_err()
    {
        signal_process(-process_group, libc::SIGTERM);
        if tokio::time::timeout(TERMINATE_GRACE, child.wait())
            .await
            .is_err()
        {
            signal_process(-process_group, libc::SIGKILL);
            let _ = child.wait().await;
        }
    }
    // Catch any late fork in the group after the direct child was reaped.
    signal_process(-process_group, libc::SIGKILL);
}

async fn read_bounded(mut stream: impl AsyncRead + Unpin) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = MAX_CAPTURE_BYTES.saturating_sub(captured.len());
                captured.extend_from_slice(&chunk[..count.min(remaining)]);
            }
        }
    }
    captured
}

async fn captured(handle: JoinHandle<Vec<u8>>) -> Vec<u8> {
    handle.await.unwrap_or_default()
}

fn command_result(stdout: Vec<u8>, stderr: Vec<u8>, exit_code: i32) -> CommandResult {
    CommandResult {
        stdout: String::from_utf8_lossy(&stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        exit_code,
    }
}

/// Execute a command with fixed arguments (no shell interpolation).
///
/// The subprocess runs in its own process group. Timeout or caller cancellation
/// kills and reaps the group so helpers such as Frida cannot survive the API call.
pub async fn exec_command(command: &str, args: &[&str], options: &ExecOptions) -> CommandResult {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("QT_ACCESSIBILITY".into(), "1".into());
    env.insert("QT_LINUX_ACCESSIBILITY_ALWAYS_ON".into(), "1".into());

    if let Some(session) = &options.session {
        env.insert("DISPLAY".into(), session.display.clone());
        env.insert(
            "DBUS_SESSION_BUS_ADDRESS".into(),
            session.dbus_address.clone().unwrap_or_default(),
        );
        env.insert("HOME".into(), format!("/home/{}", session.linux_user));
    } else {
        env.entry("DISPLAY".into()).or_insert_with(|| ":99".into());
    }

    let mut command_builder = Command::new(command);
    command_builder
        .args(args)
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command_builder.process_group(0);

    let mut child = match command_builder.spawn() {
        Ok(child) => match SupervisedChild::new(child) {
            Ok(child) => child,
            Err(()) => return command_result(Vec::new(), b"Command failed to start".to_vec(), 1),
        },
        Err(_) => return command_result(Vec::new(), b"Command failed to start".to_vec(), 1),
    };

    let child_ref = child.child.as_mut().expect("supervised child missing");
    let stdout_task = tokio::spawn(read_bounded(
        child_ref.stdout.take().expect("child stdout not piped"),
    ));
    let stderr_task = tokio::spawn(read_bounded(
        child_ref.stderr.take().expect("child stderr not piped"),
    ));

    let timeout = Duration::from_millis(options.timeout_ms);
    match tokio::time::timeout(timeout, child_ref.wait()).await {
        Ok(Ok(status)) => {
            // A command must not leave background descendants holding pipes/hooks.
            child.signal_group(libc::SIGKILL);
            child.disarm();
            command_result(
                captured(stdout_task).await,
                captured(stderr_task).await,
                status.code().unwrap_or(1),
            )
        }
        Ok(Err(_)) => {
            child.terminate_and_reap().await;
            let _ = captured(stdout_task).await;
            let _ = captured(stderr_task).await;
            command_result(Vec::new(), b"Command execution failed".to_vec(), 1)
        }
        Err(_) => {
            child.terminate_and_reap().await;
            let _ = captured(stdout_task).await;
            let _ = captured(stderr_task).await;
            command_result(Vec::new(), b"Command timed out".to_vec(), 1)
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{fs, path::Path, time::Instant};
    use tempfile::TempDir;

    fn process_exists(pid: i32) -> bool {
        Path::new(&format!("/proc/{pid}")).exists()
    }

    async fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !path.exists() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(path.exists(), "pid file was not created");
    }

    async fn wait_dead(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_exists(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!process_exists(pid), "process {pid} survived supervision");
    }

    fn pid_pair(path: &Path) -> (i32, i32) {
        let value = fs::read_to_string(path).unwrap();
        let mut fields = value.split_whitespace().map(|field| field.parse().unwrap());
        (fields.next().unwrap(), fields.next().unwrap())
    }

    #[tokio::test]
    async fn timeout_kills_and_reaps_parent_and_descendant() {
        let dir = TempDir::new().unwrap();
        let pids = dir.path().join("pids");
        let script = format!(
            "printf SUPER_SECRET; printf SUPER_SECRET >&2; sleep 30 & child=$!; echo $$ $child > {}; wait $child",
            pids.display()
        );
        let result = exec_command(
            "sh",
            &["-c", &script],
            &ExecOptions {
                session: None,
                timeout_ms: 100,
            },
        )
        .await;
        assert!(result.stdout.is_empty());
        assert_eq!(result.stderr, "Command timed out");
        let (parent, descendant) = pid_pair(&pids);
        wait_dead(parent).await;
        wait_dead(descendant).await;
    }

    #[tokio::test]
    async fn successful_output_is_trimmed_and_bounded() {
        let result = exec_command(
            "sh",
            &["-c", "printf '  ok  '; head -c 1100000 /dev/zero"],
            &ExecOptions::default(),
        )
        .await;
        assert_eq!(result.exit_code, 0);
        assert!(result.stderr.is_empty());
        assert!(result.stdout.len() <= MAX_CAPTURE_BYTES);
        assert!(result.stdout.len() >= MAX_CAPTURE_BYTES - 2);
        assert!(result.stdout.starts_with("ok  "));
    }

    #[tokio::test]
    async fn spawn_failure_is_redacted() {
        let result = exec_command(
            "/missing/SUPER_SECRET/command",
            &[],
            &ExecOptions::default(),
        )
        .await;
        assert!(result.stdout.is_empty());
        assert_eq!(result.stderr, "Command failed to start");
        assert_eq!(result.exit_code, 1);
    }

    #[tokio::test]
    async fn cancellation_kills_and_reaps_parent_and_descendant() {
        let dir = TempDir::new().unwrap();
        let pids = dir.path().join("pids");
        let script = format!(
            "sleep 30 & child=$!; echo $$ $child > {}; wait $child",
            pids.display()
        );
        let task = tokio::spawn(async move {
            exec_command(
                "sh",
                &["-c", &script],
                &ExecOptions {
                    session: None,
                    timeout_ms: 30_000,
                },
            )
            .await
        });
        wait_for_file(&pids).await;
        let (parent, descendant) = pid_pair(&pids);
        task.abort();
        let _ = task.await;
        wait_dead(parent).await;
        wait_dead(descendant).await;
    }
}
