use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
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
            claim_reusable_outbound_queued, complete_outbound_result, count_outbound_idempotency,
            expire_outbound_if_stale, get_outbound_idempotency, insert_outbound_queued,
            mark_outbound_needs_reconciliation, mark_outbound_sending,
            reconcile_outbound_idempotency, reject_outbound_pre_execution,
            reject_outbound_unless_active_or_completed, OutboundIdempotencyRecord,
            OutboundIdempotencyState,
        },
        try_get_db,
    },
    execution::run_execution_loop,
    ia::types::{SendResult, SubscriptionEvent},
    plans::send_message::{SendMessageParams, SendMessagePlan},
    sessions::manager::get_session,
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
pub const IDEMPOTENCY_KEY_MAX_BYTES: usize = 128;

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
}

#[derive(Debug, Clone)]
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
            message: "Quiet hours: outbound sends are deferred".to_string(),
            commit_attempted: false,
        }
    }

    fn budget(code: &str, retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::Budget,
            retry_after: Some(retry_after),
            code: code.to_string(),
            message: "Outbound send budget exhausted".to_string(),
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
                    | OutboundErrorKind::Budget => StatusCode::TOO_MANY_REQUESTS,
                    OutboundErrorKind::ReadOnly => StatusCode::SERVICE_UNAVAILABLE,
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
}

pub enum IdempotencyAdmission {
    Claimed(i64),
    InProgress,
    Completed(SendResult),
    Rejected(OutboundError),
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

struct OutboundTask {
    params: SendMessageParams,
    enqueued_at: Instant,
    idempotency_key: Option<String>,
    idempotency_generation: Option<i64>,
    result_tx: oneshot::Sender<OutboundSendResponse>,
}

#[derive(Clone)]
pub struct OutboundSender {
    config: OutboundConfig,
    control: Arc<OutboundControl>,
    tx: mpsc::Sender<OutboundTask>,
    usage: Arc<Mutex<Usage>>,
}

static OUTBOUND_SENDER: OnceLock<OutboundSender> = OnceLock::new();

#[cfg(test)]
static FAIL_SENDING_PERSISTENCE_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
#[cfg(test)]
static FAIL_RESULT_PERSISTENCE_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
#[cfg(test)]
static FAIL_REJECTION_PERSISTENCE_FOR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

pub fn outbound_sender() -> &'static OutboundSender {
    OUTBOUND_SENDER.get_or_init(|| OutboundSender::spawn(OutboundConfig::from_env()))
}

impl OutboundSender {
    pub fn spawn(config: OutboundConfig) -> Self {
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let control = Arc::new(OutboundControl::new(config.read_only));
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker_control = Arc::clone(&control);
        let worker_usage = Arc::clone(&usage);
        let worker_config = config.clone();

        tokio::spawn(async move {
            worker_loop(worker_config, worker_control, rx, worker_usage).await;
        });

        Self {
            config,
            control,
            tx,
            usage,
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
                IdempotencyAdmission::Claimed(generation) => {
                    return self
                        .send_claimed(params, idempotency_key, Some(generation))
                        .await;
                }
                IdempotencyAdmission::Completed(result) => {
                    cleanup_temp_files(&params);
                    return OutboundSendResponse::Result(result);
                }
                IdempotencyAdmission::InProgress => {
                    cleanup_temp_files(&params);
                    return OutboundSendResponse::Rejected(OutboundError::duplicate_in_progress(
                        self.config.retry_after(),
                    ));
                }
                IdempotencyAdmission::Rejected(error) => {
                    cleanup_temp_files(&params);
                    return OutboundSendResponse::Rejected(error);
                }
            }
        }

        self.send_claimed(params, idempotency_key, None).await
    }

    pub fn admit_idempotency_key(&self, key: &str) -> IdempotencyAdmission {
        if validate_idempotency_key(key).is_err() {
            return IdempotencyAdmission::Rejected(OutboundError::invalid_idempotency_key());
        }
        if self.control.is_read_only() {
            match get_active_or_completed_idempotency(key) {
                IdempotencyReplay::Completed(result) => {
                    return IdempotencyAdmission::Completed(result);
                }
                IdempotencyReplay::InProgress => {
                    return IdempotencyAdmission::InProgress;
                }
                IdempotencyReplay::NeedsReconciliation => {
                    return IdempotencyAdmission::Rejected(OutboundError::duplicate_in_progress(
                        self.config.retry_after(),
                    ));
                }
                IdempotencyReplay::None => {
                    if let Err(error) =
                        persist_read_only_rejection(key, self.config.idempotency_ttl)
                    {
                        tracing::error!(
                            "[outbound] failed to persist read-only rejection: {error}"
                        );
                        self.control.set_runtime_paused(true);
                        return IdempotencyAdmission::Rejected(OutboundError::persistence(false));
                    }
                    return IdempotencyAdmission::Rejected(OutboundError::read_only());
                }
            }
        }

        match try_claim_idempotency(key, self.config.idempotency_ttl) {
            Ok(IdempotencyStart::Inserted(generation)) => IdempotencyAdmission::Claimed(generation),
            Ok(IdempotencyStart::Completed(result)) => IdempotencyAdmission::Completed(result),
            Ok(IdempotencyStart::InProgress) | Ok(IdempotencyStart::NeedsReconciliation) => {
                IdempotencyAdmission::InProgress
            }
            Err(error) => {
                tracing::error!("[outbound] failed to claim idempotency key: {error}");
                self.control.set_runtime_paused(true);
                IdempotencyAdmission::Rejected(OutboundError::persistence(false))
            }
        }
    }

    pub async fn send_claimed(
        &self,
        params: SendMessageParams,
        idempotency_key: Option<String>,
        idempotency_generation: Option<i64>,
    ) -> OutboundSendResponse {
        let now = Instant::now();
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
                    tracing::error!("[outbound] failed to persist read-only rejection: {error}");
                    self.control.set_runtime_paused(true);
                    return OutboundSendResponse::Rejected(OutboundError::persistence(false));
                }
            }
            return OutboundSendResponse::Rejected(OutboundError::read_only());
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
                        tracing::error!("[outbound] failed to persist policy rejection: {error}");
                        self.control.set_runtime_paused(true);
                        cleanup_temp_files(&params);
                        return OutboundSendResponse::Rejected(OutboundError::persistence(false));
                    }
                }
                cleanup_temp_files(&params);
                return OutboundSendResponse::Rejected(error);
            }
        }

        let (result_tx, result_rx) = oneshot::channel();
        let task = OutboundTask {
            params,
            enqueued_at: now,
            idempotency_key: idempotency_key.clone(),
            idempotency_generation,
            result_tx,
        };

        match self.tx.try_send(task) {
            Ok(()) => match result_rx.await {
                Ok(response) => response,
                Err(_) => {
                    if let Some(key) = idempotency_key.as_deref() {
                        if let Err(error) = persist_result(
                            key,
                            idempotency_generation,
                            &unavailable_result(),
                            self.config.idempotency_ttl,
                        ) {
                            tracing::error!(
                                "[outbound] failed to persist scheduler unavailable result: {error}"
                            );
                            if !mark_needs_reconciliation(
                                key,
                                idempotency_generation,
                                true,
                                self.config.idempotency_ttl,
                            ) {
                                tracing::error!(
                                    "[outbound] failed to mark scheduler unavailable reconciliation state"
                                );
                            }
                            self.control.set_runtime_paused(true);
                            return OutboundSendResponse::Rejected(OutboundError::persistence(
                                true,
                            ));
                        }
                    }
                    OutboundSendResponse::Rejected(OutboundError::unavailable())
                }
            },
            Err(mpsc::error::TrySendError::Full(task)) => {
                let error = OutboundError::queue_full(self.config.retry_after());
                reject_without_idempotency_cache(task, error.clone(), self.config.idempotency_ttl);
                OutboundSendResponse::Rejected(error)
            }
            Err(mpsc::error::TrySendError::Closed(task)) => {
                reject_without_idempotency_cache(
                    task,
                    OutboundError::unavailable(),
                    self.config.idempotency_ttl,
                );
                OutboundSendResponse::Rejected(OutboundError::unavailable())
            }
        }
    }

    pub(crate) fn reject_claimed_pre_execution(
        &self,
        idempotency_key: Option<&str>,
        idempotency_generation: Option<i64>,
        error_code: &str,
    ) -> Result<(), OutboundError> {
        if let Some(key) = idempotency_key {
            if let Err(error) = persist_rejection(
                key,
                idempotency_generation,
                OutboundIdempotencyState::Rejected,
                error_code,
                self.config.idempotency_ttl,
            ) {
                tracing::error!("[outbound] failed to persist pre-execution rejection: {error}");
                self.control.set_runtime_paused(true);
                return Err(OutboundError::persistence(false));
            }
        }
        Ok(())
    }

    pub fn status(&self) -> OutboundStatus {
        OutboundStatus {
            queue_capacity: self.config.queue_capacity,
            queue_depth: self.tx.max_capacity().saturating_sub(self.tx.capacity()),
            available_capacity: self.tx.capacity(),
            min_spacing_ms: self.config.min_spacing.as_millis(),
            jitter_ms: self.config.jitter.as_millis(),
            task_ttl_ms: self.config.task_ttl.as_millis(),
            idempotency_ttl_ms: self.config.idempotency_ttl.as_millis(),
            read_only: self.control.is_read_only(),
            runtime_paused: self.control.is_runtime_paused(),
            idempotency_entries: count_persistent_idempotency(),
        }
    }

    pub fn trip_kill_switch(&self, reason: &str) -> OutboundStatus {
        tracing::warn!("[outbound] kill switch: {reason}");
        self.pause()
    }

    pub fn pause(&self) -> OutboundStatus {
        self.control.set_runtime_paused(true);
        self.status()
    }

    pub fn resume(&self) -> OutboundStatus {
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
    mut rx: mpsc::Receiver<OutboundTask>,
    usage: Arc<Mutex<Usage>>,
) {
    let mut policy = SpacingPolicy::new(config.min_spacing, config.jitter);
    while let Some(task) = rx.recv().await {
        let now = Instant::now();
        if task_expired(&task, now, config.task_ttl) {
            reject_without_idempotency_cache(
                task,
                OutboundError::expired(),
                config.idempotency_ttl,
            );
            continue;
        }

        let delay = policy.next_delay(now, &mut SystemJitter);
        let human = if config.min_spacing >= Duration::from_millis(500) {
            let outbound_chars = task
                .params
                .message
                .as_ref()
                .map(|s| s.chars().count())
                .unwrap_or(8);
            Duration::from_millis(human_pre_send_delay_ms(
                outbound_chars,
                task.params.inbound_chars.unwrap_or(0),
            ))
        } else {
            Duration::ZERO
        };
        let delay = delay.max(human);
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }

        let task = match admit_for_execute(task, &control, config.task_ttl, &config, &usage) {
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
                reject_without_idempotency_cache(task, error, config.idempotency_ttl);
                continue;
            }
        };
        if !extra.is_zero() {
            tokio::time::sleep(extra).await;
        }

        let task = match admit_for_execute(task, &control, config.task_ttl, &config, &usage) {
            Some(task) => task,
            None => continue,
        };

        if let Some(key) = task.idempotency_key.as_deref() {
            if let Err(error) = persist_sending(key, task.idempotency_generation) {
                tracing::error!("[outbound] failed to persist sending state: {error}");
                if !mark_needs_reconciliation(
                    key,
                    task.idempotency_generation,
                    false,
                    config.idempotency_ttl,
                ) {
                    tracing::error!("[outbound] failed to persist sending reconciliation state");
                }
                control.set_runtime_paused(true);
                cleanup_temp_files(&task.params);
                let _ = task.result_tx.send(OutboundSendResponse::Rejected(
                    OutboundError::persistence(false),
                ));
                continue;
            }
        }
        let result = execute_send(&task.params).await;
        apply_send_result_to_usage(
            &usage,
            &result,
            &task.params.chat_id,
            Instant::now(),
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
) -> Option<OutboundTask> {
    if control.is_read_only() {
        reject_without_idempotency_cache(task, OutboundError::read_only(), config.idempotency_ttl);
        return None;
    }
    if task_expired(&task, Instant::now(), task_ttl) {
        reject_without_idempotency_cache(task, OutboundError::expired(), config.idempotency_ttl);
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
            reject_without_idempotency_cache(task, error, config.idempotency_ttl);
            None
        }
    }
}

fn task_expired(task: &OutboundTask, now: Instant, task_ttl: Duration) -> bool {
    now.duration_since(task.enqueued_at) > task_ttl
}

async fn execute_send(params: &SendMessageParams) -> SendResult {
    let session = match get_session("default") {
        Some(s) => s,
        None => return send_error("No session available"),
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
    let noop_emit = |_: SubscriptionEvent| {};
    let (result, plan_state) =
        run_execution_loop(&plan, &params, &mut context, &noop_emit, cancel).await;
    send_result_from_plan(result.success, &plan_state, result.error)
}

fn send_result_from_plan(
    success: bool,
    plan_state: &crate::plans::send_message::SendMessagePlanState,
    result_error: Option<String>,
) -> SendResult {
    let error = plan_state.diagnostic_error.clone().or(result_error);
    SendResult {
        success,
        error_code: error.clone(),
        error,
        commit_attempted: plan_state.send_action_executed,
    }
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
    task: OutboundTask,
    result: SendResult,
    idempotency_ttl: Duration,
    control: Option<&OutboundControl>,
) {
    cleanup_temp_files(&task.params);
    if let Some(key) = task.idempotency_key.as_deref() {
        if let Err(error) =
            persist_result(key, task.idempotency_generation, &result, idempotency_ttl)
        {
            tracing::error!("[outbound] failed to persist terminal result: {error}");
            if !mark_needs_reconciliation(
                key,
                task.idempotency_generation,
                result.commit_attempted,
                idempotency_ttl,
            ) {
                tracing::error!("[outbound] failed to persist terminal reconciliation state");
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
    }
    let _ = task.result_tx.send(OutboundSendResponse::Result(result));
}

fn reject_without_idempotency_cache(
    task: OutboundTask,
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
            tracing::error!("[outbound] failed to persist rejection: {err}");
            let _ =
                task.result_tx
                    .send(OutboundSendResponse::Rejected(OutboundError::persistence(
                        false,
                    )));
            return;
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

fn unavailable_result() -> SendResult {
    send_error("SCHEDULER_UNAVAILABLE")
}

enum IdempotencyStart {
    Inserted(i64),
    InProgress,
    NeedsReconciliation,
    Completed(SendResult),
}

fn try_claim_idempotency(key: &str, ttl: Duration) -> rusqlite::Result<IdempotencyStart> {
    let db = get_db();
    expire_outbound_if_stale(&db, key)?;
    if let Some(generation) = insert_outbound_queued(&db, key, ttl)? {
        return Ok(IdempotencyStart::Inserted(generation));
    }
    if let Some(generation) = claim_reusable_outbound_queued(&db, key, ttl)? {
        return Ok(IdempotencyStart::Inserted(generation));
    }
    match get_outbound_idempotency(&db, key)? {
        Some(record) if record.state.is_completed_execution() => Ok(IdempotencyStart::Completed(
            record
                .result
                .unwrap_or_else(|| send_error("REPLAY_UNAVAILABLE")),
        )),
        Some(record)
            if matches!(
                record.state,
                OutboundIdempotencyState::Queued | OutboundIdempotencyState::Sending
            ) =>
        {
            Ok(IdempotencyStart::InProgress)
        }
        Some(record) if record.state == OutboundIdempotencyState::NeedsReconciliation => {
            Ok(IdempotencyStart::NeedsReconciliation)
        }
        _ => Ok(IdempotencyStart::InProgress),
    }
}

fn persist_sending(key: &str, generation: Option<i64>) -> rusqlite::Result<()> {
    #[cfg(test)]
    if consume_persistence_failure(&FAIL_SENDING_PERSISTENCE_FOR, key) {
        return Err(rusqlite::Error::ExecuteReturnedResults);
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
        return Err(rusqlite::Error::ExecuteReturnedResults);
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
        return Err(rusqlite::Error::ExecuteReturnedResults);
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

fn mark_needs_reconciliation(
    key: &str,
    generation: Option<i64>,
    commit_attempted: bool,
    ttl: Duration,
) -> bool {
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
                "[outbound] reconciliation state CAS affected 0 rows for idempotency key"
            );
            false
        }
        Err(error) => {
            tracing::error!("[outbound] failed to persist reconciliation state: {error}");
            false
        }
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

fn get_active_or_completed_idempotency(key: &str) -> IdempotencyReplay {
    let db = get_db();
    match get_outbound_idempotency(&db, key).ok().flatten() {
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
        .map(|db| count_outbound_idempotency(&db))
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
    let db = get_db();
    reconcile_outbound_idempotency(
        &db,
        key,
        OutboundIdempotencyState::Uncertain,
        "MANUAL_RECONCILIATION_REQUIRED",
        ttl,
    )
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
    next_allowed: Option<Instant>,
}

impl SpacingPolicy {
    fn new(min_spacing: Duration, jitter: Duration) -> Self {
        Self {
            min_spacing,
            jitter,
            next_allowed: None,
        }
    }

    fn next_delay(&mut self, now: Instant, jitter: &mut impl JitterSource) -> Duration {
        let delay = self.next_allowed.map_or(Duration::ZERO, |next_allowed| {
            next_allowed.saturating_duration_since(now)
        });
        let scheduled = now + delay;
        self.next_allowed = Some(scheduled + self.min_spacing + jitter.next_jitter(self.jitter));
        delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn clear_idempotency_rows() {
        init_test_db();
    }

    fn claim_idempotency(key: &str, ttl: Duration) -> IdempotencyStart {
        try_claim_idempotency(key, ttl).unwrap()
    }

    fn generation_for(key: &str) -> i64 {
        get_idempotency_status(key).unwrap().generation
    }

    fn persist_terminal_for_test(key: &str, result: &SendResult, ttl: Duration) {
        let generation = generation_for(key);
        persist_sending(key, Some(generation)).unwrap();
        persist_result(key, Some(generation), result, ttl).unwrap();
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
        let mut policy = SpacingPolicy::new(Duration::from_millis(100), Duration::from_millis(25));
        let mut jitter = FixedJitter::new([
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::from_millis(0),
        ]);

        assert_eq!(policy.next_delay(start, &mut jitter), Duration::ZERO);
        assert_eq!(
            policy.next_delay(start + Duration::from_millis(50), &mut jitter),
            Duration::from_millis(60)
        );
        assert_eq!(
            policy.next_delay(start + Duration::from_millis(120), &mut jitter),
            Duration::from_millis(110)
        );
    }

    #[test]
    fn idempotency_replays_completed_result_and_blocks_in_progress_duplicate() {
        clear_idempotency_rows();

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
        clear_idempotency_rows();
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
        clear_idempotency_rows();
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
        clear_idempotency_rows();
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
        clear_idempotency_rows();
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
        clear_idempotency_rows();
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

    #[tokio::test]
    async fn queue_bound_rejects_when_channel_is_full() {
        clear_idempotency_rows();
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
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(false)),
            tx,
            usage: Arc::new(Mutex::new(Usage::new())),
        };

        let (result_tx, _result_rx) = oneshot::channel();
        sender
            .tx
            .try_send(OutboundTask {
                params: test_params("first"),
                enqueued_at: Instant::now(),
                idempotency_key: None,
                idempotency_generation: None,
                result_tx,
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
        clear_idempotency_rows();
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
            },
            enqueued_at: Instant::now() - Duration::from_secs(10),
            idempotency_key: Some("expired".to_string()),
            idempotency_generation: Some(generation_for("expired")),
            result_tx,
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
        clear_idempotency_rows();
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
            result_tx,
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

    #[tokio::test]
    async fn result_channel_closed_and_unavailable_persistence_failure_fails_closed() {
        clear_idempotency_rows();
        let key = "result-channel-closed";
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
        };
        let control = Arc::new(OutboundControl::new(false));
        let usage = Arc::new(Mutex::new(Usage::new()));
        let (tx, mut rx) = mpsc::channel(config.queue_capacity);
        let dropper = tokio::spawn(async move {
            let _ = rx.recv().await;
        });
        let sender = OutboundSender {
            config,
            control: Arc::clone(&control),
            tx,
            usage,
        };

        fail_next_persistence_for(&FAIL_RESULT_PERSISTENCE_FOR, key);
        match sender
            .send_claimed(
                test_params("closed result channel"),
                Some(key.to_string()),
                Some(generation_for(key)),
            )
            .await
        {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Persistence);
                assert!(error.commit_attempted);
            }
            _ => panic!("unavailable result persistence failure must fail closed"),
        }
        dropper.await.unwrap();
        assert!(control.is_runtime_paused());
        let record = get_idempotency_status(key).unwrap();
        assert_eq!(record.state, OutboundIdempotencyState::NeedsReconciliation);
        assert!(record.result.unwrap().commit_attempted);
    }

    #[test]
    fn sending_and_rejection_persistence_failures_are_visible() {
        clear_idempotency_rows();
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
        clear_idempotency_rows();
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
        };
        let control = Arc::new(OutboundControl::new(false));
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(config, Arc::clone(&control), rx, usage));
        let (result_tx, result_rx) = oneshot::channel();

        fail_next_persistence_for(&FAIL_SENDING_PERSISTENCE_FOR, key);
        tx.try_send(OutboundTask {
            params: test_params("will not execute"),
            enqueued_at: Instant::now(),
            idempotency_key: Some(key.to_string()),
            idempotency_generation: Some(generation_for(key)),
            result_tx,
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
        clear_idempotency_rows();
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
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(true)),
            tx,
            usage: Arc::new(Mutex::new(Usage::new())),
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
        assert_eq!(
            get_idempotency_status("k").unwrap().state,
            OutboundIdempotencyState::Rejected
        );
    }

    #[tokio::test]
    async fn read_only_duplicate_does_not_overwrite_queued_idempotency() {
        clear_idempotency_rows();
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
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(true)),
            tx,
            usage: Arc::new(Mutex::new(Usage::new())),
        };

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
        clear_idempotency_rows();
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
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(true)),
            tx,
            usage: Arc::new(Mutex::new(Usage::new())),
        };

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
    async fn resume_after_paused_duplicate_replays_once_without_requeueing() {
        clear_idempotency_rows();
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
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(true)),
            tx,
            usage: Arc::new(Mutex::new(Usage::new())),
        };

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
        clear_idempotency_rows();
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
        };
        let control = Arc::new(OutboundControl::new(true));
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(config, Arc::clone(&control), rx, usage));

        let (first_tx, first_rx) = oneshot::channel();
        assert!(matches!(
            claim_idempotency("pause-first", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.try_send(OutboundTask {
            params: test_params("first"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("pause-first".to_string()),
            idempotency_generation: Some(generation_for("pause-first")),
            result_tx: first_tx,
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
        tx.try_send(OutboundTask {
            params: test_params("second"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("pause-second".to_string()),
            idempotency_generation: Some(generation_for("pause-second")),
            result_tx: second_tx,
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
        clear_idempotency_rows();
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(30),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_millis(10),
            idempotency_ttl: Duration::from_secs(60),
            chat_cooldown: Duration::ZERO,
            hourly_budget: 10_000,
            daily_budget: 10_000,
            quiet_start_min: 0,
            quiet_end_min: 0,
            read_only: false,
        };
        let control = Arc::new(OutboundControl::new(true));
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(config, Arc::clone(&control), rx, usage));

        let (first_tx, first_rx) = oneshot::channel();
        assert!(matches!(
            claim_idempotency("ttl-first", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.try_send(OutboundTask {
            params: test_params("first"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("ttl-first".to_string()),
            idempotency_generation: Some(generation_for("ttl-first")),
            result_tx: first_tx,
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
            claim_idempotency("ttl-second", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.try_send(OutboundTask {
            params: test_params("second"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("ttl-second".to_string()),
            idempotency_generation: Some(generation_for("ttl-second")),
            result_tx: second_tx,
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
        clear_idempotency_rows();
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
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(true)),
            tx,
            usage: Arc::new(Mutex::new(Usage::new())),
        };

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
        }
    }

    #[test]
    fn uncertain_terminal_result_is_cached_and_not_retried() {
        clear_idempotency_rows();
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
        clear_idempotency_rows();
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
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(false)),
            tx,
            usage: Arc::new(Mutex::new(Usage::new())),
        };
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
        clear_idempotency_rows();
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
        };
        let control = Arc::new(OutboundControl::new(false));
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let usage = Arc::new(Mutex::new(Usage::new()));
        let worker = tokio::spawn(worker_loop(config, Arc::clone(&control), rx, usage));
        let (result_tx, result_rx) = oneshot::channel();
        assert!(matches!(
            claim_idempotency("quiet", Duration::from_secs(60)),
            IdempotencyStart::Inserted(_)
        ));
        tx.try_send(OutboundTask {
            params: test_params("quiet"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("quiet".into()),
            idempotency_generation: Some(generation_for("quiet")),
            result_tx,
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
        clear_idempotency_rows();
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
