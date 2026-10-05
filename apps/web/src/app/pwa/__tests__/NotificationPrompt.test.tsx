/**
 * notifications plan U6/U7 — the in-app invitation to turn notifications on.
 *
 * The design is shaped by a browser rule, not a preference: a page cannot open
 * the permission dialog on load. Browsers require a USER GESTURE, and Chrome
 * treats repeat asks without one as hostile — it can permanently block the
 * site. So the invitation is an in-app affordance whose button satisfies the
 * rule, and the states below exist mostly to make sure we do not over-ask.
 *
 * The rule the tests defend: once the member has said no (either to the
 * browser or to us), the prompt does not come back asking the same question.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationPrompt, NOTIFICATION_PROMPT_KEY } from '../NotificationPrompt.js';

function clearStorage(): void {
  try {
    localStorage.clear();
  } catch {
    // storage unavailable in this environment — nothing to clear
  }
}

afterEach(() => {
  cleanup();
  clearStorage();
});

beforeEach(() => {
  vi.clearAllMocks();
  clearStorage();
});

describe('NotificationPrompt', () => {
  it('invites when notifications are available and undecided', async () => {
    render(<NotificationPrompt permission="default" deliverable />);

    await waitFor(() => expect(screen.getByTestId('notification-prompt')).toBeDefined());
    expect(screen.getByTestId('notification-prompt-enable')).toBeDefined();
  });

  // Nothing to ask when it is already on — that is nagging, not helping.
  it('stays out of the way when permission is already granted', async () => {
    render(<NotificationPrompt permission="granted" deliverable />);
    expect(screen.queryByTestId('notification-prompt')).toBeNull();
  });

  // A refusal is an answer. Chrome counts repeat asks as hostile, and a member
  // who said no to the browser does not want to be asked again by the app.
  it('never asks when the member refused the browser', async () => {
    render(<NotificationPrompt permission="denied" deliverable />);
    expect(screen.queryByTestId('notification-prompt')).toBeNull();
  });

  it('does not ask on a platform that cannot deliver', async () => {
    render(<NotificationPrompt permission="default" deliverable={false} />);
    expect(screen.queryByTestId('notification-prompt')).toBeNull();
  });

  it('calls the enable action when the member accepts', async () => {
    const onEnable = vi.fn().mockResolvedValue(undefined);
    render(<NotificationPrompt permission="default" deliverable onEnable={onEnable} />);

    await waitFor(() => expect(screen.getByTestId('notification-prompt-enable')).toBeDefined());
    await userEvent.click(screen.getByTestId('notification-prompt-enable'));

    await waitFor(() => expect(onEnable).toHaveBeenCalledTimes(1));
    // Accepted → gone; the settings surface is where it is changed afterwards.
    await waitFor(() => expect(screen.queryByTestId('notification-prompt')).toBeNull());
  });

  it('dismissing hides it and records the decision', async () => {
    render(<NotificationPrompt permission="default" deliverable />);
    await waitFor(() => expect(screen.getByTestId('notification-prompt')).toBeDefined());

    await userEvent.click(screen.getByTestId('notification-prompt-dismiss'));

    await waitFor(() => expect(screen.queryByTestId('notification-prompt')).toBeNull());
    // Recorded, so a re-render does not bring it straight back.
    expect(localStorage.getItem(NOTIFICATION_PROMPT_KEY)).toBeTruthy();
  });

  it('stays hidden once dismissed, across a remount', async () => {
    const first = render(<NotificationPrompt permission="default" deliverable />);
    await waitFor(() => expect(screen.getByTestId('notification-prompt')).toBeDefined());

    await userEvent.click(screen.getByTestId('notification-prompt-dismiss'));
    first.unmount();

    render(<NotificationPrompt permission="default" deliverable />);
    expect(screen.queryByTestId('notification-prompt')).toBeNull();
  });

  // A failure must be visible and must NOT be recorded as a decision: the
  // member asked for notifications and did not get them.
  it('surfaces a failed enable without recording a dismissal', async () => {
    const onEnable = vi.fn().mockRejectedValue(new Error('no keys on this instance'));
    render(<NotificationPrompt permission="default" deliverable onEnable={onEnable} />);

    await waitFor(() => expect(screen.getByTestId('notification-prompt-enable')).toBeDefined());
    await userEvent.click(screen.getByTestId('notification-prompt-enable'));

    await waitFor(() => expect(screen.getByTestId('notification-prompt-error')).toBeDefined());
    expect(localStorage.getItem(NOTIFICATION_PROMPT_KEY)).toBeNull();
  });

  it('is announced politely, not as an alert', async () => {
    render(<NotificationPrompt permission="default" deliverable />);

    await waitFor(() => expect(screen.getByTestId('notification-prompt')).toBeDefined());
    // role=status, matching the offline banner: an invitation is not an
    // interruption and must not seize a screen reader mid-task.
    expect(screen.getByTestId('notification-prompt').getAttribute('role')).toBe('status');
  });
});
