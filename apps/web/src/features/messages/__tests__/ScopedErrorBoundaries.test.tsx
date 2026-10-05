/**
 * @cytale/web — scoped error boundaries at the shell's volatile panes
 * (hardening plan 7.4).
 *
 * The app-shell boundary's recovery is a reload: a render throw in a rail
 * tab, the settings pane or the call panel used to cost the SESSION, the
 * draft, the scroll position and the route. 7.4 mounts the same
 * `ListErrorBoundary` (identical remount-cap semantics) at each of those
 * mount sites, so the blast radius is the pane alone.
 *
 * Each test throws from INSIDE the child the mount site renders and then
 * asserts two things at once:
 *   * the pane's own fallback appeared (`<scope>-crash-fallback`), and
 *   * the shell did NOT: the surrounding chrome and the sibling session
 *     marker are still mounted, and `AppErrorBoundary`'s reload-only
 *     fallback (`app-error-fallback`) never rendered.
 * The AppErrorBoundary wrapper is the honest "shell survives" witness — if
 * the scoped boundary failed to contain the throw, that is what would show.
 *
 * The call-panel test makes `CallPanel`'s own first hook throw (via a module
 * mock), rather than feeding the boundary a throwing child directly, so it
 * proves the BOUNDARY IS WIRED INTO `CallPanelSurface`, not merely that a
 * boundary can contain a throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// CallPanel must throw from its own render body; `useCallEngineState` is its
// first hook. The rest of the module stays real (other consumers import it).
vi.mock('../../calls/useCall.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../calls/useCall.js')>();
  return {
    ...actual,
    useCallEngineState: () => {
      throw new Error('call engine exploded');
    },
  };
});

import { ContextRail } from '../../../app/layout/ContextRail.js';
import { SettingsPane } from '../../settings/SettingsPane.js';
import { CallPanelSurface } from '../../calls/CallPanel.js';
import { AppErrorBoundary } from '../../observability/AppErrorBoundary.js';
import { clientErrors } from '../../observability/clientErrors.js';

/** A pane child that throws on every render (drives the remount cap). */
function Boom(): React.ReactElement {
  throw new Error('pane exploded');
}

/** The surrounding shell: whatever lives here must survive a pane crash. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div data-testid="shell-rail">workspace rail</div>
      <div data-testid="shell-session">session alive</div>
      {children}
    </div>
  );
}

function renderInShell(child: React.ReactNode) {
  return render(
    <AppErrorBoundary onError={vi.fn()}>
      <Shell>{child}</Shell>
    </AppErrorBoundary>,
  );
}

/** The shell survived: its chrome is mounted and no reload fallback showed. */
function expectShellAlive(): void {
  expect(screen.getByTestId('shell-rail')).toBeTruthy();
  expect(screen.getByTestId('shell-session')).toBeTruthy();
  expect(screen.queryByTestId('app-error-fallback')).toBeNull();
}

beforeEach(() => {
  // React logs caught errors (and its concurrent-render recovery reports the
  // abandoned attempt through window.reportError); both are noise here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('reportError', vi.fn());
  // The mount sites use the shared reporter; a crash must not try to POST.
  vi.spyOn(clientErrors, 'captureThrown').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('scoped error boundaries (7.4)', () => {
  it('a rail tab that throws costs the tab, not the shell — and a tab switch gets a fresh cap', () => {
    const { rerender } = renderInShell(
      <ContextRail
        tabs={[
          {
            id: 'members',
            label: 'Members',
            testId: 'rail-tab-members',
            icon: <span />,
            content: <Boom />,
          },
          {
            id: 'calls',
            label: 'Call log',
            testId: 'rail-tab-calls',
            icon: <span />,
            content: <div data-testid="calls-ok">call log</div>,
          },
        ]}
        active="members"
      />,
    );

    // The rail's own fallback took over; the shell and session did not.
    expect(screen.getByTestId('rail-crash-fallback')).toBeTruthy();
    expectShellAlive();
    // The rail chrome itself survives too (search toggle lives in the header).
    expect(screen.getByTestId('context-rail')).toBeTruthy();

    // Switching tabs mounts a fresh boundary (keyed by tab id), so the OTHER
    // tab renders normally instead of inheriting the exhausted cap.
    rerender(
      <AppErrorBoundary onError={vi.fn()}>
        <Shell>
          <ContextRail
            tabs={[
              {
                id: 'members',
                label: 'Members',
                testId: 'rail-tab-members',
                icon: <span />,
                content: <Boom />,
              },
              {
                id: 'calls',
                label: 'Call log',
                testId: 'rail-tab-calls',
                icon: <span />,
                content: <div data-testid="calls-ok">call log</div>,
              },
            ]}
            active="calls"
          />
        </Shell>
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('calls-ok')).toBeTruthy();
    expect(screen.queryByTestId('rail-crash-fallback')).toBeNull();
    expectShellAlive();
  });

  it('a settings section that throws costs the section, not the shell', () => {
    renderInShell(
      <SettingsPane title="Account" onClose={() => {}}>
        <Boom />
      </SettingsPane>,
    );

    expect(screen.getByTestId('settings-crash-fallback')).toBeTruthy();
    // The pane's frame (header, title, close affordance) is still there: the
    // reader can navigate away without a reload.
    expect(screen.getByTestId('settings-pane')).toBeTruthy();
    expect(screen.getByTestId('settings-pane-title').textContent).toBe('Account');
    expect(screen.getByTestId('settings-close')).toBeTruthy();
    expectShellAlive();
  });

  it('a call panel that throws costs the panel, not the shell (dock geometry stays)', () => {
    renderInShell(<CallPanelSurface channelId="7300000000000000100" forceMobile={false} />);

    expect(screen.getByTestId('call-crash-fallback')).toBeTruthy();
    // The dock is outside the guarded subtree, so the shell's layout slot is
    // still there for the remount / Try again to land in.
    expect(screen.getByTestId('call-dock')).toBeTruthy();
    expectShellAlive();
  });
});
