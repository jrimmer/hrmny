/**
 * @cytale/web — TileGrid tests (calls V2 plan U5a).
 *
 * States-first: empty (named state + next-step hint), loading/error as
 * per-tile surfaces, offline as all-frozen tiles, view-only as the budget
 * floor (connection-paused avatars — VM18). Keyboard: native Tab plus the
 * house arrow-key grid nav (wrapping). VM18's polite live region carries
 * budget step-down announcements. The strip variant is VM19's collapsed
 * grid (mobile stage composition) — axe'd as the mobile geometry.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { TileGrid, type GridParticipant } from '../TileGrid.js';
import { mobileWidthState } from '../../../../test/setup.js';

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
});

const PARTICIPANTS: GridParticipant[] = [
  { userId: 'u1', name: 'Ada', state: 'live', stream: { id: 's1' } },
  { userId: 'u2', name: 'Grace', state: 'live', stream: { id: 's2' }, speaking: true },
  { userId: 'u3', name: 'Linus', state: 'camera-off' },
  { userId: 'me', name: 'You', state: 'live', stream: { id: 's3' }, isSelf: true },
];

// -- states ---------------------------------------------------------------------

describe('TileGrid — states', () => {
  it('empty: named empty state with a next-step hint', () => {
    render(<TileGrid participants={[]} />);
    expect(screen.getByTestId('video-grid-empty')).toBeTruthy();
    expect(screen.getByText(/no one is on camera/i)).toBeTruthy();
    expect(screen.getByText(/turn your camera on/i)).toBeTruthy();
  });

  it('empty: the hint is overridable (DM copy etc.)', () => {
    render(<TileGrid participants={[]} emptyHint="Nobody is sharing video yet." />);
    expect(screen.getByText('Nobody is sharing video yet.')).toBeTruthy();
  });

  it('renders one tile per participant, mirrored only for self (VM15)', () => {
    render(<TileGrid participants={PARTICIPANTS} />);
    const tiles = screen.getAllByTestId('video-tile');
    expect(tiles).toHaveLength(4);
    const self = tiles.find((t) => t.getAttribute('data-user-id') === 'me')!;
    expect(self.className).toContain('video-mirrored');
    const remote = tiles.find((t) => t.getAttribute('data-user-id') === 'u1')!;
    expect(remote.className).not.toContain('video-mirrored');
  });

  it('view-only floor: connection-paused tiles render as avatars (VM18)', () => {
    const floored: GridParticipant[] = PARTICIPANTS.map((p) => ({
      ...p,
      state: 'connection-paused' as const,
      stream: undefined,
    }));
    render(<TileGrid participants={floored} />);
    expect(screen.getAllByTestId('tile-paused-connection')).toHaveLength(4);
    expect(screen.queryByTestId('tile-camera-off')).toBeNull();
  });

  it('offline: frozen hints ride every tile (the parent passes them)', () => {
    const frozen = PARTICIPANTS.filter((p) => p.state === 'live');
    render(<TileGrid participants={frozen.map((p) => ({ ...p, frozen: true }))} />);
    expect(screen.getAllByTestId('tile-freeze-hint')).toHaveLength(3);
  });

  it('VM18: the polite live region renders announcements (budget step-downs)', () => {
    const { rerender } = render(
      <TileGrid participants={PARTICIPANTS} announcement="" />,
    );
    const region = screen.getByTestId('video-grid-announce');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    rerender(
      <TileGrid
        participants={PARTICIPANTS}
        announcement="Connection slowed — showing 2 live video tiles"
      />,
    );
    expect(region.textContent).toBe(
      'Connection slowed — showing 2 live video tiles',
    );
  });
});

// -- geometry --------------------------------------------------------------------

describe('TileGrid — variants', () => {
  it('grid (default): the .video-grid house grid class', () => {
    render(<TileGrid participants={PARTICIPANTS} />);
    const grid = screen.getByTestId('video-grid');
    expect(grid.getAttribute('data-variant')).toBe('grid');
    expect(grid.className).toContain('video-grid');
  });

  it('strip (VM19): compact thumbnail cells', () => {
    render(<TileGrid participants={PARTICIPANTS} variant="strip" />);
    expect(screen.getByTestId('video-grid').getAttribute('data-variant')).toBe('strip');
    for (const tile of screen.getAllByTestId('video-tile')) {
      expect(tile.className).toContain('video-tile-compact');
    }
  });
});

// -- keyboard --------------------------------------------------------------------

describe('TileGrid — keyboard navigation', () => {
  it('arrow keys move focus across tiles with wrapping', async () => {
    render(<TileGrid participants={PARTICIPANTS} />);
    const tiles = screen.getAllByTestId('video-tile');
    tiles[0]!.focus();
    expect(document.activeElement).toBe(tiles[0]);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tiles[1]);

    // jsdom has no layout → one estimated column: Down steps +1, Up -1.
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(tiles[2]);

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tiles[1]);

    // Wrapping at both ends.
    tiles[3]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tiles[0]);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tiles[3]);
  });

  it('tiles are natively tabbable buttons that enlarge on Enter (VM21)', async () => {
    const onEnlarge = vi.fn();
    render(<TileGrid participants={PARTICIPANTS} onEnlarge={onEnlarge} />);
    const tiles = screen.getAllByTestId('video-tile');
    tiles[0]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(onEnlarge).toHaveBeenCalledWith('u1');
  });
});

// -- axe -------------------------------------------------------------------------

describe('TileGrid — axe', () => {
  it('zero violations on the desktop grid (mixed states + empty)', async () => {
    const { container } = render(<TileGrid participants={PARTICIPANTS} />);
    expect(await axe(container)).toHaveNoViolations();
    cleanup();
    const empty = render(<TileGrid participants={[]} />);
    expect(await axe(empty.container)).toHaveNoViolations();
  });

  it('zero violations on the mobile share-live composition (VM19 strip)', async () => {
    mobileWidthState.mobile = true;
    const { container } = render(
      <TileGrid participants={PARTICIPANTS} variant="strip" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
