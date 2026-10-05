/**
 * @cytale/web — build identity (version.ts) + the rail badge.
 *
 * Two layers under test:
 *   1. the value contract — APP_VERSION is the injected short commit hash,
 *      with 'dev' as the honest fallback where no hash was resolvable;
 *   2. the PLUMBING, which is what actually breaks silently: the vite define
 *      that injects it and the CI export that makes a deployment's badge show
 *      the image's own tag. Both are text assertions on the config files (the
 *      PWA suite's established pattern for build wiring — no build needed).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import { APP_VERSION, versionLabel } from '../version.js';
import { VersionBadge } from '../layout/VersionBadge.js';

const WEB_ROOT = join(__dirname, '..', '..', '..');

afterEach(cleanup);

describe('build version', () => {
  it('is the injected 7-char short hash (or the honest dev fallback)', () => {
    // This checkout has git + the vite define, so the value is the local
    // short sha; 'dev' is accepted so a source tarball build carries no
    // false negative.
    expect(APP_VERSION).toMatch(/^([0-9a-f]{7}|dev)$/);
  });

  it('versionLabel prefixes the hash with v', () => {
    expect(versionLabel()).toBe(`v${APP_VERSION}`);
  });
});

describe('Vite injection', () => {
  const config = readFileSync(join(WEB_ROOT, 'vite.config.ts'), 'utf8');

  it('defines __CYTALE_VERSION__ from the guarded build version', () => {
    expect(config).toContain('__CYTALE_VERSION__: JSON.stringify(version)');
  });

  it('resolve order: explicit override → CI commit env → local git HEAD → .git read → dev', () => {
    expect(config).toContain('CYTALE_VERSION');
    expect(config).toContain('GITHUB_SHA');
    expect(config).toContain("'rev-parse'");
    // A checkout with the repo but no git binary still names itself.
    expect(config).toContain('versionFromGitDir');
    expect(config).toMatch(/versionFromGitDir\(\) \?\? 'dev'/);
  });

  it('a production build that cannot name its commit refuses to emit (#137)', () => {
    // The incident: reports carried v=5304c1f while the deployed image was
    // b53ba3f — a report whose version does not name a build is
    // unattributable. 'dev' in a production bundle is exactly that, so the
    // config throws instead of shipping it; dev servers, tests, and
    // deliberate local builds keep the honest fallback (opt-out env).
    expect(config).toContain("mode === 'production'");
    expect(config).toContain('CYTALE_ALLOW_UNVERSIONED');
    expect(config).toContain('cannot name its commit');
    // The guard sits on the same value the define injects — one resolution,
    // no second buildVersion() call that could diverge from the check.
    expect(config.indexOf('const version = buildVersion()')).toBeGreaterThan(-1);
    expect(config.indexOf('const version = buildVersion()')).toBeLessThan(
      config.indexOf('__CYTALE_VERSION__: JSON.stringify(version)'),
    );
  });
});

// The maintainers' release pipeline lives outside the public tree; where a
// checkout carries it, pin its wiring too.
const PRIVATE_RELEASE = join(WEB_ROOT, '..', '..', '.forgejo', 'workflows', 'release.yml');

describe.skipIf(!existsSync(PRIVATE_RELEASE))('CI wiring (private release.yml)', () => {
  it('exports the commit for the SPA build step, so the badge matches the image tag', () => {
    // The image is tagged with the short sha; the badge must read the same
    // value in production, so the SHA job env must reach `pnpm build`.
    expect(readFileSync(PRIVATE_RELEASE, 'utf8')).toContain('SHA: ${{ github.sha }}');
  });
});

describe('CI wiring (GitHub image build)', () => {
  const workflow = readFileSync(join(WEB_ROOT, '..', '..', '.github', 'workflows', 'images.yml'), 'utf8');

  it('passes the commit into the image build, so the badge names the build', () => {
    expect(workflow).toContain('CYTALE_VERSION=${{ github.sha }}');
  });
});

describe('image-build wiring (Dockerfile + compose)', () => {
  // A deploy built FROM the Dockerfile used to read "vdev": `.git` is excluded
  // from the build context and the node image ships no git, so the SPA had no
  // way to name itself. The commit therefore has to be passed IN — these pins
  // keep that door open (user report 2026-09-11: the badge showed vdev).
  const dockerfile = readFileSync(join(WEB_ROOT, '..', '..', 'Dockerfile'), 'utf8');
  const compose = readFileSync(join(WEB_ROOT, '..', '..', 'compose.yaml'), 'utf8');

  it('the webbuild stage declares and exports CYTALE_VERSION', () => {
    const stage = dockerfile.slice(dockerfile.indexOf('AS webbuild'));
    expect(stage).toContain('ARG CYTALE_VERSION');
    expect(stage).toContain('ENV CYTALE_VERSION=${CYTALE_VERSION}');
    // and it must be declared BEFORE the SPA build, or it cannot reach it
    expect(stage.indexOf('ARG CYTALE_VERSION')).toBeLessThan(
      stage.indexOf('pnpm --filter @cytale/web run build'),
    );
  });

  it('compose forwards CYTALE_VERSION into the image build', () => {
    expect(compose).toContain('CYTALE_VERSION: ${CYTALE_VERSION:-}');
  });
});

describe('VersionBadge', () => {
  it('renders the v-prefixed hash, small and labelled for hover', () => {
    render(<VersionBadge />);
    const badge = screen.getByTestId('rail-version');
    expect(badge.textContent).toBe(versionLabel());
    expect(badge.textContent?.startsWith('v')).toBe(true);
    expect(badge.getAttribute('title')).toContain(versionLabel());
    expect(badge.className).toContain('rail-version');
  });
});
