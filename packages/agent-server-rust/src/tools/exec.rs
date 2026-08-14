use crate::ia::types::Session;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    os::unix::process::{CommandExt, ExitStatusExt},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    task::JoinHandle,
};

const SUPERVISOR_ENV: &str = "AGENT_WECHAT_EXEC_SUPERVISOR";
#[cfg(test)]
const SUPERVISOR_COMMAND_ENV: &str = "AGENT_WECHAT_EXEC_SUPERVISOR_COMMAND";
#[cfg(test)]
const SUPERVISOR_ARGS_ENV: &str = "AGENT_WECHAT_EXEC_SUPERVISOR_ARGS";
const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const TERMINATE_GRACE: Duration = Duration::from_millis(250);
const SUPERVISOR_POLL: Duration = Duration::from_millis(5);

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

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ProcessIdentity {
    pid: i32,
    start_time: u64,
}

fn process_stat(pid: i32) -> Option<(i32, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    let mut fields = fields.split_whitespace();
    let _state = fields.next()?;
    let parent = fields.next()?.parse().ok()?;
    let start_time = fields.nth(17)?.parse().ok()?;
    Some((parent, start_time))
}

fn process_identity(pid: i32) -> Option<ProcessIdentity> {
    let (_, start_time) = process_stat(pid)?;
    Some(ProcessIdentity { pid, start_time })
}

fn identity_is_live(identity: ProcessIdentity) -> bool {
    process_identity(identity.pid) == Some(identity)
}

fn descendants_of(root: i32) -> HashSet<ProcessIdentity> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return HashSet::new();
    };
    let processes: Vec<(i32, i32, u64)> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<i32>().ok())
        .filter_map(|pid| process_stat(pid).map(|(parent, start)| (pid, parent, start)))
        .collect();
    let mut parents = HashSet::from([root]);
    let mut descendants = HashSet::new();
    loop {
        let mut changed = false;
        for (pid, parent, start_time) in &processes {
            if parents.contains(parent) && parents.insert(*pid) {
                descendants.insert(ProcessIdentity {
                    pid: *pid,
                    start_time: *start_time,
                });
                changed = true;
            }
        }
        if !changed {
            return descendants;
        }
    }
}

fn signal_identity(identity: ProcessIdentity, signal: i32) {
    if identity_is_live(identity) {
        unsafe {
            libc::kill(identity.pid, signal);
        }
    }
}

fn set_nonblocking(fd: i32) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn cancellation_requested() -> bool {
    let mut byte = [0u8; 1];
    match std::io::stdin().read(&mut byte) {
        Ok(0) => true,
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
        Err(_) => true,
    }
}

fn reap_adopted_children() {
    loop {
        let mut status = 0;
        let reaped = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if reaped <= 0 {
            break;
        }
    }
}

fn terminate_tracked(tracked: &mut HashSet<ProcessIdentity>, root: i32) {
    tracked.extend(descendants_of(root));
    for identity in tracked.iter().copied() {
        signal_identity(identity, libc::SIGTERM);
    }

    let term_deadline = Instant::now() + TERMINATE_GRACE;
    while Instant::now() < term_deadline {
        tracked.extend(descendants_of(root));
        reap_adopted_children();
        std::thread::sleep(SUPERVISOR_POLL);
    }

    tracked.extend(descendants_of(root));
    for identity in tracked.iter().copied() {
        signal_identity(identity, libc::SIGKILL);
    }

    let reap_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        tracked.extend(descendants_of(root));
        for identity in tracked.iter().copied() {
            signal_identity(identity, libc::SIGKILL);
        }
        reap_adopted_children();
        tracked.retain(|identity| identity_is_live(*identity));
        if tracked.is_empty() || Instant::now() >= reap_deadline {
            break;
        }
        std::thread::sleep(SUPERVISOR_POLL);
    }
    reap_adopted_children();
}

/// Hidden synchronous process-tree supervisor entrypoint.
///
/// Returns `Some(exit_code)` when the current process was invoked in supervisor
/// mode. The supervisor is an independent process and Linux subreaper, so Tokio
/// task/runtime shutdown cannot cancel cleanup and escaped/double-forked children
/// remain owned and waitable here.
pub fn exec_supervisor_entrypoint() -> Option<i32> {
    if std::env::var_os(SUPERVISOR_ENV).is_none() {
        return None;
    }
    #[cfg(not(test))]
    let (command, command_args) = {
        let mut args = std::env::args_os();
        let _program = args.next()?;
        (args.next()?, args.collect::<Vec<_>>())
    };
    #[cfg(test)]
    let (command, command_args) = {
        let command = std::env::var_os(SUPERVISOR_COMMAND_ENV)?;
        let encoded = std::env::var(SUPERVISOR_ARGS_ENV).ok()?;
        let args: Vec<String> = serde_json::from_str(&encoded).ok()?;
        (
            command,
            args.into_iter()
                .map(std::ffi::OsString::from)
                .collect::<Vec<_>>(),
        )
    };

    #[cfg(target_os = "linux")]
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Some(126);
    }

    if set_nonblocking(libc::STDIN_FILENO).is_err() {
        return Some(126);
    }

    let mut target = std::process::Command::new(command);
    target
        .args(command_args)
        .env_remove(SUPERVISOR_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(test)]
    target
        .env_remove(SUPERVISOR_COMMAND_ENV)
        .env_remove(SUPERVISOR_ARGS_ENV);
    target.process_group(0);
    let mut target = match target.spawn() {
        Ok(child) => child,
        Err(_) => return Some(125),
    };

    let root = std::process::id() as i32;
    let mut tracked = HashSet::new();
    let status = loop {
        tracked.extend(descendants_of(root));
        if cancellation_requested() {
            break None;
        }
        match target.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(SUPERVISOR_POLL),
            Err(_) => break None,
        }
    };

    terminate_tracked(&mut tracked, root);
    if let Ok(None) = target.try_wait() {
        unsafe {
            libc::kill(target.id() as i32, libc::SIGKILL);
        }
        let _ = target.wait();
    }

    Some(match status {
        Some(status) => status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
            .unwrap_or(1),
        None => 124,
    })
}

struct SupervisedChild {
    child: Option<Child>,
    cancel: Option<tokio::process::ChildStdin>,
    pid: i32,
}

impl SupervisedChild {
    fn new(mut child: Child) -> Result<Self, ()> {
        let pid = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .ok_or(())?;
        let cancel = child.stdin.take().ok_or(())?;
        Ok(Self {
            child: Some(child),
            cancel: Some(cancel),
            pid,
        })
    }

    async fn cancel_and_reap(&mut self) {
        self.cancel.take();
        if let Some(child) = self.child.as_mut() {
            if tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_err()
            {
                unsafe {
                    libc::kill(self.pid, libc::SIGKILL);
                }
                let _ = child.wait().await;
            }
        }
        self.child = None;
    }

    fn finish(&mut self) {
        self.cancel.take();
        self.child = None;
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        self.cancel.take();
        if self.child.take().is_some() {
            let pid = self.pid;
            std::thread::spawn(move || {
                let mut status = 0;
                unsafe {
                    libc::waitpid(pid, &mut status, 0);
                }
            });
        }
    }
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

    #[cfg(all(test, not(target_os = "linux")))]
    let mut command_builder = {
        let mut builder = Command::new(command);
        builder.args(args);
        builder
    };
    #[cfg(any(not(test), target_os = "linux"))]
    let mut command_builder = {
        let executable = match std::env::current_exe() {
            Ok(path) => path,
            Err(_) => return command_result(Vec::new(), b"Command failed to start".to_vec(), 1),
        };
        let mut builder = Command::new(executable);
        #[cfg(not(test))]
        builder.arg(command).args(args);
        builder
    };
    #[cfg(all(test, target_os = "linux"))]
    command_builder
        .args([
            "--exact",
            "tools::exec::tests::supervisor_process_entry",
            "--nocapture",
        ])
        .env(SUPERVISOR_COMMAND_ENV, command)
        .env(
            SUPERVISOR_ARGS_ENV,
            serde_json::to_string(args).unwrap_or_else(|_| "[]".to_string()),
        );
    command_builder
        .envs(&env)
        .env(SUPERVISOR_ENV, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

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

    match tokio::time::timeout(Duration::from_millis(options.timeout_ms), child_ref.wait()).await {
        Ok(Ok(status)) => {
            child.finish();
            let stdout = captured(stdout_task).await;
            let stderr = captured(stderr_task).await;
            match status.code() {
                Some(125) => command_result(Vec::new(), b"Command failed to start".to_vec(), 1),
                Some(126) => command_result(Vec::new(), b"Command execution failed".to_vec(), 1),
                code => command_result(stdout, stderr, code.unwrap_or(1)),
            }
        }
        Ok(Err(_)) => {
            child.cancel_and_reap().await;
            let _ = captured(stdout_task).await;
            let _ = captured(stderr_task).await;
            command_result(Vec::new(), b"Command execution failed".to_vec(), 1)
        }
        Err(_) => {
            child.cancel_and_reap().await;
            let _ = captured(stdout_task).await;
            let _ = captured(stderr_task).await;
            command_result(Vec::new(), b"Command timed out".to_vec(), 1)
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{fs, path::Path};
    use tempfile::TempDir;

    #[test]
    fn supervisor_process_entry() {
        let Some(exit_code) = exec_supervisor_entrypoint() else {
            return;
        };
        std::process::exit(exit_code);
    }

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
        let deadline = Instant::now() + Duration::from_secs(3);
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

    fn non_waiting_parent_script(pids: &Path, escaped: bool) -> String {
        let escaped = if escaped {
            ", start_new_session=True"
        } else {
            ""
        };
        let code = format!(
            "import os, subprocess, time; child=subprocess.Popen(['sleep','30']{escaped}); open({:?},'w').write(f'{{os.getpid()}} {{child.pid}}'); time.sleep(30)",
            pids.to_string_lossy()
        );
        format!("exec python3 -c {code:?}")
    }

    fn late_double_fork_script(pids: &Path) -> String {
        let code = format!(
            "import os,time; exec(\"first=os.fork()\\nif first==0:\\n os.setsid()\\n second=os.fork()\\n if second>0: os._exit(0)\\n time.sleep(.2)\\n os.execlp('sleep','sleep','30')\"); open({:?},'w').write(str(os.getpid())); time.sleep(30)",
            pids.to_string_lossy()
        );
        format!("exec python3 -c {code:?}")
    }

    #[tokio::test]
    async fn timeout_reaps_non_waiting_parent_and_escaped_descendant() {
        for escaped in [false, true] {
            let dir = TempDir::new().unwrap();
            let pids = dir.path().join("pids");
            let script = non_waiting_parent_script(&pids, escaped);
            let result = exec_command(
                "sh",
                &["-c", &script],
                &ExecOptions {
                    session: None,
                    timeout_ms: 500,
                },
            )
            .await;
            assert_eq!(result.stderr, "Command timed out");
            let (parent, descendant) = pid_pair(&pids);
            wait_dead(parent).await;
            wait_dead(descendant).await;
        }
    }

    #[tokio::test]
    async fn concurrent_supervisors_do_not_cross_kill() {
        let dir = TempDir::new().unwrap();
        let pids_a = dir.path().join("a-pids");
        let pids_b = dir.path().join("b-pids");
        let script_a = non_waiting_parent_script(&pids_a, true);
        let script_b = non_waiting_parent_script(&pids_b, true);
        let task_a = tokio::spawn(async move {
            exec_command(
                "sh",
                &["-c", &script_a],
                &ExecOptions {
                    session: None,
                    timeout_ms: 300,
                },
            )
            .await
        });
        let task_b = tokio::spawn(async move {
            exec_command(
                "sh",
                &["-c", &script_b],
                &ExecOptions {
                    session: None,
                    timeout_ms: 900,
                },
            )
            .await
        });
        wait_for_file(&pids_a).await;
        wait_for_file(&pids_b).await;
        let (_, descendant_b) = pid_pair(&pids_b);
        assert_eq!(task_a.await.unwrap().stderr, "Command timed out");
        assert!(
            process_exists(descendant_b),
            "other supervisor killed early"
        );
        assert_eq!(task_b.await.unwrap().stderr, "Command timed out");
        wait_dead(descendant_b).await;
    }

    #[tokio::test]
    async fn timeout_reaps_late_double_fork() {
        let dir = TempDir::new().unwrap();
        let parent_pid = dir.path().join("parent-pid");
        let script = late_double_fork_script(&parent_pid);
        let result = exec_command(
            "sh",
            &["-c", &script],
            &ExecOptions {
                session: None,
                timeout_ms: 700,
            },
        )
        .await;
        assert_eq!(result.stderr, "Command timed out");
        let parent = fs::read_to_string(parent_pid).unwrap().parse().unwrap();
        wait_dead(parent).await;
    }

    #[tokio::test]
    async fn cancellation_reaps_escaped_descendant() {
        let dir = TempDir::new().unwrap();
        let pids = dir.path().join("pids");
        let script = non_waiting_parent_script(&pids, true);
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

    #[test]
    fn cleanup_survives_origin_runtime_shutdown() {
        let dir = TempDir::new().unwrap();
        let pids = dir.path().join("pids");
        let script = non_waiting_parent_script(&pids, true);
        let pids_for_thread = pids.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
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
                wait_for_file(&pids_for_thread).await;
                task.abort();
            });
        })
        .join()
        .unwrap();
        let (parent, descendant) = pid_pair(&pids);
        std::thread::sleep(Duration::from_secs(1));
        assert!(!process_exists(parent));
        assert!(!process_exists(descendant));
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
        assert!(!result.stderr.contains("SUPER_SECRET"));
        assert!(result.stdout.len() <= MAX_CAPTURE_BYTES);
        assert!(result.stdout.len() >= MAX_CAPTURE_BYTES - 2);
        assert!(result.stdout.contains("ok  "));
    }

    #[tokio::test]
    async fn spawn_failure_is_redacted() {
        let result = exec_command(
            "/missing/SUPER_SECRET/command",
            &[],
            &ExecOptions::default(),
        )
        .await;
        assert_eq!(result.exit_code, 1);
        assert!(!result.stdout.contains("SUPER_SECRET"));
        assert!(!result.stderr.contains("SUPER_SECRET"));
    }
}
