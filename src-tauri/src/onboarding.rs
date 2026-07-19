use crate::contracts::{
    parse_allowed_applications, AllowedApplication, ContractError, MAX_ALLOWED_APPLICATIONS,
};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use thiserror::Error;
use uuid::Uuid;

const CONFIG_FILE: &str = "desktop-allowlist.json";
const WORKSPACE_CONFIG_FILE: &str = "project-workspace.json";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AllowlistSource {
    DevelopmentEnvironment,
    Persisted,
    Onboarding,
}

#[derive(Debug, Error)]
pub enum OnboardingError {
    #[error("desktop allowlist configuration is invalid: {0}")]
    Contract(#[from] ContractError),
    #[error("desktop allowlist configuration could not be read or written: {0}")]
    Io(#[from] std::io::Error),
    #[error("desktop application selection was cancelled")]
    Cancelled,
    #[error("desktop application selection could not run")]
    Dialog,
    #[error("desktop application selection was not confirmed")]
    NotConfirmed,
    #[error("the selected project workspace is invalid or overlaps trusted native state")]
    InvalidWorkspace,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceConfig {
    schema_version: u8,
    workspace_root: PathBuf,
}

pub fn load_or_onboard(
    app: &tauri::App,
    packaged_release: bool,
) -> Result<Vec<AllowedApplication>, OnboardingError> {
    let config_dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
    let config_path = config_dir.join(CONFIG_FILE);
    let development = !packaged_release;
    let environment = if development {
        std::env::var("DESKTOP_APP_ALLOWLIST").ok()
    } else {
        None
    };

    match select_source(development, environment.as_deref(), config_path.is_file()) {
        AllowlistSource::DevelopmentEnvironment => {
            parse_allowed_applications(environment.as_deref()).map_err(Into::into)
        }
        AllowlistSource::Persisted => match load_persisted(&config_path) {
            Ok(applications) => Ok(applications),
            Err(error) => {
                if !confirm_reconfigure(app)? {
                    return Err(error);
                }
                quarantine_invalid(&config_path, "desktop-allowlist")?;
                onboard_at(app, &config_path)
            }
        },
        AllowlistSource::Onboarding => onboard_at(app, &config_path),
    }
}

fn onboard_at(
    app: &tauri::App,
    config_path: &Path,
) -> Result<Vec<AllowedApplication>, OnboardingError> {
    let handle = app.handle().clone();
    let paths = std::thread::spawn(move || {
        handle
            .dialog()
            .file()
            .set_title("Choose applications Provenance may control")
            .add_filter("Windows applications", &["exe"])
            .blocking_pick_files()
    })
    .join()
    .map_err(|_| OnboardingError::Dialog)?
    .ok_or(OnboardingError::Cancelled)?
    .into_iter()
    .map(|path| path.into_path().map_err(|_| OnboardingError::Dialog))
    .collect::<Result<Vec<_>, _>>()?;
    let applications = applications_from_paths(paths)?;
    confirm_selection(app, &applications)?;
    persist(config_path, &applications)?;
    Ok(applications)
}

fn confirm_reconfigure(app: &tauri::App) -> Result<bool, OnboardingError> {
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        handle
            .dialog()
            .message(
                "The saved desktop application allowlist is invalid. Quarantine it and choose a new allowlist? No application access will be granted unless you confirm.",
            )
            .title("Repair desktop application access")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    })
    .join()
    .map_err(|_| OnboardingError::Dialog)
}

fn quarantine_invalid(path: &Path, label: &str) -> Result<(), OnboardingError> {
    let parent = path.parent().ok_or_else(|| {
        OnboardingError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "allowlist path has no parent",
        ))
    })?;
    let quarantined = parent.join(format!("{label}.rejected.{}.json", Uuid::new_v4().simple()));
    std::fs::rename(path, quarantined)?;
    Ok(())
}

pub fn load_or_onboard_workspace(
    app: &tauri::App,
    resource_root: &Path,
    runtime_root: &Path,
    packaged_release: bool,
) -> Result<PathBuf, OnboardingError> {
    let config_dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
    std::fs::create_dir_all(&config_dir)?;
    let config_dir = std::fs::canonicalize(config_dir)?;
    let config_path = config_dir.join(WORKSPACE_CONFIG_FILE);
    if !packaged_release {
        let _ = resource_root;
        let protected = [runtime_root, config_dir.as_path()];
        let selected = std::env::var_os("PROVENANCE_WORKSPACE_ROOT")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        return validate_workspace(&selected, &protected);
    }

    {
        let protected = [resource_root, runtime_root, config_dir.as_path()];
        if config_path.is_file() {
            match load_workspace(&config_path, &protected) {
                Ok(workspace) => return Ok(workspace),
                Err(error) => {
                    if !confirm_workspace_reconfigure(app)? {
                        return Err(error);
                    }
                    quarantine_invalid(&config_path, "project-workspace")?;
                }
            }
        }
        let handle = app.handle().clone();
        let selected = std::thread::spawn(move || {
            handle
                .dialog()
                .file()
                .set_title("Choose the project workspace Provenance may edit")
                .blocking_pick_folder()
        })
        .join()
        .map_err(|_| OnboardingError::Dialog)?
        .ok_or(OnboardingError::Cancelled)?
        .into_path()
        .map_err(|_| OnboardingError::InvalidWorkspace)?;
        let workspace = validate_workspace(&selected, &protected)?;
        confirm_workspace(app, &workspace)?;
        persist_workspace(&config_path, &workspace)?;
        Ok(workspace)
    }
}

fn validate_workspace(
    candidate: &Path,
    protected_roots: &[&Path],
) -> Result<PathBuf, OnboardingError> {
    let workspace =
        std::fs::canonicalize(candidate).map_err(|_| OnboardingError::InvalidWorkspace)?;
    if !workspace.is_dir() {
        return Err(OnboardingError::InvalidWorkspace);
    }
    let package = std::fs::symlink_metadata(workspace.join("package.json"))
        .map_err(|_| OnboardingError::InvalidWorkspace)?;
    if !package.is_file() || package.file_type().is_symlink() {
        return Err(OnboardingError::InvalidWorkspace);
    }
    for protected in protected_roots {
        let protected =
            std::fs::canonicalize(protected).map_err(|_| OnboardingError::InvalidWorkspace)?;
        if workspace.starts_with(&protected) || protected.starts_with(&workspace) {
            return Err(OnboardingError::InvalidWorkspace);
        }
    }
    Ok(workspace)
}

fn load_workspace(path: &Path, protected_roots: &[&Path]) -> Result<PathBuf, OnboardingError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(OnboardingError::InvalidWorkspace);
    }
    let mut raw = String::new();
    File::open(path)?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut raw)?;
    let config: WorkspaceConfig =
        serde_json::from_str(&raw).map_err(|_| OnboardingError::InvalidWorkspace)?;
    if config.schema_version != 1 {
        return Err(OnboardingError::InvalidWorkspace);
    }
    validate_workspace(&config.workspace_root, protected_roots)
}

fn confirm_workspace_reconfigure(app: &tauri::App) -> Result<bool, OnboardingError> {
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        handle
            .dialog()
            .message(
                "The saved project workspace is invalid. Quarantine it and choose a new workspace? No workspace access will be granted unless you confirm.",
            )
            .title("Repair project workspace access")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    })
    .join()
    .map_err(|_| OnboardingError::Dialog)
}

fn confirm_workspace(app: &tauri::App, workspace: &Path) -> Result<(), OnboardingError> {
    let display = workspace
        .to_string_lossy()
        .chars()
        .take(512)
        .collect::<String>();
    let handle = app.handle().clone();
    let confirmed = std::thread::spawn(move || {
        handle
            .dialog()
            .message(format!(
                "Allow Provenance to use this project workspace?\n\n{display}"
            ))
            .title("Confirm project workspace")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    })
    .join()
    .map_err(|_| OnboardingError::Dialog)?;
    if confirmed {
        Ok(())
    } else {
        Err(OnboardingError::NotConfirmed)
    }
}

fn persist_workspace(path: &Path, workspace: &Path) -> Result<(), OnboardingError> {
    let encoded = serde_json::to_vec(&WorkspaceConfig {
        schema_version: 1,
        workspace_root: workspace.to_path_buf(),
    })
    .map_err(|_| OnboardingError::InvalidWorkspace)?;
    persist_bytes(path, &encoded)
}

fn select_source(
    development: bool,
    environment: Option<&str>,
    persisted_exists: bool,
) -> AllowlistSource {
    if development && environment.is_some_and(|value| !value.trim().is_empty()) {
        AllowlistSource::DevelopmentEnvironment
    } else if persisted_exists {
        AllowlistSource::Persisted
    } else {
        AllowlistSource::Onboarding
    }
}

fn load_persisted(path: &Path) -> Result<Vec<AllowedApplication>, OnboardingError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(ContractError::InvalidAllowlist.into());
    }
    let mut raw = String::new();
    File::open(path)?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut raw)?;
    if raw.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ContractError::InvalidAllowlist.into());
    }
    parse_allowed_applications(Some(&raw)).map_err(Into::into)
}

fn applications_from_paths(
    paths: Vec<PathBuf>,
) -> Result<Vec<AllowedApplication>, OnboardingError> {
    if paths.is_empty() || paths.len() > MAX_ALLOWED_APPLICATIONS {
        return Err(ContractError::InvalidAllowlistSize.into());
    }
    let applications = paths
        .into_iter()
        .map(|path| {
            let canonical = std::fs::canonicalize(path)
                .map_err(|_| OnboardingError::Contract(ContractError::InvalidExecutable))?;
            Ok(AllowedApplication {
                app_id: application_id(&canonical),
                executable_path: canonical,
            })
        })
        .collect::<Result<Vec<_>, OnboardingError>>()?;
    let raw = serde_json::to_string(&applications)
        .map_err(|_| OnboardingError::Contract(ContractError::InvalidAllowlist))?;
    parse_allowed_applications(Some(&raw)).map_err(Into::into)
}

fn application_id(path: &Path) -> String {
    let mut stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("app")
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_lowercase() || character.is_ascii_digit() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    stem = stem.trim_matches('-').chars().take(40).collect();
    if stem.is_empty() {
        stem.push_str("app");
    }
    let normalized_path = path.to_string_lossy().to_lowercase();
    let digest = hex::encode(Sha256::digest(normalized_path.as_bytes()));
    format!("{stem}-{}", &digest[..8])
}

fn confirm_selection(
    app: &tauri::App,
    applications: &[AllowedApplication],
) -> Result<(), OnboardingError> {
    let names = applications
        .iter()
        .map(|application| {
            application
                .executable_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("application.exe")
                .chars()
                .take(80)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    let handle = app.handle().clone();
    let confirmed = std::thread::spawn(move || {
        handle
            .dialog()
            .message(format!(
                "Allow Provenance to inspect and, after kernel approval, control these applications?\n\n{names}"
            ))
            .title("Confirm desktop application access")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    })
    .join()
    .map_err(|_| OnboardingError::Dialog)?;
    if confirmed {
        Ok(())
    } else {
        Err(OnboardingError::NotConfirmed)
    }
}

fn persist(path: &Path, applications: &[AllowedApplication]) -> Result<(), OnboardingError> {
    let encoded = serde_json::to_vec(applications)
        .map_err(|_| OnboardingError::Contract(ContractError::InvalidAllowlist))?;
    persist_bytes(path, &encoded)
}

fn persist_bytes(path: &Path, encoded: &[u8]) -> Result<(), OnboardingError> {
    let parent = path.parent().ok_or_else(|| {
        OnboardingError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "allowlist path has no parent",
        ))
    })?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".native-config.{}.tmp", Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(encoded)?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_source_ignores_environment_authority() {
        assert_eq!(
            select_source(false, Some("model-controlled"), true),
            AllowlistSource::Persisted
        );
        assert_eq!(
            select_source(false, Some("model-controlled"), false),
            AllowlistSource::Onboarding
        );
        assert_eq!(
            select_source(true, Some("development-only"), true),
            AllowlistSource::DevelopmentEnvironment
        );
    }

    #[test]
    fn selected_executables_receive_deterministic_bounded_ids() {
        let root = std::env::temp_dir().join(format!("provenance-onboarding-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("Example Editor.exe");
        std::fs::write(&executable, b"fixture").unwrap();
        let first = applications_from_paths(vec![executable.clone()]).unwrap();
        let second = applications_from_paths(vec![executable]).unwrap();
        assert_eq!(first, second);
        assert!(first[0].app_id.starts_with("example-editor-"));
        assert!(first[0].executable_path.is_absolute());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persisted_configuration_round_trips_through_contract_validation() {
        let root = std::env::temp_dir().join(format!("provenance-onboarding-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("editor.exe");
        std::fs::write(&executable, b"fixture").unwrap();
        let applications = applications_from_paths(vec![executable]).unwrap();
        let config = root.join(CONFIG_FILE);
        persist(&config, &applications).unwrap();
        assert_eq!(load_persisted(&config).unwrap(), applications);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_configuration_is_quarantined_before_replacement() {
        let root = std::env::temp_dir().join(format!("provenance-onboarding-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let config = root.join(CONFIG_FILE);
        std::fs::write(&config, b"not valid json").unwrap();
        assert!(load_persisted(&config).is_err());
        quarantine_invalid(&config, "desktop-allowlist").unwrap();
        assert!(!config.exists());
        assert_eq!(
            std::fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("desktop-allowlist.rejected."))
                .count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_must_be_a_project_disjoint_from_native_state() {
        let root = std::env::temp_dir().join(format!("provenance-workspace-{}", Uuid::new_v4()));
        let resource = root.join("resource");
        let runtime = root.join("runtime");
        let config = root.join("config");
        let workspace = root.join("workspace");
        for directory in [&resource, &runtime, &config, &workspace] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(workspace.join("package.json"), b"{}").unwrap();
        assert_eq!(
            validate_workspace(&workspace, &[&resource, &runtime, &config]).unwrap(),
            std::fs::canonicalize(&workspace).unwrap()
        );
        std::fs::write(resource.join("package.json"), b"{}").unwrap();
        assert!(validate_workspace(&resource, &[&resource, &runtime, &config]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
