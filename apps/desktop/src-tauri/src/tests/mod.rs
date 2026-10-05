//! U27 shell unit tests (plan: `src/tests/main.rs`).
//!
//! The shell is deliberately thin — plugin wiring only. These tests document
//! the contract: the crate hosts the web build and registers the four
//! desktop plugins (notification, deep-link, window-state, updater). There
//! is no bespoke UI logic to unit-test beyond the wiring itself.

mod main;
