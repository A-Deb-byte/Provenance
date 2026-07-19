use crate::bridge::BridgeSecret;
use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const STABILITY_WINDOW: Duration = Duration::from_millis(750);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_READY_BYTES: u64 = 4 * 1024;
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
}

pub struct NodeSupervisor {
    child: Child,
    job: ProcessJob,
    ready_path: PathBuf,
    node_url: String,
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

        let stdout = append_log(&config.runtime_directory.join("desktop-node.stdout.log"))?;
        let stderr = append_log(&config.runtime_directory.join("desktop-node.stderr.log"))?;
        let mut command = Command::new(&config.node_executable);
        command
            .arg(&config.server_entrypoint)
            .current_dir(&config.working_directory)
            .env_clear()
            .envs(minimal_environment(&config.node_executable))
            .env("NODE_ENV", "production")
            .env("PORT", "0")
            .env("PROVENANCE_PROJECT_ROOT", &config.working_directory)
            .env("PROVENANCE_WORKSPACE_ROOT", &config.workspace_root)
            .env("PROVENANCE_BUILD_VERSION", &config.build_version)
            .env("PROVENANCE_RUNTIME_DIR", &config.runtime_directory)
            .env("DESKTOP_HOST_NONCE", &host_nonce)
            .env("DESKTOP_HOST_READY_FILE", &ready_path)
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
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if config.packaged_release {
            command.env("DESKTOP_PACKAGED_RELEASE", "1");
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
            command.env("PROVENANCE_NATIVE_RELEASE_RUNNER", release_runner);
            command.creation_flags(CREATE_NO_WINDOW.0);
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

        let ready = wait_for_ready(&mut child, &ready_path, &host_nonce)?;
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
            ready_path,
            node_url: format!("http://127.0.0.1:{}", ready.port),
        })
    }

    pub fn node_url(&self) -> &str {
        &self.node_url
    }

    pub fn is_running(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }

    pub fn shutdown(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let deadline = Instant::now() + STOP_TIMEOUT;
            while Instant::now() < deadline {
                if self.child.try_wait().ok().flatten().is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            if self.child.try_wait().ok().flatten().is_none() {
                self.job.terminate();
            }
        }
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.ready_path);
    }
}

impl Drop for NodeSupervisor {
    fn drop(&mut self) {
        self.shutdown();
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

fn ensure_ready_path(runtime_dir: &Path, ready_path: &Path) -> Result<(), SupervisorError> {
    if ready_path.parent() != Some(runtime_dir) || ready_path.exists() {
        return Err(SupervisorError::ReadyPath(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "readiness path is not a fresh runtime child",
        )));
    }
    Ok(())
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
            node_dir.to_path_buf(),
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
) -> Result<ReadyRecord, SupervisorError> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(SupervisorError::Spawn)? {
            return Err(SupervisorError::Exited(status.code()));
        }
        if ready_path.exists() {
            return read_ready_record(ready_path, nonce, child.id());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(SupervisorError::ReadyTimeout)
}

fn read_ready_record(
    ready_path: &Path,
    nonce: &str,
    expected_pid: u32,
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
    if record.schema_version != 1
        || record.nonce != nonce
        || record.pid != expected_pid
        || record.port == 0
    {
        return Err(SupervisorError::InvalidReadyProof);
    }
    Ok(record)
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
    let mut startup = STARTUPINFOW::default();
    startup.cb = size_of::<STARTUPINFOW>() as u32;
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

    #[test]
    fn readiness_proof_rejects_unknown_fields_and_wrong_pid() {
        let unknown = br#"{"schemaVersion":1,"nonce":"n","pid":4,"port":3000,"token":"leak"}"#;
        assert!(serde_json::from_slice::<ReadyRecord>(unknown).is_err());

        let ready: ReadyRecord =
            serde_json::from_str(r#"{"schemaVersion":1,"nonce":"nonce","pid":4,"port":3000}"#)
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
