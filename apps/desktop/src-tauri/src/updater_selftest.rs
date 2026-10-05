//! Dev-only updater selftest (NOT compiled into release builds).
//!
//! The updater is `dialog: false` with no web-side caller yet, so the
//! ticket-level acceptance — "an older build detects, downloads,
//! signature-verifies and installs a newer build" — needs a driver that
//! exercises the plugin API directly. This module is that driver, for the
//! local proof run documented in docs/desktop-updates.md and driven by
//! `apps/desktop/e2e/updater-proof.mts`:
//!
//!   CYTALE_UPDATER_SELFTEST=1 ./Hrmny.app/Contents/MacOS/cytale-desktop
//!
//! The env var is the only switch; a launch without it (or a release build,
//! where this module does not exist) never touches the updater. The shell
//! then walks the exact production path — `updater.check()` polls the baked
//! endpoint, `Update::download` verifies the minisign signature against the
//! pubkey in tauri.conf.json BEFORE `install` moves anything — and reports
//! each stage as `UPDATER_SELFTEST:` lines on stdout, which the proof
//! harness asserts. After a successful install it exits so the harness can
//! relaunch the REPLACED bundle and watch it report the new version.

use tauri_plugin_updater::UpdaterExt;

/// Run the selftest in the background; never blocks app startup.
pub fn maybe_start(app: tauri::AppHandle) {
    if std::env::var_os("CYTALE_UPDATER_SELFTEST").is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run(&app).await {
            println!("UPDATER_SELFTEST: FAILED {err}");
            // A failed proof must not hang the harness waiting for stages
            // that will never print; exit non-zero once the verdict is out.
            std::process::exit(1);
        }
    });
}

async fn run(app: &tauri::AppHandle) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    println!("UPDATER_SELFTEST: current_version={current}");

    let updater = app.updater().map_err(|e| format!("updater(): {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("check(): {e}"))?;
    let Some(update) = update else {
        println!("UPDATER_SELFTEST: UP_TO_DATE version={current}");
        return Ok(());
    };

    println!(
        "UPDATER_SELFTEST: DETECTED current={current} available={}",
        update.version
    );
    println!("UPDATER_SELFTEST: DOWNLOAD url={}", update.download_url);

    let mut last_reported = 0usize;
    let bytes = update
        .download(
            |chunk, total| {
                if let Some(total) = total {
                    let done = (chunk as f64 / total as f64 * 4.0).floor() as usize;
                    if done > last_reported {
                        last_reported = done;
                        println!("UPDATER_SELFTEST: PROGRESS {done}/4");
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("download(): {e}"))?;
    // `download` verifies the minisign signature against the baked pubkey
    // BEFORE returning (a tampered payload is rejected there, never handed
    // to install), so reaching this line IS the verification event the
    // acceptance names.
    println!("UPDATER_SELFTEST: SIGNATURE_VERIFIED bytes={}", bytes.len());

    update.install(bytes).map_err(|e| format!("install(): {e}"))?;
    println!("UPDATER_SELFTEST: INSTALLED version={}", update.version);
    println!("UPDATER_SELFTEST: EXITING_FOR_RELAUNCH");
    // Deliberate: the install REPLACED the bundle this process is running
    // from, and continuing to live in a deleted tree can crash the webview
    // teardown. The proof harness relaunches the replaced bundle itself —
    // that relaunch is the "newer build reports" half of the acceptance.
    std::process::exit(0)
}
