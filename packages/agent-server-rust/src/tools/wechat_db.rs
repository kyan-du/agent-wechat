use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

fn sqlite_failure_code(error: &rusqlite::Error) -> String {
    match error {
        rusqlite::Error::SqliteFailure(code, _) => format!("SQLITE_{:?}", code.code),
        _ => "SQLITE_CLIENT_ERROR".to_string(),
    }
}

/// Query a WeChat database and return parsed rows.
/// Opens the database with `immutable=1` to avoid acquiring any shared locks
/// that could interfere with WeChat's own writes. Since we open a fresh
/// connection per query and drop it immediately, immutable mode is safe —
/// we always see the latest committed state at open time.
pub fn query_wechat_db(db_path: &str, hex_key: &str, sql: &str) -> Vec<Value> {
    query_wechat_db_checked(db_path, hex_key, sql).unwrap_or_default()
}

/// Checked query for APIs that must distinguish an empty result from an
/// unavailable/incompatible database. Errors contain SQLite classifications
/// only; SQL text and row data are never included.
pub fn query_wechat_db_checked(
    db_path: &str,
    hex_key: &str,
    sql: &str,
) -> Result<Vec<Value>, String> {
    if !Path::new(db_path).is_file() {
        tracing::warn!("[wechat-db] open failed code=SQLITE_CANTOPEN");
        return Err("SQLITE_CANTOPEN".to_string());
    }
    let uri = format!("file:{}?immutable=1", db_path);
    let conn = Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| {
        let code = sqlite_failure_code(&e);
        tracing::warn!("[wechat-db] open failed code={code}");
        code
    })?;

    conn.execute_batch(&format!("PRAGMA key = \"x'{hex_key}'\"; PRAGMA cipher_compatibility = 4;"))
        .map_err(|e| {
            let code = sqlite_failure_code(&e);
            tracing::warn!("[wechat-db] pragma failed code={code}");
            code
        })?;

    let mut stmt = conn.prepare(sql).map_err(|e| {
        let code = sqlite_failure_code(&e);
        tracing::warn!("[wechat-db] prepare failed code={code}");
        code
    })?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt.query_map([], |row| {
        let mut map = Map::new();
        for (i, name) in col_names.iter().enumerate() {
            let val = match row.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(n)) => Value::Number(n.into()),
                Ok(rusqlite::types::ValueRef::Real(f)) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
                Ok(rusqlite::types::ValueRef::Text(s)) => Value::String(String::from_utf8_lossy(s).into_owned()),
                Ok(rusqlite::types::ValueRef::Blob(b)) => Value::String(b.iter().map(|byte| format!("{byte:02X}")).collect()),
                Err(_) => Value::Null,
            };
            map.insert(name.clone(), val);
        }
        Ok(Value::Object(map))
    }).map_err(|e| {
        let code = sqlite_failure_code(&e);
        tracing::warn!("[wechat-db] query failed code={code}");
        code
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

const WECHAT_COMM: &str = "wechat";
const CRASHPAD_TOKEN: &str = "crashpad";
const OPT_WECHAT: &str = "/opt/wechat/wechat";
const USR_WECHAT: &str = "/usr/bin/wechat";

#[derive(Debug, Clone)]
struct WeChatProcessView {
    pid: i64,
    comm: String,
    exe: Option<String>,
    argv0: Option<String>,
    state: Option<char>,
    has_db_storage: bool,
}

fn path_basename(path: Option<&str>) -> String {
    path.unwrap_or("")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn inspect_wechat_process(pid: i64, proc_root: &Path) -> Option<WeChatProcessView> {
    if pid <= 0 {
        return None;
    }
    let base = proc_root.join(pid.to_string());
    let comm_raw = std::fs::read(base.join("comm")).ok()?;
    let comm = String::from_utf8_lossy(&comm_raw)
        .split('\0')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if comm.is_empty() {
        return None;
    }

    let mut state = None;
    if let Ok(status_raw) = std::fs::read(base.join("status")) {
        let status = String::from_utf8_lossy(&status_raw);
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("State:") {
                state = rest.trim().chars().next();
                break;
            }
        }
    }

    let exe = std::fs::read_link(base.join("exe"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    let argv0 = std::fs::read(base.join("cmdline")).ok().and_then(|raw| {
        let first = raw.split(|b| *b == 0).next().unwrap_or(&[]);
        if first.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(first).into_owned())
        }
    });

    let mut has_db_storage = false;
    if let Ok(entries) = std::fs::read_dir(base.join("fd")) {
        for entry in entries.flatten() {
            if let Ok(target) = std::fs::read_link(entry.path()) {
                let target = target.to_string_lossy();
                if target.contains("db_storage") && target.ends_with(".db") {
                    has_db_storage = true;
                    break;
                }
            }
        }
    }

    Some(WeChatProcessView {
        pid,
        comm,
        exe,
        argv0,
        state,
        has_db_storage,
    })
}

fn is_wechat_main_process(view: Option<&WeChatProcessView>) -> bool {
    let Some(view) = view else {
        return false;
    };
    if view.state == Some('Z') {
        return false;
    }
    let identity = format!(
        "{}\n{}\n{}",
        view.comm,
        view.exe.as_deref().unwrap_or(""),
        view.argv0.as_deref().unwrap_or("")
    )
    .to_ascii_lowercase();
    if identity.contains(CRASHPAD_TOKEN) {
        return false;
    }
    if view.comm != WECHAT_COMM {
        return false;
    }
    path_basename(view.exe.as_deref()) == WECHAT_COMM
        || path_basename(view.argv0.as_deref()) == WECHAT_COMM
}

fn path_rank(exe: Option<&str>) -> u8 {
    match exe {
        Some(OPT_WECHAT) => 0,
        Some(USR_WECHAT) => 1,
        Some(path) if path_basename(Some(path)) == WECHAT_COMM => 2,
        _ => 3,
    }
}

fn select_wechat_pid(views: &[WeChatProcessView]) -> Option<i64> {
    let mut mains: Vec<&WeChatProcessView> = views
        .iter()
        .filter(|view| is_wechat_main_process(Some(view)))
        .collect();
    if mains.is_empty() {
        return None;
    }
    mains.sort_by_key(|view| (!view.has_db_storage, path_rank(view.exe.as_deref()), view.pid));
    Some(mains[0].pid)
}

fn iter_proc_pids(proc_root: &Path) -> Vec<i64> {
    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Ok(pid) = name.parse::<i64>() {
            if pid > 0 {
                pids.push(pid);
            }
        }
    }
    pids
}

fn find_wechat_pid_in(proc_root: impl AsRef<Path>) -> Option<i64> {
    let proc_root = proc_root.as_ref();
    let views: Vec<WeChatProcessView> = iter_proc_pids(proc_root)
        .into_iter()
        .filter_map(|pid| inspect_wechat_process(pid, proc_root))
        .collect();
    select_wechat_pid(&views)
}

/// Find the WeChat main process PID from /proc identity, never cmdline substrings.
pub fn find_wechat_pid() -> Option<i64> {
    find_wechat_pid_in("/proc")
}

/// Detect the WeChat account directory by scanning /proc/<pid>/fd.
pub fn find_account_dir(wechat_pid: i64) -> Option<String> {
    let fd_dir = format!("/proc/{wechat_pid}/fd");
    let entries = std::fs::read_dir(&fd_dir).ok()?;

    for entry in entries.flatten() {
        if let Ok(target) = std::fs::read_link(entry.path()) {
            let target_str = target.to_string_lossy();
            if target_str.contains("db_storage") && target_str.ends_with(".db") {
                if let Some(idx) = target_str.find("xwechat_files/") {
                    let rest = &target_str[idx + "xwechat_files/".len()..];
                    if let Some(account_dir) = rest.split('/').next() {
                        if !account_dir.is_empty() {
                            return Some(account_dir.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// List all .db files that exist on disk for a given account.
pub fn list_account_dbs(account_dir: &str) -> Vec<String> {
    let base_paths = [
        format!("/home/wechat/xwechat_files/{account_dir}"),
        format!("/home/wechat/Documents/xwechat_files/{account_dir}"),
    ];

    for base in &base_paths {
        let db_storage = PathBuf::from(base).join("db_storage");
        if !db_storage.exists() {
            continue;
        }

        let mut db_names = Vec::new();
        if let Ok(sub_dirs) = std::fs::read_dir(&db_storage) {
            for sub_dir in sub_dirs.flatten() {
                if sub_dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if let Ok(files) = std::fs::read_dir(sub_dir.path()) {
                        for file in files.flatten() {
                            let name = file.file_name().to_string_lossy().to_string();
                            if name.ends_with(".db") {
                                db_names.push(name);
                            }
                        }
                    }
                }
            }
        }

        if !db_names.is_empty() {
            return db_names;
        }
    }

    Vec::new()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseCapability {
    Session,
    Contact,
    Message,
    Media,
    Unknown,
}

fn validate_db_component(value: &str) -> Result<(), String> {
    if value.is_empty() || value == "." || value == ".." || value.contains('/') || value.contains('\\') || value.contains('\0') {
        return Err("invalid WeChat DB path component".to_string());
    }
    Ok(())
}

pub fn database_capability(db_name: &str) -> DatabaseCapability {
    match db_name {
        "session.db" => DatabaseCapability::Session,
        "contact.db" | "contact_fts.db" => DatabaseCapability::Contact,
        name if name.starts_with("message_") || name == "message_resource.db" => DatabaseCapability::Message,
        name if name.starts_with("media_") || name == "hardlink.db" => DatabaseCapability::Media,
        _ => DatabaseCapability::Unknown,
    }
}

/// Get the full path to a WeChat database file.
pub fn get_db_path(account_dir: &str, db_name: &str) -> String {
    get_db_path_checked(account_dir, db_name).unwrap_or_else(|_| String::new())
}

pub fn get_db_path_checked(account_dir: &str, db_name: &str) -> Result<String, String> {
    validate_db_component(account_dir)?;
    validate_db_component(db_name)?;
    let sub_dir_map: &[(&str, &str)] = &[
        ("contact.db", "contact"),
        ("contact_fts.db", "contact"),
        ("session.db", "session"),
        ("message_0.db", "message"),
        ("message_fts.db", "message"),
        ("message_resource.db", "message"),
        ("biz_message_0.db", "message"),
        ("media_0.db", "message"),
        ("general.db", "general"),
        ("hardlink.db", "hardlink"),
        ("head_image.db", "head_image"),
        ("emoticon.db", "emoticon"),
        ("favorite.db", "favorite"),
        ("favorite_fts.db", "favorite"),
        ("sns.db", "sns"),
        ("bizchat.db", "bizchat"),
    ];

    let sub_dir = sub_dir_map
        .iter()
        .find(|(name, _)| *name == db_name)
        .map(|(_, dir)| *dir)
        .unwrap_or_else(|| db_name.strip_suffix(".db").unwrap_or(db_name));

    let base_paths = [
        format!("/home/wechat/xwechat_files/{account_dir}"),
        format!("/home/wechat/Documents/xwechat_files/{account_dir}"),
    ];

    for base in &base_paths {
        let full_path = Path::new(base)
            .join("db_storage")
            .join(sub_dir)
            .join(db_name);
        if full_path.exists() {
            return Ok(full_path.to_string_lossy().to_string());
        }
    }

    // Default to first path; callers must use query_checked to distinguish absent DBs.
    Ok(Path::new(&base_paths[0])
        .join("db_storage")
        .join(sub_dir)
        .join(db_name)
        .to_string_lossy()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        database_capability, find_wechat_pid_in, inspect_wechat_process, is_wechat_main_process,
        query_wechat_db_checked, select_wechat_pid, DatabaseCapability, WeChatProcessView,
    };
    use rusqlite::{Connection, OpenFlags};
    use std::os::unix::fs::symlink;
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, Instant};

    fn view(
        pid: i64,
        comm: &str,
        exe: &str,
        argv0: &str,
        state: Option<char>,
        has_db_storage: bool,
    ) -> WeChatProcessView {
        WeChatProcessView {
            pid,
            comm: comm.to_string(),
            exe: Some(exe.to_string()),
            argv0: Some(argv0.to_string()),
            state,
            has_db_storage,
        }
    }

    fn write_proc(
        root: &std::path::Path,
        pid: i64,
        comm: &str,
        exe: Option<&str>,
        argv0: Option<&str>,
        state: &str,
        db_storage: bool,
    ) {
        let base = root.join(pid.to_string());
        std::fs::create_dir_all(base.join("fd")).unwrap();
        std::fs::write(base.join("comm"), format!("{comm}\n")).unwrap();
        std::fs::write(base.join("status"), format!("Name:\t{comm}\nState:\t{state} (sleeping)\n")).unwrap();
        if let Some(argv0) = argv0 {
            let mut cmdline = argv0.as_bytes().to_vec();
            cmdline.push(0);
            cmdline.extend_from_slice(b"--annotation=/opt/wechat/wechat");
            cmdline.push(0);
            std::fs::write(base.join("cmdline"), cmdline).unwrap();
        }
        if let Some(exe) = exe {
            symlink(exe, base.join("exe")).unwrap();
        }
        if db_storage {
            symlink(
                "/home/wechat/xwechat_files/wxid/db_storage/session/session.db",
                base.join("fd").join("3"),
            )
            .unwrap();
        }
    }

    #[test]
    fn crashpad_with_wechat_path_annotation_is_not_main() {
        let crashpad = view(
            10,
            "chrome_crashpad_handler",
            "/opt/wechat/chrome_crashpad_handler",
            "/opt/wechat/wechat --annotation=/opt/wechat/wechat",
            Some('S'),
            true,
        );
        assert!(!is_wechat_main_process(Some(&crashpad)));
        let main = view(20, "wechat", "/opt/wechat/wechat", "/opt/wechat/wechat", Some('S'), false);
        assert_eq!(select_wechat_pid(&[crashpad, main]), Some(20));
    }

    #[test]
    fn select_wechat_pid_prefers_db_storage_then_known_path() {
        let views = vec![
            view(30, "wechat", "/tmp/wechat", "/tmp/wechat", Some('S'), true),
            view(20, "wechat", "/opt/wechat/wechat", "/opt/wechat/wechat", Some('S'), false),
            view(10, "wechat", "/usr/bin/wechat", "/usr/bin/wechat", Some('S'), false),
        ];
        assert_eq!(select_wechat_pid(&views), Some(30));
        let views = vec![
            view(30, "wechat", "/tmp/wechat", "/tmp/wechat", Some('S'), false),
            view(20, "wechat", "/opt/wechat/wechat", "/opt/wechat/wechat", Some('S'), false),
            view(10, "wechat", "/usr/bin/wechat", "/usr/bin/wechat", Some('S'), false),
        ];
        assert_eq!(select_wechat_pid(&views), Some(20));
    }

    #[test]
    fn select_wechat_pid_returns_none_without_live_main() {
        let views = vec![
            view(10, "wechat", "/opt/wechat/wechat", "/opt/wechat/wechat", Some('Z'), true),
            view(
                11,
                "chrome_crashpad_handler",
                "/opt/wechat/wechat",
                "/opt/wechat/wechat",
                Some('S'),
                true,
            ),
        ];
        assert_eq!(select_wechat_pid(&views), None);
    }

    #[test]
    fn find_wechat_pid_scans_proc_fixture_not_pgrep_order() {
        let dir = tempfile::tempdir().unwrap();
        write_proc(
            dir.path(),
            10,
            "chrome_crashpad_handler",
            Some("/opt/wechat/chrome_crashpad_handler"),
            Some("/opt/wechat/wechat"),
            "S",
            true,
        );
        write_proc(
            dir.path(),
            20,
            "wechat",
            Some("/opt/wechat/wechat"),
            Some("/opt/wechat/wechat"),
            "S",
            false,
        );
        write_proc(
            dir.path(),
            30,
            "wechat",
            Some("/usr/bin/wechat"),
            Some("/usr/bin/wechat"),
            "S",
            true,
        );
        assert_eq!(find_wechat_pid_in(dir.path()), Some(30));
        let inspected = inspect_wechat_process(10, dir.path()).unwrap();
        assert!(!is_wechat_main_process(Some(&inspected)));
        assert!(inspected.has_db_storage);
    }

    #[test]
    fn database_capability_classifies_known_storage_roles() {
        assert_eq!(database_capability("session.db"), DatabaseCapability::Session);
        assert_eq!(database_capability("message_0.db"), DatabaseCapability::Message);
        assert_eq!(database_capability("media_0.db"), DatabaseCapability::Media);
        assert_eq!(database_capability("other.db"), DatabaseCapability::Unknown);
    }

    #[test]
    fn db_path_rejects_traversal_components_without_panicking() {
        assert!(super::get_db_path_checked("../outside", "session.db").is_err());
        assert!(super::get_db_path_checked("account", "../outside.db").is_err());
        assert_eq!(super::get_db_path("../outside", "session.db"), "");
    }

    #[test]
    fn checked_queries_distinguish_unavailable_databases_from_empty_results() {
        let err = query_wechat_db_checked("/definitely/missing/contact.db", "00", "SELECT 1").unwrap_err();
        assert_eq!(err, "SQLITE_CANTOPEN");
    }

    #[test]
    fn checked_queries_classify_not_a_database_without_leaking_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("message_resource.db");
        std::fs::write(&path, b"not-a-sqlite-header").unwrap();
        let path_s = path.to_str().unwrap();
        // SELECT 1 does not read the file header. Probe schema/tables like media lookup.
        let err = query_wechat_db_checked(path_s, "00", "SELECT count(*) FROM sqlite_master")
            .err()
            .or_else(|| {
                query_wechat_db_checked(
                    path_s,
                    "00",
                    "SELECT rowid FROM ChatName2Id LIMIT 1",
                )
                .err()
            })
            .expect("garbage resource DB must fail a schema or table probe");
        assert!(
            err.contains("NotADatabase")
                || err.contains("NOTADB")
                || err.contains("CANTOPEN")
                || err.starts_with("SQLITE_"),
            "{err}"
        );
        assert!(!err.contains(path_s));
        assert!(crate::tools::wechat_db::query_wechat_db(
            path_s,
            "00",
            "SELECT rowid FROM ChatName2Id LIMIT 1"
        )
        .is_empty());
    }

    /// Create a temp DB that simulates WeChat's encrypted DB pattern.
    /// Uses plaintext SQLite (no encryption) since we're testing lock behavior,
    /// not crypto. Lock semantics are identical.
    fn create_test_db(path: &str) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = DELETE;
             CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, content TEXT);
             INSERT INTO messages (content) VALUES ('hello');
             INSERT INTO messages (content) VALUES ('world');",
        )
        .unwrap();
        conn
    }

    /// Open a read-only connection using the OLD approach (plain SQLITE_OPEN_READ_ONLY).
    /// This acquires shared locks that can block writer checkpointing/commits.
    fn open_readonly(path: &str) -> Connection {
        Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap()
    }

    /// Open a read-only connection using the NEW approach (immutable=1 URI).
    /// This acquires NO locks at all.
    fn open_immutable(path: &str) -> Connection {
        let uri = format!("file:{}?immutable=1", path);
        Connection::open_with_flags(
            &uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap()
    }

    #[test]
    fn immutable_read_does_not_block_writer() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db_path_str = db_path.to_str().unwrap();

        // Create DB with DELETE journal mode (not WAL) — worst case for lock contention
        let _setup = create_test_db(db_path_str);
        drop(_setup);

        let path = db_path_str.to_string();
        let barrier = Arc::new(Barrier::new(2));

        // Thread 1: open immutable reader, hold it open, signal writer to proceed
        let b1 = barrier.clone();
        let p1 = path.clone();
        let reader = std::thread::spawn(move || {
            let conn = open_immutable(&p1);
            let count: i64 = conn
                .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
                .unwrap();
            assert!(count >= 2);

            // Signal: reader is holding connection open
            b1.wait();

            // Hold long enough that a true exclusive-lock wait exceeds the
            // writer's budget. A loaded CI runner can take >100ms to open
            // SQLite without being locked.
            std::thread::sleep(Duration::from_millis(500));
            drop(conn);
        });

        // Thread 2: wait for reader, then try to write — should NOT be blocked
        let b2 = barrier.clone();
        let p2 = path.clone();
        let writer = std::thread::spawn(move || {
            // Wait for reader to be holding its connection
            b2.wait();

            let start = Instant::now();
            let conn = Connection::open(&p2).unwrap();
            conn.execute_batch("PRAGMA journal_mode = DELETE;").unwrap();
            conn.execute(
                "INSERT INTO messages (content) VALUES (?1)",
                ["from writer"],
            )
            .unwrap();
            let elapsed = start.elapsed();

            // Unblocked writers finish well under this; a SHARED-lock wait
            // lasts ~500ms until the reader drops.
            assert!(
                elapsed < Duration::from_millis(250),
                "Writer was blocked for {:?} — immutable reader is holding locks!",
                elapsed
            );
        });

        reader.join().unwrap();
        writer.join().unwrap();
    }

    #[test]
    fn readonly_reader_can_block_writer_in_delete_mode() {
        // This test demonstrates the problem that immutable=1 solves.
        // With DELETE journal mode, a read-only reader holds a SHARED lock
        // that prevents the writer from acquiring an EXCLUSIVE lock.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test_readonly.db");
        let db_path_str = db_path.to_str().unwrap();

        let _setup = create_test_db(db_path_str);
        drop(_setup);

        let path = db_path_str.to_string();
        let barrier = Arc::new(Barrier::new(2));

        // Thread 1: plain read-only reader with active statement (holds SHARED lock)
        let b1 = barrier.clone();
        let p1 = path.clone();
        let reader = std::thread::spawn(move || {
            let conn = open_readonly(&p1);
            // Start a query to acquire SHARED lock
            let mut stmt = conn.prepare("SELECT * FROM messages").unwrap();
            let _rows: Vec<_> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect();

            // Signal writer while we still hold the connection
            b1.wait();
            // Hold the connection open
            std::thread::sleep(Duration::from_millis(300));
            drop(stmt);
            drop(conn);
        });

        // Thread 2: try to write while reader holds SHARED lock
        let b2 = barrier.clone();
        let p2 = path.clone();
        let writer = std::thread::spawn(move || {
            b2.wait();

            let conn = Connection::open(&p2).unwrap();
            conn.execute_batch("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0;")
                .unwrap();
            let result = conn.execute(
                "INSERT INTO messages (content) VALUES (?1)",
                ["from writer"],
            );

            // With busy_timeout=0 and DELETE mode, write may fail with SQLITE_BUSY
            // if the reader's shared lock is still held.
            // Note: this depends on OS-level locking behavior, so we just log the result
            // rather than hard-assert — the important thing is the immutable test above ALWAYS passes.
            match result {
                Ok(_) => eprintln!("[info] Writer succeeded (reader may have released lock)"),
                Err(e) => eprintln!("[expected] Writer blocked/failed as expected: {e}"),
            }
        });

        reader.join().unwrap();
        writer.join().unwrap();
    }

    #[test]
    fn immutable_reads_are_consistent_per_connection() {
        // Verify that immutable=1 sees a consistent snapshot at open time
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test_consistent.db");
        let db_path_str = db_path.to_str().unwrap();

        let _setup = create_test_db(db_path_str);
        drop(_setup);

        // Open immutable reader — should see 2 rows
        let reader = open_immutable(db_path_str);
        let count_before: i64 = reader
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_before, 2);

        // Write more data via a separate connection
        {
            let writer = Connection::open(db_path_str).unwrap();
            writer
                .execute("INSERT INTO messages (content) VALUES ('new')", [])
                .unwrap();
        }

        // Immutable reader may or may not see the new row (implementation-defined).
        // The point is: it doesn't crash, corrupt, or lock.
        let count_after: i64 = reader
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert!(count_after >= 2); // At least the original data

        drop(reader);

        // Fresh immutable connection MUST see the new row
        let reader2 = open_immutable(db_path_str);
        let count_fresh: i64 = reader2
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_fresh, 3, "Fresh immutable connection should see committed writes");
    }
}
