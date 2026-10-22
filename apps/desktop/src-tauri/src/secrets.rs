//! Bearer tokens in the OS keychain. The web view only sees them through these two commands.

const SERVICE: &str = "io.fibteq.myrel";

/// Entries the web view may not read or write: the runner's login, which only the runner commands handle,
/// so script in the web view can never take the runner's token or point it at another server.
const NATIVE_ONLY: &[&str] = &[crate::runner::LOGIN_KEY];

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

fn web_key(key: &str) -> Result<(), String> {
    if NATIVE_ONLY.contains(&key) {
        return Err(format!("{key} is not readable from the web view"));
    }
    Ok(())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    web_key(&key)?;
    get(&key)
}

#[tauri::command]
pub fn secret_set(key: String, value: Option<String>) -> Result<(), String> {
    web_key(&key)?;
    set(&key, value)
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(key: &str, value: Option<String>) -> Result<(), String> {
    let entry = entry(key)?;
    match value {
        Some(value) => entry.set_password(&value).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}
