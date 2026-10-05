/**
 * @cytale/web — MobileTopbar tests (U1 chrome, U2 header-action parity).
 *
 * U2 adds the join-voice control (TopbarCallAction) beside the 👥 trigger
 * and fills the title slot. The action is CHROME, not a second header
 * implementation: its states, aria-labels, and intents must mirror the
 * desktop pane header's ChannelHeaderCallActions exactly (audit B3 — voice
 * was unreachable at mobile because zero call controls existed in the DOM).
 *
 * Media-query contract: jsdom has no layout engine; `src/test/setup.ts`
 * installs a matchMedia stub whose shared state `mobileWidthState` the
 * mobile tests flip to simulate a phone viewport.
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

import { MobileTopbar, TopbarCallAction } from '../MobileTopbar';
import { headerIconButtonClass } from '../../ui/button';

afterEach(() => {
  cleanup();
});

describe('TopbarCallAction — the topbar join-voice control (U2)', () => {
  it('idle + permitted: Start call — same accessible name as the desktop header button', async () => {
    const onStart = vi.fn();
    render(<TopbarCallAction live={false} canStartCall onStart={onStart} onJoin={vi.fn()} />);
    const start = screen.getByTestId('topbar-start-call');
    // Accessible-name parity with MessagePane's header button (AM17).
    expect(start.getAttribute('aria-label')).toBe('Start call');
    // One icon style with the side-column icons beside it (the call LOG's
    // phone glyph among them): the shared header icon control.
    expect(start.className).toBe(headerIconButtonClass);
    // Plan 7.7: this control's phone was an 18px local glyph; it now comes from
    // the shared `PhoneIcon`, so pin the rendered size (18, not the default 16).
    const phone = start.querySelector('svg')!;
    expect(phone.getAttribute('width')).toBe('18');
    expect(phone.getAttribute('height')).toBe('18');
    await userEvent.click(start);
    expect(onStart).toHaveBeenCalledWith({ ring: false });
  });

  it('live: flips to Join call; the intent routes through the join seam', async () => {
    const onJoin = vi.fn();
    render(<TopbarCallAction live canStartCall onStart={vi.fn()} onJoin={onJoin} />);
    const join = screen.getByTestId('topbar-join-call');
    expect(join.getAttribute('aria-label')).toBe('Join call');
    await userEvent.click(join);
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('live + ringing: the label and data-ringing carry the ring emphasis (U11 twin)', () => {
    render(
      <TopbarCallAction live ringing canStartCall onStart={vi.fn()} onJoin={vi.fn()} />,
    );
    const join = screen.getByTestId('topbar-join-call');
    expect(join.getAttribute('aria-label')).toBe('Join call — ringing');
    expect(join.getAttribute('data-ringing')).toBe('true');
    expect(join.className).toContain('ring-emph');
  });

  it('permission-denied (no START_CALL, idle): the control is hidden — desktop rule parity', () => {
    render(<TopbarCallAction live={false} canStartCall={false} onStart={vi.fn()} onJoin={vi.fn()} />);
    expect(screen.queryByTestId('topbar-start-call')).toBeNull();
    expect(screen.queryByTestId('topbar-join-call')).toBeNull();
  });

  it('live Join stays reachable without START_CALL (join is not start)', () => {
    render(<TopbarCallAction live canStartCall={false} onStart={vi.fn()} onJoin={vi.fn()} />);
    expect(screen.getByTestId('topbar-join-call')).toBeTruthy();
  });

  it('keyboard-operable (Enter fires the start intent)', async () => {
    const onStart = vi.fn();
    render(<TopbarCallAction live={false} canStartCall onStart={onStart} onJoin={vi.fn()} />);
    screen.getByTestId('topbar-start-call').focus();
    await userEvent.keyboard('{Enter}');
    expect(onStart).toHaveBeenCalledWith({ ring: false });
  });

  it('axe: the call action has no violations in idle and live states', async () => {
    const idle = render(
      <TopbarCallAction live={false} canStartCall onStart={vi.fn()} onJoin={vi.fn()} />,
    );
    expect(await axe(idle.container)).toHaveNoViolations();
    cleanup();
    const live = render(
      <TopbarCallAction live ringing canStartCall onStart={vi.fn()} onJoin={vi.fn()} />,
    );
    expect(await axe(live.container)).toHaveNoViolations();
  });
});

describe('MobileTopbar — title and call-action slots (U2)', () => {
  it('renders the title slot content and the call action between title and members trigger', () => {
    render(
      <MobileTopbar
        title="general"
        callAction={
          <TopbarCallAction live={false} canStartCall onStart={vi.fn()} onJoin={vi.fn()} />
        }
        railTrigger={<button type="button" data-testid="members-trigger" />}
      />,
    );
    const bar = screen.getByTestId('mobile-topbar');
    const title = bar.querySelector('.mobile-topbar-title');
    expect(title?.textContent).toBe('general');
    const call = screen.getByTestId('topbar-start-call');
    const members = screen.getByTestId('members-trigger');
    expect(bar.contains(call)).toBe(true);
    // Visual order: title → call action → members trigger.
    expect(
      title!.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      call.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('the sigil rides the title muted and aria-hidden (the desktop pane-header idiom)', () => {
    render(<MobileTopbar title="general" titleSigil="#" />);
    const sigil = screen.getByTestId('mobile-topbar').querySelector('.mobile-topbar-sigil');
    expect(sigil?.textContent).toBe('#');
    expect(sigil?.getAttribute('aria-hidden')).toBe('true');
  });

  it('no sigil prop renders no sigil span (Home / workspace fallback)', () => {
    render(<MobileTopbar title="Home" />);
    expect(
      screen.getByTestId('mobile-topbar').querySelector('.mobile-topbar-sigil'),
    ).toBeNull();
  });
});
