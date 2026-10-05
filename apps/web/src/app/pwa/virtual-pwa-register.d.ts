/**
 * Ambient module declaration for vite-plugin-pwa's virtual module.
 * The real types ship in `vite-plugin-pwa/client` — declared here so the
 * registration module typechecks without pulling client types into the
 * test environment.
 */

declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisteredSW?: (
      url: string,
      registration: ServiceWorkerRegistration | undefined,
    ) => void;
    onRegisterError?: (error: unknown) => void;
  }

  /**
   * Returns the updater: `updateSW(true)` activates the waiting worker
   * (skip-waiting) and reloads once it controls the page (prompt mode).
   */
  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
