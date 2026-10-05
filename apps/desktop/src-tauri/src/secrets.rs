//! OS credential store for the session token pair.
//!
//! The webview keeps its state in a plaintext SQLite localStorage file, and
//! anything running at `tauri://localhost` can read it — fine for column
//! widths, not for a 30-day refresh token. These commands put the pair in the
//! platform credential store (macOS Keychain, Windows Credential Manager,
//! Linux Secret Service) behind a single entry; the web adapter primes an
//! in-memory cache from it at boot and writes through on every rotation.
//!
//! The payload is opaque here (JSON chosen by the caller) so the token shape
//! can change without a shell release.

use keyring::Entry;

/// Single account: the whole token pair lives in one entry.
const ACCOUNT: &str = "session-tokens";

/// Keychain service name — the app's bundle identifier, so the entry is
/// attributable AND namespaced per build. The production app stores under
/// `chat.hrmny.desktop`; the e2e harness build (`chat.hrmny.desktop.e2e`,
/// see e2e/tauri.e2e.conf.json) lands elsewhere, which is what lets that
/// build's session reset (`secrets_delete` from the e2e driver) wipe ITS
/// OWN session without ever touching the installed app's tokens. A shared
/// constant would have made every e2e run sign the real app out.
fn entry(app: &tauri::AppHandle) -> Result<Entry, String> {
    Entry::new(&app.config().identifier, ACCOUNT).map_err(|err| err.to_string())
}

/// The stored token payload, or `None` when nothing has been saved yet.
#[tauri::command]
pub fn secrets_get(app: tauri::AppHandle) -> Result<Option<String>, String> {
    match entry(&app)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Persist (or replace) the token payload.
#[tauri::command]
pub fn secrets_set(app: tauri::AppHandle, value: String) -> Result<(), String> {
    entry(&app)?
        .set_password(&value)
        .map_err(|err| err.to_string())
}

/// Drop the stored payload. Missing entries are not an error — sign-out must
/// always succeed.
#[tauri::command]
pub fn secrets_delete(app: tauri::AppHandle) -> Result<(), String> {
    match entry(&app)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
