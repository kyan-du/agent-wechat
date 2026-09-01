use std::{
    collections::{hash_map::DefaultHasher, HashMap, VecDeque},
    future::Future,
    hash::{Hash, Hasher},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    http::{header::RETRY_AFTER, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Timelike;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    context::create_context,
    db::{
        get_db,
        queries::{
            admit_outbound_claim, complete_outbound_result, count_outbound_idempotency,
            expire_outbound_if_stale, get_outbound_idempotency, mark_outbound_needs_reconciliation,
            mark_outbound_queued_needs_reconciliation, mark_outbound_sending,
            mark_outbound_sending_needs_reconciliation, reconcile_outbound_idempotency,
            reject_outbound_pre_execution, reject_outbound_unless_active_or_completed,
            sweep_outbound_idempotency, OutboundAdmit, OutboundIdempotencyRecord,
            OutboundIdempotencyState,
        },
        try_get_db,
    },
    execution::run_execution_loop,
    ia::types::{SendResult, SubscriptionEvent},
    plans::send_message::{SendMessageParams, SendMessagePlan},
    sessions::manager::current_session,
};

const DEFAULT_QUEUE_CAPACITY: usize = 20;
const DEFAULT_MIN_SPACING_MS: u64 = 1_500;
const DEFAULT_JITTER_MS: u64 = 250;
const DEFAULT_TASK_TTL_MS: u64 = 60_000;
const DEFAULT_IDEMPOTENCY_TTL_MS: u64 = 600_000;
const DEFAULT_RETRY_AFTER_SECONDS: u64 = 2;
const DEFAULT_CHAT_COOLDOWN_MS: u64 = 3_000;
const DEFAULT_HOURLY_BUDGET: u32 = 40;
const DEFAULT_DAILY_BUDGET: u32 = 200;
const DEFAULT_QUIET_START_MIN: u32 = 30;
const DEFAULT_QUIET_END_MIN: u32 = 7 * 60 + 30;
const DEFAULT_IDEMPOTENCY_MAX_ROWS: usize = 10_000;
pub const IDEMPOTENCY_KEY_MAX_BYTES: usize = 128;
const DEFAULT_LONG_TAIL_CHANCE_PERCENT: u32 = 8;
const DEFAULT_LONG_TAIL_JITTER_MS: u64 = 4_000;
const DEFAULT_SIMILARITY_WINDOW_MS: u64 = 10 * 60_000;
const DEFAULT_SIMILARITY_MIN_CHARS: usize = 20;
const DEFAULT_SIMILARITY_HAMMING: u32 = 8;
const DEFAULT_SIMILARITY_HISTORY: usize = 200;
const DEFAULT_SOURCE: &str = "api";

fn persist_error_code(error: &rusqlite::Error) -> &'static str {
    match error {
        rusqlite::Error::SqliteFailure(err, _) => match err.code {
            rusqlite::ErrorCode::DatabaseBusy => "SQLITE_BUSY",
            rusqlite::ErrorCode::DatabaseLocked => "SQLITE_LOCKED",
            rusqlite::ErrorCode::ConstraintViolation => "SQLITE_CONSTRAINT",
            rusqlite::ErrorCode::ReadOnly => "SQLITE_READONLY",
            rusqlite::ErrorCode::DiskFull => "SQLITE_FULL",
            rusqlite::ErrorCode::CannotOpen => "SQLITE_CANTOPEN",
            rusqlite::ErrorCode::DatabaseCorrupt => "SQLITE_CORRUPT",
            rusqlite::ErrorCode::SystemIoFailure => "SQLITE_IOERR",
            rusqlite::ErrorCode::ApiMisuse => "SQLITE_MISUSE",
            rusqlite::ErrorCode::SchemaChanged => "SQLITE_SCHEMA",
            rusqlite::ErrorCode::AuthorizationForStatementDenied => "SQLITE_AUTH",
            _ => "SQLITE_FAILURE",
        },
        rusqlite::Error::QueryReturnedNoRows => "SQLITE_NO_ROWS",
        rusqlite::Error::ExecuteReturnedResults => "SQLITE_EXECUTE",
        rusqlite::Error::InvalidQuery => "SQLITE_INVALID_QUERY",
        rusqlite::Error::NulError(_) => "SQLITE_NUL",
        rusqlite::Error::InvalidColumnIndex(_)
        | rusqlite::Error::InvalidColumnName(_)
        | rusqlite::Error::InvalidColumnType(_, _, _) => "SQLITE_COLUMN",
        rusqlite::Error::Utf8Error(_) => "SQLITE_UTF8",
        rusqlite::Error::FromSqlConversionFailure(_, _, _) => "SQLITE_CONVERSION",
        rusqlite::Error::IntegralValueOutOfRange(_, _) => "SQLITE_RANGE",
        rusqlite::Error::ToSqlConversionFailure(_) => "SQLITE_TOSQL",
        _ => "SQLITE_ERROR",
    }
}

fn log_persist_failure(op: &'static str, error: &rusqlite::Error) {
    tracing::error!(
        op,
        code = persist_error_code(error),
        "[outbound] idempotency persistence failed"
    );
}

fn idempotency_max_rows() -> usize {
    env_usize("AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_MAX_ROWS")
        .unwrap_or(DEFAULT_IDEMPOTENCY_MAX_ROWS)
        .max(1)
}

fn sweep_persistent_idempotency(conn: &rusqlite::Connection) {
    if let Err(error) = sweep_outbound_idempotency(conn, idempotency_max_rows()) {
        log_persist_failure("sweep", &error);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundErrorKind {
    QueueFull,
    ReadOnly,
    DuplicateInProgress,
    Expired,
    Unavailable,
    QuietHours,
    Budget,
    Persistence,
    InvalidIdempotencyKey,
    Capacity,
    SimilarContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundError {
    pub kind: OutboundErrorKind,
    pub retry_after: Option<Duration>,
    pub code: String,
    pub message: String,
    pub commit_attempted: bool,
}

impl OutboundError {
    fn queue_full(retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::QueueFull,
            retry_after: Some(retry_after),
            code: "QUEUE_FULL".to_string(),
            message: "Outbound send queue is full".to_string(),
            commit_attempted: false,
        }
    }

    fn read_only() -> Self {
        Self {
            kind: OutboundErrorKind::ReadOnly,
            retry_after: None,
            code: "OUTBOUND_DISABLED".to_string(),
            message: "Outbound sends are disabled by read-only mode".to_string(),
            commit_attempted: false,
        }
    }

    pub(crate) fn duplicate_in_progress(retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::DuplicateInProgress,
            retry_after: Some(retry_after),
            code: "IDEMPOTENCY_IN_PROGRESS".to_string(),
            message: "A request with this idempotencyKey is already pending".to_string(),
            commit_attempted: false,
        }
    }

    fn expired() -> Self {
        Self {
            kind: OutboundErrorKind::Expired,
            retry_after: None,
            code: "QUEUE_EXPIRED".to_string(),
            message: "Outbound send expired before execution".to_string(),
            commit_attempted: false,
        }
    }

    fn unavailable() -> Self {
        Self {
            kind: OutboundErrorKind::Unavailable,
            retry_after: None,
            code: "SCHEDULER_UNAVAILABLE".to_string(),
            message: "Outbound send scheduler is unavailable".to_string(),
            commit_attempted: false,
        }
    }

    fn quiet_hours(retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::QuietHours,
            retry_after: Some(retry_after),
            code: "QUIET_HOURS".to_string(),
            message: format!("静默时间内，预计可重试时间：{} 秒后", retry_after.as_secs()),
            commit_attempted: false,
        }
    }

    fn budget(code: &str, retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::Budget,
            retry_after: Some(retry_after),
            code: code.to_string(),
            message: match code {
                "HOURLY_BUDGET" => "已达到小时发送预算，预计下一小时可重试".to_string(),
                "DAILY_BUDGET" => "已达到日发送预算，预计下一日可重试".to_string(),
                _ => "已达到发送预算，预计稍后可重试".to_string(),
            },
            commit_attempted: false,
        }
    }

    fn persistence(commit_attempted: bool) -> Self {
        Self {
            kind: OutboundErrorKind::Persistence,
            retry_after: None,
            code: "IDEMPOTENCY_PERSISTENCE_FAILED".to_string(),
            message: if commit_attempted {
                "Outbound send result could not be durably persisted; manual reconciliation is required".to_string()
            } else {
                "Outbound idempotency state could not be durably persisted".to_string()
            },
            commit_attempted,
        }
    }

    fn invalid_idempotency_key() -> Self {
        Self {
            kind: OutboundErrorKind::InvalidIdempotencyKey,
            retry_after: None,
            code: "INVALID_IDEMPOTENCY_KEY".to_string(),
            message: "idempotencyKey must be 1-128 bytes of ASCII letters, digits, dot, underscore, colon, or hyphen".to_string(),
            commit_attempted: false,
        }
    }

    fn capacity(retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::Capacity,
            retry_after: Some(retry_after),
            code: "IDEMPOTENCY_CAPACITY".to_string(),
            message: "Outbound idempotency capacity is exhausted by protected evidence".to_string(),
            commit_attempted: false,
        }
    }

    fn similar_content() -> Self {
        Self {
            kind: OutboundErrorKind::SimilarContent,
            retry_after: None,
            code: "SIMILAR_CONTENT_CONFIRMATION_REQUIRED".to_string(),
            message: "Similar outbound text requires explicit human confirmation".to_string(),
            commit_attempted: false,
        }
    }
}

pub enum OutboundSendResponse {
    Result(SendResult),
    Rejected(OutboundError),
}

impl IntoResponse for OutboundSendResponse {
    fn into_response(self) -> Response {
        match self {
            OutboundSendResponse::Result(result) => (StatusCode::OK, Json(result)).into_response(),
            OutboundSendResponse::Rejected(error) => {
                let status = match error.kind {
                    OutboundErrorKind::QueueFull
                    | OutboundErrorKind::DuplicateInProgress
                    | OutboundErrorKind::QuietHours
                    | OutboundErrorKind::Budget
                    | OutboundErrorKind::Capacity => StatusCode::TOO_MANY_REQUESTS,
                    OutboundErrorKind::ReadOnly => StatusCode::SERVICE_UNAVAILABLE,
                    OutboundErrorKind::SimilarContent => StatusCode::CONFLICT,
                    OutboundErrorKind::Expired | OutboundErrorKind::Unavailable => {
                        StatusCode::SERVICE_UNAVAILABLE
                    }
                    OutboundErrorKind::Persistence => StatusCode::SERVICE_UNAVAILABLE,
                    OutboundErrorKind::InvalidIdempotencyKey => StatusCode::BAD_REQUEST,
                };
                let mut headers = HeaderMap::new();
                if let Some(retry_after) = error.retry_after {
                    let seconds = retry_after.as_secs().max(1).to_string();
                    if let Ok(value) = HeaderValue::from_str(&seconds) {
                        headers.insert(RETRY_AFTER, value);
                    }
                }
                (
                    status,
                    headers,
                    Json(SendResult {
                        success: false,
                        error_code: Some(error.code),
                        error: Some(error.message),
                        commit_attempted: error.commit_attempted,
                    }),
                )
                    .into_response()
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundStatus {
    pub queue_capacity: usize,
    pub queue_depth: usize,
    pub available_capacity: usize,
    pub min_spacing_ms: u128,
    pub jitter_ms: u128,
    pub task_ttl_ms: u128,
    pub idempotency_ttl_ms: u128,
    pub read_only: bool,
    pub runtime_paused: bool,
    pub idempotency_entries: usize,
    pub diagnostics: OutboundDiagnosticsSnapshot,
    pub chat_select_diagnostics: crate::tools::chat_select::ChatSelectDiagnostics,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundDiagnosticsSnapshot {
    pub enqueued_total: u64,
    pub completed_total: u64,
    pub failed_total: u64,
    pub rejected_429_total: u64,
    pub queue_expired_total: u64,
    pub pause_total: u64,
    pub resume_total: u64,
    pub duplicate_suppressed_total: u64,
    pub uncertain_total: u64,
    pub budget_rejected_total: u64,
    pub quiet_hours_rejected_total: u64,
    pub last_queue_wait_ms: u64,
    pub max_queue_wait_ms: u64,
    pub last_send_interval_ms: u64,
}

#[derive(Default)]
struct OutboundDiagnostics {
    enqueued_total: AtomicU64,
    completed_total: AtomicU64,
    failed_total: AtomicU64,
    rejected_429_total: AtomicU64,
    queue_expired_total: AtomicU64,
    pause_total: AtomicU64,
    resume_total: AtomicU64,
    duplicate_suppressed_total: AtomicU64,
    uncertain_total: AtomicU64,
    budget_rejected_total: AtomicU64,
    quiet_hours_rejected_total: AtomicU64,
    last_queue_wait_ms: AtomicU64,
    max_queue_wait_ms: AtomicU64,
    last_send_interval_ms: AtomicU64,
}

impl OutboundDiagnostics {
    fn snapshot(&self) -> OutboundDiagnosticsSnapshot {
        let load = |value: &AtomicU64| value.load(Ordering::Relaxed);
        OutboundDiagnosticsSnapshot {
            enqueued_total: load(&self.enqueued_total),
            completed_total: load(&self.completed_total),
            failed_total: load(&self.failed_total),
            rejected_429_total: load(&self.rejected_429_total),
            queue_expired_total: load(&self.queue_expired_total),
            pause_total: load(&self.pause_total),
            resume_total: load(&self.resume_total),
            duplicate_suppressed_total: load(&self.duplicate_suppressed_total),
            uncertain_total: load(&self.uncertain_total),
            budget_rejected_total: load(&self.budget_rejected_total),
            quiet_hours_rejected_total: load(&self.quiet_hours_rejected_total),
            last_queue_wait_ms: load(&self.last_queue_wait_ms),
            max_queue_wait_ms: load(&self.max_queue_wait_ms),
            last_send_interval_ms: load(&self.last_send_interval_ms),
        }
    }

    fn record_rejection(&self, error: &OutboundError) {
        if matches!(
            error.kind,
            OutboundErrorKind::QueueFull
                | OutboundErrorKind::DuplicateInProgress
                | OutboundErrorKind::QuietHours
                | OutboundErrorKind::Budget
                | OutboundErrorKind::Capacity
        ) {
            self.rejected_429_total.fetch_add(1, Ordering::Relaxed);
        }
        match error.kind {
            OutboundErrorKind::DuplicateInProgress => {
                self.duplicate_suppressed_total
                    .fetch_add(1, Ordering::Relaxed);
            }
            OutboundErrorKind::Expired => {
                self.queue_expired_total.fetch_add(1, Ordering::Relaxed);
            }
            OutboundErrorKind::QuietHours => {
                self.quiet_hours_rejected_total
                    .fetch_add(1, Ordering::Relaxed);
            }
            OutboundErrorKind::Budget => {
                self.budget_rejected_total.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    fn record_queue_wait(&self, wait: Duration) {
        let millis = wait.as_millis().min(u64::MAX as u128) as u64;
        self.last_queue_wait_ms.store(millis, Ordering::Relaxed);
        self.max_queue_wait_ms.fetch_max(millis, Ordering::Relaxed);
    }

    fn record_result(&self, result: &SendResult) {
        self.completed_total.fetch_add(1, Ordering::Relaxed);
        if !result.success {
            self.failed_total.fetch_add(1, Ordering::Relaxed);
        }
        if is_uncertain_result(result) {
            self.uncertain_total.fetch_add(1, Ordering::Relaxed);
        }
        if result.error_code.as_deref() == Some("duplicate_send_action_suppressed") {
            self.duplicate_suppressed_total
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub enum IdempotencyAdmission {
    Claimed(IdempotencyClaimLease),
    InProgress,
    Completed(SendResult),
    Rejected(OutboundError),
}

enum IdempotencyLeasePhase {
    Queued,
    Sending,
}

pub struct IdempotencyClaimLease {
    key: String,
    generation: i64,
    ttl: Duration,
    phase: IdempotencyLeasePhase,
    disarmed: bool,
}

impl IdempotencyClaimLease {
    fn new(key: String, generation: i64, ttl: Duration) -> Self {
        Self {
            key,
            generation,
            ttl,
            phase: IdempotencyLeasePhase::Queued,
            disarmed: false,
        }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn generation(&self) -> i64 {
        self.generation
    }

    pub(crate) fn disarm(&mut self) {
        self.disarmed = true;
    }

    fn enter_sending(&mut self) {
        self.phase = IdempotencyLeasePhase::Sending;
    }
}

impl Drop for IdempotencyClaimLease {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let db = get_db();
        let result = match self.phase {
            IdempotencyLeasePhase::Queued => mark_outbound_queued_needs_reconciliation(
                &db,
                &self.key,
                self.generation,
                "IDEMPOTENCY_CLAIM_DROPPED",
                self.ttl,
            ),
            IdempotencyLeasePhase::Sending => mark_outbound_sending_needs_reconciliation(
                &db,
                &self.key,
                self.generation,
                "IDEMPOTENCY_SENDING_DROPPED",
                self.ttl,
            ),
        };
        match result {
            Ok(affected) if affected > 0 => {}
            Ok(_) => {
                tracing::warn!(
                    op = "lease_drop",
                    code = "SQLITE_NO_ROWS",
                    "[outbound] idempotency lease drop CAS affected 0 rows"
                );
            }
            Err(error) => {
                log_persist_failure("lease_drop", &error);
            }
        }
    }
}

#[derive(Clone)]
pub struct OutboundConfig {
    pub queue_capacity: usize,
    pub min_spacing: Duration,
    pub jitter: Duration,
    pub task_ttl: Duration,
    pub idempotency_ttl: Duration,
    pub chat_cooldown: Duration,
    pub hourly_budget: u32,
    pub daily_budget: u32,
    pub quiet_start_min: u32,
    pub quiet_end_min: u32,
    pub read_only: bool,
    pub long_tail_jitter: Duration,
    pub long_tail_chance_percent: u32,
    pub similarity_window: Duration,
    pub similarity_min_chars: usize,
    pub similarity_hamming: u32,
    pub similarity_history: usize,
}

impl OutboundConfig {
    pub fn from_env() -> Self {
        Self {
            queue_capacity: env_usize("AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY")
                .unwrap_or(DEFAULT_QUEUE_CAPACITY)
                .max(1),
            min_spacing: Duration::from_millis(
                env_u64("AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS").unwrap_or(DEFAULT_MIN_SPACING_MS),
            ),
            jitter: Duration::from_millis(
                env_u64("AGENT_WECHAT_OUTBOUND_JITTER_MS").unwrap_or(DEFAULT_JITTER_MS),
            ),
            task_ttl: Duration::from_millis(
                env_u64("AGENT_WECHAT_OUTBOUND_TASK_TTL_MS").unwrap_or(DEFAULT_TASK_TTL_MS),
            ),
            idempotency_ttl: Duration::from_millis(
                env_u64("AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_TTL_MS")
                    .unwrap_or(DEFAULT_IDEMPOTENCY_TTL_MS),
            ),
            chat_cooldown: Duration::from_millis(
                env_u64("AGENT_WECHAT_CHAT_COOLDOWN_MS").unwrap_or(DEFAULT_CHAT_COOLDOWN_MS),
            ),
            hourly_budget: env_u32("AGENT_WECHAT_HOURLY_BUDGET").unwrap_or(DEFAULT_HOURLY_BUDGET),
            daily_budget: env_u32("AGENT_WECHAT_DAILY_BUDGET").unwrap_or(DEFAULT_DAILY_BUDGET),
            quiet_start_min: env_u32("AGENT_WECHAT_QUIET_START_MIN")
                .unwrap_or(DEFAULT_QUIET_START_MIN),
            quiet_end_min: env_u32("AGENT_WECHAT_QUIET_END_MIN").unwrap_or(DEFAULT_QUIET_END_MIN),
            read_only: env_bool("AGENT_WECHAT_OUTBOUND_DISABLED")
                || env_bool("AGENT_WECHAT_READ_ONLY"),
            long_tail_jitter: Duration::from_millis(
                env_u64("AGENT_WECHAT_OUTBOUND_LONG_TAIL_JITTER_MS")
                    .unwrap_or(DEFAULT_LONG_TAIL_JITTER_MS),
            ),
            long_tail_chance_percent: env_u32("AGENT_WECHAT_OUTBOUND_LONG_TAIL_CHANCE_PERCENT")
                .unwrap_or(DEFAULT_LONG_TAIL_CHANCE_PERCENT)
                .min(100),
            similarity_window: Duration::from_millis(
                env_u64("AGENT_WECHAT_SIMILARITY_WINDOW_MS")
                    .unwrap_or(DEFAULT_SIMILARITY_WINDOW_MS),
            ),
            similarity_min_chars: env_usize("AGENT_WECHAT_SIMILARITY_MIN_CHARS")
                .unwrap_or(DEFAULT_SIMILARITY_MIN_CHARS)
                .clamp(3, 10_000),
            similarity_hamming: env_u32("AGENT_WECHAT_SIMILARITY_HAMMING")
                .unwrap_or(DEFAULT_SIMILARITY_HAMMING)
                .min(32),
            similarity_history: env_usize("AGENT_WECHAT_SIMILARITY_HISTORY")
                .unwrap_or(DEFAULT_SIMILARITY_HISTORY)
                .clamp(1, 10_000),
        }
    }

    fn retry_after(&self) -> Duration {
        (self.min_spacing + self.jitter).max(Duration::from_secs(DEFAULT_RETRY_AFTER_SECONDS))
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.parse().ok()
}

fn env_u32(name: &str) -> Option<u32> {
    std::env::var(name).ok()?.parse().ok()
}

pub fn in_quiet_hours(minute_of_day: u32, start: u32, end: u32) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        minute_of_day >= start && minute_of_day < end
    } else {
        minute_of_day >= start || minute_of_day < end
    }
}

fn local_minute_of_day() -> u32 {
    let local = chrono::Local::now();
    (local.hour() * 60 + local.minute()) as u32
}

fn minutes_until(from: u32, target: u32) -> u32 {
    if target >= from {
        target - from
    } else {
        24 * 60 - from + target
    }
}

struct Usage {
    hour_key: u64,
    day_key: u64,
    hour_count: u32,
    day_count: u32,
    last_per_chat: HashMap<String, Instant>,
}

impl Usage {
    fn new() -> Self {
        Self {
            hour_key: 0,
            day_key: 0,
            hour_count: 0,
            day_count: 0,
            last_per_chat: HashMap::new(),
        }
    }

    fn roll(&mut self, now: SystemTime) {
        let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let hour = secs / 3600;
        let day = secs / 86400;
        if hour != self.hour_key {
            self.hour_key = hour;
            self.hour_count = 0;
        }
        if day != self.day_key {
            self.day_key = day;
            self.day_count = 0;
        }
    }

    fn record_success(&mut self, chat_id: &str, now: Instant, wall: SystemTime) {
        self.roll(wall);
        self.hour_count = self.hour_count.saturating_add(1);
        self.day_count = self.day_count.saturating_add(1);
        self.last_per_chat.insert(chat_id.to_string(), now);
    }
}

fn policy_allows_send(
    config: &OutboundConfig,
    usage: &mut Usage,
    chat_id: &str,
    now: Instant,
    wall: SystemTime,
    minute_of_day: u32,
) -> Result<Duration, OutboundError> {
    usage.roll(wall);
    if in_quiet_hours(minute_of_day, config.quiet_start_min, config.quiet_end_min) {
        let wait_min = minutes_until(minute_of_day, config.quiet_end_min);
        return Err(OutboundError::quiet_hours(Duration::from_secs(
            wait_min as u64 * 60,
        )));
    }
    if usage.hour_count >= config.hourly_budget {
        return Err(OutboundError::budget(
            "HOURLY_BUDGET",
            Duration::from_secs(600),
        ));
    }
    if usage.day_count >= config.daily_budget {
        return Err(OutboundError::budget(
            "DAILY_BUDGET",
            Duration::from_secs(3600),
        ));
    }
    let extra = usage
        .last_per_chat
        .get(chat_id)
        .map(|last| {
            config
                .chat_cooldown
                .saturating_sub(now.saturating_duration_since(*last))
        })
        .unwrap_or(Duration::ZERO);
    Ok(extra)
}

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name).ok()?.parse().ok()
}

/// Reading + typing delay. Only applied when production min_spacing is large
/// enough that unit tests with 0–30ms spacing stay fast.
pub fn human_pre_send_delay_ms(outbound_chars: usize, inbound_chars: usize) -> u64 {
    let reading = ((200 + 40 * inbound_chars) as u64).clamp(800, 8_000);
    let typing = ((80 * outbound_chars.max(1)) as u64).clamp(600, 12_000);
    (reading + typing).min(20_000)
}

fn env_bool(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn normalize_source(source: Option<&str>) -> String {
    source
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
        })
        .unwrap_or(DEFAULT_SOURCE)
        .to_string()
}

#[derive(Debug, Clone, Copy)]
struct TextFingerprint {
    simhash: u64,
    feature_bits: [u64; 2],
    chars: usize,
}

fn text_fingerprint(text: &str) -> Option<TextFingerprint> {
    let normalized: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect();
    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() < 3 {
        return None;
    }
    let mut weights = [0i32; 64];
    let mut feature_bits = [0u64; 2];
    for gram in chars.windows(3) {
        let mut hasher = DefaultHasher::new();
        gram.hash(&mut hasher);
        let hash = hasher.finish();
        feature_bits[(hash as usize >> 6) & 1] |= 1u64 << (hash & 63);
        for (bit, weight) in weights.iter_mut().enumerate() {
            *weight += if hash & (1u64 << bit) == 0 { -1 } else { 1 };
        }
    }
    let simhash = weights
        .iter()
        .enumerate()
        .fold(0u64, |hash, (bit, weight)| {
            if *weight >= 0 {
                hash | (1u64 << bit)
            } else {
                hash
            }
        });
    Some(TextFingerprint {
        simhash,
        feature_bits,
        chars: chars.len(),
    })
}

struct SimilarityEntry {
    at: Instant,
    scope_hash: u64,
    fingerprint: TextFingerprint,
}

struct PendingSimilarity {
    id: u64,
    scope_hash: u64,
    fingerprint: TextFingerprint,
}

struct SimilarityGuard {
    window: Duration,
    min_chars: usize,
    max_hamming: u32,
    max_entries: usize,
    committed: VecDeque<SimilarityEntry>,
    pending: Vec<PendingSimilarity>,
}

impl SimilarityGuard {
    fn new(config: &OutboundConfig) -> Self {
        Self {
            window: config.similarity_window,
            min_chars: config.similarity_min_chars,
            max_hamming: config.similarity_hamming,
            max_entries: config.similarity_history,
            committed: VecDeque::new(),
            pending: Vec::new(),
        }
    }

    fn is_similar(&self, existing: TextFingerprint, fingerprint: TextFingerprint) -> bool {
        let length_delta = existing.chars.abs_diff(fingerprint.chars);
        let intersection: u32 = existing
            .feature_bits
            .iter()
            .zip(fingerprint.feature_bits)
            .map(|(left, right)| (left & right).count_ones())
            .sum();
        let union: u32 = existing
            .feature_bits
            .iter()
            .zip(fingerprint.feature_bits)
            .map(|(left, right)| (left | right).count_ones())
            .sum();
        length_delta * 5 <= existing.chars.max(fingerprint.chars)
            && ((existing.simhash ^ fingerprint.simhash).count_ones() <= self.max_hamming
                || (union > 0 && intersection * 100 >= union * 72))
    }

    fn reserve(
        &mut self,
        id: u64,
        chat_id: &str,
        source: &str,
        text: Option<&str>,
        confirmed: bool,
        now: Instant,
    ) -> Result<bool, OutboundError> {
        while self
            .committed
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.at) > self.window)
        {
            self.committed.pop_front();
        }
        let Some(fingerprint) = text.and_then(text_fingerprint) else {
            return Ok(false);
        };
        if fingerprint.chars < self.min_chars {
            return Ok(false);
        }
        let mut scope_hasher = DefaultHasher::new();
        chat_id.hash(&mut scope_hasher);
        source.hash(&mut scope_hasher);
        let scope_hash = scope_hasher.finish();
        let similar = self
            .committed
            .iter()
            .filter(|entry| entry.scope_hash == scope_hash)
            .any(|entry| self.is_similar(entry.fingerprint, fingerprint));
        if similar && !confirmed {
            return Err(OutboundError::similar_content());
        }
        self.pending.push(PendingSimilarity {
            id,
            scope_hash,
            fingerprint,
        });
        Ok(true)
    }

    fn validate_for_execute(&self, id: u64, confirmed: bool) -> Result<(), OutboundError> {
        if confirmed {
            return Ok(());
        }
        let Some(pending) = self.pending.iter().find(|entry| entry.id == id) else {
            return Ok(());
        };
        if self
            .committed
            .iter()
            .filter(|entry| entry.scope_hash == pending.scope_hash)
            .any(|entry| self.is_similar(entry.fingerprint, pending.fingerprint))
        {
            return Err(OutboundError::similar_content());
        }
        Ok(())
    }

    fn commit(&mut self, id: u64, now: Instant) {
        if let Some(index) = self.pending.iter().position(|entry| entry.id == id) {
            let pending = self.pending.swap_remove(index);
            self.committed.push_back(SimilarityEntry {
                at: now,
                scope_hash: pending.scope_hash,
                fingerprint: pending.fingerprint,
            });
            while self.committed.len() > self.max_entries {
                self.committed.pop_front();
            }
        }
    }

    fn release(&mut self, id: u64) {
        self.pending.retain(|entry| entry.id != id);
    }
}

struct SimilarityReservation {
    guard: Arc<Mutex<SimilarityGuard>>,
    id: u64,
    committed: bool,
}

impl SimilarityReservation {
    fn validate_for_execute(&self, confirmed: bool) -> Result<(), OutboundError> {
        self.guard
            .lock()
            .expect("similarity guard poisoned")
            .validate_for_execute(self.id, confirmed)
    }

    fn commit(&mut self, now: Instant) {
        self.guard
            .lock()
            .expect("similarity guard poisoned")
            .commit(self.id, now);
        self.committed = true;
    }
}

impl Drop for SimilarityReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.guard
                .lock()
                .expect("similarity guard poisoned")
                .release(self.id);
        }
    }
}

struct FairSourceQueue {
    chats: HashMap<String, VecDeque<OutboundTask>>,
    ready_chats: VecDeque<String>,
}

impl FairSourceQueue {
    fn new() -> Self {
        Self {
            chats: HashMap::new(),
            ready_chats: VecDeque::new(),
        }
    }

    fn push(&mut self, task: OutboundTask) {
        let chat = task.params.chat_id.clone();
        let queue = self.chats.entry(chat.clone()).or_default();
        if queue.is_empty() {
            self.ready_chats.push_back(chat);
        }
        queue.push_back(task);
    }

    fn pop(&mut self) -> Option<OutboundTask> {
        let chat = self.ready_chats.pop_front()?;
        let queue = self.chats.get_mut(&chat)?;
        let task = queue.pop_front();
        if queue.is_empty() {
            self.chats.remove(&chat);
        } else {
            self.ready_chats.push_back(chat);
        }
        task
    }

    fn is_empty(&self) -> bool {
        self.ready_chats.is_empty()
    }
}

struct FairQueue {
    sources: HashMap<String, FairSourceQueue>,
    ready_sources: VecDeque<String>,
}

impl FairQueue {
    fn new() -> Self {
        Self {
            sources: HashMap::new(),
            ready_sources: VecDeque::new(),
        }
    }

    fn push(&mut self, task: OutboundTask) {
        let source = normalize_source(task.params.source.as_deref());
        let queue = self
            .sources
            .entry(source.clone())
            .or_insert_with(FairSourceQueue::new);
        if queue.is_empty() {
            self.ready_sources.push_back(source);
        }
        queue.push(task);
    }

    fn pop(&mut self) -> Option<OutboundTask> {
        let source = self.ready_sources.pop_front()?;
        let queue = self.sources.get_mut(&source)?;
        let task = queue.pop();
        if queue.is_empty() {
            self.sources.remove(&source);
        } else {
            self.ready_sources.push_back(source);
        }
        task
    }

    fn is_empty(&self) -> bool {
        self.ready_sources.is_empty()
    }
}

struct OutboundTask {
    params: SendMessageParams,
    enqueued_at: Instant,
    idempotency_key: Option<String>,
    idempotency_generation: Option<i64>,
    idempotency_lease: Option<IdempotencyClaimLease>,
    result_tx: oneshot::Sender<OutboundSendResponse>,
    _queue_permit: Option<tokio::sync::OwnedSemaphorePermit>,
    similarity_reservation: Option<SimilarityReservation>,
}

type ExecuteFuture = Pin<Box<dyn Future<Output = SendResult> + Send>>;
type ExecuteSend = Arc<dyn Fn(SendMessageParams) -> ExecuteFuture + Send + Sync>;

#[derive(Clone)]
pub struct OutboundSender {
    config: OutboundConfig,
    control: Arc<OutboundControl>,
    tx: mpsc::UnboundedSender<OutboundTask>,
    capacity: Arc<tokio::sync::Semaphore>,
    usage: Arc<Mutex<Usage>>,
    similarity: Arc<Mutex<SimilarityGuard>>,
    next_similarity_id: Arc<AtomicU64>,
    diagnostics: Arc<OutboundDiagnostics>,
    execute: ExecuteSend,
}

static OUTBOUND_SENDER: OnceLock<OutboundSender> = OnceLock::new();

#[cfg(test)]
static FAIL_SENDING_PERSISTENCE_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
#[cfg(test)]
static FAIL_RESULT_PERSISTENCE_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
#[cfg(test)]
static FAIL_REJECTION_PERSISTENCE_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
#[cfg(test)]
static FAIL_RECONCILE_PERSISTENCE_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
#[cfg(test)]
static FAIL_CLAIM_WITH_HOSTILE_ERROR: OnceLock<Mutex<bool>> = OnceLock::new();
#[cfg(test)]
static FAIL_MANUAL_RECONCILE_WITH_HOSTILE_ERROR: OnceLock<Mutex<bool>> = OnceLock::new();

#[cfg(test)]
fn hostile_sqlite_error() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error {
            code: rusqlite::ffi::ErrorCode::DatabaseCorrupt,
            extended_code: 0,
        },
        Some(
            "hostile path=/Users/kyan/private/agent.db SQL=UPDATE outbound_idempotency provider=sqlcipher key=hostile-secret-key"
                .to_string(),
        ),
    )
}

#[cfg(test)]
fn consume_hostile_claim_failure() -> bool {
    let mut guard = FAIL_CLAIM_WITH_HOSTILE_ERROR
        .get_or_init(|| Mutex::new(false))
        .lock()
        .expect("claim fault slot poisoned");
    let fail = *guard;
    *guard = false;
    fail
}

#[cfg(test)]
fn fail_next_claim_with_hostile_error() {
    let mut guard = FAIL_CLAIM_WITH_HOSTILE_ERROR
        .get_or_init(|| Mutex::new(false))
        .lock()
        .expect("claim fault slot poisoned");
    *guard = true;
}

pub fn outbound_sender() -> &'static OutboundSender {
    OUTBOUND_SENDER.get_or_init(|| OutboundSender::spawn(OutboundConfig::from_env()))
}

impl OutboundSender {
    pub fn spawn(config: OutboundConfig) -> Self {
        Self::spawn_with_executor(
            config,
            Arc::new(|params| Box::pin(async move { execute_send(&params).await })),
        )
    }

    fn spawn_with_executor(config: OutboundConfig, execute: ExecuteSend) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let capacity = Arc::new(tokio::sync::Semaphore::new(config.queue_capacity));
        let control = Arc::new(OutboundControl::new(config.read_only));
        let usage = Arc::new(Mutex::new(Usage::new()));
        let similarity = Arc::new(Mutex::new(SimilarityGuard::new(&config)));
        let diagnostics = Arc::new(OutboundDiagnostics::default());
        let worker_control = Arc::clone(&control);
        let worker_usage = Arc::clone(&usage);
        let worker_diagnostics = Arc::clone(&diagnostics);
        let worker_config = config.clone();
        let worker_execute = Arc::clone(&execute);

        tokio::spawn(async move {
            worker_loop(
                worker_config,
                worker_control,
                rx,
                worker_usage,
                worker_diagnostics,
                worker_execute,
            )
            .await;
        });

        Self {
            config,
            control,
            tx,
            capacity,
            usage,
            similarity,
            next_similarity_id: Arc::new(AtomicU64::new(1)),
            diagnostics,
            execute,
        }
    }

    pub fn retry_after(&self) -> Duration {
        self.config.retry_after()
    }

    pub async fn send(
        &self,
        params: SendMessageParams,
        idempotency_key: Option<String>,
    ) -> OutboundSendResponse {
        if let Some(key) = idempotency_key.as_deref() {
            match self.admit_idempotency_key(key) {
                IdempotencyAdmission::Claimed(lease) => {
                    return self.send_claimed(params, Some(lease)).await;
                }
                IdempotencyAdmission::Completed(result) => {
                    cleanup_temp_files(&params);
                    return OutboundSendResponse::Result(result);
                }
                IdempotencyAdmission::InProgress => {
                    cleanup_temp_files(&params);
                    let error = OutboundError::duplicate_in_progress(self.config.retry_after());
                    self.diagnostics.record_rejection(&error);
                    return OutboundSendResponse::Rejected(error);
                }
                IdempotencyAdmission::Rejected(error) => {
                    cleanup_temp_files(&params);
                    self.diagnostics.record_rejection(&error);
                    return OutboundSendResponse::Rejected(error);
                }
            }
        }

        self.send_claimed(params, None).await
    }

    pub fn admit_idempotency_key(&self, key: &str) -> IdempotencyAdmission {
        if validate_idempotency_key(key).is_err() {
            return IdempotencyAdmission::Rejected(OutboundError::invalid_idempotency_key());
        }
        if self.control.is_read_only() {
            match expire_and_replay_idempotency(key) {
                Ok(IdempotencyReplay::Completed(result)) => {
                    return IdempotencyAdmission::Completed(result);
                }
                Ok(IdempotencyReplay::InProgress) => {
                    return IdempotencyAdmission::InProgress;
                }
                Ok(IdempotencyReplay::NeedsReconciliation) => {
                    return IdempotencyAdmission::Rejected(OutboundError::duplicate_in_progress(
                        self.config.retry_after(),
                    ));
                }
                Ok(IdempotencyReplay::None) => {
                    if let Err(error) =
                        persist_read_only_rejection(key, self.config.idempotency_ttl)
                    {
                        log_persist_failure("read_only_rejection", &error);
                        self.control.set_runtime_paused(true);
                        return IdempotencyAdmission::Rejected(OutboundError::persistence(false));
                    }
                    return IdempotencyAdmission::Rejected(OutboundError::read_only());
                }
                Err(error) => {
                    log_persist_failure("read_only_expire_or_replay", &error);
                    self.control.set_runtime_paused(true);
                    return IdempotencyAdmission::Rejected(OutboundError::persistence(false));
                }
            }
        }

        match try_claim_idempotency(key, self.config.idempotency_ttl) {
            Ok(IdempotencyStart::Inserted(generation)) => {
                IdempotencyAdmission::Claimed(IdempotencyClaimLease::new(
                    key.to_string(),
                    generation,
                    self.config.idempotency_ttl,
                ))
            }
            Ok(IdempotencyStart::Completed(result)) => IdempotencyAdmission::Completed(result),
            Ok(IdempotencyStart::InProgress) | Ok(IdempotencyStart::NeedsReconciliation) => {
                IdempotencyAdmission::InProgress
            }
            Ok(IdempotencyStart::Capacity) => {
                IdempotencyAdmission::Rejected(OutboundError::capacity(self.config.retry_after()))
            }
            Err(error) => {
                log_persist_failure("claim", &error);
                self.control.set_runtime_paused(true);
                IdempotencyAdmission::Rejected(OutboundError::persistence(false))
            }
        }
    }

    pub async fn send_claimed(
        &self,
        params: SendMessageParams,
        mut idempotency_lease: Option<IdempotencyClaimLease>,
    ) -> OutboundSendResponse {
        let now = Instant::now();
        let idempotency_key = idempotency_lease.as_ref().map(|lease| lease.key.clone());
        let idempotency_generation = idempotency_lease.as_ref().map(|lease| lease.generation);
        if self.control.is_read_only() {
            cleanup_temp_files(&params);
            if let Some(key) = idempotency_key.as_deref() {
                if let Err(error) = persist_rejection(
                    key,
                    idempotency_generation,
                    OutboundIdempotencyState::Rejected,
                    "OUTBOUND_DISABLED",
                    self.config.idempotency_ttl,
                ) {
                    log_persist_failure("claimed_read_only_rejection", &error);
                    self.control.set_runtime_paused(true);
                    return OutboundSendResponse::Rejected(OutboundError::persistence(false));
                }
                if let Some(lease) = &mut idempotency_lease {
                    lease.disarm();
                }
            }
            let error = OutboundError::read_only();
            self.diagnostics.record_rejection(&error);
            return OutboundSendResponse::Rejected(error);
        }

        {
            let mut usage = self.usage.lock().expect("usage poisoned");
            if let Err(error) = policy_allows_send(
                &self.config,
                &mut usage,
                &params.chat_id,
                now,
                SystemTime::now(),
                local_minute_of_day(),
            ) {
                if let Some(key) = idempotency_key.as_deref() {
                    if let Err(error) = persist_rejection(
                        key,
                        idempotency_generation,
                        OutboundIdempotencyState::Rejected,
                        &error.code,
                        self.config.idempotency_ttl,
                    ) {
                        log_persist_failure("policy_rejection", &error);
                        self.control.set_runtime_paused(true);
                        cleanup_temp_files(&params);
                        return OutboundSendResponse::Rejected(OutboundError::persistence(false));
                    }
                    if let Some(lease) = &mut idempotency_lease {
                        lease.disarm();
                    }
                }
                cleanup_temp_files(&params);
                self.diagnostics.record_rejection(&error);
                return OutboundSendResponse::Rejected(error);
            }
        }

        let permit = match Arc::clone(&self.capacity).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let error = OutboundError::queue_full(self.config.retry_after());
                if let Some(key) = idempotency_key.as_deref() {
                    if let Err(err) = persist_rejection(
                        key,
                        idempotency_generation,
                        OutboundIdempotencyState::Rejected,
                        &error.code,
                        self.config.idempotency_ttl,
                    ) {
                        log_persist_failure("queue_full_rejection", &err);
                        self.control.set_runtime_paused(true);
                        cleanup_temp_files(&params);
                        return OutboundSendResponse::Rejected(OutboundError::persistence(false));
                    }
                    if let Some(lease) = &mut idempotency_lease {
                        lease.disarm();
                    }
                }
                cleanup_temp_files(&params);
                self.diagnostics.record_rejection(&error);
                return OutboundSendResponse::Rejected(error);
            }
        };

        let similarity_id = self.next_similarity_id.fetch_add(1, Ordering::Relaxed);
        let similarity_source = normalize_source(params.source.as_deref());
        let similarity_text = if params.image_path.is_none() && params.file_path.is_none() {
            params.message.as_deref()
        } else {
            None
        };
        let similarity_reserved = self
            .similarity
            .lock()
            .expect("similarity guard poisoned")
            .reserve(
                similarity_id,
                &params.chat_id,
                &similarity_source,
                similarity_text,
                params.similarity_confirmed,
                now,
            );
        let similarity_reservation = match similarity_reserved {
            Ok(true) => Some(SimilarityReservation {
                guard: Arc::clone(&self.similarity),
                id: similarity_id,
                committed: false,
            }),
            Ok(false) => None,
            Err(error) => {
                drop(permit);
                if let Some(key) = idempotency_key.as_deref() {
                    if let Err(err) = persist_rejection(
                        key,
                        idempotency_generation,
                        OutboundIdempotencyState::Rejected,
                        &error.code,
                        self.config.idempotency_ttl,
                    ) {
                        log_persist_failure("similarity_rejection", &err);
                        self.control.set_runtime_paused(true);
                        cleanup_temp_files(&params);
                        return OutboundSendResponse::Rejected(OutboundError::persistence(false));
                    }
                    if let Some(lease) = &mut idempotency_lease {
                        lease.disarm();
                    }
                }
                cleanup_temp_files(&params);
                self.diagnostics.record_rejection(&error);
                return OutboundSendResponse::Rejected(error);
            }
        };

        let (result_tx, result_rx) = oneshot::channel();
        let task = OutboundTask {
            params,
            enqueued_at: now,
            idempotency_key: idempotency_key.clone(),
            idempotency_generation,
            idempotency_lease,
            result_tx,
            _queue_permit: Some(permit),
            similarity_reservation,
        };

        match self.tx.send(task) {
            Ok(()) => {
                self.diagnostics
                    .enqueued_total
                    .fetch_add(1, Ordering::Relaxed);
                match result_rx.await {
                    Ok(response) => response,
                    Err(_) => {
                        if let Some(key) = idempotency_key.as_deref() {
                            if let Err(error) = persist_unknown_worker_result(
                                key,
                                idempotency_generation,
                                self.config.idempotency_ttl,
                            ) {
                                log_persist_failure("unknown_worker_result", &error);
                                self.control.set_runtime_paused(true);
                                return OutboundSendResponse::Rejected(OutboundError::persistence(
                                    true,
                                ));
                            }
                        }
                        let error = OutboundError::unavailable();
                        self.diagnostics.record_rejection(&error);
                        OutboundSendResponse::Rejected(error)
                    }
                }
            }
            Err(mpsc::error::SendError(task)) => {
                let error = OutboundError::unavailable();
                self.diagnostics.record_rejection(&error);
                reject_without_idempotency_cache(task, error.clone(), self.config.idempotency_ttl);
                OutboundSendResponse::Rejected(error)
            }
        }
    }

    pub(crate) fn reject_claimed_pre_execution(
        &self,
        idempotency_lease: &mut Option<IdempotencyClaimLease>,
        error_code: &str,
    ) -> Result<(), OutboundError> {
        if let Some(lease) = idempotency_lease {
            if let Err(error) = persist_rejection(
                lease.key(),
                Some(lease.generation()),
                OutboundIdempotencyState::Rejected,
                error_code,
                self.config.idempotency_ttl,
            ) {
                log_persist_failure("pre_execution_rejection", &error);
                self.control.set_runtime_paused(true);
                return Err(OutboundError::persistence(false));
            }
            lease.disarm();
        }
        Ok(())
    }

    pub fn status(&self) -> OutboundStatus {
        OutboundStatus {
            queue_capacity: self.config.queue_capacity,
            queue_depth: self
                .config
                .queue_capacity
                .saturating_sub(self.capacity.available_permits()),
            available_capacity: self.capacity.available_permits(),
            min_spacing_ms: self.config.min_spacing.as_millis(),
            jitter_ms: self.config.jitter.as_millis(),
            task_ttl_ms: self.config.task_ttl.as_millis(),
            idempotency_ttl_ms: self.config.idempotency_ttl.as_millis(),
            read_only: self.control.is_read_only(),
            runtime_paused: self.control.is_runtime_paused(),
            idempotency_entries: count_persistent_idempotency(),
            diagnostics: self.diagnostics.snapshot(),
            chat_select_diagnostics: crate::tools::chat_select::diagnostics(),
        }
    }

    pub fn trip_kill_switch(&self, reason: &str) -> OutboundStatus {
        let code = match reason {
            "security_popup" => "SECURITY_POPUP",
            "FRIDA_ATTACH_TIMEOUT" => "FRIDA_ATTACH_TIMEOUT",
            "FRIDA_ATTACH_FAILED" => "FRIDA_ATTACH_FAILED",
            _ => "SAFETY_POLICY",
        };
        tracing::warn!("[outbound] paused code={code}");
        self.pause()
    }

    pub fn pause(&self) -> OutboundStatus {
        if !self.control.is_runtime_paused() {
            self.diagnostics.pause_total.fetch_add(1, Ordering::Relaxed);
        }
        self.control.set_runtime_paused(true);
        self.status()
    }

    pub fn resume(&self) -> OutboundStatus {
        if self.control.is_runtime_paused() {
            self.diagnostics
                .resume_total
                .fetch_add(1, Ordering::Relaxed);
        }
        self.control.set_runtime_paused(false);
        self.status()
    }
}

pub struct OutboundControl {
    read_only: AtomicBool,
}

impl OutboundControl {
    fn new(read_only: bool) -> Self {
        Self {
            read_only: AtomicBool::new(read_only),
        }
    }

    fn set_runtime_paused(&self, read_only: bool) {
        self.read_only.store(read_only, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn set_read_only(&self, read_only: bool) {
        self.set_runtime_paused(read_only);
    }

    fn is_runtime_paused(&self) -> bool {
        self.read_only.load(Ordering::SeqCst)
    }

    fn is_read_only(&self) -> bool {
        self.is_runtime_paused()
            || env_bool("AGENT_WECHAT_OUTBOUND_DISABLED")
            || env_bool("AGENT_WECHAT_READ_ONLY")
    }
}

async fn worker_loop(
    config: OutboundConfig,
    control: Arc<OutboundControl>,
    mut rx: mpsc::UnboundedReceiver<OutboundTask>,
    usage: Arc<Mutex<Usage>>,
    diagnostics: Arc<OutboundDiagnostics>,
    execute: ExecuteSend,
) {
    let mut policy = SpacingPolicy::new(
        config.min_spacing,
        config.jitter,
        config.long_tail_jitter,
        config.long_tail_chance_percent,
    );
    let mut fair = FairQueue::new();
    let mut last_send_started: Option<Instant> = None;
    loop {
        if fair.is_empty() {
            let Some(task) = rx.recv().await else { break };
            fair.push(task);
        }
        while let Ok(task) = rx.try_recv() {
            fair.push(task);
        }
        let Some(task) = fair.pop() else { continue };
        tokio::task::yield_now().await;
        if let Some(db) = try_get_db() {
            sweep_persistent_idempotency(&db);
        }
        let now = Instant::now();
        if task.result_tx.is_closed() {
            reject_without_idempotency_cache(
                task,
                OutboundError::unavailable(),
                config.idempotency_ttl,
            );
            continue;
        }
        if task_expired(&task, now, config.task_ttl) {
            let error = OutboundError::expired();
            diagnostics.record_rejection(&error);
            reject_without_idempotency_cache(task, error, config.idempotency_ttl);
            continue;
        }

        let delay = policy.next_delay(now);
        let human = if config.min_spacing >= Duration::from_millis(500)
            && task.params.image_path.is_none()
            && task.params.file_path.is_none()
        {
            task.params.message.as_ref().map_or(Duration::ZERO, |text| {
                Duration::from_millis(human_pre_send_delay_ms(
                    text.chars().count(),
                    task.params.inbound_chars.unwrap_or(0),
                ))
            })
        } else {
            Duration::ZERO
        };
        let delay = delay.max(human);
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }

        let task = match admit_for_execute(
            task,
            &control,
            config.task_ttl,
            &config,
            &usage,
            &diagnostics,
        ) {
            Some(task) => task,
            None => continue,
        };

        let extra = {
            let mut usage = usage.lock().expect("usage poisoned");
            policy_allows_send(
                &config,
                &mut usage,
                &task.params.chat_id,
                Instant::now(),
                SystemTime::now(),
                local_minute_of_day(),
            )
        };
        let extra = match extra {
            Ok(wait) => wait,
            Err(error) => {
                diagnostics.record_rejection(&error);
                reject_without_idempotency_cache(task, error, config.idempotency_ttl);
                continue;
            }
        };
        if !extra.is_zero() {
            tokio::time::sleep(extra).await;
        }

        let mut task = match admit_for_execute(
            task,
            &control,
            config.task_ttl,
            &config,
            &usage,
            &diagnostics,
        ) {
            Some(task) => task,
            None => continue,
        };

        if let Some(reservation) = task.similarity_reservation.as_ref() {
            if let Err(error) = reservation.validate_for_execute(task.params.similarity_confirmed) {
                diagnostics.record_rejection(&error);
                reject_without_idempotency_cache(task, error, config.idempotency_ttl);
                continue;
            }
        }

        if let Some(key) = task.idempotency_key.as_deref() {
            if let Err(error) = persist_sending(key, task.idempotency_generation) {
                log_persist_failure("sending", &error);
                if mark_needs_reconciliation(
                    key,
                    task.idempotency_generation,
                    false,
                    config.idempotency_ttl,
                ) {
                    if let Some(lease) = &mut task.idempotency_lease {
                        lease.disarm();
                    }
                } else {
                    tracing::error!(
                        op = "sending_reconciliation",
                        code = "SQLITE_NO_ROWS",
                        "[outbound] idempotency persistence failed"
                    );
                }
                control.set_runtime_paused(true);
                cleanup_temp_files(&task.params);
                let error = OutboundError::persistence(false);
                diagnostics.record_rejection(&error);
                let _ = task.result_tx.send(OutboundSendResponse::Rejected(error));
                continue;
            }
            if let Some(lease) = &mut task.idempotency_lease {
                lease.enter_sending();
            }
        }

        let send_started = Instant::now();
        diagnostics.record_queue_wait(send_started.saturating_duration_since(task.enqueued_at));
        if let Some(previous) = last_send_started.replace(send_started) {
            let interval = send_started
                .saturating_duration_since(previous)
                .as_millis()
                .min(u64::MAX as u128) as u64;
            diagnostics
                .last_send_interval_ms
                .store(interval, Ordering::Relaxed);
        }
        let result = execute(task.params.clone()).await;
        diagnostics.record_result(&result);
        let completed_at = Instant::now();
        if counts_toward_usage(&result) {
            policy.record_attempt(completed_at, &mut SystemJitter);
            if let Some(reservation) = task.similarity_reservation.as_mut() {
                reservation.commit(completed_at);
            }
        }
        apply_send_result_to_usage(
            &usage,
            &result,
            &task.params.chat_id,
            completed_at,
            SystemTime::now(),
        );
        complete_task(task, result, config.idempotency_ttl, Some(&control));
    }
}

fn admit_for_execute(
    task: OutboundTask,
    control: &OutboundControl,
    task_ttl: Duration,
    config: &OutboundConfig,
    usage: &Mutex<Usage>,
    diagnostics: &OutboundDiagnostics,
) -> Option<OutboundTask> {
    if task.result_tx.is_closed() {
        reject_without_idempotency_cache(
            task,
            OutboundError::unavailable(),
            config.idempotency_ttl,
        );
        return None;
    }
    if control.is_read_only() {
        let error = OutboundError::read_only();
        diagnostics.record_rejection(&error);
        reject_without_idempotency_cache(task, error, config.idempotency_ttl);
        return None;
    }
    if task_expired(&task, Instant::now(), task_ttl) {
        let error = OutboundError::expired();
        diagnostics.record_rejection(&error);
        reject_without_idempotency_cache(task, error, config.idempotency_ttl);
        return None;
    }
    let policy = {
        let mut usage = usage.lock().expect("usage poisoned");
        policy_allows_send(
            config,
            &mut usage,
            &task.params.chat_id,
            Instant::now(),
            SystemTime::now(),
            local_minute_of_day(),
        )
    };
    match policy {
        Ok(_) => Some(task),
        Err(error) => {
            diagnostics.record_rejection(&error);
            reject_without_idempotency_cache(task, error, config.idempotency_ttl);
            None
        }
    }
}

fn task_expired(task: &OutboundTask, now: Instant, task_ttl: Duration) -> bool {
    now.duration_since(task.enqueued_at) > task_ttl
}

async fn execute_send(params: &SendMessageParams) -> SendResult {
    let session = match current_session() {
        Some(s) => s,
        None => return send_error("SESSION_UNAVAILABLE"),
    };

    if session.logged_in_user.is_none() {
        return send_error("NOT_LOGGED_IN");
    }

    let mut context = {
        let db = get_db();
        create_context(session, &db)
    };

    let plan = SendMessagePlan;
    let cancel = CancellationToken::new();
    let noop_emit = std::sync::Arc::new(|_: SubscriptionEvent| {});
    let (result, plan_state) =
        run_execution_loop(&plan, &params, &mut context, noop_emit, cancel).await;
    send_result_from_plan(result.success, &plan_state, result.error)
}

fn send_result_from_plan(
    success: bool,
    plan_state: &crate::plans::send_message::SendMessagePlanState,
    result_error: Option<String>,
) -> SendResult {
    let error = plan_state
        .diagnostic_error
        .clone()
        .or_else(|| result_error.as_deref().map(execution_error_code));
    SendResult {
        success,
        error_code: error.clone(),
        error,
        commit_attempted: plan_state.send_action_executed,
    }
}

fn execution_error_code(error: &str) -> String {
    match error {
        "Aborted" => "EXECUTION_ABORTED",
        "No action selected" => "NO_ACTION_SELECTED",
        "Max steps reached" => "MAX_STEPS_REACHED",
        _ if error.starts_with("Execution timeout") => "EXECUTION_TIMEOUT",
        _ if error.starts_with("Unknown state") => "UNKNOWN_UI_STATE_TIMEOUT",
        _ => "SEND_EXECUTION_FAILED",
    }
    .to_string()
}

fn is_uncertain_result(result: &SendResult) -> bool {
    !result.success
        && (result.commit_attempted
            || matches!(
                result.error_code.as_deref(),
                Some(
                    "send_commit_uncertain"
                        | "send_result_uncertain"
                        | "popup_after_send_action"
                        | "composer_missing_during_confirmation"
                )
            ))
}

fn counts_toward_usage(result: &SendResult) -> bool {
    result.success || result.commit_attempted
}

fn apply_send_result_to_usage(
    usage: &Mutex<Usage>,
    result: &SendResult,
    chat_id: &str,
    now: Instant,
    wall: SystemTime,
) {
    if counts_toward_usage(result) {
        usage
            .lock()
            .expect("usage poisoned")
            .record_success(chat_id, now, wall);
    }
}

fn complete_task(
    mut task: OutboundTask,
    result: SendResult,
    idempotency_ttl: Duration,
    control: Option<&OutboundControl>,
) {
    cleanup_temp_files(&task.params);
    if let Some(key) = task.idempotency_key.as_deref() {
        if let Err(error) =
            persist_result(key, task.idempotency_generation, &result, idempotency_ttl)
        {
            log_persist_failure("terminal_result", &error);
            if mark_needs_reconciliation(
                key,
                task.idempotency_generation,
                result.commit_attempted,
                idempotency_ttl,
            ) {
                if let Some(lease) = &mut task.idempotency_lease {
                    lease.disarm();
                }
            } else {
                tracing::error!(
                    op = "terminal_reconciliation",
                    code = "SQLITE_NO_ROWS",
                    "[outbound] idempotency persistence failed"
                );
            }
            if let Some(control) = control {
                control.set_runtime_paused(true);
            }
            let _ =
                task.result_tx
                    .send(OutboundSendResponse::Rejected(OutboundError::persistence(
                        result.commit_attempted,
                    )));
            return;
        }
        if let Some(lease) = &mut task.idempotency_lease {
            lease.disarm();
        }
    }
    let _ = task.result_tx.send(OutboundSendResponse::Result(result));
}

fn reject_without_idempotency_cache(
    mut task: OutboundTask,
    error: OutboundError,
    idempotency_ttl: Duration,
) {
    cleanup_temp_files(&task.params);
    if let Some(key) = task.idempotency_key.as_deref() {
        let state = if error.kind == OutboundErrorKind::Expired {
            OutboundIdempotencyState::Expired
        } else {
            OutboundIdempotencyState::Rejected
        };
        if let Err(err) = persist_rejection(
            key,
            task.idempotency_generation,
            state,
            &error.code,
            idempotency_ttl,
        ) {
            log_persist_failure("rejection", &err);
            let _ =
                task.result_tx
                    .send(OutboundSendResponse::Rejected(OutboundError::persistence(
                        false,
                    )));
            return;
        }
        if let Some(lease) = &mut task.idempotency_lease {
            lease.disarm();
        }
    }
    let _ = task.result_tx.send(OutboundSendResponse::Rejected(error));
}

pub fn cleanup_temp_files(params: &SendMessageParams) {
    if let Some(path) = &params.image_path {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = &params.file_path {
        let _ = std::fs::remove_file(path);
    }
}

fn send_error(error: &str) -> SendResult {
    SendResult {
        success: false,
        error_code: Some(error.to_string()),
        error: Some(error.to_string()),
        commit_attempted: false,
    }
}

enum IdempotencyStart {
    Inserted(i64),
    InProgress,
    NeedsReconciliation,
    Completed(SendResult),
    Capacity,
}

fn try_claim_idempotency(key: &str, ttl: Duration) -> rusqlite::Result<IdempotencyStart> {
    try_claim_idempotency_limited(key, ttl, idempotency_max_rows())
}

fn try_claim_idempotency_limited(
    key: &str,
    ttl: Duration,
    max_rows: usize,
) -> rusqlite::Result<IdempotencyStart> {
    #[cfg(test)]
    if consume_hostile_claim_failure() {
        return Err(hostile_sqlite_error());
    }
    let db = get_db();
    if let Err(error) = sweep_outbound_idempotency(&db, max_rows) {
        log_persist_failure("sweep", &error);
    }
    Ok(match admit_outbound_claim(&db, key, ttl, max_rows)? {
        OutboundAdmit::Inserted(generation) => IdempotencyStart::Inserted(generation),
        OutboundAdmit::Completed(result) => IdempotencyStart::Completed(result),
        OutboundAdmit::InProgress => IdempotencyStart::InProgress,
        OutboundAdmit::NeedsReconciliation => IdempotencyStart::NeedsReconciliation,
        OutboundAdmit::Capacity => IdempotencyStart::Capacity,
    })
}

fn persist_sending(key: &str, generation: Option<i64>) -> rusqlite::Result<()> {
    #[cfg(test)]
    if consume_persistence_failure(&FAIL_SENDING_PERSISTENCE_FOR, key) {
        return Err(hostile_sqlite_error());
    }
    let generation = generation.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let db = get_db();
    if mark_outbound_sending(&db, key, generation)? {
        Ok(())
    } else {
        Err(rusqlite::Error::QueryReturnedNoRows)
    }
}

fn persist_result(
    key: &str,
    generation: Option<i64>,
    result: &SendResult,
    ttl: Duration,
) -> rusqlite::Result<()> {
    #[cfg(test)]
    if consume_persistence_failure(&FAIL_RESULT_PERSISTENCE_FOR, key) {
        return Err(hostile_sqlite_error());
    }
    let generation = generation.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let db = get_db();
    if complete_outbound_result(&db, key, generation, result, ttl)? {
        Ok(())
    } else {
        Err(rusqlite::Error::QueryReturnedNoRows)
    }
}

fn persist_rejection(
    key: &str,
    generation: Option<i64>,
    state: OutboundIdempotencyState,
    error_code: &str,
    ttl: Duration,
) -> rusqlite::Result<()> {
    #[cfg(test)]
    if consume_persistence_failure(&FAIL_REJECTION_PERSISTENCE_FOR, key) {
        return Err(hostile_sqlite_error());
    }
    let db = get_db();
    if reject_outbound_pre_execution(&db, key, generation, state, error_code, ttl)? {
        Ok(())
    } else {
        Err(rusqlite::Error::QueryReturnedNoRows)
    }
}

#[cfg(test)]
fn fail_next_persistence_for(slot: &OnceLock<Mutex<Option<String>>>, key: &str) {
    let mut guard = slot
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("persistence fault slot poisoned");
    *guard = Some(key.to_string());
}

#[cfg(test)]
fn consume_persistence_failure(slot: &OnceLock<Mutex<Option<String>>>, key: &str) -> bool {
    let mut guard = slot
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("persistence fault slot poisoned");
    if guard.as_deref() == Some(key) {
        *guard = None;
        true
    } else {
        false
    }
}

#[cfg(test)]
static IDEMPOTENCY_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_idempotency_tests() -> std::sync::MutexGuard<'static, ()> {
    IDEMPOTENCY_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
fn clear_persistence_faults() {
    for slot in [
        &FAIL_SENDING_PERSISTENCE_FOR,
        &FAIL_RESULT_PERSISTENCE_FOR,
        &FAIL_REJECTION_PERSISTENCE_FOR,
        &FAIL_RECONCILE_PERSISTENCE_FOR,
    ] {
        if let Some(mutex) = slot.get() {
            *mutex.lock().expect("persistence fault slot poisoned") = None;
        }
    }
    if let Some(mutex) = FAIL_CLAIM_WITH_HOSTILE_ERROR.get() {
        *mutex.lock().expect("claim fault slot poisoned") = false;
    }
    if let Some(mutex) = FAIL_MANUAL_RECONCILE_WITH_HOSTILE_ERROR.get() {
        *mutex.lock().expect("reconcile fault slot poisoned") = false;
    }
}

fn mark_needs_reconciliation(
    key: &str,
    generation: Option<i64>,
    commit_attempted: bool,
    ttl: Duration,
) -> bool {
    #[cfg(test)]
    if consume_persistence_failure(&FAIL_RECONCILE_PERSISTENCE_FOR, key) {
        log_persist_failure("reconciliation", &hostile_sqlite_error());
        return false;
    }
    let db = get_db();
    match mark_outbound_needs_reconciliation(
        &db,
        key,
        generation,
        "IDEMPOTENCY_RECONCILIATION_REQUIRED",
        commit_attempted,
        ttl,
    ) {
        Ok(affected) if affected > 0 => true,
        Ok(_) => {
            tracing::error!(
                op = "reconciliation",
                code = "SQLITE_NO_ROWS",
                "[outbound] idempotency persistence failed"
            );
            false
        }
        Err(error) => {
            log_persist_failure("reconciliation", &error);
            false
        }
    }
}

fn persist_unknown_worker_result(
    key: &str,
    generation: Option<i64>,
    ttl: Duration,
) -> rusqlite::Result<()> {
    if mark_needs_reconciliation(key, generation, true, ttl) {
        return Ok(());
    }
    let db = get_db();
    match get_outbound_idempotency(&db, key)? {
        Some(record)
            if record.state.is_completed_execution()
                || matches!(
                    record.state,
                    OutboundIdempotencyState::NeedsReconciliation
                        | OutboundIdempotencyState::Rejected
                        | OutboundIdempotencyState::Expired
                ) =>
        {
            Ok(())
        }
        _ => Err(rusqlite::Error::QueryReturnedNoRows),
    }
}

fn persist_read_only_rejection(key: &str, ttl: Duration) -> rusqlite::Result<()> {
    let db = get_db();
    reject_outbound_unless_active_or_completed(
        &db,
        key,
        OutboundIdempotencyState::Rejected,
        "OUTBOUND_DISABLED",
        ttl,
    )
}

enum IdempotencyReplay {
    None,
    InProgress,
    NeedsReconciliation,
    Completed(SendResult),
}

fn replay_from_record(record: Option<OutboundIdempotencyRecord>) -> IdempotencyReplay {
    match record {
        Some(record) if record.state.is_completed_execution() => IdempotencyReplay::Completed(
            record
                .result
                .unwrap_or_else(|| send_error("REPLAY_UNAVAILABLE")),
        ),
        Some(record)
            if matches!(
                record.state,
                OutboundIdempotencyState::Queued | OutboundIdempotencyState::Sending
            ) =>
        {
            IdempotencyReplay::InProgress
        }
        Some(record) if record.state == OutboundIdempotencyState::NeedsReconciliation => {
            IdempotencyReplay::NeedsReconciliation
        }
        _ => IdempotencyReplay::None,
    }
}

fn expire_and_replay_idempotency(key: &str) -> rusqlite::Result<IdempotencyReplay> {
    let db = get_db();
    expire_outbound_if_stale(&db, key)?;
    sweep_persistent_idempotency(&db);
    Ok(replay_from_record(get_outbound_idempotency(&db, key)?))
}

pub fn validate_idempotency_key(key: &str) -> Result<(), &'static str> {
    if key.is_empty() || key.len() > IDEMPOTENCY_KEY_MAX_BYTES {
        return Err("invalid length");
    }
    if key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err("invalid characters")
    }
}

fn count_persistent_idempotency() -> usize {
    try_get_db()
        .map(|db| {
            sweep_persistent_idempotency(&db);
            count_outbound_idempotency(&db)
        })
        .unwrap_or(0)
}

pub fn get_idempotency_status(key: &str) -> Option<OutboundIdempotencyRecord> {
    if validate_idempotency_key(key).is_err() {
        return None;
    }
    let db = get_db();
    let _ = expire_outbound_if_stale(&db, key);
    get_outbound_idempotency(&db, key).ok().flatten()
}

pub fn manually_reconcile_idempotency(key: &str, ttl: Duration) -> rusqlite::Result<bool> {
    if validate_idempotency_key(key).is_err() {
        return Ok(false);
    }
    #[cfg(test)]
    if consume_manual_reconcile_hostile_failure() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ffi::ErrorCode::DatabaseCorrupt,
                extended_code: 0,
            },
            Some(
                "hostile path=/Users/kyan/private/agent.db SQL=UPDATE outbound_idempotency provider=sqlcipher key=hostile-secret-key"
                    .to_string(),
            ),
        ));
    }
    let db = get_db();
    reconcile_outbound_idempotency(
        &db,
        key,
        OutboundIdempotencyState::Uncertain,
        "MANUAL_RECONCILIATION_REQUIRED",
        ttl,
    )
}

#[cfg(test)]
pub(crate) fn fail_next_manual_reconcile_with_hostile_error() {
    let mut guard = FAIL_MANUAL_RECONCILE_WITH_HOSTILE_ERROR
        .get_or_init(|| Mutex::new(false))
        .lock()
        .expect("manual reconcile fault slot poisoned");
    *guard = true;
}

#[cfg(test)]
fn consume_manual_reconcile_hostile_failure() -> bool {
    let mut guard = FAIL_MANUAL_RECONCILE_WITH_HOSTILE_ERROR
        .get_or_init(|| Mutex::new(false))
        .lock()
        .expect("manual reconcile fault slot poisoned");
    let fail = *guard;
    *guard = false;
    fail
}

trait JitterSource {
    fn next_jitter(&mut self, max: Duration) -> Duration;
}

struct SystemJitter;

impl JitterSource for SystemJitter {
    fn next_jitter(&mut self, max: Duration) -> Duration {
        if max.is_zero() {
            return Duration::ZERO;
        }
        let max_ms = max.as_millis() as u64;
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        Duration::from_millis(seed % (max_ms + 1))
    }
}

struct SpacingPolicy {
    min_spacing: Duration,
    jitter: Duration,
    long_tail_jitter: Duration,
    long_tail_chance_percent: u32,
    next_allowed: Option<Instant>,
}

impl SpacingPolicy {
    fn new(
        min_spacing: Duration,
        jitter: Duration,
        long_tail_jitter: Duration,
        long_tail_chance_percent: u32,
    ) -> Self {
        Self {
            min_spacing,
            jitter,
            long_tail_jitter,
            long_tail_chance_percent,
            next_allowed: None,
        }
    }

    fn next_delay(&self, now: Instant) -> Duration {
        self.next_allowed.map_or(Duration::ZERO, |next_allowed| {
            next_allowed.saturating_duration_since(now)
        })
    }

    fn record_attempt(&mut self, now: Instant, jitter: &mut impl JitterSource) {
        let regular_jitter = jitter.next_jitter(self.jitter);
        let long_tail = if self.long_tail_chance_percent > 0
            && jitter.next_jitter(Duration::from_millis(99)).as_millis()
                < self.long_tail_chance_percent as u128
        {
            jitter.next_jitter(self.long_tail_jitter)
        } else {
            Duration::ZERO
        };
        self.next_allowed = Some(now + self.min_spacing + regular_jitter + long_tail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::count_protected_outbound_idempotency;
    use std::{collections::VecDeque, sync::Once};

    static INIT_DB: Once = Once::new();

    fn init_test_db() {
        INIT_DB.call_once(|| {
            let dir = tempfile::TempDir::new().unwrap();
            let path = dir.path().join("outbound-test.db");
            std::env::set_var("AGENT_DB_PATH", &path);
            std::env::set_var("AGENT_WECHAT_TOKEN", "test-token");
            crate::router::auth::init_token();
            let _ = crate::db::init_db();
            std::mem::forget(dir);
        });
    }

    fn clear_idempotency_rows() -> std::sync::MutexGuard<'static, ()> {
        let guard = lock_idempotency_tests();
        init_test_db();
        clear_persistence_faults();
        if let Some(db) = crate::db::try_get_db() {
            db.execute("DELETE FROM outbound_idempotency", []).ok();
        }
        guard
    }

    fn test_executor() -> ExecuteSend {
        Arc::new(|_params| Box::pin(async { send_error("TEST_EXECUTOR") }))
    }

    fn test_sender_with_channel(
        config: OutboundConfig,
        control: Arc<OutboundControl>,
        tx: mpsc::UnboundedSender<OutboundTask>,
    ) -> OutboundSender {
        let capacity = Arc::new(tokio::sync::Semaphore::new(config.queue_capacity));
        let similarity = Arc::new(Mutex::new(SimilarityGuard::new(&config)));
        OutboundSender {
            config,
            control,
            tx,
            capacity,
            usage: Arc::new(Mutex::new(Usage::new())),
            similarity,
            next_similarity_id: Arc::new(AtomicU64::new(1)),
            diagnostics: Arc::new(OutboundDiagnostics::default()),
            execute: test_executor(),
        }
    }

    fn claim_idempotency(key: &str, ttl: Duration) -> IdempotencyStart {
        try_claim_idempotency(key, ttl).unwrap()
    }

    fn generation_for(key: &str) -> i64 {
        get_idempotency_status(key).unwrap().generation
    }

    fn lease_for(key: &str) -> IdempotencyClaimLease {
        IdempotencyClaimLease::new(
            key.to_string(),
            generation_for(key),
            Duration::from_secs(60),
        )
    }

    fn persist_terminal_for_test(key: &str, result: &SendResult, ttl: Duration) {
        let generation = generation_for(key);
        persist_sending(key, Some(generation)).unwrap();
        persist_result(key, Some(generation), result, ttl).unwrap();
    }

    struct LogBuffer(std::sync::Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuffer {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("log buffer poisoned")
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuffer {
        type Writer = Self;

        fn make_writer(&'a self) -> Self::Writer {
            Self(std::sync::Arc::clone(&self.0))
        }
    }

    fn capture_logs(run: impl FnOnce()) -> String {
        let buf = std::sync::Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(LogBuffer(std::sync::Arc::clone(&buf)))
            .with_ansi(false)
            .with_level(true)
            .finish();
        tracing::subscriber::with_default(subscriber, run);
        let logs = String::from_utf8(buf.lock().expect("log buffer poisoned").clone()).unwrap();
        logs
    }

    fn assert_logs_redacted(logs: &str) {
        assert!(
            logs.contains("SQLITE_CORRUPT")
                || logs.contains("SQLITE_NO_ROWS")
                || logs.contains("SQLITE_FAILURE")
                || logs.contains("SQLITE_ERROR"),
            "expected a coarse sqlite code in logs: {logs}"
        );
        for forbidden in [
            "hostile-secret-key",
            "/Users/kyan/private/agent.db",
            "UPDATE outbound_idempotency",
            "sqlcipher",
            "provider=sqlcipher",
        ] {
            assert!(!logs.contains(forbidden), "leaked {forbidden} in {logs}");
        }
    }

    struct FixedJitter {
        values: VecDeque<Duration>,
    }

    impl FixedJitter {
        fn new(values: impl IntoIterator<Item = Duration>) -> Self {
            Self {
                values: values.into_iter().collect(),
            }
        }
    }

    impl JitterSource for FixedJitter {
        fn next_jitter(&mut self, max: Duration) -> Duration {
            self.values.pop_front().unwrap_or(Duration::ZERO).min(max)
        }
    }

    #[test]
    fn spacing_policy_applies_min_spacing_and_jitter_deterministically() {
        let start = Instant::now();
        let mut policy = SpacingPolicy::new(
            Duration::from_millis(100),
            Duration::from_millis(25),
            Duration::ZERO,
            0,
        );
        let mut jitter = FixedJitter::new([
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::from_millis(0),
        ]);

        assert_eq!(policy.next_delay(start), Duration::ZERO);
        policy.record_attempt(start, &mut jitter);
        assert_eq!(
            policy.next_delay(start + Duration::from_millis(50)),
            Duration::from_millis(60)
        );
        policy.record_attempt(start + Duration::from_millis(120), &mut jitter);
        assert_eq!(
            policy.next_delay(start + Duration::from_millis(150)),
            Duration::from_millis(90)
        );
    }

    #[test]
    fn idempotency_replays_completed_result_and_blocks_in_progress_duplicate() {
        let _idempotency_lock = clear_idempotency_rows();

        assert!(matches!(
            claim_idempotency("replay-k", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        assert!(matches!(
            claim_idempotency("replay-k", Duration::from_secs(60)),
            IdempotencyStart::InProgress
        ));
        persist_terminal_for_test(
            "replay-k",
            &SendResult {
                success: false,
                error_code: Some("UNCERTAIN_AFTER_SEND".to_string()),
                error: Some("UNCERTAIN_AFTER_SEND".to_string()),
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );

        match claim_idempotency("replay-k", Duration::from_secs(60)) {
            IdempotencyStart::Completed(result) => {
                assert!(!result.success);
                assert_eq!(result.error.as_deref(), Some("UNCERTAIN_AFTER_SEND"));
            }
            _ => panic!("expected completed replay"),
        }
    }

    #[test]
    fn idempotency_key_validation_rejects_hostile_values() {
        assert!(validate_idempotency_key("abc-123._:XYZ").is_ok());
        assert!(validate_idempotency_key(&"a".repeat(IDEMPOTENCY_KEY_MAX_BYTES)).is_ok());
        for key in [
            "",
            "has space",
            "slash/key",
            "line\nbreak",
            "control\u{7}",
            "汉字",
            "snowman-☃",
        ] {
            assert!(validate_idempotency_key(key).is_err(), "{key:?}");
        }
        assert!(validate_idempotency_key(&"a".repeat(IDEMPOTENCY_KEY_MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn completed_idempotency_key_can_be_reused_after_ttl() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("ttl-k", Duration::from_millis(1)),
            IdempotencyStart::Inserted(_)
        ));
        persist_terminal_for_test(
            "ttl-k",
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_millis(1),
        );
        std::thread::sleep(Duration::from_millis(5));
        assert!(matches!(
            claim_idempotency("ttl-k", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
    }

    #[test]
    fn in_progress_idempotency_key_does_not_expire_after_ttl() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("in-progress-k", Duration::from_millis(1)),
            IdempotencyStart::Inserted(_)
        ));
        std::thread::sleep(Duration::from_millis(5));
        assert!(matches!(
            claim_idempotency("in-progress-k", Duration::from_secs(60)),
            IdempotencyStart::InProgress
        ));
    }

    #[test]
    fn concurrent_same_key_admission_inserts_once() {
        let _idempotency_lock = clear_idempotency_rows();
        let inserted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let inserted = Arc::clone(&inserted);
                scope.spawn(move || {
                    if matches!(
                        claim_idempotency("concurrent", Duration::from_secs(60)),
                        IdempotencyStart::Inserted(_)
                    ) {
                        inserted.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(inserted.load(Ordering::SeqCst), 1);
        assert!(matches!(
            claim_idempotency("concurrent", Duration::from_secs(60)),
            IdempotencyStart::InProgress
        ));
    }

    #[test]
    fn persisted_queued_or_sending_blocks_duplicate_after_restart() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("restart-queued", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        assert!(matches!(
            claim_idempotency("restart-queued", Duration::from_secs(60)),
            IdempotencyStart::InProgress
        ));

        assert!(matches!(
            claim_idempotency("restart-sending", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        persist_sending("restart-sending", Some(generation_for("restart-sending"))).unwrap();
        assert!(matches!(
            claim_idempotency("restart-sending", Duration::from_secs(60)),
            IdempotencyStart::InProgress
        ));
    }

    #[test]
    fn manual_reconcile_marks_persisted_queued_uncertain_without_reclaim() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("manual-queued", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        assert!(manually_reconcile_idempotency("manual-queued", Duration::from_secs(60)).unwrap());
        let record = get_idempotency_status("manual-queued").unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::Uncertain);
        assert_eq!(
            record.result.unwrap().error_code.as_deref(),
            Some("MANUAL_RECONCILIATION_REQUIRED")
        );
        match claim_idempotency("manual-queued", Duration::from_secs(60)) {
            IdempotencyStart::Completed(result) => {
                assert!(!result.success);
                assert!(result.commit_attempted);
            }
            _ => panic!("manual reconciliation must become terminal replay, not a new claim"),
        }
    }

    #[test]
    fn dropped_claim_lease_marks_exact_queued_generation_needs_reconciliation() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "lease-drop-queued";
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let generation = generation_for(key);

        drop(IdempotencyClaimLease::new(
            key.to_string(),
            generation,
            Duration::from_secs(60),
        ));

        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        assert_eq!(
            record.result.unwrap().error_code.as_deref(),
            Some("IDEMPOTENCY_CLAIM_DROPPED")
        );
        assert!(manually_reconcile_idempotency(key, Duration::from_secs(60)).unwrap());
        match claim_idempotency(key, Duration::from_secs(60)) {
            IdempotencyStart::Completed(result) => {
                assert_eq!(
                    result.error_code.as_deref(),
                    Some("MANUAL_RECONCILIATION_REQUIRED")
                );
                assert!(result.commit_attempted);
            }
            _ => panic!("manual reconciliation must remain no-resend terminal replay"),
        }
    }

    #[test]
    fn dropped_old_generation_claim_lease_cannot_overwrite_reclaimed_key() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "lease-old-generation";
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let old_generation = generation_for(key);
        persist_rejection(
            key,
            Some(old_generation),
            OutboundIdempotencyState::Rejected,
            "IMAGE_BASE64_DECODE_FAILED",
            Duration::from_secs(60),
        )
        .unwrap();
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let new_generation = generation_for(key);

        drop(IdempotencyClaimLease::new(
            key.to_string(),
            old_generation,
            Duration::from_secs(60),
        ));

        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::Queued);
        assert_eq!(record.generation, new_generation);
    }

    #[tokio::test]
    async fn queued_task_owns_lease_after_caller_abort_until_runtime_drop() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "lease-after-try-send-abort";
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(false)), tx);

        let pending = tokio::spawn(async move {
            sender
                .send_claimed(test_params("queued"), Some(lease_for(key)))
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while rx.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        pending.abort();
        assert_eq!(
            get_idempotency_status(key).unwrap().state,
            OutboundIdempotencyState::Queued
        );

        let task = rx.recv().await.unwrap();
        drop(task);
        assert!(matches!(
            pending.await,
            Err(error) if error.is_cancelled()
        ));
        assert_eq!(
            get_idempotency_status(key).unwrap().state,
            OutboundIdempotencyState::NeedsReconciliation
        );
    }

    #[tokio::test]
    async fn dropping_receiver_before_worker_takes_task_reconciles_queued_lease() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "lease-runtime-shutdown";
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(false)), tx);
        let pending = tokio::spawn(async move {
            sender
                .send_claimed(test_params("shutdown"), Some(lease_for(key)))
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while rx.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        drop(rx);
        match pending.await.unwrap() {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Unavailable);
                assert!(!error.commit_attempted);
            }
            _ => panic!("closed receiver should fail closed after queued handoff"),
        }
        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        assert!(record.result.unwrap().commit_attempted);
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::NeedsReconciliation
        ));
    }

    #[tokio::test]
    async fn queue_bound_rejects_when_channel_is_full() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::from_secs(60),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(false)), tx);

        let permit = Arc::clone(&sender.capacity).try_acquire_owned().unwrap();
        let (result_tx, _result_rx) = oneshot::channel();
        sender
            .tx
            .send(OutboundTask {
                params: test_params("first"),
                enqueued_at: Instant::now(),
                idempotency_key: None,
                idempotency_generation: None,
                idempotency_lease: None,
                result_tx,
                _queue_permit: Some(permit),
                similarity_reservation: None,
            })
            .unwrap();

        match sender
            .send(test_params("second"), Some("queue-full".to_string()))
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::QueueFull);
                assert!(error.retry_after.is_some());
            }
            _ => panic!("expected queue full rejection"),
        }
        let record = get_idempotency_status("queue-full").unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::Rejected);
        assert_eq!(
            record.result.unwrap().error_code.as_deref(),
            Some("QUEUE_FULL")
        );
    }

    #[test]
    fn expired_task_returns_queue_expired_and_cleans_file() {
        let _idempotency_lock = clear_idempotency_rows();
        let temp = tempfile::NamedTempFile::new().unwrap();
        let path = temp.path().to_string_lossy().to_string();
        assert!(matches!(
            claim_idempotency("expired", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let (result_tx, mut result_rx) = oneshot::channel();
        let task = OutboundTask {
            params: SendMessageParams {
                chat_id: "chat".to_string(),
                message: Some("hello".to_string()),
                image_path: Some(path.clone()),
                image_mime: None,
                file_path: None,
                inbound_chars: None,
                source: None,
                similarity_confirmed: false,
            },
            enqueued_at: Instant::now() - Duration::from_secs(10),
            idempotency_key: Some("expired".to_string()),
            idempotency_generation: Some(generation_for("expired")),
            idempotency_lease: Some(lease_for("expired")),
            result_tx,
            _queue_permit: None,
            similarity_reservation: None,
        };
        reject_without_idempotency_cache(task, OutboundError::expired(), Duration::from_secs(60));

        let result = result_rx.try_recv().unwrap();
        match result {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Expired);
                assert_eq!(error.code, "QUEUE_EXPIRED");
            }
            _ => panic!("expected expired rejection"),
        }
        assert!(!std::path::Path::new(&path).exists());
        let record = get_idempotency_status("expired").unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::Expired);
        assert_eq!(
            record.result.unwrap().error_code.as_deref(),
            Some("QUEUE_EXPIRED")
        );
    }

    #[test]
    fn terminal_persistence_failure_returns_fail_closed_rejection() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("persist-fail", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        fail_next_persistence_for(&FAIL_RESULT_PERSISTENCE_FOR, "persist-fail");
        let (result_tx, mut result_rx) = oneshot::channel();
        let task = OutboundTask {
            params: test_params("persist-fail"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("persist-fail".to_string()),
            idempotency_generation: Some(generation_for("persist-fail")),
            idempotency_lease: None,
            result_tx,
            _queue_permit: None,
            similarity_reservation: None,
        };
        let control = OutboundControl::new(false);
        complete_task(
            task,
            SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
            Some(&control),
        );
        match result_rx.try_recv().unwrap() {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Persistence);
                assert!(error.commit_attempted);
            }
            _ => panic!("terminal persistence failure must not ack the send result"),
        }
        assert!(control.is_runtime_paused());
        assert_eq!(
            get_idempotency_status("persist-fail").unwrap().state,
            OutboundIdempotencyState::NeedsReconciliation
        );
    }

    #[test]
    fn unknown_worker_result_after_sending_is_needs_reconciliation_not_failed() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "unknown-after-sending";
        {
            let db = get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let generation = generation_for(key);
        persist_sending(key, Some(generation)).unwrap();
        persist_unknown_worker_result(key, Some(generation), Duration::from_secs(60)).unwrap();

        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        assert!(record.result.unwrap().commit_attempted);
        assert_ne!(record.state, OutboundIdempotencyState::Failed);
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::NeedsReconciliation
        ));
    }

    #[test]
    fn protected_capacity_rejects_new_keys_but_keeps_existing_and_survives_restart() {
        let _idempotency_lock = clear_idempotency_rows();
        let held = "cap-held";
        let extra = "cap-extra";
        let limit = {
            let db = get_db();
            db.execute(
                "DELETE FROM outbound_idempotency WHERE key IN (?1, ?2)",
                [held, extra],
            )
            .unwrap();
            count_protected_outbound_idempotency(&db) + 1
        };
        assert!(matches!(
            try_claim_idempotency_limited(held, Duration::from_secs(60), limit).unwrap(),
            IdempotencyStart::Inserted(_)
        ));
        assert!(matches!(
            try_claim_idempotency_limited(extra, Duration::from_secs(60), limit).unwrap(),
            IdempotencyStart::Capacity
        ));
        assert!(matches!(
            try_claim_idempotency_limited(held, Duration::from_secs(60), limit).unwrap(),
            IdempotencyStart::InProgress
        ));
        assert!(get_idempotency_status(extra).is_none());

        // Restart-equivalent: same durable rows, new claim attempt.
        assert!(matches!(
            try_claim_idempotency_limited(extra, Duration::from_secs(60), limit).unwrap(),
            IdempotencyStart::Capacity
        ));
        assert_eq!(
            get_idempotency_status(held).unwrap().state,
            OutboundIdempotencyState::Queued
        );

        persist_terminal_for_test(
            held,
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );
        assert_eq!(
            get_idempotency_status(held).unwrap().state,
            OutboundIdempotencyState::Sent
        );
        let limit_after_terminal = {
            let db = get_db();
            count_protected_outbound_idempotency(&db) + 1
        };
        assert!(matches!(
            try_claim_idempotency_limited(extra, Duration::from_secs(60), limit_after_terminal)
                .unwrap(),
            IdempotencyStart::Inserted(_)
        ));
    }

    #[tokio::test]
    async fn capacity_rejection_http_response_exposes_stable_code() {
        let response =
            OutboundSendResponse::Rejected(OutboundError::capacity(Duration::from_secs(2)))
                .into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("2")
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["success"], false);
        assert_eq!(json["errorCode"], "IDEMPOTENCY_CAPACITY");
        assert_eq!(json["commitAttempted"], false);
    }

    #[tokio::test]
    async fn send_claimed_oneshot_close_after_sending_does_not_persist_failed() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "oneshot-close-after-sending";
        {
            let db = get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        persist_sending(key, Some(generation_for(key))).unwrap();
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let dropper = tokio::spawn(async move {
            let task = rx.recv().await.unwrap();
            drop(task);
        });
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(false)), tx);
        let mut lease = lease_for(key);
        lease.enter_sending();
        match sender
            .send_claimed(test_params("closed after sending"), Some(lease))
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Unavailable);
            }
            _ => panic!("missing worker result must not become a replayable send result"),
        }
        dropper.await.unwrap();
        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        assert!(record.result.unwrap().commit_attempted);
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::NeedsReconciliation
        ));
    }

    #[test]
    fn dropped_sending_lease_marks_exact_generation_needs_reconciliation() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "lease-drop-sending";
        {
            let db = get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let generation = generation_for(key);
        persist_sending(key, Some(generation)).unwrap();
        let mut lease =
            IdempotencyClaimLease::new(key.to_string(), generation, Duration::from_secs(60));
        lease.enter_sending();
        drop(lease);

        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        let result = record.result.unwrap();
        assert_eq!(
            result.error_code.as_deref(),
            Some("IDEMPOTENCY_SENDING_DROPPED")
        );
        assert!(result.commit_attempted);
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::NeedsReconciliation
        ));
    }

    #[test]
    fn dropped_sending_lease_cannot_overwrite_terminal_or_other_generation() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "lease-sending-stale";
        {
            let db = get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        persist_terminal_for_test(
            key,
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );
        let mut stale = IdempotencyClaimLease::new(key.to_string(), 1, Duration::from_secs(60));
        stale.enter_sending();
        drop(stale);
        assert_eq!(
            get_idempotency_status(key).unwrap().state,
            OutboundIdempotencyState::Sent
        );
    }

    #[test]
    fn persist_error_code_is_coarse_and_redacts_hostile_sqlite_text() {
        let hostile = hostile_sqlite_error();
        let code = persist_error_code(&hostile);
        assert_eq!(code, "SQLITE_CORRUPT");
        for forbidden in [
            "hostile-secret-key",
            "/Users/kyan/private/agent.db",
            "UPDATE outbound_idempotency",
            "sqlcipher",
        ] {
            assert!(!code.contains(forbidden), "{forbidden}");
        }
        assert_eq!(
            persist_error_code(&rusqlite::Error::QueryReturnedNoRows),
            "SQLITE_NO_ROWS"
        );
    }

    #[test]
    fn persistence_paths_log_only_coarse_codes_for_hostile_sqlite_errors() {
        let _idempotency_lock = clear_idempotency_rows();
        let logs = capture_logs(|| {
            fail_next_claim_with_hostile_error();
            let config = OutboundConfig {
                queue_capacity: 1,
                min_spacing: Duration::ZERO,
                jitter: Duration::ZERO,
                task_ttl: Duration::from_secs(60),
                idempotency_ttl: Duration::from_secs(60),
                chat_cooldown: Duration::ZERO,
                hourly_budget: 10_000,
                daily_budget: 10_000,
                quiet_start_min: 0,
                quiet_end_min: 0,
                read_only: false,
                long_tail_jitter: Duration::ZERO,
                long_tail_chance_percent: 0,
                similarity_window: Duration::from_secs(600),
                similarity_min_chars: 20,
                similarity_hamming: 8,
                similarity_history: 200,
            };
            let (tx, _rx) = mpsc::unbounded_channel();
            let sender =
                test_sender_with_channel(config, Arc::new(OutboundControl::new(false)), tx);
            let _ = sender.admit_idempotency_key("claim-hostile");
            for (op, error) in [
                ("pre_execution_rejection", hostile_sqlite_error()),
                ("sending", hostile_sqlite_error()),
                ("terminal_result", hostile_sqlite_error()),
                ("reconciliation", hostile_sqlite_error()),
            ] {
                log_persist_failure(op, &error);
            }
        });
        assert_logs_redacted(&logs);
        assert!(logs.contains("claim"), "{logs}");
        assert!(
            logs.contains("pre_execution_rejection") || logs.contains("rejection"),
            "{logs}"
        );
        assert!(logs.contains("sending"), "{logs}");
        assert!(logs.contains("terminal_result"), "{logs}");
        assert!(logs.contains("reconciliation"), "{logs}");
    }

    #[test]
    fn sending_and_rejection_persistence_failures_are_visible() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("sending-fail", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        fail_next_persistence_for(&FAIL_SENDING_PERSISTENCE_FOR, "sending-fail");
        assert!(persist_sending("sending-fail", Some(generation_for("sending-fail"))).is_err());

        assert!(matches!(
            claim_idempotency("reject-fail", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        fail_next_persistence_for(&FAIL_REJECTION_PERSISTENCE_FOR, "reject-fail");
        assert!(persist_rejection(
            "reject-fail",
            Some(generation_for("reject-fail")),
            OutboundIdempotencyState::Rejected,
            "QUEUE_FULL",
            Duration::from_secs(60)
        )
        .is_err());
    }

    #[tokio::test]
    async fn worker_sending_persistence_failure_marks_reconciliation_and_pauses() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "worker-sending-persist-fail";
        {
            let db = get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let control = Arc::new(OutboundControl::new(false));
        let (tx, rx) = mpsc::unbounded_channel();
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(
            config,
            Arc::clone(&control),
            rx,
            usage,
            Arc::new(OutboundDiagnostics::default()),
            test_executor(),
        ));
        let (result_tx, result_rx) = oneshot::channel();

        fail_next_persistence_for(&FAIL_SENDING_PERSISTENCE_FOR, key);
        tx.send(OutboundTask {
            params: test_params("will not execute"),
            enqueued_at: Instant::now(),
            idempotency_key: Some(key.to_string()),
            idempotency_generation: Some(generation_for(key)),
            idempotency_lease: Some(lease_for(key)),
            result_tx,
            _queue_permit: None,
            similarity_reservation: None,
        })
        .unwrap();

        match result_rx.await.unwrap() {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Persistence);
                assert!(!error.commit_attempted);
            }
            _ => panic!("sending persistence failure must fail closed"),
        }
        assert!(control.is_runtime_paused());
        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        assert_eq!(
            record.result.unwrap().error_code.as_deref(),
            Some("IDEMPOTENCY_RECONCILIATION_REQUIRED")
        );
        assert!(matches!(
            claim_idempotency(key, Duration::from_secs(60)),
            IdempotencyStart::NeedsReconciliation
        ));
        assert!(manually_reconcile_idempotency(key, Duration::from_secs(60)).unwrap());
        match claim_idempotency(key, Duration::from_secs(60)) {
            IdempotencyStart::Completed(result) => {
                assert!(!result.success);
                assert!(result.commit_attempted);
            }
            _ => panic!("manual reconciliation must produce terminal replay"),
        }

        drop(tx);
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn kill_switch_rejects_without_queueing() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: true,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(true)), tx);

        match sender
            .send(test_params("blocked"), Some("k".to_string()))
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::ReadOnly);
                assert!(error.retry_after.is_none());
            }
            _ => panic!("expected read-only rejection"),
        }
        assert_eq!(
            get_idempotency_status("k").unwrap().state,
            OutboundIdempotencyState::Rejected
        );
    }

    #[tokio::test]
    async fn read_only_duplicate_does_not_overwrite_queued_idempotency() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("paused-queued", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: true,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(true)), tx);

        match sender
            .send(test_params("duplicate"), Some("paused-queued".into()))
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::DuplicateInProgress);
            }
            _ => panic!("expected in-progress replay"),
        }
        assert_eq!(
            get_idempotency_status("paused-queued").unwrap().state,
            OutboundIdempotencyState::Queued
        );
    }

    #[tokio::test]
    async fn read_only_duplicate_replays_terminal_idempotency() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("paused-terminal", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        persist_terminal_for_test(
            "paused-terminal",
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: true,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(true)), tx);

        match sender
            .send(test_params("duplicate"), Some("paused-terminal".into()))
            .await
        {
            OutboundSendResponse::Result(result) => assert!(result.success),
            OutboundSendResponse::Rejected(error) => {
                panic!("terminal replay must not be rejected as {}", error.code)
            }
        }
        assert_eq!(
            get_idempotency_status("paused-terminal").unwrap().state,
            OutboundIdempotencyState::Sent
        );
    }

    #[tokio::test]
    async fn read_only_admission_expires_stale_terminal_instead_of_replaying() {
        let _idempotency_lock = clear_idempotency_rows();
        let key = "paused-expired-terminal";
        {
            let db = get_db();
            db.execute("DELETE FROM outbound_idempotency WHERE key = ?1", [key])
                .unwrap();
        }
        assert!(matches!(
            claim_idempotency(key, Duration::from_millis(1)),
            IdempotencyStart::Inserted(_)
        ));
        persist_terminal_for_test(
            key,
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_millis(1),
        );
        std::thread::sleep(Duration::from_millis(5));
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: true,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(true)), tx);

        match sender
            .send(test_params("expired replay"), Some(key.into()))
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::ReadOnly);
            }
            OutboundSendResponse::Result(_) => {
                panic!("paused admission must not replay a TTL-expired terminal result")
            }
        }
        let record = get_idempotency_status(key).unwrap();
        assert_ne!(record.state, OutboundIdempotencyState::Sent);
    }

    #[tokio::test]
    async fn resume_after_paused_duplicate_replays_once_without_requeueing() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("resume-once", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(true)), tx);

        match sender
            .send(
                test_params("duplicate while paused"),
                Some("resume-once".into()),
            )
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::DuplicateInProgress);
            }
            _ => panic!("expected paused duplicate to be treated as in-progress"),
        }
        sender.resume();
        persist_terminal_for_test(
            "resume-once",
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );
        match sender
            .send(
                test_params("replay after resume"),
                Some("resume-once".into()),
            )
            .await
        {
            OutboundSendResponse::Result(result) => assert!(result.success),
            OutboundSendResponse::Rejected(error) => {
                panic!(
                    "completed resume replay must not be rejected as {}",
                    error.code
                )
            }
        }
        assert_eq!(sender.status().queue_depth, 0);
    }

    #[tokio::test]
    async fn queued_task_rechecks_pause_after_spacing_delay() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(25),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let control = Arc::new(OutboundControl::new(true));
        let (tx, rx) = mpsc::unbounded_channel();
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(
            config,
            Arc::clone(&control),
            rx,
            usage,
            Arc::new(OutboundDiagnostics::default()),
            test_executor(),
        ));

        let (first_tx, first_rx) = oneshot::channel();
        assert!(matches!(
            claim_idempotency("pause-first", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.send(OutboundTask {
            params: test_params("first"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("pause-first".to_string()),
            idempotency_generation: Some(generation_for("pause-first")),
            idempotency_lease: Some(lease_for("pause-first")),
            result_tx: first_tx,
            _queue_permit: None,
            similarity_reservation: None,
        })
        .unwrap();
        let first = first_rx.await.unwrap();
        match first {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::ReadOnly);
            }
            _ => panic!("expected read-only rejection"),
        }

        let (second_tx, second_rx) = oneshot::channel();
        control.set_read_only(false);
        assert!(matches!(
            claim_idempotency("pause-second", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.send(OutboundTask {
            params: test_params("second"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("pause-second".to_string()),
            idempotency_generation: Some(generation_for("pause-second")),
            idempotency_lease: Some(lease_for("pause-second")),
            result_tx: second_tx,
            _queue_permit: None,
            similarity_reservation: None,
        })
        .unwrap();
        control.set_read_only(true);

        let second = second_rx.await.unwrap();
        match second {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::ReadOnly);
            }
            _ => panic!("expected read-only rejection"),
        }
        assert_eq!(
            get_idempotency_status("pause-second").unwrap().state,
            OutboundIdempotencyState::Rejected
        );

        drop(tx);
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn queued_task_rechecks_ttl_after_spacing_delay() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(30),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_millis(10),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::from_millis(30),
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let control = Arc::new(OutboundControl::new(true));
        let (tx, rx) = mpsc::unbounded_channel();
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(
            config,
            Arc::clone(&control),
            rx,
            Arc::clone(&usage),
            Arc::new(OutboundDiagnostics::default()),
            test_executor(),
        ));

        let (first_tx, first_rx) = oneshot::channel();
        assert!(matches!(
            claim_idempotency("ttl-first", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.send(OutboundTask {
            params: test_params("first"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("ttl-first".to_string()),
            idempotency_generation: Some(generation_for("ttl-first")),
            idempotency_lease: Some(lease_for("ttl-first")),
            result_tx: first_tx,
            _queue_permit: None,
            similarity_reservation: None,
        })
        .unwrap();
        let first = first_rx.await.unwrap();
        match first {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::ReadOnly);
            }
            _ => panic!("expected read-only rejection"),
        }

        usage
            .lock()
            .unwrap()
            .last_per_chat
            .insert("chat".to_string(), Instant::now());
        let (second_tx, second_rx) = oneshot::channel();
        control.set_read_only(false);
        assert!(matches!(
            claim_idempotency("ttl-second", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.send(OutboundTask {
            params: test_params("second"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("ttl-second".to_string()),
            idempotency_generation: Some(generation_for("ttl-second")),
            idempotency_lease: Some(lease_for("ttl-second")),
            result_tx: second_tx,
            _queue_permit: None,
            similarity_reservation: None,
        })
        .unwrap();

        let second = second_rx.await.unwrap();
        match second {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Expired);
            }
            _ => panic!("expected expired rejection"),
        }
        assert_eq!(
            get_idempotency_status("ttl-second").unwrap().state,
            OutboundIdempotencyState::Expired
        );

        drop(tx);
        worker.await.unwrap();
    }

    #[test]
    fn status_reports_queue_config_and_idempotency_entries() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(150),
            jitter: Duration::from_millis(25),
            task_ttl: Duration::from_secs(30),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: true,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(true)), tx);

        assert!(matches!(
            claim_idempotency("status-key", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));

        let status = sender.status();
        assert_eq!(status.queue_capacity, 2);
        assert_eq!(status.queue_depth, 0);
        assert_eq!(status.available_capacity, 2);
        assert_eq!(status.min_spacing_ms, 150);
        assert_eq!(status.jitter_ms, 25);
        assert_eq!(status.task_ttl_ms, 30_000);
        assert_eq!(status.idempotency_ttl_ms, 60_000);
        assert!(status.read_only);
        assert!(status.runtime_paused);
        assert!(status.idempotency_entries >= 1);
    }

    fn test_params(text: &str) -> SendMessageParams {
        SendMessageParams {
            chat_id: "chat".to_string(),
            message: Some(text.to_string()),
            image_path: None,
            image_mime: None,
            file_path: None,
            inbound_chars: None,
            source: None,
            similarity_confirmed: false,
        }
    }

    #[test]
    fn uncertain_terminal_result_is_cached_and_not_retried() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("uncertain-k", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        persist_terminal_for_test(
            "uncertain-k",
            &SendResult {
                success: false,
                error_code: Some("send_commit_uncertain".into()),
                error: Some("send_commit_uncertain".into()),
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );
        assert_eq!(
            get_idempotency_status("uncertain-k").unwrap().state,
            OutboundIdempotencyState::Uncertain
        );
        match claim_idempotency("uncertain-k", Duration::from_secs(60)) {
            IdempotencyStart::Completed(result) => {
                assert!(!result.success);
                assert_eq!(result.error_code.as_deref(), Some("send_commit_uncertain"));
            }
            _ => panic!("expected cached uncertain result"),
        }
    }

    #[tokio::test]
    async fn completed_replay_beats_quiet_hours_policy() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 24 * 60,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = test_sender_with_channel(config, Arc::new(OutboundControl::new(false)), tx);
        assert!(matches!(
            claim_idempotency("replay", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        persist_terminal_for_test(
            "replay",
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );
        match sender
            .send(test_params("hello"), Some("replay".into()))
            .await
        {
            OutboundSendResponse::Result(result) => assert!(result.success),
            OutboundSendResponse::Rejected(error) => {
                panic!("replay must not be rejected as {}", error.code)
            }
        }
    }

    #[tokio::test]
    async fn worker_rejects_quiet_hours_instead_of_sending() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 24 * 60,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(600),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let control = Arc::new(OutboundControl::new(false));
        let (tx, rx) = mpsc::unbounded_channel();
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(
            config,
            Arc::clone(&control),
            rx,
            usage,
            Arc::new(OutboundDiagnostics::default()),
            test_executor(),
        ));
        let (result_tx, result_rx) = oneshot::channel();
        assert!(matches!(
            claim_idempotency("quiet", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.send(OutboundTask {
            params: test_params("quiet"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("quiet".into()),
            idempotency_generation: Some(generation_for("quiet")),
            idempotency_lease: Some(lease_for("quiet")),
            result_tx,
            _queue_permit: None,
            similarity_reservation: None,
        })
        .unwrap();
        match result_rx.await.unwrap() {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::QuietHours);
            }
            _ => panic!("queued quiet-hours task must be rejected, not sent"),
        }
        drop(tx);
        worker.await.unwrap();
    }

    #[test]
    fn quiet_hours_and_budgets_are_deterministic() {
        let mut config = OutboundConfig::from_env();
        config.quiet_start_min = 30;
        config.quiet_end_min = 450;
        config.hourly_budget = 2;
        config.daily_budget = 2;
        config.chat_cooldown = Duration::from_secs(5);
        let mut usage = Usage::new();
        let now = Instant::now();
        let wall = SystemTime::now();
        assert!(in_quiet_hours(30, 30, 450));
        assert!(policy_allows_send(&config, &mut usage, "c", now, wall, 30).is_err());
        assert!(policy_allows_send(&config, &mut usage, "c", now, wall, 500).is_ok());
        usage.hour_count = 2;
        usage.hour_key = wall.duration_since(UNIX_EPOCH).unwrap().as_secs() / 3600;
        assert!(policy_allows_send(&config, &mut usage, "c", now, wall, 500).is_err());
    }

    fn post_commit_result(code: &str) -> SendResult {
        SendResult {
            success: false,
            error_code: Some(code.into()),
            error: Some(code.into()),
            commit_attempted: true,
        }
    }

    #[test]
    fn post_commit_diagnostics_count_as_usage() {
        let usage = Mutex::new(Usage::new());
        let now = Instant::now();
        let wall = SystemTime::now();
        for code in [
            "send_commit_uncertain",
            "send_result_uncertain",
            "composer_missing_during_confirmation",
            "popup_after_send_action",
        ] {
            apply_send_result_to_usage(&usage, &post_commit_result(code), "chat", now, wall);
        }
        let snapshot = usage.lock().unwrap();
        assert_eq!(snapshot.hour_count, 4);
        assert_eq!(snapshot.day_count, 4);
        assert!(snapshot.last_per_chat.contains_key("chat"));
    }

    #[test]
    fn pre_commit_failures_do_not_count_as_usage() {
        let usage = Mutex::new(Usage::new());
        apply_send_result_to_usage(
            &usage,
            &SendResult {
                success: false,
                error_code: Some("target_confirmation_identity_mismatch".into()),
                error: Some("target_confirmation_identity_mismatch".into()),
                commit_attempted: false,
            },
            "chat",
            Instant::now(),
            SystemTime::now(),
        );
        let snapshot = usage.lock().unwrap();
        assert_eq!(snapshot.hour_count, 0);
        assert_eq!(snapshot.day_count, 0);
    }

    #[test]
    fn successful_return_then_uncertain_confirmation_is_commit_attempted() {
        let mut plan_state = crate::plans::send_message::SendMessagePlanState {
            phase: crate::plans::send_message::SendMessagePhase::Confirming,
            open_result: None,
            focus_attempts: 0,
            confirm_attempts: 0,
            send_action_executed: true,
            diagnostic_error: None,
        };
        for code in [
            "send_result_uncertain",
            "composer_missing_during_confirmation",
            "popup_after_send_action",
        ] {
            plan_state.diagnostic_error = Some(code.into());
            let result = send_result_from_plan(false, &plan_state, None);
            assert!(result.commit_attempted, "{code}");
            assert!(counts_toward_usage(&result), "{code}");
            assert_eq!(result.error_code.as_deref(), Some(code));
        }
    }

    #[test]
    fn pre_execution_reject_does_not_contaminate_completed_result() {
        let _idempotency_lock = clear_idempotency_rows();
        assert!(matches!(
            claim_idempotency("pre-reject-k", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        persist_terminal_for_test(
            "pre-reject-k",
            &SendResult {
                success: true,
                error_code: None,
                error: None,
                commit_attempted: true,
            },
            Duration::from_secs(60),
        );
        assert!(persist_rejection(
            "pre-reject-k",
            Some(generation_for("pre-reject-k")),
            OutboundIdempotencyState::Rejected,
            "OUTBOUND_DISABLED",
            Duration::from_secs(60),
        )
        .is_err());
        let record = get_idempotency_status("pre-reject-k").unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::Sent);
        assert!(record.result.unwrap().success);
    }
}

#[cfg(test)]
mod p0c_tests {
    use std::sync::Once;

    static INIT_DB: Once = Once::new();

    fn init_test_db() {
        INIT_DB.call_once(|| {
            let dir = tempfile::TempDir::new().unwrap();
            let path = dir.path().join("outbound-p0c-integrated-test.db");
            std::env::set_var("AGENT_DB_PATH", &path);
            std::env::set_var("AGENT_WECHAT_TOKEN", "test-token");
            crate::router::auth::init_token();
            let _ = crate::db::init_db();
            std::mem::forget(dir);
        });
    }

    fn clear_idempotency_rows() -> std::sync::MutexGuard<'static, ()> {
        let guard = super::lock_idempotency_tests();
        init_test_db();
        super::clear_persistence_faults();
        let db = get_db();
        db.execute("DELETE FROM outbound_idempotency", []).unwrap();
        guard
    }

    use super::*;

    fn test_executor() -> ExecuteSend {
        Arc::new(|_params| Box::pin(async { send_error("TEST_EXECUTOR") }))
    }

    struct FixedJitter {
        values: VecDeque<Duration>,
    }

    impl FixedJitter {
        fn new(values: impl IntoIterator<Item = Duration>) -> Self {
            Self {
                values: values.into_iter().collect(),
            }
        }
    }

    impl JitterSource for FixedJitter {
        fn next_jitter(&mut self, max: Duration) -> Duration {
            self.values.pop_front().unwrap_or(Duration::ZERO).min(max)
        }
    }

    #[test]
    fn spacing_policy_applies_min_spacing_and_jitter_deterministically() {
        let start = Instant::now();
        let mut policy = SpacingPolicy::new(
            Duration::from_millis(100),
            Duration::from_millis(25),
            Duration::ZERO,
            0,
        );
        let mut jitter = FixedJitter::new([
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::ZERO,
        ]);

        assert_eq!(policy.next_delay(start), Duration::ZERO);
        policy.record_attempt(start, &mut jitter);
        assert_eq!(
            policy.next_delay(start + Duration::from_millis(50)),
            Duration::from_millis(60)
        );
        policy.record_attempt(start + Duration::from_millis(120), &mut jitter);
        assert_eq!(
            policy.next_delay(start + Duration::from_millis(150)),
            Duration::from_millis(90)
        );
    }

    fn task_for_fairness(chat: &str, source: &str, text: &str) -> OutboundTask {
        let (result_tx, _result_rx) = oneshot::channel();
        let mut params = test_params(text);
        params.chat_id = chat.to_string();
        params.source = Some(source.to_string());
        OutboundTask {
            params,
            enqueued_at: Instant::now(),
            idempotency_key: None,
            idempotency_generation: None,
            idempotency_lease: None,
            result_tx,
            _queue_permit: None,
            similarity_reservation: None,
        }
    }

    #[test]
    fn fair_queue_rotates_sources_and_chats_without_starvation() {
        let mut queue = FairQueue::new();
        queue.push(task_for_fairness("a", "openclaw", "a1"));
        queue.push(task_for_fairness("a", "openclaw", "a2"));
        queue.push(task_for_fairness("b", "openclaw", "b1"));
        queue.push(task_for_fairness("c", "wechaty", "c1"));
        queue.push(task_for_fairness("d", "wechaty", "d1"));

        let order: Vec<(String, String)> = (0..5)
            .map(|_| {
                let task = queue.pop().unwrap();
                (task.params.source.unwrap(), task.params.message.unwrap())
            })
            .collect();
        assert_eq!(
            order,
            vec![
                ("openclaw".into(), "a1".into()),
                ("wechaty".into(), "c1".into()),
                ("openclaw".into(), "b1".into()),
                ("wechaty".into(), "d1".into()),
                ("openclaw".into(), "a2".into()),
            ]
        );
    }

    #[test]
    fn similar_text_requires_confirmation_without_retaining_plaintext() {
        let config = OutboundConfig {
            similarity_min_chars: 8,
            similarity_hamming: 12,
            ..test_config()
        };
        let mut guard = SimilarityGuard::new(&config);
        let now = Instant::now();
        assert_eq!(
            guard.reserve(
                1,
                "chat",
                "api",
                Some("Your order 123 has shipped today"),
                false,
                now
            ),
            Ok(true)
        );
        guard.commit(1, now);
        let error = guard
            .reserve(
                2,
                "chat",
                "api",
                Some("Your order 124 has shipped today!"),
                false,
                now + Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(error.kind, OutboundErrorKind::SimilarContent);
        assert_eq!(
            guard.reserve(
                3,
                "chat",
                "api",
                Some("Your order 124 has shipped today!"),
                true,
                now + Duration::from_secs(2),
            ),
            Ok(true)
        );
        guard.commit(3, now + Duration::from_secs(2));
        assert_eq!(guard.committed.len(), 2);
        assert_eq!(
            guard.reserve(
                4,
                "other-chat",
                "api",
                Some("Your order 125 has shipped today!"),
                false,
                now + Duration::from_secs(3),
            ),
            Ok(true)
        );
        assert_eq!(
            guard.reserve(
                5,
                "chat",
                "other-source",
                Some("Your order 126 has shipped today!"),
                false,
                now + Duration::from_secs(3),
            ),
            Ok(true)
        );
    }

    #[test]
    fn pending_confirmed_work_does_not_become_policy_history() {
        let config = OutboundConfig {
            similarity_min_chars: 8,
            ..test_config()
        };
        let mut guard = SimilarityGuard::new(&config);
        let now = Instant::now();
        assert_eq!(
            guard.reserve(
                1,
                "chat",
                "api",
                Some("pending confirmed template message"),
                true,
                now,
            ),
            Ok(true)
        );
        assert_eq!(
            guard.reserve(
                2,
                "chat",
                "api",
                Some("pending confirmed template message"),
                false,
                now + Duration::from_millis(1),
            ),
            Ok(true)
        );
        guard.release(1);
        guard.release(2);
        assert!(guard.committed.is_empty());
        assert!(guard.pending.is_empty());
    }

    #[test]
    fn short_text_and_media_only_requests_bypass_similarity_guard() {
        let config = test_config();
        let mut guard = SimilarityGuard::new(&config);
        let now = Instant::now();
        assert_eq!(
            guard.reserve(1, "chat", "api", Some("ok"), false, now),
            Ok(false)
        );
        assert_eq!(
            guard.reserve(2, "chat", "api", Some("ok"), false, now),
            Ok(false)
        );
        assert_eq!(guard.reserve(3, "chat", "api", None, false, now), Ok(false));
        assert!(guard.committed.is_empty());
        assert!(guard.pending.is_empty());
    }

    #[test]
    fn failed_or_cancelled_similarity_reservations_do_not_poison_history() {
        let config = OutboundConfig {
            similarity_min_chars: 8,
            ..test_config()
        };
        let guard = Arc::new(Mutex::new(SimilarityGuard::new(&config)));
        let now = Instant::now();
        assert_eq!(
            guard.lock().unwrap().reserve(
                1,
                "chat",
                "api",
                Some("template message for cancellation"),
                false,
                now
            ),
            Ok(true)
        );
        {
            let _reservation = SimilarityReservation {
                guard: Arc::clone(&guard),
                id: 1,
                committed: false,
            };
        }
        assert!(guard.lock().unwrap().committed.is_empty());
        assert!(guard.lock().unwrap().pending.is_empty());
        assert_eq!(
            guard.lock().unwrap().reserve(
                2,
                "chat",
                "api",
                Some("template message for cancellation"),
                false,
                now + Duration::from_secs(1),
            ),
            Ok(true)
        );
    }

    #[test]
    fn spacing_policy_adds_bounded_long_tail_deterministically() {
        let start = Instant::now();
        let mut policy = SpacingPolicy::new(
            Duration::from_millis(100),
            Duration::ZERO,
            Duration::from_millis(500),
            10,
        );
        let mut jitter = FixedJitter::new([
            Duration::ZERO,
            Duration::from_millis(5),
            Duration::from_millis(400),
            Duration::ZERO,
            Duration::from_millis(99),
        ]);
        assert_eq!(policy.next_delay(start), Duration::ZERO);
        policy.record_attempt(start, &mut jitter);
        assert_eq!(
            policy.next_delay(start + Duration::from_millis(100)),
            Duration::from_millis(400)
        );
    }

    #[tokio::test]
    async fn live_worker_rotates_hot_sources_and_chats_and_releases_capacity() {
        let config = OutboundConfig {
            queue_capacity: 8,
            similarity_min_chars: 1_000,
            ..test_config()
        };
        let order = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let first_started = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let call = Arc::new(AtomicU64::new(0));
        let executor: ExecuteSend = {
            let order = Arc::clone(&order);
            let first_started = Arc::clone(&first_started);
            let release_first = Arc::clone(&release_first);
            let call = Arc::clone(&call);
            Arc::new(move |params| {
                let order = Arc::clone(&order);
                let first_started = Arc::clone(&first_started);
                let release_first = Arc::clone(&release_first);
                let call = Arc::clone(&call);
                Box::pin(async move {
                    let index = call.fetch_add(1, Ordering::SeqCst);
                    order
                        .lock()
                        .unwrap()
                        .push((normalize_source(params.source.as_deref()), params.chat_id));
                    if index == 0 {
                        first_started.notify_one();
                        release_first.notified().await;
                    }
                    SendResult {
                        success: true,
                        error_code: None,
                        error: None,
                        commit_attempted: true,
                    }
                })
            })
        };
        let sender = OutboundSender::spawn_with_executor(config, executor);
        let mut hot = test_params("hot-a1");
        hot.chat_id = "a".into();
        hot.source = Some("hot".into());
        let first = tokio::spawn({
            let sender = sender.clone();
            async move { sender.send(hot, None).await }
        });
        first_started.notified().await;

        let mut sends = Vec::new();
        for (source, chat, text) in [
            ("hot", "a", "hot-a2"),
            ("hot", "b", "hot-b1"),
            ("cold", "c", "cold-c1"),
            ("hot", "a", "hot-a3"),
            ("cold", "d", "cold-d1"),
        ] {
            let mut params = test_params(text);
            params.source = Some(source.into());
            params.chat_id = chat.into();
            let sender = sender.clone();
            sends.push(tokio::spawn(async move { sender.send(params, None).await }));
        }
        tokio::task::yield_now().await;
        release_first.notify_one();
        let _ = first.await.unwrap();
        for send in sends {
            assert!(matches!(
                send.await.unwrap(),
                OutboundSendResponse::Result(_)
            ));
        }
        assert_eq!(
            sender.capacity.available_permits(),
            sender.config.queue_capacity
        );
        assert_eq!(
            *order.lock().unwrap(),
            vec![
                ("hot".into(), "a".into()),
                ("hot".into(), "a".into()),
                ("cold".into(), "c".into()),
                ("hot".into(), "b".into()),
                ("cold".into(), "d".into()),
                ("hot".into(), "a".into()),
            ]
        );
    }

    #[tokio::test]
    async fn queue_bound_rejects_when_channel_is_full() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::from_secs(60),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(60),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = OutboundSender {
            config: config.clone(),
            control: Arc::new(OutboundControl::new(false)),
            tx,
            capacity: Arc::new(tokio::sync::Semaphore::new(config.queue_capacity)),
            usage: Arc::new(Mutex::new(Usage::new())),
            similarity: Arc::new(Mutex::new(SimilarityGuard::new(&config))),
            next_similarity_id: Arc::new(AtomicU64::new(1)),
            diagnostics: Arc::new(OutboundDiagnostics::default()),
            execute: test_executor(),
        };

        let held_permit = Arc::clone(&sender.capacity).try_acquire_owned().unwrap();

        match sender
            .send(
                test_params("second"),
                Some("p0c-queue-capacity-full".to_string()),
            )
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::QueueFull);
                assert!(error.retry_after.is_some());
            }
            _ => panic!("expected queue full rejection"),
        }
        let record = get_idempotency_status("p0c-queue-capacity-full").unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::Rejected);
        assert_eq!(
            record.result.unwrap().error_code.as_deref(),
            Some("QUEUE_FULL")
        );
        let counters = sender.diagnostics.snapshot();
        assert_eq!(counters.rejected_429_total, 1);
        assert_eq!(counters.enqueued_total, 0);
        assert_eq!(counters.completed_total, 0);
        drop(held_permit);
    }

    #[tokio::test]
    async fn cancelled_confirmed_send_releases_capacity_and_similarity_without_false_block() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(50),
            task_ttl: Duration::from_millis(5),
            similarity_min_chars: 8,
            ..test_config()
        };
        let sender = OutboundSender::spawn_with_executor(config, test_executor());
        sender
            .usage
            .lock()
            .unwrap()
            .last_per_chat
            .insert("chat".into(), Instant::now());
        let mut confirmed = test_params("confirmed pending template message");
        confirmed.similarity_confirmed = true;
        let cancelled = tokio::spawn({
            let sender = sender.clone();
            async move { sender.send(confirmed, Some("cancelled".into())).await }
        });
        tokio::time::sleep(Duration::from_millis(2)).await;
        let concurrent_unconfirmed = tokio::spawn({
            let sender = sender.clone();
            async move {
                sender
                    .send(test_params("confirmed pending template message"), None)
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(2)).await;
        cancelled.abort();
        let _ = cancelled.await;
        assert!(!matches!(
            concurrent_unconfirmed.await.unwrap(),
            OutboundSendResponse::Rejected(OutboundError {
                kind: OutboundErrorKind::SimilarContent,
                ..
            })
        ));
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert_eq!(
            sender.capacity.available_permits(),
            sender.config.queue_capacity
        );
        assert!(sender.similarity.lock().unwrap().committed.is_empty());
        assert!(sender.similarity.lock().unwrap().pending.is_empty());

        let unconfirmed = test_params("confirmed pending template message");
        assert!(!matches!(
            sender.send(unconfirmed, None).await,
            OutboundSendResponse::Rejected(OutboundError {
                kind: OutboundErrorKind::SimilarContent,
                ..
            })
        ));
    }

    #[test]
    fn media_caption_is_not_reserved_as_template_text() {
        let params = SendMessageParams {
            image_path: Some("/tmp/image.png".to_string()),
            ..test_params("A repeated caption that is long enough to guard")
        };
        let similarity_text = if params.image_path.is_none() && params.file_path.is_none() {
            params.message.as_deref()
        } else {
            None
        };
        assert!(similarity_text.is_none());
    }

    #[tokio::test]
    async fn kill_switch_rejects_without_queueing() {
        let _idempotency_lock = clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: true,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(60),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = OutboundSender {
            config: config.clone(),
            control: Arc::new(OutboundControl::new(true)),
            tx,
            capacity: Arc::new(tokio::sync::Semaphore::new(config.queue_capacity)),
            usage: Arc::new(Mutex::new(Usage::new())),
            similarity: Arc::new(Mutex::new(SimilarityGuard::new(&config))),
            next_similarity_id: Arc::new(AtomicU64::new(1)),
            diagnostics: Arc::new(OutboundDiagnostics::default()),
            execute: test_executor(),
        };

        match sender
            .send(test_params("blocked"), Some("k".to_string()))
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::ReadOnly);
                assert!(error.retry_after.is_none());
            }
            _ => panic!("expected read-only rejection"),
        }
        let counters = sender.diagnostics.snapshot();
        assert_eq!(counters.enqueued_total, 0);
        assert_eq!(counters.completed_total, 0);
        assert_eq!(counters.rejected_429_total, 0);
    }

    #[test]
    fn status_reports_queue_config_and_idempotency_entries() {
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(150),
            jitter: Duration::from_millis(25),
            task_ttl: Duration::from_secs(30),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: true,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(60),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let sender = OutboundSender {
            config: config.clone(),
            control: Arc::new(OutboundControl::new(true)),
            tx,
            capacity: Arc::new(tokio::sync::Semaphore::new(config.queue_capacity)),
            usage: Arc::new(Mutex::new(Usage::new())),
            similarity: Arc::new(Mutex::new(SimilarityGuard::new(&config))),
            next_similarity_id: Arc::new(AtomicU64::new(1)),
            diagnostics: Arc::new(OutboundDiagnostics::default()),
            execute: test_executor(),
        };

        let _idempotency_lock = clear_idempotency_rows();

        let status = sender.status();
        assert_eq!(status.queue_capacity, 2);
        assert_eq!(status.queue_depth, 0);
        assert_eq!(status.available_capacity, 2);
        assert_eq!(status.min_spacing_ms, 150);
        assert_eq!(status.jitter_ms, 25);
        assert_eq!(status.task_ttl_ms, 30_000);
        assert_eq!(status.idempotency_ttl_ms, 60_000);
        assert!(status.read_only);
        assert!(status.runtime_paused);
        assert_eq!(status.idempotency_entries, 0);
        assert_eq!(status.diagnostics.enqueued_total, 0);
        assert_eq!(status.chat_select_diagnostics.attach_total, 0);

        let json = serde_json::to_string(&status).unwrap();
        for sensitive in [
            "private message body",
            "Alice Display Name",
            "/tmp/send_file_secret.pdf",
            "Bearer secret-token",
            "data:image/png;base64",
        ] {
            assert!(!json.contains(sensitive));
        }
        assert!(json.contains("diagnostics"));
        assert!(json.contains("chatSelectDiagnostics"));
    }

    #[test]
    fn diagnostics_count_redacted_outcomes_and_durations() {
        let diagnostics = OutboundDiagnostics::default();
        diagnostics.record_rejection(&OutboundError::queue_full(Duration::from_secs(1)));
        diagnostics.record_rejection(&OutboundError::expired());
        diagnostics.record_rejection(&OutboundError::quiet_hours(Duration::from_secs(1)));
        diagnostics.record_rejection(&OutboundError::budget(
            "HOURLY_BUDGET",
            Duration::from_secs(1),
        ));
        diagnostics.record_queue_wait(Duration::from_millis(23));
        diagnostics.record_result(&SendResult {
            success: false,
            error_code: Some("send_commit_uncertain".into()),
            error: Some("send_commit_uncertain".into()),
            commit_attempted: true,
        });

        let snapshot = diagnostics.snapshot();
        assert_eq!(snapshot.rejected_429_total, 3);
        assert_eq!(snapshot.queue_expired_total, 1);
        assert_eq!(snapshot.quiet_hours_rejected_total, 1);
        assert_eq!(snapshot.budget_rejected_total, 1);
        assert_eq!(snapshot.completed_total, 1);
        assert_eq!(snapshot.failed_total, 1);
        assert_eq!(snapshot.uncertain_total, 1);
        assert_eq!(snapshot.last_queue_wait_ms, 23);
        assert_eq!(snapshot.max_queue_wait_ms, 23);
    }

    #[test]
    fn pause_resume_and_uncertain_completion_are_counted_once() {
        let sender = OutboundSender {
            diagnostics: Arc::new(OutboundDiagnostics::default()),
            ..test_sender(false)
        };
        sender.pause();
        sender.pause();
        sender.resume();
        sender.resume();
        sender.diagnostics.record_result(&SendResult {
            success: false,
            error_code: Some("send_result_uncertain".into()),
            error: None,
            commit_attempted: true,
        });
        let counters = sender.diagnostics.snapshot();
        assert_eq!(counters.pause_total, 1);
        assert_eq!(counters.resume_total, 1);
        assert_eq!(counters.completed_total, 1);
        assert_eq!(counters.failed_total, 1);
        assert_eq!(counters.uncertain_total, 1);
    }

    #[test]
    fn uncertain_counter_uses_only_post_commit_terminal_codes() {
        let diagnostics = OutboundDiagnostics::default();
        diagnostics.record_result(&SendResult {
            success: false,
            error_code: Some("target_confirmation_identity_mismatch".into()),
            error: None,
            commit_attempted: false,
        });
        diagnostics.record_result(&SendResult {
            success: false,
            error_code: Some("send_result_uncertain".into()),
            error: None,
            commit_attempted: true,
        });
        assert_eq!(diagnostics.snapshot().uncertain_total, 1);
    }

    #[test]
    fn execution_errors_are_mapped_to_stable_codes_without_detail() {
        assert_eq!(
            execution_error_code("Execution timeout after 301s /tmp/private"),
            "EXECUTION_TIMEOUT"
        );
        assert_eq!(
            execution_error_code("Unknown state for 60s - Alice secret"),
            "UNKNOWN_UI_STATE_TIMEOUT"
        );
        assert_eq!(
            execution_error_code("untrusted error with message text and token"),
            "SEND_EXECUTION_FAILED"
        );
    }

    fn test_config() -> OutboundConfig {
        OutboundConfig {
            queue_capacity: 20,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
            long_tail_jitter: Duration::ZERO,
            long_tail_chance_percent: 0,
            similarity_window: Duration::from_secs(60),
            similarity_min_chars: 20,
            similarity_hamming: 8,
            similarity_history: 200,
        }
    }

    fn test_sender(read_only: bool) -> OutboundSender {
        let mut config = test_config();
        config.read_only = read_only;
        let (tx, _rx) = mpsc::unbounded_channel();
        OutboundSender {
            config: config.clone(),
            control: Arc::new(OutboundControl::new(read_only)),
            tx,
            capacity: Arc::new(tokio::sync::Semaphore::new(config.queue_capacity)),
            usage: Arc::new(Mutex::new(Usage::new())),
            similarity: Arc::new(Mutex::new(SimilarityGuard::new(&config))),
            next_similarity_id: Arc::new(AtomicU64::new(1)),
            diagnostics: Arc::new(OutboundDiagnostics::default()),
            execute: test_executor(),
        }
    }

    fn test_params(text: &str) -> SendMessageParams {
        SendMessageParams {
            chat_id: "chat".to_string(),
            message: Some(text.to_string()),
            image_path: None,
            image_mime: None,
            file_path: None,
            inbound_chars: None,
            source: None,
            similarity_confirmed: false,
        }
    }

    #[test]
    fn quiet_hours_and_budgets_are_deterministic() {
        let mut config = OutboundConfig::from_env();
        config.quiet_start_min = 30;
        config.quiet_end_min = 450;
        config.hourly_budget = 2;
        config.daily_budget = 2;
        config.chat_cooldown = Duration::from_secs(5);
        let mut usage = Usage::new();
        let now = Instant::now();
        let wall = SystemTime::now();
        assert!(in_quiet_hours(30, 30, 450));
        assert!(policy_allows_send(&config, &mut usage, "c", now, wall, 30).is_err());
        assert!(policy_allows_send(&config, &mut usage, "c", now, wall, 500).is_ok());
        usage.hour_count = 2;
        usage.hour_key = wall.duration_since(UNIX_EPOCH).unwrap().as_secs() / 3600;
        assert!(policy_allows_send(&config, &mut usage, "c", now, wall, 500).is_err());
    }

    fn post_commit_result(code: &str) -> SendResult {
        SendResult {
            success: false,
            error_code: Some(code.into()),
            error: Some(code.into()),
            commit_attempted: true,
        }
    }

    #[test]
    fn post_commit_diagnostics_count_as_usage() {
        let usage = Mutex::new(Usage::new());
        let now = Instant::now();
        let wall = SystemTime::now();
        for code in [
            "send_commit_uncertain",
            "send_result_uncertain",
            "composer_missing_during_confirmation",
            "popup_after_send_action",
        ] {
            apply_send_result_to_usage(&usage, &post_commit_result(code), "chat", now, wall);
        }
        let snapshot = usage.lock().unwrap();
        assert_eq!(snapshot.hour_count, 4);
        assert_eq!(snapshot.day_count, 4);
        assert!(snapshot.last_per_chat.contains_key("chat"));
    }

    #[test]
    fn pre_commit_failures_do_not_count_as_usage() {
        let usage = Mutex::new(Usage::new());
        apply_send_result_to_usage(
            &usage,
            &SendResult {
                success: false,
                error_code: Some("target_confirmation_identity_mismatch".into()),
                error: Some("target_confirmation_identity_mismatch".into()),
                commit_attempted: false,
            },
            "chat",
            Instant::now(),
            SystemTime::now(),
        );
        let snapshot = usage.lock().unwrap();
        assert_eq!(snapshot.hour_count, 0);
        assert_eq!(snapshot.day_count, 0);
    }

    #[test]
    fn successful_return_then_uncertain_confirmation_is_commit_attempted() {
        let mut plan_state = crate::plans::send_message::SendMessagePlanState {
            phase: crate::plans::send_message::SendMessagePhase::Confirming,
            open_result: None,
            focus_attempts: 0,
            confirm_attempts: 0,
            send_action_executed: true,
            diagnostic_error: None,
        };
        for code in [
            "send_result_uncertain",
            "composer_missing_during_confirmation",
            "popup_after_send_action",
        ] {
            plan_state.diagnostic_error = Some(code.into());
            let result = send_result_from_plan(false, &plan_state, None);
            assert!(result.commit_attempted, "{code}");
            assert!(counts_toward_usage(&result), "{code}");
            assert_eq!(result.error_code.as_deref(), Some(code));
        }
    }
}
