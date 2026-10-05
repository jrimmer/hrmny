/**
 * Title bar accessibility (plan 004 M5, R18).
 *
 * R18's automated half for the ONE title bar every surface renders: the
 * navigation / back trigger, the members trigger, and the rendered-but-disabled
 * voice entry point each carry an accessible name, each reaches the 44pt floor,
 * and the reading order is the rendered DOM order (exit → title → voice →
 * members). The floor technique is copied from
 * `messages/__tests__/MessageRow.test.tsx`.
 *
 * Scope honesty: these are automated checks over the rendered tree. R18's
 * human half — a VoiceOver/TalkBack walkthrough of the primary flows without a
 * dead end — is NOT covered here and stays a manual acceptance step.
 */
import { render, screen } from '@testing-library/react-native';

import { ShellProvider } from '../ShellContext';
import { TitleBar, VOICE_UNAVAILABLE_LABEL } from '../TitleBar';
import { IDS, resetShellStore, seedShellStore } from './support';

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

/** Test ids, in the tree order the renderer produced. */
function testIdsOf(elements: { props: Record<string, unknown> }[]): string[] {
  return elements.map((element) => String(element.props.testID));
}

/** Assert a control's name, its button role, and the 44pt floor in one place. */
function expectControl(testID: string, name: string): void {
  const control = screen.getByTestId(testID);
  expect(control).toHaveAccessibleName(name);
  expect(screen.getByRole('button', { name })).toBe(control);
  expect(styleOf(control).minHeight).toBeGreaterThanOrEqual(44);
}

describe('title bar — R18', () => {
  it('drawer surfaces: nav trigger first, title, then the disabled voice slot', async () => {
    await render(<TitleBar title="Home" onOpenDrawer={jest.fn()} />);

    expectControl('title-bar-drawer', 'Open navigation');
    expectControl('title-bar-voice', VOICE_UNAVAILABLE_LABEL);
    expect(testIdsOf(screen.getAllByTestId(/^title-bar-/))).toEqual([
      'title-bar-drawer',
      'title-bar-title',
      'title-bar-voice',
    ]);
  });

  it('pushed surfaces: back first, title, then the disabled voice slot', async () => {
    await render(<TitleBar title="Thread" subtitle="Release train" onBack={jest.fn()} />);

    expectControl('title-bar-back', 'Back');
    expectControl('title-bar-voice', VOICE_UNAVAILABLE_LABEL);
    expect(testIdsOf(screen.getAllByTestId(/^title-bar-/))).toEqual([
      'title-bar-back',
      'title-bar-title',
      'title-bar-voice',
    ]);

    // The header names the surface AND its subtitle in one stop.
    const header = screen.getByLabelText('Thread, Release train');
    expect(header.props.accessibilityRole).toBe('header');
    expect(styleOf(header).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('channel surfaces: the members trigger follows voice, named for the list it opens', async () => {
    await render(
      <TitleBar title="general" subtitle="Ship it" onOpenDrawer={jest.fn()} onOpenMembers={jest.fn()} />,
    );

    expectControl('title-bar-drawer', 'Open navigation');
    expectControl('title-bar-voice', VOICE_UNAVAILABLE_LABEL);
    expectControl('title-bar-members', 'Show member list');
    expect(testIdsOf(screen.getAllByTestId(/^title-bar-/))).toEqual([
      'title-bar-drawer',
      'title-bar-title',
      'title-bar-voice',
      'title-bar-members',
    ]);
  });

  it('takes the members label from the caller when one is supplied', async () => {
    await render(
      <TitleBar
        title="general"
        onOpenDrawer={jest.fn()}
        onOpenMembers={jest.fn()}
        membersLabel="Members of #general"
      />,
    );

    expectControl('title-bar-members', 'Members of #general');
  });

  it('keeps the disabled voice entry point in the reading order, announced as disabled', async () => {
    await render(<TitleBar title="Home" onOpenDrawer={jest.fn()} />);

    const voice = screen.getByTestId('title-bar-voice');
    // Reachable by role (not hidden from assistive tech) and explicitly
    // announced as unavailable — R11's "rendered but disabled" seam.
    expect(screen.getByRole('button', { name: VOICE_UNAVAILABLE_LABEL })).toBe(voice);
    expect(voice.props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('title bar — nav-trigger face (device feedback 2442: hamburger → workspace icon)', () => {
  afterEach(() => {
    resetShellStore();
  });

  it('no shell, no active workspace: the trigger keeps the ☰ fallback face', async () => {
    await render(<TitleBar title="Home" onOpenDrawer={jest.fn()} />);

    expectControl('title-bar-drawer', 'Open navigation');
    // The face is aria-hidden (the button's label IS the meaning), so the
    // query must opt into hidden elements to see it at all.
    expect(screen.queryByTestId('title-bar-ws-icon', { includeHiddenElements: true })).toBeNull();
  });

  it('an active workspace replaces the hamburger with its icon tile, name intact', async () => {
    seedShellStore();
    await render(
      <ShellProvider
        routePath={`/channel/${IDS.general}`}
        drawer={null}
        onNavigate={jest.fn()}
        onPush={jest.fn()}
      >
        <TitleBar title="general" onOpenDrawer={jest.fn()} />
      </ShellProvider>,
    );

    // The trigger's contract is unchanged (name, role, 44pt floor)…
    expectControl('title-bar-drawer', 'Open navigation');
    // …only the face changed: the active workspace's icon tile. The face is
    // deliberately aria-hidden (the button's label IS the meaning), so the
    // query opts into hidden elements to reach it.
    expect(screen.getByTestId('title-bar-ws-icon', { includeHiddenElements: true })).toBeTruthy();
  });

  it('keeps the ☰ face when the shell has no workspaces at all', async () => {
    await render(
      <ShellProvider routePath="/" drawer={null} onNavigate={jest.fn()} onPush={jest.fn()}>
        <TitleBar title="Home" onOpenDrawer={jest.fn()} />
      </ShellProvider>,
    );

    expectControl('title-bar-drawer', 'Open navigation');
    expect(screen.queryByTestId('title-bar-ws-icon', { includeHiddenElements: true })).toBeNull();
  });
});
