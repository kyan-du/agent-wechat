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
    let state = OutboundIdempotencyState::from_str(&state_raw)
        .unwrap_or(OutboundIdempotencyState::Failed);
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
    })
}

pub fn get_outbound_idempotency(
    conn: &Connection,
    key: &str,
) -> rusqlite::Result<Option<OutboundIdempotencyRecord>> {
    conn.query_row(
        "SELECT key, state, result_success, error_code, error, commit_attempted, expires_at, updated_at
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
) -> rusqlite::Result<()> {
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.execute(
        "INSERT INTO outbound_idempotency
            (key, state, result_success, error_code, error, commit_attempted, expires_at, created_at, updated_at, completed_at)
         VALUES (?1, 'queued', NULL, NULL, NULL, 0, ?2, ?3, ?3, NULL)
         ON CONFLICT(key) DO UPDATE SET
            state = 'queued',
            result_success = NULL,
            error_code = NULL,
            error = NULL,
            commit_attempted = 0,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at,
            completed_at = NULL",
        params![key, expires_at, now],
    )?;
    Ok(())
}

pub fn update_outbound_state(
    conn: &Connection,
    key: &str,
    state: OutboundIdempotencyState,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE outbound_idempotency SET state = ?2, updated_at = ?3 WHERE key = ?1",
        params![key, state.as_str(), sqlite_now()],
    )?;
    Ok(())
}

pub fn complete_outbound_result(
    conn: &Connection,
    key: &str,
    result: &SendResult,
    ttl: std::time::Duration,
) -> rusqlite::Result<()> {
    let sanitized = sanitized_result(result);
    let state = send_result_state(&sanitized);
    let now = sqlite_now();
    let expires_at = datetime_after_ms(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.execute(
        "UPDATE outbound_idempotency
         SET state = ?2,
             result_success = ?3,
             error_code = ?4,
             error = ?5,
             commit_attempted = ?6,
             expires_at = ?7,
             updated_at = ?8,
             completed_at = ?8
         WHERE key = ?1",
        params![
            key,
            state.as_str(),
            if sanitized.success { 1 } else { 0 },
            sanitized.error_code,
            sanitized.error,
            if sanitized.commit_attempted { 1 } else { 0 },
            expires_at,
            now
        ],
    )?;
    Ok(())
}

pub fn reject_outbound_pre_execution(
    conn: &Connection,
    key: &str,
    state: OutboundIdempotencyState,
    error_code: &str,
    ttl: std::time::Duration,
) -> rusqlite::Result<()> {
    let existing = get_outbound_idempotency(conn, key)?;
    if matches!(
        existing.as_ref().map(|record| &record.state),
        Some(state) if state.is_completed_execution()
    ) {
        return Ok(());
    }
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
            completed_at = excluded.completed_at",
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
           AND state IN ('sent', 'uncertain', 'failed')
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
    let login_state = if logged_in_user.is_some() { "logged_in" } else { "logged_out" };
    conn.execute(
        "UPDATE sessions SET logged_in_user = ?1, login_state = ?2, updated_at = ?3 WHERE id = ?4",
        params![logged_in_user, login_state, now, session_id],
    )
    .ok();
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
