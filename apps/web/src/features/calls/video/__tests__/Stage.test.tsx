/**
 * @cytale/web — Stage tests (calls V2 plan U5a).
 *
 * States-first: collapsed (VM16 — no share means the GRID owns the panel),
 * loading skeleton, live (video + presenter bar + VM9 share-audio badge +
 * pin/enlarge), error alert, ended (stopped vs presenter-left copy) with
 * VM22's collapse affordance. VM16's fullscreen geometry, VM21's live
 * region, and the switcher slot. srcObject attach via the prop stream.
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

import { Stage, type StageShare } from '../Stage.js';
import { mobileWidthState } from '../../../../test/setup.js';

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
});

function stubSrcObject(): void {
  Object.defineProperty(window.HTMLVideoElement.prototype, 'srcObject', {
    configurable: true,
    writable: true,
    value: null,
  });
}

const SHARE: StageShare = {
  shareId: 'sh1',
  presenterId: 'u1',
  presenterName: 'Ada',
  stream: { id: 'screen-stream' } as unknown as MediaStream,
  shareAudio: false,
  sourceLabel: 'Entire screen',
};

// -- states ---------------------------------------------------------------------

describe('Stage — states', () => {
  it('collapsed: no share and nothing ended renders nothing (VM16 grid-fills)', () => {
    const { container } = render(<Stage share={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('loading: skeleton + sr status while the share stream is absent', () => {
    render(<Stage share={{ ...SHARE, stream: null }} />);
    expect(screen.getByTestId('stage-skeleton')).toBeTruthy();
    expect(screen.getByText(/loading ada's screen share/i)).toBeTruthy();
    expect(screen.queryByTestId('stage-video')).toBeNull();
  });

  it('live: attaches the share stream and renders the presenter bar', () => {
    stubSrcObject();
    render(<Stage share={SHARE} />);
    const video = screen.getByTestId('stage-video') as HTMLVideoElement;
    expect(video.srcObject).toBe(SHARE.stream);
    expect(screen.getByTestId('stage-presenter').textContent).toContain('Ada');
    expect(screen.getByTestId('stage-presenter').textContent).toContain('Entire screen');
    expect(screen.getByTestId('video-stage').getAttribute('data-stage-state')).toBe('live');
  });

  it('VM9: the share-audio badge appears only when the share carries audio', () => {
    const { rerender } = render(<Stage share={SHARE} />);
    expect(screen.queryByTestId('stage-share-audio-badge')).toBeNull();
    rerender(<Stage share={{ ...SHARE, shareAudio: true }} />);
    expect(screen.getByTestId('stage-share-audio-badge')).toBeTruthy();
    expect(screen.getByTestId('stage-share-audio-badge').textContent).toMatch(
      /sharing audio/i,
    );
  });

  it('error: role=alert with recovery copy', () => {
    render(<Stage share={SHARE} error="Track failed" />);
    const alert = screen.getByTestId('stage-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toMatch(/screen share failed/i);
    expect(alert.textContent).toMatch(/connection recovers/i);
  });

  it('ended (stopped): notice + Back to grid collapse (VM22 last-ends)', async () => {
    const onCollapse = vi.fn();
    render(<Stage share={null} endedReason="stopped" onCollapse={onCollapse} />);
    expect(screen.getByTestId('stage-ended').textContent).toMatch(
      /the screen share ended/i,
    );
    await userEvent.click(screen.getByTestId('stage-collapse'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('ended (presenter-left): the copy names the presenter', () => {
    render(
      <Stage
        share={null}
        endedReason="presenter-left"
        endedPresenterName="Ada"
      />,
    );
    expect(screen.getByTestId('stage-ended').textContent).toMatch(
      /ada left the call — their screen share ended/i,
    );
  });
});

// -- VM16 fullscreen + pin ---------------------------------------------------------

describe('Stage — presenter bar controls', () => {
  it('pin: aria-pressed toggle reports onPinToggle (VM22 pin → pinned)', async () => {
    const onPinToggle = vi.fn();
    const { rerender } = render(<Stage share={SHARE} pinned={false} onPinToggle={onPinToggle} />);
    const pin = screen.getByTestId('stage-pin');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(pin.getAttribute('aria-label')).toBe('Pin screen share');
    await userEvent.click(pin);
    expect(onPinToggle).toHaveBeenCalledTimes(1);

    rerender(<Stage share={SHARE} pinned onPinToggle={onPinToggle} />);
    expect(screen.getByTestId('stage-pin').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('video-stage').getAttribute('data-pinned')).toBe('true');
  });

  it('VM16: the enlarge toggle carries pressed state and the fullscreen geometry', async () => {
    const onEnlargeToggle = vi.fn();
    const { rerender } = render(
      <Stage share={SHARE} fullscreen={false} onEnlargeToggle={onEnlargeToggle} />,
    );
    const enlarge = screen.getByTestId('stage-enlarge');
    expect(enlarge.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('video-stage').className).not.toContain('video-stage-fullscreen');
    await userEvent.click(enlarge);
    expect(onEnlargeToggle).toHaveBeenCalledTimes(1);

    rerender(<Stage share={SHARE} fullscreen onEnlargeToggle={onEnlargeToggle} />);
    const stage = screen.getByTestId('video-stage');
    expect(screen.getByTestId('stage-enlarge').getAttribute('aria-pressed')).toBe('true');
    expect(stage.className).toContain('video-stage-fullscreen');
    expect(stage.getAttribute('data-fullscreen')).toBe('true');
  });

  it('the switcher slot renders inside the presenter bar (VM4 multi-share)', () => {
    render(
      <Stage
        share={SHARE}
        switcher={<button type="button" data-testid="slotted-switcher">2 screens</button>}
      />,
    );
    const bar = screen.getByTestId('stage-presenter-bar');
    expect(bar.contains(screen.getByTestId('slotted-switcher'))).toBe(true);
  });
});

// -- VM21 announcements -----------------------------------------------------------

describe('Stage — live region announcements (VM21)', () => {
  it('announces the live share, the pinned state, failures, and endings', () => {
    const { rerender } = render(<Stage share={SHARE} />);
    expect(screen.getByTestId('stage-announce').textContent).toBe(
      "Ada is sharing their Entire screen.",
    );

    rerender(<Stage share={SHARE} pinned />);
    expect(screen.getByTestId('stage-announce').textContent).toBe(
      "Ada's screen share is pinned.",
    );

    rerender(<Stage share={SHARE} error="Track failed" />);
    expect(screen.getByTestId('stage-announce').textContent).toMatch(/failed/i);

    rerender(<Stage share={null} endedReason="stopped" />);
    expect(screen.getByTestId('stage-announce').textContent).toMatch(
      /the screen share ended/i,
    );
  });
});

// -- axe -------------------------------------------------------------------------

describe('Stage — axe', () => {
  it('zero violations on every stage state (desktop)', async () => {
    const cases = [
      <Stage key="live" share={SHARE} />,
      <Stage key="pinned" share={SHARE} pinned />,
      <Stage key="loading" share={{ ...SHARE, stream: null }} />,
      <Stage key="error" share={SHARE} error="Track failed" />,
      <Stage key="ended" share={null} endedReason="stopped" />,
      <Stage key="fullscreen" share={SHARE} fullscreen />,
    ];
    for (const element of cases) {
      cleanup();
      const { container } = render(element);
      expect(await axe(container)).toHaveNoViolations();
    }
  });

  it('zero violations on the mobile stage-fullscreen composition (VM19)', async () => {
    mobileWidthState.mobile = true;
    const { container } = render(
      <Stage share={{ ...SHARE, shareAudio: true }} fullscreen />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
