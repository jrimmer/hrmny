/**
 * Minimal build-time env typing. apps/web deliberately does not depend on
 * `vite/client`, so only the variables this app reads are declared here.
 *
 * Static access matters: Vite replaces `import.meta.env.VITE_X` literals at
 * build time, which is what lets Rollup drop the e2e branch (and its dynamic
 * import) from production bundles. A structural cast would survive as a
 * runtime lookup and drag the driver into every build.
 */
interface ImportMetaEnv {
  /**
   * Read by vite.config.ts to compute `__CYTALE_E2E__`; supplied by .env.e2e.
   * Nothing in src/ should read it directly (it would not fold).
   */
  readonly VITE_CYTALE_E2E?: string;
  /** Absolute API/gateway origin for packaged shells (src/app/origin.ts). */
  readonly VITE_CYTALE_ORIGIN?: string;
  /**
   * The hosted deployment a packaged shell falls back to and the login form
   * suggests (src/app/origin.ts `HOSTED_ORIGIN`). Unset = none.
   */
  readonly VITE_CYTALE_HOSTED_ORIGIN?: string;
  /** Media-handoff opener origin (calls capability). */
  readonly VITE_WEB_ORIGIN?: string;
  /** Vite's built-ins (dev-only debug handles, mode branches). */
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly MODE?: string;
  readonly BASE_URL?: string;
  /**
   * Anything else the app reads. Kept open on purpose: this declaration is a
   * convenience for the vars above, not a gate — narrowing it must never break
   * an unrelated `import.meta.env.*` call site.
   */
  readonly [key: string]: string | boolean | undefined;
}

/**
 * e2e-only surfaces gate, substituted by the `__CYTALE_E2E__` define in
 * vite.config.ts (true only for `vite build --mode e2e` with .env.e2e). Read
 * it directly — never re-export it through a module, which would stop it
 * folding and pull the driver chunk into release bundles.
 */
declare const __CYTALE_E2E__: boolean;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
