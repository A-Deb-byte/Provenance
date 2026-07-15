use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const OWNER_FILE: &str = "runtime-owner.json";
const MAX_OWNER_BYTES: u64 = 4 * 1024;
const MAX_ACQUIRE_ATTEMPTS: usize = 3;

#[derive(Debug, Error)]
pub enum RuntimeOwnershipError {
    #[error("runtime directory could not be created: {0}")]
    CreateDirectory(#[source] std::io::Error),
    #[error("runtime directory could not be canonicalized: {0}")]
    Canonicalize(#[source] std::io::Error),
    #[error("another desktop host already owns this runtime directory")]
    MutexAlreadyOwned,
    #[error("runtime owner file is held by live process {0}")]
    LiveOwner(u32),
    #[error("runtime owner file exists but is not a valid bounded ownership record")]
    InvalidOwner,
    #[error("runtime owner file could not be created exclusively: {0}")]
    CreateOwner(#[source] std::io::Error),
    #[error("runtime owner record could not be serialized")]
    SerializeOwner,
    #[error("runtime ownership could not be acquired after stale-owner recovery")]
    Contention,
    #[error("Windows runtime mutex failed: {0}")]
    WindowsMutex(String),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopOwnerRecord<'a> {
    schema_version: u8,
    mode: &'static str,
    proof_hash: &'a str,
    host_pid: u32,
    created_at: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExistingOwnerRecord {
    schema_version: u8,
    mode: String,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    proof_hash: Option<String>,
    #[serde(default)]
    host_pid: Option<u32>,
    #[serde(default)]
    pid: Option<u32>,
    created_at: String,
}

impl ExistingOwnerRecord {
    fn pid(&self) -> Option<u32> {
        self.host_pid.or(self.pid)
    }

    fn structurally_valid(&self) -> bool {
        self.schema_version == 1
            && matches!(self.mode.as_str(), "desktop-host" | "node-standalone")
            && (match self.mode.as_str() {
                "desktop-host" => {
                    self.host_pid.is_some_and(|pid| pid > 0)
                        && self.pid.is_none()
                        && self.nonce.is_none()
                        && self.proof_hash.as_ref().is_some_and(|value| {
                            value.len() == 64
                                && value.bytes().all(|byte| {
                                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                                })
                        })
                }
                "node-standalone" => {
                    self.pid.is_some_and(|pid| pid > 0)
                        && self.host_pid.is_none()
                        && self.proof_hash.is_none()
                        && self
                            .nonce
                            .as_ref()
                            .is_some_and(|value| value.len() >= 32 && value.is_ascii())
                }
                _ => false,
            })
            && OffsetDateTime::parse(&self.created_at, &Rfc3339).is_ok()
    }
}

pub struct RuntimeOwnership {
    runtime_dir: PathBuf,
    owner_path: PathBuf,
    nonce: String,
    _mutex: PlatformMutex,
}

impl RuntimeOwnership {
    pub fn acquire(runtime_dir: &Path) -> Result<Self, RuntimeOwnershipError> {
        std::fs::create_dir_all(runtime_dir).map_err(RuntimeOwnershipError::CreateDirectory)?;
        let runtime_dir =
            std::fs::canonicalize(runtime_dir).map_err(RuntimeOwnershipError::Canonicalize)?;
        let mutex = PlatformMutex::acquire(&runtime_dir)?;
        let owner_path = runtime_dir.join(OWNER_FILE);

        let nonce = random_nonce();
        let created_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|_| RuntimeOwnershipError::SerializeOwner)?;
        let proof_hash = hex::encode(Sha256::digest(nonce.as_bytes()));
        let record = DesktopOwnerRecord {
            schema_version: 1,
            mode: "desktop-host",
            proof_hash: &proof_hash,
            host_pid: std::process::id(),
            created_at: &created_at,
        };
        let payload =
            serde_json::to_vec(&record).map_err(|_| RuntimeOwnershipError::SerializeOwner)?;
        for _ in 0..MAX_ACQUIRE_ATTEMPTS {
            match publish_owner_atomically(&runtime_dir, &owner_path, &payload) {
                Ok(()) => {
                    return Ok(Self {
                        runtime_dir,
                        owner_path,
                        nonce,
                        _mutex: mutex,
                    });
                }
                Err(PublishOwnerError::AlreadyExists) => {
                    // A complete record is the only state another process can
                    // observe at the authoritative path. Invalid records are
                    // never reclaimed because their ownership cannot be
                    // authenticated safely.
                    let existing = read_existing_owner(&owner_path)?;
                    let pid = existing.pid().unwrap_or_default();
                    if process_is_alive(pid) {
                        return Err(RuntimeOwnershipError::LiveOwner(pid));
                    }
                    std::fs::remove_file(&owner_path)
                        .map_err(RuntimeOwnershipError::CreateOwner)?;
                }
                Err(PublishOwnerError::Io(error)) => {
                    return Err(RuntimeOwnershipError::CreateOwner(error));
                }
            }
        }
        Err(RuntimeOwnershipError::Contention)
    }

    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    pub fn nonce(&self) -> &str {
        &self.nonce
    }
}

impl Drop for RuntimeOwnership {
    fn drop(&mut self) {
        let owned = read_existing_owner(&self.owner_path).is_ok_and(|record| {
            record.mode == "desktop-host"
                && record.proof_hash.as_deref()
                    == Some(hex::encode(Sha256::digest(self.nonce.as_bytes())).as_str())
                && record.host_pid == Some(std::process::id())
        });
        if owned {
            let _ = std::fs::remove_file(&self.owner_path);
        }
    }
}

fn create_owner_file(path: &Path) -> Result<File, RuntimeOwnershipError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(RuntimeOwnershipError::CreateOwner)
}

#[derive(Debug)]
enum PublishOwnerError {
    AlreadyExists,
    Io(std::io::Error),
}

fn publish_owner_atomically(
    runtime_dir: &Path,
    owner_path: &Path,
    payload: &[u8],
) -> Result<(), PublishOwnerError> {
    let temporary_path = runtime_dir.join(format!(
        ".runtime-owner-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let mut temporary = create_owner_file(&temporary_path).map_err(|error| match error {
        RuntimeOwnershipError::CreateOwner(source) => PublishOwnerError::Io(source),
        other => PublishOwnerError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            other.to_string(),
        )),
    })?;
    if let Err(error) = temporary
        .write_all(payload)
        .and_then(|_| temporary.sync_all())
    {
        drop(temporary);
        let _ = std::fs::remove_file(&temporary_path);
        return Err(PublishOwnerError::Io(error));
    }
    drop(temporary);

    match std::fs::hard_link(&temporary_path, owner_path) {
        Ok(()) => {
            if let Err(error) = std::fs::remove_file(&temporary_path) {
                let _ = std::fs::remove_file(owner_path);
                return Err(PublishOwnerError::Io(error));
            }
            // Directory synchronization is supported on Unix but not on all
            // Windows filesystems. The linked file itself was already synced.
            let _ = File::open(runtime_dir).and_then(|directory| directory.sync_all());
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temporary_path);
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Err(PublishOwnerError::AlreadyExists)
            } else {
                Err(PublishOwnerError::Io(error))
            }
        }
    }
}

fn read_existing_owner(path: &Path) -> Result<ExistingOwnerRecord, RuntimeOwnershipError> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| RuntimeOwnershipError::InvalidOwner)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_OWNER_BYTES {
        return Err(RuntimeOwnershipError::InvalidOwner);
    }
    let mut content = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|mut file| file.take(MAX_OWNER_BYTES + 1).read_to_end(&mut content))
        .map_err(|_| RuntimeOwnershipError::InvalidOwner)?;
    if content.len() as u64 > MAX_OWNER_BYTES {
        return Err(RuntimeOwnershipError::InvalidOwner);
    }
    let record: ExistingOwnerRecord =
        serde_json::from_slice(&content).map_err(|_| RuntimeOwnershipError::InvalidOwner)?;
    if !record.structurally_valid() {
        return Err(RuntimeOwnershipError::InvalidOwner);
    }
    Ok(record)
}

fn random_nonce() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut exit_code = 0_u32;
        let alive = GetExitCodeProcess(handle, &mut exit_code).is_ok() && exit_code == 259;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(not(windows))]
fn process_is_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(windows)]
struct PlatformMutex {
    handle: windows::Win32::Foundation::HANDLE,
}

// The handle is process-owned, never waited on through this wrapper, and is
// closed exactly once. Moving ownership into Tauri managed state is safe.
#[cfg(windows)]
unsafe impl Send for PlatformMutex {}

#[cfg(windows)]
impl PlatformMutex {
    fn acquire(runtime_dir: &Path) -> Result<Self, RuntimeOwnershipError> {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
        use windows::Win32::System::Threading::CreateMutexW;

        let digest = hex::encode(Sha256::digest(
            runtime_dir.to_string_lossy().to_lowercase().as_bytes(),
        ));
        let name = format!("Local\\Provenance.Runtime.{}", &digest[..32]);
        let wide: Vec<u16> = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let handle = CreateMutexW(None, false, PCWSTR(wide.as_ptr()))
                .map_err(|error| RuntimeOwnershipError::WindowsMutex(error.to_string()))?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(handle);
                return Err(RuntimeOwnershipError::MutexAlreadyOwned);
            }
            Ok(Self { handle })
        }
    }
}

#[cfg(windows)]
impl Drop for PlatformMutex {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
struct PlatformMutex;

#[cfg(not(windows))]
impl PlatformMutex {
    fn acquire(_runtime_dir: &Path) -> Result<Self, RuntimeOwnershipError> {
        Ok(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_record_accepts_both_supported_parent_modes() {
        for json in [
            r#"{"schemaVersion":1,"mode":"desktop-host","proofHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","hostPid":42,"createdAt":"2026-07-15T00:00:00Z"}"#,
            r#"{"schemaVersion":1,"mode":"node-standalone","nonce":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pid":42,"createdAt":"2026-07-15T00:00:00Z"}"#,
        ] {
            let record: ExistingOwnerRecord = serde_json::from_str(json).unwrap();
            assert!(record.structurally_valid());
        }
    }

    #[test]
    fn owner_record_rejects_short_nonces_and_unknown_modes() {
        let record: ExistingOwnerRecord = serde_json::from_str(
            r#"{"schemaVersion":1,"mode":"agent","nonce":"short","pid":42,"createdAt":"invalid"}"#,
        )
        .unwrap();
        assert!(!record.structurally_valid());
    }

    #[test]
    fn mutex_name_digest_is_stable_for_path_case() {
        let left = hex::encode(Sha256::digest(b"c:\\runtime"));
        let right = hex::encode(Sha256::digest("C:\\RUNTIME".to_lowercase().as_bytes()));
        assert_eq!(left, right);
    }

    #[test]
    fn owner_record_requires_valid_timestamp_and_mode_specific_pid() {
        for json in [
            r#"{"schemaVersion":1,"mode":"desktop-host","proofHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","hostPid":42,"createdAt":"not-a-date"}"#,
            r#"{"schemaVersion":1,"mode":"desktop-host","proofHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pid":42,"createdAt":"2026-07-15T00:00:00Z"}"#,
            r#"{"schemaVersion":1,"mode":"node-standalone","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pid":42,"hostPid":43,"createdAt":"2026-07-15T00:00:00Z"}"#,
        ] {
            let record: ExistingOwnerRecord = serde_json::from_str(json).unwrap();
            assert!(!record.structurally_valid());
        }
    }

    fn temporary_test_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "provenance-native-owner-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn atomic_publish_never_replaces_a_partial_authoritative_record() {
        let runtime_dir = temporary_test_directory("partial");
        let owner_path = runtime_dir.join(OWNER_FILE);
        let partial = br#"{"schemaVersion":1"#;
        std::fs::write(&owner_path, partial).unwrap();

        let result = publish_owner_atomically(&runtime_dir, &owner_path, br#"{"complete":true}"#);
        assert!(matches!(result, Err(PublishOwnerError::AlreadyExists)));
        assert_eq!(std::fs::read(&owner_path).unwrap(), partial);
        assert!(matches!(
            read_existing_owner(&owner_path),
            Err(RuntimeOwnershipError::InvalidOwner)
        ));
        std::fs::remove_dir_all(runtime_dir).unwrap();
    }

    #[test]
    fn contending_atomic_publishers_produce_one_complete_record() {
        use std::sync::{Arc, Barrier};

        let runtime_dir = temporary_test_directory("contention");
        let owner_path = runtime_dir.join(OWNER_FILE);
        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for index in 0..8 {
            let runtime_dir = runtime_dir.clone();
            let owner_path = owner_path.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                let payload = format!(r#"{{"publisher":{index}}}"#);
                barrier.wait();
                (
                    payload.clone(),
                    publish_owner_atomically(&runtime_dir, &owner_path, payload.as_bytes()),
                )
            }));
        }
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            results.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|(_, result)| matches!(result, Err(PublishOwnerError::AlreadyExists)))
                .count(),
            7
        );
        let published = std::fs::read(&owner_path).unwrap();
        assert!(results
            .iter()
            .any(|(payload, _)| payload.as_bytes() == published));
        assert_eq!(
            std::fs::read_dir(&runtime_dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        std::fs::remove_dir_all(runtime_dir).unwrap();
    }
}
