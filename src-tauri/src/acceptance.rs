use crate::bridge::BridgeServer;
use crate::resources::DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL;
use crate::supervisor::NodeSupervisor;
use crate::uia::UiaBroker;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

const ACCEPTANCE_NONCE_ENV: &str = "PROVENANCE_NATIVE_ACCEPTANCE_NONCE";
const ACCEPTANCE_IDENTIFIER_ENV: &str = "PROVENANCE_NATIVE_ACCEPTANCE_IDENTIFIER";
const MAX_ATTESTATION_BYTES: usize = 8 * 1024;
const MAX_MOUNT_REQUEST_BYTES: usize = 2 * 1024;
const MOUNT_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(30);
const ATTESTATION_TYPE: &str = "native.acceptance.ready";
const PUBLISH_ATTEMPTS: usize = 40;
const PUBLISH_RETRY_DELAY: Duration = Duration::from_millis(250);
const SUPPORTED_IDENTIFIERS: [&str; 3] = [
    "dev.provenance.desktop.development",
    "dev.provenance.desktop",
    "dev.provenance.desktop.pilot",
];

#[derive(Debug, Error)]
pub enum AcceptanceError {
    #[error("the native acceptance nonce must be a 32-byte base64url value")]
    InvalidNonce,
    #[error("native acceptance requires an exact supported application identifier")]
    InvalidIdentifier,
    #[error("native acceptance nonce and identifier must be configured together")]
    IncompleteConfiguration,
    #[error("native acceptance state is unavailable")]
    State,
    #[error("native acceptance attestation could not be written: {0}")]
    Io(#[from] std::io::Error),
    #[error("native acceptance attestation could not be encoded")]
    Encoding,
}

#[derive(Clone)]
pub struct NativeAcceptance {
    inner: Arc<AcceptanceInner>,
}

struct AcceptanceInner {
    nonce: Option<String>,
    expected_identifier: Option<String>,
    state: Mutex<AcceptanceState>,
    published_path: Mutex<Option<PathBuf>>,
    clean_shutdown: AtomicBool,
}

#[derive(Default)]
struct AcceptanceState {
    initialized: Option<AcceptanceEvidence>,
    loaded_url: Option<String>,
    page_generation: u64,
    loaded_generation: Option<u64>,
    mount_verified: Option<Arc<AtomicBool>>,
    publishing: bool,
}

pub struct FrontendMountChallenge {
    pub(crate) token: String,
    pub(crate) endpoint: String,
    pub(crate) origin: String,
    listener: Mutex<Option<TcpListener>>,
    verified: Arc<AtomicBool>,
    acceptance: NativeAcceptance,
}

impl FrontendMountChallenge {
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn bind_expected_origin(&self, expected_origin: &str) -> Result<(), AcceptanceError> {
        if !is_exact_loopback_origin(expected_origin) {
            return Err(AcceptanceError::State);
        }
        let listener = self
            .listener
            .lock()
            .map_err(|_| AcceptanceError::State)?
            .take()
            .ok_or(AcceptanceError::State)?;
        let expected_origin = expected_origin.to_owned();
        let expected_token = self.token.clone();
        let verified = Arc::clone(&self.verified);
        let acceptance = self.acceptance.clone();
        std::thread::Builder::new()
            .name("provenance-acceptance-mount".into())
            .spawn(move || {
                if run_mount_challenge(listener, &expected_origin, &expected_token) {
                    verified.store(true, Ordering::Release);
                    if let Err(error) = acceptance.try_publish() {
                        eprintln!(
                            "[Acceptance] Frontend mount completed but readiness could not be published: {error}"
                        );
                    }
                }
            })?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct AcceptanceEvidence {
    pub runtime_directory: PathBuf,
    pub expected_origin: String,
    pub application_identifier: String,
    pub host_instance_id: String,
    pub build_version: String,
    pub packaged_release: bool,
    pub resource_manifest_sha256: String,
    pub monitor_started: bool,
    pub supervisor: Weak<Mutex<NodeSupervisor>>,
    pub bridge: Weak<BridgeServer>,
    pub desktop: Weak<UiaBroker>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptanceComponents {
    runtime_ownership: bool,
    uia_healthy: bool,
    bridge_authenticated: bool,
    node_ready: bool,
    kernel_ready: bool,
    scheduler_disabled: bool,
    updater_suppressed: bool,
    exact_origin_navigation: bool,
    dashboard_mounted: bool,
    monitor_started: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptanceRecord {
    schema_version: u8,
    r#type: &'static str,
    nonce_digest: String,
    application_identifier: String,
    host_pid: u32,
    node_pid: u32,
    node_port: u16,
    host_instance_id: String,
    build_version: String,
    packaged_release: bool,
    resource_manifest_sha256: String,
    access_mode: String,
    desktop_authority: String,
    issued_at_ms: u128,
    components: AcceptanceComponents,
    proof: String,
}

struct AcceptanceSigningInput<'a> {
    nonce_digest: &'a str,
    application_identifier: &'a str,
    host_pid: u32,
    node_pid: u32,
    node_port: u16,
    host_instance_id: &'a str,
    build_version: &'a str,
    packaged_release: bool,
    resource_manifest_sha256: &'a str,
    access_mode: &'a str,
    desktop_authority: &'a str,
    issued_at_ms: u128,
}

impl NativeAcceptance {
    pub fn from_environment() -> Result<Self, AcceptanceError> {
        let nonce = std::env::var(ACCEPTANCE_NONCE_ENV).ok();
        let expected_identifier = std::env::var(ACCEPTANCE_IDENTIFIER_ENV).ok();
        if nonce.is_some() != expected_identifier.is_some() {
            return Err(AcceptanceError::IncompleteConfiguration);
        }
        if let Some(value) = nonce.as_deref() {
            if !is_valid_nonce(value) {
                return Err(AcceptanceError::InvalidNonce);
            }
        }
        if let Some(value) = expected_identifier.as_deref() {
            if !is_supported_identifier(value) {
                return Err(AcceptanceError::InvalidIdentifier);
            }
        }
        Ok(Self {
            inner: Arc::new(AcceptanceInner {
                nonce,
                expected_identifier,
                state: Mutex::new(AcceptanceState::default()),
                published_path: Mutex::new(None),
                clean_shutdown: AtomicBool::new(false),
            }),
        })
    }

    pub fn enabled(&self) -> bool {
        self.inner.nonce.is_some()
    }

    pub fn validate_identifier(&self, actual: &str) -> Result<(), AcceptanceError> {
        let Some(expected) = self.inner.expected_identifier.as_deref() else {
            return Ok(());
        };
        if expected != actual || !is_supported_identifier(actual) {
            return Err(AcceptanceError::InvalidIdentifier);
        }
        Ok(())
    }

    pub fn prepare_frontend_mount(
        &self,
        host_instance_id: &str,
    ) -> Result<Option<FrontendMountChallenge>, AcceptanceError> {
        let (Some(nonce), Some(identifier)) = (
            self.inner.nonce.as_deref(),
            self.inner.expected_identifier.as_deref(),
        ) else {
            return Ok(None);
        };
        let token = derive_frontend_mount_token(nonce, identifier, host_instance_id)?;
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let origin = format!("http://127.0.0.1:{port}");
        let verified = Arc::new(AtomicBool::new(false));
        {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| AcceptanceError::State)?;
            if state.mount_verified.is_some() {
                return Err(AcceptanceError::State);
            }
            state.mount_verified = Some(Arc::clone(&verified));
        }
        Ok(Some(FrontendMountChallenge {
            token,
            endpoint: format!("{origin}/__provenance/native/mounted"),
            origin,
            listener: Mutex::new(Some(listener)),
            verified,
            acceptance: self.clone(),
        }))
    }

    pub fn mark_initialized(&self, evidence: AcceptanceEvidence) -> Result<(), AcceptanceError> {
        if !self.enabled() {
            return Ok(());
        }
        self.validate_identifier(&evidence.application_identifier)?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| AcceptanceError::State)?;
        state.initialized = Some(evidence);
        drop(state);
        self.try_publish()
    }

    pub fn mark_page_navigation_started(&self, label: &str) -> Result<(), AcceptanceError> {
        if !self.enabled() || label != "main" {
            return Ok(());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| AcceptanceError::State)?;
        state.page_generation = state
            .page_generation
            .checked_add(1)
            .ok_or(AcceptanceError::State)?;
        state.loaded_url = None;
        state.loaded_generation = None;
        drop(state);
        self.inner.remove_published_attestation();
        Ok(())
    }

    pub fn mark_page_loaded(&self, label: &str, url: &tauri::Url) -> Result<(), AcceptanceError> {
        if !self.enabled() || label != "main" {
            return Ok(());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| AcceptanceError::State)?;
        state.loaded_url = Some(url.as_str().to_owned());
        state.loaded_generation = Some(state.page_generation);
        drop(state);
        self.try_publish()
    }

    pub fn mark_shutdown_result(&self, clean: bool) {
        if self.enabled() {
            self.inner.clean_shutdown.store(clean, Ordering::Release);
            if clean {
                self.inner.remove_published_attestation();
            }
        }
    }

    fn try_publish(&self) -> Result<(), AcceptanceError> {
        let (nonce, evidence, page_generation) = {
            let Some(nonce) = self.inner.nonce.clone() else {
                return Ok(());
            };
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| AcceptanceError::State)?;
            let Some(evidence) = state.initialized.clone() else {
                return Ok(());
            };
            let mount_verified = state
                .mount_verified
                .as_ref()
                .is_some_and(|verified| verified.load(Ordering::Acquire));
            if state.publishing
                || !mount_verified
                || !page_matches(
                    &state,
                    evidence.expected_origin.as_str(),
                    state.page_generation,
                )
            {
                return Ok(());
            }
            state.publishing = true;
            (nonce, evidence, state.page_generation)
        };

        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            let mut last_error = None;
            for attempt in 0..PUBLISH_ATTEMPTS {
                match publish_attestation(&inner, &nonce, &evidence, page_generation) {
                    Ok(()) => return,
                    Err(error) => last_error = Some(error),
                }
                if attempt + 1 < PUBLISH_ATTEMPTS {
                    std::thread::sleep(PUBLISH_RETRY_DELAY);
                }
            }
            if let Ok(mut state) = inner.state.lock() {
                state.publishing = false;
            }
            if let Some(error) = last_error {
                eprintln!("[Acceptance] Full native readiness was not attested: {error}");
            }
        });
        Ok(())
    }
}

fn is_valid_nonce(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_supported_identifier(value: &str) -> bool {
    SUPPORTED_IDENTIFIERS.contains(&value)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

fn is_exact_dashboard_url(value: &str, expected_origin: &str) -> bool {
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    url.origin().ascii_serialization() == expected_origin
        && url.path() == "/"
        && url.query().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn page_matches(state: &AcceptanceState, expected_origin: &str, expected_generation: u64) -> bool {
    state.page_generation == expected_generation
        && state.loaded_generation == Some(expected_generation)
        && state
            .loaded_url
            .as_deref()
            .is_some_and(|url| is_exact_dashboard_url(url, expected_origin))
}

fn derive_frontend_mount_token(
    nonce: &str,
    identifier: &str,
    host_instance_id: &str,
) -> Result<String, AcceptanceError> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(nonce.as_bytes()).map_err(|_| AcceptanceError::State)?;
    mac.update(b"native-acceptance-mount\n");
    mac.update(identifier.as_bytes());
    mac.update(b"\n");
    mac.update(host_instance_id.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

impl Drop for AcceptanceInner {
    fn drop(&mut self) {
        if !self.clean_shutdown.load(Ordering::Acquire) {
            return;
        }
        if let Ok(path) = self.published_path.get_mut() {
            remove_published_path(path);
        }
    }
}

impl AcceptanceInner {
    fn remove_published_attestation(&self) {
        if let Ok(mut path) = self.published_path.lock() {
            remove_published_path(&mut path);
        }
    }
}

fn remove_published_path(path: &mut Option<PathBuf>) {
    if let Some(path) = path.take() {
        let _ = std::fs::remove_file(path);
    }
}

fn publish_attestation(
    inner: &AcceptanceInner,
    nonce: &str,
    evidence: &AcceptanceEvidence,
    page_generation: u64,
) -> Result<(), AcceptanceError> {
    if inner
        .published_path
        .lock()
        .map_err(|_| AcceptanceError::State)?
        .is_some()
    {
        return Ok(());
    }
    let expected_identifier = inner
        .expected_identifier
        .as_deref()
        .ok_or(AcceptanceError::State)?;
    if evidence.application_identifier != expected_identifier || !evidence.monitor_started {
        return Err(AcceptanceError::State);
    }
    {
        let state = inner.state.lock().map_err(|_| AcceptanceError::State)?;
        let mount_verified = state
            .mount_verified
            .as_ref()
            .is_some_and(|verified| verified.load(Ordering::Acquire));
        if !mount_verified
            || !page_matches(&state, evidence.expected_origin.as_str(), page_generation)
        {
            return Err(AcceptanceError::State);
        }
    }
    let supervisor = evidence
        .supervisor
        .upgrade()
        .ok_or(AcceptanceError::State)?;
    let bridge = evidence.bridge.upgrade().ok_or(AcceptanceError::State)?;
    let desktop = evidence.desktop.upgrade().ok_or(AcceptanceError::State)?;
    let (node_running, node_pid, node_port, access_mode, desktop_authority, scheduler_enabled) = {
        let mut supervisor = supervisor.lock().map_err(|_| AcceptanceError::State)?;
        (
            supervisor.is_running(),
            supervisor.child_pid(),
            supervisor.node_port(),
            supervisor.access_mode().to_owned(),
            supervisor.desktop_status().to_owned(),
            supervisor.scheduler_enabled(),
        )
    };
    if !node_running
        || !bridge.is_running()
        || !desktop.is_healthy()
        || scheduler_enabled
        || access_mode != "multi_user"
        || desktop_authority != "available"
        || evidence.expected_origin != format!("http://127.0.0.1:{node_port}")
        || (evidence.packaged_release && !is_sha256(&evidence.resource_manifest_sha256))
        || (!evidence.packaged_release
            && evidence.resource_manifest_sha256 != DEVELOPMENT_RESOURCE_MANIFEST_SENTINEL)
    {
        return Err(AcceptanceError::State);
    }

    let runtime_directory = std::fs::canonicalize(&evidence.runtime_directory)?;
    if !runtime_directory.is_dir() {
        return Err(AcceptanceError::State);
    }
    let nonce_digest = hex::encode(Sha256::digest(nonce.as_bytes()));
    let host_pid = std::process::id();
    let issued_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AcceptanceError::State)?
        .as_millis();
    let components = AcceptanceComponents {
        runtime_ownership: true,
        uia_healthy: true,
        bridge_authenticated: true,
        node_ready: true,
        kernel_ready: true,
        scheduler_disabled: true,
        updater_suppressed: true,
        exact_origin_navigation: true,
        dashboard_mounted: true,
        monitor_started: true,
    };
    let signing_payload = signing_payload(&AcceptanceSigningInput {
        nonce_digest: &nonce_digest,
        application_identifier: &evidence.application_identifier,
        host_pid,
        node_pid,
        node_port,
        host_instance_id: &evidence.host_instance_id,
        build_version: &evidence.build_version,
        packaged_release: evidence.packaged_release,
        resource_manifest_sha256: &evidence.resource_manifest_sha256,
        access_mode: &access_mode,
        desktop_authority: &desktop_authority,
        issued_at_ms,
    });
    let mut mac =
        Hmac::<Sha256>::new_from_slice(nonce.as_bytes()).map_err(|_| AcceptanceError::State)?;
    mac.update(signing_payload.as_bytes());
    let proof = hex::encode(mac.finalize().into_bytes());
    let record = AcceptanceRecord {
        schema_version: 3,
        r#type: ATTESTATION_TYPE,
        nonce_digest: nonce_digest.clone(),
        application_identifier: evidence.application_identifier.clone(),
        host_pid,
        node_pid,
        node_port,
        host_instance_id: evidence.host_instance_id.clone(),
        build_version: evidence.build_version.clone(),
        packaged_release: evidence.packaged_release,
        resource_manifest_sha256: evidence.resource_manifest_sha256.clone(),
        access_mode,
        desktop_authority,
        issued_at_ms,
        components,
        proof,
    };
    let encoded = serde_json::to_vec(&record).map_err(|_| AcceptanceError::Encoding)?;
    if encoded.len() > MAX_ATTESTATION_BYTES {
        return Err(AcceptanceError::Encoding);
    }
    // Keep the page-state lock through publication. The navigation guard must
    // acquire this lock before allowing another main-window navigation, so the
    // mounted page cannot change between this final check and the atomic write.
    let state = inner.state.lock().map_err(|_| AcceptanceError::State)?;
    if !page_matches(&state, evidence.expected_origin.as_str(), page_generation) {
        return Err(AcceptanceError::State);
    }
    publish_record(inner, &runtime_directory, &nonce_digest, host_pid, &encoded)
}

fn run_mount_challenge(listener: TcpListener, expected_origin: &str, expected_token: &str) -> bool {
    let expected_host = match listener.local_addr() {
        Ok(address) => format!("127.0.0.1:{}", address.port()),
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + MOUNT_CHALLENGE_TIMEOUT;
    loop {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                let accepted = peer.ip().is_loopback()
                    && verify_mount_request(
                        &mut stream,
                        &expected_host,
                        expected_origin,
                        expected_token,
                        deadline.saturating_duration_since(std::time::Instant::now()),
                    );
                let status = if accepted {
                    "204 No Content"
                } else {
                    "404 Not Found"
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nAccess-Control-Allow-Origin: {expected_origin}\r\nVary: Origin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let response_written = stream.write_all(response.as_bytes()).is_ok();
                if accepted && response_written {
                    return true;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return false,
        }
    }
}

fn verify_mount_request(
    stream: &mut TcpStream,
    expected_host: &str,
    expected_origin: &str,
    expected_token: &str,
    remaining: Duration,
) -> bool {
    let request_timeout = std::cmp::min(Duration::from_secs(2), remaining);
    if request_timeout.is_zero() {
        return false;
    }
    if stream.set_read_timeout(Some(request_timeout)).is_err()
        || stream.set_write_timeout(Some(request_timeout)).is_err()
    {
        return false;
    }
    let mut request = Vec::with_capacity(512);
    let mut buffer = [0_u8; 512];
    let (header_end, content_length) = loop {
        if request.len() >= MAX_MOUNT_REQUEST_BYTES {
            return false;
        }
        let read = match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return false,
            Ok(read) => read,
        };
        request.extend_from_slice(&buffer[..read]);
        let Some(header_end) = request.windows(4).position(|value| value == b"\r\n\r\n") else {
            continue;
        };
        let header_end = header_end + 4;
        let Ok(headers) = std::str::from_utf8(&request[..header_end]) else {
            return false;
        };
        let Some(content_length) = validate_mount_headers(
            headers,
            expected_host,
            expected_origin,
            expected_token.len(),
        ) else {
            return false;
        };
        if request.len() >= header_end + content_length {
            break (header_end, content_length);
        }
    };
    request.len() == header_end + content_length
        && request[header_end..] == *expected_token.as_bytes()
}

fn validate_mount_headers(
    headers: &str,
    expected_host: &str,
    expected_origin: &str,
    expected_content_length: usize,
) -> Option<usize> {
    let mut lines = headers.split("\r\n");
    if lines.next()? != "POST /__provenance/native/mounted HTTP/1.1" {
        return None;
    }
    let mut host = None;
    let mut origin = None;
    let mut content_length = None;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "host" if host.replace(value).is_some() => return None,
            "origin" if origin.replace(value).is_some() => return None,
            "content-length" if content_length.replace(value).is_some() => return None,
            _ => {}
        }
    }
    let content_length = content_length?.parse::<usize>().ok()?;
    (host == Some(expected_host)
        && origin == Some(expected_origin)
        && content_length == expected_content_length)
        .then_some(content_length)
}

fn publish_record(
    inner: &AcceptanceInner,
    runtime_directory: &std::path::Path,
    nonce_digest: &str,
    host_pid: u32,
    encoded: &[u8],
) -> Result<(), AcceptanceError> {
    let path = runtime_directory.join(format!(".native-acceptance-{}.json", &nonce_digest[..32]));
    let temporary = runtime_directory.join(format!(
        ".native-acceptance-{}-{host_pid}.tmp",
        &nonce_digest[..32]
    ));
    if path.exists() || temporary.exists() {
        return Err(AcceptanceError::State);
    }
    let write_result = (|| -> Result<(), AcceptanceError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(encoded)?;
        file.sync_all()?;
        drop(file);
        std::fs::hard_link(&temporary, &path)?;
        std::fs::remove_file(&temporary)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    let mut published = inner
        .published_path
        .lock()
        .map_err(|_| AcceptanceError::State)?;
    *published = Some(path);
    if inner.clean_shutdown.load(Ordering::Acquire) {
        remove_published_path(&mut published);
    }
    Ok(())
}

fn signing_payload(input: &AcceptanceSigningInput<'_>) -> String {
    [
        "schemaVersion=3".to_owned(),
        format!("type={ATTESTATION_TYPE}"),
        format!("nonceDigest={}", input.nonce_digest),
        format!("applicationIdentifier={}", input.application_identifier),
        format!("hostPid={}", input.host_pid),
        format!("nodePid={}", input.node_pid),
        format!("nodePort={}", input.node_port),
        format!("hostInstanceId={}", input.host_instance_id),
        format!("buildVersion={}", input.build_version),
        format!("packagedRelease={}", input.packaged_release),
        format!("resourceManifestSha256={}", input.resource_manifest_sha256),
        format!("accessMode={}", input.access_mode),
        format!("desktopAuthority={}", input.desktop_authority),
        format!("issuedAtMs={}", input.issued_at_ms),
        "runtimeOwnership=true".to_owned(),
        "uiaHealthy=true".to_owned(),
        "bridgeAuthenticated=true".to_owned(),
        "nodeReady=true".to_owned(),
        "kernelReady=true".to_owned(),
        "schedulerDisabled=true".to_owned(),
        "updaterSuppressed=true".to_owned(),
        "exactOriginNavigation=true".to_owned(),
        "dashboardMounted=true".to_owned(),
        "monitorStarted=true".to_owned(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_payload_is_fixed_order_and_does_not_include_the_nonce() {
        let payload = signing_payload(&AcceptanceSigningInput {
            nonce_digest: "digest",
            application_identifier: "dev.provenance.desktop",
            host_pid: 10,
            node_pid: 11,
            node_port: 43123,
            host_instance_id: "desktop-host-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            build_version: "1.2.3",
            packaged_release: true,
            resource_manifest_sha256:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            access_mode: "multi_user",
            desktop_authority: "available",
            issued_at_ms: 12,
        });
        assert!(payload.starts_with(
            "schemaVersion=3\ntype=native.acceptance.ready\nnonceDigest=digest\napplicationIdentifier=dev.provenance.desktop\n"
        ));
        assert!(payload.contains("hostPid=10\nnodePid=11\nnodePort=43123"));
        assert!(payload.contains(
            "resourceManifestSha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(payload.ends_with("monitorStarted=true"));
        assert!(!payload.contains("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"));
    }

    #[test]
    fn acceptance_nonce_is_exact_base64url_without_padding() {
        assert!(is_valid_nonce(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
        ));
        assert!(!is_valid_nonce("short"));
        assert!(!is_valid_nonce(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP="
        ));
    }

    #[test]
    fn only_isolated_application_identifiers_are_accepted() {
        assert!(is_supported_identifier(
            "dev.provenance.desktop.development"
        ));
        assert!(is_supported_identifier("dev.provenance.desktop.pilot"));
        assert!(is_supported_identifier("dev.provenance.desktop"));
        assert!(!is_supported_identifier("dev.provenance.desktop.attacker"));
    }

    #[test]
    fn frontend_mount_token_is_context_bound_and_fixed_width() {
        let nonce = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
        let first = derive_frontend_mount_token(
            nonce,
            "dev.provenance.desktop",
            "desktop-host-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let second = derive_frontend_mount_token(
            nonce,
            "dev.provenance.desktop.pilot",
            "desktop-host-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn mount_headers_require_exact_host_origin_and_body_length() {
        let headers = "POST /__provenance/native/mounted HTTP/1.1\r\nHost: 127.0.0.1:43123\r\nOrigin: http://127.0.0.1:3000\r\nContent-Length: 64\r\n\r\n";
        assert_eq!(
            validate_mount_headers(headers, "127.0.0.1:43123", "http://127.0.0.1:3000", 64),
            Some(64)
        );
        assert!(validate_mount_headers(
            &headers.replace("http://127.0.0.1:3000", "http://127.0.0.1:3001"),
            "127.0.0.1:43123",
            "http://127.0.0.1:3000",
            64
        )
        .is_none());
    }

    #[test]
    fn mount_origin_is_one_exact_ipv4_loopback_origin() {
        assert!(is_exact_loopback_origin("http://127.0.0.1:43123"));
        assert!(!is_exact_loopback_origin("http://localhost:43123"));
        assert!(!is_exact_loopback_origin("http://127.0.0.1:43123/path"));
        assert!(!is_exact_loopback_origin("http://127.0.0.1:43123?query"));
        assert!(!is_exact_loopback_origin("https://127.0.0.1:43123"));
    }

    #[test]
    fn dashboard_page_match_is_exact_and_generation_bound() {
        let mut state = AcceptanceState {
            loaded_url: Some("http://127.0.0.1:43123/#provenance-first-admin=secret".to_owned()),
            page_generation: 4,
            loaded_generation: Some(4),
            ..AcceptanceState::default()
        };
        assert!(page_matches(&state, "http://127.0.0.1:43123", 4));
        assert!(!page_matches(&state, "http://127.0.0.1:43123", 3));

        state.page_generation = 5;
        assert!(!page_matches(&state, "http://127.0.0.1:43123", 4));
        state.loaded_generation = Some(5);
        state.loaded_url = Some("http://127.0.0.1:43123/other".to_owned());
        assert!(!page_matches(&state, "http://127.0.0.1:43123", 5));
        state.loaded_url = Some("http://127.0.0.1:43123/?query=1".to_owned());
        assert!(!page_matches(&state, "http://127.0.0.1:43123", 5));
        state.loaded_url = Some("about:blank".to_owned());
        assert!(!page_matches(&state, "http://127.0.0.1:43123", 5));
    }

    #[test]
    fn mount_listener_ignores_an_invalid_request_before_the_valid_proof() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let expected_host = format!("127.0.0.1:{}", address.port());
        let expected_origin = "http://127.0.0.1:3000".to_owned();
        let expected_token = "a".repeat(64);
        let thread_origin = expected_origin.clone();
        let thread_token = expected_token.clone();
        let challenge = std::thread::spawn(move || {
            run_mount_challenge(listener, &thread_origin, &thread_token)
        });

        let send = |token: &str| {
            let mut stream = TcpStream::connect(address).unwrap();
            let request = format!(
                "POST /__provenance/native/mounted HTTP/1.1\r\nHost: {expected_host}\r\nOrigin: {expected_origin}\r\nContent-Length: {}\r\n\r\n{token}",
                token.len()
            );
            stream.write_all(request.as_bytes()).unwrap();
            stream.shutdown(std::net::Shutdown::Write).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        assert!(send(&"b".repeat(64)).starts_with("HTTP/1.1 404"));
        assert!(send(&expected_token).starts_with("HTTP/1.1 204"));
        assert!(challenge.join().unwrap());
    }
}
