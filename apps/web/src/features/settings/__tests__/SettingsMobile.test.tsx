/**
 * U5 — the settings surfaces' mobile stack wiring in AuthenticatedApp.
 *
 * jsdom has no AuthenticatedApp harness (the component boots the full auth
 * + gateway + store stack), so the composed behavior is proven by the
 * mobile e2e; this suite pins the SEAM in the source the way AppShell's
 * KTD2 test does, plus the shared shell.css contract both surfaces ride.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(__dirname, '..', '..', '..', '..');

describe('AuthenticatedApp — settings mobile stack wiring (U5, source pin)', () => {
  const app = readFileSync(join(WEB_ROOT, 'src', 'AuthenticatedApp.tsx'), 'utf8');

  it('the pane owns the mobile list; the drawer copy of both navs is hidden', () => {
    // The responsive switch rides the shell's own band contract — one source
    // of truth for phone | tablet | desktop, so the JS branches and the CSS
    // breakpoints cannot disagree (the 768–1279px defect).
    expect(app).toContain('useShellBand');
    // The mobile list is the pane's content at the BARE prefix…
    expect(app).toContain('settingsMobileList');
    expect(app).toContain('wsettingsMobileList');
    // …the gear writes that bare prefix at mobile (the hash stays the
    // source of truth: bare = list, sectioned = content)…
    expect(app).toContain('navigate(SETTINGS_ROUTE_PREFIX)');
    expect(app).toContain('navigate(WSETTINGS_ROUTE_PREFIX)');
    // …and the sidebar slot (the drawer at mobile) drops both navs.
    expect(app).toMatch(/settingsOpen \?[\s\S]{0,240}isMobile \? null :/);
    expect(app).toMatch(/wsettingsOpen \?[\s\S]{0,160}isMobile \? null :/);
  });

  it('section views carry the ← back target only at mobile (desktop col-2/col-3 untouched)', () => {
    expect(app.match(/onBack=\{isMobile/g)?.length).toBe(2);
  });
});

describe('shell.css — the mobile settings list contract (U5, stylesheet pin)', () => {
  it('the ≥44px rows live inside the ≤767px block only', () => {
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    // Exactly one definition block, inside the mobile breakpoint.
    expect(css.split('.settings-list-row {').length - 1).toBe(1);
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 767px)'));
    const desktopHead = css.slice(0, css.indexOf('@media (max-width: 767px)'));
    expect(desktopHead).not.toContain('.settings-list-row');
    const rowRule = mobileBlock.slice(mobileBlock.indexOf('.settings-list-row {'));
    expect(rowRule).toContain('min-height: 44px');
  });
});
