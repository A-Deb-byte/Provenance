use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_updater::UpdaterExt;

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_FILE: &str = "native-update-status.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum UpdatePhase {
    Checking,
    Current,
    Available,
    Deferred,
    Installing,
    CheckFailed,
    InstallFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus<'a> {
    schema_version: u8,
    phase: UpdatePhase,
    current_version: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_version: Option<&'a str>,
}

pub fn start(app: AppHandle, runtime_dir: PathBuf, enabled: bool) -> bool {
    if !enabled {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        run_update_check(app, &runtime_dir).await;
    });
    true
}

async fn run_update_check(app: AppHandle, runtime_dir: &Path) {
    let current_version = app.package_info().version.to_string();
    write_status(runtime_dir, UpdatePhase::Checking, &current_version, None);

    let before_exit_handle = app.clone();
    let updater = match app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .on_before_exit(move || crate::shutdown_supervised_child(&before_exit_handle))
        .build()
    {
        Ok(updater) => updater,
        Err(_) => {
            write_status(
                runtime_dir,
                UpdatePhase::CheckFailed,
                &current_version,
                None,
            );
            return;
        }
    };

    let update = match updater.check().await {
        Ok(update) => update,
        Err(_) => {
            write_status(
                runtime_dir,
                UpdatePhase::CheckFailed,
                &current_version,
                None,
            );
            return;
        }
    };
    let Some(update) = update else {
        write_status(runtime_dir, UpdatePhase::Current, &current_version, None);
        return;
    };

    write_status(
        runtime_dir,
        UpdatePhase::Available,
        &current_version,
        Some(&update.version),
    );
    let prompt_handle = app.clone();
    let candidate_version = update.version.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || {
        prompt_handle
            .dialog()
            .message(format!(
                "A signed Provenance update ({candidate_version}) is available. Install it now? The application will close during installation."
            ))
            .title("Signed Provenance update")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
            == MessageDialogResult::Yes
    })
    .await
    .unwrap_or(false);

    if !approved {
        write_status(
            runtime_dir,
            UpdatePhase::Deferred,
            &current_version,
            Some(&update.version),
        );
        return;
    }

    write_status(
        runtime_dir,
        UpdatePhase::Installing,
        &current_version,
        Some(&update.version),
    );
    if update.download_and_install(|_, _| {}, || {}).await.is_err() {
        write_status(
            runtime_dir,
            UpdatePhase::InstallFailed,
            &current_version,
            Some(&update.version),
        );
    }
}

fn write_status(
    runtime_dir: &Path,
    phase: UpdatePhase,
    current_version: &str,
    candidate_version: Option<&str>,
) {
    let record = UpdateStatus {
        schema_version: 1,
        phase,
        current_version,
        candidate_version,
    };
    if let Ok(encoded) = serde_json::to_vec(&record) {
        // This is diagnostic state, not execution authority. It deliberately
        // contains neither endpoint details nor updater/signing key material.
        let _ = std::fs::write(runtime_dir.join(STATUS_FILE), encoded);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_status_never_contains_update_authority() {
        let encoded = serde_json::to_string(&UpdateStatus {
            schema_version: 1,
            phase: UpdatePhase::Available,
            current_version: "1.0.0",
            candidate_version: Some("1.1.0"),
        })
        .unwrap();
        assert_eq!(
            encoded,
            r#"{"schemaVersion":1,"phase":"available","currentVersion":"1.0.0","candidateVersion":"1.1.0"}"#
        );
        assert!(!encoded.contains("endpoint"));
        assert!(!encoded.contains("key"));
        assert!(!encoded.contains("signature"));
    }

    #[test]
    fn frontend_capability_does_not_grant_updater_commands() {
        let capability = include_str!("../capabilities/main.json");
        assert!(!capability.contains("updater:"));
        assert!(!capability.contains("dialog:"));
    }
}
