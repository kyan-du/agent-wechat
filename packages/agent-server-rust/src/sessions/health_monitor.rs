use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::db::get_db;
use crate::ia::identify_states;
use crate::ia::actions::close_window;
use crate::ia::helpers::action_frame;
use crate::sessions::manager::current_session;
use crate::tools::a11y::get_a11y_desktop;
use crate::tools::exec::ExecOptions;
use crate::tools::screenshot::capture_screenshot;
use crate::tools::wechat_db::find_wechat_pid;
use crate::tools::wechat_keys::{extract_keys_async, needs_key_extraction, store_keys};

/// How often to run the health scan (in seconds).
const SCAN_INTERVAL_SECS: u64 = 1;

/// Kill WeChat if no IA state has been identified for this long (in seconds).
const UNRESPONSIVE_TIMEOUT_SECS: u64 = 60;

/// Delay before restarting WeChat after a crash (in seconds).
const RESTART_DELAY_SECS: u64 = 3;

/// If WeChat crashes this many times within RAPID_WINDOW_SECS, back off.
const MAX_RAPID_RESTARTS: u32 = 5;
const RAPID_WINDOW_SECS: u64 = 60;
const BACKOFF_DELAY_SECS: u64 = 30;

/// After docker/WeChat restart the official client parks on saved-account
/// LoginAccount. VNC is view-only, so the health monitor clicks Log In.
const LOGIN_RESUME_COOLDOWN: Duration = Duration::from_secs(8);
const LOGIN_RESUME_MAX_CLICKS: u32 = 5;

/// Back off failed logged-in key extraction so the 1s health tick cannot re-enter.
const HOT_PATH_EXTRACT_BACKOFF: Duration = Duration::from_secs(30);

fn is_logged_in_chat_state(state_id: Option<&str>) -> bool {
    matches!(state_id, Some("chat") | Some("chat_open"))
}

/// Pure gate for logged-in hot-path key extraction (no WeChat / DB I/O).
struct HotPathExtractInput<'a> {
    session_running: bool,
    has_logged_in_user: bool,
    has_wechat_pid: bool,
    state_id: Option<&'a str>,
    monitoring_paused: bool,
    in_flight: bool,
    satisfied: bool,
    needs_extraction: bool,
    backoff_until: Option<Instant>,
    now: Instant,
}

fn hot_path_ready_to_inspect(input: &HotPathExtractInput<'_>) -> bool {
    if input.monitoring_paused
        || !input.session_running
        || !input.has_logged_in_user
        || !input.has_wechat_pid
        || !is_logged_in_chat_state(input.state_id)
        || input.satisfied
        || input.in_flight
    {
        return false;
    }
    match input.backoff_until {
        Some(until) if input.now < until => false,
        _ => true,
    }
}

fn hot_path_should_extract(input: &HotPathExtractInput<'_>) -> bool {
    hot_path_ready_to_inspect(input) && input.needs_extraction
}

#[derive(Default)]
struct HotPathExtractRuntime {
    in_flight: AtomicBool,
    satisfied: AtomicBool,
    backoff_until: Mutex<Option<Instant>>,
}

impl HotPathExtractRuntime {
    fn snapshot_gate(&self) -> (bool, bool, Option<Instant>) {
        (
            self.in_flight.load(Ordering::SeqCst),
            self.satisfied.load(Ordering::SeqCst),
            self.backoff_until.lock().ok().and_then(|guard| *guard),
        )
    }

    fn try_begin(&self) -> bool {
        self.in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn mark_satisfied(&self) {
        self.satisfied.store(true, Ordering::SeqCst);
        self.in_flight.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.backoff_until.lock() {
            *guard = None;
        }
    }

    fn finish_success(&self) {
        self.mark_satisfied();
    }

    fn finish_failure(&self, now: Instant) {
        self.in_flight.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.backoff_until.lock() {
            *guard = Some(now + HOT_PATH_EXTRACT_BACKOFF);
        }
    }
}

fn maybe_spawn_hot_path_key_extract(
    session: &crate::ia::types::Session,
    wechat_pid: i64,
    state_id: Option<&str>,
    runtime: &Arc<HotPathExtractRuntime>,
) {
    let (in_flight, satisfied, backoff_until) = runtime.snapshot_gate();
    let inspect = HotPathExtractInput {
        session_running: session.status == "running",
        has_logged_in_user: session.logged_in_user.is_some(),
        has_wechat_pid: true,
        state_id,
        monitoring_paused: MONITORING_PAUSED.load(Ordering::Relaxed),
        in_flight,
        satisfied,
        needs_extraction: true,
        backoff_until,
        now: Instant::now(),
    };
    if !hot_path_ready_to_inspect(&inspect) {
        return;
    }
    let Some(account_dir) = session.logged_in_user.clone() else {
        return;
    };

    let needs = {
        let db = get_db();
        needs_key_extraction(&db, &session.id, &account_dir)
    };
    if !needs {
        runtime.mark_satisfied();
        return;
    }
    if !runtime.try_begin() {
        return;
    }

    tracing::info!(
        "[wechat-keys] health/hot-path triggering key extraction session={} pid={}",
        session.id,
        wechat_pid
    );

    let session_id = session.id.clone();
    let runtime = Arc::clone(runtime);
    tokio::spawn(async move {
        let keys = extract_keys_async(wechat_pid).await;
        if keys.is_empty() {
            tracing::warn!(
                "[wechat-keys] health/hot-path extraction returned no keys; backing off"
            );
            runtime.finish_failure(Instant::now());
            return;
        }
        {
            let db = get_db();
            store_keys(&db, &session_id, &account_dir, &keys);
        }
        let has_image_aes = keys.contains_key("_image_aes");
        tracing::info!(
            "[wechat-keys] health/hot-path stored keys, image key: {}",
            if has_image_aes { "yes" } else { "no" }
        );
        if has_image_aes {
            runtime.finish_success();
        } else {
            tracing::warn!(
                "[wechat-keys] health/hot-path still missing _image_aes; backing off"
            );
            runtime.finish_failure(Instant::now());
        }
    });
}

/// Overlay that must not sit on top of a saved-account Log In click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResumeOverlay {
    None,
    Security,
    Popup,
    Settings,
    ContactCard,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LoginResumeSnapshot {
    state_id: Option<String>,
    has_logged_in_user: bool,
    overlay: ResumeOverlay,
}

impl LoginResumeSnapshot {
    fn from_identified(
        identified: &crate::ia::types::IdentifiedStates,
        has_logged_in_user: bool,
    ) -> Self {
        let overlay = if identified
            .popup
            .as_ref()
            .is_some_and(|popup| popup.state_id == "popup_security")
        {
            ResumeOverlay::Security
        } else if identified.popup.is_some() {
            ResumeOverlay::Popup
        } else if identified.settings.is_some() {
            ResumeOverlay::Settings
        } else if identified.contact_card.is_some() {
            ResumeOverlay::ContactCard
        } else {
            ResumeOverlay::None
        };
        Self {
            state_id: identified
                .main_window
                .as_ref()
                .map(|state| state.state_id.clone()),
            has_logged_in_user,
            overlay,
        }
    }

    fn is_bare_login_account(&self) -> bool {
        self.state_id.as_deref() == Some("login_account")
            && self.has_logged_in_user
            && self.overlay == ResumeOverlay::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResumeDecision {
    Click,
    Skip,
    TripSecurity,
}

/// Click budget / cooldown for auto-resuming a previously logged-in account.
/// Never clicks Switch Account. Stops once the UI leaves `login_account`.
#[derive(Debug, Default)]
struct LoginResumePolicy {
    last_click: Option<Instant>,
    clicks: u32,
}

impl LoginResumePolicy {
    fn reset(&mut self) {
        self.last_click = None;
        self.clicks = 0;
    }

    fn observe(&mut self, state_id: Option<&str>) {
        if state_id != Some("login_account") {
            self.clicks = 0;
        }
    }

    fn should_click(&self, snap: &LoginResumeSnapshot, now: Instant) -> bool {
        if !snap.is_bare_login_account() {
            return false;
        }
        if self.clicks >= LOGIN_RESUME_MAX_CLICKS {
            return false;
        }
        match self.last_click {
            None => true,
            Some(last) => now.saturating_duration_since(last) >= LOGIN_RESUME_COOLDOWN,
        }
    }

    fn decide(&self, snap: &LoginResumeSnapshot, now: Instant) -> ResumeDecision {
        if snap.overlay == ResumeOverlay::Security {
            return ResumeDecision::TripSecurity;
        }
        if self.should_click(snap, now) {
            ResumeDecision::Click
        } else {
            ResumeDecision::Skip
        }
    }

    /// Authoritative decision is the snapshot taken under the plan lock.
    fn decide_after_lock(
        &self,
        _candidate: &LoginResumeSnapshot,
        locked: &LoginResumeSnapshot,
        now: Instant,
    ) -> ResumeDecision {
        self.decide(locked, now)
    }

    fn record_click(&mut self, now: Instant) {
        self.last_click = Some(now);
        self.clicks = self.clicks.saturating_add(1);
    }

    fn budget_exhausted(&self) -> bool {
        self.clicks >= LOGIN_RESUME_MAX_CLICKS
    }
}

/// Global flag to pause health monitoring during active execution loops.
static MONITORING_PAUSED: AtomicBool = AtomicBool::new(false);

/// Pause health monitoring (call when an execution loop starts).
pub fn pause_monitoring() {
    MONITORING_PAUSED.store(true, Ordering::Relaxed);
}

/// Resume health monitoring (call when an execution loop ends).
pub fn resume_monitoring() {
    MONITORING_PAUSED.store(false, Ordering::Relaxed);
}

fn should_close_weixin_update(identified: &crate::ia::types::IdentifiedStates) -> bool {
    identified
        .popup
        .as_ref()
        .is_some_and(|popup| popup.state_id == "popup_weixin_update")
}

/// Spawn WeChat process for the given session using the shared launch script.
fn spawn_wechat(session: &crate::ia::types::Session) {
    // Use DBUS_SESSION_BUS_ADDRESS from our own environment (inherited from
    // entrypoint.sh) rather than the DB value. The entrypoint's D-Bus session
    // is the one AT-SPI is connected to, so WeChat must use it for a11y to work.
    let result = std::process::Command::new("/opt/tools/launch-wechat")
        .env("DISPLAY", &session.display)
        .env("WECHAT_HOME", format!("/home/{}", session.linux_user))
        .env("WECHAT_USER", &session.linux_user)
        .spawn();

    match result {
        Ok(_) => tracing::info!("[health] Spawned WeChat for session '{}'", session.name),
        Err(e) => tracing::error!("[health] Failed to spawn WeChat: {}", e),
    }
}

/// Spawn the background health monitor task.
///
/// Every second, it checks the default session's WeChat process by running
/// a11y → identify. If WeChat has crashed, it restarts it. If no IA state
/// has been identified for more than 60 seconds, it kills and restarts it.
/// After a container restart the official client often sits on saved-account
/// LoginAccount; if this session already has a logged-in user, the monitor
/// clicks Log In via AT-SPI (VNC is view-only) and never Switch Account.
pub fn spawn_health_monitor() {
    tokio::spawn(async move {
        tracing::info!("[health] WeChat health monitor started");

        let mut last_identified = Instant::now();
        let mut was_running = false;
        let mut restart_count: u32 = 0;
        let mut window_start = Instant::now();
        let mut waiting_restart_since: Option<Instant> = None;
        let mut login_resume = LoginResumePolicy::default();
        let mut login_resume_exhausted_logged = false;
        let hot_path_extract = Arc::new(HotPathExtractRuntime::default());

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SCAN_INTERVAL_SECS)).await;

            // Skip if monitoring is paused (an execution loop is active)
            if MONITORING_PAUSED.load(Ordering::Relaxed) {
                last_identified = Instant::now();
                continue;
            }

            // Only monitor the default session
            let session = match current_session() {
                Some(s) if s.status == "running" => s,
                _ => {
                    last_identified = Instant::now();
                    continue;
                }
            };

            // Check if WeChat process is even running
            let wechat_pid = match find_wechat_pid() {
                Some(pid) => {
                    if !was_running {
                        tracing::info!("[health] WeChat process found (pid={})", pid);
                        was_running = true;
                        waiting_restart_since = None;
                    }
                    pid
                }
                None => {
                    if was_running {
                        tracing::warn!(
                            "[health] WeChat process disappeared (likely crashed), restarting"
                        );
                        was_running = false;
                        waiting_restart_since = Some(Instant::now());
                        login_resume.reset();
                        login_resume_exhausted_logged = false;
                    }

                    // Handle restart with crash loop protection
                    if let Some(since) = waiting_restart_since {
                        // Check crash loop
                        if window_start.elapsed().as_secs() > RAPID_WINDOW_SECS {
                            restart_count = 0;
                            window_start = Instant::now();
                        }

                        let delay = if restart_count >= MAX_RAPID_RESTARTS {
                            if since.elapsed().as_secs() == RESTART_DELAY_SECS {
                                tracing::warn!(
                                    "[health] Crash loop detected ({} restarts in {}s), backing off to {}s",
                                    restart_count, RAPID_WINDOW_SECS, BACKOFF_DELAY_SECS
                                );
                            }
                            BACKOFF_DELAY_SECS
                        } else {
                            RESTART_DELAY_SECS
                        };

                        if since.elapsed().as_secs() >= delay {
                            spawn_wechat(&session);
                            restart_count += 1;
                            waiting_restart_since = None;
                        }
                    }

                    last_identified = Instant::now();
                    continue;
                }
            };

            // Run a11y + identify to see if we can detect any state
            let exec_options = ExecOptions {
                session: Some(session.clone()),
                timeout_ms: 10_000,
            };

            let a11y = match get_a11y_desktop(&exec_options).await {
                Ok(tree) => tree,
                Err(_) => {
                    // a11y failed — count as unresponsive, don't reset timer
                    check_and_kill(wechat_pid, &last_identified);
                    continue;
                }
            };

            let screenshot = capture_screenshot(&exec_options).await.unwrap_or_default();
            let identified = identify_states(&a11y, &screenshot);

            if identified.main_window.is_some() || identified.popup.is_some() {
                // State identified — WeChat is responsive
                last_identified = Instant::now();
            } else {
                // No state identified — check timeout
                check_and_kill(wechat_pid, &last_identified);
            }

            if should_close_weixin_update(&identified) {
                let action = close_window();
                let frame = action_frame(&identified);
                match crate::execution::actions::execute_action(
                    &action,
                    frame.as_ref(),
                    &exec_options,
                    &a11y,
                    &|_event: crate::ia::types::SubscriptionEvent| {},
                )
                .await
                {
                    Ok(_) => tracing::info!("[health] Closed Weixin update overlay"),
                    Err(error) => tracing::warn!(
                        "[health] Failed to close Weixin update overlay code={}",
                        error.diagnostic
                    ),
                }
                continue;
            }

            let candidate = LoginResumeSnapshot::from_identified(
                &identified,
                session.logged_in_user.is_some(),
            );
            login_resume.observe(candidate.state_id.as_deref());
            if candidate.state_id.as_deref() != Some("login_account") {
                login_resume_exhausted_logged = false;
            }

            if is_logged_in_chat_state(candidate.state_id.as_deref()) {
                maybe_spawn_hot_path_key_extract(
                    &session,
                    wechat_pid,
                    candidate.state_id.as_deref(),
                    &hot_path_extract,
                );
            }

            match login_resume.decide(&candidate, Instant::now()) {
                ResumeDecision::TripSecurity => {
                    crate::outbound::outbound_sender().trip_kill_switch("security_popup");
                    continue;
                }
                ResumeDecision::Skip => {
                    if candidate.state_id.as_deref() == Some("login_account")
                        && candidate.has_logged_in_user
                        && candidate.overlay == ResumeOverlay::None
                        && login_resume.budget_exhausted()
                        && !login_resume_exhausted_logged
                    {
                        tracing::warn!(
                            "[health] LoginAccount resume click budget exhausted; waiting for explicit login"
                        );
                        login_resume_exhausted_logged = true;
                    }
                    continue;
                }
                ResumeDecision::Click => {}
            }

            let Some(_plan_guard) = crate::execution::try_acquire_plan_lock() else {
                continue;
            };

            let session = match current_session() {
                Some(s) if s.status == "running" => s,
                _ => continue,
            };
            let exec_options = ExecOptions {
                session: Some(session.clone()),
                timeout_ms: 10_000,
            };
            let a11y = match get_a11y_desktop(&exec_options).await {
                Ok(tree) => tree,
                Err(_) => continue,
            };
            let screenshot = capture_screenshot(&exec_options).await.unwrap_or_default();
            let identified = identify_states(&a11y, &screenshot);
            let locked = LoginResumeSnapshot::from_identified(
                &identified,
                session.logged_in_user.is_some(),
            );

            match login_resume.decide_after_lock(&candidate, &locked, Instant::now()) {
                ResumeDecision::TripSecurity => {
                    crate::outbound::outbound_sender().trip_kill_switch("security_popup");
                    continue;
                }
                ResumeDecision::Skip => continue,
                ResumeDecision::Click => {}
            }

            let Some(action) = crate::ia::actions::saved_account_login_click(&a11y) else {
                continue;
            };
            let frame = identified
                .main_window
                .as_ref()
                .and_then(|state| state.frame.clone());
            tracing::info!(
                "[health] LoginAccount with saved session; clicking Log In (attempt {})",
                login_resume.clicks + 1
            );
            let emit = |_event: crate::ia::types::SubscriptionEvent| {};
            match crate::execution::actions::execute_action(
                &action,
                frame.as_ref(),
                &exec_options,
                &a11y,
                &emit,
            )
            .await
            {
                Ok(_) => tracing::info!("[health] Saved-account Log In click dispatched"),
                Err(error) => tracing::warn!(
                    "[health] Saved-account Log In click failed code={}",
                    error.diagnostic
                ),
            }
            login_resume.record_click(Instant::now());
        }
    });
}

/// If time since last identified state exceeds the timeout, kill the WeChat process.
fn check_and_kill(wechat_pid: i64, last_identified: &Instant) {
    let elapsed = last_identified.elapsed();
    if elapsed.as_secs() >= UNRESPONSIVE_TIMEOUT_SECS {
        tracing::warn!(
            "[health] WeChat (pid={}) unresponsive for {}s, killing process",
            wechat_pid,
            elapsed.as_secs()
        );

        let result = std::process::Command::new("kill")
            .args(["-9", &wechat_pid.to_string()])
            .output();

        match result {
            Ok(output) if output.status.success() => {
                tracing::info!(
                    "[health] Killed WeChat pid={}, will restart automatically",
                    wechat_pid
                );
            }
            Ok(output) => {
                tracing::warn!(
                    "[health] kill returned non-zero for pid={}: {}",
                    wechat_pid,
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(e) => {
                tracing::error!("[health] Failed to kill WeChat pid={}: {}", wechat_pid, e);
            }
        }
    } else {
        tracing::debug!(
            "[health] WeChat unresponsive for {}s (threshold: {}s)",
            elapsed.as_secs(),
            UNRESPONSIVE_TIMEOUT_SECS
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ia::types::{IdentifiedState, IdentifiedStates};

    fn snap(state: Option<&str>, user: bool, overlay: ResumeOverlay) -> LoginResumeSnapshot {
        LoginResumeSnapshot {
            state_id: state.map(str::to_string),
            has_logged_in_user: user,
            overlay,
        }
    }

    fn bare_login(user: bool) -> LoginResumeSnapshot {
        snap(Some("login_account"), user, ResumeOverlay::None)
    }

    fn identified(
        main: Option<&str>,
        popup: Option<&str>,
        settings: bool,
        card: bool,
    ) -> IdentifiedStates {
        let state = |id: &str, fsm: &str| IdentifiedState {
            state_id: id.to_string(),
            fsm: fsm.to_string(),
            frame: None,
        };
        IdentifiedStates {
            main_window: main.map(|id| state(id, "mainWindow")),
            popup: popup.map(|id| state(id, "popup")),
            contact_card: card.then(|| state("contact_card", "contactCard")),
            settings: settings.then(|| state("settings", "settings")),
        }
    }

    #[test]
    fn update_popup_is_closed_but_other_popups_are_not() {
        assert!(should_close_weixin_update(&identified(None, Some("popup_weixin_update"), false, false)));
        assert!(!should_close_weixin_update(&identified(None, Some("popup_security"), false, false)));
        assert!(!should_close_weixin_update(&identified(Some("chat"), Some("popup_confirm"), false, false)));
    }

    #[test]
    fn clicks_login_account_only_when_session_has_saved_user() {
        let policy = LoginResumePolicy::default();
        let now = Instant::now();
        assert!(policy.should_click(&bare_login(true), now));
        assert!(!policy.should_click(&bare_login(false), now));
        assert!(!policy.should_click(&snap(Some("login_qr"), true, ResumeOverlay::None), now));
        assert!(!policy.should_click(
            &snap(Some("login_phone_confirm"), true, ResumeOverlay::None),
            now
        ));
        assert!(!policy.should_click(&snap(Some("chat"), true, ResumeOverlay::None), now));
        assert!(!policy.should_click(&snap(None, true, ResumeOverlay::None), now));
    }

    #[test]
    fn cooldown_blocks_immediate_retry() {
        let mut policy = LoginResumePolicy::default();
        let now = Instant::now();
        assert!(policy.should_click(&bare_login(true), now));
        policy.record_click(now);
        assert!(!policy.should_click(&bare_login(true), now));
        assert!(policy.should_click(&bare_login(true), now + LOGIN_RESUME_COOLDOWN));
    }

    #[test]
    fn click_budget_stops_after_max_attempts() {
        let mut policy = LoginResumePolicy::default();
        let mut now = Instant::now();
        for _ in 0..LOGIN_RESUME_MAX_CLICKS {
            assert!(policy.should_click(&bare_login(true), now));
            policy.record_click(now);
            now += LOGIN_RESUME_COOLDOWN;
        }
        assert!(policy.budget_exhausted());
        assert!(!policy.should_click(&bare_login(true), now));
    }

    #[test]
    fn leaving_login_account_resets_click_budget() {
        let mut policy = LoginResumePolicy::default();
        let now = Instant::now();
        for _ in 0..LOGIN_RESUME_MAX_CLICKS {
            policy.record_click(now);
        }
        assert!(policy.budget_exhausted());
        policy.observe(Some("login_phone_confirm"));
        assert!(!policy.budget_exhausted());
        assert!(policy.should_click(&bare_login(true), now + LOGIN_RESUME_COOLDOWN));
    }

    #[test]
    fn process_reset_allows_immediate_click() {
        let mut policy = LoginResumePolicy::default();
        let now = Instant::now();
        policy.record_click(now);
        assert!(!policy.should_click(&bare_login(true), now));
        policy.reset();
        assert!(policy.should_click(&bare_login(true), now));
    }

    #[test]
    fn lock_reobserve_after_logout_does_not_click_or_spend_budget() {
        let policy = LoginResumePolicy::default();
        let now = Instant::now();
        let candidate = bare_login(true);
        let locked = bare_login(false);
        assert_eq!(policy.decide(&candidate, now), ResumeDecision::Click);
        assert_eq!(
            policy.decide_after_lock(&candidate, &locked, now),
            ResumeDecision::Skip
        );
        assert_eq!(policy.clicks, 0);
        assert!(!policy.budget_exhausted());
    }

    #[test]
    fn lock_reobserve_after_login_plan_does_not_click() {
        let policy = LoginResumePolicy::default();
        let now = Instant::now();
        let candidate = bare_login(true);
        let locked = snap(Some("chat"), true, ResumeOverlay::None);
        assert_eq!(
            policy.decide_after_lock(&candidate, &locked, now),
            ResumeDecision::Skip
        );
        assert_eq!(policy.clicks, 0);
    }

    #[test]
    fn overlays_skip_click_and_do_not_consume_budget() {
        let policy = LoginResumePolicy::default();
        let now = Instant::now();
        for overlay in [
            ResumeOverlay::Popup,
            ResumeOverlay::Settings,
            ResumeOverlay::ContactCard,
        ] {
            let snap = snap(Some("login_account"), true, overlay);
            assert_eq!(policy.decide(&snap, now), ResumeDecision::Skip);
        }
        assert_eq!(policy.clicks, 0);
    }

    #[test]
    fn security_popup_trips_kill_switch_without_click_or_budget() {
        let policy = LoginResumePolicy::default();
        let now = Instant::now();
        let snap = snap(Some("login_account"), true, ResumeOverlay::Security);
        assert_eq!(policy.decide(&snap, now), ResumeDecision::TripSecurity);
        assert_eq!(policy.clicks, 0);
        let from_tree = LoginResumeSnapshot::from_identified(
            &identified(Some("login_account"), Some("popup_security"), false, false),
            true,
        );
        assert_eq!(from_tree.overlay, ResumeOverlay::Security);
        assert!(!from_tree.is_bare_login_account());
    }

    #[test]
    fn logout_must_clear_saved_user_before_releasing_plan_lock() {
        // LogoutPlan succeeds when the UI is already login_account.
        // If logged_in_user is still Some when PLAN_LOCK drops, auto-resume clicks.
        let policy = LoginResumePolicy::default();
        let now = Instant::now();
        let after_plan_before_clear = bare_login(true);
        assert_eq!(
            policy.decide(&after_plan_before_clear, now),
            ResumeDecision::Click
        );
        let after_clear_under_lock = bare_login(false);
        assert_eq!(
            policy.decide(&after_clear_under_lock, now),
            ResumeDecision::Skip
        );
        assert_eq!(policy.clicks, 0);
    }

    #[test]
    fn from_identified_maps_ordinary_overlays() {
        let popup = LoginResumeSnapshot::from_identified(
            &identified(Some("login_account"), Some("popup_confirm"), false, false),
            true,
        );
        assert_eq!(popup.overlay, ResumeOverlay::Popup);
        let settings = LoginResumeSnapshot::from_identified(
            &identified(Some("login_account"), None, true, false),
            true,
        );
        assert_eq!(settings.overlay, ResumeOverlay::Settings);
        let card = LoginResumeSnapshot::from_identified(
            &identified(Some("login_account"), None, false, true),
            true,
        );
        assert_eq!(card.overlay, ResumeOverlay::ContactCard);
        let bare = LoginResumeSnapshot::from_identified(
            &identified(Some("login_account"), None, false, false),
            true,
        );
        assert!(bare.is_bare_login_account());
    }

    fn hot_path_base(now: Instant) -> HotPathExtractInput<'static> {
        HotPathExtractInput {
            session_running: true,
            has_logged_in_user: true,
            has_wechat_pid: true,
            state_id: Some("chat"),
            monitoring_paused: false,
            in_flight: false,
            satisfied: false,
            needs_extraction: true,
            backoff_until: None,
            now,
        }
    }

    #[test]
    fn hot_path_triggers_when_logged_in_chat_needs_image_aes() {
        let now = Instant::now();
        assert!(hot_path_should_extract(&hot_path_base(now)));
        let mut chat_open = hot_path_base(now);
        chat_open.state_id = Some("chat_open");
        assert!(hot_path_should_extract(&chat_open));
    }

    #[test]
    fn hot_path_skips_when_image_aes_already_present() {
        let now = Instant::now();
        let mut input = hot_path_base(now);
        input.needs_extraction = false;
        assert!(hot_path_ready_to_inspect(&input));
        assert!(!hot_path_should_extract(&input));
        input.satisfied = true;
        assert!(!hot_path_ready_to_inspect(&input));
        assert!(!hot_path_should_extract(&input));
    }

    #[test]
    fn hot_path_does_not_reenter_while_extraction_in_flight() {
        let now = Instant::now();
        let mut input = hot_path_base(now);
        input.in_flight = true;
        assert!(!hot_path_ready_to_inspect(&input));
        assert!(!hot_path_should_extract(&input));
        let runtime = HotPathExtractRuntime::default();
        assert!(runtime.try_begin());
        assert!(!runtime.try_begin());
        runtime.finish_success();
        let (in_flight, satisfied, backoff) = runtime.snapshot_gate();
        assert!(!in_flight);
        assert!(satisfied);
        assert!(backoff.is_none());
        input.in_flight = false;
        input.satisfied = true;
        input.needs_extraction = false;
        assert!(!hot_path_should_extract(&input));
    }

    #[test]
    fn hot_path_skips_login_account_and_paused_monitor() {
        let now = Instant::now();
        let mut input = hot_path_base(now);
        input.state_id = Some("login_account");
        assert!(!hot_path_should_extract(&input));
        input.state_id = Some("chat");
        input.monitoring_paused = true;
        assert!(!hot_path_should_extract(&input));
        input.monitoring_paused = false;
        input.session_running = false;
        assert!(!hot_path_should_extract(&input));
        input.session_running = true;
        input.has_logged_in_user = false;
        assert!(!hot_path_should_extract(&input));
        input.has_logged_in_user = true;
        input.has_wechat_pid = false;
        assert!(!hot_path_should_extract(&input));
    }

    #[test]
    fn hot_path_failure_backs_off_instead_of_extracting_every_tick() {
        let now = Instant::now();
        let runtime = HotPathExtractRuntime::default();
        assert!(runtime.try_begin());
        runtime.finish_failure(now);
        let (in_flight, satisfied, backoff) = runtime.snapshot_gate();
        assert!(!in_flight);
        assert!(!satisfied);
        assert_eq!(backoff, Some(now + HOT_PATH_EXTRACT_BACKOFF));
        let mut input = hot_path_base(now);
        input.backoff_until = backoff;
        assert!(!hot_path_should_extract(&input));
        input.now = now + HOT_PATH_EXTRACT_BACKOFF;
        assert!(hot_path_should_extract(&input));
    }
}
