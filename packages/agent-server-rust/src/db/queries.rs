use rusqlite::{params, Connection, OptionalExtension};

use crate::ia::types::SendResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboundIdempotencyState {
    Queued,
    Sending,
    Sent,
    Uncertain,
    Failed,
    Rejected,
    Expired,
    NeedsReconciliation,
}

impl OutboundIdempotencyState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Sending => "sending",
            Self::Sent => "sent",
            Self::Uncertain => "uncertain",
            Self::Failed => "failed",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
            Self::NeedsReconciliation => "needs_reconciliation",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        Some(match value {
            "queued" => Self::Queued,
            "sending" => Self::Sending,
            "sent" => Self::Sent,
            "uncertain" => Self::Uncertain,
            "failed" => Self::Failed,
            "rejected" => Self::Rejected,
            "expired" => Self::Expired,
            "needs_reconciliation" => Self::NeedsReconciliation,
            _ => return None,
        })
    }

    pub fn is_completed_execution(&self) -> bool {
        matches!(self, Self::Sent | Self::Uncertain | Self::Failed)
    }
}

#[derive(Debug, Clone)]
pub struct OutboundIdempotencyRecord {
    pub key: String,
    pub state: OutboundIdempotencyState,
    pub result: Option<SendResult>,
    pub expires_at: String,
    pub updated_at: String,
    pub generation: i64,
}

fn unix_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn datetime_after_ms(ttl_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(unix_ms().saturating_add(ttl_ms))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

fn sqlite_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn send_result_state(result: &SendResult) -> OutboundIdempotencyState {
    if result.success {
        OutboundIdempotencyState::Sent
    } else if result.commit_attempted {
        OutboundIdempotencyState::Uncertain
    } else {
        OutboundIdempotencyState::Failed
    }
}

fn sanitized_result(result: &SendResult) -> SendResult {
    let error_code = result.error_code.clone();
    let error = if result.success {
        None
    } else {
        Some(
            error_code
                .clone()
                .unwrap_or_else(|| "SEND_FAILED".to_string()),
        )
    };
    SendResult {
        success: result.success,
        error_code,
        error,
        commit_attempted: result.commit_attempted,
    }
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboundIdempotencyRecord> {
    let state_raw: String = row.get(1)?;
    let state =
        OutboundIdempotencyState::from_str(&state_raw).unwrap_or(OutboundIdempotencyState::Failed);
    let result_success: Option<i64> = row.get(2)?;
    let error_code: Option<String> = row.get(3)?;
    let error: Option<String> = row.get(4)?;
    let commit_attempted: i64 = row.get(5)?;
    let result = result_success.map(|success| SendResult {
        success: success != 0,
        error_code,
        error,
        commit_attempted: commit_attempted != 0,
    });
    Ok(OutboundIdempotencyRecord {
        key: row.get(0)?,
        state,
        result,
        expires_at: row.get(6)?,
        updated_at: row.get(7)?,
        generation: row.get(8).unwrap_or(0),
    })
}

pub fn get_outbound_idempotency(
    conn: &Connection,
    key: &str,
) -> rusqlite::Result<Option<OutboundIdempotencyRecord>> {
    conn.query_row(
        "SELECT key, state, result_success, error_code, error, commit_attempted, expires_at, updated_at, generation
         FROM outbound_idempotency WHERE key = ?1",
        params![key],
        record_from_row,
    )
    .optional()
}

pub fn count_outbound_idempotency(conn: &Connection) -> usize {
    conn.query_row("SELECT count(*) FROM outbound_idempotency", [], |row| {
        row.get::<_, i64>(0)
    })
    .unwrap_or(0)
    .max(0) as usize
}

pub fn insert_outbound_queued(
    conn: &Connection,
    key: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<Option<i64>> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    let changed = conn.execute(
        "INSERT INTO outbound_idempotency
            (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at, generation)
         VALUES (?1, 'queued', NULL, NULL, NULL, 0, ?2, ?3, ?3, NULL, 1)
         ON CONFLICT(key) DO NOTHING",
        params![key, expires_at, now],
    )?;
    Ok((changed > 0).then_some(1))
}

pub fn claim_reusable_outbound_queued(
    conn: &Connection,
    key: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<Option<i64>> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.query_row(
        "UPDATE outbound_idempotency
         SET state = 'queued',
             result_success = NULL,
             error_code = NULL,
             error = NULL,
             commit_attempted = 0,
             expires_at = ?2,
             updated_at = ?3,
             completed_at = NULL,
             generation = generation + 1
         WHERE key = ?1
           AND state IN ('rejected', 'expired')
         RETURNING generation",
        params![key, expires_at, now],
        |row| row.get(0),
    )
    .optional()
}

pub fn mark_outbound_sending(
    conn: &Connection,
    key: &str,
    generation: i64,
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE outbound_idempotency
         SET state = 'sending', updated_at = ?3
         WHERE key = ?1
           AND generation = ?2
           AND state = 'queued'",
        params![key, generation, sqlite_now()],
    )?;
    Ok(changed > 0)
}

pub fn complete_outbound_result(
    conn: &Connection,
    key: &str,
    generation: i64,
    result: &SendResult,
    ttl: std::time::Duration,
) -> rusqlite::Result<bool> {
    let sanitized = sanitized_result(result);
    let state = send_result_state(&sanitized);
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    let changed = conn.execute(
        "UPDATE outbound_idempotency
         SET state = ?3,
             result_success = ?4,
             error_code = ?5,
             error = ?6,
             commit_attempted = ?7,
             expires_at = ?8,
             updated_at = ?9,
             completed_at = ?9
         WHERE key = ?1
           AND generation = ?2
           AND state = 'sending'",
        params![
            key,
            generation,
            state.as_str(),
            if sanitized.success { 1 } else { 0 },
            sanitized.error_code,
            sanitized.error,
            if sanitized.commit_attempted { 1 } else { 0 },
            expires_at,
            now
        ],
    )?;
    Ok(changed > 0)
}

pub fn mark_outbound_needs_reconciliation(
    conn: &Connection,
    key: &str,
    generation: Option<i64>,
    error_code: &str,
    commit_attempted: bool,
    ttl: std::time::Duration,
) -> rusqlite::Result<usize> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.execute(
        "UPDATE outbound_idempotency
         SET state = 'needs_reconciliation',
             result_success = 0,
             error_code = ?2,
             error = ?2,
             commit_attempted = ?3,
             expires_at = ?4,
             updated_at = ?5,
             completed_at = ?5
         WHERE key = ?1
           AND (?6 IS NULL OR generation = ?6)
           AND state IN ('queued', 'sending', 'needs_reconciliation')",
        params![
            key,
            error_code,
            if commit_attempted { 1 } else { 0 },
            expires_at,
            now,
            generation
        ],
    )
}

pub fn reconcile_outbound_idempotency(
    conn: &Connection,
    key: &str,
    state: OutboundIdempotencyState,
    error_code: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<bool> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    let success = matches!(state, OutboundIdempotencyState::Sent);
    let changed = conn.execute(
        "UPDATE outbound_idempotency
         SET state = ?2,
             result_success = ?3,
             error_code = ?4,
             error = ?4,
             commit_attempted = 1,
             expires_at = ?5,
             updated_at = ?6,
             completed_at = ?6
         WHERE key = ?1
           AND state IN ('queued', 'sending', 'needs_reconciliation')",
        params![
            key,
            state.as_str(),
            if success { 1 } else { 0 },
            error_code,
            expires_at,
            now
        ],
    )?;
    Ok(changed > 0)
}

pub fn reject_outbound_pre_execution(
    conn: &Connection,
    key: &str,
    generation: Option<i64>,
    state: OutboundIdempotencyState,
    error_code: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<bool> {
    if let Some(generation) = generation {
        let now = sqlite_now();
        let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
        let changed = conn.execute(
            "UPDATE outbound_idempotency
             SET state = ?3,
                 result_success = 0,
                 error_code = ?4,
                 error = ?4,
                 commit_attempted = 0,
                 expires_at = ?5,
                 updated_at = ?6,
                 completed_at = ?6
             WHERE key = ?1
               AND generation = ?2
               AND state = 'queued'",
            params![key, generation, state.as_str(), error_code, expires_at, now],
        )?;
        return Ok(changed > 0);
    }
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    let changed = conn.execute(
        "INSERT INTO outbound_idempotency
            (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at, generation)
         VALUES (?1, ?2, 0, ?3, ?3, 0, ?4, ?5, ?5, ?5, 1)
         ON CONFLICT(key) DO UPDATE SET
            state = excluded.state,
            result_success = 0,
            error_code = excluded.error_code,
            error = excluded.error,
            commit_attempted = 0,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at,
            generation = outbound_idempotency.generation + 1
         WHERE outbound_idempotency.state NOT IN ('queued', 'sending', 'sent', 'uncertain', 'failed', 'needs_reconciliation')",
        params![key, state.as_str(), error_code, expires_at, now],
    )?;
    Ok(changed > 0)
}

pub fn reject_outbound_unless_active_or_completed(
    conn: &Connection,
    key: &str,
    state: OutboundIdempotencyState,
    error_code: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<()> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.execute(
        "INSERT INTO outbound_idempotency
            (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at)
         VALUES (?1, ?2, 0, ?3, ?3, 0, ?4, ?5, ?5, ?5)
         ON CONFLICT(key) DO UPDATE SET
            state = excluded.state,
            result_success = 0,
            error_code = excluded.error_code,
            error = excluded.error,
            commit_attempted = 0,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at
         WHERE outbound_idempotency.state NOT IN ('queued', 'sending', 'sent', 'uncertain', 'failed', 'needs_reconciliation')",
        params![key, state.as_str(), error_code, expires_at, now],
    )?;
    Ok(())
}

pub fn expire_outbound_if_stale(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE outbound_idempotency
         SET state = 'expired', result_success = 0, error_code = 'IDEMPOTENCY_EXPIRED',
             error = 'IDEMPOTENCY_EXPIRED', commit_attempted = 0, updated_at = ?2, completed_at = ?2
         WHERE key = ?1
           AND state IN ('sent', 'uncertain', 'failed', 'needs_reconciliation')
           AND julianday(expires_at) <= julianday(?2)",
        params![key, sqlite_now()],
    )?;
    Ok(changed > 0)
}

// ============================================
// SYNC STATE QUERIES
// ============================================

pub fn get_sync_state(conn: &Connection, key: &str, session_id: Option<&str>) -> Option<String> {
    let result = match session_id {
        Some(sid) => conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = ?1 AND session_id = ?2",
                params![key, sid],
                |row| row.get::<_, String>(0),
            )
            .ok(),
        None => conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = ?1 AND session_id IS NULL",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .ok(),
    };
    result
}

pub fn set_sync_state(conn: &Connection, key: &str, value: &str, session_id: Option<&str>) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO sync_state (session_id, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![session_id, key, value, now],
    )
    .ok();
}

// ============================================
// SESSION QUERIES
// ============================================

pub fn get_session_logged_in_user(conn: &Connection, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT logged_in_user FROM sessions WHERE id = ?1",
        params![session_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

pub fn update_session_logged_in_user(
    conn: &Connection,
    session_id: &str,
    logged_in_user: Option<&str>,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let login_state = if logged_in_user.is_some() {
        "logged_in"
    } else {
        "logged_out"
    };
    conn.execute(
        "UPDATE sessions SET logged_in_user = ?1, login_state = ?2, updated_at = ?3 WHERE id = ?4",
        params![logged_in_user, login_state, now, session_id],
    )
    .ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        },
        time::Duration,
    };

    fn open_test_conn(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS outbound_idempotency (
                key TEXT PRIMARY KEY,
                state TEXT NOT NULL CHECK (
                    state IN ('queued', 'sending', 'sent', 'uncertain', 'failed', 'rejected', 'expired', 'needs_reconciliation')
                ),
                result_success INTEGER,
                error_code TEXT,
                error TEXT,
                commit_attempted INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT,
                generation INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn independent_connections_atomically_insert_one_queued_claim() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("claim.db");
        open_test_conn(&path);
        let barrier = Arc::new(Barrier::new(2));
        let inserted = Arc::new(AtomicUsize::new(0));

        std::thread::scope(|scope| {
            for _ in 0..2 {
                let barrier = Arc::clone(&barrier);
                let inserted = Arc::clone(&inserted);
                let path = path.clone();
                scope.spawn(move || {
                    let conn = open_test_conn(&path);
                    assert!(get_outbound_idempotency(&conn, "same-key")
                        .unwrap()
                        .is_none());
                    barrier.wait();
                    if insert_outbound_queued(&conn, "same-key", Duration::from_secs(60))
                        .unwrap()
                        .is_some()
                    {
                        inserted.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });

        let conn = open_test_conn(&path);
        assert_eq!(inserted.load(Ordering::SeqCst), 1);
        assert_eq!(
            get_outbound_idempotency(&conn, "same-key")
                .unwrap()
                .unwrap()
                .state,
            OutboundIdempotencyState::Queued
        );
    }

    #[test]
    fn independent_connections_atomically_reclaim_reusable_key_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("reclaim.db");
        let conn = open_test_conn(&path);
        reject_outbound_pre_execution(
            &conn,
            "retry-key",
            None,
            OutboundIdempotencyState::Rejected,
            "QUEUE_FULL",
            Duration::from_secs(60),
        )
        .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let claimed = Arc::new(AtomicUsize::new(0));

        std::thread::scope(|scope| {
            for _ in 0..2 {
                let barrier = Arc::clone(&barrier);
                let claimed = Arc::clone(&claimed);
                let path = path.clone();
                scope.spawn(move || {
                    let conn = open_test_conn(&path);
                    barrier.wait();
                    if claim_reusable_outbound_queued(&conn, "retry-key", Duration::from_secs(60))
                        .unwrap()
                        .is_some()
                    {
                        claimed.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });

        assert_eq!(claimed.load(Ordering::SeqCst), 1);
        assert_eq!(
            get_outbound_idempotency(&conn, "retry-key")
                .unwrap()
                .unwrap()
                .state,
            OutboundIdempotencyState::Queued
        );
    }

    #[test]
    fn independent_connections_reconcile_blocks_stale_worker_transitions() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("reconcile-worker.db");
        let conn = open_test_conn(&path);
        let generation = insert_outbound_queued(&conn, "race-key", Duration::from_secs(60))
            .unwrap()
            .unwrap();
        let worker_conn = open_test_conn(&path);
        let ops_conn = open_test_conn(&path);

        assert!(reconcile_outbound_idempotency(
            &ops_conn,
            "race-key",
            OutboundIdempotencyState::Uncertain,
            "MANUAL_RECONCILIATION_REQUIRED",
            Duration::from_secs(60),
        )
        .unwrap());
        assert!(!mark_outbound_sending(&worker_conn, "race-key", generation).unwrap());
        assert!(!complete_outbound_result(
            &worker_conn,
            "race-key",
            generation,
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
        )
        .unwrap());
        assert_eq!(
            get_outbound_idempotency(&conn, "race-key")
                .unwrap()
                .unwrap()
                .state,
            OutboundIdempotencyState::Uncertain
        );
    }

    #[test]
    fn independent_connections_reject_cannot_overwrite_reclaim_or_sending() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("reject-reclaim.db");
        let conn = open_test_conn(&path);
        assert!(reject_outbound_pre_execution(
            &conn,
            "reject-race",
            None,
            OutboundIdempotencyState::Rejected,
            "QUEUE_FULL",
            Duration::from_secs(60),
        )
        .unwrap());
        let old_generation = get_outbound_idempotency(&conn, "reject-race")
            .unwrap()
            .unwrap()
            .generation;
        let reclaim_conn = open_test_conn(&path);
        let new_generation =
            claim_reusable_outbound_queued(&reclaim_conn, "reject-race", Duration::from_secs(60))
                .unwrap()
                .unwrap();

        let stale_reject_conn = open_test_conn(&path);
        assert!(!reject_outbound_pre_execution(
            &stale_reject_conn,
            "reject-race",
            Some(old_generation),
            OutboundIdempotencyState::Rejected,
            "STALE_REJECT",
            Duration::from_secs(60),
        )
        .unwrap());
        assert_eq!(
            get_outbound_idempotency(&conn, "reject-race")
                .unwrap()
                .unwrap()
                .state,
            OutboundIdempotencyState::Queued
        );

        assert!(mark_outbound_sending(&reclaim_conn, "reject-race", new_generation).unwrap());
        assert!(!reject_outbound_pre_execution(
            &stale_reject_conn,
            "reject-race",
            Some(new_generation),
            OutboundIdempotencyState::Rejected,
            "LATE_REJECT",
            Duration::from_secs(60),
        )
        .unwrap());
        assert_eq!(
            get_outbound_idempotency(&conn, "reject-race")
                .unwrap()
                .unwrap()
                .state,
            OutboundIdempotencyState::Sending
        );
    }

    #[test]
    fn independent_connection_claim_waits_for_held_writer() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("busy.db");
        let writer = open_test_conn(&path);
        writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let thread_path = path.clone();
        let handle = std::thread::spawn(move || {
            let conn = open_test_conn(&thread_path);
            insert_outbound_queued(&conn, "busy-key", Duration::from_secs(60)).unwrap()
        });
        std::thread::sleep(Duration::from_millis(50));
        writer.execute_batch("COMMIT;").unwrap();
        assert_eq!(handle.join().unwrap(), Some(1));
        assert_eq!(
            get_outbound_idempotency(&writer, "busy-key")
                .unwrap()
                .unwrap()
                .state,
            OutboundIdempotencyState::Queued
        );
    }
}

pub fn clear_session_data(conn: &Connection, session_id: &str) {
    conn.execute(
        "DELETE FROM wechat_keys WHERE session_id = ?1",
        params![session_id],
    )
    .ok();
    conn.execute(
        "DELETE FROM sync_state WHERE session_id = ?1",
        params![session_id],
    )
    .ok();
}
