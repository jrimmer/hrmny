/**
 * @cytale/web — a channel row at its notification level (notification
 * controls, 2026-09-27), and the shared badge rule behind it.
 *
 *   * all      → mention-or-unread (today's badge);
 *   * mentions → mention badge only (the row keeps its unread WEIGHT);
 *   * mute     → dimmed, bell-off glyph, no unread weight or count — but a
 *                mention badge still shows;
 *   * nothing set anywhere → the row reads as today (the product default is
 *     "mentions", and stripping every untouched channel's unread count is a
 *     change nobody chose — see `useRowLevel`).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/session.js', () => ({ api: {} }));

import type { Channel } from '@cytale/domain';
import { defaultStore, emptyNotificationPrefs } from '@cytale/state';

import { ChannelListItem } from '../ChannelListItem.js';
import { SidebarRowBadge, dmRowLevel, showsUnread } from '../SidebarRowBadge.js';

const WS = '5400000000000000001';
const CH = '5400000000000000100';

function ch(): Channel {
  return {
    id: CH,
    workspace_id: WS,
    name: 'general',
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-06T00:00:00Z',
  };
}

function withOverrides(overrides: Record<string, 'all' | 'mentions' | 'mute'>) {
  defaultStore.setState({ notificationPrefs: { ...emptyNotificationPrefs(), overrides, status: 'ready' } });
}

beforeEach(() => withOverrides({}));
afterEach(cleanup);

describe('SidebarRowBadge — the level rule', () => {
  it('all shows unread; mentions and mute do not; a mention always shows', () => {
    const { rerender } = render(<SidebarRowBadge unread={3} mentions={0} level="all" unreadTestId="u" mentionsTestId="m" />);
    expect(screen.getByTestId('u').textContent).toBe('3');
    rerender(<SidebarRowBadge unread={3} mentions={0} level="mentions" unreadTestId="u" mentionsTestId="m" />);
    expect(screen.queryByTestId('u')).toBeNull();
    rerender(<SidebarRowBadge unread={3} mentions={0} level="mute" unreadTestId="u" mentionsTestId="m" />);
    expect(screen.queryByTestId('u')).toBeNull();
    rerender(<SidebarRowBadge unread={3} mentions={2} level="mute" unreadTestId="u" mentionsTestId="m" />);
    expect(screen.getByTestId('m').textContent).toBe('2');
  });

  it('helpers: only all shows unread; a DM reads as all unless muted', () => {
    expect([showsUnread('all'), showsUnread('mentions'), showsUnread('mute')]).toEqual([true, false, false]);
    expect([dmRowLevel('all'), dmRowLevel('mentions'), dmRowLevel('mute')]).toEqual(['all', 'all', 'mute']);
  });
});

describe('ChannelListItem at its level', () => {
  it('nothing set: the unread count shows as it always has', () => {
    render(<ChannelListItem channel={ch()} unread={4} />);
    expect(screen.getByTestId(`unread-${CH}`).textContent).toBe('4');
    expect(screen.getByTestId(`channel-${CH}`).getAttribute('data-muted')).toBeNull();
  });

  it('muted: dimmed with the glyph, no unread, mention badge kept, name says muted', () => {
    withOverrides({ [`channel:${CH}`]: 'mute' });
    render(<ChannelListItem channel={ch()} unread={4} mentions={1} />);
    const row = screen.getByTestId(`channel-${CH}`);
    expect(row.getAttribute('data-muted')).toBe('true');
    expect(row.getAttribute('data-unread')).toBeNull();
    expect(screen.getByTestId(`muted-${CH}`)).toBeTruthy();
    expect(screen.queryByTestId(`unread-${CH}`)).toBeNull();
    expect(screen.getByTestId(`mentions-${CH}`).textContent).toBe('1');
    expect(row.getAttribute('aria-label')).toBe('general, muted, 1 mentions');
  });

  it('mentions only (set at the workspace): no count, but the row keeps its unread weight', () => {
    withOverrides({ [`workspace:${WS}`]: 'mentions' });
    render(<ChannelListItem channel={ch()} unread={4} />);
    const row = screen.getByTestId(`channel-${CH}`);
    expect(screen.queryByTestId(`unread-${CH}`)).toBeNull();
    expect(row.getAttribute('data-unread')).toBe('true');
    expect(row.getAttribute('data-muted')).toBeNull();
  });

  it('a level change re-renders the row live', async () => {
    render(<ChannelListItem channel={ch()} unread={4} />);
    expect(screen.getByTestId(`unread-${CH}`)).toBeTruthy();
    const { act } = await import('@testing-library/react');
    act(() => withOverrides({ [`channel:${CH}`]: 'mute' }));
    expect(screen.queryByTestId(`unread-${CH}`)).toBeNull();
    expect(screen.getByTestId(`channel-${CH}`).getAttribute('data-muted')).toBe('true');
  });
});
