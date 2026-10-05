/**
 * @cytale/web — build identity.
 *
 * The short commit hash of the bundle currently running, injected at build
 * time by vite.config.ts (`define: __CYTALE_VERSION__`). Surfaced as the rail
 * footer badge so any live session or screenshot can be tied to a commit
 * without opening devtools — the deployed image tag IS this hash.
 *
 * The `typeof` guard keeps the module importable wherever the define was not
 * applied (it degrades to 'dev' rather than throwing on an undefined global).
 */

declare const __CYTALE_VERSION__: string;

/** Short commit hash of this build; 'dev' when none was resolvable. */
export const APP_VERSION: string =
  typeof __CYTALE_VERSION__ === 'string' && __CYTALE_VERSION__ !== ''
    ? __CYTALE_VERSION__
    : 'dev';

/** Display label for the badge — the hash with the 'v' prefix users read. */
export function versionLabel(): string {
  return `v${APP_VERSION}`;
}
