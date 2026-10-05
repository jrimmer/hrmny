/**
 * @cytale/web — SelfView tests (calls V2 plan U5a, VM15).
 *
 * The mirroring invariant (self-view is the ONLY mirrored surface), both
 * ratified geometries — grid tile while the grid is shown, corner overlay
 * when the stage dominates (VM16) — inherited tile states, and VM21
 * activation.
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

import { SelfView } from '../SelfView.js';
import { mobileWidthState } from '../../../../test/setup.js';

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
});

describe('SelfView — VM15', () => {
  it('is mirrored in the tile variant (the only mirrored surface)', () => {
    render(<SelfView state="live" stream={{ id: 'cam' }} />);
    expect(screen.getByTestId('self-view').getAttribute('data-variant')).toBe('tile');
    const tile = screen.getByTestId('video-tile');
    expect(tile.className).toContain('video-mirrored');
    expect(screen.getByTestId('self-view').className).toContain('self-view-tile');
  });

  it('demotes to the corner overlay variant when the stage dominates (VM16)', () => {
    render(<SelfView state="live" variant="overlay" stream={{ id: 'cam' }} />);
    const wrap = screen.getByTestId('self-view');
    expect(wrap.getAttribute('data-variant')).toBe('overlay');
    expect(wrap.className).toContain('self-view-overlay');
    // Still mirrored — the overlay is still self-view (VM15).
    expect(screen.getByTestId('video-tile').className).toContain('video-mirrored');
    expect(screen.getByTestId('video-tile').className).toContain('video-tile-compact');
  });

  it('names itself "You" and inherits the tile states (camera-off avatar)', () => {
    render(<SelfView state="camera-off" />);
    const tile = screen.getByTestId('video-tile');
    expect(tile.getAttribute('aria-label')).toBe('You, camera off');
    expect(screen.getByTestId('tile-camera-off')).toBeTruthy();
  });

  it('VM21: Enter activates enlarge with the viewer\'s id', async () => {
    const onEnlarge = vi.fn();
    render(<SelfView state="live" onEnlarge={onEnlarge} userId="me" />);
    screen.getByTestId('video-tile').focus();
    await userEvent.keyboard('{Enter}');
    expect(onEnlarge).toHaveBeenCalledWith('me');
  });

  it('axe: zero violations on both variants (desktop + mobile overlay)', async () => {
    const { container } = render(<SelfView state="live" stream={{ id: 'cam' }} speaking />);
    expect(await axe(container)).toHaveNoViolations();

    cleanup();
    mobileWidthState.mobile = true;
    const overlay = render(
      <SelfView state="camera-off" variant="overlay" speaking frozen />,
    );
    expect(await axe(overlay.container)).toHaveNoViolations();
  });
});
