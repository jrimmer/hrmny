/**
 * Navigation drawer accessibility (plan 004 M5, R18).
 *
 * R18's automated half for the drawer surface: every control the drawer
 * exposes has an accessible name, every tappable target reaches the 44pt
 * floor, the reading order is the rendered DOM order, and the layer is the
 * modal surface (nothing behind it is reachable). The floor technique is
 * copied from `messages/__tests__/MessageRow.test.tsx`; the shell rendering
 * idiom from `shell.test.tsx`.
 *
 * Scope honesty: these are automated checks over the rendered tree. R18's
 * human half — a VoiceOver/TalkBack walkthrough of the primary flows without a
 * dead end — is NOT covered here and stays a manual acceptance step.
 */
import { render, screen, within } from '@testing-library/react-native';

import { NavigationDrawer } from '../NavigationDrawer';
import { ShellProvider, useShell } from '../ShellContext';
import { SurfaceScaffold } from '../SurfaceScaffold';
import { resetSurfaceStates } from '../shellState';
import { IDS, press, resetShellStore, seedShellStore } from './support';

/** Flatten a (possibly array) RN style prop into a plain object. */
function styleOf(element: { props: { style?: unknown } }): Record<string, unknown> {
  return Object.assign(
    {},
    ...([] as unknown[])
      .concat(element.props.style ?? [])
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      ),
  );
}

/**
 * The accessible name the surface set on a control. Every control under test
 * sets one explicitly; a missing name fails loudly rather than silently
 * reordering a control that has no name to read.
 */
function namedLabelOf(element: { props: Record<string, unknown> }): string {
  const label = element.props['aria-label'] ?? element.props.accessibilityLabel;
  if (typeof label !== 'string' || label === '') {
    throw new Error('control without an explicit accessible label — see the name assertions');
  }
  return label;
}

/** A minimal surface: the shell's frame with the drawer trigger. */
function TestSurface() {
  const shell = useShell();
  return <SurfaceScaffold testID="test-surface" title="Home" onOpenDrawer={shell.openDrawer} />;
}

/** Mount the shell and open the drawer through its title-bar trigger. */
async function renderDrawerOpen() {
  await render(
    <ShellProvider routePath="/" drawer={<NavigationDrawer />} onNavigate={jest.fn()} onPush={jest.fn()}>
      <TestSurface />
    </ShellProvider>,
  );
  await press(screen.getByLabelText('Open navigation'));
  return screen.getByTestId('navigation-drawer');
}

/**
 * Every control the drawer renders, in the order it renders them. The
 * workspace rows carry their unread rollup in the label (the strip announces
 * "name, N unread" in one stop), and the channel rows carry unread + mentions.
 */
const DRAWER_CONTROLS = [
  { testID: 'drawer-home', name: 'Home' },
  { testID: `drawer-workspace-${IDS.ws1}`, name: 'JMC, 3 unread' },
  // The selected workspace's channels hang indented beneath it (2026-09-19
  // rework): the channel rows render between the two workspaces now.
  { testID: `drawer-channel-${IDS.general}`, name: 'general' },
  { testID: `drawer-channel-${IDS.random}`, name: 'random, 3 unread, 1 mentions' },
  { testID: `drawer-workspace-${IDS.ws2}`, name: 'Starbug' },
  { testID: 'user-panel-settings', name: 'User settings' },
  { testID: 'drawer-diagnostics', name: 'Diagnostics' },
] as const;

beforeEach(() => {
  resetShellStore();
  resetSurfaceStates();
  seedShellStore();
});

afterEach(() => {
  resetShellStore();
  resetSurfaceStates();
});

describe('navigation drawer — R18', () => {
  it('gives every control an accessible name', async () => {
    await renderDrawerOpen();

    for (const control of DRAWER_CONTROLS) {
      const element = screen.getByTestId(control.testID);
      expect(element).toHaveAccessibleName(control.name);
      // `getByRole` is the same contract seen from the query side: the control
      // is reachable by role + name, not just carrying a label prop.
      expect(screen.getByRole('button', { name: control.name })).toBe(element);
    }
  });

  it('meets the 44pt floor on every tappable target', async () => {
    await renderDrawerOpen();

    for (const control of DRAWER_CONTROLS) {
      const flattened = styleOf(screen.getByTestId(control.testID));
      expect(flattened.minHeight).toBeGreaterThanOrEqual(44);
    }

    // The scrim is a full-screen overlay — its target IS the viewport, so it
    // is checked for a name (above) and not for a 44pt minimum.
  });

  it('reads in rendered order: dismiss, workspaces, channels, identity, dev entry', async () => {
    const drawer = await renderDrawerOpen();

    // Inside the drawer content: workspace strip (Home + workspaces with
    // their channels) → user panel → dev-only diagnostics entry. The ✕ left
    // with the 2026-09-19 rework: scrim tap or a selection dismisses.
    expect(within(drawer).getAllByRole('button').map(namedLabelOf)).toEqual(
      DRAWER_CONTROLS.map((control) => control.name),
    );

    // The layer renders the scrim before the panel, so the modal's dismiss
    // affordance is the first stop — the same order the tree produces.
    expect(screen.getAllByRole('button').map(namedLabelOf)).toEqual([
      'Dismiss navigation',
      ...DRAWER_CONTROLS.map((control) => control.name),
    ]);
  });

  it('is the modal surface: the scrim is the exit and the surface behind is unreachable', async () => {
    await renderDrawerOpen();

    expect(screen.getByTestId('drawer-layer').props.accessibilityViewIsModal).toBe(true);
    expect(screen.getByLabelText('Dismiss navigation')).toHaveAccessibleName();

    // Everything behind an open drawer leaves the accessibility tree — the
    // surface's own title-bar trigger is not a stop while the drawer is up.
    expect(screen.queryByLabelText('Open navigation')).toBeNull();
  });

  it('announces ONE selection: the active workspace, never Home beside it', async () => {
    await renderDrawerOpen();

    // The drawer seeds its single selection with the active workspace — its
    // channels hang beneath it. Home lights up only after being chosen.
    expect(screen.getByTestId('drawer-home').props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(screen.getByTestId(`drawer-workspace-${IDS.ws1}`).props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByTestId(`drawer-workspace-${IDS.ws2}`).props.accessibilityState).toMatchObject({
      selected: false,
    });
  });
});
