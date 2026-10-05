/**
 * @cytale/desktop — placeholder entry (U1 scaffold, U27 shell).
 *
 * The desktop shell is Rust-hosted (apps/desktop/src-tauri); it loads the
 * web build (apps/web) in the OS webview. There is no TypeScript application
 * code in this package — this file exists so the package's `tsc --noEmit`
 * typecheck has an input and stays green. The web-side Tauri integration
 * helpers live in apps/web/src/tauri.
 */
export {};
