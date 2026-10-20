mod runner;
mod secrets;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Must be registered first: a second launch (e.g. from an myrel:// link) focuses this window
        // and the deep-link plugin forwards the URL to it.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(runner::Runner::default())
        .invoke_handler(tauri::generate_handler![
            secrets::secret_get,
            secrets::secret_set,
            runner::runner_info,
            runner::runner_connect,
            runner::runner_set_access,
            runner::runner_logout,
            runner::runner_start,
            runner::runner_stop,
        ])
        .setup(|app| {
            // Linux and Windows dev builds only learn the scheme at runtime; installers register it.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            runner::autostart(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Myrel")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                runner::stop(app);
            }
        });
}
