/**
 * Client entry for the tokens bridge so the Vite plugin picks up the @theme
 * block in dev and build. App code imports tokens.css transitively via
 * AppShell; this module exists for the future standalone entry (U25 PWA
 * shell).
 */
import './app/theme/tokens.css';
import './app/theme/shell.css';
