mod bridge;
mod contracts;
mod runtime_lock;
mod supervisor;
mod uia;

use bridge::{BridgeSecret, BridgeServer};
use contracts::{parse_allowed_applications, AllowedApplication};
use runtime_lock::RuntimeOwnership;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use supervisor::{NodeLaunchConfig, NodeSupervisor};
use tauri::Manager;
use uia::UiaBroker;
use uuid::Uuid;

struct NativeHostState {
    supervisor: Arc<Mutex<NodeSupervisor>>,
    _bridge: Arc<BridgeServer>,
    _desktop: Arc<UiaBroker>,
    _ownership: Mutex<Option<RuntimeOwnership>>,
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
        .setup(|app| setup_host(app).map_err(|error| -> Box<dyn std::error::Error> { error }))
        .run(tauri::generate_context!())
        .expect("Provenance native host terminated unexpectedly");
}

fn setup_host(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let project_root = project_root()?;
    let runtime_dir = app.path().app_local_data_dir()?.join("runtime");
    let ownership = RuntimeOwnership::acquire(&runtime_dir)?;
    let runtime_owner_nonce = ownership.nonce().to_string();

    let allowed_apps =
        parse_allowed_applications(std::env::var("DESKTOP_APP_ALLOWLIST").ok().as_deref())?;
    let allowlist_json = canonical_allowlist_json(&allowed_apps)?;
    let desktop = UiaBroker::start(allowed_apps)?;
    let desktop_executor: Arc<dyn uia::DesktopExecutor> = desktop.clone();

    let host_instance_id = format!("desktop-host-{}", Uuid::new_v4().simple());
    let bridge_secret = BridgeSecret::generate();
    let bridge = Arc::new(tauri::async_runtime::block_on(BridgeServer::start(
        bridge_secret.clone(),
        host_instance_id.clone(),
        desktop_executor,
    ))?);

    let supervisor = Arc::new(Mutex::new(NodeSupervisor::start(NodeLaunchConfig {
        node_executable: node_executable(app)?,
        server_entrypoint: project_root.join("dist/server.cjs"),
        working_directory: project_root,
        runtime_directory: ownership.runtime_dir().to_path_buf(),
        bridge_url: bridge.url(),
        bridge_secret,
        runtime_owner_nonce,
        host_instance_id: host_instance_id.clone(),
        desktop_app_allowlist_json: allowlist_json,
    })?));
    let node_url = supervisor
        .lock()
        .map_err(|_| "supervised Node state was poisoned")?
        .node_url()
        .to_string();

    let remote_url = tauri::Url::parse(&node_url)?;
    let main_window = app
        .get_webview_window("main")
        .ok_or("Tauri did not create the main webview window")?;
    // Tauri grants commands to bundled content by default. No remote origin is
    // present in the capability file, so this supervised HTTP page receives
    // no native invoke authority; it reaches UIA only through the signed Node
    // kernel bridge.
    main_window.navigate(remote_url)?;

    if !app.manage(NativeHostState {
        supervisor: Arc::clone(&supervisor),
        _bridge: Arc::clone(&bridge),
        _desktop: Arc::clone(&desktop),
        _ownership: Mutex::new(Some(ownership)),
    }) {
        return Err("native host state was already initialized".into());
    }
    spawn_fail_closed_monitor(
        app.handle().clone(),
        Arc::downgrade(&supervisor),
        Arc::downgrade(&bridge),
        Arc::downgrade(&desktop),
    );
    Ok(())
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

fn project_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let configured = std::env::var_os("PROVENANCE_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let root = std::fs::canonicalize(configured)?;
    if !root.join("dist/server.cjs").is_file() {
        return Err("PROVENANCE_PROJECT_ROOT must contain dist/server.cjs".into());
    }
    Ok(root)
}

fn node_executable(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(configured) = std::env::var_os("PROVENANCE_NODE_EXECUTABLE") {
        return Ok(std::fs::canonicalize(configured)?);
    }
    let bundled = app.path().resource_dir()?.join("node/node.exe");
    if bundled.is_file() {
        return Ok(std::fs::canonicalize(bundled)?);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(r"C:\Program Files\nodejs\node.exe");
        if development.is_file() {
            return Ok(std::fs::canonicalize(development)?);
        }
    }
    Err("No canonical bundled Node runtime is available".into())
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
}
