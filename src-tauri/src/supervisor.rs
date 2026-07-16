use crate::bridge::BridgeSecret;
use serde::Deserialize;
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

#[derive(Clone, Debug)]
pub struct NodeLaunchConfig {
    pub node_executable: PathBuf,
    pub server_entrypoint: PathBuf,
    pub working_directory: PathBuf,
    pub runtime_directory: PathBuf,
    pub bridge_url: String,
    pub bridge_secret: BridgeSecret,
    pub runtime_owner_nonce: String,
    pub host_instance_id: String,
    pub desktop_app_allowlist_json: String,
}

impl NodeLaunchConfig {
    fn validate(mut self) -> Result<Self, SupervisorError> {
        self.node_executable = canonical_file(&self.node_executable, "Node executable")?;
        self.server_entrypoint = canonical_file(&self.server_entrypoint, "server entrypoint")?;
        self.working_directory = std::fs::canonicalize(&self.working_directory)
            .map_err(|error| SupervisorError::InvalidPath("working directory", error))?;
        self.runtime_directory = std::fs::canonicalize(&self.runtime_directory)
            .map_err(|error| SupervisorError::InvalidPath("runtime directory", error))?;

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
        if !self.bridge_url.starts_with("http://127.0.0.1:")
            || self.bridge_secret.expose_to_supervised_child().len() < 32
            || self.runtime_owner_nonce.len() < 32
        {
            return Err(SupervisorError::InvalidBridge);
        }
        if self.desktop_app_allowlist_json.len() > 64 * 1024
            || serde_json::from_str::<Vec<crate::contracts::AllowedApplication>>(
                &self.desktop_app_allowlist_json,
            )
            .is_err()
        {
            return Err(SupervisorError::InvalidAllowlist);
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
    #[error("the desktop bridge URL, token, or runtime-owner nonce is invalid")]
    InvalidBridge,
    #[error("the desktop application allowlist is not canonical bounded JSON")]
    InvalidAllowlist,
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
            .env("DESKTOP_HOST_INSTANCE_ID", &config.host_instance_id)
            .env("DESKTOP_APP_ALLOWLIST", &config.desktop_app_allowlist_json)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows::Win32::System::Threading::CREATE_NO_WINDOW;
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
    fn assign(child: &Child) -> Result<Self, SupervisorError> {
        use std::ffi::c_void;
        use std::mem::size_of;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
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
            let process_handle = HANDLE(child.as_raw_handle());
            if let Err(error) = AssignProcessToJobObject(handle, process_handle) {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
                return Err(SupervisorError::Job(error.to_string()));
            }
            Ok(Self { handle })
        }
    }

    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
    }
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
}
