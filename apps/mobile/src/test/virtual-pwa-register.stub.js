/**
 * Jest stub for vite-plugin-pwa's virtual module.
 *
 * The cross-client markdown parity test executes the WEB renderer
 * (`apps/web/src/features/messages/markdown.tsx`), whose import graph reaches
 * `apps/web/src/app/pwa/registerSW.ts` — a module whose real implementation
 * is a Vite virtual module that exists only inside the web build. The stub is
 * test-only: it can never be bundled into the app (Metro resolves the real
 * thing via metro.config.js, and nothing in `apps/mobile/src` imports it).
 *
 * Mirrors the ambient declaration in `types/web-app-shims.d.ts`.
 */

export const registerSW = () => Promise.resolve();

export default registerSW;
