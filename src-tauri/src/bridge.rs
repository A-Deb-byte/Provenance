use crate::contracts::{
    ActionEnvelope, ActionResponse, ActionResponseStatus, HealthResponse, BRIDGE_SCHEMA_VERSION,
    MAX_ACTION_BODY_BYTES,
};
use crate::uia::{DesktopExecutionError, DesktopExecutor};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

type HmacSha256 = Hmac<Sha256>;

const REQUEST_ID: &str = "x-provenance-request-id";
const ISSUED_AT: &str = "x-provenance-issued-at";
const EXPIRES_AT: &str = "x-provenance-expires-at";
const CONTENT_SHA256: &str = "x-provenance-content-sha256";
const REQUEST_SIGNATURE: &str = "x-provenance-signature";
const RESPONSE_SHA256: &str = "x-provenance-response-sha256";
const RESPONSE_SIGNATURE: &str = "x-provenance-response-signature";
const MAX_CLOCK_SKEW_MS: u64 = 30_000;
const MAX_REQUEST_TTL_MS: u64 = 30_000;
const MAX_REPLAY_ENTRIES: usize = 4_096;

#[derive(Clone)]
pub struct BridgeSecret(Arc<str>);

impl BridgeSecret {
    pub fn generate() -> Self {
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        Self(Arc::from(URL_SAFE_NO_PAD.encode(bytes)))
    }

    pub fn from_string(value: String) -> Result<Self, BridgeError> {
        if value.len() < 32 || !value.is_ascii() {
            return Err(BridgeError::WeakSecret);
        }
        Ok(Self(Arc::from(value)))
    }

    pub fn expose_to_supervised_child(&self) -> &str {
        &self.0
    }

    fn bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl fmt::Debug for BridgeSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BridgeSecret([redacted])")
    }
}

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("desktop bridge token must contain at least 32 ASCII characters")]
    WeakSecret,
    #[error("desktop bridge could not bind loopback: {0}")]
    Bind(#[from] std::io::Error),
}

#[derive(Clone)]
struct BridgeState {
    secret: BridgeSecret,
    host_instance_id: Arc<str>,
    desktop: Arc<dyn DesktopExecutor>,
    replay: Arc<Mutex<ReplayCache>>,
}

pub struct BridgeServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl BridgeServer {
    pub async fn start(
        secret: BridgeSecret,
        host_instance_id: String,
        desktop: Arc<dyn DesktopExecutor>,
    ) -> Result<Self, BridgeError> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let state = BridgeState {
            secret,
            host_instance_id: Arc::from(host_instance_id),
            desktop,
            replay: Arc::new(Mutex::new(ReplayCache::default())),
        };
        let router = Router::new()
            .route("/v1/health", get(health))
            .route("/v1/actions", post(action))
            .layer(DefaultBodyLimit::max(MAX_ACTION_BODY_BYTES))
            .with_state(state);
        let task = tokio::spawn(async move {
            let service = router.into_make_service_with_connect_info::<SocketAddr>();
            let _ = axum::serve(listener, service).await;
        });
        Ok(Self { address, task })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn health(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let request_id = response_request_id(&headers);
    if !peer.ip().is_loopback() {
        return signed_error(
            &state,
            &request_id,
            StatusCode::FORBIDDEN,
            "peer_not_loopback",
            "Desktop bridge requests are accepted only from loopback.",
        );
    }
    if let Err(error) = authenticate(&state, &Method::GET, "/v1/health", &headers, &[], now_ms()) {
        return signed_auth_error(&state, &request_id, error);
    }
    signed_json(
        &state,
        &request_id,
        StatusCode::OK,
        &HealthResponse {
            schema_version: BRIDGE_SCHEMA_VERSION,
            status: "ok",
            host_instance_id: state.host_instance_id.to_string(),
            platform: "windows",
            capabilities: vec![
                "desktop.discover".into(),
                "desktop.inspect".into(),
                "desktop.click".into(),
                "desktop.type".into(),
            ],
            allowed_app_ids: state.desktop.allowed_app_ids(),
        },
    )
}

async fn action(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = response_request_id(&headers);
    if !peer.ip().is_loopback() {
        return signed_error(
            &state,
            &request_id,
            StatusCode::FORBIDDEN,
            "peer_not_loopback",
            "Desktop bridge requests are accepted only from loopback.",
        );
    }
    if let Err(error) = authenticate(
        &state,
        &Method::POST,
        "/v1/actions",
        &headers,
        &body,
        now_ms(),
    ) {
        return signed_auth_error(&state, &request_id, error);
    }
    let envelope: ActionEnvelope = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return signed_error(
                &state,
                &request_id,
                StatusCode::BAD_REQUEST,
                "invalid_action_json",
                "Desktop action JSON failed strict schema validation.",
            )
        }
    };
    if let Err(error) = envelope.validate() {
        return signed_error(
            &state,
            &request_id,
            StatusCode::BAD_REQUEST,
            "invalid_action_contract",
            &error.to_string(),
        );
    }

    let source_ref = envelope.action.source_ref();
    let mutation = envelope.action.is_mutation();
    let executor = Arc::clone(&state.desktop);
    let execution = tokio::task::spawn_blocking(move || executor.execute(envelope)).await;
    match execution {
        Ok(Ok(output)) => signed_json(
            &state,
            &request_id,
            StatusCode::OK,
            &ActionResponse {
                schema_version: BRIDGE_SCHEMA_VERSION,
                status: ActionResponseStatus::Succeeded,
                source_ref,
                summary: output.summary,
                content: output.content,
                error_code: None,
            },
        ),
        Ok(Err(error)) => signed_execution_error(&state, &request_id, source_ref, error),
        Err(_) if mutation => signed_json(
            &state,
            &request_id,
            StatusCode::CONFLICT,
            &ActionResponse {
                schema_version: BRIDGE_SCHEMA_VERSION,
                status: ActionResponseStatus::Uncertain,
                source_ref,
                summary: "The desktop mutation may have completed, but the executor result was lost. Do not retry it automatically.".into(),
                content: None,
                error_code: Some("desktop_outcome_uncertain".into()),
            },
        ),
        Err(_) => signed_error(
            &state,
            &request_id,
            StatusCode::SERVICE_UNAVAILABLE,
            "desktop_executor_join_failed",
            "The bounded desktop executor did not return a trustworthy result.",
        ),
    }
}

fn signed_execution_error(
    state: &BridgeState,
    request_id: &str,
    source_ref: String,
    error: DesktopExecutionError,
) -> Response {
    signed_json(
        state,
        request_id,
        error.http_status(),
        &ActionResponse {
            schema_version: BRIDGE_SCHEMA_VERSION,
            status: if error == DesktopExecutionError::OutcomeUncertain {
                ActionResponseStatus::Uncertain
            } else {
                ActionResponseStatus::Failed
            },
            source_ref,
            summary: error.public_summary().to_string(),
            content: None,
            error_code: Some(error.code().to_string()),
        },
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthError {
    MissingHeader,
    InvalidRequestId,
    InvalidTimestamp,
    Expired,
    InvalidContentHash,
    InvalidSignature,
    Replay,
    ReplayCapacity,
}

fn authenticate(
    state: &BridgeState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    body: &[u8],
    now: u64,
) -> Result<String, AuthError> {
    let request_id = header(headers, REQUEST_ID)?;
    if !valid_request_id(request_id) {
        return Err(AuthError::InvalidRequestId);
    }
    let issued_at = header(headers, ISSUED_AT)?
        .parse::<u64>()
        .map_err(|_| AuthError::InvalidTimestamp)?;
    let expires_at = header(headers, EXPIRES_AT)?
        .parse::<u64>()
        .map_err(|_| AuthError::InvalidTimestamp)?;
    if issued_at > now.saturating_add(MAX_CLOCK_SKEW_MS)
        || now.saturating_sub(issued_at) > MAX_CLOCK_SKEW_MS
        || expires_at <= now
        || expires_at < issued_at
        || expires_at.saturating_sub(issued_at) > MAX_REQUEST_TTL_MS
    {
        return Err(AuthError::Expired);
    }

    let supplied_hash = header(headers, CONTENT_SHA256)?;
    let actual_hash = sha256_hex(body);
    if supplied_hash != actual_hash {
        return Err(AuthError::InvalidContentHash);
    }
    let signature = hex::decode(header(headers, REQUEST_SIGNATURE)?)
        .map_err(|_| AuthError::InvalidSignature)?;
    if signature.len() != 32 {
        return Err(AuthError::InvalidSignature);
    }
    let canonical = request_canonical(
        method.as_str(),
        path,
        request_id,
        issued_at,
        expires_at,
        supplied_hash,
    );
    let mut mac = HmacSha256::new_from_slice(state.secret.bytes())
        .map_err(|_| AuthError::InvalidSignature)?;
    mac.update(canonical.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| AuthError::InvalidSignature)?;

    let mut replay = state.replay.lock().map_err(|_| AuthError::ReplayCapacity)?;
    replay.consume(request_id, expires_at, now)?;
    Ok(request_id.to_string())
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, AuthError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or(AuthError::MissingHeader)
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

#[derive(Default)]
struct ReplayCache {
    entries: HashMap<String, u64>,
}

impl ReplayCache {
    fn consume(&mut self, request_id: &str, expires_at: u64, now: u64) -> Result<(), AuthError> {
        self.entries.retain(|_, expiry| *expiry > now);
        if self.entries.contains_key(request_id) {
            return Err(AuthError::Replay);
        }
        if self.entries.len() >= MAX_REPLAY_ENTRIES {
            return Err(AuthError::ReplayCapacity);
        }
        self.entries.insert(request_id.to_string(), expires_at);
        Ok(())
    }
}

fn signed_auth_error(state: &BridgeState, request_id: &str, error: AuthError) -> Response {
    let (status, code, summary) = match error {
        AuthError::Replay => (
            StatusCode::CONFLICT,
            "request_replayed",
            "The signed desktop request identifier has already been consumed.",
        ),
        AuthError::ReplayCapacity => (
            StatusCode::TOO_MANY_REQUESTS,
            "replay_cache_full",
            "The desktop replay-protection cache is at capacity.",
        ),
        AuthError::Expired | AuthError::InvalidTimestamp => (
            StatusCode::UNAUTHORIZED,
            "request_expired",
            "The signed desktop request is expired or outside the clock-skew bound.",
        ),
        _ => (
            StatusCode::UNAUTHORIZED,
            "request_authentication_failed",
            "The desktop request signature or authenticated body is invalid.",
        ),
    };
    signed_error(state, request_id, status, code, summary)
}

fn signed_error(
    state: &BridgeState,
    request_id: &str,
    status: StatusCode,
    code: &str,
    summary: &str,
) -> Response {
    signed_json(
        state,
        request_id,
        status,
        &ActionResponse {
            schema_version: BRIDGE_SCHEMA_VERSION,
            status: ActionResponseStatus::Failed,
            source_ref: "desktop:bridge".into(),
            summary: summary.into(),
            content: None,
            error_code: Some(code.into()),
        },
    )
}

fn signed_json<T: Serialize>(
    state: &BridgeState,
    request_id: &str,
    status: StatusCode,
    value: &T,
) -> Response {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| {
        br#"{"schemaVersion":1,"status":"failed","sourceRef":"desktop:bridge","summary":"Response serialization failed.","errorCode":"serialization_failed"}"#.to_vec()
    });
    let body_hash = sha256_hex(&body);
    let canonical = response_canonical(request_id, status.as_u16(), &body_hash);
    let signature = sign_hex(state.secret.bytes(), canonical.as_bytes());
    Response::builder()
        .status(status)
        .header("content-type", HeaderValue::from_static("application/json"))
        .header(RESPONSE_SHA256, body_hash)
        .header(RESPONSE_SIGNATURE, signature)
        .body(Body::from(body))
        .expect("static desktop bridge response headers are valid")
}

fn response_request_id(headers: &HeaderMap) -> String {
    headers
        .get(REQUEST_ID)
        .and_then(|value| value.to_str().ok())
        .filter(|value| valid_request_id(value))
        .unwrap_or("invalid-request")
        .to_string()
}

fn request_canonical(
    method: &str,
    path: &str,
    request_id: &str,
    issued_at: u64,
    expires_at: u64,
    content_hash: &str,
) -> String {
    format!("{method}\n{path}\n{request_id}\n{issued_at}\n{expires_at}\n{content_hash}")
}

fn response_canonical(request_id: &str, status: u16, body_hash: &str) -> String {
    format!("RESPONSE\n{request_id}\n{status}\n{body_hash}")
}

fn sign_hex(secret: &[u8], message: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts every key length");
    mac.update(message);
    hex::encode(mac.finalize().into_bytes())
}

fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::uia::{DesktopActionOutput, DesktopExecutor};

    struct UnusedExecutor;

    impl DesktopExecutor for UnusedExecutor {
        fn allowed_app_ids(&self) -> Vec<String> {
            Vec::new()
        }

        fn execute(
            &self,
            _envelope: ActionEnvelope,
        ) -> Result<DesktopActionOutput, DesktopExecutionError> {
            unreachable!()
        }
    }

    fn state() -> BridgeState {
        BridgeState {
            secret: BridgeSecret::from_string("s".repeat(43)).unwrap(),
            host_instance_id: Arc::from("host-test"),
            desktop: Arc::new(UnusedExecutor),
            replay: Arc::new(Mutex::new(ReplayCache::default())),
        }
    }

    fn headers(state: &BridgeState, body: &[u8], now: u64, request_id: &str) -> HeaderMap {
        let issued_at = now;
        let expires_at = now + 5_000;
        let content_hash = sha256_hex(body);
        let canonical = request_canonical(
            "POST",
            "/v1/actions",
            request_id,
            issued_at,
            expires_at,
            &content_hash,
        );
        let mut headers = HeaderMap::new();
        headers.insert(REQUEST_ID, request_id.parse().unwrap());
        headers.insert(ISSUED_AT, issued_at.to_string().parse().unwrap());
        headers.insert(EXPIRES_AT, expires_at.to_string().parse().unwrap());
        headers.insert(CONTENT_SHA256, content_hash.parse().unwrap());
        headers.insert(
            REQUEST_SIGNATURE,
            sign_hex(state.secret.bytes(), canonical.as_bytes())
                .parse()
                .unwrap(),
        );
        headers
    }

    #[test]
    fn authenticates_once_and_rejects_nonce_replay() {
        let state = state();
        let now = 1_000_000;
        let body = br#"{"schemaVersion":1}"#;
        let headers = headers(&state, body, now, "request-1");
        assert_eq!(
            authenticate(&state, &Method::POST, "/v1/actions", &headers, body, now),
            Ok("request-1".into())
        );
        assert_eq!(
            authenticate(&state, &Method::POST, "/v1/actions", &headers, body, now),
            Err(AuthError::Replay)
        );
    }

    #[test]
    fn authenticates_the_exact_method_path_and_body_hash() {
        let state = state();
        let now = 1_000_000;
        let body = b"trusted";
        let headers = headers(&state, body, now, "request-2");
        assert_eq!(
            authenticate(
                &state,
                &Method::POST,
                "/v1/actions",
                &headers,
                b"tampered",
                now
            ),
            Err(AuthError::InvalidContentHash)
        );

        let headers = headers(&state, body, now, "request-3");
        assert_eq!(
            authenticate(&state, &Method::GET, "/v1/actions", &headers, body, now),
            Err(AuthError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_requests_outside_the_thirty_second_window() {
        let state = state();
        let issued = 1_000_000;
        let headers = headers(&state, b"", issued, "request-4");
        assert_eq!(
            authenticate(
                &state,
                &Method::POST,
                "/v1/actions",
                &headers,
                b"",
                issued + 31_000
            ),
            Err(AuthError::Expired)
        );
    }

    #[test]
    fn response_signature_binds_request_status_and_body_hash() {
        let secret = BridgeSecret::from_string("s".repeat(43)).unwrap();
        let body_hash = sha256_hex(b"body");
        let canonical = response_canonical("request-5", 200, &body_hash);
        let signature = sign_hex(secret.bytes(), canonical.as_bytes());
        assert_eq!(signature.len(), 64);
        assert_ne!(
            signature,
            sign_hex(
                secret.bytes(),
                response_canonical("request-5", 500, &body_hash).as_bytes()
            )
        );
    }
}
