/**
 * My Threads rows are sidebar rows (UI consistency, 2026-09-27): the channel
 * row's `.channel-row` markup, the neutral active pill with `aria-current`,
 * and the channel row's ONE-badge rule (mention count wins, else unread).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Thread } from '@cytale/domain';
import { createStateStore } from '@cytale/state';

import { MyThreadsSidebar } from '../MyThreadsSidebar.js';
import type { UseThreads } from '../useThreads.js';

afterEach(() => cleanup());

function thread(id: string, name: string): Thread {
  return {
    id,
    channel_id: 'c-1',
    parent_message_id: null,
    name,
    created_by: 'u-1',
    archived: false,
    member_state: { notify: true, last_read_id: null },
    created_at: '2026-09-01T00:00:00Z',
  } as Thread;
}

function setup(
  activeThreadId: string | null = null,
  overrides: Record<string, 'all' | 'mentions' | 'mute'> = {},
) {
  const store = createStateStore();
  store.setState({
    notificationPrefs: { overrides, suppressBroadcasts: {}, status: 'ready' },
    threadsById: {
      't-1': thread('t-1', 'mentioned'),
      't-2': thread('t-2', 'unread'),
      't-3': thread('t-3', 'quiet'),
    },
    unreadByThread: {
      't-1': { last_read_id: null, unread_count: 5, mention_count: 2 },
      't-2': { last_read_id: null, unread_count: 3, mention_count: 0 },
    },
  } as never);
  const counts: Record<string, number> = { 't-1': 5, 't-2': 3, 't-3': 0 };
  const threads = {
    openThread: vi.fn(),
    unreadCount: (id: string) => counts[id] ?? 0,
  } as unknown as UseThreads;
  render(<MyThreadsSidebar store={store} threads={threads} activeThreadId={activeThreadId} />);
}

const row = (id: string) =>
  screen.getAllByTestId('my-thread-row').find((r) => r.getAttribute('data-thread-id') === id)!;

describe('MyThreadsSidebar — the channel row standard', () => {
  it('renders .channel-row rows with the channel badge rule (mention wins, one badge)', () => {
    setup();
    const mentioned = row('t-1');
    expect(mentioned.className).toContain('channel-row');
    const badges1 = mentioned.querySelectorAll('[data-testid="my-thread-badge"]');
    expect(badges1).toHaveLength(1);
    expect(badges1[0]!.className).toBe('channel-mentions');
    expect(badges1[0]!.textContent).toBe('2');

    const unread = row('t-2').querySelector('[data-testid="my-thread-badge"]')!;
    expect(unread.className).toBe('channel-unread');
    expect(unread.textContent).toBe('3');

    // A followed thread with nothing new carries no badge — `notify` alone is
    // a follow setting, not news (it used to paint a permanent orange dot).
    expect(row('t-3').querySelector('[data-testid="my-thread-badge"]')).toBeNull();
    expect(row('t-3').getAttribute('data-unread')).toBeNull();
    expect(row('t-2').getAttribute('data-unread')).toBe('true');
  });

  // Notification controls (2026-09-27): a thread row reads at its effective
  // level — thread → channel → workspace — like a channel row.
  it('a muted thread dims, drops its unread badge, and keeps its mention badge', () => {
    setup(null, { 'thread:t-1': 'mute', 'thread:t-2': 'mute' });
    const mentioned = row('t-1');
    expect(mentioned.getAttribute('data-muted')).toBe('true');
    expect(mentioned.querySelector('[data-testid="my-thread-badge"]')!.className).toBe('channel-mentions');
    expect(mentioned.getAttribute('aria-label')).toContain('muted');

    const unread = row('t-2');
    expect(unread.querySelector('[data-testid="my-thread-badge"]')).toBeNull();
    expect(unread.getAttribute('data-unread')).toBeNull();
    expect(unread.querySelector('[data-testid="my-thread-muted"]')).not.toBeNull();
  });

  it('a thread inherits its channel: a mentions-only channel hides the unread count', () => {
    setup(null, { 'channel:c-1': 'mentions' });
    expect(row('t-2').querySelector('[data-testid="my-thread-badge"]')).toBeNull();
    // Mentions still show.
    expect(row('t-1').querySelector('[data-testid="my-thread-badge"]')!.textContent).toBe('2');
  });

  it('marks the open thread with the active pill and aria-current', () => {
    setup('t-2');
    expect(row('t-2').getAttribute('aria-current')).toBe('page');
    expect(row('t-2').getAttribute('data-active')).toBe('true');
    expect(row('t-1').getAttribute('aria-current')).toBeNull();
  });
});
