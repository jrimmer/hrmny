//! Cytale desktop shell (U27) — a thin Tauri 2 host for the web build.
//!
//! The web app (apps/web, U25 PWA) is the entire UI; this crate is the
//! minimal OS shell: window management, native notifications, `cytale://`
//! deep links, window-state persistence, and the auto-updater. Everything
//! else (account, gateway, state) is the shared TS core (U15–U17), so the
//! desktop app and the PWA share state via the same gateway (AE6).
//!
//! The library/binary split keeps the shell unit-testable without launching
//! a window: `cargo test` exercises the pure helpers in this module.

pub mod secrets;
#[cfg(debug_assertions)]
pub mod updater_selftest;

use std::sync::Mutex;

use tauri::{Emitter, Manager};

/// The `cytale://` URL the app was LAUNCHED with, held until the webview asks
/// for it (#114).
///
/// Why state and not just the event below: on a cold start the OS delivers the
/// link before the webview has loaded, so the JS side has no listener yet and
/// an emitted event is dropped on the floor. The launch URL is therefore
/// retained here and handed over exactly once, through
/// `deep_link_take_pending`, when the web app is alive to navigate to it.
#[derive(Default)]
struct PendingDeepLink(Mutex<Option<String>>);

impl PendingDeepLink {
    /// Take the held URL, leaving nothing behind. A poisoned lock (a panic
    /// while holding it) reads as "no link" rather than panicking the webview's
    /// call — the app must still start.
    fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut pending| pending.take())
    }

    /// Record a URL the OS opened while the app was not yet listening.
    fn hold(&self, url: String) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(url);
        }
    }
}

/// Hand the launch URL to the webview, ONCE. `None` when the app was launched
/// normally, or when a previous call already took it — the web side must be
/// able to tell "no link" from "link", because a reload must not re-open a link
/// the member has already visited.
#[tauri::command]
fn deep_link_take_pending(state: tauri::State<'_, PendingDeepLink>) -> Option<String> {
    state.take()
}

/// Register the desktop plugins and run the app. Called from `main.rs`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingDeepLink::default())
        // Session tokens live in the OS credential store, not the webview's
        // plaintext localStorage (see secrets.rs).
        .invoke_handler(tauri::generate_handler![
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            deep_link_take_pending
        ])
        .setup(|app| {
            // Deep-link handling: `cytale://workspace/{id}/channel/{id}/message/{id}`
            // is parsed on the web side (apps/web/src/tauri/deepLink.ts); the
            // shell just forwards the raw URL to the webview — by event while
            // the app is running, and through the retained launch URL above for
            // a cold start, where no listener exists yet to receive the event.
            #[cfg(desktop)]
            {
                let deep_link = app.state::<tauri_plugin_deep_link::DeepLink<tauri::Wry>>();
                let _ = deep_link.register("cytale");
                let handle = app.handle().clone();
                deep_link.on_open_url(move |event| {
                    for url in event.urls() {
                        let url = url.to_string();
                        if let Some(state) = handle.try_state::<PendingDeepLink>() {
                            state.hold(url.clone());
                        }
                        let _ = handle.emit("cytale-deep-link", url);
                    }
                });
            }
            // Dev-only updater selftest (debug builds, CYTALE_UPDATER_SELFTEST
            // set): exercises the updater plugin end-to-end for the local
            // proof run. A no-op everywhere else — see updater_selftest.rs.
            #[cfg(debug_assertions)]
            updater_selftest::maybe_start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hrmny desktop shell");
}

#[cfg(test)]
mod tests;
