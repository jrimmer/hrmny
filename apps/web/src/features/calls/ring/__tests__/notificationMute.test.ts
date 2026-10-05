/**
 * @cytale/web — notificationMute tests (calls plan U11, AM6 client half).
 *
 * The toggle round-trip: optimistic flip → PATCH via @cytale/api-client →
 * keep (server echo authoritative) or revert + `status: 'error'` for the
 * menu's inline alert. The api seam is faked at the session boundary.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setCallNotificationMute = vi.fn();

vi.mock('../../../auth/session.js', () => ({
  api: { setCallNotificationMute: (...args: unknown[]) => setCallNotificationMute(...(args as [string, boolean])) },
}));

import {
  getCallMute,
  isCallMuted,
  resetCallMuteStoreForTests,
  toggleCallMute,
  useCallMute,
} from '../notificationMute.js';

const CH = '7600000000000000100';

beforeEach(() => {
  resetCallMuteStoreForTests();
  setCallNotificationMute.mockReset();
});

afterEach(cleanup);

describe('notificationMute (client half of the durable setting)', () => {
  it('defaults to unmuted for unknown channels', () => {
    expect(getCallMute(CH)).toEqual({ muted: false, status: 'idle' });
    expect(isCallMuted(CH)).toBe(false);
  });

  it('mute: PATCHes {muted:true} and keeps the server echo', async () => {
    setCallNotificationMute.mockResolvedValue({ muted: true });

    await act(async () => {
      await toggleCallMute(CH);
    });

    expect(setCallNotificationMute).toHaveBeenCalledWith(CH, true);
    expect(getCallMute(CH)).toEqual({ muted: true, status: 'idle' });
    expect(isCallMuted(CH)).toBe(true);
  });

  it('unmute: PATCHes {muted:false} on the second toggle', async () => {
    setCallNotificationMute.mockResolvedValueOnce({ muted: true });
    setCallNotificationMute.mockResolvedValueOnce({ muted: false });

    await act(async () => {
      await toggleCallMute(CH);
    });
    await act(async () => {
      await toggleCallMute(CH);
    });

    expect(setCallNotificationMute).toHaveBeenNthCalledWith(1, CH, true);
    expect(setCallNotificationMute).toHaveBeenNthCalledWith(2, CH, false);
    expect(getCallMute(CH)).toEqual({ muted: false, status: 'idle' });
  });

  it('reverts optimistically and marks error when the PATCH fails', async () => {
    setCallNotificationMute.mockRejectedValue(new Error('offline'));

    await act(async () => {
      await toggleCallMute(CH); // attempted mute; fails
    });

    expect(getCallMute(CH)).toEqual({ muted: false, status: 'error' });
    expect(isCallMuted(CH)).toBe(false);
  });

  it('pending during the in-flight PATCH (the menu disables the item)', async () => {
    let release: (v: { muted: boolean }) => void = () => undefined;
    setCallNotificationMute.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = toggleCallMute(CH);
    });
    expect(getCallMute(CH)).toEqual({ muted: true, status: 'pending' });

    await act(async () => {
      release({ muted: true });
      await pending;
    });
    expect(getCallMute(CH)).toEqual({ muted: true, status: 'idle' });
  });

  it('useCallMute tracks the store reactively', async () => {
    setCallNotificationMute.mockResolvedValue({ muted: true });
    const { result } = renderHook(() => useCallMute(CH));
    expect(result.current.muted).toBe(false);

    await act(async () => {
      await toggleCallMute(CH);
    });
    expect(result.current.muted).toBe(true);
  });
});
