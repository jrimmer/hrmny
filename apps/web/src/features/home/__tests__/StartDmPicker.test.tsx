/**
 * @cytale/web — StartDmPicker acceptance coverage (#94).
 *
 * The DM column's member picker: renders the shared-workspace rosters the
 * store hydrated (grouped by workspace — the scope guard), type-to-filter,
 * keyboard-complete (ArrowUp/Down/Enter, Escape closes via Radix), one
 * in-flight open at a time, the server's refusal surfaced inline with the
 * selection retained, and the states-first empty copies.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Channel } from '@cytale/domain';

import { ApiError } from '@cytale/api-client';

import { StartDmPicker, type DmCandidate } from '../StartDmPicker.js';

function dmChannel(id: string, peerId: string): Channel {
  return {
    id,
    workspace_id: null,
    name: '',
    type: 'dm',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-01T00:00:00Z',
    recipients: [{ id: peerId, username: 'peer' }],
  };
}

/**
 * The host hands over ONE entry per person. A person shared across two
 * workspaces is a single candidate — the duplicate-per-workspace listing is the
 * defect this pins (user report 2026-09-14).
 */
const CANDIDATES: DmCandidate[] = [
  { id: 'u-1', username: 'alice', avatar_url: null, nickname: null },
  { id: 'u-2', username: 'bob', avatar_url: null, nickname: 'Bobby' },
  { id: 'u-3', username: 'carol', avatar_url: null, nickname: null },
];

function renderPicker(props: Partial<Parameters<typeof StartDmPicker>[0]> = {}) {
  const onStartDm = vi.fn().mockResolvedValue(dmChannel('d-new', 'u-1'));
  render(
    <StartDmPicker
      open={true}
      onOpenChange={vi.fn()}
      candidates={CANDIDATES}
      onStartDm={onStartDm}
      {...props}
    />,
  );
  return { onStartDm };
}

afterEach(() => cleanup());

describe('StartDmPicker — the member pool (scope guard)', () => {
  it('renders one row per person, with no workspace grouping', () => {
    renderPicker();
    expect(screen.getByTestId('dm-picker-result-u-1').textContent).toContain('alice');
    expect(screen.getByTestId('dm-picker-result-u-2').textContent).toContain('Bobby');
    expect(screen.getByTestId('dm-picker-result-u-3').textContent).toContain('carol');
    // display name over @handle, disambiguation second line
    expect(screen.getByTestId('dm-picker-result-u-2').textContent).toContain('@bob');
    // No per-workspace labels: a DM is instance-wide, so a workspace heading
    // would both mislead and be the only reason a person could appear twice.
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('with no rosters hydrated, the picker says so instead of showing a directory', () => {
    renderPicker({ candidates: [] });
    expect(screen.getByTestId('dm-picker-empty').textContent).toMatch(/no members yet/i);
  });
});

describe('StartDmPicker — type-to-filter', () => {
  it('filters across display name and username', async () => {
    renderPicker();
    const input = screen.getByTestId('dm-picker-input');
    await userEvent.type(input, 'bob');
    expect(screen.getByTestId('dm-picker-result-u-2')).toBeTruthy(); // handle hit
    expect(screen.queryByTestId('dm-picker-result-u-1')).toBeNull();
    expect(screen.queryByTestId('dm-picker-result-u-3')).toBeNull();
  });

  it('a filter miss renders the empty result state', async () => {
    renderPicker();
    await userEvent.type(screen.getByTestId('dm-picker-input'), 'nobody');
    expect(screen.getByTestId('dm-picker-empty').textContent).toMatch(/no members match/i);
  });

  it('filtering resets the roving selection to the first visible row', async () => {
    renderPicker();
    await userEvent.type(screen.getByTestId('dm-picker-input'), 'carol');
    expect(screen.getByTestId('dm-picker-result-u-3').getAttribute('aria-selected')).toBe('true');
  });
});

describe('StartDmPicker — keyboard path', () => {
  it('ArrowDown/ArrowUp move the selection, Enter opens the active row', async () => {
    const { onStartDm } = renderPicker();
    const input = screen.getByTestId('dm-picker-input');
    await userEvent.type(input, '{ArrowDown}');
    expect(screen.getByTestId('dm-picker-result-u-2').getAttribute('aria-selected')).toBe('true');
    await userEvent.type(input, '{ArrowDown}');
    expect(screen.getByTestId('dm-picker-result-u-3').getAttribute('aria-selected')).toBe('true');
    // clamps at the end
    await userEvent.type(input, '{ArrowDown}');
    expect(screen.getByTestId('dm-picker-result-u-3').getAttribute('aria-selected')).toBe('true');
    await userEvent.type(input, '{ArrowUp}');
    expect(screen.getByTestId('dm-picker-result-u-2').getAttribute('aria-selected')).toBe('true');
    await userEvent.type(input, '{ArrowUp}{ArrowUp}');
    expect(screen.getByTestId('dm-picker-result-u-1').getAttribute('aria-selected')).toBe('true');

    await userEvent.type(input, '{Enter}');
    await waitFor(() => expect(onStartDm).toHaveBeenCalledTimes(1));
    expect(onStartDm).toHaveBeenCalledWith('u-1');
  });

  it('Escape closes the dialog (Radix) without selecting', async () => {
    const onOpenChange = vi.fn();
    const { onStartDm } = renderPicker({ onOpenChange });
    await userEvent.type(screen.getByTestId('dm-picker-input'), '{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onStartDm).not.toHaveBeenCalled();
  });
});

describe('StartDmPicker — selection', () => {
  it('selecting a member calls onStartDm exactly once with the member id', async () => {
    const { onStartDm } = renderPicker();
    await userEvent.click(screen.getByTestId('dm-picker-result-u-2'));
    await waitFor(() => expect(onStartDm).toHaveBeenCalledTimes(1));
    expect(onStartDm).toHaveBeenCalledWith('u-2');
  });

  it('a second activation while the open is in flight is a no-op (one API call)', async () => {
    let resolveOpen: (c: Channel) => void = () => {};
    const onStartDm = vi.fn().mockImplementation(
      () => new Promise<Channel>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    render(
      <StartDmPicker open={true} onOpenChange={vi.fn()} candidates={CANDIDATES} onStartDm={onStartDm} />,
    );
    const row = screen.getByTestId('dm-picker-result-u-1');
    await userEvent.click(row);
    await userEvent.click(row); // pending — ignored
    await userEvent.click(row);
    expect(onStartDm).toHaveBeenCalledTimes(1);
    resolveOpen(dmChannel('d-new', 'u-1'));
  });

  it('the in-flight open is announced on the row', async () => {
    const onStartDm = vi.fn().mockImplementation(
      () => new Promise<Channel>(() => {}),
    );
    render(
      <StartDmPicker open={true} onOpenChange={vi.fn()} candidates={CANDIDATES} onStartDm={onStartDm} />,
    );
    await userEvent.click(screen.getByTestId('dm-picker-result-u-1'));
    expect(screen.getByTestId('dm-picker-pending').textContent).toMatch(/opening/i);
  });
});

describe('StartDmPicker — failure (states-first)', () => {
  it('a refused open surfaces the server’s message inline and retains the selection', async () => {
    const refusal = new ApiError({
      key: 'forbidden',
      code: 40301,
      message: 'verification required',
      status: 403,
    });
    const onStartDm = vi.fn().mockRejectedValue(refusal);
    const onOpenChange = vi.fn();
    render(
      <StartDmPicker open={true} onOpenChange={onOpenChange} candidates={CANDIDATES} onStartDm={onStartDm} />,
    );
    await userEvent.click(screen.getByTestId('dm-picker-result-u-2'));

    expect(await screen.findByTestId('dm-picker-error')).toBeTruthy();
    // permission-denied copy (the write gate's 403), not a generic message
    expect(screen.getByTestId('dm-picker-error').textContent).toMatch(
      /can't start this conversation/i,
    );
    // the dialog stays open and the failed member stays selected for a retry
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId('dm-picker-result-u-2').getAttribute('aria-selected')).toBe('true');

    // retry: the handler is invoked again (and now resolves)
    onStartDm.mockResolvedValue(dmChannel('d-new', 'u-2'));
    await userEvent.click(screen.getByTestId('dm-picker-result-u-2'));
    await waitFor(() => expect(onStartDm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('a non-403 failure carries the server’s message through', async () => {
    const onStartDm = vi.fn().mockRejectedValue(
      new ApiError({
        key: 'validation_failed',
        code: 40001,
        message: 'DMs require a human participant',
        status: 400,
      }),
    );
    render(
      <StartDmPicker open={true} onOpenChange={vi.fn()} candidates={CANDIDATES} onStartDm={onStartDm} />,
    );
    await userEvent.click(screen.getByTestId('dm-picker-result-u-1'));
    expect(await screen.findByTestId('dm-picker-error').then((el) => el.textContent)).toBe(
      'DMs require a human participant',
    );
  });
});

describe('StartDmPicker — accessibility (WCAG 2.1 AA bar)', () => {
  it('has no axe violations (dialog, labelled input, listbox semantics)', async () => {
    renderPicker();
    await screen.findByTestId('dm-picker-results');
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations on the empty-pool state', async () => {
    renderPicker({ candidates: [] });
    await screen.findByTestId('dm-picker-empty');
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('StartDmPicker — principals you cannot message (owner report 2026-09-15)', () => {
  const WITH_AGENT: DmCandidate[] = [
    ...CANDIDATES,
    {
      id: 'u-bot',
      username: 'mia',
      avatar_url: null,
      nickname: 'Mia Helper',
      kind: 'bot',
      parentName: 'jordan',
      dmSupport: 'none',
    },
  ];

  it('marks an agent row with its reason and never calls onStartDm', async () => {
    const onStartDm = vi.fn(async (id: string) => dmChannel('d-new', id));
    render(
      <StartDmPicker
        open={true}
        onOpenChange={vi.fn()}
        candidates={WITH_AGENT}
        onStartDm={onStartDm}
      />,
    );

    const row = screen.getByTestId('dm-picker-result-u-bot');
    expect(row.getAttribute('data-blocked')).toBeTruthy();
    expect(row.getAttribute('aria-disabled')).toBe('true');
    // The reason replaces the handle, and it names the owning human.
    expect(screen.getByTestId('dm-picker-blocked-u-bot').textContent).toBe(
      "This agent doesn't accept direct messages.",
    );
    expect(row.querySelector('[data-testid="kind-badge"]')).toBeTruthy();

    fireEvent.click(row);
    await Promise.resolve();
    // NOT even attempted: no request leaves the client.
    expect(onStartDm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dm-picker-pending')).toBeNull();
  });

  it('opens for an agent whose policy accepts people (the default)', async () => {
    const onStartDm = vi.fn(async (id: string) => dmChannel('d-new', id));
    render(
      <StartDmPicker
        open={true}
        onOpenChange={vi.fn()}
        candidates={[
          ...CANDIDATES,
          { id: 'u-bot', username: 'mia', avatar_url: null, nickname: null, kind: 'bot' },
        ]}
        onStartDm={onStartDm}
      />,
    );

    // No dmSupport field at all = the server's default (:humans), so the row is
    // openable — the blanket agent refusal is gone (owner direction 2026-09-15).
    const row = screen.getByTestId('dm-picker-result-u-bot');
    expect(row.getAttribute('data-blocked')).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(onStartDm).toHaveBeenCalledWith('u-bot'));
  });

  it('opens for a human in the same list', async () => {
    const onStartDm = vi.fn(async (id: string) => dmChannel('d-new', id));
    render(
      <StartDmPicker
        open={true}
        onOpenChange={vi.fn()}
        candidates={WITH_AGENT}
        onStartDm={onStartDm}
      />,
    );

    fireEvent.click(screen.getByTestId('dm-picker-result-u-2'));
    await waitFor(() => expect(onStartDm).toHaveBeenCalledWith('u-2'));
  });
});
