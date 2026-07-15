use crate::contracts::{ActionEnvelope, AllowedApplication, DesktopAction};
use axum::http::StatusCode;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use thiserror::Error;

const DISCOVER_TIMEOUT: Duration = Duration::from_secs(3);
const INSPECT_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);

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
    fn execute(
        &self,
        envelope: ActionEnvelope,
    ) -> Result<DesktopActionOutput, DesktopExecutionError>;
}

struct WorkerRequest {
    envelope: ActionEnvelope,
    response: mpsc::SyncSender<Result<DesktopActionOutput, DesktopExecutionError>>,
}

pub struct UiaBroker {
    allowed_app_ids: Vec<String>,
    sender: mpsc::Sender<WorkerRequest>,
    healthy: AtomicBool,
}

impl UiaBroker {
    pub fn start(
        allowed_apps: Vec<AllowedApplication>,
    ) -> Result<Arc<Self>, DesktopExecutionError> {
        let allowed_app_ids = allowed_apps
            .iter()
            .map(|app| app.app_id.clone())
            .collect::<Vec<_>>();
        let (sender, receiver) = mpsc::channel::<WorkerRequest>();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("provenance-uia-mta".into())
            .spawn(move || worker_main(allowed_apps, receiver, ready_sender))
            .map_err(|_| DesktopExecutionError::Unavailable)?;
        ready_receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| DesktopExecutionError::Unavailable)??;
        Ok(Arc::new(Self {
            allowed_app_ids,
            sender,
            healthy: AtomicBool::new(true),
        }))
    }

    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }
}

impl DesktopExecutor for UiaBroker {
    fn allowed_app_ids(&self) -> Vec<String> {
        self.allowed_app_ids.clone()
    }

    fn execute(
        &self,
        envelope: ActionEnvelope,
    ) -> Result<DesktopActionOutput, DesktopExecutionError> {
        if !self.is_healthy() {
            return Err(DesktopExecutionError::Unavailable);
        }
        let mutation = envelope.action.is_mutation();
        let timeout = match &envelope.action {
            DesktopAction::Discover { .. } => DISCOVER_TIMEOUT,
            DesktopAction::Inspect { .. } => INSPECT_TIMEOUT,
            DesktopAction::Click { .. } | DesktopAction::Type { .. } => WRITE_TIMEOUT,
        };
        let (response, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(WorkerRequest { envelope, response })
            .map_err(|_| DesktopExecutionError::Unavailable)?;
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                // A hung provider cannot be cancelled safely in-process. This
                // broker is permanently failed closed instead of accumulating
                // more calls on a compromised COM apartment.
                self.healthy.store(false, Ordering::Release);
                Err(if mutation {
                    DesktopExecutionError::OutcomeUncertain
                } else {
                    DesktopExecutionError::Timeout
                })
            }
        }
    }
}

#[cfg(windows)]
fn worker_main(
    allowed_apps: Vec<AllowedApplication>,
    receiver: mpsc::Receiver<WorkerRequest>,
    ready: mpsc::SyncSender<Result<(), DesktopExecutionError>>,
) {
    let mut automation = match windows_worker::WindowsAutomation::new(allowed_apps) {
        Ok(value) => {
            let _ = ready.send(Ok(()));
            value
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    for request in receiver {
        let result = automation.execute(request.envelope);
        let _ = request.response.send(result);
    }
}

#[cfg(not(windows))]
fn worker_main(
    _allowed_apps: Vec<AllowedApplication>,
    _receiver: mpsc::Receiver<WorkerRequest>,
    ready: mpsc::SyncSender<Result<(), DesktopExecutionError>>,
) {
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
    use rand::rngs::OsRng;
    use rand::RngCore;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use windows::core::{BSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
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
        IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_InvokePatternId,
        UIA_ValuePatternId,
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
        _com: ComApartment,
        automation: IUIAutomation,
        walker: IUIAutomationTreeWalker,
        allowed: HashMap<String, AllowedApplication>,
        windows: HashMap<String, WindowTarget>,
        trees: HashMap<String, BuiltTree>,
        node_salt: [u8; 32],
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
                _com: com,
                automation,
                walker,
                allowed: allowed_apps
                    .into_iter()
                    .map(|app| (app.app_id.clone(), app))
                    .collect(),
                windows: HashMap::new(),
                trees: HashMap::new(),
                node_salt,
            })
        }

        pub(super) fn execute(
            &mut self,
            envelope: ActionEnvelope,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let payload = envelope.payload_text;
            match envelope.action {
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
                } => self.click(&app_id, &window_id, &tree_revision, &node_id),
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
                ),
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
                let pid = window_pid(hwnd).ok_or(DesktopExecutionError::FailedClosed)?;
                let Ok(path) = process_path(pid) else {
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
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let (target, element, path) =
                self.resolve_authoritative_node(app_id, window_id, tree_revision, node_id)?;
            let pattern: IUIAutomationInvokePattern =
                unsafe { element.GetCurrentPatternAs(UIA_InvokePatternId) }
                    .map_err(|_| DesktopExecutionError::UnsupportedPattern)?;
            if !unsafe { element.CurrentIsEnabled() }
                .map(|value| value.as_bool())
                .unwrap_or(false)
            {
                return Err(DesktopExecutionError::NodeStale);
            }
            self.revalidate_node_identity(&element, &path, node_id)?;
            unsafe { pattern.Invoke() }.map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            self.verify_mutation_after_side_effect(target, tree_revision, "desktop.click")
        }

        fn type_value(
            &mut self,
            app_id: &str,
            window_id: &str,
            tree_revision: &str,
            node_id: &str,
            payload: &str,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let (target, element, path) =
                self.resolve_authoritative_node(app_id, window_id, tree_revision, node_id)?;
            let pattern: IUIAutomationValuePattern =
                unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }
                    .map_err(|_| DesktopExecutionError::UnsupportedPattern)?;
            if unsafe { pattern.CurrentIsReadOnly() }
                .map(|value| value.as_bool())
                .unwrap_or(true)
            {
                return Err(DesktopExecutionError::ReadOnly);
            }
            self.revalidate_node_identity(&element, &path, node_id)?;
            unsafe { element.SetFocus() }.map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            if !unsafe { element.CurrentIsEnabled() }
                .map(|value| value.as_bool())
                .unwrap_or(false)
            {
                return Err(DesktopExecutionError::OutcomeUncertain);
            }
            if unsafe { pattern.CurrentIsReadOnly() }
                .map(|value| value.as_bool())
                .unwrap_or(true)
            {
                return Err(DesktopExecutionError::OutcomeUncertain);
            }
            self.revalidate_node_identity(&element, &path, node_id)
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            let value = BSTR::from(payload);
            unsafe { pattern.SetValue(&value) }
                .map_err(|_| DesktopExecutionError::OutcomeUncertain)?;
            self.verify_mutation_after_side_effect(target, tree_revision, "desktop.type")
        }

        fn verify_mutation_after_side_effect(
            &mut self,
            target: WindowTarget,
            previous_revision: &str,
            action: &'static str,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let window_id = target.window_id.clone();
            match self.verify_after_write(target, previous_revision, action) {
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
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            let current = self.build_tree(&target)?;
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
            &self,
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
            if !unsafe { IsWindow(target.hwnd()) }.as_bool()
                || window_pid(target.hwnd()) != Some(target.pid)
                || process_path(target.pid)
                    .map(|path| !paths_equal(&path, &target.executable_path))
                    .unwrap_or(true)
            {
                return Err(DesktopExecutionError::WindowStale);
            }
            Ok(target)
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

        fn build_tree(&self, target: &WindowTarget) -> Result<BuiltTree, DesktopExecutionError> {
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
}
