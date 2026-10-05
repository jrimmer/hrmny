/**
 * Ambient types for the web-app files the cross-client parity test
 * transitively typechecks: `markdown.parity.test.ts` executes
 * `apps/web/src/features/messages/markdown.tsx`, whose import graph reaches
 * Vite-only surfaces (`import.meta.env` on the session store's debug handle,
 * the `virtual:pwa-register` module) that plain tsc under Expo's tsconfig
 * knows nothing about.
 *
 * These shims declare ONLY what those files use — they do not make the web
 * app's Vite features available to mobile code, and a new Vite-ism in the
 * reached graph still fails typecheck until a shim grows the matching
 * declaration (which is the signal to look at the boundary instead).
 *
 * The virtual-module declaration mirrors
 * `apps/web/src/app/pwa/virtual-pwa-register.d.ts`; keep the two in step.
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

  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
