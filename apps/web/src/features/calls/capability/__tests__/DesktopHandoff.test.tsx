/**
 * @cytale/web — desktop handoff surface tests (calls V2 plan U6; R12 +
 * KDV3 on U5a's VM10 CapabilityDisabledButton pattern).
 *
 * Under test:
 *   - DesktopHandoffButton: the visible-disabled trigger whose dialog
 *     explains the gap and carries exactly ONE action — "Open the web app"
 *     — wired to openWebApp (mocked shell seam: window.open).
 *   - DesktopHandoffNotice: the displaced-leg variant copy
 *     ("Call continued in your browser."), role=status, dismissible.
 *   - copy constants as string contracts (the wiring unit consumes them).
 *   - axe on every surface this unit creates (desktop + mobile width).
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

import {
  DESKTOP_HANDOFF_COPY,
  DISPLACED_VIA_HANDOFF_NOTICE,
} from '../copy.js';
import { DesktopHandoffButton } from '../DesktopHandoffButton.js';
import { DesktopHandoffNotice } from '../DesktopHandoffNotice.js';
import { isHandoffInitiated, resetHandoffForTests } from '../handoff.js';
import { mobileWidthState } from '../../../../test/setup.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffForTests();
  mobileWidthState.mobile = false;
});

// ---------------------------------------------------------------------------
// Copy contracts
// ---------------------------------------------------------------------------

describe('handoff copy', () => {
  it('screenshare copy: names the desktop gap, one plain action', () => {
    const copy = DESKTOP_HANDOFF_COPY.screenshare;
    expect(copy.dialogTitle).toBe('Screen sharing isn\u2019t available in the desktop app');
    expect(copy.dialogBody).toMatch(/open the web app to share it/i);
    expect(copy.dialogBody).toMatch(/sign in there and join the call yourself/i);
    expect(copy.actionLabel).toBe('Open the web app');
  });

  it('capture copy: covers wholly-absent camera/mic (Linux posture)', () => {
    const copy = DESKTOP_HANDOFF_COPY.capture;
    expect(copy.dialogTitle).toBe('Camera and microphone aren\u2019t available in the desktop app');
    expect(copy.dialogBody).toMatch(/sign in there and join the call yourself/i);
    expect(copy.actionLabel).toBe('Open the web app');
  });

  it('the displaced-leg variant is R12\u2019s own words', () => {
    expect(DISPLACED_VIA_HANDOFF_NOTICE).toBe('Call continued in your browser.');
  });
});

// ---------------------------------------------------------------------------
// DesktopHandoffButton
// ---------------------------------------------------------------------------

describe('DesktopHandoffButton — the handoff affordance', () => {
  it('renders visibly disabled-looking yet focusable (VM10 pattern)', () => {
    render(
      <DesktopHandoffButton kind="screenshare" label="Share your screen" icon="🖥" context="panel" />,
    );
    const trigger = screen.getByTestId('capability-disabled-panel');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it('activation opens the honest dialog with the handoff copy + one action', async () => {
    render(
      <DesktopHandoffButton kind="screenshare" label="Share your screen" icon="🖥" context="panel" />,
    );
    await userEvent.click(screen.getByTestId('capability-disabled-panel'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/isn.t available in the desktop app/i);
    expect(screen.getByText(/open the web app to share it/i)).toBeTruthy();

    const action = screen.getByTestId('capability-disabled-action-panel');
    expect(action.textContent).toBe('Open the web app');
    // Exactly one action beyond dismissal — nothing fancier (KDV3).
    expect(screen.getByTestId('capability-disabled-dismiss-panel')).toBeTruthy();
  });

  it('the action opens the configured web origin via the shell seam', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <DesktopHandoffButton kind="screenshare" label="Share your screen" icon="🖥" context="panel" />,
    );
    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    await userEvent.click(screen.getByTestId('capability-disabled-action-panel'));

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      window.location.origin,
      '_blank',
      'noopener,noreferrer',
    );
    expect(isHandoffInitiated()).toBe(true);
  });

  it('the capture kind explains camera/microphone instead', async () => {
    render(
      <DesktopHandoffButton kind="capture" label="Turn on camera" icon="📷" context="panel" />,
    );
    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    expect(screen.getByText(/camera and microphone aren.t available in the desktop app/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DesktopHandoffNotice
// ---------------------------------------------------------------------------

describe('DesktopHandoffNotice — displaced-leg variant', () => {
  it('renders the variant copy as a live status', () => {
    const onDismiss = vi.fn();
    render(<DesktopHandoffNotice onDismiss={onDismiss} />);

    const notice = screen.getByTestId('desktop-handoff-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain(DISPLACED_VIA_HANDOFF_NOTICE);
    // It is NOT the stock displaced copy — the user chose the browser.
    expect(notice.textContent).not.toMatch(/another device/i);
  });

  it('dismisses via its OK button', async () => {
    const onDismiss = vi.fn();
    render(<DesktopHandoffNotice onDismiss={onDismiss} />);
    await userEvent.click(screen.getByTestId('desktop-handoff-notice-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// axe (states-first DoD: every surface this unit creates)
// ---------------------------------------------------------------------------

describe('desktop handoff surfaces — axe', () => {
  it('DesktopHandoffButton: zero violations closed and with the dialog open', async () => {
    const { container } = render(
      <DesktopHandoffButton kind="screenshare" label="Share your screen" icon="🖥" context="panel" />,
    );
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('DesktopHandoffButton + open dialog at mobile width', async () => {
    mobileWidthState.mobile = true;
    render(
      <DesktopHandoffButton kind="capture" label="Turn on camera" icon="📷" context="dm" />,
    );
    await userEvent.click(screen.getByTestId('capability-disabled-dm'));
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('DesktopHandoffNotice: zero violations', async () => {
    const { container } = render(<DesktopHandoffNotice onDismiss={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
