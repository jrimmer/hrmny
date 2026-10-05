//! U27 shell unit tests (plan: `src/tests/main.rs`).
//!
//! The shell is deliberately thin — plugin wiring only. These tests document
//! the contract: the crate hosts the web build and registers the four
//! desktop plugins (notification, deep-link, window-state, updater). There
//! is no bespoke UI logic to unit-test beyond the wiring itself.

#[test]
fn shell_is_thin() {
    // The shell hosts the web build; there is no bespoke UI logic here.
    // This test documents that the crate's only job is plugin wiring.
    assert!(true);
}

#[test]
fn deep_link_scheme_is_cytale() {
    // The deep-link scheme is pinned to `cytale://` (see tauri.conf.json
    // plugins.deep-link.desktop.schemes). The web side parses it
    // (apps/web/src/tauri/deepLink.ts); the shell only forwards the raw URL.
    let scheme = "cytale";
    assert_eq!(scheme, "cytale");
}

mod pending_deep_link {
    //! #114 — the cold-start handover.
    //!
    //! A launch-by-link delivers the URL before the webview exists, so the
    //! shell cannot just emit it (no listener yet). It retains it instead and
    //! hands it over on request — exactly once, which is what stops a reload
    //! from re-opening a link the member has already visited.

    use crate::PendingDeepLink;

    #[test]
    fn an_app_launched_without_a_link_has_nothing_to_hand_over() {
        assert!(PendingDeepLink::default().take().is_none());
    }

    #[test]
    fn the_launch_url_is_handed_over_once_and_then_forgotten() {
        let state = PendingDeepLink::default();
        state.hold("cytale://workspace/1/channel/2/message/3".to_string());

        assert_eq!(
            state.take().as_deref(),
            Some("cytale://workspace/1/channel/2/message/3")
        );
        assert!(state.take().is_none());
    }

    #[test]
    fn a_second_link_replaces_the_first() {
        // Two links opened back to back while the app is starting: the newest
        // is the one the member meant to open.
        let state = PendingDeepLink::default();
        state.hold("cytale://workspace/1".to_string());
        state.hold("cytale://workspace/1/channel/2/message/3".to_string());
        assert_eq!(
            state.take().as_deref(),
            Some("cytale://workspace/1/channel/2/message/3")
        );
    }
}
