use crate::contracts::{ActionEnvelope, AllowedApplication, DesktopAction};
use axum::http::StatusCode;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use thiserror::Error;

const DISCOVER_TIMEOUT: Duration = Duration::from_secs(3);
const INSPECT_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(250);
const HEARTBEAT_STALE_AFTER: Duration = Duration::from_secs(8);
const MUTATION_OBSERVATION_TIMEOUT: Duration = Duration::from_millis(750);
const MUTATION_OBSERVATION_INTERVAL: Duration = Duration::from_millis(10);
const REQUEST_QUEUE_CAPACITY: usize = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopActionOutput {
    pub summary: String,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DesktopExecutionError {
    #[error("desktop application is outside the configured allowlist")]
    AppNotAllowed,
    #[error("desktop window identity is missing or stale")]
    WindowStale,
    #[error("desktop accessibility-tree revision is stale")]
    TreeStale,
    #[error("desktop accessibility node identity is missing or stale")]
    NodeStale,
    #[error("requested UI Automation control pattern is unavailable")]
    UnsupportedPattern,
    #[error("requested UI Automation value is read-only")]
    ReadOnly,
    #[error("desktop action exceeded its fixed runtime bound")]
    Timeout,
    #[error("desktop UI Automation is unavailable")]
    Unavailable,
    #[error("desktop UI Automation failed closed")]
    FailedClosed,
    #[error("desktop mutation outcome is uncertain and must not be retried automatically")]
    OutcomeUncertain,
}

impl DesktopExecutionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AppNotAllowed => "desktop_app_not_allowed",
            Self::WindowStale => "desktop_window_stale",
            Self::TreeStale => "desktop_tree_stale",
            Self::NodeStale => "desktop_node_stale",
            Self::UnsupportedPattern => "desktop_pattern_unsupported",
            Self::ReadOnly => "desktop_value_read_only",
            Self::Timeout => "desktop_timeout",
            Self::Unavailable => "desktop_unavailable",
            Self::FailedClosed => "desktop_failed_closed",
            Self::OutcomeUncertain => "desktop_outcome_uncertain",
        }
    }

    pub fn public_summary(&self) -> &'static str {
        match self {
            Self::AppNotAllowed => "The target application is not allowlisted.",
            Self::WindowStale => "The recorded desktop window is no longer authoritative.",
            Self::TreeStale => "The accessibility tree changed; inspect again before acting.",
            Self::NodeStale => "The selected accessibility node is no longer authoritative.",
            Self::UnsupportedPattern => "The selected control does not expose the required UI Automation pattern.",
            Self::ReadOnly => "The selected control exposes a read-only value.",
            Self::Timeout => "The desktop provider did not finish inside the fixed deadline.",
            Self::Unavailable => "The Windows UI Automation worker is unavailable.",
            Self::FailedClosed => "The desktop action could not be verified and was rejected.",
            Self::OutcomeUncertain => "The desktop operation may have completed, but its post-write state could not be verified. Do not retry it automatically.",
        }
    }

    pub fn http_status(&self) -> StatusCode {
        match self {
            Self::AppNotAllowed => StatusCode::FORBIDDEN,
            Self::WindowStale | Self::TreeStale | Self::NodeStale | Self::OutcomeUncertain => {
                StatusCode::CONFLICT
            }
            Self::UnsupportedPattern | Self::ReadOnly => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Timeout => StatusCode::GATEWAY_TIMEOUT,
            Self::Unavailable | Self::FailedClosed => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

pub trait DesktopExecutor: Send + Sync {
    fn allowed_app_ids(&self) -> Vec<String>;
    fn is_healthy(&self) -> bool {
        true
    }
    fn execute(
        &self,
        envelope: ActionEnvelope,
    ) -> Result<DesktopActionOutput, DesktopExecutionError>;
}

enum WorkerRequest {
    Execute {
        envelope: ActionEnvelope,
        authority: RequestAuthority,
        response: mpsc::SyncSender<Result<DesktopActionOutput, DesktopExecutionError>>,
    },
    Probe {
        authority: RequestAuthority,
        response: mpsc::SyncSender<Result<(), DesktopExecutionError>>,
    },
}

#[derive(Clone, Copy, Debug)]
struct RequestAuthority {
    deadline: Instant,
    generation: u64,
}

#[derive(Clone)]
struct WorkerState {
    healthy: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    heartbeat: Arc<AtomicU64>,
    epoch: Instant,
}

impl WorkerState {
    fn new() -> Self {
        Self {
            healthy: Arc::new(AtomicBool::new(true)),
            generation: Arc::new(AtomicU64::new(1)),
            heartbeat: Arc::new(AtomicU64::new(0)),
            epoch: Instant::now(),
        }
    }

    fn now_tick(&self) -> u64 {
        self.epoch.elapsed().as_nanos().min(u64::MAX as u128) as u64
    }

    fn record_heartbeat(&self) {
        self.heartbeat.store(self.now_tick(), Ordering::Release);
    }

    fn heartbeat_age(&self) -> Duration {
        let age = self
            .now_tick()
            .saturating_sub(self.heartbeat.load(Ordering::Acquire));
        Duration::from_nanos(age)
    }

    fn is_current(&self, authority: RequestAuthority) -> bool {
        self.healthy.load(Ordering::Acquire)
            && self.generation.load(Ordering::Acquire) == authority.generation
            && Instant::now() < authority.deadline
    }

    fn check(&self, authority: RequestAuthority) -> Result<(), DesktopExecutionError> {
        if !self.healthy.load(Ordering::Acquire)
            || self.generation.load(Ordering::Acquire) != authority.generation
        {
            return Err(DesktopExecutionError::Unavailable);
        }
        if Instant::now() >= authority.deadline {
            return Err(DesktopExecutionError::Timeout);
        }
        Ok(())
    }

    fn mark_unhealthy(&self) {
        if self.healthy.swap(false, Ordering::AcqRel) {
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
    }
}

struct WorkerLifecycle {
    state: WorkerState,
}

impl Drop for WorkerLifecycle {
    fn drop(&mut self) {
        self.state.mark_unhealthy();
    }
}

#[derive(Clone)]
struct ExecutionGuard {
    authority: RequestAuthority,
    state: WorkerState,
}

impl ExecutionGuard {
    fn check(&self) -> Result<(), DesktopExecutionError> {
        self.state.check(self.authority)
    }

    fn observation_deadline(&self) -> Instant {
        std::cmp::min(
            self.authority.deadline,
            Instant::now() + MUTATION_OBSERVATION_TIMEOUT,
        )
    }
}

fn run_authorized<T>(
    state: &WorkerState,
    authority: RequestAuthority,
    operation: impl FnOnce(&ExecutionGuard) -> Result<T, DesktopExecutionError>,
) -> Result<T, DesktopExecutionError> {
    let guard = ExecutionGuard {
        authority,
        state: state.clone(),
    };
    guard.check()?;
    operation(&guard)
}

pub struct UiaBroker {
    allowed_app_ids: Vec<String>,
    sender: mpsc::SyncSender<WorkerRequest>,
    state: WorkerState,
    heartbeat_stale_after: Duration,
}

impl UiaBroker {
    pub fn start(
        allowed_apps: Vec<AllowedApplication>,
    ) -> Result<Arc<Self>, DesktopExecutionError> {
        let allowed_app_ids = allowed_apps
            .iter()
            .map(|app| app.app_id.clone())
            .collect::<Vec<_>>();
        let (sender, receiver) = mpsc::sync_channel::<WorkerRequest>(REQUEST_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let state = WorkerState::new();
        state.record_heartbeat();
        let worker_state = state.clone();
        std::thread::Builder::new()
            .name("provenance-uia-mta".into())
            .spawn(move || worker_main(allowed_apps, receiver, ready_sender, worker_state))
            .map_err(|_| DesktopExecutionError::Unavailable)?;
        ready_receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| DesktopExecutionError::Unavailable)??;
        let broker = Arc::new(Self {
            allowed_app_ids,
            sender,
            state,
            heartbeat_stale_after: HEARTBEAT_STALE_AFTER,
        });
        if !broker.startup_probe(STARTUP_PROBE_TIMEOUT) {
            return Err(DesktopExecutionError::Unavailable);
        }
        Ok(broker)
    }

    pub fn is_healthy(&self) -> bool {
        if !self.state.healthy.load(Ordering::Acquire) {
            return false;
        }
        if self.state.heartbeat_age() > self.heartbeat_stale_after {
            self.mark_unhealthy();
            return false;
        }
        true
    }

    fn startup_probe(&self, timeout: Duration) -> bool {
        if !self.is_healthy() {
            return false;
        }
        let deadline = Instant::now() + timeout;
        let authority = RequestAuthority {
            deadline,
            generation: self.state.generation.load(Ordering::Acquire),
        };
        let (response, receiver) = mpsc::sync_channel(1);
        if self
            .send_request(WorkerRequest::Probe {
                authority,
                response,
            })
            .is_err()
        {
            return false;
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(())) => true,
            Ok(Err(_)) | Err(_) => {
                self.mark_unhealthy();
                false
            }
        }
    }

    fn send_request(&self, request: WorkerRequest) -> Result<(), DesktopExecutionError> {
        match self.sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => Err(DesktopExecutionError::Timeout),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.mark_unhealthy();
                Err(DesktopExecutionError::Unavailable)
            }
        }
    }

    fn mark_unhealthy(&self) {
        self.state.mark_unhealthy();
    }

    fn execute_with_timeout(
        &self,
        envelope: ActionEnvelope,
        timeout: Duration,
    ) -> Result<DesktopActionOutput, DesktopExecutionError> {
        let mutation = envelope.action.is_mutation();
        let deadline = Instant::now() + timeout;
        if !self.is_healthy() {
            return Err(DesktopExecutionError::Unavailable);
        }
        let authority = RequestAuthority {
            deadline,
            generation: self.state.generation.load(Ordering::Acquire),
        };
        let (response, receiver) = mpsc::sync_channel(1);
        self.send_request(WorkerRequest::Execute {
            envelope,
            authority,
            response,
        })?;
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(result) => result,
            Err(_) => {
                // A hung provider cannot be cancelled safely in-process. This
                // broker is permanently failed closed instead of accumulating
                // more calls on a compromised COM apartment.
                self.mark_unhealthy();
                Err(if mutation {
                    DesktopExecutionError::OutcomeUncertain
                } else {
                    DesktopExecutionError::Timeout
                })
            }
        }
    }
}

impl DesktopExecutor for UiaBroker {
    fn allowed_app_ids(&self) -> Vec<String> {
        self.allowed_app_ids.clone()
    }

    fn is_healthy(&self) -> bool {
        UiaBroker::is_healthy(self)
    }

    fn execute(
        &self,
        envelope: ActionEnvelope,
    ) -> Result<DesktopActionOutput, DesktopExecutionError> {
        let timeout = match &envelope.action {
            DesktopAction::Discover { .. } => DISCOVER_TIMEOUT,
            DesktopAction::Inspect { .. } => INSPECT_TIMEOUT,
            DesktopAction::Click { .. } | DesktopAction::Type { .. } => WRITE_TIMEOUT,
        };
        self.execute_with_timeout(envelope, timeout)
    }
}

#[cfg(windows)]
fn worker_main(
    allowed_apps: Vec<AllowedApplication>,
    receiver: mpsc::Receiver<WorkerRequest>,
    ready: mpsc::SyncSender<Result<(), DesktopExecutionError>>,
    state: WorkerState,
) {
    let _lifecycle = WorkerLifecycle {
        state: state.clone(),
    };
    let mut automation = match windows_worker::WindowsAutomation::new(allowed_apps) {
        Ok(value) => {
            state.record_heartbeat();
            let _ = ready.send(Ok(()));
            value
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    loop {
        let request = match receiver.recv_timeout(HEARTBEAT_INTERVAL) {
            Ok(request) => request,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                state.record_heartbeat();
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        state.record_heartbeat();
        match request {
            WorkerRequest::Execute {
                envelope,
                authority,
                response,
            } => {
                let result = run_authorized(&state, authority, |guard| {
                    automation.execute(envelope, guard)
                });
                let _ = response.send(result);
            }
            WorkerRequest::Probe {
                authority,
                response,
            } => {
                let result = run_authorized(&state, authority, |guard| automation.probe(guard));
                let _ = response.send(result);
            }
        }
        state.record_heartbeat();
    }
}

#[cfg(not(windows))]
fn worker_main(
    _allowed_apps: Vec<AllowedApplication>,
    _receiver: mpsc::Receiver<WorkerRequest>,
    ready: mpsc::SyncSender<Result<(), DesktopExecutionError>>,
    state: WorkerState,
) {
    state.mark_unhealthy();
    let _ = ready.send(Err(DesktopExecutionError::Unavailable));
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WindowListContent {
    schema_version: u8,
    kind: &'static str,
    app_id: String,
    windows: Vec<WindowSummary>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WindowSummary {
    window_id: String,
    title: String,
    tree_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TreeContent {
    schema_version: u8,
    kind: &'static str,
    app_id: String,
    window_id: String,
    tree_revision: String,
    nodes: Vec<ControlNode>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ControlNode {
    node_id: String,
    role: String,
    name: String,
    enabled: bool,
    focusable: bool,
    focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds: Option<NodeBounds>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NodeBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MutationContent {
    schema_version: u8,
    kind: &'static str,
    action: &'static str,
    app_id: String,
    window_id: String,
    previous_tree_revision: String,
    current_tree_revision: String,
}

fn bounded_text(value: String) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(crate::contracts::MAX_TEXT_CHARS)
        .collect()
}

#[cfg(windows)]
mod windows_worker {
    use super::*;
    use crate::contracts::{MAX_TREE_DEPTH, MAX_TREE_NODES};
    use hmac::{Hmac, Mac};
    use rand::rngs::OsRng;
    use rand::RngCore;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use windows::core::{BOOL, BSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation8, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        IUIAutomationTogglePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
        UIA_InvokePatternId, UIA_TogglePatternId, UIA_ValuePatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
        IsWindowVisible,
    };

    const MAX_WINDOWS_PER_APP: usize = 32;
    const MAX_PROCESS_PATH_U16: usize = 32_768;

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, DesktopExecutionError> {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED)
                    .ok()
                    .map_err(|_| DesktopExecutionError::Unavailable)?;
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    #[derive(Clone)]
    struct WindowTarget {
        app_id: String,
        executable_path: PathBuf,
        window_id: String,
        discovery_revision: String,
        pid: u32,
        hwnd: isize,
    }

    struct BuiltTree {
        revision: String,
        nodes: Vec<ControlNode>,
        paths: HashMap<String, Vec<usize>>,
        elements: HashMap<String, IUIAutomationElement>,
    }

    pub(super) struct WindowsAutomation {
        automation: IUIAutomation,
        walker: IUIAutomationTreeWalker,
        allowed: HashMap<String, AllowedApplication>,
        windows: HashMap<String, WindowTarget>,
        trees: HashMap<String, BuiltTree>,
        node_salt: [u8; 32],
        // Keep the apartment guard last so every cached COM interface is
        // released before CoUninitialize runs.
        _com: ComApartment,
    }

    impl WindowsAutomation {
        pub(super) fn new(
            allowed_apps: Vec<AllowedApplication>,
        ) -> Result<Self, DesktopExecutionError> {
            let com = ComApartment::initialize()?;
            let automation: IUIAutomation = unsafe {
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| DesktopExecutionError::Unavailable)?
            };
            let walker = unsafe { automation.ControlViewWalker() }
                .map_err(|_| DesktopExecutionError::Unavailable)?;
            let mut node_salt = [0_u8; 32];
            OsRng.fill_bytes(&mut node_salt);
            Ok(Self {
                automation,
                walker,
                allowed: allowed_apps
                    .into_iter()
                    .map(|app| (app.app_id.clone(), app))
                    .collect(),
                windows: HashMap::new(),
                trees: HashMap::new(),
                node_salt,
                _com: com,
            })
        }

        pub(super) fn probe(&self, guard: &ExecutionGuard) -> Result<(), DesktopExecutionError> {
            guard.check()?;
            let root = unsafe { self.automation.GetRootElement() }
                .map_err(|_| DesktopExecutionError::Unavailable)?;
            guard.check()?;
            unsafe { root.CurrentControlType() }.map_err(|_| DesktopExecutionError::Unavailable)?;
            guard.check()?;
            let _ = unsafe { self.walker.GetFirstChildElement(&root) }
                .map_err(|_| DesktopExecutionError::Unavailable)?;
            guard.check()?;
            Ok(())
        }

        pub(super) fn execute(
            &mut self,
            envelope: ActionEnvelope,
            guard: &ExecutionGuard,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            guard.check()?;
            let mutation = envelope.action.is_mutation();
            let payload = envelope.payload_text;
            let result = match envelope.action {
                DesktopAction::Discover { app_id } => self.discover(&app_id),
                DesktopAction::Inspect {
                    app_id,
                    window_id,
                    tree_revision,
                } => self.inspect(&app_id, &window_id, &tree_revision),
                DesktopAction::Click {
                    app_id,
                    window_id,
                    tree_revision,
                    node_id,
                } => self.click(&app_id, &window_id, &tree_revision, &node_id, guard),
                DesktopAction::Type {
                    app_id,
                    window_id,
                    tree_revision,
                    node_id,
                    ..
                } => self.type_value(
                    &app_id,
                    &window_id,
                    &tree_revision,
                    &node_id,
                    payload
                        .as_deref()
                        .ok_or(DesktopExecutionError::FailedClosed)?,
                    guard,
                ),
            };
            match result {
                Ok(output) => {
                    guard.check().map_err(|_| {
                        if mutation {
                            DesktopExecutionError::OutcomeUncertain
                        } else {
                            DesktopExecutionError::Timeout
                        }
                    })?;
                    Ok(output)
                }
                Err(error) => Err(error),
            }
        }

        fn discover(&mut self, app_id: &str) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let allowed = self
                .allowed
                .get(app_id)
                .cloned()
                .ok_or(DesktopExecutionError::AppNotAllowed)?;
            let mut summaries = Vec::new();
            let mut authoritative = HashMap::new();
            for hwnd in visible_windows()? {
                if summaries.len() >= MAX_WINDOWS_PER_APP {
                    break;
                }
                let Some((pid, path)) = window_process_identity(hwnd) else {
                    continue;
                };
                if !paths_equal(&path, &allowed.executable_path) {
                    continue;
                }
                let title = bounded_text(window_title(hwnd));
                let normalized_path = path.to_string_lossy().to_lowercase();
                let pid_bytes = pid.to_le_bytes();
                let hwnd_bytes = (hwnd.0 as isize).to_le_bytes();
                let window_id = hash_values(&[
                    app_id.as_bytes(),
                    normalized_path.as_bytes(),
                    &pid_bytes,
                    &hwnd_bytes,
                ]);
                let discovery_revision = self.discovery_revision(hwnd, pid, &window_id)?;
                let target = WindowTarget {
                    app_id: app_id.into(),
                    executable_path: path,
                    window_id: window_id.clone(),
                    discovery_revision: discovery_revision.clone(),
                    pid,
                    hwnd: hwnd.0 as isize,
                };
                summaries.push(WindowSummary {
                    window_id: window_id.clone(),
                    title,
                    tree_revision: discovery_revision,
                });
                authoritative.insert(window_id, target);
            }
            let replaced_window_ids = self
                .windows
                .iter()
                .filter(|(_, target)| target.app_id == app_id)
                .map(|(window_id, _)| window_id.clone())
                .collect::<Vec<_>>();
            self.windows.retain(|_, target| target.app_id != app_id);
            for window_id in replaced_window_ids {
                self.trees.remove(&window_id);
            }
            self.windows.extend(authoritative);
            summaries.sort_by(|left, right| left.window_id.cmp(&right.window_id));
            let content = WindowListContent {
                schema_version: 1,
                kind: "desktop.windows",
                app_id: app_id.into(),
                windows: summaries,
            };
            Ok(DesktopActionOutput {
                summary: "Recorded bounded windows for the allowlisted application.".into(),
                content: Some(
                    serde_json::to_string(&content)
                        .map_err(|_| DesktopExecutionError::FailedClosed)?,
                ),
            })
        }

        fn inspect(
            &mut self,
            app_id: &str,
            window_id: &str,
            discovery_revision: &str,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let target = self.authoritative_target(app_id, window_id)?;
            let current_discovery =
                self.discovery_revision(target.hwnd(), target.pid, &target.window_id)?;
            if target.discovery_revision != discovery_revision
                || current_discovery != discovery_revision
            {
                return Err(DesktopExecutionError::TreeStale);
            }
            let tree = self.build_tree(&target)?;
            let content = TreeContent {
                schema_version: 1,
                kind: "desktop.tree",
                app_id: app_id.into(),
                window_id: window_id.into(),
                tree_revision: tree.revision.clone(),
                nodes: tree.nodes.clone(),
            };
            self.trees.insert(window_id.into(), tree);
            Ok(DesktopActionOutput {
                summary: "Recorded a bounded, redacted Windows UI Automation tree.".into(),
                content: Some(
                    serde_json::to_string(&content)
                        .map_err(|_| DesktopExecutionError::FailedClosed)?,
                ),
            })
        }

        fn click(
            &mut self,
            app_id: &str,
            window_id: &str,
            tree_revision: &str,
            node_id: &str,
            guard: &ExecutionGuard,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let (target, element, path) =
                self.resolve_authoritative_node(app_id, window_id, tree_revision, node_id)?;
            let toggle_pattern: Option<IUIAutomationTogglePattern> =
                unsafe { element.GetCurrentPatternAs(UIA_TogglePatternId) }.ok();
            let invoke_pattern: Option<IUIAutomationInvokePattern> = if toggle_pattern.is_none() {
                unsafe { element.GetCurrentPatternAs(UIA_InvokePatternId) }.ok()
            } else {
                None
            };
            if invoke_pattern.is_none() && toggle_pattern.is_none() {
                return Err(DesktopExecutionError::UnsupportedPattern);
            }
            if !unsafe { element.CurrentIsEnabled() }
                .map(|value| value.as_bool())
                .unwrap_or(false)
            {
                return Err(DesktopExecutionError::NodeStale);
            }
            self.revalidate_node_identity(&element, &path, node_id)?;
            self.revalidate_target_identity(&target)?;
            guard.check()?;
            let independently_verified = if let Some(pattern) = toggle_pattern {
                let before = unsafe { pattern.CurrentToggleState() }
                    .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
                guard.check()?;
                unsafe { pattern.Toggle() }.map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
                let deadline = guard.observation_deadline();
                loop {
                    let after = unsafe { pattern.CurrentToggleState() }
                        .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
                    if after != before {
                        break;
                    }
                    if Instant::now() >= deadline || !guard.state.is_current(guard.authority) {
                        return Err(DesktopExecutionError::OutcomeUncertain);
                    }
                    std::thread::sleep(MUTATION_OBSERVATION_INTERVAL);
                }
                true
            } else if let Some(pattern) = invoke_pattern {
                guard.check()?;
                unsafe { pattern.Invoke() }.map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
                false
            } else {
                return Err(DesktopExecutionError::UnsupportedPattern);
            };
            self.verify_mutation_after_side_effect(
                target,
                tree_revision,
                "desktop.click",
                independently_verified,
                guard,
            )
        }

        fn type_value(
            &mut self,
            app_id: &str,
            window_id: &str,
            tree_revision: &str,
            node_id: &str,
            payload: &str,
            guard: &ExecutionGuard,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let (target, element, path) =
                self.resolve_authoritative_node(app_id, window_id, tree_revision, node_id)?;
            {
                let pattern: IUIAutomationValuePattern =
                    unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }
                        .map_err(|_| DesktopExecutionError::UnsupportedPattern)?;
                if unsafe { pattern.CurrentIsReadOnly() }
                    .map(|value| value.as_bool())
                    .unwrap_or(true)
                {
                    return Err(DesktopExecutionError::ReadOnly);
                }
            }
            self.revalidate_node_identity(&element, &path, node_id)?;
            self.revalidate_target_identity(&target)?;
            guard.check()?;
            unsafe { element.SetFocus() }.map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            let element = self
                .reacquire_node_at_path(&target, &path, node_id)
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            if !unsafe { element.CurrentIsEnabled() }
                .map(|value| value.as_bool())
                .unwrap_or(false)
            {
                return Err(DesktopExecutionError::OutcomeUncertain);
            }
            self.revalidate_node_identity(&element, &path, node_id)
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            self.revalidate_target_identity(&target)
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            let pattern: IUIAutomationValuePattern =
                unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }
                    .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            if unsafe { pattern.CurrentIsReadOnly() }
                .map(|value| value.as_bool())
                .unwrap_or(true)
            {
                return Err(DesktopExecutionError::OutcomeUncertain);
            }
            guard
                .check()
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            let value = BSTR::from(payload);
            unsafe { pattern.SetValue(&value) }
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            let deadline = guard.observation_deadline();
            loop {
                let actual = unsafe { pattern.CurrentValue() }
                    .map(|value| value.to_string())
                    .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
                if self.value_matches(payload, &actual) {
                    break;
                }
                if Instant::now() >= deadline || !guard.state.is_current(guard.authority) {
                    return Err(DesktopExecutionError::OutcomeUncertain);
                }
                std::thread::sleep(MUTATION_OBSERVATION_INTERVAL);
            }
            self.verify_mutation_after_side_effect(
                target,
                tree_revision,
                "desktop.type",
                true,
                guard,
            )
        }

        fn value_matches(&self, expected: &str, actual: &str) -> bool {
            let mut expected_mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.node_salt)
                .expect("HMAC accepts a 32-byte key");
            expected_mac.update(expected.as_bytes());
            let expected_tag = expected_mac.finalize().into_bytes();
            let mut actual_mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.node_salt)
                .expect("HMAC accepts a 32-byte key");
            actual_mac.update(actual.as_bytes());
            actual_mac.verify_slice(&expected_tag).is_ok()
        }

        fn verify_mutation_after_side_effect(
            &mut self,
            target: WindowTarget,
            previous_revision: &str,
            action: &'static str,
            independently_verified: bool,
            guard: &ExecutionGuard,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let window_id = target.window_id.clone();
            match self.verify_after_write(
                target,
                previous_revision,
                action,
                independently_verified,
                guard,
            ) {
                Ok(output) => Ok(output),
                Err(_) => {
                    self.trees.remove(&window_id);
                    Err(DesktopExecutionError::OutcomeUncertain)
                }
            }
        }

        fn verify_after_write(
            &mut self,
            target: WindowTarget,
            previous_revision: &str,
            action: &'static str,
            independently_verified: bool,
            guard: &ExecutionGuard,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            guard
                .check()
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            let current = self.build_tree(&target)?;
            guard
                .check()
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            if !independently_verified && current.revision == previous_revision {
                return Err(DesktopExecutionError::OutcomeUncertain);
            }
            let content = MutationContent {
                schema_version: 1,
                kind: "desktop.action",
                action,
                app_id: target.app_id.clone(),
                window_id: target.window_id.clone(),
                previous_tree_revision: previous_revision.into(),
                current_tree_revision: current.revision.clone(),
            };
            self.trees.insert(target.window_id.clone(), current);
            Ok(DesktopActionOutput {
                summary:
                    "Executed one approved UI Automation operation and re-observed the target tree."
                        .into(),
                content: Some(
                    serde_json::to_string(&content)
                        .map_err(|_| DesktopExecutionError::FailedClosed)?,
                ),
            })
        }

        fn authoritative_target(
            &mut self,
            app_id: &str,
            window_id: &str,
        ) -> Result<WindowTarget, DesktopExecutionError> {
            if !self.allowed.contains_key(app_id) {
                return Err(DesktopExecutionError::AppNotAllowed);
            }
            let target = self
                .windows
                .get(window_id)
                .filter(|target| target.app_id == app_id)
                .cloned()
                .ok_or(DesktopExecutionError::WindowStale)?;
            self.revalidate_target_identity(&target)?;
            Ok(target)
        }

        fn target_identity_matches(&self, target: &WindowTarget) -> bool {
            self.allowed
                .get(&target.app_id)
                .map(|allowed| paths_equal(&allowed.executable_path, &target.executable_path))
                .unwrap_or(false)
                && unsafe { IsWindow(Some(target.hwnd())) }.as_bool()
                && window_pid(target.hwnd()) == Some(target.pid)
                && process_path(target.pid)
                    .map(|path| paths_equal(&path, &target.executable_path))
                    .unwrap_or(false)
        }

        fn revalidate_target_identity(
            &mut self,
            target: &WindowTarget,
        ) -> Result<(), DesktopExecutionError> {
            if self.target_identity_matches(target) {
                return Ok(());
            }
            self.windows.remove(&target.window_id);
            self.trees.remove(&target.window_id);
            Err(DesktopExecutionError::WindowStale)
        }

        fn resolve_authoritative_node(
            &mut self,
            app_id: &str,
            window_id: &str,
            tree_revision: &str,
            node_id: &str,
        ) -> Result<(WindowTarget, IUIAutomationElement, Vec<usize>), DesktopExecutionError>
        {
            let target = self.authoritative_target(app_id, window_id)?;
            let expected_path = self
                .trees
                .get(window_id)
                .filter(|tree| tree.revision == tree_revision)
                .and_then(|tree| tree.paths.get(node_id))
                .cloned()
                .ok_or(DesktopExecutionError::TreeStale)?;
            let current = self.build_tree(&target)?;
            if current.revision != tree_revision {
                return Err(DesktopExecutionError::TreeStale);
            }
            if current.paths.get(node_id) != Some(&expected_path) {
                return Err(DesktopExecutionError::NodeStale);
            }
            let element = current
                .elements
                .get(node_id)
                .cloned()
                .ok_or(DesktopExecutionError::NodeStale)?;
            Ok((target, element, expected_path))
        }

        fn reacquire_node_at_path(
            &mut self,
            target: &WindowTarget,
            expected_path: &[usize],
            expected_node_id: &str,
        ) -> Result<IUIAutomationElement, DesktopExecutionError> {
            self.revalidate_target_identity(target)?;
            let current = self.build_tree(target)?;
            if current.paths.get(expected_node_id).map(Vec::as_slice) != Some(expected_path) {
                return Err(DesktopExecutionError::NodeStale);
            }
            let element = current
                .elements
                .get(expected_node_id)
                .cloned()
                .ok_or(DesktopExecutionError::NodeStale)?;
            self.revalidate_node_identity(&element, expected_path, expected_node_id)?;
            self.revalidate_target_identity(target)?;
            Ok(element)
        }

        fn revalidate_node_identity(
            &self,
            element: &IUIAutomationElement,
            path: &[usize],
            expected_node_id: &str,
        ) -> Result<(), DesktopExecutionError> {
            if self.control_node(element, path)?.node_id == expected_node_id {
                Ok(())
            } else {
                Err(DesktopExecutionError::NodeStale)
            }
        }

        fn discovery_revision(
            &self,
            hwnd: HWND,
            pid: u32,
            window_id: &str,
        ) -> Result<String, DesktopExecutionError> {
            let root = unsafe { self.automation.ElementFromHandle(hwnd) }
                .map_err(|_| DesktopExecutionError::WindowStale)?;
            let role = unsafe { root.CurrentLocalizedControlType() }
                .map(|value| value.to_string())
                .map_err(|_| DesktopExecutionError::WindowStale)?;
            let name = unsafe { root.CurrentName() }
                .map(|value| value.to_string())
                .map_err(|_| DesktopExecutionError::WindowStale)?;
            let bounds = unsafe { root.CurrentBoundingRectangle() }
                .map_err(|_| DesktopExecutionError::WindowStale)?;
            let pid_bytes = pid.to_le_bytes();
            let bounds_debug = format!("{bounds:?}");
            Ok(hash_values(&[
                window_id.as_bytes(),
                &pid_bytes,
                role.as_bytes(),
                name.as_bytes(),
                bounds_debug.as_bytes(),
            ]))
        }

        fn build_tree(
            &mut self,
            target: &WindowTarget,
        ) -> Result<BuiltTree, DesktopExecutionError> {
            self.revalidate_target_identity(target)?;
            let root = unsafe { self.automation.ElementFromHandle(target.hwnd()) }
                .map_err(|_| DesktopExecutionError::WindowStale)?;
            let mut nodes = Vec::new();
            let mut paths = HashMap::new();
            let mut elements = HashMap::new();
            self.visit(
                &root,
                &mut Vec::new(),
                0,
                &mut nodes,
                &mut paths,
                &mut elements,
            )?;
            self.revalidate_target_identity(target)?;
            let serialized_nodes =
                serde_json::to_vec(&nodes).map_err(|_| DesktopExecutionError::FailedClosed)?;
            let revision = hash_values(&[target.window_id.as_bytes(), &serialized_nodes]);
            Ok(BuiltTree {
                revision,
                nodes,
                paths,
                elements,
            })
        }

        fn visit(
            &self,
            element: &IUIAutomationElement,
            path: &mut Vec<usize>,
            depth: usize,
            nodes: &mut Vec<ControlNode>,
            paths: &mut HashMap<String, Vec<usize>>,
            elements: &mut HashMap<String, IUIAutomationElement>,
        ) -> Result<(), DesktopExecutionError> {
            if depth > MAX_TREE_DEPTH || nodes.len() >= MAX_TREE_NODES {
                return Ok(());
            }
            let node = self.control_node(element, path)?;
            let node_id = node.node_id.clone();
            nodes.push(node);
            paths.insert(node_id.clone(), path.clone());
            elements.insert(node_id, element.clone());

            if depth == MAX_TREE_DEPTH || nodes.len() >= MAX_TREE_NODES {
                return Ok(());
            }
            let mut child = unsafe { self.walker.GetFirstChildElement(element) }.ok();
            let mut child_index = 0_usize;
            while let Some(current) = child {
                if nodes.len() >= MAX_TREE_NODES {
                    break;
                }
                path.push(child_index);
                self.visit(&current, path, depth + 1, nodes, paths, elements)?;
                path.pop();
                child = unsafe { self.walker.GetNextSiblingElement(&current) }.ok();
                child_index += 1;
            }
            Ok(())
        }

        fn control_node(
            &self,
            element: &IUIAutomationElement,
            path: &[usize],
        ) -> Result<ControlNode, DesktopExecutionError> {
            let password = unsafe { element.CurrentIsPassword() }
                .map(|value| value.as_bool())
                .map_err(|_| DesktopExecutionError::NodeStale)?;
            let role = bounded_text(
                unsafe { element.CurrentLocalizedControlType() }
                    .map(|value| value.to_string())
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
            );
            let raw_name = bounded_text(
                unsafe { element.CurrentName() }
                    .map(|value| value.to_string())
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
            );
            let name = if password {
                "[redacted]".into()
            } else {
                raw_name
            };
            let automation_id = bounded_text(
                unsafe { element.CurrentAutomationId() }
                    .map(|value| value.to_string())
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
            );
            let class_name = bounded_text(
                unsafe { element.CurrentClassName() }
                    .map(|value| value.to_string())
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
            );
            let control_type = unsafe { element.CurrentControlType() }
                .map(|value| value.0)
                .map_err(|_| DesktopExecutionError::NodeStale)?;
            let bounds = rect_to_bounds(
                unsafe { element.CurrentBoundingRectangle() }
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
            );
            let node_id = self.node_id(
                path,
                &role,
                &name,
                &automation_id,
                &class_name,
                control_type,
                bounds,
            );
            Ok(ControlNode {
                node_id,
                role,
                name,
                enabled: unsafe { element.CurrentIsEnabled() }
                    .map(|value| value.as_bool())
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
                focusable: unsafe { element.CurrentIsKeyboardFocusable() }
                    .map(|value| value.as_bool())
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
                focused: unsafe { element.CurrentHasKeyboardFocus() }
                    .map(|value| value.as_bool())
                    .map_err(|_| DesktopExecutionError::NodeStale)?,
                bounds,
            })
        }

        #[allow(clippy::too_many_arguments)]
        fn node_id(
            &self,
            path: &[usize],
            role: &str,
            name: &str,
            automation_id: &str,
            class_name: &str,
            control_type: i32,
            bounds: Option<NodeBounds>,
        ) -> String {
            let path_debug = format!("{path:?}");
            let control_type_bytes = control_type.to_le_bytes();
            let bounds_debug = format!("{bounds:?}");
            hash_values(&[
                &self.node_salt,
                path_debug.as_bytes(),
                role.as_bytes(),
                name.as_bytes(),
                automation_id.as_bytes(),
                class_name.as_bytes(),
                &control_type_bytes,
                bounds_debug.as_bytes(),
            ])
        }
    }

    impl WindowTarget {
        fn hwnd(&self) -> HWND {
            HWND(self.hwnd as *mut c_void)
        }
    }

    fn visible_windows() -> Result<Vec<HWND>, DesktopExecutionError> {
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let windows = &mut *(lparam.0 as *mut Vec<HWND>);
            if IsWindowVisible(hwnd).as_bool() {
                windows.push(hwnd);
            }
            BOOL(1)
        }
        let mut windows = Vec::<HWND>::new();
        unsafe {
            EnumWindows(
                Some(collect),
                LPARAM((&mut windows as *mut Vec<HWND>) as isize),
            )
        }
        .map_err(|_| DesktopExecutionError::FailedClosed)?;
        Ok(windows)
    }

    fn window_pid(hwnd: HWND) -> Option<u32> {
        let mut pid = 0_u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        (pid > 0).then_some(pid)
    }

    fn window_process_identity(hwnd: HWND) -> Option<(u32, PathBuf)> {
        let pid = window_pid(hwnd)?;
        let path = process_path(pid).ok()?;
        Some((pid, path))
    }

    fn process_path(pid: u32) -> Result<PathBuf, DesktopExecutionError> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .map_err(|_| DesktopExecutionError::WindowStale)?;
            let mut buffer = vec![0_u16; MAX_PROCESS_PATH_U16];
            let mut size = buffer.len() as u32;
            let result = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(process);
            result.map_err(|_| DesktopExecutionError::WindowStale)?;
            let path = PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize]));
            std::fs::canonicalize(path).map_err(|_| DesktopExecutionError::WindowStale)
        }
    }

    fn paths_equal(left: &Path, right: &Path) -> bool {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    }

    fn window_title(hwnd: HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) }.clamp(0, 511) as usize;
        let mut buffer = vec![0_u16; length + 1];
        let written = unsafe { GetWindowTextW(hwnd, &mut buffer) }.max(0) as usize;
        String::from_utf16_lossy(&buffer[..written.min(buffer.len())])
    }

    fn rect_to_bounds(rect: RECT) -> Option<NodeBounds> {
        let width = rect.right.checked_sub(rect.left)?;
        let height = rect.bottom.checked_sub(rect.top)?;
        (width >= 0 && height >= 0).then_some(NodeBounds {
            x: rect.left,
            y: rect.top,
            width,
            height,
        })
    }

    fn hash_values(values: &[&[u8]]) -> String {
        let mut hasher = Sha256::new();
        for value in values {
            hasher.update((value.len() as u64).to_le_bytes());
            hasher.update(value);
        }
        hex::encode(hasher.finalize())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn invalid_window_is_not_a_process_identity_candidate() {
            assert!(window_process_identity(HWND::default()).is_none());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_and_tree_content_match_the_cockpit_contract() {
        let windows = WindowListContent {
            schema_version: 1,
            kind: "desktop.windows",
            app_id: "notepad".into(),
            windows: vec![WindowSummary {
                window_id: "window".into(),
                title: "Untitled".into(),
                tree_revision: "a".repeat(64),
            }],
        };
        let value = serde_json::to_value(windows).unwrap();
        assert_eq!(value["kind"], "desktop.windows");
        assert_eq!(value["windows"][0]["treeRevision"], "a".repeat(64));

        let tree = TreeContent {
            schema_version: 1,
            kind: "desktop.tree",
            app_id: "notepad".into(),
            window_id: "window".into(),
            tree_revision: "b".repeat(64),
            nodes: vec![ControlNode {
                node_id: "c".repeat(64),
                role: "edit".into(),
                name: "[redacted]".into(),
                enabled: true,
                focusable: true,
                focused: false,
                bounds: None,
            }],
        };
        let value = serde_json::to_value(tree).unwrap();
        assert_eq!(value["kind"], "desktop.tree");
        assert!(value["nodes"][0].get("bounds").is_none());
        assert_eq!(value["nodes"][0]["name"], "[redacted]");
    }

    #[test]
    fn bounded_text_removes_control_characters_and_limits_length() {
        let value = format!("a\0b{}", "c".repeat(crate::contracts::MAX_TEXT_CHARS));
        let bounded = bounded_text(value);
        assert!(!bounded.contains('\0'));
        assert_eq!(bounded.chars().count(), crate::contracts::MAX_TEXT_CHARS);
    }

    #[test]
    fn public_errors_do_not_include_provider_or_typed_content() {
        for error in [
            DesktopExecutionError::WindowStale,
            DesktopExecutionError::TreeStale,
            DesktopExecutionError::Timeout,
            DesktopExecutionError::FailedClosed,
        ] {
            assert!(!error.public_summary().contains("secret"));
            assert!(!error.code().is_empty());
        }
    }

    fn test_broker(heartbeat_stale_after: Duration) -> (UiaBroker, mpsc::Receiver<WorkerRequest>) {
        let (sender, receiver) = mpsc::sync_channel(REQUEST_QUEUE_CAPACITY);
        let state = WorkerState::new();
        state.record_heartbeat();
        (
            UiaBroker {
                allowed_app_ids: Vec::new(),
                sender,
                state,
                heartbeat_stale_after,
            },
            receiver,
        )
    }

    fn test_mutation(payload: &str) -> ActionEnvelope {
        ActionEnvelope {
            schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
            action: DesktopAction::Type {
                app_id: "fixture".into(),
                window_id: "window".into(),
                tree_revision: "revision".into(),
                node_id: "node".into(),
                payload_hash: "hash".into(),
            },
            payload_text: Some(payload.into()),
        }
    }

    #[test]
    fn health_reads_do_not_enqueue_com_probes() {
        let (broker, receiver) = test_broker(Duration::from_secs(1));

        for _ in 0..128 {
            assert!(broker.is_healthy());
        }
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn stale_heartbeat_failure_is_sticky() {
        let (broker, _receiver) = test_broker(Duration::ZERO);
        while broker.state.heartbeat_age().is_zero() {
            std::hint::spin_loop();
        }

        assert!(!broker.is_healthy());
        broker.state.record_heartbeat();
        assert!(!broker.is_healthy());
        assert!(!broker.state.healthy.load(Ordering::Acquire));
    }

    #[test]
    fn failed_startup_probe_is_sticky() {
        let (broker, receiver) = test_broker(Duration::from_secs(1));
        let worker = std::thread::spawn(move || {
            let WorkerRequest::Probe { response, .. } = receiver.recv().unwrap() else {
                panic!("expected a startup probe");
            };
            response
                .send(Err(DesktopExecutionError::Unavailable))
                .unwrap();
        });

        assert!(!broker.startup_probe(Duration::from_secs(1)));
        worker.join().unwrap();
        assert!(!broker.is_healthy());
    }

    #[test]
    fn timed_out_startup_probe_fails_closed() {
        let (broker, receiver) = test_broker(Duration::from_secs(1));
        let worker = std::thread::spawn(move || {
            let WorkerRequest::Probe { response, .. } = receiver.recv().unwrap() else {
                panic!("expected a startup probe");
            };
            std::thread::sleep(Duration::from_millis(30));
            let _ = response.send(Ok(()));
        });

        assert!(!broker.startup_probe(Duration::from_millis(1)));
        assert!(!broker.is_healthy());
        worker.join().unwrap();
    }

    #[test]
    fn expired_queued_mutation_is_rejected_before_its_side_effect() {
        let (broker, receiver) = test_broker(Duration::from_secs(1));
        let authority = RequestAuthority {
            deadline: Instant::now(),
            generation: broker.state.generation.load(Ordering::Acquire),
        };
        let (response, result_receiver) = mpsc::sync_channel(1);
        broker
            .send_request(WorkerRequest::Execute {
                envelope: ActionEnvelope {
                    schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                    action: DesktopAction::Type {
                        app_id: "fixture".into(),
                        window_id: "window".into(),
                        tree_revision: "revision".into(),
                        node_id: "node".into(),
                        payload_hash: "hash".into(),
                    },
                    payload_text: Some("must not be typed".into()),
                },
                authority,
                response,
            })
            .unwrap();
        let side_effects = Arc::new(AtomicU64::new(0));
        let observed = side_effects.clone();
        let worker_state = broker.state.clone();
        let worker = std::thread::spawn(move || {
            let WorkerRequest::Execute {
                authority,
                response,
                ..
            } = receiver.recv().unwrap()
            else {
                panic!("expected a queued mutation");
            };
            let result = run_authorized(&worker_state, authority, |_| {
                observed.fetch_add(1, Ordering::AcqRel);
                Ok(DesktopActionOutput {
                    summary: "unexpected".into(),
                    content: None,
                })
            });
            response.send(result).unwrap();
        });

        assert_eq!(
            result_receiver.recv().unwrap(),
            Err(DesktopExecutionError::Timeout)
        );
        worker.join().unwrap();
        assert_eq!(side_effects.load(Ordering::Acquire), 0);
    }

    #[test]
    fn queue_full_mutation_is_not_enqueued_or_executed() {
        let (broker, receiver) = test_broker(Duration::from_secs(1));
        let authority = RequestAuthority {
            deadline: Instant::now() + Duration::from_secs(1),
            generation: broker.state.generation.load(Ordering::Acquire),
        };
        let (first_response, _first_result) = mpsc::sync_channel(1);
        broker
            .send_request(WorkerRequest::Execute {
                envelope: test_mutation("first"),
                authority,
                response: first_response,
            })
            .unwrap();

        assert_eq!(
            broker.execute_with_timeout(test_mutation("must not be typed"), Duration::from_secs(1)),
            Err(DesktopExecutionError::Timeout)
        );

        let WorkerRequest::Execute { envelope, .. } = receiver.recv().unwrap() else {
            panic!("expected the first queued mutation");
        };
        assert_eq!(envelope.payload_text.as_deref(), Some("first"));
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn timed_out_mutation_invalidates_a_second_queued_mutation() {
        let (broker, receiver) = test_broker(Duration::from_secs(1));
        let broker = Arc::new(broker);
        let worker_state = broker.state.clone();
        let first_side_effects = Arc::new(AtomicU64::new(0));
        let second_side_effects = Arc::new(AtomicU64::new(0));
        let first_observed = Arc::clone(&first_side_effects);
        let second_observed = Arc::clone(&second_side_effects);
        let (first_started, first_started_receiver) = mpsc::sync_channel(1);
        let (release_first, release_first_receiver) = mpsc::sync_channel(1);

        let worker = std::thread::spawn(move || {
            let WorkerRequest::Execute {
                authority,
                response,
                ..
            } = receiver.recv().unwrap()
            else {
                panic!("expected the first mutation");
            };
            let result = run_authorized(&worker_state, authority, |_| {
                first_observed.fetch_add(1, Ordering::AcqRel);
                first_started.send(()).unwrap();
                release_first_receiver.recv().unwrap();
                Ok(DesktopActionOutput {
                    summary: "first completed after its caller timed out".into(),
                    content: None,
                })
            });
            let _ = response.send(result);

            let WorkerRequest::Execute {
                authority,
                response,
                ..
            } = receiver.recv().unwrap()
            else {
                panic!("expected the second queued mutation");
            };
            let result = run_authorized(&worker_state, authority, |_| {
                second_observed.fetch_add(1, Ordering::AcqRel);
                Ok(DesktopActionOutput {
                    summary: "second mutation unexpectedly executed".into(),
                    content: None,
                })
            });
            response.send(result).unwrap();
        });

        let first_broker = Arc::clone(&broker);
        let first = std::thread::spawn(move || {
            first_broker.execute_with_timeout(
                test_mutation("first may have executed"),
                Duration::from_millis(100),
            )
        });
        first_started_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let second_authority = RequestAuthority {
            deadline: Instant::now() + Duration::from_secs(1),
            generation: broker.state.generation.load(Ordering::Acquire),
        };
        let (second_response, second_result) = mpsc::sync_channel(1);
        broker
            .send_request(WorkerRequest::Execute {
                envelope: test_mutation("must not be typed"),
                authority: second_authority,
                response: second_response,
            })
            .unwrap();

        assert_eq!(
            first.join().unwrap(),
            Err(DesktopExecutionError::OutcomeUncertain)
        );
        assert!(!broker.is_healthy());
        release_first.send(()).unwrap();
        assert_eq!(
            second_result.recv_timeout(Duration::from_secs(1)).unwrap(),
            Err(DesktopExecutionError::Unavailable)
        );
        worker.join().unwrap();
        assert_eq!(first_side_effects.load(Ordering::Acquire), 1);
        assert_eq!(second_side_effects.load(Ordering::Acquire), 0);
    }

    #[cfg(windows)]
    mod live_windows_acceptance {
        use super::*;
        use serde_json::Value;
        use sha2::{Digest, Sha256};
        use std::ffi::c_void;
        use std::thread::JoinHandle;
        use windows::core::{w, PCWSTR};
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DispatchMessageW, GetMessageW, GetWindowTextLengthW, GetWindowTextW,
            PostThreadMessageW, SendMessageW, ShowWindow, TranslateMessage, BM_GETCHECK,
            BS_AUTOCHECKBOX, ES_AUTOHSCROLL, MSG, SW_SHOW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_QUIT,
            WS_BORDER, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_TABSTOP, WS_VISIBLE,
        };

        const APP_ID: &str = "provenance.acceptance.fixture";
        const TOGGLE_NAME: &str = "Acceptance toggle";
        const EDIT_NAME: &str = "Acceptance input";

        struct AcceptanceWindow {
            title: String,
            edit: isize,
            toggle: isize,
            thread_id: u32,
            thread: Option<JoinHandle<()>>,
        }

        impl AcceptanceWindow {
            fn start() -> Self {
                let title = format!(
                    "Provenance UIA acceptance {}",
                    uuid::Uuid::new_v4().simple()
                );
                let thread_title = title.clone();
                let (ready, receiver) = mpsc::sync_channel(1);
                let thread = std::thread::spawn(move || unsafe {
                    let title_wide = wide(&thread_title);
                    let edit_text = wide(EDIT_NAME);
                    let toggle_text = wide(TOGGLE_NAME);
                    let result = (|| -> Result<(isize, isize, u32), String> {
                        let window = CreateWindowExW(
                            WINDOW_EX_STYLE::default(),
                            w!("STATIC"),
                            PCWSTR(title_wide.as_ptr()),
                            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                            120,
                            120,
                            520,
                            240,
                            None,
                            None,
                            None,
                            None,
                        )
                        .map_err(|error| format!("fixture window creation failed: {error}"))?;
                        let edit = CreateWindowExW(
                            WINDOW_EX_STYLE::default(),
                            w!("EDIT"),
                            PCWSTR(edit_text.as_ptr()),
                            WS_CHILD
                                | WS_VISIBLE
                                | WS_TABSTOP
                                | WS_BORDER
                                | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                            32,
                            40,
                            420,
                            36,
                            Some(window),
                            None,
                            None,
                            None,
                        )
                        .map_err(|error| format!("fixture edit creation failed: {error}"))?;
                        let toggle = CreateWindowExW(
                            WINDOW_EX_STYLE::default(),
                            w!("BUTTON"),
                            PCWSTR(toggle_text.as_ptr()),
                            WS_CHILD
                                | WS_VISIBLE
                                | WS_TABSTOP
                                | WINDOW_STYLE(BS_AUTOCHECKBOX as u32),
                            32,
                            104,
                            240,
                            36,
                            Some(window),
                            None,
                            None,
                            None,
                        )
                        .map_err(|error| format!("fixture toggle creation failed: {error}"))?;
                        let _ = ShowWindow(window, SW_SHOW);
                        Ok((edit.0 as isize, toggle.0 as isize, GetCurrentThreadId()))
                    })();
                    if ready.send(result).is_err() {
                        return;
                    }
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                });
                let (edit, toggle, thread_id) = receiver
                    .recv_timeout(Duration::from_secs(5))
                    .expect("fixture window did not start")
                    .expect("fixture window could not be created");
                Self {
                    title,
                    edit,
                    toggle,
                    thread_id,
                    thread: Some(thread),
                }
            }

            fn edit_text(&self) -> String {
                unsafe {
                    let hwnd = HWND(self.edit as *mut c_void);
                    let length = GetWindowTextLengthW(hwnd).max(0) as usize;
                    let mut buffer = vec![0_u16; length + 1];
                    let written = GetWindowTextW(hwnd, &mut buffer).max(0) as usize;
                    String::from_utf16_lossy(&buffer[..written])
                }
            }

            fn toggle_checked(&self) -> bool {
                unsafe {
                    SendMessageW(HWND(self.toggle as *mut c_void), BM_GETCHECK, None, None).0 == 1
                }
            }
        }

        impl Drop for AcceptanceWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
                }
                if let Some(thread) = self.thread.take() {
                    let _ = thread.join();
                }
            }
        }

        fn wide(value: &str) -> Vec<u16> {
            value.encode_utf16().chain(std::iter::once(0)).collect()
        }

        fn content(output: DesktopActionOutput) -> Value {
            serde_json::from_str(output.content.as_deref().expect("action content missing"))
                .expect("action content was not JSON")
        }

        fn text_hash(value: &str) -> String {
            hex::encode(Sha256::digest(value.as_bytes()))
        }

        #[test]
        fn discovers_inspects_clicks_and_types_against_a_real_win32_window() {
            let fixture = AcceptanceWindow::start();
            let executable_path = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
            let broker = UiaBroker::start(vec![AllowedApplication {
                app_id: APP_ID.into(),
                executable_path,
            }])
            .expect("UI Automation broker did not start");
            assert!(broker.is_healthy(), "UI Automation liveness probe failed");

            let discovered = content(
                broker
                    .execute(ActionEnvelope {
                        schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                        action: DesktopAction::Discover {
                            app_id: APP_ID.into(),
                        },
                        payload_text: None,
                    })
                    .expect("fixture discovery failed"),
            );
            let window = discovered["windows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|window| window["title"].as_str() == Some(&fixture.title))
                .expect("fixture window was not discovered");
            let window_id = window["windowId"].as_str().unwrap().to_string();
            let discovery_revision = window["treeRevision"].as_str().unwrap().to_string();

            let inspected = content(
                broker
                    .execute(ActionEnvelope {
                        schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                        action: DesktopAction::Inspect {
                            app_id: APP_ID.into(),
                            window_id: window_id.clone(),
                            tree_revision: discovery_revision,
                        },
                        payload_text: None,
                    })
                    .expect("fixture inspection failed"),
            );
            let tree_revision = inspected["treeRevision"].as_str().unwrap().to_string();
            let nodes = inspected["nodes"].as_array().unwrap();
            let toggle_node = nodes
                .iter()
                .find(|node| node["name"].as_str() == Some(TOGGLE_NAME))
                .expect("fixture toggle was not present in the UIA tree");
            let edit_nodes = nodes
                .iter()
                .filter(|node| node["role"].as_str() == Some("edit"))
                .collect::<Vec<_>>();
            assert_eq!(
                edit_nodes.len(),
                1,
                "fixture UIA tree did not contain exactly one edit control"
            );
            let edit_node = edit_nodes[0];
            let toggle_node_id = toggle_node["nodeId"].as_str().unwrap().to_string();
            let edit_node_id = edit_node["nodeId"].as_str().unwrap().to_string();

            let clicked = content(
                broker
                    .execute(ActionEnvelope {
                        schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                        action: DesktopAction::Click {
                            app_id: APP_ID.into(),
                            window_id: window_id.clone(),
                            tree_revision,
                            node_id: toggle_node_id,
                        },
                        payload_text: None,
                    })
                    .expect("fixture click failed"),
            );
            assert!(
                fixture.toggle_checked(),
                "UIA invoke did not toggle the real control"
            );

            let payload = "typed by Provenance acceptance";
            let after_click_revision = clicked["currentTreeRevision"].as_str().unwrap().to_string();
            let typed = content(
                broker
                    .execute(ActionEnvelope {
                        schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                        action: DesktopAction::Type {
                            app_id: APP_ID.into(),
                            window_id,
                            tree_revision: after_click_revision,
                            node_id: edit_node_id,
                            payload_hash: text_hash(payload),
                        },
                        payload_text: Some(payload.into()),
                    })
                    .expect("fixture typing failed"),
            );
            assert_eq!(typed["action"], "desktop.type");
            assert_eq!(fixture.edit_text(), payload);
        }

        /// Drives a real third-party application, not a fixture this test built.
        ///
        /// Every other desktop test either creates its own Win32 window or uses a
        /// deterministic simulation, so the claim that the runtime can operate an
        /// application it did not create was never actually exercised. Notepad is
        /// used because it ships with Windows and needs no install.
        ///
        /// Opt-in via PROVENANCE_LIVE_DESKTOP=1: UI Automation cannot attach in a
        /// headless session, and a test that silently passed when it could not run
        /// would be worse than no test.
        #[test]
        fn drives_notepad_as_a_real_third_party_application() {
            if std::env::var("PROVENANCE_LIVE_DESKTOP").ok().as_deref() != Some("1") {
                eprintln!("skipped: set PROVENANCE_LIVE_DESKTOP=1 on an interactive desktop");
                return;
            }

            // On Windows 11, System32\notepad.exe is a launcher stub: the window is
            // owned by a different process under WindowsApps, so allowlisting the
            // System32 path discovers nothing at all. The allowlist must name the
            // executable that actually owns the window.
            let system_root =
                std::env::var("SystemRoot").unwrap_or_else(|_| String::from(r"C:\Windows"));
            let default_path = std::path::Path::new(&system_root)
                .join("System32")
                .join("notepad.exe");
            let executable = std::env::var("PROVENANCE_LIVE_DESKTOP_EXE")
                .map(std::path::PathBuf::from)
                .unwrap_or(default_path);
            assert!(executable.is_file(), "notepad executable not found at {executable:?}");
            let canonical = std::fs::canonicalize(&executable).expect("canonical notepad path");

            struct Launched(std::process::Child);
            impl Drop for Launched {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let _notepad = Launched(
                std::process::Command::new(&executable)
                    .spawn()
                    .expect("launch notepad"),
            );

            let broker = UiaBroker::start(vec![AllowedApplication {
                app_id: APP_ID.into(),
                executable_path: canonical,
            }])
            .expect("UI Automation broker did not start");

            let payload = "provenance-live-uia";

            // A live modern application re-renders continuously, so its tree
            // revision can go stale between any two calls. The contract is right to
            // refuse a stale revision; the consequence is that a real client must
            // retry the whole discover -> inspect -> act sequence as a unit, not
            // just the step that failed. This loop is that client.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            let mut typed_ok = false;
            let mut last_error = String::from("no attempt completed");
            while std::time::Instant::now() < deadline && !typed_ok {
                let attempt = (|| -> Result<(), String> {
                    let discovered = content(
                        broker
                            .execute(ActionEnvelope {
                                schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                                action: DesktopAction::Discover { app_id: APP_ID.into() },
                                payload_text: None,
                            })
                            .map_err(|error| format!("discover: {error:?}"))?,
                    );
                    let window = discovered["windows"]
                        .as_array()
                        .and_then(|windows| windows.first())
                        .cloned()
                        .ok_or_else(|| String::from("discover: no window yet"))?;
                    let window_id = window["windowId"].as_str().unwrap().to_string();

                    let inspected = content(
                        broker
                            .execute(ActionEnvelope {
                                schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                                action: DesktopAction::Inspect {
                                    app_id: APP_ID.into(),
                                    window_id: window_id.clone(),
                                    tree_revision: window["treeRevision"]
                                        .as_str()
                                        .unwrap()
                                        .to_string(),
                                },
                                payload_text: None,
                            })
                            .map_err(|error| format!("inspect: {error:?}"))?,
                    );
                    let nodes = inspected["nodes"]
                        .as_array()
                        .ok_or_else(|| String::from("inspect: no nodes"))?;
                    if nodes.is_empty() {
                        return Err(String::from("inspect: a real window produced an empty tree"));
                    }
                    let editable = nodes
                        .iter()
                        .find(|node| {
                            matches!(node["role"].as_str(), Some("edit") | Some("document"))
                        })
                        .ok_or_else(|| String::from("inspect: no editable node"))?;

                    let typed = content(
                        broker
                            .execute(ActionEnvelope {
                                schema_version: crate::contracts::BRIDGE_SCHEMA_VERSION,
                                action: DesktopAction::Type {
                                    app_id: APP_ID.into(),
                                    window_id,
                                    tree_revision: inspected["treeRevision"]
                                        .as_str()
                                        .unwrap()
                                        .to_string(),
                                    node_id: editable["nodeId"].as_str().unwrap().to_string(),
                                    payload_hash: text_hash(payload),
                                },
                                payload_text: Some(payload.into()),
                            })
                            .map_err(|error| format!("type: {error:?}"))?,
                    );
                    if typed["action"] != "desktop.type" {
                        return Err(String::from("type: unexpected action echo"));
                    }
                    Ok(())
                })();

                match attempt {
                    Ok(()) => typed_ok = true,
                    Err(error) => {
                        last_error = error;
                        std::thread::sleep(std::time::Duration::from_millis(400));
                    }
                }
            }
            assert!(
                typed_ok,
                "never completed a discover/inspect/type against Notepad: {last_error}"
            );

            // Deliberately not asserted: what was typed cannot be read back.
            //
            // ControlNode exposes the UIA Name property, not a control's text
            // content -- Notepad keeps its document text behind the Value/Text
            // pattern, which this broker does not serialize. An earlier version of
            // this test grepped the serialized tree for the payload and passed only
            // intermittently, because the text surfaced in a node name by accident
            // rather than by contract.
            //
            // What IS proven above is the part that was never proven before: a real
            // third-party window was discovered, inspected, and accepted a typed
            // action that required a live node, an unstale tree revision, and a
            // matching payload hash. Verifying the resulting content needs a
            // TextPattern read the contract does not yet offer.
        }
    }
}
