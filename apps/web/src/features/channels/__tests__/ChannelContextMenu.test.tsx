/**
 * @cytale/web — channel context menu tests (calls plan U11, AM6/AM18).
 *
 * The per-room mute surface: opens via the keyboard-reachable "⋯" trigger,
 * right-click, and long-press (the menu's own mobile handling); the item
 * PATCHes the U4 route (asserted at the api seam) and the label flips
 * Mute/Unmute; failure renders an inline role=alert with the label
 * reverted. Axe zero violations with the menu open.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const setCallNotificationMute = vi.fn();
const getChannelMediaOverride = vi.fn();
const putChannelMediaOverride = vi.fn();
const setNotificationPreference = vi.fn();
const clearNotificationPreference = vi.fn();

// The api seam only: the REAL notificationMute + mediaOverrides stores run
// (their behavior is what these tests exercise through the menu).
vi.mock('../../auth/session.js', () => ({
  api: {
    setNotificationPreference: (...args: unknown[]) => setNotificationPreference(...args),
    clearNotificationPreference: (...args: unknown[]) => clearNotificationPreference(...args),
    setCallNotificationMute: (...args: unknown[]) =>
      setCallNotificationMute(...(args as [string, boolean])),
    getChannelMediaOverride: (...args: unknown[]) => getChannelMediaOverride(...(args as [string])),
    putChannelMediaOverride: (...args: unknown[]) =>
      putChannelMediaOverride(...(args as [string, Record<string, boolean | null>])),
  },
}));

import type { Channel } from '@cytale/domain';
import { defaultStore, emptyNotificationPrefs } from '@cytale/state';
import { within } from '@testing-library/react';

import { resetCallMuteStoreForTests } from '../../calls/ring/notificationMute.js';
import { resetMediaOverrideStoreForTests } from '../mediaOverrides.js';
import { ChannelListItem } from '../ChannelListItem.js';
import { LONG_PRESS_MS } from '../ChannelContextMenu.js';

const CH = '7700000000000000100';

const MASTER_ON = { calls: true, video: true, screenshare: true, overrides_allowed: true };

function overrideView(overrides?: {
  override?: Record<string, boolean | null>;
  overrides_allowed?: boolean;
}) {
  return {
    override: overrides?.override ?? { calls: null, video: null, screenshare: null },
    overrides_allowed: overrides?.overrides_allowed ?? true,
    master: { ...MASTER_ON, overrides_allowed: overrides?.overrides_allowed ?? true },
  };
}

function ch(): Channel {
  return {
    id: CH,
    workspace_id: '7700000000000050001',
    name: 'general',
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-06T00:00:00Z',
  };
}

beforeEach(() => {
  resetCallMuteStoreForTests();
  resetMediaOverrideStoreForTests();
  defaultStore.setState({ notificationPrefs: emptyNotificationPrefs() });
  setCallNotificationMute.mockReset();
  getChannelMediaOverride.mockReset();
  putChannelMediaOverride.mockReset();
  getChannelMediaOverride.mockResolvedValue(overrideView());
});

afterEach(() => {
  cleanup();
});

describe('channel context menu (open paths)', () => {
  it('opens from the keyboard-reachable ⋯ trigger', () => {
    render(<ChannelListItem channel={ch()} />);
    fireEvent.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    expect(screen.queryByTestId('channel-context-menu')).not.toBeNull();
    expect(screen.queryByTestId('channel-context-mute-rings')).not.toBeNull();
  });

  it('opens on right-click of the row (default menu suppressed)', () => {
    render(<ChannelListItem channel={ch()} />);
    const row = screen.getByTestId(`channel-${CH}`);
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.contextMenu(row)).toBe(false);
    expect(screen.queryByTestId('channel-context-menu')).not.toBeNull();
  });

  it('opens on ~500ms long-press (touch) — not before', () => {
    vi.useFakeTimers();
    try {
      render(<ChannelListItem channel={ch()} />);
      const row = screen.getByTestId(`channel-${CH}`);
      fireEvent.touchStart(row);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS - 10);
      });
      expect(screen.queryByTestId('channel-context-menu')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(20);
      });
      expect(screen.queryByTestId('channel-context-menu')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a scroll-abort (touchmove) cancels the long-press', () => {
    vi.useFakeTimers();
    try {
      render(<ChannelListItem channel={ch()} />);
      const row = screen.getByTestId(`channel-${CH}`);
      fireEvent.touchStart(row);
      fireEvent.touchMove(row);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 50);
      });
      expect(screen.queryByTestId('channel-context-menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channel context menu (mute interaction)', () => {
  it('mute: PATCH asserted + label flips to Unmute', async () => {
    setCallNotificationMute.mockResolvedValue({ muted: true });
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    expect(screen.getByTestId('channel-context-mute-rings').textContent).toContain('Mute call rings');

    await user.click(screen.getByTestId('channel-context-mute-rings'));

    expect(setCallNotificationMute).toHaveBeenCalledWith(CH, true);
    await waitFor(() => {
      expect(screen.getByTestId(`channel-context-trigger-${CH}`).getAttribute('aria-expanded')).toBe('false');
    });

    // Reopen: the label flipped.
    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await waitFor(() => {
      expect(screen.getByTestId('channel-context-mute-rings').textContent).toContain('Unmute call rings');
    });
  });

  it('unmute: second activation PATCHes {muted:false}', async () => {
    setCallNotificationMute.mockResolvedValueOnce({ muted: true });
    setCallNotificationMute.mockResolvedValueOnce({ muted: false });
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    const trigger = screen.getByTestId(`channel-context-trigger-${CH}`);
    await user.click(trigger);
    await user.click(screen.getByTestId('channel-context-mute-rings'));
    await user.click(trigger);
    const item = await screen.findByText('Unmute call rings');
    await user.click(item);

    expect(setCallNotificationMute).toHaveBeenNthCalledWith(1, CH, true);
    expect(setCallNotificationMute).toHaveBeenNthCalledWith(2, CH, false);
  });

  it('keyboard: item focused on open; Enter activates; Escape closes and refocuses the trigger', async () => {
    setCallNotificationMute.mockResolvedValue({ muted: true });
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    const trigger = screen.getByTestId(`channel-context-trigger-${CH}`);
    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByTestId('channel-context-mute-rings'));

    await user.keyboard('{Enter}');
    expect(setCallNotificationMute).toHaveBeenCalledWith(CH, true);

    // Reopen and escape: focus returns to the trigger, nothing activates.
    setCallNotificationMute.mockClear();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('channel-context-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(setCallNotificationMute).not.toHaveBeenCalled();
  });

  it('failure: inline role=alert with the label reverted', async () => {
    setCallNotificationMute.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await user.click(screen.getByTestId('channel-context-mute-rings'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull();
    });
    expect(screen.getByTestId('channel-context-mute-rings').textContent).toContain('Mute call rings');
  });

  it('axe: zero violations with the menu open', async () => {
    const { container } = render(
      <ul>
        <ChannelListItem channel={ch()} />
      </ul>,
    );
    fireEvent.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    expect(await axe(container)).toHaveNoViolations();
  });
});

// Notification controls (2026-09-27): the channel menu carries the level as a
// radio group with "Use workspace default", and the ring mute sits inside it.
describe('channel context menu — notifications group', () => {
  beforeEach(() => {
    setNotificationPreference.mockReset().mockResolvedValue(undefined);
    clearNotificationPreference.mockReset().mockResolvedValue(undefined);
    defaultStore.setState({ notificationPrefs: emptyNotificationPrefs() });
  });

  it('renders the three levels plus the workspace default, with the ring mute inside the group', async () => {
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);
    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));

    const group = screen.getByTestId('channel-context-notifications');
    const radios = within(group).getAllByRole('menuitemradio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'All messages',
      'Mentions only',
      'Nothing',
      'Use workspace default (Mentions only)',
    ]);
    // Inheriting: the default radio is the checked one.
    expect(screen.getByTestId('channel-context-level-inherit').getAttribute('aria-checked')).toBe('true');
    expect(within(group).getByTestId('channel-context-mute-rings')).toBeTruthy();
  });

  it('choosing Nothing writes the channel row, closes the menu and dims the row', async () => {
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} unread={4} mentions={0} />);
    expect(screen.getByTestId(`unread-${CH}`)).toBeTruthy();

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await user.click(screen.getByTestId('channel-context-level-mute'));

    expect(setNotificationPreference).toHaveBeenCalledWith('channel', 'mute', CH);
    await waitFor(() => expect(screen.queryByTestId('channel-context-menu')).toBeNull());
    const row = screen.getByTestId(`channel-${CH}`);
    expect(row.hasAttribute('data-muted')).toBe(true);
    expect(screen.queryByTestId(`unread-${CH}`)).toBeNull();
    expect(row.getAttribute('aria-label')).toContain('muted');
  });

  it('Use workspace default clears the channel row', async () => {
    defaultStore.setState({
      notificationPrefs: { ...emptyNotificationPrefs(), overrides: { [`channel:${CH}`]: 'all' } },
    });
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);
    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    expect(screen.getByTestId('channel-context-level-all').getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByTestId('channel-context-level-inherit'));
    expect(clearNotificationPreference).toHaveBeenCalledWith('channel', CH);
    expect(defaultStore.getState().notificationPrefs.overrides[`channel:${CH}`]).toBeUndefined();
  });

  it('a refused write keeps the menu open with an alert and rolls the radio back', async () => {
    setNotificationPreference.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);
    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await user.click(screen.getByTestId('channel-context-level-mute'));

    await waitFor(() => expect(screen.getByTestId('channel-context-notifications-error')).toBeTruthy());
    expect(screen.getByTestId('channel-context-level-inherit').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId(`channel-${CH}`).hasAttribute('data-muted')).toBe(false);
  });

  it('axe: zero violations with the notifications group open', async () => {
    const { container } = render(
      <ul>
        <ChannelListItem channel={ch()} />
      </ul>,
    );
    fireEvent.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await screen.findByTestId('channel-context-notifications');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('channel context menu — media overrides (calls V2 plan U8, R16)', () => {
  it('fetches the override view on open', async () => {
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await waitFor(() => {
      expect(getChannelMediaOverride).toHaveBeenCalledWith(CH);
    });
  });

  it('overrides NOT allowed → the media entries are hidden (visibility rule)', async () => {
    getChannelMediaOverride.mockResolvedValue(overrideView({ overrides_allowed: false }));
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await waitFor(() => {
      expect(getChannelMediaOverride).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('channel-context-media-calls')).toBeNull();
    expect(screen.queryByTestId('channel-context-media-video')).toBeNull();
    expect(screen.queryByTestId('channel-context-media-screenshare')).toBeNull();
    expect(screen.queryByTestId('channel-context-media-reset')).toBeNull();
    // The mute entry stays.
    expect(screen.queryByTestId('channel-context-mute-rings')).not.toBeNull();
  });

  it('overrides allowed → entries render with inherited labels', async () => {
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await waitFor(() => {
      expect(screen.getByTestId('channel-context-media-calls')).not.toBeNull();
    });

    expect(screen.getByTestId('channel-context-media-calls').textContent).toContain(
      'Calls: On (inherited)',
    );
    expect(screen.getByTestId('channel-context-media-video').textContent).toContain(
      'Video: On (inherited)',
    );
    expect(screen.getByTestId('channel-context-media-screenshare').textContent).toContain(
      'Screenshare: On (inherited)',
    );
    expect(screen.getByTestId('channel-context-media-reset').textContent).toContain(
      'Reset to workspace media defaults',
    );
  });

  it('toggle: PUT asserted with the full tri-state map; label flips to override', async () => {
    putChannelMediaOverride.mockImplementation(
      async (_cid: string, body: Record<string, boolean | null>) =>
        overrideView({ override: body }),
    );
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await user.click(await screen.findByTestId('channel-context-media-video'));

    await waitFor(() => {
      expect(putChannelMediaOverride).toHaveBeenCalledWith(CH, {
        calls: null,
        video: false,
        screenshare: null,
      });
    });

    // The label flipped in place (override), and the menu stays open for
    // the next capability.
    await waitFor(() => {
      expect(screen.getByTestId('channel-context-media-video').textContent).toContain(
        'Video: Off (override)',
      );
    });
    expect(screen.queryByTestId('channel-context-menu')).not.toBeNull();
  });

  it('reset: PUTs the all-null map and labels return to inherited', async () => {
    getChannelMediaOverride.mockResolvedValue(
      overrideView({ override: { calls: null, video: false, screenshare: null } }),
    );
    putChannelMediaOverride.mockImplementation(
      async (_cid: string, body: Record<string, boolean | null>) =>
        overrideView({ override: body }),
    );
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await waitFor(() => {
      expect(screen.getByTestId('channel-context-media-video').textContent).toContain(
        'Video: Off (override)',
      );
    });

    await user.click(screen.getByTestId('channel-context-media-reset'));

    await waitFor(() => {
      expect(putChannelMediaOverride).toHaveBeenCalledWith(CH, {
        calls: null,
        video: null,
        screenshare: null,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('channel-context-media-video').textContent).toContain(
        'Video: On (inherited)',
      );
    });
  });

  it('403 (plain member) → entries hidden, the fetch is the only call', async () => {
    getChannelMediaOverride.mockRejectedValue(
      Object.assign(new Error('Request denied.'), { status: 403 }),
    );
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await waitFor(() => {
      expect(getChannelMediaOverride).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('channel-context-media-calls')).toBeNull();
    expect(screen.queryByTestId('channel-context-media-reset')).toBeNull();
  });

  it('network failure → entries VISIBLE but disabled with the inline alert', async () => {
    getChannelMediaOverride.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await waitFor(() => {
      expect(screen.getByTestId('channel-context-media-calls')).not.toBeNull();
    });

    // #150: Radix menu items are divs — disabled rides on aria-disabled
    // (data-disabled), not the button element's `disabled` property.
    const calls = screen.getByTestId('channel-context-media-calls');
    expect(calls.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('channel-context-media-error')).not.toBeNull();
  });

  it('toggle failure → label reverts with the inline media alert', async () => {
    putChannelMediaOverride.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<ChannelListItem channel={ch()} />);

    await user.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await user.click(await screen.findByTestId('channel-context-media-calls'));

    await waitFor(() => {
      expect(putChannelMediaOverride).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('channel-context-media-error')).not.toBeNull();
    });
    expect(screen.getByTestId('channel-context-media-calls').textContent).toContain(
      'Calls: On (inherited)',
    );
  });

  it('axe: zero violations with the media entries visible', async () => {
    const { container } = render(
      <ul>
        <ChannelListItem channel={ch()} />
      </ul>,
    );
    fireEvent.click(screen.getByTestId(`channel-context-trigger-${CH}`));
    await screen.findByTestId('channel-context-media-calls');
    expect(await axe(container)).toHaveNoViolations();
  });
});
