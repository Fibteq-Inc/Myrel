//! The bundled myrel-runner (packages/myrel-runner) as a sidecar, so projects can work in local
//! folders with the user's own Claude Code, Codex, Antigravity CLI, OpenCode, Hermes Agent or Cursor CLI without installing anything.
//!
//! The runner keeps its shared folders (added from Myrel > Devices) in `<app data>/runner`,
//! separate from a standalone `npx myrel-runner` install. Its login (server + runner token) stays in the OS keychain and
//! only reaches the runner through MYREL_SERVER / MYREL_RUNNER_TOKEN, which it never writes to disk. `start --json` prints one status object per line,
//! which is forwarded to the web view as `runner://status` events.

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

pub const STATUS_EVENT: &str = "runner://status";
pub const LOGIN_KEY: &str = "runner-login";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    server: String,
    runner_id: String,
    token: String,
}

fn load_login() -> Option<Login> {
    let raw = crate::secrets::get(LOGIN_KEY).ok()??;
    serde_json::from_str(&raw).ok()
}

#[derive(Default)]
pub struct Runner {
    child: Mutex<Option<CommandChild>>,
    last: Mutex<Option<Value>>,
}

fn command<R: Runtime>(app: &AppHandle<R>) -> Result<tauri_plugin_shell::process::Command, String> {
    let home = app.path().app_data_dir().map_err(|e| e.to_string())?.join("runner");
    let mut cmd = app
        .shell()
        .sidecar("myrel-runner")
        .map_err(|e| e.to_string())?
        .env("MYREL_RUNNER_HOME", home);
    if let Some(path) = login_path() {
        cmd = cmd.env("PATH", path);
    }
    if let Some(login) = load_login() {
        cmd = cmd.env("MYREL_SERVER", login.server).env("MYREL_RUNNER_TOKEN", login.token);
    }
    Ok(cmd)
}

/// Runs a one-shot runner command and returns its stdout, or its error message.
async fn run<R: Runtime>(app: &AppHandle<R>, args: &[&str]) -> Result<String, String> {
    let out = command(app)?.args(args).output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        Err(if err.is_empty() { "myrel-runner failed".into() } else { err })
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, status: Value) {
    if let Some(runner) = app.try_state::<Runner>() {
        *runner.last.lock().unwrap() = Some(status.clone());
    }
    let _ = app.emit(STATUS_EVENT, status);
}

/// Server, shared folders, access level, installed CLIs and whether this computer is paired.
#[tauri::command]
pub async fn runner_info<R: Runtime>(app: AppHandle<R>, runner: State<'_, Runner>) -> Result<Value, String> {
    let mut info: Value = serde_json::from_str(&run(&app, &["status", "--json"]).await?).map_err(|e| e.to_string())?;
    let state = runner.last.lock().unwrap().clone().unwrap_or_else(|| serde_json::json!({ "state": "stopped" }));
    info["status"] = state;
    let login = load_login();
    info["paired"] = login.is_some().into();
    info["server"] = login.as_ref().map(|l| l.server.clone()).into();
    info["runnerId"] = login.as_ref().map(|l| l.runner_id.clone()).into();
    info["hostname"] = gethostname::gethostname().to_string_lossy().into_owned().into();
    // Node's names, which the runner reports too.
    info["platform"] = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        os => os,
    }
    .into();
    Ok(info)
}

/// Saves the runner login (from `POST /api/runner/pair`, done by the web view) in the keychain and starts the runner.
#[tauri::command]
pub fn runner_connect<R: Runtime>(app: AppHandle<R>, server: String, runner_id: String, token: String) -> Result<(), String> {
    let login = serde_json::to_string(&Login { server, runner_id, token }).map_err(|e| e.to_string())?;
    crate::secrets::set(LOGIN_KEY, Some(login))?;
    start(&app)
}

#[tauri::command]
pub async fn runner_set_access<R: Runtime>(app: AppHandle<R>, access: String) -> Result<(), String> {
    if !matches!(access.as_str(), "read" | "edit" | "auto" | "full") {
        return Err("access must be read, edit, auto or full".into());
    }
    // `start --access` saves the level; restart so the running runner picks it up.
    stop(&app);
    spawn(&app, &["start", "--json", "--access", &access])
}

/// Stops the runner and forgets its login on this computer.
#[tauri::command]
pub fn runner_logout<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    stop(&app);
    crate::secrets::set(LOGIN_KEY, None)
}

#[tauri::command]
pub fn runner_start<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    start(&app)
}

#[tauri::command]
pub fn runner_stop<R: Runtime>(app: AppHandle<R>) {
    stop(&app)
}

fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    stop(app);
    spawn(app, &["start", "--json"])
}

fn spawn<R: Runtime>(app: &AppHandle<R>, args: &[&str]) -> Result<(), String> {
    let (mut events, child) = command(app)?.args(args).spawn().map_err(|e| e.to_string())?;
    let pid = child.pid();
    *app.state::<Runner>().child.lock().unwrap() = Some(child);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stderr = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if let Ok(status) = serde_json::from_slice::<Value>(&line) {
                        emit(&app, status);
                    }
                }
                CommandEvent::Stderr(line) => {
                    stderr = String::from_utf8_lossy(&line).trim().to_owned();
                }
                CommandEvent::Terminated(payload) => {
                    let runner = app.state::<Runner>();
                    let mut child = runner.child.lock().unwrap();
                    // Only report the exit of the process we still track; a restart replaced it otherwise.
                    if child.as_ref().map(|c| c.pid()) == Some(pid) {
                        *child = None;
                        drop(child);
                        if payload.code != Some(0) {
                            emit(&app, serde_json::json!({ "state": "error", "message": stderr }));
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    let Some(runner) = app.try_state::<Runner>() else { return };
    let child = runner.child.lock().unwrap().take();
    if let Some(child) = child {
        terminate(child);
        emit(app, serde_json::json!({ "state": "stopped", "reason": "stopped" }));
    }
}

/// Lets the runner stop its CLI tasks before it exits (SIGTERM); Windows has no such signal.
fn terminate(child: CommandChild) {
    #[cfg(unix)]
    {
        // SAFETY: plain kill(2) on the pid of a child we spawned and still own.
        if unsafe { libc::kill(child.pid() as libc::pid_t, libc::SIGTERM) } == 0 {
            return;
        }
    }
    let _ = child.kill();
}

/// Starts the runner at launch when this computer is already paired.
pub fn autostart<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if load_login().is_some() {
            let _ = start(&app);
        }
    });
}

/// Apps opened from the Dock or a launcher get a minimal PATH, so the CLIs the user installed
/// (Homebrew, ~/.local/bin, nvm) would not be found. Ask the login shell for the real one.
fn login_path() -> Option<String> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        #[cfg(unix)]
        {
            use std::{process::Command, sync::mpsc, thread, time::Duration};
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let (tx, rx) = mpsc::channel();
            thread::spawn(move || {
                let out = Command::new(shell)
                    .args(["-ilc", "printf '__MYREL_PATH__%s__MYREL_PATH__' \"$PATH\""])
                    .output();
                let _ = tx.send(out);
            });
            // A shell profile that waits for input must not hold up the app.
            let out = rx.recv_timeout(Duration::from_secs(5)).ok()?.ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let path = text.split("__MYREL_PATH__").nth(1)?.to_owned();
            (!path.is_empty()).then_some(path)
        }
        #[cfg(not(unix))]
        {
            None
        }
    })
    .clone()
}
