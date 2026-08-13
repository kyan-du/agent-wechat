use std::{
    collections::{HashMap, VecDeque},
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
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    context::create_context,
    db::get_db,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboundErrorKind {
    QueueFull,
    ReadOnly,
    DuplicateInProgress,
    Expired,
    Unavailable,
}

#[derive(Debug, Clone)]
pub struct OutboundError {
    pub kind: OutboundErrorKind,
    pub retry_after: Option<Duration>,
    pub code: String,
    pub message: String,
}

impl OutboundError {
    fn queue_full(retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::QueueFull,
            retry_after: Some(retry_after),
            code: "QUEUE_FULL".to_string(),
            message: "Outbound send queue is full".to_string(),
        }
    }

    fn read_only() -> Self {
        Self {
            kind: OutboundErrorKind::ReadOnly,
            retry_after: None,
            code: "OUTBOUND_DISABLED".to_string(),
            message: "Outbound sends are disabled by read-only mode".to_string(),
        }
    }

    fn duplicate_in_progress(retry_after: Duration) -> Self {
        Self {
            kind: OutboundErrorKind::DuplicateInProgress,
            retry_after: Some(retry_after),
            code: "IDEMPOTENCY_IN_PROGRESS".to_string(),
            message: "A request with this idempotencyKey is already pending".to_string(),
        }
    }

    fn expired() -> Self {
        Self {
            kind: OutboundErrorKind::Expired,
            retry_after: None,
            code: "QUEUE_EXPIRED".to_string(),
            message: "Outbound send expired before execution".to_string(),
        }
    }

    fn unavailable() -> Self {
        Self {
            kind: OutboundErrorKind::Unavailable,
            retry_after: None,
            code: "SCHEDULER_UNAVAILABLE".to_string(),
            message: "Outbound send scheduler is unavailable".to_string(),
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
                    OutboundErrorKind::QueueFull | OutboundErrorKind::DuplicateInProgress => {
                        StatusCode::TOO_MANY_REQUESTS
                    }
                    OutboundErrorKind::ReadOnly => StatusCode::SERVICE_UNAVAILABLE,
                    OutboundErrorKind::Expired | OutboundErrorKind::Unavailable => {
                        StatusCode::SERVICE_UNAVAILABLE
                    }
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

#[derive(Clone)]
pub struct OutboundConfig {
    pub queue_capacity: usize,
    pub min_spacing: Duration,
    pub jitter: Duration,
    pub task_ttl: Duration,
    pub idempotency_ttl: Duration,
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

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name).ok()?.parse().ok()
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
    result_tx: oneshot::Sender<OutboundSendResponse>,
}

#[derive(Clone)]
pub struct OutboundSender {
    config: OutboundConfig,
    control: Arc<OutboundControl>,
    tx: mpsc::Sender<OutboundTask>,
    idempotency: Arc<Mutex<IdempotencyStore>>,
}

static OUTBOUND_SENDER: OnceLock<OutboundSender> = OnceLock::new();

pub fn outbound_sender() -> &'static OutboundSender {
    OUTBOUND_SENDER.get_or_init(|| OutboundSender::spawn(OutboundConfig::from_env()))
}

impl OutboundSender {
    pub fn spawn(config: OutboundConfig) -> Self {
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let control = Arc::new(OutboundControl::new(config.read_only));
        let idempotency = Arc::new(Mutex::new(IdempotencyStore::new(config.idempotency_ttl)));
        let worker_control = Arc::clone(&control);
        let worker_store = Arc::clone(&idempotency);
        let worker_config = config.clone();

        tokio::spawn(async move {
            worker_loop(worker_config, worker_control, rx, worker_store).await;
        });

        Self {
            config,
            control,
            tx,
            idempotency,
        }
    }

    pub async fn send(
        &self,
        params: SendMessageParams,
        idempotency_key: Option<String>,
    ) -> OutboundSendResponse {
        let now = Instant::now();
        if self.control.is_read_only() {
            cleanup_temp_files(&params);
            return OutboundSendResponse::Rejected(OutboundError::read_only());
        }

        if let Some(key) = idempotency_key.as_deref() {
            let mut store = self.idempotency.lock().expect("idempotency store poisoned");
            match store.start(key, now) {
                IdempotencyStart::Inserted => {}
                IdempotencyStart::Completed(result) => {
                    cleanup_temp_files(&params);
                    return OutboundSendResponse::Result(result);
                }
                IdempotencyStart::InProgress => {
                    cleanup_temp_files(&params);
                    return OutboundSendResponse::Rejected(OutboundError::duplicate_in_progress(
                        self.config.retry_after(),
                    ));
                }
            }
        }

        let (result_tx, result_rx) = oneshot::channel();
        let task = OutboundTask {
            params,
            enqueued_at: now,
            idempotency_key: idempotency_key.clone(),
            result_tx,
        };

        match self.tx.try_send(task) {
            Ok(()) => match result_rx.await {
                Ok(response) => response,
                Err(_) => {
                    if let Some(key) = idempotency_key.as_deref() {
                        self.idempotency
                            .lock()
                            .expect("idempotency store poisoned")
                            .complete(key, now, unavailable_result());
                    }
                    OutboundSendResponse::Rejected(OutboundError::unavailable())
                }
            },
            Err(mpsc::error::TrySendError::Full(task)) => {
                let error = OutboundError::queue_full(self.config.retry_after());
                reject_without_idempotency_cache(task, error.clone(), &self.idempotency);
                OutboundSendResponse::Rejected(error)
            }
            Err(mpsc::error::TrySendError::Closed(task)) => {
                reject_without_idempotency_cache(
                    task,
                    OutboundError::unavailable(),
                    &self.idempotency,
                );
                OutboundSendResponse::Rejected(OutboundError::unavailable())
            }
        }
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
            idempotency_entries: self
                .idempotency
                .lock()
                .expect("idempotency store poisoned")
                .len(),
        }
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
    idempotency: Arc<Mutex<IdempotencyStore>>,
) {
    let mut policy = SpacingPolicy::new(config.min_spacing, config.jitter);
    while let Some(task) = rx.recv().await {
        let now = Instant::now();
        if task_expired(&task, now, config.task_ttl) {
            reject_without_idempotency_cache(task, OutboundError::expired(), &idempotency);
            continue;
        }

        let delay = policy.next_delay(now, &mut SystemJitter);
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }

        let now = Instant::now();
        if control.is_read_only() {
            reject_without_idempotency_cache(task, OutboundError::read_only(), &idempotency);
            continue;
        }
        if task_expired(&task, now, config.task_ttl) {
            reject_without_idempotency_cache(task, OutboundError::expired(), &idempotency);
            continue;
        }

        let result = execute_send(&task.params).await;
        complete_task(task, result, &idempotency, Instant::now());
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
    let error = plan_state.diagnostic_error.or(result.error);

    SendResult {
        success: result.success,
        error_code: error.clone(),
        error,
    }
}

fn complete_task(
    task: OutboundTask,
    result: SendResult,
    idempotency: &Arc<Mutex<IdempotencyStore>>,
    now: Instant,
) {
    cleanup_temp_files(&task.params);
    if let Some(key) = task.idempotency_key.as_deref() {
        idempotency
            .lock()
            .expect("idempotency store poisoned")
            .complete(key, now, result.clone());
    }
    let _ = task.result_tx.send(OutboundSendResponse::Result(result));
}

fn reject_without_idempotency_cache(
    task: OutboundTask,
    error: OutboundError,
    idempotency: &Arc<Mutex<IdempotencyStore>>,
) {
    cleanup_temp_files(&task.params);
    if let Some(key) = task.idempotency_key.as_deref() {
        idempotency
            .lock()
            .expect("idempotency store poisoned")
            .remove(key);
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
    }
}

fn unavailable_result() -> SendResult {
    send_error("SCHEDULER_UNAVAILABLE")
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

#[derive(Clone)]
enum IdempotencyEntry {
    InProgress,
    Completed {
        expires_at: Instant,
        result: SendResult,
    },
}

enum IdempotencyStart {
    Inserted,
    InProgress,
    Completed(SendResult),
}

struct IdempotencyStore {
    ttl: Duration,
    entries: HashMap<String, IdempotencyEntry>,
    order: VecDeque<String>,
}

impl IdempotencyStore {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn start(&mut self, key: &str, now: Instant) -> IdempotencyStart {
        self.prune(now);
        match self.entries.get(key) {
            Some(IdempotencyEntry::InProgress { .. }) => IdempotencyStart::InProgress,
            Some(IdempotencyEntry::Completed { result, .. }) => {
                IdempotencyStart::Completed(result.clone())
            }
            None => {
                self.entries
                    .insert(key.to_string(), IdempotencyEntry::InProgress);
                self.order.push_back(key.to_string());
                IdempotencyStart::Inserted
            }
        }
    }

    fn complete(&mut self, key: &str, now: Instant, result: SendResult) {
        self.prune(now);
        self.entries.insert(
            key.to_string(),
            IdempotencyEntry::Completed {
                expires_at: now + self.ttl,
                result,
            },
        );
        self.order.push_back(key.to_string());
    }

    fn remove(&mut self, key: &str) {
        self.entries.remove(key);
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn prune(&mut self, now: Instant) {
        self.entries.retain(|_, entry| match entry {
            IdempotencyEntry::InProgress => true,
            IdempotencyEntry::Completed { expires_at, .. } => *expires_at > now,
        });
        self.order.retain(|key| self.entries.contains_key(key));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let now = Instant::now();
        let mut store = IdempotencyStore::new(Duration::from_secs(60));

        assert!(matches!(store.start("k", now), IdempotencyStart::Inserted));
        assert!(matches!(
            store.start("k", now + Duration::from_secs(1)),
            IdempotencyStart::InProgress
        ));

        store.complete(
            "k",
            now + Duration::from_secs(2),
            SendResult {
                success: false,
                error_code: Some("UNCERTAIN_AFTER_SEND".to_string()),
                error: Some("UNCERTAIN_AFTER_SEND".to_string()),
            },
        );

        match store.start("k", now + Duration::from_secs(3)) {
            IdempotencyStart::Completed(result) => {
                assert!(!result.success);
                assert_eq!(result.error.as_deref(), Some("UNCERTAIN_AFTER_SEND"));
            }
            _ => panic!("expected completed replay"),
        }
    }

    #[test]
    fn completed_idempotency_key_can_be_reused_after_ttl() {
        let now = Instant::now();
        let mut store = IdempotencyStore::new(Duration::from_secs(5));

        assert!(matches!(store.start("k", now), IdempotencyStart::Inserted));
        store.complete(
            "k",
            now + Duration::from_secs(1),
            SendResult {
                success: true,
                error_code: None,
                error: None,
            },
        );
        assert!(matches!(
            store.start("k", now + Duration::from_secs(6)),
            IdempotencyStart::Inserted
        ));
    }

    #[test]
    fn in_progress_idempotency_key_does_not_expire_after_ttl() {
        let now = Instant::now();
        let mut store = IdempotencyStore::new(Duration::from_secs(5));

        assert!(matches!(store.start("k", now), IdempotencyStart::Inserted));
        assert!(matches!(
            store.start("k", now + Duration::from_secs(60)),
            IdempotencyStart::InProgress
        ));
    }

    #[tokio::test]
    async fn queue_bound_rejects_when_channel_is_full() {
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::from_secs(60),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            read_only: false,
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(false)),
            tx,
            idempotency: Arc::new(Mutex::new(IdempotencyStore::new(Duration::from_secs(60)))),
        };

        let (result_tx, _result_rx) = oneshot::channel();
        sender
            .tx
            .try_send(OutboundTask {
                params: test_params("first"),
                enqueued_at: Instant::now(),
                idempotency_key: None,
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
        assert!(matches!(
            sender
                .idempotency
                .lock()
                .unwrap()
                .start("queue-full", Instant::now() + Duration::from_secs(1)),
            IdempotencyStart::Inserted
        ));
    }

    #[test]
    fn expired_task_returns_queue_expired_and_cleans_file() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let path = temp.path().to_string_lossy().to_string();
        let (result_tx, mut result_rx) = oneshot::channel();
        let task = OutboundTask {
            params: SendMessageParams {
                chat_id: "chat".to_string(),
                message: Some("hello".to_string()),
                image_path: Some(path.clone()),
                image_mime: None,
                file_path: None,
            },
            enqueued_at: Instant::now() - Duration::from_secs(10),
            idempotency_key: Some("expired".to_string()),
            result_tx,
        };
        let idempotency = Arc::new(Mutex::new(IdempotencyStore::new(Duration::from_secs(60))));

        reject_without_idempotency_cache(task, OutboundError::expired(), &idempotency);

        let result = result_rx.try_recv().unwrap();
        match result {
            OutboundSendResponse::Rejected(error) => {
                assert_eq!(error.kind, OutboundErrorKind::Expired);
                assert_eq!(error.code, "QUEUE_EXPIRED");
            }
            _ => panic!("expected expired rejection"),
        }
        assert!(!std::path::Path::new(&path).exists());
        assert!(matches!(
            idempotency
                .lock()
                .unwrap()
                .start("expired", Instant::now() + Duration::from_secs(1)),
            IdempotencyStart::Inserted
        ));
    }

    #[tokio::test]
    async fn kill_switch_rejects_without_queueing() {
        let config = OutboundConfig {
            queue_capacity: 1,
            min_spacing: Duration::ZERO,
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            read_only: true,
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(true)),
            tx,
            idempotency: Arc::new(Mutex::new(IdempotencyStore::new(Duration::from_secs(60)))),
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
    }

    #[tokio::test]
    async fn queued_task_rechecks_pause_after_spacing_delay() {
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(25),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_secs(60),
            idempotency_ttl: Duration::from_secs(60),
            read_only: false,
        };
        let control = Arc::new(OutboundControl::new(true));
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let idempotency = Arc::new(Mutex::new(IdempotencyStore::new(Duration::from_secs(60))));
        let worker = tokio::spawn(worker_loop(
            config,
            Arc::clone(&control),
            rx,
            Arc::clone(&idempotency),
        ));

        let (first_tx, first_rx) = oneshot::channel();
        tx.try_send(OutboundTask {
            params: test_params("first"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("first".to_string()),
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
        tx.try_send(OutboundTask {
            params: test_params("second"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("second".to_string()),
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
        assert!(matches!(
            idempotency
                .lock()
                .unwrap()
                .start("second", Instant::now() + Duration::from_secs(1)),
            IdempotencyStart::Inserted
        ));

        drop(tx);
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn queued_task_rechecks_ttl_after_spacing_delay() {
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(30),
            jitter: Duration::ZERO,
            task_ttl: Duration::from_millis(10),
            idempotency_ttl: Duration::from_secs(60),
            read_only: false,
        };
        let control = Arc::new(OutboundControl::new(true));
        let (tx, rx) = mpsc::channel(config.queue_capacity);
        let idempotency = Arc::new(Mutex::new(IdempotencyStore::new(Duration::from_secs(60))));
        let worker = tokio::spawn(worker_loop(
            config,
            Arc::clone(&control),
            rx,
            Arc::clone(&idempotency),
        ));

        let (first_tx, first_rx) = oneshot::channel();
        tx.try_send(OutboundTask {
            params: test_params("first"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("first".to_string()),
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
        tx.try_send(OutboundTask {
            params: test_params("second"),
            enqueued_at: Instant::now(),
            idempotency_key: Some("second".to_string()),
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
        assert!(matches!(
            idempotency
                .lock()
                .unwrap()
                .start("second", Instant::now() + Duration::from_secs(1)),
            IdempotencyStart::Inserted
        ));

        drop(tx);
        worker.await.unwrap();
    }

    #[test]
    fn status_reports_queue_config_and_idempotency_entries() {
        let config = OutboundConfig {
            queue_capacity: 2,
            min_spacing: Duration::from_millis(150),
            jitter: Duration::from_millis(25),
            task_ttl: Duration::from_secs(30),
            idempotency_ttl: Duration::from_secs(60),
            read_only: true,
        };
        let (tx, _rx) = mpsc::channel(config.queue_capacity);
        let sender = OutboundSender {
            config,
            control: Arc::new(OutboundControl::new(true)),
            tx,
            idempotency: Arc::new(Mutex::new(IdempotencyStore::new(Duration::from_secs(60)))),
        };

        sender
            .idempotency
            .lock()
            .unwrap()
            .start("status-key", Instant::now());

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
        assert_eq!(status.idempotency_entries, 1);
    }

    fn test_params(text: &str) -> SendMessageParams {
        SendMessageParams {
            chat_id: "chat".to_string(),
            message: Some(text.to_string()),
            image_path: None,
            image_mime: None,
            file_path: None,
        }
    }
}
