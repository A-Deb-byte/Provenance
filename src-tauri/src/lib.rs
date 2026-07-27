mod acceptance;
mod bridge;
mod contracts;
mod onboarding;
mod resources;
mod runtime_lock;
mod supervisor;
mod uia;
mod updater;

use acceptance::{AcceptanceEvidence, NativeAcceptance};
use bridge::{BridgeSecret, BridgeServer};
use contracts::AllowedApplication;
use runtime_lock::RuntimeOwnership;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::Duration;
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
    acceptance: NativeAcceptance,
}

impl NativeHostState {
    fn shutdown(&self) -> bool {
        let clean_shutdown = self
            .supervisor
            .lock()
            .map(|mut supervisor| supervisor.shutdown())
            .unwrap_or(false);
        self.acceptance.mark_shutdown_result(clean_shutdown);
        if clean_shutdown {
            if let Ok(mut ownership) = self._ownership.lock() {
                ownership.take();
            }
        }
        clean_shutdown
    }
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
    Acceptance,
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
            Self::Acceptance => "native_acceptance",
        }
    }
}

impl Drop for NativeHostState {
    fn drop(&mut self) {
        self.shutdown();
        // The bridge server and runtime ownership drop after the supervised
        // child has exited. That order prevents an orphan from retaining a
        // credential or writing after the owner record disappears.
    }
}

pub fn run() {
    let acceptance = NativeAcceptance::from_environment()
        .expect("the native acceptance configuration is invalid");
    let page_acceptance = acceptance.clone();
    let navigation_acceptance = acceptance.clone();
    let expected_navigation_origin = Arc::new(Mutex::new(None::<String>));
    let navigation_guard = Arc::clone(&expected_navigation_origin);
    let setup_navigation_origin = Arc::clone(&expected_navigation_origin);
    let mut builder = tauri::Builder::default()
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
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("provenance-navigation-guard")
                .on_navigation(move |webview, url| {
                    if webview.label() != "main" || !navigation_is_allowed(&navigation_guard, url) {
                        return false;
                    }
                    if let Err(error) =
                        navigation_acceptance.mark_page_navigation_started(webview.label())
                    {
                        eprintln!("[Acceptance] Page-navigation evidence was rejected: {error}");
                        return false;
                    }
                    true
                })
                .build(),
        );
    // Only the signed release pipeline injects `plugins.updater`, and the
    // plugin fails initialization when that configuration is absent. So
    // registration must use the same predicate that gates `updater::start`:
    // registering it in an unpackaged build aborts the host before `setup`
    // runs, leaving no subsystem initialized and no diagnostic beyond a
    // panic on a detached GUI stderr.
    if is_packaged_release() && !acceptance.enabled() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .on_page_load(move |webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Err(error) = page_acceptance.mark_page_loaded(webview.label(), payload.url())
                {
                    eprintln!("[Acceptance] Page-load evidence was rejected: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                shutdown_supervised_child(window.app_handle());
            }
        })
        .setup(move |app| {
            setup_host(
                app,
                acceptance.clone(),
                Arc::clone(&setup_navigation_origin),
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Provenance native host terminated unexpectedly");
}

fn setup_host(
    app: &mut tauri::App,
    acceptance: NativeAcceptance,
    expected_navigation_origin: Arc<Mutex<Option<String>>>,
) {
    let packaged_release = is_packaged_release();
    let application_identifier = app.config().identifier.clone();
    if acceptance
        .validate_identifier(&application_identifier)
        .is_err()
    {
        enter_recovery_mode(app, RecoveryCode::Acceptance, false);
        return;
    }
    let runtime_dir = match app.path().app_local_data_dir() {
        Ok(directory) => directory.join("runtime"),
        Err(_) => {
            enter_recovery_mode(app, RecoveryCode::RuntimeDirectory, false);
            return;
        }
    };
    if std::fs::create_dir_all(&runtime_dir).is_err() {
        let updater_scheduled = if acceptance.enabled() {
            false
        } else {
            updater::start(app.handle().clone(), runtime_dir, packaged_release)
        };
        enter_recovery_mode(app, RecoveryCode::RuntimeDirectory, updater_scheduled);
        return;
    }
    // Signed update recovery must remain available even when every later
    // authority-bearing subsystem fails to initialize.
    let updater_scheduled = if acceptance.enabled() {
        false
    } else {
        updater::start(app.handle().clone(), runtime_dir.clone(), packaged_release)
    };
    if let Err(code) = initialize_host(
        app,
        runtime_dir,
        packaged_release,
        &acceptance,
        application_identifier,
        expected_navigation_origin,
    ) {
        enter_recovery_mode(app, code, updater_scheduled);
    }
}

fn initialize_host(
    app: &mut tauri::App,
    runtime_dir: PathBuf,
    packaged_release: bool,
    acceptance: &NativeAcceptance,
    application_identifier: String,
    expected_navigation_origin: Arc<Mutex<Option<String>>>,
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
    let build_version = app.package_info().version.to_string();
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
    let frontend_mount_challenge = acceptance
        .prepare_frontend_mount(&host_instance_id)
        .map_err(|_| RecoveryCode::Acceptance)?;

    let supervisor = Arc::new(Mutex::new(
        NodeSupervisor::start(NodeLaunchConfig {
            node_executable: node_executable(app).map_err(|_| RecoveryCode::ResourceLayout)?,
            server_entrypoint: project_root.join("dist/server.cjs"),
            working_directory: project_root.clone(),
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
            build_version: build_version.clone(),
            acceptance_mode: acceptance.enabled(),
            native_acceptance_mount_origin: frontend_mount_challenge
                .as_ref()
                .map(|challenge| challenge.origin().to_owned()),
            resource_root: project_root.clone(),
        })
        .map_err(|_| RecoveryCode::Supervisor)?,
    ));
    let node_url = supervisor
        .lock()
        .map_err(|_| RecoveryCode::Supervisor)?
        .node_url()
        .to_string();
    let expected_origin = tauri::Url::parse(&node_url)
        .map_err(|_| RecoveryCode::Webview)?
        .origin()
        .ascii_serialization();
    *expected_navigation_origin
        .lock()
        .map_err(|_| RecoveryCode::Webview)? = Some(expected_origin.clone());
    if let Some(challenge) = frontend_mount_challenge.as_ref() {
        challenge
            .bind_expected_origin(&expected_origin)
            .map_err(|_| RecoveryCode::Acceptance)?;
    }

    let remote_url = initial_webview_url(
        &node_url,
        &first_admin_bootstrap_secret,
        frontend_mount_challenge
            .as_ref()
            .map(|challenge| (challenge.token(), challenge.endpoint())),
    )
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

    let monitor_started = spawn_fail_closed_monitor(
        app.handle().clone(),
        Arc::downgrade(&supervisor),
        Arc::downgrade(&bridge),
        Arc::downgrade(&desktop),
    );
    if !monitor_started {
        return Err(RecoveryCode::Acceptance);
    }
    acceptance
        .mark_initialized(AcceptanceEvidence {
            runtime_directory: ownership.runtime_dir().to_path_buf(),
            expected_origin,
            application_identifier,
            host_instance_id,
            build_version,
            packaged_release,
            resource_manifest_sha256: supervisor
                .lock()
                .map_err(|_| RecoveryCode::Supervisor)?
                .resource_manifest_sha256()
                .to_owned(),
            monitor_started,
            supervisor: Arc::downgrade(&supervisor),
            bridge: Arc::downgrade(&bridge),
            desktop: Arc::downgrade(&desktop),
        })
        .map_err(|_| RecoveryCode::Acceptance)?;
    if !app.manage(NativeHostState {
        supervisor: Arc::clone(&supervisor),
        _bridge: Arc::clone(&bridge),
        _desktop: Arc::clone(&desktop),
        _ownership: Mutex::new(Some(ownership)),
        acceptance: acceptance.clone(),
    }) {
        return Err(RecoveryCode::ManagedState);
    }
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
        state.shutdown();
    }
}

fn spawn_fail_closed_monitor(
    app_handle: tauri::AppHandle,
    supervisor: Weak<Mutex<NodeSupervisor>>,
    bridge: Weak<BridgeServer>,
    desktop: Weak<UiaBroker>,
) -> bool {
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut initial_check = true;
        loop {
            let (Some(supervisor), Some(bridge), Some(desktop)) =
                (supervisor.upgrade(), bridge.upgrade(), desktop.upgrade())
            else {
                if initial_check {
                    let _ = started_tx.send(false);
                }
                return;
            };
            let node_running = supervisor
                .lock()
                .map(|mut child| child.is_running())
                .unwrap_or(false);
            let healthy = node_running && bridge.is_running() && desktop.is_healthy();
            if initial_check {
                let _ = started_tx.send(healthy);
                initial_check = false;
            }
            if !healthy {
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
        }
    });
    started_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(false)
}

fn navigation_is_allowed(expected_origin: &Arc<Mutex<Option<String>>>, url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    let Ok(expected_origin) = expected_origin.lock() else {
        return false;
    };
    if let Some(expected) = expected_origin.as_deref() {
        return url.origin().ascii_serialization() == expected;
    }
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
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
    frontend_mount_challenge: Option<(&str, &str)>,
) -> Result<tauri::Url, ()> {
    let mut remote_url = tauri::Url::parse(node_url).map_err(|_| ())?;
    let mut fragment = format!(
        "provenance-first-admin={}",
        secret.expose_to_initial_webview()
    );
    if let Some((token, endpoint)) = frontend_mount_challenge {
        let endpoint = tauri::Url::parse(endpoint).map_err(|_| ())?;
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            || endpoint.scheme() != "http"
            || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.port().is_none()
            || endpoint.path() != "/__provenance/native/mounted"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(());
        }
        fragment.push_str("&provenance-native-acceptance-mount=");
        fragment.push_str(token);
        fragment.push_str("&provenance-native-acceptance-endpoint=");
        fragment.push_str(endpoint.as_str());
    }
    remote_url.set_fragment(Some(&fragment));
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
    fn base_configuration_carries_no_updater_settings() {
        // The updater plugin can only initialize against the `plugins.updater`
        // block the release pipeline injects. Registration in `run` is
        // conditional precisely because this base configuration omits it; if a
        // static block ever lands here, revisit that condition rather than
        // letting two sources of updater configuration disagree.
        let config = include_str!("../tauri.conf.json");
        assert!(!config.contains("\"plugins\""));
        assert!(!config.contains("\"updater\""));
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
        let initial = initial_webview_url(node_url, &secret, None).unwrap();
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

    #[test]
    fn acceptance_mount_token_shares_only_the_ephemeral_fragment() {
        let secret = FirstAdminBootstrapSecret::generate();
        let token = "a".repeat(64);
        let endpoint = "http://127.0.0.1:43124/__provenance/native/mounted";
        let initial =
            initial_webview_url("http://127.0.0.1:43123", &secret, Some((&token, endpoint)))
                .unwrap();
        let fragment = initial.fragment().unwrap();
        assert!(fragment.contains("provenance-first-admin="));
        assert!(fragment.contains(&format!("provenance-native-acceptance-mount={token}")));
        assert!(fragment.contains(
            "provenance-native-acceptance-endpoint=http://127.0.0.1:43124/__provenance/native/mounted"
        ));
        assert!(initial.query().is_none());
        let invalid = "A".repeat(64);
        assert!(initial_webview_url(
            "http://127.0.0.1:43123",
            &secret,
            Some((&invalid, endpoint)),
        )
        .is_err());
    }

    #[test]
    fn navigation_guard_allows_only_internal_bootstrap_then_exact_origin() {
        let expected = Arc::new(Mutex::new(None));
        assert!(navigation_is_allowed(
            &expected,
            &tauri::Url::parse("http://tauri.localhost/").unwrap(),
        ));
        assert!(!navigation_is_allowed(
            &expected,
            &tauri::Url::parse("https://example.com/").unwrap(),
        ));
        *expected.lock().unwrap() = Some("http://127.0.0.1:43123".to_owned());
        assert!(navigation_is_allowed(
            &expected,
            &tauri::Url::parse("http://127.0.0.1:43123/dashboard").unwrap(),
        ));
        assert!(!navigation_is_allowed(
            &expected,
            &tauri::Url::parse("http://127.0.0.1:43124/").unwrap(),
        ));
        assert!(!navigation_is_allowed(
            &expected,
            &tauri::Url::parse("http://127.0.0.1.example.com:43123/").unwrap(),
        ));
        assert!(navigation_is_allowed(
            &expected,
            &tauri::Url::parse("about:blank").unwrap(),
        ));
    }
}
