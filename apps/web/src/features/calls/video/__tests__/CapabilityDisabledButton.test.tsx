/**
 * @cytale/web — CapabilityDisabledButton tests (calls V2 plan U5a).
 *
 * THE ratified VM10 pattern (flipped at the 2026-09-07 ratification): a
 * capability-off affordance always RENDERS — visibly disabled-looking — and
 * activating it opens the explanatory dialog instead of doing nothing or
 * disappearing. The trigger is a REAL focusable button carrying
 * aria-disabled (never the native disabled attribute, which would swallow
 * the only action it has). Copy is caller-supplied (mobile screenshare is
 * the default; U6's desktop handoff overrides it).
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

import { CapabilityDisabledButton } from '../CapabilityDisabledButton.js';
import { mobileWidthState } from '../../../../test/setup.js';

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
});

function renderButton(props: Partial<Parameters<typeof CapabilityDisabledButton>[0]> = {}) {
  return render(
    <CapabilityDisabledButton label="Share your screen" icon="🖥" context="panel" {...props} />,
  );
}

describe('CapabilityDisabledButton — VM10 visible-disabled', () => {
  it('renders visibly disabled-looking yet stays focusable and interactive', () => {
    renderButton();
    const trigger = screen.getByTestId('capability-disabled-panel');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('disabled')).toBeNull(); // the dialog IS the action
    expect(trigger.className).toContain('capability-disabled-btn');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it('activation opens the explanatory dialog (never a silent no-op)', async () => {
    renderButton();
    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    expect(screen.getByTestId('capability-disabled-dialog-panel')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Enter opens the dialog too (keyboard parity)', async () => {
    renderButton();
    screen.getByTestId('capability-disabled-panel').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('capability-disabled-dialog-panel')).toBeTruthy();
  });

  it('defaults to the ratified VM10 mobile screenshare copy', async () => {
    renderButton();
    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/screen sharing isn.t available/i);
    expect(screen.getByText(/you can still watch shared screens/i)).toBeTruthy();
    // No action button by default — there is nowhere to hand off on mobile.
    expect(screen.queryByTestId('capability-disabled-action-panel')).toBeNull();
    expect(screen.getByTestId('capability-disabled-dismiss-panel')).toBeTruthy();
  });

  it('custom copy: the U6 desktop handoff shape (title/body/action)', async () => {
    const onAction = vi.fn();
    renderButton({
      dialogTitle: 'Screen sharing isn\u2019t available in the desktop app',
      dialogBody:
        'This desktop platform can\u2019t capture your screen. Open the web app to share it.',
      actionLabel: 'Open the web app',
      onAction,
    });
    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    expect(screen.getByText(/desktop app/i)).toBeTruthy();
    expect(screen.getByText(/open the web app to share it/i)).toBeTruthy();

    const action = screen.getByTestId('capability-disabled-action-panel');
    expect(action.textContent).toBe('Open the web app');
    await userEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    // The action closes the dialog on its way out.
    expect(screen.queryByTestId('capability-disabled-dialog-panel')).toBeNull();
  });

  it('dismiss (Got it) and Escape close and return focus to the trigger', async () => {
    renderButton();
    const trigger = screen.getByTestId('capability-disabled-panel');
    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId('capability-disabled-dismiss-panel'));
    expect(screen.queryByTestId('capability-disabled-dialog-panel')).toBeNull();

    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('capability-disabled-dialog-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('CapabilityDisabledButton — axe (VM10)', () => {
  it('zero violations closed and with the dialog open (desktop + mobile width)', async () => {
    const { container } = renderButton();
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    expect(await axe(document.body)).toHaveNoViolations();

    cleanup();
    mobileWidthState.mobile = true;
    renderButton({
      actionLabel: 'Open the web app',
      onAction: () => {},
    });
    await userEvent.click(screen.getByTestId('capability-disabled-panel'));
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
