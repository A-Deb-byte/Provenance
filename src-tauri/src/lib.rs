mod bridge;
mod contracts;
mod onboarding;
mod runtime_lock;
mod supervisor;
mod uia;
mod updater;

use bridge::{BridgeSecret, BridgeServer};
use contracts::AllowedApplication;
use runtime_lock::RuntimeOwnership;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use supervisor::{FirstAdminBootstrapSecret, NodeLaunchConfig, NodeSupervisor};

pub fn native_release_runner_exit_code() -> Option<i32> {
    supervisor::native_release_runner_exit_code()
}
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uia::UiaBroker;
use uuid::Uuid;

struct NativeHostState {
    supervisor: Arc<Mutex<NodeSupervisor>>,
    _bridge: Arc<BridgeServer>,
    _desktop: Arc<UiaBroker>,
    _ownership: Mutex<Option<RuntimeOwnership>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryCode {
    RuntimeDirectory,
    RuntimeOwnership,
    ResourceLayout,
    Allowlist,
    Workspace,
    DesktopBroker,
    Bridge,
    Supervisor,
    Webview,
    ManagedState,
}

impl RecoveryCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeDirectory => "runtime_directory",
            Self::RuntimeOwnership => "runtime_ownership",
            Self::ResourceLayout => "resource_layout",
            Self::Allowlist => "desktop_allowlist",
            Self::Workspace => "project_workspace",
            Self::DesktopBroker => "desktop_broker",
            Self::Bridge => "desktop_bridge",
            Self::Supervisor => "node_supervisor",
            Self::Webview => "webview_navigation",
            Self::ManagedState => "native_state",
        }
    }
}

impl Drop for NativeHostState {
    fn drop(&mut self) {
        if let Ok(mut supervisor) = self.supervisor.lock() {
            supervisor.shutdown();
        }
        // The bridge server and runtime ownership drop after the supervised
        // child has exited. That order prevents an orphan from retaining a
        // credential or writing after the owner record disappears.
    }
}

pub fn run() {
    tauri::Builder::default()
        // This must remain the first plugin so a second app instance cannot
        // initialize additional native capability before it is rejected.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // These plugins are used only from trusted Rust. The capability file
        // grants neither plugin to the bundled page, and the loopback page has
        // no Tauri capability at all.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            setup_host(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Provenance native host terminated unexpectedly");
}

fn setup_host(app: &mut tauri::App) {
    let packaged_release = is_packaged_release();
    let runtime_dir = match app.path().app_local_data_dir() {
        Ok(directory) => directory.join("runtime"),
        Err(_) => {
            enter_recovery_mode(app, RecoveryCode::RuntimeDirectory, false);
            return;
        }
    };
    if std::fs::create_dir_all(&runtime_dir).is_err() {
        let updater_scheduled = updater::start(app.handle().clone(), runtime_dir, packaged_release);
        enter_recovery_mode(app, RecoveryCode::RuntimeDirectory, updater_scheduled);
        return;
    }
    // Signed update recovery must remain available even when every later
    // authority-bearing subsystem fails to initialize.
    let updater_scheduled =
        updater::start(app.handle().clone(), runtime_dir.clone(), packaged_release);
    if let Err(code) = initialize_host(app, runtime_dir, packaged_release) {
        enter_recovery_mode(app, code, updater_scheduled);
    }
}

fn initialize_host(
    app: &mut tauri::App,
    runtime_dir: PathBuf,
    packaged_release: bool,
) -> Result<(), RecoveryCode> {
    let project_root =
        project_root(app, packaged_release).map_err(|_| RecoveryCode::ResourceLayout)?;
    let ownership =
        RuntimeOwnership::acquire(&runtime_dir).map_err(|_| RecoveryCode::RuntimeOwnership)?;
    let runtime_owner_nonce = ownership.nonce().to_string();

    let allowed_apps =
        onboarding::load_or_onboard(app, packaged_release).map_err(|_| RecoveryCode::Allowlist)?;
    let current_executable = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|_| RecoveryCode::ResourceLayout)?;
    ensure_host_is_not_allowlisted(&allowed_apps, &current_executable)
        .map_err(|_| RecoveryCode::Allowlist)?;
    let allowlist_json =
        canonical_allowlist_json(&allowed_apps).map_err(|_| RecoveryCode::Allowlist)?;
    let workspace_root = onboarding::load_or_onboard_workspace(
        app,
        &project_root,
        ownership.runtime_dir(),
        packaged_release,
    )
    .map_err(|_| RecoveryCode::Workspace)?;
    let sandbox_image = if packaged_release {
        option_env!("PROVENANCE_SANDBOX_IMAGE").map(str::to_owned)
    } else {
        std::env::var("PROVENANCE_SANDBOX_IMAGE").ok()
    };
    let desktop = UiaBroker::start(allowed_apps).map_err(|_| RecoveryCode::DesktopBroker)?;
    let desktop_executor: Arc<dyn uia::DesktopExecutor> = desktop.clone();

    let host_instance_id = format!("desktop-host-{}", Uuid::new_v4().simple());
    let bridge_secret = BridgeSecret::generate();
    let first_admin_bootstrap_secret = FirstAdminBootstrapSecret::generate();
    let bridge = Arc::new(
        tauri::async_runtime::block_on(BridgeServer::start(
            bridge_secret.clone(),
            host_instance_id.clone(),
            desktop_executor,
        ))
        .map_err(|_| RecoveryCode::Bridge)?,
    );

    let supervisor = Arc::new(Mutex::new(
        NodeSupervisor::start(NodeLaunchConfig {
            node_executable: node_executable(app).map_err(|_| RecoveryCode::ResourceLayout)?,
            server_entrypoint: project_root.join("dist/server.cjs"),
            working_directory: project_root,
            runtime_directory: ownership.runtime_dir().to_path_buf(),
            bridge_url: bridge.url(),
            bridge_secret,
            first_admin_bootstrap_secret: first_admin_bootstrap_secret.clone(),
            runtime_owner_nonce,
            host_instance_id: host_instance_id.clone(),
            desktop_app_allowlist_json: allowlist_json,
            workspace_root,
            packaged_release,
            sandbox_image,
            build_version: env!("CARGO_PKG_VERSION").to_owned(),
        })
        .map_err(|_| RecoveryCode::Supervisor)?,
    ));
    let node_url = supervisor
        .lock()
        .map_err(|_| RecoveryCode::Supervisor)?
        .node_url()
        .to_string();

    let remote_url = initial_webview_url(&node_url, &first_admin_bootstrap_secret)
        .map_err(|_| RecoveryCode::Webview)?;
    let main_window = app
        .get_webview_window("main")
        .ok_or(RecoveryCode::Webview)?;
    // Tauri grants commands to bundled content by default. No remote origin is
    // present in the capability file, so this supervised HTTP page receives
    // no native invoke authority; it reaches UIA only through the signed Node
    // kernel bridge.
    main_window
        .navigate(remote_url)
        .map_err(|_| RecoveryCode::Webview)?;
    main_window.show().map_err(|_| RecoveryCode::Webview)?;
    main_window.set_focus().map_err(|_| RecoveryCode::Webview)?;

    if !app.manage(NativeHostState {
        supervisor: Arc::clone(&supervisor),
        _bridge: Arc::clone(&bridge),
        _desktop: Arc::clone(&desktop),
        _ownership: Mutex::new(Some(ownership)),
    }) {
        return Err(RecoveryCode::ManagedState);
    }
    spawn_fail_closed_monitor(
        app.handle().clone(),
        Arc::downgrade(&supervisor),
        Arc::downgrade(&bridge),
        Arc::downgrade(&desktop),
    );
    Ok(())
}

fn recovery_update_status(updater_scheduled: bool) -> &'static str {
    if updater_scheduled {
        "A signed update check was scheduled independently, but successful recovery is not guaranteed."
    } else {
        "No signed update check could be scheduled in this state."
    }
}

fn enter_recovery_mode(app: &tauri::App, code: RecoveryCode, updater_scheduled: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("sessionStorage.clear(); localStorage.clear();");
        if let Ok(blank) = tauri::Url::parse("about:blank") {
            let _ = window.navigate(blank);
        }
        let _ = window.set_title("Provenance recovery");
        let _ = window.show();
    }
    let update_status = recovery_update_status(updater_scheduled);
    app.dialog()
        .message(format!(
            "Provenance could not start its trusted runtime ({}). No model, Node, bridge, or desktop authority is active. {update_status} Close this window to exit.",
            code.as_str(),
        ))
        .title("Provenance recovery mode")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

pub(crate) fn shutdown_supervised_child(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<NativeHostState>() {
        if let Ok(mut supervisor) = state.supervisor.lock() {
            supervisor.shutdown();
        }
    }
}

fn spawn_fail_closed_monitor(
    app_handle: tauri::AppHandle,
    supervisor: Weak<Mutex<NodeSupervisor>>,
    bridge: Weak<BridgeServer>,
    desktop: Weak<UiaBroker>,
) {
    std::thread::spawn(move || loop {
        let (Some(supervisor), Some(bridge), Some(desktop)) =
            (supervisor.upgrade(), bridge.upgrade(), desktop.upgrade())
        else {
            return;
        };
        let node_running = supervisor
            .lock()
            .map(|mut child| child.is_running())
            .unwrap_or(false);
        if !node_running || !bridge.is_running() || !desktop.is_healthy() {
            let handle = app_handle.clone();
            let _ = app_handle.run_on_main_thread(move || {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.eval(
                        "try { sessionStorage.clear(); localStorage.clear(); } finally { location.replace('about:blank'); }",
                    );
                    let _ = window.close();
                }
            });
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    });
}

fn project_root(
    app: &tauri::App,
    packaged_release: bool,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let configured = if packaged_release {
        app.path().resource_dir()?
    } else {
        std::env::var_os("PROVENANCE_PROJECT_ROOT")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?)
    };
    let root = std::fs::canonicalize(configured)?;
    if !root.join("dist/server.cjs").is_file() {
        return Err("the application resource root must contain dist/server.cjs".into());
    }
    Ok(root)
}

fn ensure_host_is_not_allowlisted(
    apps: &[AllowedApplication],
    host_executable: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let host = host_executable.to_string_lossy().to_lowercase();
    if apps
        .iter()
        .any(|app| app.executable_path.to_string_lossy().to_lowercase() == host)
    {
        return Err("the native Provenance host cannot be a desktop automation target".into());
    }
    Ok(())
}

fn node_executable(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if !is_packaged_release() {
        if let Some(configured) = std::env::var_os("PROVENANCE_NODE_EXECUTABLE") {
            return Ok(std::fs::canonicalize(configured)?);
        }
    }
    let bundled = app.path().resource_dir()?.join("node/node.exe");
    if bundled.is_file() {
        return Ok(std::fs::canonicalize(bundled)?);
    }
    if !is_packaged_release() {
        let development = Path::new(r"C:\Program Files\nodejs\node.exe");
        if development.is_file() {
            return Ok(std::fs::canonicalize(development)?);
        }
    }
    Err("No canonical bundled Node runtime is available".into())
}

fn is_packaged_release() -> bool {
    matches!(option_env!("PROVENANCE_PACKAGED_RELEASE"), Some("1"))
}

fn initial_webview_url(
    node_url: &str,
    secret: &FirstAdminBootstrapSecret,
) -> Result<tauri::Url, ()> {
    let mut remote_url = tauri::Url::parse(node_url).map_err(|_| ())?;
    remote_url.set_fragment(Some(&format!(
        "provenance-first-admin={}",
        secret.expose_to_initial_webview()
    )));
    Ok(remote_url)
}

fn canonical_allowlist_json(apps: &[AllowedApplication]) -> Result<String, serde_json::Error> {
    serde_json::to_string(apps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_allowlist_is_the_exact_child_and_health_source() {
        let apps = vec![AllowedApplication {
            app_id: "notepad".into(),
            executable_path: PathBuf::from(r"C:\Windows\System32\notepad.exe"),
        }];
        let json = canonical_allowlist_json(&apps).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<AllowedApplication>>(&json).unwrap(),
            apps
        );
        assert!(json.contains(r#""appId":"notepad""#));
    }

    #[test]
    fn native_host_cannot_become_its_own_automation_target() {
        let host = PathBuf::from(r"C:\Program Files\Provenance\provenance-desktop.exe");
        let apps = vec![AllowedApplication {
            app_id: "provenance".into(),
            executable_path: host.clone(),
        }];
        assert!(ensure_host_is_not_allowlisted(&apps, &host).is_err());
    }

    #[test]
    fn recovery_codes_are_stable_and_non_sensitive() {
        assert_eq!(RecoveryCode::RuntimeDirectory.as_str(), "runtime_directory");
        assert_eq!(RecoveryCode::ResourceLayout.as_str(), "resource_layout");
        assert_eq!(RecoveryCode::Allowlist.as_str(), "desktop_allowlist");
        assert_eq!(RecoveryCode::Workspace.as_str(), "project_workspace");
        assert_eq!(RecoveryCode::Supervisor.as_str(), "node_supervisor");
    }

    #[test]
    fn ordinary_builds_do_not_claim_packaged_release_authority() {
        assert!(!is_packaged_release());
    }

    #[test]
    fn recovery_copy_never_promises_an_unavailable_updater() {
        assert!(recovery_update_status(false).contains("No signed update check"));
        assert!(recovery_update_status(true).contains("not guaranteed"));
        assert!(!recovery_update_status(true).contains("remains available"));
    }

    #[test]
    fn initial_webview_receives_secret_only_in_the_fragment() {
        let secret = FirstAdminBootstrapSecret::generate();
        let node_url = "http://127.0.0.1:43123";
        let initial = initial_webview_url(node_url, &secret).unwrap();
        assert_eq!(initial.origin().ascii_serialization(), node_url);
        assert_eq!(initial.path(), "/");
        assert!(initial.query().is_none());
        let expected_fragment = format!(
            "provenance-first-admin={}",
            secret.expose_to_initial_webview()
        );
        assert_eq!(initial.fragment(), Some(expected_fragment.as_str()));
        assert!(!node_url.contains(secret.expose_to_initial_webview()));
    }
}
