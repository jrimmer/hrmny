/**
 * @cytale/web — useComponentClick tests (components plan U4, KTD6).
 *
 * The per-control pending contract: the POST body is the message-keyed
 * interaction variant EXACTLY; pending is store-scoped by
 * (message_id, custom_id) so it survives hook unmount/remount (the
 * react-virtuoso pin); completion is the bot's answer — InteractionSuccess,
 * or the target message's edited_at/components changing — first signal
 * wins; a new bot-authored message is NOT an answer (an unacknowledged
 * click), and turns the deadline into the Dismiss-only "unacknowledged"
 * notice; the ~10s timeout otherwise lands the dismissable no-response
 * state with Retry while the watches stay armed (a late signal still
 * renders AND clears the stale affordance); POST failures classify into
 * permission-denied (403), dead/stale (410 + 400 component_unavailable),
 * and retryable errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';

import type { InteractionSuccess } from '@cytale/protocol';

import {
  receiveInteractionSuccess,
  resetInteractionAnswers,
  routeInteractionSuccessFrame,
} from '../../interactions/interactionAnswers.js';
import {
  COMPONENT_CLICK_TIMEOUT_MS,
  resetComponentClicks,
  useComponentClick,
} from '../useComponentClick.js';

const CHANNEL = '9007199254740993';
const BOT_ID = '8000000000000001';
const MESSAGE_ID = '1000000000000001';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let store: StateStore;
let seq = 1_000_000;

function seedMessage(overrides: Record<string, unknown> = {}): void {
  store.setState({
    messagesByChannel: {
      [CHANNEL]: {
        items: [
          {
            id: MESSAGE_ID,
            channel_id: CHANNEL,
            thread_id: null,
            author_id: BOT_ID,
            content: 'approve this?',
            created_at: '2026-09-06T12:00:00Z',
            edited_at: null,
            ...overrides,
          } as never,
        ],
        oldestId: null,
        hasCompleteHistory: true,
      },
    },
  });
}

/** The type-7 flip: MessageUpdate patches components + edited_at (U3 reconcile). */
function landFlip(components: unknown[]): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageUpdate',
    s: ++seq,
    d: {
      id: MESSAGE_ID,
      channel_id: CHANNEL,
      thread_id: null,
      content: 'approve this?',
      edited_at: '2026-09-06T12:00:05Z',
      components,
    },
  } as never);
}

/** The type-4/followup reply: an ordinary bot-authored MessageCreate. */
function landBotReply(content: string, authorId = BOT_ID): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageCreate',
    s: ++seq,
    d: {
      id: String(2_000_000_000_000_000 + seq),
      channel_id: CHANNEL,
      thread_id: null,
      author_id: authorId,
      content,
      created_at: '2026-09-06T12:00:06Z',
      edited_at: null,
    },
  } as never);
}

const BUTTON_ARGS = {
  messageId: MESSAGE_ID,
  channelId: CHANNEL,
  applicationId: BOT_ID,
  customId: 'approve-btn',
  componentType: 2,
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => jsonResponse(202, { interaction_id: '9300000000000001' }));
  vi.stubGlobal('fetch', fetchMock);
  store = createStateStore();
  store.setState({ currentUser: { id: '7000000000000002', username: 'me' } });
  seedMessage();
});

afterEach(() => {
  cleanup();
  resetComponentClicks();
  resetInteractionAnswers();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useComponentClick — invoke', () => {
  it('POSTs the message-keyed /interactions body exactly (no values key for buttons) and holds pending', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/v1/interactions');
    expect(JSON.parse(String(init.body))).toEqual({
      channel_id: CHANNEL,
      message_id: MESSAGE_ID,
      custom_id: 'approve-btn',
      component_type: 2,
      nonce: expect.stringMatching(/^.{1,64}$/),
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn')).toMatchObject({ kind: 'pending' });
  });

  it('carries select values verbatim (single-select v1)', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS, customId: 'model-pick', componentType: 3, values: ['glm-5.3'] });
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      channel_id: CHANNEL,
      message_id: MESSAGE_ID,
      custom_id: 'model-pick',
      component_type: 3,
      values: ['glm-5.3'],
      nonce: expect.any(String),
    });
  });

  it('pending is scoped per (message_id, custom_id) — another control is untouched', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    expect(result.current.statusFor(MESSAGE_ID, 'deny-btn').kind).toBe('idle');
    expect(result.current.statusFor('1000000000000002', 'approve-btn').kind).toBe('idle');
  });
});

describe('useComponentClick — composed watch (KTD6)', () => {
  it('EDITED-watch: a MessageUpdate flip (edited_at + components) clears pending', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');

    act(() => landFlip([{ type: 1, components: [{ type: 2, style: 1, label: 'Approved', custom_id: 'approve-btn', disabled: true }] }]));
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
    // The store row carries the flipped card.
    const row = store.getState().messagesByChannel[CHANNEL]!.items.find((m) => m.id === MESSAGE_ID);
    expect(row?.edited_at).toBe('2026-09-06T12:00:05Z');
    expect(row?.components).toHaveLength(1);
  });

  it('a type-4 reply resolves through its InteractionSuccess, with NO timeout affordance', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });

    act(() => landBotReply('done!'));
    act(() => {
      receiveInteractionSuccess(success({ nonce: sentNonce(), response_type: 4 }));
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');

    // The false-timeout pin: the deadline passing afterwards mints nothing.
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });

  it('a bot message WITHOUT an answer is not one: pending holds, then the Dismiss-only unacknowledged notice', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });

    // The 2026-10-04 shape: the bot acted and posted, but its acknowledgement
    // never reached the server.
    act(() => landBotReply('running the command…'));
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');

    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('unacknowledged');
    expect(result.current.resolutionCount(MESSAGE_ID, 'approve-btn')).toBe(0);

    // A late answer still clears it, and counts.
    act(() => {
      receiveInteractionSuccess(success({ nonce: sentNonce(), response_type: 6 }));
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
    expect(result.current.resolutionCount(MESSAGE_ID, 'approve-btn')).toBe(1);
  });

  it('a bot message after the no-response fallback turns it into the unacknowledged notice', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('no-response');

    act(() => landBotReply('done, eventually'));
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('unacknowledged');
  });

  it('ignores messages from other authors', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    act(() => landBotReply('human chatter', '7000000000000009'));
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('no-response');
  });

  it('the signal may land before the POST resolves (emit-before-ack race)', async () => {
    let releaseFetch: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const { result } = renderHook(() => useComponentClick(store));
    let clicked: Promise<void> = Promise.resolve();
    act(() => {
      clicked = result.current.click({ ...BUTTON_ARGS });
    });
    // Flush the microtask queue so the transport actually reaches fetch.
    await act(async () => {
      await Promise.resolve();
    });
    expect(releaseFetch).not.toBeNull();
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');

    // The flip lands while the REST call is still in flight.
    act(() => landFlip([]));
    await act(async () => {
      releaseFetch!(jsonResponse(202, { interaction_id: '9300000000000002' }));
      await clicked;
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });
});

describe('useComponentClick — timeout', () => {
  it('lands the dismissable no-response state at the 10s deadline; Retry re-POSTs', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });

    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS - 1);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');

    await act(async () => {
      vi.advanceTimersByTimeAsync(2);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn')).toMatchObject({
      kind: 'no-response',
    });

    await act(async () => {
      await result.current.retry(MESSAGE_ID, 'approve-btn');
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dismiss clears the affordance back to idle', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 2);
    });
    act(() => result.current.dismiss(MESSAGE_ID, 'approve-btn'));
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });

  it('watches stay armed store-side: a LATE flip renders and clears the stale affordance', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('no-response');

    // The bot answers after the client gave up: the card still flips.
    act(() => landFlip([{ type: 1, components: [{ type: 2, style: 1, label: 'Approved', custom_id: 'approve-btn', disabled: true }] }]));
    const row = store.getState().messagesByChannel[CHANNEL]!.items.find((m) => m.id === MESSAGE_ID);
    expect(row?.edited_at).not.toBeNull();
    // ...and the armed watch clears the stale affordance.
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });
});

describe('useComponentClick — virtualization remount (store-scoped pending)', () => {
  it('pending survives hook unmount; the flip clears it on the remounted instance', async () => {
    const first = renderHook(() => useComponentClick(store));
    await act(async () => {
      await first.result.current.click({ ...BUTTON_ARGS });
    });
    expect(first.result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');

    // Scroll out of the react-virtuoso window: the row (and its hook) unmount.
    first.unmount();

    // ...and back in: a FRESH hook instance reads the module-scoped registry.
    const second = renderHook(() => useComponentClick(store));
    expect(second.result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');

    act(() => landFlip([]));
    expect(second.result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });

  it('an answer landing while unmounted still resolves (watches are not component state)', async () => {
    const first = renderHook(() => useComponentClick(store));
    await act(async () => {
      await first.result.current.click({ ...BUTTON_ARGS });
    });
    first.unmount();

    act(() => {
      receiveInteractionSuccess(success({ nonce: sentNonce(), response_type: 4 }));
    });
    const second = renderHook(() => useComponentClick(store));
    expect(second.result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });
});

describe('useComponentClick — error classification', () => {
  it('403 → forbidden error (permission-denied copy class, Dismiss-only downstream)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { key: 'forbidden', code: 40303, message: 'no send right' } }),
    );
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn')).toMatchObject({
      kind: 'error',
      forbidden: true,
      dead: false,
    });
  });

  it('410 → dead error (the dead-button class)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(410, {
        error: {
          key: 'component_unavailable',
          code: 41001,
          message: 'The bot behind this component is no longer active.',
        },
      }),
    );
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn')).toMatchObject({
      kind: 'error',
      forbidden: false,
      dead: true,
    });
  });

  it('400 component_unavailable → dead (the stale-select submit class)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          key: 'component_unavailable',
          code: 40001,
          message: 'That component is not available on this message.',
        },
      }),
    );
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn')).toMatchObject({
      kind: 'error',
      dead: true,
    });
  });

  it('other 4xx → retryable error carrying the server message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(404, { error: { key: 'message_not_found', code: 40404, message: 'gone' } }),
      )
      .mockResolvedValueOnce(jsonResponse(202, { interaction_id: '9300000000000003' }));
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn')).toMatchObject({
      kind: 'error',
      error: 'gone',
      forbidden: false,
      dead: false,
    });

    await act(async () => {
      await result.current.retry(MESSAGE_ID, 'approve-btn');
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// InteractionSuccess — the server's exact "the bot answered" signal
// ---------------------------------------------------------------------------

/** The nonce the n-th click POST sent. */
function sentNonce(n = 0): string {
  return JSON.parse(String(fetchMock.mock.calls[n]![1]!.body)).nonce as string;
}

function success(overrides: Partial<InteractionSuccess> = {}): InteractionSuccess {
  return {
    interaction_id: '9300000000000001',
    nonce: null,
    application_id: BOT_ID,
    channel_id: CHANNEL,
    thread_id: null,
    message_id: MESSAGE_ID,
    custom_id: 'approve-btn',
    response_type: 6,
    ...overrides,
  };
}

describe('useComponentClick — InteractionSuccess resolves the click exactly', () => {
  // 4 reply, 5 deferred reply, 6 deferred update, 7 update, 9 modal. The
  // deferred two change nothing in the store — only this signal sees them.
  for (const responseType of [4, 5, 6, 7, 9]) {
    it(`response type ${responseType}: resolves by nonce, counts as answered, and the fallback never fires`, async () => {
      const { result } = renderHook(() => useComponentClick(store));
      await act(async () => {
        await result.current.click({ ...BUTTON_ARGS });
      });
      expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');

      act(() => {
        expect(receiveInteractionSuccess(success({ nonce: sentNonce(), response_type: responseType }))).toBe(true);
      });
      expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
      expect(result.current.resolutionCount(MESSAGE_ID, 'approve-btn')).toBe(1);

      await act(async () => {
        vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS * 2);
      });
      expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
    });
  }

  it('an answer that outruns the 202 (emit-before-ack) resolves by the nonce sent with the POST', async () => {
    let releaseFetch: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const { result } = renderHook(() => useComponentClick(store));
    let clicked: Promise<void> = Promise.resolve();
    act(() => {
      clicked = result.current.click({ ...BUTTON_ARGS });
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      receiveInteractionSuccess(success({ nonce: sentNonce(), response_type: 6 }));
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');

    await act(async () => {
      releaseFetch!(jsonResponse(202, { interaction_id: '9300000000000001' }));
      await clicked;
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS * 2);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
    expect(result.current.resolutionCount(MESSAGE_ID, 'approve-btn')).toBe(1);
  });

  it('resolves by interaction id when the event carries no nonce', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    act(() => {
      receiveInteractionSuccess(success({ interaction_id: '9300000000000001', nonce: null }));
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });

  it("another interaction's answer is not this click's", async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    act(() => {
      expect(receiveInteractionSuccess(success({ interaction_id: '9300000000000777', nonce: 'someone-else' }))).toBe(
        false,
      );
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');
  });

  it('a LATE answer clears the no-response fallback, and only the answer counts as completion', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('no-response');
    // The fallback is not an answer.
    expect(result.current.resolutionCount(MESSAGE_ID, 'approve-btn')).toBe(0);

    act(() => {
      receiveInteractionSuccess(success({ nonce: sentNonce(), response_type: 5 }));
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
    expect(result.current.resolutionCount(MESSAGE_ID, 'approve-btn')).toBe(1);
  });

  it("after Retry, the first attempt's late answer still resolves the control", async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    await act(async () => {
      await result.current.retry(MESSAGE_ID, 'approve-btn');
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');
    expect(sentNonce(1)).not.toBe(sentNonce(0));

    act(() => {
      receiveInteractionSuccess(success({ nonce: sentNonce(0) }));
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });

  it('a dismissed control ignores a later answer and counts nothing', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    await act(async () => {
      vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
    });
    act(() => result.current.dismiss(MESSAGE_ID, 'approve-btn'));
    act(() => {
      expect(receiveInteractionSuccess(success({ nonce: sentNonce() }))).toBe(false);
    });
    expect(result.current.resolutionCount(MESSAGE_ID, 'approve-btn')).toBe(0);
  });

  it('a card in a THREAD resolves through the same path', async () => {
    const THREAD = '9100000000000001';
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS, threadId: THREAD });
    });
    act(() => {
      receiveInteractionSuccess(success({ nonce: sentNonce(), thread_id: THREAD, response_type: 6 }));
    });
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });

  it('the gateway frame route takes InteractionSuccess dispatches and nothing else', async () => {
    const { result } = renderHook(() => useComponentClick(store));
    await act(async () => {
      await result.current.click({ ...BUTTON_ARGS });
    });
    const d = success({ nonce: sentNonce() });
    act(() => routeInteractionSuccessFrame({ op: 0, t: 'InteractionModal', s: 1, d }));
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('pending');
    act(() => routeInteractionSuccessFrame({ op: 0, t: 'InteractionSuccess', s: 2, d }));
    expect(result.current.statusFor(MESSAGE_ID, 'approve-btn').kind).toBe('idle');
  });
});
