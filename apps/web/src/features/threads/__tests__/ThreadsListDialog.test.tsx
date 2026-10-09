/**
 * ThreadsListDialog — the channel's thread roster (⋯ menu entry).
 * Covers the archived toggle, the states-first set, and row → dock handoff.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { api } from '../../auth/session.js';
import { ThreadsListDialog } from '../ThreadsListDialog.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const THREAD = {
  id: 't-1',
  channel_id: 'c-1',
  parent_message_id: 'm-1',
  name: 'Deploy talk',
  created_by: 'u-1',
  archived: false,
  message_count: 3,
  latest_reply_at: '2026-09-10T20:00:00Z',
  created_at: '2026-09-10T19:00:00Z',
};

function renderDialog(overrides: Partial<Parameters<typeof ThreadsListDialog>[0]> = {}) {
  const onOpenThread = vi.fn();
  render(
    <ThreadsListDialog
      open
      onOpenChange={vi.fn()}
      channelId="c-1"
      channelName="general"
      onOpenThread={onOpenThread}
      {...overrides}
    />,
  );
  return { onOpenThread };
}

describe('ThreadsListDialog', () => {
  it('lists the channel roster with reply counts and opens the dock on click', async () => {
    vi.spyOn(api, 'listThreads').mockResolvedValue([THREAD as never]);
    const { onOpenThread } = renderDialog();

    await waitFor(() => expect(screen.getByTestId('threads-list')).toBeTruthy());
    const row = screen.getByTestId('threads-list-row-t-1');
    expect(row.textContent).toContain('Deploy talk');
    expect(row.textContent).toContain('3 replies');
    fireEvent.click(row);
    expect(onOpenThread).toHaveBeenCalledWith('t-1');
  });

  it('a generated name gives way to the start message; the newest reply previews under it', async () => {
    vi.spyOn(api, 'listThreads').mockResolvedValue([
      {
        ...THREAD,
        name: 'thread-388032',
        starter: {
          id: 'm-1',
          author_id: 'u-1',
          author_name: null,
          content: 'Overnight **transcript**, DNC line 2',
          embed_title: null,
          attachment_count: 0,
          created_at: THREAD.created_at,
        },
        latest_reply: {
          id: 'm-9',
          author_id: 'u-2',
          author_name: 'Shredder',
          content: 'Shredded.',
          embed_title: null,
          attachment_count: 0,
          created_at: THREAD.latest_reply_at,
        },
      } as never,
    ]);
    renderDialog();

    const row = await screen.findByTestId('threads-list-row-t-1');
    expect(row.textContent).toContain('Overnight transcript, DNC line 2');
    expect(row.textContent).not.toContain('thread-388032');
    expect(row.textContent).toContain('Shredder Shredded.');
    expect(row.textContent).toContain('3 replies');
  });

  it('excludes archived by default and refetches with the flag when toggled', async () => {
    const spy = vi
      .spyOn(api, 'listThreads')
      .mockResolvedValueOnce([THREAD as never])
      .mockResolvedValueOnce([{ ...THREAD, id: 't-2', archived: true } as never]);
    renderDialog();

    await waitFor(() => expect(spy).toHaveBeenCalledWith('c-1', { includeArchived: false }));
    fireEvent.click(screen.getByTestId('threads-list-archived'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('c-1', { includeArchived: true }));
    await waitFor(() =>
      expect(screen.getByTestId('threads-list-row-t-2').textContent).toContain('archived'),
    );
  });

  it('empty state points at the way to start a thread', async () => {
    vi.spyOn(api, 'listThreads').mockResolvedValue([]);
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('threads-list-empty')).toBeTruthy());
    // The roster is shared with the context rail's Threads tab, so the copy
    // names the action rather than the desktop-only hover affordance.
    expect(screen.getByTestId('threads-list-empty').textContent).toMatch(/start one from a message/);
  });

  it('error state offers Retry', async () => {
    const spy = vi.spyOn(api, 'listThreads').mockRejectedValue(new Error('down'));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('threads-list-error')).toBeTruthy());
    fireEvent.click(screen.getByTestId('threads-list-retry'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
