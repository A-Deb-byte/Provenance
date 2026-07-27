use crate::bridge::BridgeSecret;
use crate::resources::ResourceLease;
use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;

// The supervised kernel probes its optional runtimes before it listens, and a
// container-runtime probe alone has been measured at ~45s on a healthy
// workstation (total time to listening ~48s). `packaged-server-smoke.mjs`
// already budgets 120s for the same startup; this must not be tighter, or the
// host reports a supervisor failure for a server that was merely still booting.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const STABILITY_WINDOW: Duration = Duration::from_millis(750);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_READY_BYTES: u64 = 4 * 1024;
const MAX_SHUTDOWN_BYTES: u64 = 1024;
const MAX_SHUTDOWN_STATUS_LINE_BYTES: usize = 256;
const NATIVE_RELEASE_RUNNER_FLAG: &str = "--provenance-native-release-runner-v1";
const NATIVE_RELEASE_RUNNER_FAILURE: i32 = 125;

pub fn native_release_runner_exit_code() -> Option<i32> {
    let mut arguments = std::env::args_os();
    let _executable = arguments.next();
    if arguments.next().as_deref() != Some(OsStr::new(NATIVE_RELEASE_RUNNER_FLAG)) {
        return None;
    }
    let arguments = arguments.collect::<Vec<_>>();
    Some(run_native_release_runner(arguments).unwrap_or(NATIVE_RELEASE_RUNNER_FAILURE))
}

#[cfg(not(windows))]
fn run_native_release_runner(_arguments: Vec<OsString>) -> Result<i32, ()> {
    Err(())
}

#[derive(Clone)]
pub struct FirstAdminBootstrapSecret(String);

impl FirstAdminBootstrapSecret {
    pub fn generate() -> Self {
        Self(random_launch_nonce())
    }

    pub fn expose_to_supervised_child(&self) -> &str {
        &self.0
    }

    pub fn expose_to_initial_webview(&self) -> &str {
        &self.0
    }

    fn is_valid(&self) -> bool {
        self.0.len() == 43
            && self
                .0
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    }
}

impl fmt::Debug for FirstAdminBootstrapSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FirstAdminBootstrapSecret([redacted])")
    }
}

#[derive(Clone, Debug)]
pub struct NodeLaunchConfig {
    pub node_executable: PathBuf,
    pub server_entrypoint: PathBuf,
    pub working_directory: PathBuf,
    pub runtime_directory: PathBuf,
    pub bridge_url: String,
    pub bridge_secret: BridgeSecret,
    pub first_admin_bootstrap_secret: FirstAdminBootstrapSecret,
    pub runtime_owner_nonce: String,
    pub host_instance_id: String,
    pub desktop_app_allowlist_json: String,
    pub workspace_root: PathBuf,
    pub packaged_release: bool,
    pub sandbox_image: Option<String>,
    pub build_version: String,
    pub acceptance_mode: bool,
    pub native_acceptance_mount_origin: Option<String>,
    pub resource_root: PathBuf,
}

impl NodeLaunchConfig {
    fn validate(mut self) -> Result<Self, SupervisorError> {
        self.node_executable = canonical_file(&self.node_executable, "Node executable")?;
        self.server_entrypoint = canonical_file(&self.server_entrypoint, "server entrypoint")?;
        self.working_directory = std::fs::canonicalize(&self.working_directory)
            .map_err(|error| SupervisorError::InvalidPath("working directory", error))?;
        self.runtime_directory = std::fs::canonicalize(&self.runtime_directory)
            .map_err(|error| SupervisorError::InvalidPath("runtime directory", error))?;
        self.workspace_root = std::fs::canonicalize(&self.workspace_root)
            .map_err(|error| SupervisorError::InvalidPath("project workspace", error))?;
        self.resource_root = std::fs::canonicalize(&self.resource_root)
            .map_err(|error| SupervisorError::InvalidPath("resource root", error))?;

        if !self
            .node_executable
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Err(SupervisorError::InvalidExecutable);
        }
        if !self
            .server_entrypoint
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("cjs"))
            || !is_within(&self.working_directory, &self.server_entrypoint)
        {
            return Err(SupervisorError::EntrypointEscaped);
        }
        if is_within(&self.working_directory, &self.runtime_directory) {
            return Err(SupervisorError::RuntimeInsideWorkspace);
        }
        let workspace_package = std::fs::symlink_metadata(self.workspace_root.join("package.json"));
        if !self.workspace_root.is_dir()
            || workspace_package
                .as_ref()
                .map(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
                .unwrap_or(true)
            || (self.packaged_release
                && (is_within(&self.working_directory, &self.workspace_root)
                    || is_within(&self.workspace_root, &self.working_directory)))
            || is_within(&self.runtime_directory, &self.workspace_root)
            || is_within(&self.workspace_root, &self.runtime_directory)
        {
            return Err(SupervisorError::InvalidWorkspace);
        }
        if !self.bridge_url.starts_with("http://127.0.0.1:")
            || self.bridge_secret.expose_to_supervised_child().len() < 32
            || self.runtime_owner_nonce.len() < 32
        {
            return Err(SupervisorError::InvalidBridge);
        }
        if !self.first_admin_bootstrap_secret.is_valid() {
            return Err(SupervisorError::InvalidBootstrapSecret);
        }
        if self.desktop_app_allowlist_json.len() > 64 * 1024
            || serde_json::from_str::<Vec<crate::contracts::AllowedApplication>>(
                &self.desktop_app_allowlist_json,
            )
            .is_err()
        {
            return Err(SupervisorError::InvalidAllowlist);
        }
        if self
            .sandbox_image
            .as_deref()
            .is_some_and(|image| !is_digest_pinned_image(image))
            || (self.packaged_release && self.sandbox_image.is_none())
        {
            return Err(SupervisorError::InvalidSandboxImage);
        }
        if !is_public_build_version(&self.build_version) {
            return Err(SupervisorError::InvalidBuildVersion);
        }
        if !self.host_instance_id.starts_with("desktop-host-")
            || self.host_instance_id.len() != 45
            || !self.host_instance_id[13..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(SupervisorError::InvalidBridge);
        }
        if self.packaged_release && self.resource_root != self.working_directory {
            return Err(SupervisorError::InvalidResources);
        }
        match (
            self.acceptance_mode,
            self.native_acceptance_mount_origin.as_deref(),
        ) {
            (true, Some(origin)) if is_exact_loopback_origin(origin) => {}
            (false, None) => {}
            _ => return Err(SupervisorError::InvalidAcceptanceOrigin),
        }
        Ok(self)
    }
}

#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("{0} is not a readable canonical file: {1}")]
    InvalidPath(&'static str, #[source] std::io::Error),
    #[error("the supervised Node executable must be an absolute .exe file")]
    InvalidExecutable,
    #[error("the fixed CommonJS entrypoint escaped the supervised working directory")]
    EntrypointEscaped,
    #[error("the native runtime directory must be outside the command workspace")]
    RuntimeInsideWorkspace,
    #[error("the project workspace must be a real package directory disjoint from native resources and runtime state")]
    InvalidWorkspace,
    #[error("the desktop bridge URL, token, or runtime-owner nonce is invalid")]
    InvalidBridge,
    #[error("the per-launch first-admin bootstrap secret is invalid")]
    InvalidBootstrapSecret,
    #[error("the desktop application allowlist is not canonical bounded JSON")]
    InvalidAllowlist,
    #[error("packaged desktop releases require a digest-pinned command sandbox image")]
    InvalidSandboxImage,
    #[error("the native build version is invalid")]
    InvalidBuildVersion,
    #[error("the packaged runtime resources failed build-manifest authentication")]
    InvalidResources,
    #[error("native acceptance requires one exact pre-bound loopback mount origin")]
    InvalidAcceptanceOrigin,
    #[error("the per-launch readiness path could not be prepared: {0}")]
    ReadyPath(#[source] std::io::Error),
    #[error("the supervised Node log could not be opened: {0}")]
    Log(#[source] std::io::Error),
    #[error("the supervised Node child could not be spawned: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("the supervised Node child could not be assigned to a kill-on-close job: {0}")]
    Job(String),
    #[error("the supervised Node child exited before readiness (code {0:?})")]
    Exited(Option<i32>),
    #[error("the supervised Node child did not produce a valid readiness proof in time")]
    ReadyTimeout,
    #[error("the supervised Node readiness proof was invalid")]
    InvalidReadyProof,
    #[error("the supervised Node child exited during the stability window")]
    Unstable,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyRecord {
    schema_version: u8,
    nonce: String,
    pid: u32,
    port: u16,
    host_instance_id: String,
    kernel_ready: bool,
    access_mode: String,
    bridge_authenticated: bool,
    scheduler_enabled: bool,
    desktop_status: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShutdownRecord {
    schema_version: u8,
    nonce: String,
    pid: u32,
}

pub struct NodeSupervisor {
    child: Child,
    job: ProcessJob,
    _resource_lease: ResourceLease,
    ready_path: PathBuf,
    node_url: String,
    node_port: u16,
    access_mode: String,
    desktop_status: String,
    scheduler_enabled: bool,
    shutdown_token: String,
    shutdown_nonce: String,
    shutdown_path: PathBuf,
    clean_shutdown: Option<bool>,
}

impl NodeSupervisor {
    pub fn start(config: NodeLaunchConfig) -> Result<Self, SupervisorError> {
        let config = config.validate()?;
        let launch_id = Uuid::new_v4().simple().to_string();
        let host_nonce = random_launch_nonce();
        let ready_path = config
            .runtime_directory
            .join(format!(".desktop-ready-{launch_id}.json"));
        ensure_ready_path(&config.runtime_directory, &ready_path)?;
        let shutdown_token = random_launch_nonce();
        let shutdown_nonce = random_launch_nonce();
        let shutdown_path = config
            .runtime_directory
            .join(format!(".desktop-shutdown-{launch_id}.json"));
        ensure_ready_path(&config.runtime_directory, &shutdown_path)?;
        let child_ready_path = child_runtime_path(&config.runtime_directory, &ready_path)?;
        let child_shutdown_path = child_runtime_path(&config.runtime_directory, &shutdown_path)?;

        let stdout = append_log(&config.runtime_directory.join("desktop-node.stdout.log"))?;
        let stderr = append_log(&config.runtime_directory.join("desktop-node.stderr.log"))?;
        let mut command = Command::new(&config.node_executable);
        command
            .arg(child_path(&config.server_entrypoint))
            .current_dir(child_path(&config.working_directory))
            .env_clear()
            .envs(minimal_environment(&config.node_executable))
            .env("NODE_ENV", "production")
            .env("PORT", "0")
            .env(
                "PROVENANCE_PROJECT_ROOT",
                child_path(&config.working_directory),
            )
            .env(
                "PROVENANCE_WORKSPACE_ROOT",
                child_path(&config.workspace_root),
            )
            .env("PROVENANCE_BUILD_VERSION", &config.build_version)
            .env(
                "PROVENANCE_RUNTIME_DIR",
                child_path(&config.runtime_directory),
            )
            .env("DESKTOP_HOST_NONCE", &host_nonce)
            .env("DESKTOP_HOST_READY_FILE", child_ready_path)
            .env("DESKTOP_RUNTIME_OWNER_NONCE", &config.runtime_owner_nonce)
            .env("DESKTOP_RUNTIME_OWNER_PID", std::process::id().to_string())
            .env("DESKTOP_BRIDGE_URL", &config.bridge_url)
            .env(
                "DESKTOP_BRIDGE_TOKEN",
                config.bridge_secret.expose_to_supervised_child(),
            )
            .env(
                "PROVENANCE_FIRST_ADMIN_BOOTSTRAP_SECRET",
                config
                    .first_admin_bootstrap_secret
                    .expose_to_supervised_child(),
            )
            .env("DESKTOP_HOST_INSTANCE_ID", &config.host_instance_id)
            .env("DESKTOP_APP_ALLOWLIST", &config.desktop_app_allowlist_json)
            .env("DESKTOP_HOST_SHUTDOWN_TOKEN", &shutdown_token)
            .env("DESKTOP_HOST_SHUTDOWN_NONCE", &shutdown_nonce)
            .env("DESKTOP_HOST_SHUTDOWN_FILE", child_shutdown_path)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if config.packaged_release {
            command.env("DESKTOP_PACKAGED_RELEASE", "1");
        }
        if config.acceptance_mode {
            command
                .env("PROVENANCE_NATIVE_ACCEPTANCE", "1")
                .env(
                    "PROVENANCE_NATIVE_ACCEPTANCE_MOUNT_ORIGIN",
                    config
                        .native_acceptance_mount_origin
                        .as_deref()
                        .ok_or(SupervisorError::InvalidAcceptanceOrigin)?,
                )
                .env("RECURRING_RESEARCH_SCHEDULER_ENABLED", "0");
        }
        if let Some(image) = &config.sandbox_image {
            command.env("PROVENANCE_SANDBOX_IMAGE", image);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows::Win32::System::Threading::CREATE_NO_WINDOW;
            let release_runner = canonical_file(
                &std::env::current_exe().map_err(|error| {
                    SupervisorError::InvalidPath("native release runner", error)
                })?,
                "native release runner",
            )?;
            if !release_runner
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
            {
                return Err(SupervisorError::InvalidExecutable);
            }
            command.env(
                "PROVENANCE_NATIVE_RELEASE_RUNNER",
                child_path(&release_runner),
            );
            command.creation_flags(CREATE_NO_WINDOW.0);
        }

        // Authenticate through read handles immediately before dispatch. On
        // Windows those handles share reads only, so the exact checked files
        // cannot be replaced, rewritten, or deleted while Node is alive.
        let mut resource_lease =
            ResourceLease::authenticate(&config.resource_root, config.packaged_release)
                .map_err(|_| SupervisorError::InvalidResources)?;
        if let Some(manifest_path) = resource_lease
            .publish_authenticated_manifest(&config.runtime_directory, &launch_id)
            .map_err(|_| SupervisorError::InvalidResources)?
        {
            command
                .env(
                    "PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_PATH",
                    child_path(&manifest_path),
                )
                .env(
                    "PROVENANCE_AUTHENTICATED_RESOURCE_MANIFEST_SHA256",
                    resource_lease.manifest_sha256(),
                );
        }
        let mut child = command.spawn().map_err(SupervisorError::Spawn)?;
        let job = match ProcessJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        let ready = wait_for_ready(
            &mut child,
            &ready_path,
            &host_nonce,
            &config.host_instance_id,
            config.acceptance_mode,
        )?;
        if ready.pid != child.id() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SupervisorError::InvalidReadyProof);
        }
        std::fs::remove_file(&ready_path).map_err(SupervisorError::ReadyPath)?;
        wait_for_stability(&mut child)?;

        Ok(Self {
            child,
            job,
            _resource_lease: resource_lease,
            ready_path,
            node_url: format!("http://127.0.0.1:{}", ready.port),
            node_port: ready.port,
            access_mode: ready.access_mode,
            desktop_status: ready.desktop_status,
            scheduler_enabled: ready.scheduler_enabled,
            shutdown_token,
            shutdown_nonce,
            shutdown_path,
            clean_shutdown: None,
        })
    }

    pub fn node_url(&self) -> &str {
        &self.node_url
    }

    pub fn child_pid(&self) -> u32 {
        self.child.id()
    }

    pub fn node_port(&self) -> u16 {
        self.node_port
    }

    pub fn access_mode(&self) -> &str {
        &self.access_mode
    }

    pub fn desktop_status(&self) -> &str {
        &self.desktop_status
    }

    pub fn scheduler_enabled(&self) -> bool {
        self.scheduler_enabled
    }

    pub fn resource_manifest_sha256(&self) -> &str {
        self._resource_lease.manifest_sha256()
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn shutdown(&mut self) -> bool {
        if let Some(clean) = self.clean_shutdown {
            return clean;
        }
        let clean = if matches!(self.child.try_wait(), Ok(None)) {
            request_graceful_shutdown(self.node_port, &self.shutdown_token).is_ok()
                && wait_for_exit(&mut self.child, STOP_TIMEOUT)
                && read_shutdown_record(&self.shutdown_path, &self.shutdown_nonce, self.child.id())
                    .is_ok()
        } else {
            false
        };
        if !clean {
            match self.child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => {
                    self.job.terminate();
                    let _ = self.child.wait();
                }
            }
        }
        let _ = std::fs::remove_file(&self.ready_path);
        if clean {
            let _ = std::fs::remove_file(&self.shutdown_path);
        }
        self.clean_shutdown = Some(clean);
        clean
    }
}

impl Drop for NodeSupervisor {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn canonical_file(path: &Path, label: &'static str) -> Result<PathBuf, SupervisorError> {
    let canonical =
        std::fs::canonicalize(path).map_err(|error| SupervisorError::InvalidPath(label, error))?;
    if !canonical.is_file() {
        return Err(SupervisorError::InvalidPath(
            label,
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a regular file"),
        ));
    }
    Ok(canonical)
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn is_exact_loopback_origin(value: &str) -> bool {
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.origin().ascii_serialization() == value
}

/// Renders a canonical path in the form the supervised child can parse.
///
/// Windows `fs::canonicalize` returns extended-length `\\?\` paths. Those are
/// correct for Win32 calls and are what every containment check above compares,
/// so they are deliberately kept internally. Node, however, parses `\\?\C:\...`
/// as a UNC share and resolves it to `C:` -- which makes the server entrypoint
/// unloadable and every path-valued environment variable wrong. Conversion
/// therefore happens only where a path crosses into the child, leaving the
/// authority-bearing comparisons on a single canonical form.
#[cfg(windows)]
fn child_path(path: &Path) -> PathBuf {
    const VERBATIM: &str = r"\\?\";
    const VERBATIM_UNC: &str = r"\\?\UNC\";
    // A non-UTF-8 path cannot be rewritten safely, so it is passed through
    // unchanged rather than lossily reconstructed into a different path.
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(share) = text.strip_prefix(VERBATIM_UNC) {
        let candidate = PathBuf::from(format!(r"\\{share}"));
        if matches!(
            std::fs::canonicalize(&candidate),
            Ok(ref canonical) if canonical == path
        ) {
            return candidate;
        }
        return path.to_path_buf();
    }
    if let Some(rest) = text.strip_prefix(VERBATIM) {
        let bytes = rest.as_bytes();
        // Only drive-qualified verbatim paths have an ordinary equivalent.
        // Device paths such as `\\?\Volume{...}` keep the prefix, since
        // removing it there would address a different file.
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let candidate = PathBuf::from(rest);
            if matches!(
                std::fs::canonicalize(&candidate),
                Ok(ref canonical) if canonical == path
            ) {
                return candidate;
            }
        }
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn child_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn ensure_ready_path(runtime_dir: &Path, ready_path: &Path) -> Result<(), SupervisorError> {
    if ready_path.parent() != Some(runtime_dir) || ready_path.exists() {
        return Err(SupervisorError::ReadyPath(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "readiness path is not a fresh runtime child",
        )));
    }
    Ok(())
}

fn child_runtime_path(
    runtime_dir: &Path,
    controlled_child: &Path,
) -> Result<PathBuf, SupervisorError> {
    if controlled_child.parent() != Some(runtime_dir) || controlled_child.exists() {
        return Err(SupervisorError::ReadyPath(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "child path is not a fresh direct runtime child",
        )));
    }
    let file_name = controlled_child.file_name().ok_or_else(|| {
        SupervisorError::ReadyPath(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "child path has no filename",
        ))
    })?;
    Ok(child_path(runtime_dir).join(file_name))
}

fn append_log(path: &Path) -> Result<File, SupervisorError> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(SupervisorError::Log)
}

fn minimal_environment(node_executable: &Path) -> Vec<(String, String)> {
    const INHERITED: &[&str] = &[
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMDATA",
    ];
    let mut values: Vec<(String, String)> = INHERITED
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| ((*key).into(), value)))
        .collect();
    if let Ok(windows) = std::env::var("WINDIR") {
        let node_dir = node_executable.parent().unwrap_or_else(|| Path::new(""));
        let path = [
            // PATH is consumed by the child, so this entry follows the same
            // boundary conversion as every other path handed across.
            child_path(node_dir),
            PathBuf::from(&windows).join("System32"),
            PathBuf::from(&windows),
            PathBuf::from(&windows).join("System32/WindowsPowerShell/v1.0"),
        ]
        .into_iter()
        .map(|entry| entry.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(";");
        values.push(("PATH".into(), path));
    }
    values
}

fn wait_for_ready(
    child: &mut Child,
    ready_path: &Path,
    nonce: &str,
    host_instance_id: &str,
    acceptance_mode: bool,
) -> Result<ReadyRecord, SupervisorError> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(SupervisorError::Spawn)? {
            return Err(SupervisorError::Exited(status.code()));
        }
        if ready_path.exists() {
            return read_ready_record(
                ready_path,
                nonce,
                child.id(),
                host_instance_id,
                acceptance_mode,
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(SupervisorError::ReadyTimeout)
}

fn read_ready_record(
    ready_path: &Path,
    nonce: &str,
    expected_pid: u32,
    host_instance_id: &str,
    acceptance_mode: bool,
) -> Result<ReadyRecord, SupervisorError> {
    let metadata =
        std::fs::symlink_metadata(ready_path).map_err(|_| SupervisorError::InvalidReadyProof)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_READY_BYTES {
        return Err(SupervisorError::InvalidReadyProof);
    }
    let mut content = Vec::with_capacity(metadata.len() as usize);
    File::open(ready_path)
        .and_then(|file| file.take(MAX_READY_BYTES + 1).read_to_end(&mut content))
        .map_err(|_| SupervisorError::InvalidReadyProof)?;
    if content.len() as u64 > MAX_READY_BYTES {
        return Err(SupervisorError::InvalidReadyProof);
    }
    let record: ReadyRecord =
        serde_json::from_slice(&content).map_err(|_| SupervisorError::InvalidReadyProof)?;
    let desktop_status_is_valid = matches!(
        record.desktop_status.as_str(),
        "available" | "configured" | "unavailable" | "blocked"
    );
    let access_mode_is_valid = matches!(
        record.access_mode.as_str(),
        "open" | "operator_token" | "multi_user"
    );
    if record.schema_version != 3
        || record.nonce != nonce
        || record.pid != expected_pid
        || record.port == 0
        || record.host_instance_id != host_instance_id
        || !record.kernel_ready
        || !access_mode_is_valid
        || !record.bridge_authenticated
        || !desktop_status_is_valid
        || (acceptance_mode && record.scheduler_enabled)
        || (acceptance_mode && record.desktop_status != "available")
        || (acceptance_mode && record.access_mode != "multi_user")
    {
        return Err(SupervisorError::InvalidReadyProof);
    }
    Ok(record)
}

fn request_graceful_shutdown(port: u16, token: &str) -> Result<(), ()> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(1)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| ())?;
    let request = format!(
        "POST /__provenance/native/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-provenance-native-shutdown: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(|_| ())?;
    let _ = stream.shutdown(Shutdown::Write);
    read_successful_shutdown_status(&mut stream)
}

fn read_successful_shutdown_status(reader: &mut impl Read) -> Result<(), ()> {
    let mut response = Vec::with_capacity(64);
    let mut buffer = [0_u8; 64];
    loop {
        let remaining = (MAX_SHUTDOWN_STATUS_LINE_BYTES + 2).saturating_sub(response.len());
        if remaining == 0 {
            return Err(());
        }
        let read_length = remaining.min(buffer.len());
        let received = reader.read(&mut buffer[..read_length]).map_err(|_| ())?;
        if received == 0 {
            return Err(());
        }
        response.extend_from_slice(&buffer[..received]);
        let Some(line_end) = response.windows(2).position(|bytes| bytes == b"\r\n") else {
            continue;
        };
        if line_end > MAX_SHUTDOWN_STATUS_LINE_BYTES {
            return Err(());
        }
        let status = std::str::from_utf8(&response[..line_end]).map_err(|_| ())?;
        return if status.starts_with("HTTP/1.1 204 ") || status.starts_with("HTTP/1.0 204 ") {
            Ok(())
        } else {
            Err(())
        };
    }
}

#[cfg(test)]
fn successful_shutdown_status(status: &str) -> Result<(), ()> {
    let mut response = std::io::Cursor::new(status.as_bytes());
    if read_successful_shutdown_status(&mut response).is_ok() {
        Ok(())
    } else {
        Err(())
    }
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

fn read_shutdown_record(path: &Path, nonce: &str, pid: u32) -> Result<(), ()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_SHUTDOWN_BYTES {
        return Err(());
    }
    let mut content = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(MAX_SHUTDOWN_BYTES + 1).read_to_end(&mut content))
        .map_err(|_| ())?;
    if content.len() as u64 > MAX_SHUTDOWN_BYTES {
        return Err(());
    }
    let record: ShutdownRecord = serde_json::from_slice(&content).map_err(|_| ())?;
    if record.schema_version != 1 || record.nonce != nonce || record.pid != pid {
        return Err(());
    }
    Ok(())
}

fn wait_for_stability(child: &mut Child) -> Result<(), SupervisorError> {
    let deadline = Instant::now() + STABILITY_WINDOW;
    while Instant::now() < deadline {
        if child.try_wait().map_err(SupervisorError::Spawn)?.is_some() {
            return Err(SupervisorError::Unstable);
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

fn random_launch_nonce() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn is_digest_pinned_image(value: &str) -> bool {
    let Some((repository, digest)) = value.rsplit_once("@sha256:") else {
        return false;
    };
    repository.contains('/')
        && !repository.starts_with('/')
        && !repository.ends_with('/')
        && repository.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-' | b'/' | b':')
        })
        && digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_public_build_version(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 64
        || !value.is_ascii()
        || value.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return false;
    }
    let core = value.split_once('-').map(|(core, _)| core).unwrap_or(value);
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(windows)]
struct ProcessJob {
    handle: windows::Win32::Foundation::HANDLE,
}

// The job handle has unique ownership and is only used behind the host's
// supervisor mutex. Moving it to Tauri managed state does not duplicate it.
#[cfg(windows)]
unsafe impl Send for ProcessJob {}

#[cfg(windows)]
impl ProcessJob {
    fn create() -> Result<Self, SupervisorError> {
        use std::ffi::c_void;
        use std::mem::size_of;
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let handle = CreateJobObjectW(None, windows::core::PCWSTR::null())
                .map_err(|error| SupervisorError::Job(error.to_string()))?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
                return Err(SupervisorError::Job(error.to_string()));
            }
            Ok(Self { handle })
        }
    }

    fn assign_handle(
        &self,
        process_handle: windows::Win32::Foundation::HANDLE,
    ) -> Result<(), SupervisorError> {
        unsafe {
            windows::Win32::System::JobObjects::AssignProcessToJobObject(
                self.handle,
                process_handle,
            )
            .map_err(|error| SupervisorError::Job(error.to_string()))
        }
    }

    fn assign(child: &Child) -> Result<Self, SupervisorError> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;

        let job = Self::create()?;
        job.assign_handle(HANDLE(child.as_raw_handle()))?;
        Ok(job)
    }

    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
    }
}

#[cfg(windows)]
fn run_native_release_runner(arguments: Vec<OsString>) -> Result<i32, ()> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
        CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION, STARTUPINFOW,
    };

    if arguments.len() != 3 {
        return Err(());
    }
    let node_executable = canonical_runner_file(&arguments[0], "exe")?;
    let working_directory = std::fs::canonicalize(PathBuf::from(&arguments[2])).map_err(|_| ())?;
    if !working_directory.is_dir() {
        return Err(());
    }
    let entrypoint = canonical_runner_file(&arguments[1], "cjs")?;
    if !is_within(&working_directory, &entrypoint) {
        return Err(());
    }

    let node_argument = node_executable
        .as_os_str()
        .encode_wide()
        .collect::<Vec<_>>();
    let entrypoint_argument = entrypoint.as_os_str().encode_wide().collect::<Vec<_>>();
    if node_argument
        .iter()
        .any(|value| *value == 0 || *value == b'"' as u16)
        || entrypoint_argument
            .iter()
            .any(|value| *value == 0 || *value == b'"' as u16)
    {
        return Err(());
    }
    let mut command_line = Vec::with_capacity(node_argument.len() + entrypoint_argument.len() + 6);
    command_line.push(b'"' as u16);
    command_line.extend_from_slice(&node_argument);
    command_line.extend_from_slice(&[b'"' as u16, b' ' as u16, b'"' as u16]);
    command_line.extend_from_slice(&entrypoint_argument);
    command_line.extend_from_slice(&[b'"' as u16, 0]);
    let node_wide = node_executable
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let working_wide = working_directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();

    let job = ProcessJob::create().map_err(|_| ())?;
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessW(
            PCWSTR(node_wide.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            None,
            PCWSTR(working_wide.as_ptr()),
            &startup,
            &mut process,
        )
        .map_err(|_| ())?;

        if job.assign_handle(process.hProcess).is_err() {
            let _ = TerminateProcess(process.hProcess, NATIVE_RELEASE_RUNNER_FAILURE as u32);
            let _ = WaitForSingleObject(process.hProcess, INFINITE);
            let _ = CloseHandle(process.hThread);
            let _ = CloseHandle(process.hProcess);
            return Err(());
        }
        if ResumeThread(process.hThread) == u32::MAX {
            job.terminate();
            let _ = WaitForSingleObject(process.hProcess, INFINITE);
            let _ = CloseHandle(process.hThread);
            let _ = CloseHandle(process.hProcess);
            return Err(());
        }
        let _ = CloseHandle(process.hThread);
        if WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0 {
            job.terminate();
            let _ = CloseHandle(process.hProcess);
            return Err(());
        }
        let mut exit_code = NATIVE_RELEASE_RUNNER_FAILURE as u32;
        let result = GetExitCodeProcess(process.hProcess, &mut exit_code);
        let _ = CloseHandle(process.hProcess);
        result.map_err(|_| ())?;
        if exit_code > 255 {
            return Err(());
        }
        Ok(exit_code as i32)
    }
}

#[cfg(windows)]
fn canonical_runner_file(path: &OsStr, expected_extension: &str) -> Result<PathBuf, ()> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err(());
    }
    let canonical = std::fs::canonicalize(requested).map_err(|_| ())?;
    let metadata = std::fs::symlink_metadata(&canonical).map_err(|_| ())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || !canonical
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(expected_extension))
    {
        return Err(());
    }
    Ok(canonical)
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
struct ProcessJob;

#[cfg(not(windows))]
impl ProcessJob {
    fn assign(_child: &Child) -> Result<Self, SupervisorError> {
        Ok(Self)
    }

    fn terminate(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ByteAtATime {
        bytes: Vec<u8>,
        offset: usize,
    }

    impl ByteAtATime {
        fn new(value: &str) -> Self {
            Self {
                bytes: value.as_bytes().to_vec(),
                offset: 0,
            }
        }
    }

    impl Read for ByteAtATime {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.offset == self.bytes.len() || buffer.is_empty() {
                return Ok(0);
            }
            buffer[0] = self.bytes[self.offset];
            self.offset += 1;
            Ok(1)
        }
    }

    #[test]
    fn readiness_proof_rejects_unknown_fields_and_wrong_pid() {
        let unknown = br#"{"schemaVersion":3,"nonce":"n","pid":4,"port":3000,"hostInstanceId":"desktop-host-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kernelReady":true,"accessMode":"multi_user","bridgeAuthenticated":true,"schedulerEnabled":false,"desktopStatus":"available","token":"leak"}"#;
        assert!(serde_json::from_slice::<ReadyRecord>(unknown).is_err());

        let ready: ReadyRecord = serde_json::from_str(
            r#"{"schemaVersion":3,"nonce":"nonce","pid":4,"port":3000,"hostInstanceId":"desktop-host-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kernelReady":true,"accessMode":"multi_user","bridgeAuthenticated":true,"schedulerEnabled":false,"desktopStatus":"available"}"#,
        )
        .unwrap();
        assert_eq!(ready.pid, 4);
        assert_ne!(ready.pid, 5);
    }

    #[test]
    fn path_containment_does_not_accept_sibling_prefixes() {
        let root = Path::new(r"C:\Program Files\Provenance");
        assert!(is_within(root, &root.join("core/dist/server.cjs")));
        assert!(!is_within(
            root,
            Path::new(r"C:\Program Files\Provenance-evil\server.cjs")
        ));
        assert!(!is_within(
            root,
            Path::new(r"C:\Users\operator\AppData\Local\Provenance\runtime")
        ));
    }

    #[test]
    fn native_acceptance_callback_is_one_exact_loopback_origin() {
        assert!(is_exact_loopback_origin("http://127.0.0.1:43123"));
        assert!(!is_exact_loopback_origin("http://localhost:43123"));
        assert!(!is_exact_loopback_origin("http://127.0.0.1:43123/path"));
        assert!(!is_exact_loopback_origin("https://127.0.0.1:43123"));
    }

    #[test]
    fn shutdown_status_accepts_a_fragmented_complete_204_line() {
        let mut response = ByteAtATime::new("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        assert!(read_successful_shutdown_status(&mut response).is_ok());
        assert!(successful_shutdown_status("HTTP/1.0 204 No Content\r\n").is_ok());
    }

    #[test]
    fn shutdown_status_rejects_incomplete_malformed_and_oversized_lines() {
        assert!(successful_shutdown_status("HTTP/1.1 200 OK\r\n").is_err());
        assert!(successful_shutdown_status("HTTP/1.1 204 No Content\n").is_err());
        assert!(successful_shutdown_status(&format!(
            "HTTP/1.1 204 {}\r\n",
            "x".repeat(MAX_SHUTDOWN_STATUS_LINE_BYTES)
        ))
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn child_paths_only_drop_a_verbatim_prefix_after_semantic_round_trip() {
        // Node resolves `\\?\C:\...` as a UNC share and lstats `C:`, so a
        // canonicalized entrypoint reaches the child unloadable unless the
        // prefix is removed at the boundary.
        let directory =
            std::env::temp_dir().join(format!("provenance-child-path-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("server.cjs");
        std::fs::write(&file, "module.exports = {};").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let rendered = child_path(&canonical);
        assert_eq!(std::fs::canonicalize(&rendered).unwrap(), canonical);
        assert!(!rendered.to_string_lossy().starts_with(r"\\?\"));
        let canonical_directory = std::fs::canonicalize(&directory).unwrap();
        let controlled = canonical_directory.join(".desktop-ready-test.json");
        let rendered_controlled = child_runtime_path(&canonical_directory, &controlled).unwrap();
        assert_eq!(
            std::fs::canonicalize(rendered_controlled.parent().unwrap()).unwrap(),
            canonical_directory
        );
        assert_eq!(
            rendered_controlled.file_name(),
            Some(std::ffi::OsStr::new(".desktop-ready-test.json"))
        );
        assert!(!rendered_controlled.to_string_lossy().starts_with(r"\\?\"));
        std::fs::remove_dir_all(&directory).unwrap();

        // A syntactically convertible path that cannot be proved equivalent is
        // left untouched, so the child fails closed instead of addressing a
        // different file.
        let missing = Path::new(r"\\?\C:\Provenance-does-not-exist\server.cjs");
        assert_eq!(child_path(missing), missing.to_path_buf());
        // Ordinary paths and device paths without a drive equivalent are
        // never rewritten: doing so would address a different file.
        let ordinary = Path::new(r"C:\Provenance\dist\server.cjs");
        assert_eq!(child_path(ordinary), ordinary.to_path_buf());
        let volume = Path::new(r"\\?\Volume{eb1cf39b-0000-0000-0000-100000000000}\dist");
        assert_eq!(child_path(volume), volume.to_path_buf());
    }

    #[test]
    fn generated_launch_nonces_are_long_and_distinct() {
        let left = random_launch_nonce();
        let right = random_launch_nonce();
        assert!(left.len() >= 32);
        assert_ne!(left, right);
    }

    #[test]
    fn first_admin_bootstrap_secrets_are_redacted_and_url_safe() {
        let left = FirstAdminBootstrapSecret::generate();
        let right = FirstAdminBootstrapSecret::generate();
        let exposed = left.expose_to_initial_webview();
        assert!(left.is_valid());
        assert_eq!(exposed.len(), 43);
        assert!(exposed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
        assert_ne!(exposed, right.expose_to_initial_webview());
        assert_eq!(format!("{left:?}"), "FirstAdminBootstrapSecret([redacted])");
        assert!(!format!("{left:?}").contains(exposed));
    }

    #[test]
    fn packaged_sandbox_images_are_exact_digest_references() {
        assert!(is_digest_pinned_image(&format!(
            "registry.example.test/provenance/sandbox@sha256:{}",
            "a".repeat(64)
        )));
        assert!(!is_digest_pinned_image("provenance/sandbox:latest"));
        assert!(!is_digest_pinned_image(&format!(
            "Provenance/sandbox@sha256:{}",
            "a".repeat(64)
        )));
    }

    #[test]
    fn native_build_versions_are_public_bounded_semver() {
        assert!(is_public_build_version("0.1.0"));
        assert!(is_public_build_version("1.2.3-rc.1"));
        assert!(!is_public_build_version("model-selected"));
        assert!(!is_public_build_version("1.2.3\nSECRET=value"));
    }
}
