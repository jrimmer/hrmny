/**
 * Members drawer accessibility (plan 004 M5, R18).
 *
 * R18's automated half for the members layer: the two controls it exposes (the
 * full-screen dismiss scrim and the header close control) carry accessible
 * names, the close control reaches the 44pt floor, the reading order is the
 * rendered DOM order, and the layer is modal — the surface it covers is out of
 * the accessibility tree. The floor technique is copied from
 * `messages/__tests__/MessageRow.test.tsx`.
 *
 * Member rows are read-only identity rows, not controls: R18's target floor
 * does not apply to them, so they are asserted for reading order and for the
 * identity each row announces.
 *
 * Scope honesty: these are automated checks over the rendered tree. R18's
 * human half — a VoiceOver/TalkBack walkthrough of the primary flows without a
 * dead end — is NOT covered here and stays a manual acceptance step.
 */
import { render, screen, within } from '@testing-library/react-native';
import { View } from 'react-native';

import { MembersDrawer } from '../MembersDrawer';
import type { MemberRow } from '../store';
import { IDS } from './support';

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

const MEMBERS: MemberRow[] = [
  { id: IDS.alice, name: 'alice', status: 'online', avatarUrl: null },
  { id: IDS.bob, name: 'Bobby', status: 'dnd', avatarUrl: null },
  { id: IDS.me, name: 'rowan', status: 'offline', avatarUrl: null },
];

/**
 * Render the layer over a stand-in for the surface it covers, so the modal
 * contract is asserted against a real sibling rather than in isolation.
 */
async function renderMembers(members: MemberRow[] = MEMBERS) {
  const onClose = jest.fn();
  const view = await render(
    <View>
      <View
        accessibilityRole="button"
        accessibilityLabel="Behind the layer"
        testID="behind"
        style={{ minHeight: 44 }}
      />
      <MembersDrawer members={members} onClose={onClose} />
    </View>,
  );
  return { onClose, view };
}

describe('members drawer — R18', () => {
  it('names the dismiss scrim and the close control', async () => {
    await renderMembers();

    const scrim = screen.getByLabelText('Dismiss member list');
    const close = screen.getByLabelText('Close member list');

    expect(scrim).toHaveAccessibleName('Dismiss member list');
    expect(close).toHaveAccessibleName('Close member list');
    expect(screen.getByRole('button', { name: 'Dismiss member list' })).toBe(scrim);
    expect(screen.getByRole('button', { name: 'Close member list' })).toBe(close);
  });

  it('meets the 44pt floor on the close control', async () => {
    await renderMembers();

    const flattened = styleOf(screen.getByTestId('members-close'));
    expect(flattened.minHeight).toBeGreaterThanOrEqual(44);

    // The scrim is a full-screen overlay — its target IS the viewport, so it
    // is checked for a name (above) and not for a 44pt minimum.
  });

  it('reads in rendered order: the dismiss scrim, then the panel’s close control', async () => {
    await renderMembers();

    expect(screen.getAllByRole('button').map(namedLabelOf)).toEqual([
      'Dismiss member list',
      'Close member list',
    ]);
  });

  it('is the modal surface: nothing behind it is reachable', async () => {
    await renderMembers();

    expect(screen.getByTestId('members-layer').props.accessibilityViewIsModal).toBe(true);
    // The stand-in behind the layer leaves the accessibility tree entirely.
    expect(screen.queryByLabelText('Behind the layer')).toBeNull();
    expect(screen.getByLabelText('Close member list')).toBeTruthy();
  });

  it('renders one reading stop per member, in the order the roster gives', async () => {
    await renderMembers();

    const rows = screen.getAllByTestId(/^member-row-/);
    expect(rows.map((row) => row.props.testID)).toEqual([
      `member-row-${IDS.alice}`,
      `member-row-${IDS.bob}`,
      `member-row-${IDS.me}`,
    ]);

    // Each row announces the member's name and then their presence.
    for (const [row, member] of rows.map((row, index) => [row, MEMBERS[index]] as const)) {
      expect(within(row).getByText(member?.name ?? '')).toBeTruthy();
    }
    expect(within(rows[0] as (typeof rows)[number]).getByText('Online')).toBeTruthy();
    expect(within(rows[1] as (typeof rows)[number]).getByText('Do not disturb')).toBeTruthy();
    expect(within(rows[2] as (typeof rows)[number]).getByText('Offline')).toBeTruthy();
  });
});
