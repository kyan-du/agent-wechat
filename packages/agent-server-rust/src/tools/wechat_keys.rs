use super::exec::{exec_command, ExecOptions};
use super::wechat_db::{get_db_path, list_account_dbs};
use rusqlite::{params, Connection, OpenFlags};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;
use tokio::sync::Mutex;

pub const PASSPHRASE_PATH: &str = "/tmp/wechat-passphrase.bin";
pub const PASSPHRASE_READY_PATH: &str = "/tmp/wechat-passphrase.bin.ready";
const PASSPHRASE_CAPTURE_TIMEOUT_MS: u64 = 1_800_000;
const PASSPHRASE_HOOK_WAIT_MS: u64 = 8_000;

static CAPTURE_PID: AtomicI64 = AtomicI64::new(0);
static CAPTURE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn capture_lock() -> &'static Mutex<()> {
    CAPTURE_LOCK.get_or_init(|| Mutex::new(()))
}

/// Attach Frida passphrase hooks before QR / saved-account login applies the key.
/// Capture must happen during login; heap scans after Chat is shown are too late.
pub async fn ensure_passphrase_capture(wechat_pid: i64) {
    if wechat_pid <= 0 {
        return;
    }
    if passphrase_file_ready() {
        return;
    }
    let spawned = {
        let _guard = capture_lock().lock().await;
        if passphrase_file_ready() {
            return;
        }
        let previous = CAPTURE_PID.load(Ordering::SeqCst);
        if previous == wechat_pid {
            false
        } else {
            CAPTURE_PID.store(wechat_pid, Ordering::SeqCst);
            let _ = std::fs::remove_file(PASSPHRASE_READY_PATH);
            tracing::info!("[wechat-keys] starting login passphrase capture pid={wechat_pid}");
            tokio::spawn(async move {
                let result = exec_command(
                    "env",
                    &[
                        "HOME=/home/wechat",
                        "python3",
                        "/opt/tools/capture-passphrase.py",
                        "--pid",
                        &wechat_pid.to_string(),
                        "--output",
                        PASSPHRASE_PATH,
                    ],
                    &ExecOptions {
                        timeout_ms: PASSPHRASE_CAPTURE_TIMEOUT_MS,
                        ..Default::default()
                    },
                )
                .await;
                if passphrase_file_ready() {
                    tracing::info!("[wechat-keys] login passphrase captured pid={wechat_pid}");
                } else {
                    tracing::warn!(
                        "[wechat-keys] login passphrase capture unfinished pid={wechat_pid} code={}",
                        result.exit_code
                    );
                    CAPTURE_PID
                        .compare_exchange(wechat_pid, 0, Ordering::SeqCst, Ordering::SeqCst)
                        .ok();
                }
            });
            true
        }
    };
    if !spawned || passphrase_file_ready() || passphrase_hooks_ready() {
        return;
    }
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(PASSPHRASE_HOOK_WAIT_MS);
    while tokio::time::Instant::now() < deadline {
        if passphrase_file_ready() || passphrase_hooks_ready() {
            return;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    tracing::warn!("[wechat-keys] passphrase hooks not ready within {PASSPHRASE_HOOK_WAIT_MS}ms pid={wechat_pid}");
}

pub fn passphrase_file_ready() -> bool {
    passphrase_path_ready(PASSPHRASE_PATH)
}

fn passphrase_path_ready(path: &str) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    meta.len() == 32 && meta.permissions().mode() & 0o077 == 0
}

pub fn passphrase_hooks_ready() -> bool {
    std::fs::metadata(PASSPHRASE_READY_PATH).is_ok()
}

/// Drop a captured passphrase after logout, auth reset, or WeChat restart.
/// Do not call this after a new account is already detected; the file belongs
/// to the login that just completed.
pub fn clear_passphrase_capture() {
    CAPTURE_PID.store(0, Ordering::SeqCst);
    let _ = std::fs::remove_file(PASSPHRASE_PATH);
    let _ = std::fs::remove_file(PASSPHRASE_READY_PATH);
}

/// Extract all WeChat DB credentials (async, non-blocking).
/// Calls the Python extract-keys script.
pub async fn extract_keys_async(wechat_pid: i64) -> HashMap<String, String> {
    let out_path = format!("/tmp/wechat_keys_{wechat_pid}.json");

    let mut args = vec![
        "HOME=/home/wechat".to_string(),
        "python3".to_string(),
        "/opt/tools/extract-keys.py".to_string(),
        "--pid".to_string(),
        wechat_pid.to_string(),
        "--output".to_string(),
        out_path.clone(),
    ];
    if passphrase_file_ready() {
        args.push("--passphrase-file".to_string());
        args.push(PASSPHRASE_PATH.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let _ = exec_command(
        "env",
        &arg_refs,
        &ExecOptions {
            timeout_ms: 120_000,
            ..Default::default()
        },
    )
    .await;

    let result = (|| -> Option<HashMap<String, String>> {
        let content = std::fs::read_to_string(&out_path).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
        let keys = parsed.get("keys")?.as_object()?;
        let map: HashMap<String, String> = keys
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
            .collect();

        let db_keys: Vec<_> = map.keys().filter(|k| !k.starts_with('_')).collect();
        let has_image_aes = map.contains_key("_image_aes");
        tracing::info!(
            "[wechat-keys] Extracted {} DB keys, image key: {}",
            db_keys.len(),
            if has_image_aes { "yes" } else { "no" }
        );
        Some(map)
    })();

    // Clean up temp file
    let _ = std::fs::remove_file(&out_path);

    result.unwrap_or_default()
}

/// Get stored keys for a session + account from the agent DB.
pub fn get_stored_keys(
    conn: &Connection,
    session_id: &str,
    account_dir: &str,
) -> HashMap<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT db_name, hex_key FROM wechat_keys
             WHERE session_id = ?1 AND account_dir = ?2",
        )
        .unwrap();

    let rows = stmt
        .query_map(params![session_id, account_dir], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .unwrap();

    let mut map = HashMap::new();
    for row in rows.flatten() {
        map.insert(row.0, row.1);
    }
    map
}

/// Store extracted keys in the agent DB.
pub fn store_keys(
    conn: &Connection,
    session_id: &str,
    account_dir: &str,
    keys: &HashMap<String, String>,
) {
    let now = chrono::Utc::now().to_rfc3339();
    for (db_name, hex_key) in keys {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO wechat_keys (id, session_id, account_dir, db_name, hex_key, verified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id, account_dir, db_name) DO UPDATE SET
               hex_key = excluded.hex_key,
               verified_at = excluded.verified_at",
            params![id, session_id, account_dir, db_name, hex_key, now],
        )
        .ok();
    }
}

/// Store a single key.
pub fn store_single_key(
    conn: &Connection,
    session_id: &str,
    account_dir: &str,
    db_name: &str,
    hex_key: &str,
) {
    let mut keys = HashMap::new();
    keys.insert(db_name.to_string(), hex_key.to_string());
    store_keys(conn, session_id, account_dir, &keys);
}

/// Verify a single key against a database file.
/// Opens with immutable=1 to avoid acquiring any locks that could interfere
/// with WeChat's own writes/checkpoints.
pub fn verify_key(db_path: &str, hex_key: &str) -> bool {
    let uri = format!("file:{}?immutable=1", db_path);
    let conn = match Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return false,
    };

    if conn
        .execute_batch(&format!(
            "PRAGMA key = \"x'{hex_key}'\"; PRAGMA cipher_compatibility = 4;"
        ))
        .is_err()
    {
        return false;
    }

    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .is_ok()
}

const REQUIRED_EXACT_DBS: &[&str] = &[
    "session.db",
    "contact.db",
    "emoticon.db",
    "head_image.db",
    "hardlink.db",
];
const REQUIRED_SHARD_PREFIXES: &[&str] = &["message_", "media_"];

fn is_required_shard(name: &str) -> bool {
    // message_fts.db is unused search storage. message_resource.db is SQLCipher
    // media metadata and must be keyed when the file is on disk.
    if name == "message_fts.db" {
        return false;
    }
    REQUIRED_SHARD_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

/// Check if credential setup is needed.
///
/// 1. Check that all required DB keys exist in stored_keys
/// 2. Scan disk for additional required DBs (message_N, media_N) without keys
/// 3. Spot-check one key for validity
/// 4. Re-extract when stored DB keys exist but `_image_aes` is missing
pub fn needs_key_extraction(
    conn: &Connection,
    session_id: &str,
    account_dir: &str,
) -> bool {
    let stored_keys = get_stored_keys(conn, session_id, account_dir);
    let existing_dbs = list_account_dbs(account_dir);
    tracing::debug!(
        "[wechat-keys] Disk scan: {} files for account {}",
        existing_dbs.len(),
        account_dir
    );
    needs_key_extraction_for(&stored_keys, &existing_dbs, |check_db, check_key| {
        verify_key(&get_db_path(account_dir, check_db), check_key)
    })
}

fn needs_key_extraction_for(
    stored_keys: &HashMap<String, String>,
    existing_dbs: &[String],
    verify: impl Fn(&str, &str) -> bool,
) -> bool {
    if stored_keys.is_empty() {
        tracing::info!("[wechat-keys] No stored keys, extraction needed");
        return true;
    }

    // Check required exact keys are present (regardless of disk scan)
    let missing_required: Vec<&str> = REQUIRED_EXACT_DBS
        .iter()
        .filter(|name| !stored_keys.contains_key(**name))
        .copied()
        .collect();

    if !missing_required.is_empty() {
        tracing::info!(
            "[wechat-keys] Missing required keys: {}",
            missing_required.join(", ")
        );
        return true;
    }

    // Scan disk for sharded DBs (message_N.db, media_N.db) and
    // message_resource.db missing keys. A missing resource file does not retry.
    let missing_on_disk: Vec<_> = existing_dbs
        .iter()
        .filter(|name| {
            is_required_shard(name) && !stored_keys.contains_key(name.as_str())
        })
        .collect();

    if !missing_on_disk.is_empty() {
        tracing::info!(
            "[wechat-keys] Missing keys for on-disk DBs: {}",
            missing_on_disk.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        );
        return true;
    }

    // Spot-check session.db and, when present, message_resource.db.
    // Media lookup treats a failed resource open as an empty result; a stale
    // stored key must re-extract instead of looking like a cache miss.
    let mut check_dbs = vec!["session.db"];
    if existing_dbs.iter().any(|name| name == "message_resource.db")
        && stored_keys.contains_key("message_resource.db")
    {
        check_dbs.push("message_resource.db");
    }
    for check_db in check_dbs {
        if let Some(check_key) = stored_keys.get(check_db) {
            if !verify(check_db, check_key) {
                tracing::info!("[wechat-keys] Spot-check failed for {check_db}, re-extraction needed");
                return true;
            }
        }
    }

    if !stored_keys.contains_key("_image_aes") {
        tracing::info!(
            "[wechat-keys] Stored DB keys present but _image_aes missing, re-extraction needed"
        );
        return true;
    }

    let db_key_count = stored_keys.keys().filter(|k| !k.starts_with('_')).count();
    tracing::info!(
        "[wechat-keys] {db_key_count} DB keys stored, spot-check passed, image_aes=true"
    );
    false
}

/// Get stored image keys.
pub fn get_image_keys(
    conn: &Connection,
    session_id: &str,
    account_dir: &str,
) -> Option<(String, Option<u8>)> {
    let keys = get_stored_keys(conn, session_id, account_dir);
    let aes_hex = keys.get("_image_aes")?;
    let xor_byte = keys
        .get("_image_xor")
        .and_then(|h| u8::from_str_radix(h, 16).ok());
    Some((aes_hex.clone(), xor_byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn required_db_keys() -> HashMap<String, String> {
        let mut keys = HashMap::new();
        for name in REQUIRED_EXACT_DBS {
            keys.insert((*name).to_string(), "00".to_string());
        }
        keys
    }

    #[test]
    fn needs_extraction_when_db_keys_exist_without_image_aes() {
        let stored = required_db_keys();
        assert!(needs_key_extraction_for(&stored, &[], |_, _| true));
    }

    #[test]
    fn skips_extraction_when_image_aes_and_required_keys_pass_spot_check() {
        let mut stored = required_db_keys();
        stored.insert("_image_aes".to_string(), "00".to_string());
        assert!(!needs_key_extraction_for(&stored, &[], |_, _| true));
    }

    #[test]
    fn message_resource_on_disk_requires_working_key_fts_does_not() {
        let mut stored = required_db_keys();
        stored.insert("_image_aes".to_string(), "00".to_string());
        stored.insert("message_0.db".to_string(), "00".to_string());

        // No resource file: do not retry.
        assert!(!needs_key_extraction_for(
            &stored,
            &["message_0.db".to_string()],
            |_, _| true,
        ));

        // File present without a stored key: extract.
        assert!(needs_key_extraction_for(
            &stored,
            &["message_0.db".to_string(), "message_resource.db".to_string()],
            |_, _| true,
        ));

        stored.insert("message_resource.db".to_string(), "00".to_string());
        assert!(!needs_key_extraction_for(
            &stored,
            &["message_0.db".to_string(), "message_resource.db".to_string()],
            |_, _| true,
        ));

        // Stale stored resource key must re-extract.
        assert!(needs_key_extraction_for(
            &stored,
            &["message_0.db".to_string(), "message_resource.db".to_string()],
            |db, _| db != "message_resource.db",
        ));

        stored.remove("message_resource.db");
        assert!(!needs_key_extraction_for(
            &stored,
            &["message_0.db".to_string(), "message_fts.db".to_string()],
            |_, _| true,
        ));
        assert!(needs_key_extraction_for(
            &stored,
            &["message_1.db".to_string()],
            |_, _| true,
        ));
    }

    #[test]
    fn rust_verify_pragma_matches_python_compat4_probe() {
        let python_probe = include_str!("../../../../docker/tools/extract-keys.py");
        assert!(python_probe.contains(
            "PRAGMA key = \"x\\'{key}\\'\"; PRAGMA cipher_compatibility = 4; SELECT count(*) FROM sqlite_master;"
        ));
        let rust_src = include_str!("wechat_keys.rs");
        let db_src = include_str!("wechat_db.rs");
        assert!(rust_src.contains("PRAGMA cipher_compatibility = 4;"));
        assert!(db_src.contains("PRAGMA cipher_compatibility = 4;"));
        let forbidden_compat = format!("cipher_compatibility = {}", 3);
        assert!(!python_probe.contains(&forbidden_compat));
        assert!(!rust_src.contains(&forbidden_compat));
        assert!(!db_src.contains(&forbidden_compat));
    }

    #[test]
    fn passphrase_file_ready_requires_mode_0600_and_32_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wechat-passphrase.bin");
        let path_s = path.to_str().unwrap();
        assert!(!passphrase_path_ready(path_s));
        std::fs::write(&path, [0u8; 31]).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms.clone()).unwrap();
        assert!(!passphrase_path_ready(path_s));
        std::fs::write(&path, [0u8; 32]).unwrap();
        std::fs::set_permissions(&path, perms).unwrap();
        assert!(passphrase_path_ready(path_s));
        let mut world = std::fs::metadata(&path).unwrap().permissions();
        world.set_mode(0o644);
        std::fs::set_permissions(&path, world).unwrap();
        assert!(!passphrase_path_ready(path_s));
    }

    #[test]
    fn verify_key_opens_sqlcipher4_database_created_by_rusqlite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("contact.db");
        let path_s = path.to_str().unwrap();
        let hex_key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "PRAGMA key = \"x'{hex_key}'\"; PRAGMA cipher_compatibility = 4;"
            ))
            .unwrap();
            conn.execute_batch(
                "CREATE TABLE probe (id INTEGER PRIMARY KEY); INSERT INTO probe VALUES (1);",
            )
            .unwrap();
        }
        assert!(verify_key(path_s, hex_key));
        let wrong_key = "00".repeat(32);
        assert!(!verify_key(path_s, &wrong_key));
        let rows = crate::tools::wechat_db::query_wechat_db_checked(
            path_s,
            hex_key,
            "SELECT count(*) AS n FROM sqlite_master",
        )
        .expect("compat4 query must succeed");
        assert!(!rows.is_empty());
    }

    #[test]
    fn store_keys_persists_underscore_image_aes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE wechat_keys (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                account_dir TEXT NOT NULL,
                db_name TEXT NOT NULL,
                hex_key TEXT NOT NULL,
                verified_at TEXT,
                UNIQUE(session_id, account_dir, db_name)
            );",
        )
        .unwrap();

        let mut keys = HashMap::new();
        keys.insert("session.db".to_string(), "00".to_string());
        keys.insert("_image_aes".to_string(), "aa".to_string());
        store_keys(&conn, "sess", "acct", &keys);

        let stored = get_stored_keys(&conn, "sess", "acct");
        assert_eq!(stored.get("_image_aes").map(String::as_str), Some("aa"));
        assert_eq!(stored.get("session.db").map(String::as_str), Some("00"));
    }
}
