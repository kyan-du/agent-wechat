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

pub fn count_protected_outbound_idempotency(conn: &Connection) -> usize {
    conn.query_row(
        "SELECT count(*) FROM outbound_idempotency
         WHERE state IN ('queued', 'sending', 'uncertain', 'needs_reconciliation')",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
    .max(0) as usize
}

pub fn count_outbound_generation_clock(conn: &Connection) -> usize {
    conn.query_row(
        "SELECT count(*) FROM outbound_idempotency_clock",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
    .max(0) as usize
}

pub fn allocate_outbound_generation(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "UPDATE outbound_idempotency_clock
         SET next_generation = next_generation + 1
         WHERE id = 1
         RETURNING next_generation - 1",
        [],
        |row| row.get(0),
    )
}

#[derive(Debug)]
pub enum OutboundAdmit {
    Inserted(i64),
    InProgress,
    NeedsReconciliation,
    Completed(SendResult),
    Capacity,
}

pub fn admit_outbound_claim(
    conn: &Connection,
    key: &str,
    ttl: std::time::Duration,
    max_rows: usize,
) -> rusqlite::Result<OutboundAdmit> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = admit_outbound_claim_locked(conn, key, ttl, max_rows);
    match &outcome {
        Ok(_) => conn.execute_batch("COMMIT")?,
        Err(_) => {
            let _ = conn.execute_batch("ROLLBACK");
        }
    }
    outcome
}

fn admit_outbound_claim_locked(
    conn: &Connection,
    key: &str,
    ttl: std::time::Duration,
    max_rows: usize,
) -> rusqlite::Result<OutboundAdmit> {
    expire_outbound_if_stale(conn, key)?;
    if let Some(record) = get_outbound_idempotency(conn, key)? {
        if record.state.is_completed_execution() {
            return Ok(OutboundAdmit::Completed(record.result.unwrap_or(
                SendResult {
                    success: false,
                    error_code: Some("REPLAY_UNAVAILABLE".to_string()),
                    error: Some("REPLAY_UNAVAILABLE".to_string()),
                    commit_attempted: false,
                },
            )));
        }
        if matches!(
            record.state,
            OutboundIdempotencyState::Queued | OutboundIdempotencyState::Sending
        ) {
            return Ok(OutboundAdmit::InProgress);
        }
        if record.state == OutboundIdempotencyState::NeedsReconciliation {
            return Ok(OutboundAdmit::NeedsReconciliation);
        }
    }
    if count_protected_outbound_idempotency(conn) >= max_rows {
        return Ok(OutboundAdmit::Capacity);
    }
    if let Some(generation) = insert_outbound_queued(conn, key, ttl)? {
        return Ok(OutboundAdmit::Inserted(generation));
    }
    if let Some(generation) = claim_reusable_outbound_queued(conn, key, ttl)? {
        return Ok(OutboundAdmit::Inserted(generation));
    }
    Ok(OutboundAdmit::InProgress)
}

pub fn insert_outbound_queued(
    conn: &Connection,
    key: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<Option<i64>> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    let generation = allocate_outbound_generation(conn)?;
    let changed = conn.execute(
        "INSERT INTO outbound_idempotency
            (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at, generation)
         VALUES (?1, 'queued', NULL, NULL, NULL, 0, ?2, ?3, ?3, NULL, ?4)
         ON CONFLICT(key) DO NOTHING",
        params![key, expires_at, now, generation],
    )?;
    Ok((changed > 0).then_some(generation))
}

pub fn claim_reusable_outbound_queued(
    conn: &Connection,
    key: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<Option<i64>> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    let generation = allocate_outbound_generation(conn)?;
    let changed = conn.execute(
        "UPDATE outbound_idempotency
         SET state = 'queued',
             result_success = NULL,
             error_code = NULL,
             error = NULL,
             commit_attempted = 0,
             expires_at = ?2,
             updated_at = ?3,
             completed_at = NULL,
             generation = ?4
         WHERE key = ?1
           AND state IN ('rejected', 'expired')",
        params![key, expires_at, now, generation],
    )?;
    Ok((changed > 0).then_some(generation))
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

pub fn mark_outbound_queued_needs_reconciliation(
    conn: &Connection,
    key: &str,
    generation: i64,
    error_code: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<usize> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.execute(
        "UPDATE outbound_idempotency
         SET state = 'needs_reconciliation',
             result_success = 0,
             error_code = ?3,
             error = ?3,
             commit_attempted = 0,
             expires_at = ?4,
             updated_at = ?5,
             completed_at = ?5
         WHERE key = ?1
           AND generation = ?2
           AND state = 'queued'",
        params![key, generation, error_code, expires_at, now],
    )
}

pub fn mark_outbound_sending_needs_reconciliation(
    conn: &Connection,
    key: &str,
    generation: i64,
    error_code: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<usize> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.execute(
        "UPDATE outbound_idempotency
         SET state = 'needs_reconciliation',
             result_success = 0,
             error_code = ?3,
             error = ?3,
             commit_attempted = 1,
             expires_at = ?4,
             updated_at = ?5,
             completed_at = ?5
         WHERE key = ?1
           AND generation = ?2
           AND state = 'sending'",
        params![key, generation, error_code, expires_at, now],
    )
}

/// Delete terminal rows that are past their replay window, then evict the
/// oldest expired/rejected (and past-TTL sent/failed) rows down to `max_rows`.
/// Never deletes queued, sending, uncertain, or needs_reconciliation evidence.
pub fn sweep_outbound_idempotency(conn: &Connection, max_rows: usize) -> rusqlite::Result<usize> {
    let now = sqlite_now();
    let mut deleted = conn.execute(
        "DELETE FROM outbound_idempotency
         WHERE state IN ('expired', 'rejected')
           AND julianday(expires_at) <= julianday(?1)",
        params![now],
    )?;
    conn.execute(
        "UPDATE outbound_idempotency
         SET state = 'expired',
             result_success = 0,
             error_code = 'IDEMPOTENCY_EXPIRED',
             error = 'IDEMPOTENCY_EXPIRED',
             commit_attempted = 0,
             updated_at = ?1,
             completed_at = ?1
         WHERE state IN ('sent', 'failed')
           AND julianday(expires_at) <= julianday(?1)",
        params![now],
    )?;
    deleted += conn.execute(
        "DELETE FROM outbound_idempotency
         WHERE state = 'expired'
           AND julianday(expires_at) <= julianday(?1)",
        params![now],
    )?;

    let count = count_outbound_idempotency(conn);
    if count > max_rows {
        let excess = (count - max_rows) as i64;
        deleted += conn.execute(
            "DELETE FROM outbound_idempotency
             WHERE key IN (
                SELECT key FROM outbound_idempotency
                WHERE state IN ('expired', 'rejected')
                ORDER BY updated_at ASC
                LIMIT ?1
             )",
            params![excess],
        )?;
    }
    let count = count_outbound_idempotency(conn);
    if count > max_rows {
        let excess = (count - max_rows) as i64;
        deleted += conn.execute(
            "DELETE FROM outbound_idempotency
             WHERE key IN (
                SELECT key FROM outbound_idempotency
                WHERE state IN ('sent', 'failed')
                  AND julianday(expires_at) <= julianday(?2)
                ORDER BY updated_at ASC
                LIMIT ?1
             )",
            params![excess, now],
        )?;
    }
    Ok(deleted)
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
    let generation = allocate_outbound_generation(conn)?;
    let changed = conn.execute(
        "INSERT INTO outbound_idempotency
            (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at, generation)
         VALUES (?1, ?2, 0, ?3, ?3, 0, ?4, ?5, ?5, ?5, ?6)
         ON CONFLICT(key) DO UPDATE SET
            state = excluded.state,
            result_success = 0,
            error_code = excluded.error_code,
            error = excluded.error,
            commit_attempted = 0,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at,
            generation = excluded.generation
         WHERE outbound_idempotency.state NOT IN ('queued', 'sending', 'sent', 'uncertain', 'failed', 'needs_reconciliation')",
        params![key, state.as_str(), error_code, expires_at, now, generation],
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
    let generation = allocate_outbound_generation(conn)?;
    conn.execute(
        "INSERT INTO outbound_idempotency
            (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at, generation)
         VALUES (?1, ?2, 0, ?3, ?3, 0, ?4, ?5, ?5, ?5, ?6)
         ON CONFLICT(key) DO UPDATE SET
            state = excluded.state,
            result_success = 0,
            error_code = excluded.error_code,
            error = excluded.error,
            commit_attempted = 0,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at,
            generation = excluded.generation
         WHERE outbound_idempotency.state NOT IN ('queued', 'sending', 'sent', 'uncertain', 'failed', 'needs_reconciliation')",
        params![key, state.as_str(), error_code, expires_at, now, generation],
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
             );
             CREATE TABLE IF NOT EXISTS outbound_idempotency_clock (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                next_generation INTEGER NOT NULL
             );
             INSERT OR IGNORE INTO outbound_idempotency_clock (id, next_generation)
             VALUES (1, 1);",
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

    fn insert_state(conn: &Connection, key: &str, state: &str, expires_at: &str) {
        conn.execute(
            "INSERT INTO outbound_idempotency
                (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at, generation)
             VALUES (?1, ?2, 0, 'X', 'X', 0, ?3, ?3, ?3, ?3, 1)",
            params![key, state, expires_at],
        )
        .unwrap();
    }

    #[test]
    fn sending_reconciliation_cas_only_matches_sending_generation() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("sending-recon.db");
        let conn = open_test_conn(&path);
        let generation = insert_outbound_queued(&conn, "send-lease", Duration::from_secs(60))
            .unwrap()
            .unwrap();
        assert_eq!(
            mark_outbound_sending_needs_reconciliation(
                &conn,
                "send-lease",
                generation,
                "IDEMPOTENCY_SENDING_DROPPED",
                Duration::from_secs(60),
            )
            .unwrap(),
            0
        );
        assert!(mark_outbound_sending(&conn, "send-lease", generation).unwrap());
        assert_eq!(
            mark_outbound_sending_needs_reconciliation(
                &conn,
                "send-lease",
                generation + 1,
                "IDEMPOTENCY_SENDING_DROPPED",
                Duration::from_secs(60),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            get_outbound_idempotency(&conn, "send-lease")
                .unwrap()
                .unwrap()
                .state,
            OutboundIdempotencyState::Sending
        );
        assert_eq!(
            mark_outbound_sending_needs_reconciliation(
                &conn,
                "send-lease",
                generation,
                "IDEMPOTENCY_SENDING_DROPPED",
                Duration::from_secs(60),
            )
            .unwrap(),
            1
        );
        let record = get_outbound_idempotency(&conn, "send-lease")
            .unwrap()
            .unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        assert_eq!(record.result.as_ref().unwrap().commit_attempted, true);
    }

    #[test]
    fn sweep_deletes_past_ttl_expired_and_rejected_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("sweep.db");
        let conn = open_test_conn(&path);
        let past = "1970-01-01T00:00:00+00:00";
        let future = datetime_after_ms(60_000);
        insert_state(&conn, "old-expired", "expired", past);
        insert_state(&conn, "old-rejected", "rejected", past);
        insert_state(&conn, "fresh-rejected", "rejected", &future);
        insert_state(&conn, "old-sent", "sent", past);
        insert_state(&conn, "old-failed", "failed", past);
        insert_state(&conn, "live-queued", "queued", past);
        insert_state(&conn, "live-sending", "sending", past);
        insert_state(&conn, "live-uncertain", "uncertain", past);
        insert_state(&conn, "live-recon", "needs_reconciliation", past);

        let deleted = sweep_outbound_idempotency(&conn, 10_000).unwrap();
        assert!(deleted >= 4);
        assert!(get_outbound_idempotency(&conn, "old-expired")
            .unwrap()
            .is_none());
        assert!(get_outbound_idempotency(&conn, "old-rejected")
            .unwrap()
            .is_none());
        assert!(get_outbound_idempotency(&conn, "old-sent")
            .unwrap()
            .is_none());
        assert!(get_outbound_idempotency(&conn, "old-failed")
            .unwrap()
            .is_none());
        assert!(get_outbound_idempotency(&conn, "fresh-rejected")
            .unwrap()
            .is_some());
        for key in [
            "live-queued",
            "live-sending",
            "live-uncertain",
            "live-recon",
        ] {
            assert!(
                get_outbound_idempotency(&conn, key).unwrap().is_some(),
                "{key} must be retained"
            );
        }
    }

    #[test]
    fn sweep_enforces_capacity_without_deleting_active_or_uncertain() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("sweep-cap.db");
        let conn = open_test_conn(&path);
        let future = datetime_after_ms(60_000);
        for i in 0..5 {
            insert_state(&conn, &format!("rej-{i}"), "rejected", &future);
        }
        insert_state(&conn, "keep-queued", "queued", &future);
        insert_state(&conn, "keep-sending", "sending", &future);
        insert_state(&conn, "keep-uncertain", "uncertain", &future);
        insert_state(&conn, "keep-recon", "needs_reconciliation", &future);

        sweep_outbound_idempotency(&conn, 6).unwrap();
        assert!(count_outbound_idempotency(&conn) <= 6);
        for key in [
            "keep-queued",
            "keep-sending",
            "keep-uncertain",
            "keep-recon",
        ] {
            assert!(
                get_outbound_idempotency(&conn, key).unwrap().is_some(),
                "{key} must survive capacity eviction"
            );
        }
    }

    #[test]
    fn sweep_delete_reinsert_does_not_reuse_generation_against_stale_worker() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("aba.db");
        let conn = open_test_conn(&path);
        let old_generation = insert_outbound_queued(&conn, "aba-key", Duration::from_secs(60))
            .unwrap()
            .unwrap();
        assert_eq!(old_generation, 1);
        assert!(mark_outbound_sending(&conn, "aba-key", old_generation).unwrap());
        conn.execute(
            "UPDATE outbound_idempotency
             SET state = 'expired', expires_at = '1970-01-01T00:00:00+00:00'
             WHERE key = 'aba-key'",
            [],
        )
        .unwrap();
        sweep_outbound_idempotency(&conn, 10_000).unwrap();
        assert!(get_outbound_idempotency(&conn, "aba-key")
            .unwrap()
            .is_none());
        assert_eq!(count_outbound_generation_clock(&conn), 1);

        let stale = open_test_conn(&path);
        let fresh = open_test_conn(&path);
        let new_generation = insert_outbound_queued(&fresh, "aba-key", Duration::from_secs(60))
            .unwrap()
            .unwrap();
        assert!(new_generation > old_generation);
        assert!(mark_outbound_sending(&fresh, "aba-key", new_generation).unwrap());

        assert!(!complete_outbound_result(
            &stale,
            "aba-key",
            old_generation,
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
            mark_outbound_sending_needs_reconciliation(
                &stale,
                "aba-key",
                old_generation,
                "IDEMPOTENCY_SENDING_DROPPED",
                Duration::from_secs(60),
            )
            .unwrap(),
            0
        );
        let record = get_outbound_idempotency(&conn, "aba-key").unwrap().unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::Sending);
        assert_eq!(record.generation, new_generation);
    }

    #[test]
    fn protected_rows_above_max_are_retained_and_counted() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("protected-cap.db");
        let conn = open_test_conn(&path);
        let future = datetime_after_ms(60_000);
        for i in 0..20 {
            insert_state(&conn, &format!("unc-{i}"), "uncertain", &future);
        }
        sweep_outbound_idempotency(&conn, 3).unwrap();
        assert_eq!(count_outbound_idempotency(&conn), 20);
        assert_eq!(count_protected_outbound_idempotency(&conn), 20);
        assert!(count_protected_outbound_idempotency(&conn) > 3);
    }

    #[test]
    fn independent_connections_do_not_oversubscribe_protected_capacity() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("cap-atomic.db");
        open_test_conn(&path);
        let barrier = Arc::new(Barrier::new(2));
        let inserted = Arc::new(AtomicUsize::new(0));

        std::thread::scope(|scope| {
            for i in 0..2 {
                let barrier = Arc::clone(&barrier);
                let inserted = Arc::clone(&inserted);
                let path = path.clone();
                scope.spawn(move || {
                    let conn = open_test_conn(&path);
                    barrier.wait();
                    match admit_outbound_claim(
                        &conn,
                        &format!("cap-key-{i}"),
                        Duration::from_secs(60),
                        1,
                    )
                    .unwrap()
                    {
                        OutboundAdmit::Inserted(_) => {
                            inserted.fetch_add(1, Ordering::SeqCst);
                        }
                        OutboundAdmit::Capacity => {}
                        other => panic!("unexpected admit result: {other:?}"),
                    }
                });
            }
        });

        let conn = open_test_conn(&path);
        assert_eq!(inserted.load(Ordering::SeqCst), 1);
        assert_eq!(count_protected_outbound_idempotency(&conn), 1);
    }

    #[test]
    fn global_clock_stays_one_row_across_high_cardinality_and_restart() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("clock.db");
        let conn = open_test_conn(&path);
        for i in 0..80 {
            assert!(reject_outbound_pre_execution(
                &conn,
                &format!("rej-card-{i}"),
                None,
                OutboundIdempotencyState::Rejected,
                "QUEUE_FULL",
                Duration::from_millis(1),
            )
            .unwrap());
        }
        std::thread::sleep(Duration::from_millis(5));
        sweep_outbound_idempotency(&conn, 1).unwrap();
        assert_eq!(count_outbound_generation_clock(&conn), 1);
        let first = allocate_outbound_generation(&conn).unwrap();

        let restarted = open_test_conn(&path);
        assert_eq!(count_outbound_generation_clock(&restarted), 1);
        let second = allocate_outbound_generation(&restarted).unwrap();
        assert!(second > first);
        let claimed = insert_outbound_queued(&restarted, "after-restart", Duration::from_secs(60))
            .unwrap()
            .unwrap();
        assert!(claimed >= second);
        assert_eq!(count_outbound_generation_clock(&restarted), 1);
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
