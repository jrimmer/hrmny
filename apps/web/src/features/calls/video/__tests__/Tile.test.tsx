/**
 * @cytale/web — Tile tests (calls V2 plan U5a).
 *
 * Every tile state (UX_SPEC §9's states-first set, mapped to a video tile):
 * loading skeleton, live video (srcObject attach), camera-off avatar,
 * beyond-budget connection-paused avatar (VM18 — DISTINCT from camera-off),
 * error alert — plus the freeze hint, the non-color speaking indicator, the
 * name plate, VM15 mirroring, the compact strip variant, and VM21's
 * activation contract (focusable; Enter announces-and-enlarges via the
 * accessible name's (name, camera state) pair).
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

import { Tile, tileCameraStateText } from '../Tile.js';

afterEach(() => {
  cleanup();
});

/** Give jsdom a settable srcObject so the attach effect is observable. */
function stubSrcObject(): void {
  Object.defineProperty(window.HTMLVideoElement.prototype, 'srcObject', {
    configurable: true,
    writable: true,
    value: null,
  });
}

// -- states ---------------------------------------------------------------------

describe('Tile — states', () => {
  it('loading: skeleton + sr-only connecting status + aria-busy', () => {
    render(<Tile userId="u1" name="Ada" state="loading" />);
    const tile = screen.getByTestId('video-tile');
    expect(tile.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('tile-skeleton')).toBeTruthy();
    expect(screen.getByText(/connecting ada's video/i)).toBeTruthy();
    expect(screen.queryByTestId('tile-video')).toBeNull();
  });

  it('live: renders the video element and attaches the prop stream by ref', () => {
    stubSrcObject();
    const fakeStream = { id: 'stream-1' } as unknown as MediaStream;
    render(<Tile userId="u1" name="Ada" state="live" stream={fakeStream} />);
    const video = screen.getByTestId('tile-video') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.srcObject).toBe(fakeStream);
    // React maps these to DOM properties (not reflected attributes in jsdom):
    // autoplay + muted (tiles are never audible surfaces) + playsinline.
    expect(video.autoplay).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
  });

  it('live without a stream yet degrades to the skeleton, never a blank tile', () => {
    render(<Tile userId="u1" name="Ada" state="live" />);
    expect(screen.getByTestId('tile-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('tile-video')).toBeNull();
  });

  it('camera-off: avatar + Camera off chip (the publisher\'s choice)', () => {
    render(<Tile userId="u1" name="Ada" state="camera-off" />);
    expect(screen.getByTestId('tile-camera-off')).toBeTruthy();
    expect(screen.getByText(/camera off/i)).toBeTruthy();
    expect(screen.queryByTestId('tile-paused-connection')).toBeNull();
  });

  it('VM18: connection-paused is a DISTINCT affordance from camera-off', () => {
    render(<Tile userId="u1" name="Ada" state="connection-paused" />);
    // Distinct chip + distinct testid + distinct accessible state text.
    expect(screen.getByTestId('tile-paused-connection')).toBeTruthy();
    expect(screen.getByText(/video paused — connection/i)).toBeTruthy();
    expect(screen.queryByTestId('tile-camera-off')).toBeNull();
    expect(tileCameraStateText('connection-paused')).not.toBe(
      tileCameraStateText('camera-off'),
    );
  });

  it('error: avatar + role=alert recovery copy', () => {
    render(<Tile userId="u1" name="Ada" state="error" />);
    const alert = screen.getByTestId('tile-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toMatch(/video unavailable/i);
  });

  it('freeze hint renders only on a live tile and reads as text (non-color)', () => {
    const { rerender } = render(<Tile userId="u1" name="Ada" state="live" frozen />);
    expect(screen.getByTestId('tile-freeze-hint').textContent).toMatch(
      /video may be frozen/i,
    );
    rerender(<Tile userId="u1" name="Ada" state="camera-off" frozen />);
    expect(screen.queryByTestId('tile-freeze-hint')).toBeNull();
  });

  it('speaking: icon + sr-only text pair with the ring (data-speaking)', () => {
    render(<Tile userId="u1" name="Ada" state="live" speaking />);
    const tile = screen.getByTestId('video-tile');
    expect(tile.getAttribute('data-speaking')).toBe('true');
    expect(screen.getByTestId('tile-speaking-icon')).toBeTruthy();
  });

  it('name plate renders the display name', () => {
    render(<Tile userId="u1" name="Ada Lovelace" state="camera-off" />);
    expect(screen.getByTestId('tile-name').textContent).toBe('Ada Lovelace');
  });
});

// -- VM15 / VM19 geometry ---------------------------------------------------------

describe('Tile — geometry modifiers', () => {
  it('mirrored applies the VM15 class (self-view only)', () => {
    render(<Tile userId="self" name="You" state="live" mirrored />);
    expect(screen.getByTestId('video-tile').className).toContain('video-mirrored');
  });

  it('default (remote) tiles are never mirrored', () => {
    render(<Tile userId="u1" name="Ada" state="live" />);
    expect(screen.getByTestId('video-tile').className).not.toContain('video-mirrored');
  });

  it('compact applies the strip modifier (VM19 thumbnail cells)', () => {
    render(<Tile userId="u1" name="Ada" state="camera-off" compact />);
    expect(screen.getByTestId('video-tile').className).toContain('video-tile-compact');
  });
});

// -- VM21 activation --------------------------------------------------------------

describe('Tile — VM21 activation', () => {
  it('is a real focusable button whose accessible name is (name, camera state)', () => {
    render(<Tile userId="u1" name="Ada" state="live" />);
    const tile = screen.getByTestId('video-tile');
    expect(tile.tagName).toBe('BUTTON');
    expect(tile.getAttribute('aria-label')).toBe('Ada, camera on');
  });

  it('the paused-connection state announces distinctly in the name', () => {
    render(<Tile userId="u1" name="Ada" state="connection-paused" />);
    expect(screen.getByTestId('video-tile').getAttribute('aria-label')).toBe(
      'Ada, video paused — connection',
    );
  });

  it('Enter and click activate enlarge with the userId', async () => {
    const onEnlarge = vi.fn();
    render(<Tile userId="u1" name="Ada" state="live" onEnlarge={onEnlarge} />);
    screen.getByTestId('video-tile').focus();
    await userEvent.keyboard('{Enter}');
    expect(onEnlarge).toHaveBeenCalledWith('u1');
    await userEvent.click(screen.getByTestId('video-tile'));
    expect(onEnlarge).toHaveBeenCalledTimes(2);
  });
});

// -- axe --------------------------------------------------------------------------

describe('Tile — axe', () => {
  it('zero violations on every state (desktop)', async () => {
    const states = ['loading', 'live', 'camera-off', 'connection-paused', 'error'] as const;
    for (const state of states) {
      cleanup();
      const { container } = render(
        <Tile userId="u1" name="Ada" state={state} speaking frozen />,
      );
      expect(await axe(container)).toHaveNoViolations();
    }
  });
});
