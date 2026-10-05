/**
 * #114 — the desktop shell's deep-link feed.
 *
 * Two arrivals, one handler: a link opened while the app RUNS (an event the
 * Rust shell emits) and the link the app was LAUNCHED with (retained by the
 * shell, because on a cold start the webview did not exist yet — an emitted
 * event would have had no listener). The tests pin both, and pin that the
 * default bridge is wired to the shell's actual channel names, since a typo
 * there fails silently in production (no link is delivered, nothing throws).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listenMock = vi.fn<
  (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
>(async () => () => undefined);

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) =>
    listenMock(event, handler),
}));

import {
  DEEP_LINK_EVENT,
  DEEP_LINK_TAKE_PENDING_COMMAND,
  parseDeepLink,
  subscribeToDeepLinks,
  type DeepLinkBridge,
} from '../deepLink.js';

/** A bridge that records what the subscription asked for. */
function fakeBridge(pending: unknown = null): {
  bridge: DeepLinkBridge;
  emit: (payload: unknown) => void;
  commands: string[];
  unlisten: ReturnType<typeof vi.fn>;
  events: string[];
} {
  let handler: ((event: { payload: unknown }) => void) | null = null;
  const commands: string[] = [];
  const events: string[] = [];
  const unlisten = vi.fn();
  return {
    bridge: {
      listen: async (event, cb) => {
        events.push(event);
        handler = cb;
        return unlisten;
      },
      invoke: async (command) => {
        commands.push(command);
        return pending;
      },
    },
    emit: (payload: unknown) => handler?.({ payload }),
    commands,
    unlisten,
    events,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('subscribeToDeepLinks — a link opened while the app runs', () => {
  it('delivers a parsed target for a well-formed link', async () => {
    const f = fakeBridge();
    const onTarget = vi.fn();
    await subscribeToDeepLinks(onTarget, f.bridge);

    f.emit('cytale://workspace/1001/channel/2002/message/3003');

    expect(onTarget).toHaveBeenCalledTimes(1);
    expect(onTarget.mock.calls[0]![0]).toEqual({
      kind: 'message',
      workspaceId: '1001',
      channelId: '2002',
      threadId: undefined,
      messageId: '3003',
    });
    // The raw string travels too, so a caller never has to re-serialize it.
    expect(onTarget.mock.calls[0]![1]).toBe('cytale://workspace/1001/channel/2002/message/3003');
  });

  it('ignores anything that is not a Cytale link (the OS can hand over junk)', async () => {
    const f = fakeBridge();
    const onTarget = vi.fn();
    await subscribeToDeepLinks(onTarget, f.bridge);

    for (const payload of [
      'https://example.com/workspace/1001',
      'cytale://workspace/not-an-id',
      'cytale://',
      '',
      null,
      42,
      { url: 'cytale://workspace/1001' },
    ]) {
      f.emit(payload);
    }

    expect(onTarget).not.toHaveBeenCalled();
  });

  it('returns the shell unlisten so the subscription can be torn down', async () => {
    const f = fakeBridge();
    const unlisten = await subscribeToDeepLinks(vi.fn(), f.bridge);
    expect(typeof unlisten).toBe('function');
    expect(() => unlisten()).not.toThrow();
  });
});

describe('subscribeToDeepLinks — the launch URL (cold start)', () => {
  it('takes the retained URL exactly once and delivers it', async () => {
    const f = fakeBridge('cytale://workspace/1001/channel/2002/message/3003');
    const onTarget = vi.fn();
    await subscribeToDeepLinks(onTarget, f.bridge);

    expect(f.commands).toEqual([DEEP_LINK_TAKE_PENDING_COMMAND]);
    expect(onTarget).toHaveBeenCalledTimes(1);
    expect(onTarget.mock.calls[0]![0]).toMatchObject({ kind: 'message', messageId: '3003' });

    // One-shot: the shell clears its copy when asked, so a second take (a
    // reload) comes back empty and nothing re-opens.
    const second = fakeBridge(null);
    await subscribeToDeepLinks(onTarget, second.bridge);
    expect(onTarget).toHaveBeenCalledTimes(1);
  });

  it('attaches the live listener BEFORE asking for the launch URL', async () => {
    // Otherwise a link that arrives during the handover — the exact window a
    // cold start opens — would be dropped.
    const order: string[] = [];
    const bridge: DeepLinkBridge = {
      listen: async () => {
        order.push('listen');
        return () => undefined;
      },
      invoke: async () => {
        order.push('invoke');
        return null;
      },
    };

    await subscribeToDeepLinks(vi.fn(), bridge);
    expect(order).toEqual(['listen', 'invoke']);
  });

  it('treats a non-string or malformed launch URL as no link', async () => {
    const onTarget = vi.fn();
    await subscribeToDeepLinks(onTarget, fakeBridge(undefined).bridge);
    await subscribeToDeepLinks(onTarget, fakeBridge('not a link').bridge);
    expect(onTarget).not.toHaveBeenCalled();
  });
});

describe('subscribeToDeepLinks — outside the shell', () => {
  it('is a no-op in a browser, and still returns a callable unlisten', async () => {
    const onTarget = vi.fn();
    const unlisten = await subscribeToDeepLinks(onTarget);
    expect(listenMock).not.toHaveBeenCalled();
    expect(onTarget).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });

  it('uses the shell bridge when __TAURI_INTERNALS__ is present', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => 'cytale://workspace/1001/channel/2002/message/3003'),
    };
    const onTarget = vi.fn();

    const unlisten = await subscribeToDeepLinks(onTarget);

    // The real channel names, pinned: the shell emits this event and answers
    // this command (apps/desktop/src-tauri/src/lib.rs).
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0]![0]).toBe(DEEP_LINK_EVENT);
    expect(DEEP_LINK_EVENT).toBe('cytale-deep-link');
    expect(DEEP_LINK_TAKE_PENDING_COMMAND).toBe('deep_link_take_pending');
    expect(
      (window as unknown as { __TAURI_INTERNALS__: { invoke: ReturnType<typeof vi.fn> } })
        .__TAURI_INTERNALS__.invoke,
    ).toHaveBeenCalledWith(DEEP_LINK_TAKE_PENDING_COMMAND);
    expect(onTarget).toHaveBeenCalledTimes(1);
    expect(() => unlisten()).not.toThrow();
  });

  it('survives a shell whose event binding is missing (older shell)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => 'cytale://workspace/1001'),
    };
    listenMock.mockRejectedValueOnce(new Error('no plugin:event'));

    const onTarget = vi.fn();
    // No throw: a shell that cannot deliver events still gets its launch URL.
    await subscribeToDeepLinks(onTarget);
    expect(onTarget).toHaveBeenCalledTimes(1);
  });
});

describe('parseDeepLink (unchanged contract, now one grammar)', () => {
  it('reads the scheme through the shared permalink grammar', () => {
    expect(parseDeepLink('cytale://workspace/1/channel/2/thread/3/message/4')).toEqual({
      kind: 'message',
      workspaceId: '1',
      channelId: '2',
      threadId: '3',
      messageId: '4',
    });
    // A DM address has no workspace segment — the grammar allows one root.
    expect(parseDeepLink('cytale://channel/2/message/4')).toEqual({
      kind: 'message',
      workspaceId: undefined,
      channelId: '2',
      threadId: undefined,
      messageId: '4',
    });
  });
});
