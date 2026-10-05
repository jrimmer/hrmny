// @vitest-environment node
// (Loading the real vite config pulls in the Tailwind plugin, which loads
// esbuild — it refuses to run inside jsdom's Uint8Array realm.)
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — the config module is outside the src/ tsconfig include.
import config from './vite.config';

/**
 * The e2e driver opens a loopback control channel that logs in and sends
 * messages, so arming it is a security boundary, not a convenience toggle.
 * These assertions pin the three cases that matter; the folding itself (the
 * reason the gate works at all) is pinned by the grep in
 * the CI workflows against a real release build (.github/workflows/ci.yml).
 */
type Resolved = { define: Record<string, string> };
function resolveConfig(mode: string): Resolved {
  const factory = config as unknown as (env: { mode: string; command: string }) => Resolved;
  return factory({ mode, command: 'build' });
}

describe('__CYTALE_E2E__ build gate', () => {
  it('is off for a production build', () => {
    expect(resolveConfig('production').define.__CYTALE_E2E__).toBe('false');
  });

  it('is on for `vite build --mode e2e` (.env.e2e supplies the second factor)', () => {
    expect(resolveConfig('e2e').define.__CYTALE_E2E__).toBe('true');
  });

  it('is off for any other mode, even with VITE_CYTALE_E2E exported', () => {
    // The pre-fix gate was this env var alone, so `VITE_CYTALE_E2E=1 pnpm
    // build` shipped a bundle with the driver in it. The mode check is what
    // closes that; keep it first in the conjunction.
    process.env.VITE_CYTALE_E2E = '1';
    try {
      expect(resolveConfig('production').define.__CYTALE_E2E__).toBe('false');
      expect(resolveConfig('staging').define.__CYTALE_E2E__).toBe('false');
    } finally {
      delete process.env.VITE_CYTALE_E2E;
    }
  });
});
