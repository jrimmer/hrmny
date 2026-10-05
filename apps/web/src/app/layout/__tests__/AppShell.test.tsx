/**
 * @cytale/web — U18 acceptance coverage.
 *
 * Red-first history: written before AppShell/Theme existed and observed
 * failing (import resolution + matchMedia). Now the unit's regression net.
 *
 * Media-query contract: jsdom has no layout engine; `src/test/setup.ts`
 * installs a matchMedia stub whose shared state `mobileWidthState` the
 * mobile-collapse tests flip to simulate a phone viewport.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { AppShell } from '../AppShell';
import { WorkspaceRail } from '../WorkspaceRail';
import { WorkspaceSwitcher } from '../../../features/channels/WorkspaceSwitcher';
import { mobileWidthState } from '../../../test/setup';

const WEB_ROOT = join(__dirname, '..', '..', '..', '..');

// The shell OWNS the four region landmarks (named nav/main/aside); the
// injected props are region CONTENT — plain nodes with content-level testids.
const railContent = <div data-testid="workspace-rail-content" />;
const sidebarContent = <div data-testid="channel-sidebar-content" />;
const paneContent = <div data-testid="message-pane-content" />;
const membersContent = <div data-testid="member-list-content" />;

/**
 * The 4th column is HIDDEN until a rail icon selects a mode (owner direction
 * 2026-09-12 — "always start hidden", no persistence). So the default helper
 * opens one: the region tests below are about what is IN the column, and the
 * closed-by-default contract has its own test.
 */
const OPEN_MEMBERS = { railMode: 'members' } as const;

/**
 * Desktop opens a mode so the region tests can assert the column's contents.
 * MOBILE MUST NOT: an open column at mobile is a MODAL drawer, which makes the
 * rest of the shell aria-hidden — so every other lookup in those tests (the ☰
 * trigger, the topbar) would fail for a reason that has nothing to do with what
 * they assert. Mobile tests that want the drawer open pass the mode themselves.
 */
const railDefaults = () => (mobileWidthState.mobile ? {} : OPEN_MEMBERS);

function renderShell() {
  return render(
      <AppShell
        workspaceRail={railContent}
        channelSidebar={sidebarContent}
        messagePane={paneContent}
        railContent={membersContent}
        {...railDefaults()}
      />
  );
}

/**
 * A host that owns the mode, the way AuthenticatedApp does. The shell DELEGATES
 * the toggle (the host needs the mode to pick the column's content), so a
 * standalone render with no host toggle has icons that cannot open anything —
 * which is what these tests hit when the trigger became the icon cluster.
 */
function ShellHost(props: Partial<Parameters<typeof AppShell>[0]>) {
  const [mode, setMode] = useState<'members' | 'calls' | 'threads' | null>(null);
  return (
    <AppShell
      workspaceRail={railContent}
      channelSidebar={sidebarContent}
      messagePane={paneContent}
      railContent={membersContent}
      railMode={mode}
      onRailSelect={(m) => setMode((cur) => (cur === m ? null : m))}
      {...props}
    />
  );
}

function renderShellWith(props: Partial<Parameters<typeof AppShell>[0]>) {
  return render(
      <AppShell
        workspaceRail={railContent}
        channelSidebar={sidebarContent}
        messagePane={paneContent}
        railContent={membersContent}
        {...railDefaults()}
        {...props}
      />
  );
}

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
});

describe('AppShell — 4-region desktop layout', () => {
  it('renders all 4 regions at desktop width', () => {
    renderShell();
    expect(screen.getByTestId('workspace-rail')).toBeTruthy();
    expect(screen.getByTestId('channel-sidebar')).toBeTruthy();
    expect(screen.getByTestId('message-pane')).toBeTruthy();
    expect(screen.getByTestId('member-list')).toBeTruthy();
  });

  it('applies the dark-default theme to the document root', () => {
    renderShell();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('AppShell — states-first DoD', () => {
  it('loading state: skeleton shell with progressbar announced', () => {
    renderShellWith({ loading: true });
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByTestId('app-shell').getAttribute('data-state')).toBe('loading');
  });

  it('empty channels state: sidebar announces the empty condition', () => {
    renderShellWith({ channelSidebarEmpty: true });
    expect(screen.getByTestId('channel-sidebar-empty')).toBeTruthy();
  });

  it('error state: sidebar announces the failure via alert role', () => {
    renderShellWith({ channelSidebarError: 'Failed to load channels' });
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load/i);
  });

  it('offline state: a status banner announces offline mode', () => {
    renderShellWith({ offline: true });
    expect(screen.getByRole('status').textContent).toMatch(/offline/i);
  });

  it('view-only state: the pane explains send is unavailable', () => {
    renderShellWith({ viewOnly: true });
    expect(screen.getByTestId('view-only-note').textContent).toMatch(/view-only/i);
  });

  it('permission-denied state: the pane renders an alert instead of messages', () => {
    renderShellWith({ permissionDenied: 'You need the View Channels permission.' });
    const pane = screen.getByTestId('message-pane');
    expect(pane.getAttribute('data-permission-denied')).toBe('true');
    expect(screen.getByTestId('permission-denied').textContent).toMatch(/permission/i);
  });
});

describe('AppShell — responsive collapse (mobile width)', () => {
  it('sidebar collapses out of the tree and returns via the drawer trigger', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    renderShell();
    // collapsed: static sidebar region is gone; hamburger present
    expect(screen.queryByTestId('channel-sidebar')).toBeNull();
    const toggle = screen.getAllByRole('button', { name: /open navigation/i })[0]!;
    await userEvent.setup().click(toggle);
    // drawer carries the channels nav, focus-trapped by Radix
    expect(screen.getByRole('dialog', { name: 'Channels' })).toBeTruthy();
    expect(screen.getByTestId('channel-sidebar-content')).toBeTruthy();
  });

  it('workspace rail unmounts at mobile width (folds into the drawer); member list becomes an overlay', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    render(<ShellHost />);
    // U1/B2: the rail no longer exists at mobile — no fixed 72px overlay.
    expect(screen.queryByTestId('workspace-rail')).toBeNull();
    expect(screen.queryByTestId('workspace-rail-content')).toBeNull();
    expect(screen.queryByTestId('member-list')).toBeNull();
    const membersTrigger = screen.getByTestId('rail-icon-members');
    await userEvent.setup().click(membersTrigger);
    expect(screen.getByRole('dialog', { name: 'Members' })).toBeTruthy();
  });
});

describe('AppShell — mobile shell chrome v2 (U1: topbar, contained triggers, rail in drawer)', () => {
  // Minimal Workspace fixture for the strip test (Snowflake ids are strings).
  const makeWorkspace = (id: string, name: string) => ({
    id,
    name,
    owner_id: '9000000000000001',
    role_version: 1,
    created_at: '2026-01-01T00:00:00Z',
  });

  function renderShellWithRail(rail: React.ReactNode) {
    return render(
      <AppShell
        workspaceRail={rail}
        channelSidebar={sidebarContent}
        messagePane={paneContent}
        railContent={membersContent}
      />,
    );
  }

  it('☰ and 👥 triggers render inside the topbar region as constrained controls — never direct shell children', () => {
    mobileWidthState.mobile = true;
    const { container } = renderShell();
    const shell = screen.getByTestId('app-shell');
    const topbar = screen.getByTestId('mobile-topbar');
    expect(topbar.className).toContain('mobile-topbar');

    const navTrigger = screen.getAllByRole('button', { name: /open navigation/i })[0]!;
    const membersTrigger = screen.getByTestId('rail-icon-members');
    // Contained: both controls live inside the topbar band.
    expect(topbar.contains(navTrigger)).toBe(true);
    expect(topbar.contains(membersTrigger)).toBe(true);

    // B1 regression net: the triggers must NOT be direct children of the
    // 1-column shell (grid-stretched invisible full-width tap blocks).
    const shellChildren = Array.from(shell.children);
    expect(shellChildren.includes(navTrigger)).toBe(false);
    expect(shellChildren.includes(membersTrigger)).toBe(false);
    expect(container.querySelectorAll('.shell > button')).toHaveLength(0);

    // Bounded-size contract, pinned at the stylesheet (jsdom has no layout):
    // fixed-height bar, 44×44 inline-flex actions.
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const barRule = css.slice(css.indexOf('.mobile-topbar {'));
    expect(barRule).toContain('height: 48px');
    const actionRule = css.slice(css.indexOf('.mobile-topbar-action'));
    expect(actionRule).toContain('display: inline-flex');
    expect(actionRule).toContain('width: 44px');
    expect(actionRule).toContain('height: 44px');
  });

  it('the mobile rail fix is gone from the stylesheet — no fixed .shell > .rail overlay', () => {
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    expect(css).not.toContain('.shell > .rail');
  });

  it('the drawer carries the workspace strip (Home + workspaces); selecting a workspace closes the drawer', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    const onSelect = vi.fn();
    renderShellWithRail(
      <WorkspaceRail>
        <button type="button" className="rail-home" aria-label="Home">
          Home
        </button>
        <WorkspaceSwitcher
          workspaces={[makeWorkspace('9100000000000001', 'Acme'), makeWorkspace('9100000000000002', 'Globex')]}
          activeWorkspaceId="9100000000000001"
          onSelect={onSelect}
        />
      </WorkspaceRail>,
    );

    // Rail content absent while closed; open the drawer and the strip rides
    // above the channel list.
    expect(screen.queryByTestId('workspace-9100000000000001')).toBeNull();
    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: /open navigation/i })[0]!);
    const drawer = screen.getByRole('dialog', { name: 'Channels' });
    const strip = screen.getByTestId('drawer-workspace-strip');
    expect(drawer.contains(strip)).toBe(true);
    expect(drawer.contains(screen.getByTestId('channel-sidebar-content'))).toBe(true);
    expect(strip.compareDocumentPosition(screen.getByTestId('channel-sidebar-content')) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(drawer.contains(screen.getByRole('button', { name: 'Home' }))).toBe(true);
    expect(drawer.contains(screen.getByTestId('workspace-9100000000000002'))).toBe(true);

    // Selecting a workspace fires the switch AND closes the drawer.
    await userEvent.click(screen.getByTestId('workspace-9100000000000002'));
    expect(onSelect).toHaveBeenCalledWith('9100000000000002');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Channels' })).toBeNull(),
    );
  });

  it('the pane fills the height between topbar and viewport bottom (growing child of the mobile column)', () => {
    mobileWidthState.mobile = true;
    renderShell();
    const shell = screen.getByTestId('app-shell');
    const topbar = screen.getByTestId('mobile-topbar');
    const pane = screen.getByTestId('message-pane');
    const children = Array.from(shell.children);
    expect(children.includes(topbar)).toBe(true);
    expect(children.includes(pane)).toBe(true);
    expect(children.indexOf(topbar)).toBeLessThan(children.indexOf(pane));

    // Layout contract pinned at the stylesheet: the mobile shell is a column
    // whose pane is the one growing child.
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(mobileBlock).toContain('flex-direction: column');
    expect(mobileBlock).toContain('.shell > .pane');
    const paneRule = css.slice(css.indexOf('.shell > .pane'));
    expect(paneRule).toContain('flex: 1');
  });

  it('desktop: no topbar mounts (the left-cluster composition is untouched)', () => {
    renderShell();
    expect(screen.queryByTestId('mobile-topbar')).toBeNull();
    expect(screen.getByTestId('left-cluster')).toBeTruthy();
    expect(screen.getByTestId('workspace-rail')).toBeTruthy();
  });

  // U4 pin: the view-only note must stay readable at mobile — it renders as
  // the pane's trailing child above the bottom-anchored composer, and the
  // composer full-bleed CSS must not unhook it.
  it('view-only note renders inside the pane at mobile width', () => {
    mobileWidthState.mobile = true;
    renderShellWith({ viewOnly: true });
    const pane = screen.getByTestId('message-pane');
    const note = screen.getByTestId('view-only-note');
    expect(note.textContent).toMatch(/view-only/i);
    expect(pane.contains(note)).toBe(true);
  });

  it('the integrations affordance is GONE from every surface (owner direction 2026-09-14)', () => {
    const app = readFileSync(join(WEB_ROOT, 'src', 'AuthenticatedApp.tsx'), 'utf8');
    // This replaces the inverse pin ("exactly one Integrations affordance —
    // consolidated into the strip"), which asserted a surface that no longer
    // exists: the rail button, its `#/integrations/:pane` overlay and the
    // workspace menu's Integrations item are all removed, and the two panes
    // are user-settings sections now (plan 2026-09-15-1200, KD1).
    //
    // The replacement is a real assertion rather than a deletion because
    // "removed" is the contract the owner asked for, and an affordance that
    // creeps back — a stray rail button, a second entry in the workspace menu
    // — is exactly the duplication this removed.
    expect(app).not.toContain('data-testid="rail-integrations"');
    expect(app).not.toContain('onOpenIntegrations');
    expect(app).not.toContain('useIntegrationsRoute');
    expect(app).not.toContain('IntegrationsPanel');
    // The drawer footer itself is back (2026-09-27) carrying ONLY the version
    // badge — the release-notes link phones otherwise cannot reach. The pin is
    // on what it carries, not on the slot.
    expect(app).toContain('drawerFooter={<VersionBadge />}');
    expect(app).not.toContain('data-testid="drawer-integrations"');
    // …and the surface it became is reachable: both sections are mounted by
    // the settings pane's body.
    expect(app).toContain('<AgentsSection');
    expect(app).toContain('<WebhooksSection');
  });

  it('axe: the mobile topbar chrome has no violations', async () => {
    mobileWidthState.mobile = true;
    const { container } = renderShell();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AppShell — header actions and voice reach mobile (U2)', () => {
  it('mobileTitle fills the topbar title slot at mobile width', () => {
    mobileWidthState.mobile = true;
    renderShellWith({ mobileTitle: 'general' });
    const title = screen.getByTestId('mobile-topbar').querySelector('.mobile-topbar-title');
    expect(title?.textContent).toBe('general');
  });

  it('mobileNavIcon replaces the ☰ glyph in the nav trigger (2026-09-18 topbar rework)', () => {
    mobileWidthState.mobile = true;
    renderShellWith({
      mobileNavIcon: <img src="/ws.png" alt="" data-testid="ws-icon-face" />,
    });
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    expect(trigger.querySelector('[data-testid="ws-icon-face"]')).toBeTruthy();
    // The face is wrapped so the squircle sizing cannot leak onto the trigger plate.
    expect(trigger.querySelector('.mobile-topbar-ws')).toBeTruthy();
  });

  it('without mobileNavIcon the nav trigger falls back to the ☰ glyph', () => {
    mobileWidthState.mobile = true;
    renderShellWith({});
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    expect(trigger.textContent).toBe('☰');
    expect(trigger.querySelector('.mobile-topbar-ws')).toBeNull();
  });

  it('mobileCallAction renders inside the topbar band — a contained control, never a direct shell child', () => {
    mobileWidthState.mobile = true;
    const { container } = renderShellWith({
      mobileCallAction: <button type="button" data-testid="topbar-call-slot" />,
    });
    const shell = screen.getByTestId('app-shell');
    const topbar = screen.getByTestId('mobile-topbar');
    const action = screen.getByTestId('topbar-call-slot');
    expect(topbar.contains(action)).toBe(true);
    // B1 regression net applies to the call action too.
    expect(Array.from(shell.children).includes(action)).toBe(false);
    expect(container.querySelectorAll('.shell > button')).toHaveLength(0);
  });

  it('desktop width: neither the topbar nor its call action mounts (pane header is the only header)', () => {
    renderShellWith({
      mobileTitle: 'general',
      mobileCallAction: <button type="button" data-testid="topbar-call-slot" />,
    });
    expect(screen.queryByTestId('mobile-topbar')).toBeNull();
    expect(screen.queryByTestId('topbar-call-slot')).toBeNull();
  });

  it('ONE title bar at mobile: the stylesheet suppresses the in-pane channel header below 768px (DM headers exempt)', () => {
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const selector = "[data-testid='channel-header']:not([data-dm])";
    // The suppression exists exactly once, and only inside the mobile block.
    expect(css.split(selector).length - 1).toBe(1);
    expect(css.indexOf(selector)).toBeGreaterThan(css.indexOf('@media (max-width: 767px)'));
  });
});

describe('AppShell — user panel (column-2 footer) + rail footer', () => {
  const userPanelContent = <div data-testid="user-panel-content" />;
  const railFooterContent = <div data-testid="rail-footer-content">v1a2b3c4</div>;

  it('desktop: renders the panel under the SIDEBAR column only', () => {
    renderShellWith({ userPanel: userPanelContent });
    const cluster = screen.getByTestId('left-cluster');
    expect(screen.getByTestId('user-panel-region')).toBeTruthy();
    expect(screen.getByTestId('user-panel-content')).toBeTruthy();
    // the cluster owns rail + sidebar + panel
    expect(cluster.contains(screen.getByTestId('workspace-rail'))).toBe(true);
    expect(cluster.contains(screen.getByTestId('channel-sidebar'))).toBe(true);
    // and the panel is NOT inside the rail's column container
    expect(
      screen.getByTestId('workspace-rail').contains(screen.getByTestId('user-panel-region')),
    ).toBe(false);
    expect(
      screen.getByTestId('channel-sidebar').contains(screen.getByTestId('user-panel-region')),
    ).toBe(false);
  });

  it('desktop: the panel region spans the sidebar track only (column 2)', () => {
    // jsdom does not lay out grid tracks, so the placement contract is pinned
    // in the stylesheet: grid-area 2/2/3/3 = row 2, column 2 — never 1/3.
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const rule = css.slice(css.indexOf('.user-panel-region'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('grid-area: 2 / 2 / 3 / 3;');
  });

  it('desktop: railFooter renders in column 1, absent without the prop', () => {
    renderShellWith({ railFooter: railFooterContent });
    const footer = screen.getByTestId('rail-footer');
    expect(footer.textContent).toContain('v1a2b3c4');
    expect(screen.getByTestId('left-cluster').contains(footer)).toBe(true);
    // the rail's own footer is NOT the sidebar's column
    expect(
      screen.getByTestId('channel-sidebar').contains(footer),
    ).toBe(false);

    cleanup();
    renderShell();
    expect(screen.queryByTestId('rail-footer')).toBeNull();
  });

  it('desktop: the rail footer spans the rail track only (column 1)', () => {
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const rule = css.slice(css.indexOf('.rail-footer {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('grid-area: 2 / 1 / 3 / 2;');
  });

  it('desktop: without the panel prop the region is absent', () => {
    renderShell();
    expect(screen.queryByTestId('user-panel-region')).toBeNull();
  });

  it('mobile: the panel rides the drawer', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    renderShellWith({ userPanel: userPanelContent });
    await userEvent.setup().click(screen.getAllByRole('button', { name: /open navigation/i })[0]!);
    expect(screen.getByTestId('drawer-user-panel')).toBeTruthy();
    expect(screen.getByTestId('user-panel-content')).toBeTruthy();
  });
});

describe('AppShell — settings entries close the drawer (U5)', () => {
  // U5: the settings surfaces' mobile lists live in the PANE (full-width),
  // so their drawer-borne entries — the user panel's gear and the workspace
  // menu's Workspace Settings item — must close the drawer on activation
  // (the workspace strip's select-closes idiom), or the open drawer covers
  // the surface they just opened.
  it('the user panel gear closes the drawer', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    renderShellWith({
      userPanel: (
        <button type="button" data-testid="user-settings-toggle" data-drawer-close>
          ⚙
        </button>
      ),
    });
    await userEvent.setup().click(screen.getAllByRole('button', { name: /open navigation/i })[0]!);
    expect(screen.getByRole('dialog', { name: 'Channels' })).toBeTruthy();
    await userEvent.click(screen.getByTestId('user-settings-toggle'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Channels' })).toBeNull(),
    );
  });

  it('the workspace-menu settings item closes the drawer', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    renderShellWith({
      channelSidebar: (
        <button type="button" data-testid="workspace-menu-settings" data-drawer-close>
          Workspace Settings
        </button>
      ),
    });
    await userEvent.setup().click(screen.getAllByRole('button', { name: /open navigation/i })[0]!);
    expect(screen.getByRole('dialog', { name: 'Channels' })).toBeTruthy();
    await userEvent.click(screen.getByTestId('workspace-menu-settings'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Channels' })).toBeNull(),
    );
  });

  it('other drawer content keeps the drawer open (presence picker stays hosted)', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    renderShellWith({
      userPanel: (
        <button type="button" data-testid="user-panel-status-trigger">
          status
        </button>
      ),
    });
    await userEvent.setup().click(screen.getAllByRole('button', { name: /open navigation/i })[0]!);
    await userEvent.click(screen.getByTestId('user-panel-status-trigger'));
    expect(screen.getByRole('dialog', { name: 'Channels' })).toBeTruthy();
  });
});

describe('AppShell — bottom baseline (panel ↔ composer ↔ badge)', () => {
  // The user panel card, the message composer well, and the rail's version
  // badge share ONE bottom line 12px above the window edge (user ask
  // 2026-09-10: the entry box sat a bit above the panel and looked awkward).
  // jsdom has no layout engine, so each constant is pinned where it lives.
  const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');

  it('the panel card bottoms out 12px above the edge (4px region padding + 8px card margin)', () => {
    const region = css.slice(css.indexOf('.user-panel-region {'));
    expect(region.slice(0, region.indexOf('}'))).toContain('padding: 0 0 4px;');
    const card = css.slice(css.indexOf('\n.user-panel {'));
    // Sides 12px (owner, 2026-09-27: clear of the column's edges); the 8px
    // bottom is what the baseline depends on.
    expect(card.slice(0, card.indexOf('}'))).toContain('margin: 0 12px 8px;');
  });

  it('the rail footer carries the same 12px inset for the badge', () => {
    const rule = css.slice(css.indexOf('.rail-footer {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('padding: 4px 2px 12px;');
  });

  it('the composer wrapper keeps the 12px bottom and the 16px row gutter (owner direction 2026-09-27)', () => {
    const src = readFileSync(
      join(WEB_ROOT, 'src', 'features', 'messages', 'MessageCompose.tsx'),
      'utf8',
    );
    const marker = 'data-testid="message-compose"';
    const wrapper = src.slice(Math.max(0, src.indexOf(marker) - 300), src.indexOf(marker));
    // What the two tests above pin is the VERTICAL pair: 12px above the edge
    // (4px region padding + 8px card margin) under the status card, and
    // Tailwind pb-3 on this wrapper — the same 12px, so the well's bottom edge
    // and the card's bottom edge sit on one line. The owner kept exactly that
    // alignment when the surround went (2026-09-14, which also dropped an 8px
    // side inset). On 2026-09-27 the owner found the well "smashed up against
    // the border" and asked for a gutter back: px-4, the message rows' own
    // 16px, so the well lines up with the text above it.
    expect(wrapper).toContain('pb-3');
    expect(wrapper).toContain('px-4');
  });
});

describe('AppShell — col-3 pane wash direction', () => {
  const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');

  it('darkens toward the RIGHT (gray into black), ending at 80% of the column', () => {
    // The pane is the gray surface (#1a1a1e) carrying the wash. It used to sit
    // on the LEFT edge (black→gray left-to-right, a Discord observation); the
    // user reversed it, then widened it — the ramp spans the whole column and
    // reaches full black at 80%, holding it to the right edge. The variable is
    // the contract (two surfaces paint it); jsdom has no layout engine.
    const vars = css.slice(css.indexOf(':root {'));
    const wash = vars.slice(vars.indexOf('--pane-wash:'), vars.indexOf(';', vars.indexOf('--pane-wash:')));
    expect(wash).toContain('rgba(0, 0, 0, 0),'); // transparent (pane gray) at the left
    expect(wash).toContain('rgba(0, 0, 0, 0.22) 80%'); // black at 80% of the column

    const pane = css.slice(css.indexOf('.pane::before {'));
    expect(pane.slice(0, pane.indexOf('}'))).toContain('background: var(--pane-wash);');
  });
});

describe('AppShell — members-hidden (Home surface)', () => {
  it('desktop: drops the members region and flags the shell', () => {
    renderShellWith({ railHidden: true });
    expect(screen.queryByTestId('member-list')).toBeNull();
    expect(screen.getByTestId('app-shell').className).toContain('shell--no-members');
  });

  it('mobile: hides the members trigger too', () => {
    mobileWidthState.mobile = true;
    renderShellWith({ railHidden: true });
    // When the rail is force-hidden (settings takeover, an open thread) the
    // icons stand down WITH it: they are the only way in, so leaving them would
    // offer a control that opens a surface the host has suppressed.
    expect(screen.queryByTestId('rail-icon-members')).toBeNull();
    expect(screen.queryByTestId('member-list')).toBeNull();
  });
});

describe('AppShell — the phone drawer opens only on a tap (live suite 2026-09-29)', () => {
  /** A host whose mode starts SET — the desktop default, or one remembered from a wider band. */
  function PresetHost({ initial }: { initial: 'members' | 'calls' | 'threads' }) {
    const [mode, setMode] = useState<'members' | 'calls' | 'threads' | null>(initial);
    return (
      <AppShell
        workspaceRail={railContent}
        channelSidebar={sidebarContent}
        messagePane={paneContent}
        railContent={membersContent}
        railMode={mode}
        onRailSelect={(m) => setMode((cur) => (cur === m ? null : m))}
      />
    );
  }

  it('a mode already set at phone width does not open the drawer; the first tap opens it', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    render(<PresetHost initial="members" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Nothing reads as pressed while nothing is open.
    expect(screen.getByTestId('rail-icon-members').getAttribute('aria-pressed')).toBe('false');
    // The topbar is reachable (no modal made it inert).
    expect(screen.getByRole('button', { name: /open navigation/i })).toBeTruthy();

    await userEvent.setup().click(screen.getByTestId('rail-icon-members'));
    expect(screen.getByRole('dialog', { name: 'Members' })).toBeTruthy();
  });

  it('a desktop column carried across a resize to phone does not come up as a drawer', async () => {
    const { act } = await import('@testing-library/react');
    render(<PresetHost initial="members" />);
    expect(screen.getByTestId('member-list')).toBeTruthy();

    mobileWidthState.mobile = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('mobile-topbar')).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('member-list')).toBeNull();
  });

  it('tapping a DIFFERENT mode than the remembered one opens that mode', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    render(<PresetHost initial="members" />);
    await userEvent.setup().click(screen.getByTestId('rail-icon-calls'));
    expect(screen.getByRole('dialog', { name: 'Call log' })).toBeTruthy();
  });

  it('railModes limits every icon set the shell renders (Home: no Members)', () => {
    mobileWidthState.mobile = true;
    renderShellWith({ railModes: ['calls', 'threads'] });
    expect(screen.queryByTestId('rail-icon-members')).toBeNull();
    expect(screen.getByTestId('rail-icon-calls')).toBeTruthy();
    expect(screen.getByTestId('rail-icon-threads')).toBeTruthy();
  });
});

describe('AppShell — members drawer regression lock + drawer header (U6)', () => {
  it('members drawer: the dialog content carries the edge-aligned drawer classes; the scrim carries drawer-overlay', async () => {
    // M2 regression lock: the members drawer is the EDGE-ALIGNED surface
    // (`.drawer.members` — full-height, right-anchored, scrimmed), never a
    // floating centered card. Structure here; geometry in the mobile e2e.
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    render(<ShellHost />);
    await userEvent
      .setup()
      .click(screen.getByTestId('rail-icon-members'));
    const drawer = screen.getByRole('dialog', { name: 'Members' });
    expect(drawer.className).toContain('drawer');
    expect(drawer.className).toContain('members');
    expect(drawer.contains(screen.getByTestId('member-list-content'))).toBe(true);
    const overlay = document.querySelector('.drawer-overlay');
    expect(overlay).toBeTruthy();

    // Stylesheet pin (jsdom has no layout): the drawer is fixed full-height
    // and the members variant anchors it to the right edge; the scrim is a
    // fixed viewport-covering layer behind it.
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const drawerRule = css.slice(css.indexOf('.drawer {'), css.indexOf('.drawer.members'));
    expect(drawerRule).toContain('position: fixed');
    expect(drawerRule).toContain('top: 0');
    expect(drawerRule).toContain('bottom: 0');
    const membersRule = css.slice(css.indexOf('.drawer.members'));
    expect(membersRule).toContain('right: 0');
    expect(membersRule).toContain('left: auto');
    const overlayRule = css.slice(css.indexOf('.drawer-overlay'));
    expect(overlayRule).toContain('position: fixed');
    expect(overlayRule).toContain('inset: 0');
  });

  it('drawer header (m1): the ✕ sits right of the title inside a header row — structurally and at the stylesheet', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    renderShell();
    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: /open navigation/i })[0]!);
    const drawer = screen.getByRole('dialog', { name: 'Channels' });
    const header = drawer.querySelector('.drawer-header');
    const title = drawer.querySelector('.drawer-title');
    const close = drawer.querySelector('.drawer-close');
    expect(header).toBeTruthy();
    expect(title).toBeTruthy();
    expect(close).toBeTruthy();
    expect(header!.contains(title!)).toBe(true);
    expect(header!.contains(close!)).toBe(true);
    // Row order title → ✕: in the flex row the close renders at the right
    // edge (the audit's centered-✕ finding).
    expect(
      title!.compareDocumentPosition(close!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Stylesheet pin: the header is the flex row; the close is a constrained
    // control; the dead `.drawer > button[data-state]` absolute rule is GONE
    // (Radix's Dialog.Close never carried data-state, so that selector never
    // matched and the ✕ fell into the column flow stretched + centered).
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    expect(css).not.toContain('.drawer > button[data-state]');
    const headerRule = css.slice(css.indexOf('.drawer-header {'));
    expect(headerRule).toContain('display: flex');
    const titleRule = css.slice(css.indexOf('.drawer-title {'));
    expect(titleRule).toContain('flex: 1');
    const closeRule = css.slice(css.indexOf('.drawer-close {'));
    expect(closeRule).toContain('width: 44px');
    expect(closeRule).toContain('height: 44px');
  });

  it('members drawer header: the same title-left/close-right idiom', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    render(<ShellHost />);
    await userEvent
      .setup()
      .click(screen.getByTestId('rail-icon-members'));
    const drawer = screen.getByRole('dialog', { name: 'Members' });
    const header = drawer.querySelector('.drawer-header');
    const title = drawer.querySelector('.drawer-title');
    const close = drawer.querySelector('.drawer-close');
    expect(header).toBeTruthy();
    expect(title?.textContent).toBe('Members');
    expect(header!.contains(title!)).toBe(true);
    expect(header!.contains(close!)).toBe(true);
    expect(
      title!.compareDocumentPosition(close!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('the members aside is a DESKTOP column — no inline aside at mobile, whatever the lever', () => {
    mobileWidthState.mobile = true;
    renderShellWith({ memberListCollapsible: false });
    // The icons DO exist at mobile — they are the only way to open a mode. What
    // this pins is that the inline desktop ASIDE does not, whatever the lever.
    expect(screen.getByTestId('rail-icon-members')).toBeTruthy();
    expect(screen.queryByTestId('member-list')).toBeNull();
    // The inline mobile aside path is gone. `memberListCollapsible` now governs
    // only the 👥 trigger; the aside renders at desktop and nowhere else, since
    // that is the only band with a grid track for it and the only one whose
    // host does not suppress it. Home opts out in every band through
    // `railHidden` (owner direction 2026-09-12), and it was the last caller
    // of the inline path — so this pins the ABSENCE rather than a height bound.
    expect(screen.queryByTestId('member-list')).toBeNull();
  });

  it('memberListCollapsible=true (non-Home default) at mobile: the 👥 trigger still renders — not over-suppressed', () => {
    mobileWidthState.mobile = true;
    renderShellWith({ memberListCollapsible: true });
    expect(screen.getByTestId('rail-icon-members')).toBeTruthy();
  });

  it('desktop: the members aside renders regardless of the collapsible lever', () => {
    renderShellWith({ memberListCollapsible: false });
    expect(screen.getByTestId('member-list')).toBeTruthy();
  });

  it('Home is an ORDINARY case for BAND visibility — but it suppresses the column outright', () => {
    const app = readFileSync(join(WEB_ROOT, 'src', 'AuthenticatedApp.tsx'), 'utf8');
    // Two owner decisions live here, and the second overrides the first.
    //
    // 2026-09-12: visibility is owned by the rail icons, so Home needs no
    // clause of its own — Home is an ordinary case in both directions, and the
    // band picks the default (`band === 'desktop' ? 'members' : null`). That
    // rule still stands and is asserted below.
    //
    // The 2026-09-12 note ALSO said `homeActive` must never re-enter the
    // `railHidden` expression, because that is what removed Home's entire 4th
    // column and took the Call log and Threads tabs with the member list
    // (#105). The owner has since asked for the column gone anyway — same
    // sentence that named the member list as nonsense outside a room (2026-09-14:
    // "In home, col 4 doesn't make sense as I'm not in a room … the entire
    // column shouldn't be there"). So `homeActive` IS back in that expression,
    // deliberately, and this test now pins the CURRENT decision rather than
    // forbidding the old shape.
    //
    // The cost is real and is recorded here on purpose: Home no longer reaches
    // the cross-workspace Call log or the Threads-you-follow list. If those are
    // wanted back without the member list, the fix is a Home rule that drops
    // the MEMBERS tab rather than `railHidden` — not a re-litigation of this
    // line.
    //
    // 2026-09-29 (live suite): that cost is paid back exactly as prescribed.
    // Home's column is still hidden BY DEFAULT — `homeActive` hides it while
    // Home's own mode is unset — and Home never offers Members, but its band
    // opens Call log or Threads on request (`homeRailMode`), so My Threads is
    // reachable from Home again.
    expect(app).toContain("band === 'desktop' ? 'members' : null");
    expect(app).toMatch(
      /railHidden=\{\s*settingsOpen \|\| wsettingsOpen \|\| serverSettings\.open \|\| \(homeActive && homeRailMode === null\)/,
    );
    expect(app).toContain("const HOME_RAIL_MODES: readonly RailMode[] = ['calls', 'threads'];");
    expect(app).not.toContain('memberListCollapsible={!homeActive}');
  });

  it('axe: the opened drawers with the U6 header row are clean', async () => {
    mobileWidthState.mobile = true;
    const userEvent = (await import('@testing-library/user-event')).default;
    const nav = render(<ShellHost />);
    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: /open navigation/i })[0]!);
    expect(await axe(screen.getByRole('dialog', { name: 'Channels' }))).toHaveNoViolations();
    nav.unmount();

    const members = render(<ShellHost />);
    await userEvent
      .setup()
      .click(screen.getByTestId('rail-icon-members'));
    expect(await axe(screen.getByRole('dialog', { name: 'Members' }))).toHaveNoViolations();
    members.unmount();
  });
});

describe('AppShell — accessibility (WCAG 2.1 AA bar)', () => {
  it('has no axe violations at desktop width', async () => {
    const { container } = renderShell();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('regions carry accessible names for keyboard navigation', () => {
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Channels' })).toBeTruthy();
    expect(screen.getByRole('main', { name: 'Messages' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Members' })).toBeTruthy();
  });

  it('has no axe violations in the loading state', async () => {
    const { container } = renderShellWith({ loading: true });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the error + offline states', async () => {
    const { container } = renderShellWith({
      offline: true,
      channelSidebarError: 'Failed to load channels',
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
