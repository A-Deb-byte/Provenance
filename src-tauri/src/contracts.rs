use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const BRIDGE_SCHEMA_VERSION: u8 = 1;
pub const MAX_APP_ID_CHARS: usize = 64;
pub const MAX_ALLOWED_APPLICATIONS: usize = 32;
pub const MAX_ID_CHARS: usize = 128;
pub const MAX_PAYLOAD_CHARS: usize = 32 * 1024;
pub const MAX_ACTION_BODY_BYTES: usize = 96 * 1024;
pub const MAX_TREE_DEPTH: usize = 8;
pub const MAX_TREE_NODES: usize = 512;
pub const MAX_TEXT_CHARS: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AllowedApplication {
    pub app_id: String,
    pub executable_path: PathBuf,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContractError {
    #[error("schemaVersion must be 1")]
    SchemaVersion,
    #[error("{0} is invalid")]
    InvalidField(&'static str),
    #[error("payloadText is only valid for desktop.type")]
    UnexpectedPayload,
    #[error("desktop.type requires a non-empty bounded payloadText")]
    MissingPayload,
    #[error("desktop.type payloadText contains a NUL character")]
    NulPayload,
    #[error("desktop.type payloadHash does not match payloadText")]
    PayloadHashMismatch,
    #[error("desktop allowlist is invalid JSON")]
    InvalidAllowlist,
    #[error("desktop allowlist must contain between 1 and 32 applications")]
    InvalidAllowlistSize,
    #[error("desktop allowlist contains duplicate application identities")]
    DuplicateApplication,
    #[error("desktop allowlist executable paths must be absolute .exe files")]
    InvalidExecutable,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionEnvelope {
    pub schema_version: u8,
    pub action: DesktopAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DesktopAction {
    #[serde(rename = "desktop.discover")]
    Discover { app_id: String },
    #[serde(rename = "desktop.inspect")]
    Inspect {
        app_id: String,
        window_id: String,
        tree_revision: String,
    },
    #[serde(rename = "desktop.click")]
    Click {
        app_id: String,
        window_id: String,
        tree_revision: String,
        node_id: String,
    },
    #[serde(rename = "desktop.type")]
    Type {
        app_id: String,
        window_id: String,
        tree_revision: String,
        node_id: String,
        payload_hash: String,
    },
}

impl DesktopAction {
    pub fn action_type(&self) -> &'static str {
        match self {
            Self::Discover { .. } => "desktop.discover",
            Self::Inspect { .. } => "desktop.inspect",
            Self::Click { .. } => "desktop.click",
            Self::Type { .. } => "desktop.type",
        }
    }

    pub fn app_id(&self) -> &str {
        match self {
            Self::Discover { app_id }
            | Self::Inspect { app_id, .. }
            | Self::Click { app_id, .. }
            | Self::Type { app_id, .. } => app_id,
        }
    }

    pub fn source_ref(&self) -> String {
        match self {
            Self::Discover { app_id } => format!("desktop:{app_id}:windows"),
            Self::Inspect {
                app_id, window_id, ..
            } => format!("desktop:{app_id}:{window_id}:tree"),
            Self::Click {
                app_id,
                window_id,
                node_id,
                ..
            } => format!("desktop:{app_id}:{window_id}:{node_id}:click"),
            Self::Type {
                app_id,
                window_id,
                node_id,
                ..
            } => format!("desktop:{app_id}:{window_id}:{node_id}:type"),
        }
    }

    pub fn is_mutation(&self) -> bool {
        matches!(self, Self::Click { .. } | Self::Type { .. })
    }
}

impl ActionEnvelope {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.schema_version != BRIDGE_SCHEMA_VERSION {
            return Err(ContractError::SchemaVersion);
        }
        validate_app_id(self.action.app_id(), "action.appId")?;
        match &self.action {
            DesktopAction::Discover { .. } => {
                if self.payload_text.is_some() {
                    return Err(ContractError::UnexpectedPayload);
                }
            }
            DesktopAction::Inspect {
                window_id,
                tree_revision,
                ..
            } => {
                validate_identifier(window_id, MAX_ID_CHARS, "action.windowId")?;
                validate_sha256(tree_revision, "action.treeRevision")?;
                if self.payload_text.is_some() {
                    return Err(ContractError::UnexpectedPayload);
                }
            }
            DesktopAction::Click {
                window_id,
                tree_revision,
                node_id,
                ..
            } => {
                validate_target(window_id, tree_revision, node_id)?;
                if self.payload_text.is_some() {
                    return Err(ContractError::UnexpectedPayload);
                }
            }
            DesktopAction::Type {
                window_id,
                tree_revision,
                node_id,
                payload_hash,
                ..
            } => {
                validate_target(window_id, tree_revision, node_id)?;
                validate_sha256(payload_hash, "action.payloadHash")?;
                let payload = self
                    .payload_text
                    .as_ref()
                    .filter(|value| !value.is_empty() && value.chars().count() <= MAX_PAYLOAD_CHARS)
                    .ok_or(ContractError::MissingPayload)?;
                if payload.contains('\0') {
                    return Err(ContractError::NulPayload);
                }
                let actual_hash = hex::encode(Sha256::digest(payload.as_bytes()));
                if actual_hash.as_str() != payload_hash {
                    return Err(ContractError::PayloadHashMismatch);
                }
            }
        }
        Ok(())
    }
}

fn validate_target(
    window_id: &str,
    tree_revision: &str,
    node_id: &str,
) -> Result<(), ContractError> {
    validate_identifier(window_id, MAX_ID_CHARS, "action.windowId")?;
    validate_sha256(tree_revision, "action.treeRevision")?;
    validate_sha256(node_id, "action.nodeId")
}

fn validate_identifier(
    value: &str,
    maximum: usize,
    name: &'static str,
) -> Result<(), ContractError> {
    let valid = !value.is_empty()
        && value.chars().count() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'));
    if valid {
        Ok(())
    } else {
        Err(ContractError::InvalidField(name))
    }
}

fn validate_app_id(value: &str, name: &'static str) -> Result<(), ContractError> {
    let mut bytes = value.bytes();
    let first = bytes.next();
    let valid = !value.is_empty()
        && value.len() <= MAX_APP_ID_CHARS
        && first.is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        });
    if valid {
        Ok(())
    } else {
        Err(ContractError::InvalidField(name))
    }
}

fn validate_sha256(value: &str, name: &'static str) -> Result<(), ContractError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(ContractError::InvalidField(name))
    }
}

pub fn parse_allowed_applications(
    raw: Option<&str>,
) -> Result<Vec<AllowedApplication>, ContractError> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(ContractError::InvalidAllowlistSize);
    };
    let mut apps: Vec<AllowedApplication> =
        serde_json::from_str(raw).map_err(|_| ContractError::InvalidAllowlist)?;
    if apps.is_empty() || apps.len() > MAX_ALLOWED_APPLICATIONS {
        return Err(ContractError::InvalidAllowlistSize);
    }
    let mut identities = std::collections::HashSet::new();
    let mut executable_paths = std::collections::HashSet::new();
    for app in &mut apps {
        validate_app_id(&app.app_id, "allowlist.appId")?;
        if !is_absolute_executable(&app.executable_path) {
            return Err(ContractError::InvalidExecutable);
        }
        app.executable_path = std::fs::canonicalize(&app.executable_path)
            .map_err(|_| ContractError::InvalidExecutable)?;
        let normalized_path = app.executable_path.to_string_lossy().to_lowercase();
        if !identities.insert(app.app_id.clone()) || !executable_paths.insert(normalized_path) {
            return Err(ContractError::DuplicateApplication);
        }
    }
    apps.sort_by(|left, right| left.app_id.cmp(&right.app_id));
    Ok(apps)
}

fn is_absolute_executable(path: &Path) -> bool {
    path.is_absolute()
        && path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub schema_version: u8,
    pub status: &'static str,
    pub host_instance_id: String,
    pub platform: &'static str,
    pub capabilities: Vec<String>,
    pub allowed_app_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionResponse {
    pub schema_version: u8,
    pub status: ActionResponseStatus,
    pub source_ref: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionResponseStatus {
    Succeeded,
    Failed,
    Uncertain,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash() -> String {
        "a".repeat(64)
    }

    #[test]
    fn write_actions_require_exact_hash_bound_targets() {
        let valid = ActionEnvelope {
            schema_version: 1,
            action: DesktopAction::Click {
                app_id: "app.editor".into(),
                window_id: "window-1".into(),
                tree_revision: hash(),
                node_id: hash(),
            },
            payload_text: None,
        };
        assert_eq!(valid.validate(), Ok(()));

        let mut stale = valid.clone();
        if let DesktopAction::Click { tree_revision, .. } = &mut stale.action {
            *tree_revision = "caller-chosen-revision".into();
        }
        assert_eq!(
            stale.validate(),
            Err(ContractError::InvalidField("action.treeRevision"))
        );
    }

    #[test]
    fn text_exists_only_in_the_separate_bounded_payload() {
        let missing = ActionEnvelope {
            schema_version: 1,
            action: DesktopAction::Type {
                app_id: "app.editor".into(),
                window_id: "window-1".into(),
                tree_revision: hash(),
                node_id: hash(),
                payload_hash: hash(),
            },
            payload_text: None,
        };
        assert_eq!(missing.validate(), Err(ContractError::MissingPayload));

        let unexpected = ActionEnvelope {
            schema_version: 1,
            action: DesktopAction::Discover {
                app_id: "app.editor".into(),
            },
            payload_text: Some("secret".into()),
        };
        assert_eq!(unexpected.validate(), Err(ContractError::UnexpectedPayload));
    }

    #[test]
    fn action_fields_use_the_shared_camel_case_wire_contract() {
        let parsed: ActionEnvelope = serde_json::from_str(&format!(
            r#"{{"schemaVersion":1,"action":{{"type":"desktop.inspect","appId":"app.editor","windowId":"window-1","treeRevision":"{}"}}}}"#,
            hash()
        ))
        .unwrap();
        assert_eq!(parsed.validate(), Ok(()));
        assert!(matches!(
            parsed.action,
            DesktopAction::Inspect { ref app_id, .. } if app_id == "app.editor"
        ));
    }

    #[test]
    fn app_ids_are_lowercase_and_bounded_to_the_shared_pattern() {
        assert_eq!(validate_app_id("notepad", "appId"), Ok(()));
        assert_eq!(
            validate_app_id("Notepad", "appId"),
            Err(ContractError::InvalidField("appId"))
        );
        assert_eq!(
            validate_app_id(&format!("a{}", "b".repeat(64)), "appId"),
            Err(ContractError::InvalidField("appId"))
        );
    }

    #[test]
    fn source_references_never_include_typed_payloads() {
        let action = DesktopAction::Type {
            app_id: "app.editor".into(),
            window_id: "window-1".into(),
            tree_revision: hash(),
            node_id: hash(),
            payload_hash: hash(),
        };
        assert_eq!(
            action.source_ref(),
            format!("desktop:app.editor:window-1:{}:type", hash())
        );
    }

    #[test]
    fn type_wire_contract_preserves_hash_but_rejects_artifact_identity() {
        let payload = "bounded text";
        let payload_hash = hex::encode(Sha256::digest(payload.as_bytes()));
        let parsed: ActionEnvelope = serde_json::from_str(&format!(
            r#"{{"schemaVersion":1,"action":{{"type":"desktop.type","appId":"app.editor","windowId":"window-1","treeRevision":"{}","nodeId":"{}","payloadHash":"{payload_hash}"}},"payloadText":"{payload}"}}"#,
            hash(),
            hash(),
        ))
        .unwrap();
        assert_eq!(parsed.validate(), Ok(()));
        let serialized = serde_json::to_value(&parsed).unwrap();
        assert_eq!(serialized["action"]["payloadHash"], payload_hash);
        assert!(serialized["action"].get("payloadArtifactId").is_none());

        let with_artifact_id = format!(
            r#"{{"schemaVersion":1,"action":{{"type":"desktop.type","appId":"app.editor","windowId":"window-1","treeRevision":"{}","nodeId":"{}","payloadHash":"{payload_hash}","payloadArtifactId":"artifact-secret"}},"payloadText":"{payload}"}}"#,
            hash(),
            hash(),
        );
        assert!(serde_json::from_str::<ActionEnvelope>(&with_artifact_id).is_err());
    }

    #[test]
    fn type_payload_hash_is_verified_against_the_exact_utf8_payload() {
        let envelope = ActionEnvelope {
            schema_version: 1,
            action: DesktopAction::Type {
                app_id: "app.editor".into(),
                window_id: "window-1".into(),
                tree_revision: hash(),
                node_id: hash(),
                payload_hash: "f".repeat(64),
            },
            payload_text: Some("not the approved bytes".into()),
        };
        assert_eq!(envelope.validate(), Err(ContractError::PayloadHashMismatch));
    }

    #[test]
    fn uncertain_outcome_has_an_explicit_wire_status() {
        assert_eq!(
            serde_json::to_value(ActionResponseStatus::Uncertain).unwrap(),
            "uncertain"
        );
    }

    #[test]
    fn allowlist_size_is_bounded_before_filesystem_resolution() {
        assert_eq!(
            parse_allowed_applications(None),
            Err(ContractError::InvalidAllowlistSize)
        );
        assert_eq!(
            parse_allowed_applications(Some("[]")),
            Err(ContractError::InvalidAllowlistSize)
        );
        let oversized = (0..=MAX_ALLOWED_APPLICATIONS)
            .map(|index| AllowedApplication {
                app_id: format!("app{index}"),
                executable_path: PathBuf::from(format!(r"C:\fixture\app{index}.exe")),
            })
            .collect::<Vec<_>>();
        let raw = serde_json::to_string(&oversized).unwrap();
        assert_eq!(
            parse_allowed_applications(Some(&raw)),
            Err(ContractError::InvalidAllowlistSize)
        );
    }
}
