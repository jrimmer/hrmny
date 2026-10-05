/**
 * @cytale/web — MessageList tests (U21 slice 2).
 *
 * react-virtuoso needs real layout (jsdom has zero dimensions), so the
 * `Virtuoso` component is mocked to render all items in order and expose a
 * `startReached` trigger. This keeps the test focused on the message-list
 * DATA flow — the real unit under test:
 *   * newest 50 load on open,
 *   * scroll-up (startReached) loads older via the `before` cursor,
 *   * no duplicates / no gaps across pages,
 *   * new messages append at the bottom (store merge),
 *   * followOutput is wired to stick-to-bottom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import React, { Profiler } from 'react';
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}


import type { Message } from '@cytale/domain';
import {
  MESSAGE_SLICE_MAX,
  applyGatewayEvent,
  beginOptimisticSend,
  confirmOptimisticSend,
  createStateStore,
  markChannelRead,
  mergeChannelMessages,
  type StateStore,
} from '@cytale/state';

import { MessageList, forgetSavedListStates } from '../MessageList.js';
import { rememberReadingPosition } from '../readingAnchor.js';
import { revealMessageActions } from '../../../test/revealActions.js';
import { coarsePointerState } from '../../../test/setup.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';

// -- Virtuoso mock -----------------------------------------------------------
// Renders all items in order; captures the startReached callback so tests
// can simulate "scrolled to the top" (oldest) to trigger an older-page load,
// and the imperative scrollToIndex calls so a landing (#104/#114) can be
// asserted without a layout engine.
let startReachedCb: (() => void) | null = null;
let followOutputValue: unknown = null;
/** The last props the list handed Virtuoso (range/restore/components seams). */
let lastVirtuosoProps: Record<string, unknown> | null = null;
interface ScrollToIndexCall {
  index: number;
  align?: string;
  behavior?: string;
}
const scrollToIndexCalls: ScrollToIndexCall[] = [];
/**
 * Every committed (rows, firstItemIndex) pair the list handed Virtuoso, in
 * render order — the prepend-consistency assertions (#135/#137) read this:
 * the new index space and the longer data must arrive in the SAME render.
 */
const virtuosoRenderLog: Array<{ rows: number; firstItemIndex: number | undefined }> = [];

/** The last landing the list issued through Virtuoso's imperative handle. */
function lastLanding(): ScrollToIndexCall | undefined {
  return scrollToIndexCalls[scrollToIndexCalls.length - 1];
}

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  const Virtuoso = React.forwardRef(function Virtuoso(
    props: {
      data?: readonly unknown[];
      firstItemIndex?: number;
      itemContent: (index: number, data: unknown) => React.ReactNode;
      computeItemKey?: (index: number, data: unknown) => string;
      startReached?: () => void;
      followOutput?: unknown;
      context?: unknown;
      components?: {
        Header?: React.ComponentType<{ context?: unknown }>;
        Footer?: React.ComponentType<{ context?: unknown }>;
      };
    },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: (params: ScrollToIndexCall) => {
        scrollToIndexCalls.push(params);
      },
      scrollTo: () => {},
      scrollBy: () => {},
    }));
    startReachedCb = props.startReached ?? null;
    followOutputValue = props.followOutput;
    lastVirtuosoProps = props as unknown as Record<string, unknown>;
    const items = props.data ?? [];
    virtuosoRenderLog.push({ rows: items.length, firstItemIndex: props.firstItemIndex });
    const Header = props.components?.Header;
    const Footer = props.components?.Footer;
    return (
      <div data-testid="virtuoso-mock">
        {Header ? <Header context={props.context} /> : null}
        {items.map((item, i) => (
          <div key={props.computeItemKey?.(i, item) ?? i} data-testid="virtuoso-item">
            {props.itemContent(i, item)}
          </div>
        ))}
        {Footer ? <Footer context={props.context} /> : null}
      </div>
    );
  });
  return { Virtuoso };
});

// -- fetch mock --------------------------------------------------------------
// Serves paginated message history: page 1 = newest 50, page 2 = older 50,
// etc. Each page's `before` cursor is the oldest id of the previous page.
const ALL_MESSAGES: Message[] = Array.from({ length: 120 }, (_, i) => {
  const id = String(1000000000000000 + i); // ascending; newest = highest id
  return {
    id,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content: `message ${i}`,
    created_at: `2026-08-30T12:00:${String(i % 60).padStart(2, '0')}Z`,
    edited_at: null,
  };
});
// newest-first for the server response
const NEWEST_FIRST = [...ALL_MESSAGES].reverse();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = /\/channels\/[^/]+\/messages(?:\?([^#]*))?$/.exec(url);
      if (!m) return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
      const params = new URLSearchParams(m[1] ?? '');
      const before = params.get('before');
      const after = params.get('after');
      const limit = Number(params.get('limit') ?? 50);

      let page: Message[];
      if (after) {
        // The `limit` rows closest to the cursor that are newer, newest-first.
        page = ALL_MESSAGES.filter((msg) => BigInt(msg.id) > BigInt(after))
          .slice(0, limit)
          .reverse();
      } else if (!before) {
        page = NEWEST_FIRST.slice(0, limit);
      } else {
        const idx = NEWEST_FIRST.findIndex((msg) => msg.id === before);
        page = idx >= 0 ? NEWEST_FIRST.slice(idx + 1, idx + 1 + limit) : [];
      }
      const oldest = page.length > 0 ? page[page.length - 1]!.id : null;
      return jsonResponse(200, {
        items: page,
        cursor: { before: oldest, after: page[0]?.id ?? null, limit },
      });
    }),
  );
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

beforeEach(() => {
  startReachedCb = null;
  followOutputValue = null;
  lastVirtuosoProps = null;
  forgetSavedListStates();
  scrollToIndexCalls.length = 0;
  virtuosoRenderLog.length = 0;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MessageList — seed-message thread indicators', () => {
  /** Seed a thread hanging off a message in the loaded page. */
  function seedThread(store: StateStore, messageId: string, id: string, messageCount: number) {
    store.setState((s) => ({
      threadsById: {
        ...s.threadsById,
        [id]: {
          id,
          channel_id: CHANNEL,
          parent_message_id: messageId,
          name: 'Deploy talk',
          created_by: ME,
          archived: false,
          message_count: messageCount,
          latest_reply_at: messageCount > 0 ? '2026-08-30T12:30:00Z' : null,
          created_at: '2026-08-30T12:00:00Z',
        },
      },
      threadIdsByChannel: { ...s.threadIdsByChannel, [CHANNEL]: [id] },
    }));
  }

  it('marks a message that seeds a thread with replies', async () => {
    const store = makeStore();
    seedThread(store, '1000000000000119', '5000000000000001', 3);
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => {
      expect(screen.getByTestId('thread-indicator')).toBeTruthy();
    });
    expect(screen.getByTestId('thread-indicator').textContent).toContain('3 replies');
  });

  it('marks nothing for a thread with NO replies — a thread is its replies', async () => {
    const store = makeStore();
    seedThread(store, '1000000000000119', '5000000000000002', 0);
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    // The pre-2026-09-12 empty thread (started, never replied to) leaves no
    // mark on its seed message.
    expect(screen.queryByTestId('thread-indicator')).toBeNull();
  });

  // Invisible threads (2026-10-02): a thread ANOTHER principal starts on a
  // message in the open channel — a bot, a webhook, another member, another
  // device — reaches this client only as live events. The chip must appear
  // from them alone, with no roster refetch, and track every reply.
  it('a thread someone else starts shows its chip live once the first reply lands', async () => {
    const store = makeStore();
    const onOpenThread = vi.fn();
    const SEED = '1000000000000119';
    const TID = '5000000000000077';
    const BOT = '7000000000000099';
    let seq = 0;
    const ev = (t: string, d: unknown) =>
      ({ op: 0, t, s: ++seq, d }) as unknown as Parameters<typeof applyGatewayEvent>[1];
    const reply = (id: string, at: string) =>
      ev('ThreadMessageCreate', {
        id,
        channel_id: CHANNEL,
        thread_id: TID,
        author_id: BOT,
        content: `reply ${id}`,
        created_at: at,
        edited_at: null,
      });
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} onOpenThread={onOpenThread} />);
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    act(() => {
      applyGatewayEvent(
        store,
        ev('ThreadCreate', {
          id: TID,
          channel_id: CHANNEL,
          parent_message_id: SEED,
          name: 'Approve deploy?',
          created_by: BOT,
          created_at: '2026-08-30T12:00:00Z',
        }),
      );
    });
    // Created, no replies yet: a thread is its replies.
    expect(screen.queryByTestId('thread-indicator')).toBeNull();

    act(() => {
      applyGatewayEvent(store, reply('5000000000000078', '2026-08-30T12:01:00Z'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('thread-indicator').textContent).toContain('1 reply');
    });

    act(() => {
      applyGatewayEvent(store, reply('5000000000000079', '2026-08-30T12:02:00Z'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('thread-indicator').textContent).toContain('2 replies');
    });
    // The chip sits on the seed row and opens THIS thread.
    const chip = screen.getByTestId('thread-indicator');
    expect(chip.getAttribute('data-thread-id')).toBe(TID);
    expect(chip.closest(`[data-message-id="${SEED}"]`)).not.toBeNull();
    fireEvent.click(chip);
    expect(onOpenThread).toHaveBeenCalledWith(TID);
  });
});

describe('MessageList', () => {
  it('loads the newest 50 messages on open', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);

    await waitFor(() => {
      const items = store.getState().messagesByChannel[CHANNEL]?.items ?? [];
      expect(items).toHaveLength(50);
    });
    // newest-first: the first item is the highest id
    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items[0]!.id).toBe('1000000000000119');
  });

  it('scroll-up (startReached) loads older via the before cursor, no dupes/gaps', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    // Simulate scrolling to the top (oldest) → startReached fires.
    act(() => {
      startReachedCb?.();
    });

    await waitFor(() => {
      const items = store.getState().messagesByChannel[CHANNEL]!.items;
      expect(items).toHaveLength(100);
    });

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    // No duplicates.
    const ids = items.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // No gaps: 120 messages total, 100 loaded, contiguous ids.
    const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
    for (let i = 1; i < sorted.length; i++) {
      expect(Number(sorted[i]!) - Number(sorted[i - 1]!)).toBe(1);
    }
  });

  it('new messages append at the bottom (store merge) and followOutput is wired', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    // A new message arrives via gateway → merged into the store.
    const newest: Message = {
      id: '1000000000000120',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'brand new',
      created_at: '2026-08-30T12:01:00Z',
      edited_at: null,
    };
    act(() => {
      mergeChannelMessages(store, CHANNEL, [newest]);
    });

    await waitFor(() => {
      const items = store.getState().messagesByChannel[CHANNEL]!.items;
      expect(items).toHaveLength(51);
      expect(items[0]!.id).toBe('1000000000000120'); // newest at top (bottom of view)
    });

    // followOutput is a FUNCTION of the reader's position, not the constant
    // 'smooth': a constant follows every append, which yanks a reader who is
    // reading history down to the newest message (user report 2026-09-13).
    expect(typeof followOutputValue).toBe('function');
    const follow = followOutputValue as () => unknown;
    // 'auto', not 'smooth' (U14): an animated follow fought the instant pin.
    expect(follow(), 'at the end, new messages are followed').toBe('auto');

    // A wheel upward is the reader leaving the end — including one that lands
    // inside the old 64px "at the bottom" band, which is the case that stuck.
    fireEvent.wheel(screen.getByTestId('message-list'), { deltaY: -120 });
    expect(follow(), 'a reader who scrolled up is not followed').toBe(false);
  });

  it('renders the loaded messages through the list', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('message-list')).toBeTruthy();
  });
});

describe('MessageList — "Remind me…" gating (#54)', () => {
  it('offers the reminder action on a channel row, and not to a view-only viewer', async () => {
    const store = makeStore();
    const view = render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0));
    revealMessageActions();
    await waitFor(() => expect(screen.getAllByTestId('action-remind').length).toBeGreaterThan(0));

    view.unmount();
    render(<MessageList channelId={CHANNEL} store={makeStore()} currentUserId={ME} viewOnly />);
    await waitFor(() => expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0));
    revealMessageActions();
    expect(screen.queryAllByTestId('action-remind')).toHaveLength(0);
  });
});

describe('MessageList — prepend index-space consistency (#135/#137)', () => {
  it('a history page and its firstItemIndex decrement reach Virtuoso in the SAME render', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    // Scroll to the top (oldest) → the older page prepends 50 rows.
    act(() => {
      startReachedCb?.();
    });
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(100);
    });

    // The contract Virtuoso documents for `firstItemIndex`: the new index
    // space arrives with the prepended data in one render pass. The old
    // effect-based decrement committed the longer list under the OLD index
    // space for one full frame — two compensation passes in the exact
    // window (momentum, fast drags) where the upstream #946 recursion
    // oscillates.
    const at100 = virtuosoRenderLog.filter((entry) => entry.rows === 100);
    expect(at100.length).toBeGreaterThan(0);
    expect(at100.every((entry) => entry.firstItemIndex === 1_000_000 - 50)).toBe(true);

    // And nothing ever rendered the larger list under the stale index space.
    expect(virtuosoRenderLog.some((e) => e.rows === 100 && e.firstItemIndex === 1_000_000)).toBe(
      false,
    );
    // The 50-row first page rode the initial index space, untouched.
    expect(
      virtuosoRenderLog.every(
        (e) => e.rows !== 50 || e.firstItemIndex === 1_000_000,
      ),
    ).toBe(true);
  });

  it('an overlapping history page (duplicate ids across the prepend boundary) renders each row once and never crashes', async () => {
    const consoleErrors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });

    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    // A page fetched "before id …070" that ALSO carries rows the store
    // already has (cursor drift / rows created between page fetches): ids
    // 70–74 are duplicates of loaded rows, 65–69 are genuinely older.
    const seq = (m: Message) => Number(m.id) - 1_000_000_000_000_000;
    const overlap = [
      ...NEWEST_FIRST.filter((m) => seq(m) >= 70 && seq(m) <= 74),
      ...NEWEST_FIRST.filter((m) => seq(m) >= 65 && seq(m) <= 69),
    ];
    expect(overlap.map(seq)).toEqual([74, 73, 72, 71, 70, 69, 68, 67, 66, 65]);
    act(() => {
      mergeChannelMessages(store, CHANNEL, overlap, { isLastPage: false });
    });

    // The store (the merge is the source) dropped the duplicates: 55 rows,
    // all unique — the duplicate keys that feed the virtuoso emit-graph
    // oscillation cannot exist at the list boundary.
    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(55);
    const ids = items.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The list rendered every row exactly once — no React duplicate-key
    // warning, no crash.
    const rendered = screen.getAllByTestId('virtuoso-item');
    expect(rendered).toHaveLength(55);
    const renderedKeys = rendered.map(
      (el) => el.querySelector('[data-testid="message-item"]')!.getAttribute('data-message-id'),
    );
    expect(new Set(renderedKeys).size).toBe(55);
    expect(consoleErrors.some((line) => /duplicate key/i.test(line))).toBe(false);
    spy.mockRestore();

    // The prepend bookkeeping matches: the previous oldest (id …070) now sits
    // at index 5, so the index space moved by exactly the 5 NEW rows.
    expect(
      virtuosoRenderLog
        .filter((e) => e.rows === 55)
        .every((e) => e.firstItemIndex === 1_000_000 - 5),
    ).toBe(true);
  });

  // #9: the top LOSING a row moves the index space UP by the rows removed —
  // an unchanged index read as "every later row moved up one", which slid a
  // reader scrolled up by a row per eviction.
  it('a removed head (the oldest loaded row deleted) advances the index space by one, never decrements', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    // The oldest loaded row (id …070) is deleted while the pane is open: the
    // head id changes, but nothing was PREPENDED — a decrement here would
    // shift every remaining row's index. The remaining rows KEEP their
    // indices, so the first index is one higher than before.
    act(() => {
      const slice = store.getState().messagesByChannel[CHANNEL]!;
      store.setState({
        messagesByChannel: {
          ...store.getState().messagesByChannel,
          [CHANNEL]: {
            ...slice,
            items: slice.items.filter((m) => m.id !== '1000000000000070'),
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('virtuoso-item')).toHaveLength(49);
    });
    expect(
      virtuosoRenderLog.every(
        (e) => e.rows !== 49 || e.firstItemIndex === 1_000_001,
      ),
    ).toBe(true);
  });
});

describe('MessageList — attribution wiring (U12)', () => {
  const PARENT_ID = '7000000000000100';
  const BOT_ID = '7000000000000101';
  const HOOK_ID = '7000000000000102';

  function memberRow(
    id: string,
    username: string,
    kind?: 'bot' | 'webhook',
    parentUserId?: string,
  ) {
    return {
      id,
      username,
      nickname: null,
      joined_at: '2026-01-01T00:00:00Z',
      roles: [],
      kind,
      parent_user_id: parentUserId,
    };
  }

  it('badges bot/webhook authors off the members projection, naming the parent; unknown authors get none', async () => {
    const store = makeStore();
    store.setState({
      membersById: {
        [PARENT_ID]: memberRow(PARENT_ID, 'janedoe'),
        [BOT_ID]: memberRow(BOT_ID, 'release-bot', 'bot', PARENT_ID),
        [HOOK_ID]: memberRow(HOOK_ID, 'deploy-hook', 'webhook', PARENT_ID),
      },
    });

    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });

    // The fetched history rows are authored by ME (absent from the members
    // projection → no badge). Two gateway rows land from a bot and a webhook.
    act(() => {
      mergeChannelMessages(store, CHANNEL, [
        {
          id: '1000000000000120',
          channel_id: CHANNEL,
          thread_id: null,
          author_id: BOT_ID,
          content: 'release cut',
          created_at: '2026-08-30T12:01:00Z',
          edited_at: null,
        },
        {
          id: '1000000000000121',
          channel_id: CHANNEL,
          thread_id: null,
          author_id: HOOK_ID,
          content: 'deploy done',
          created_at: '2026-08-30T12:02:00Z',
          edited_at: null,
        },
      ]);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('kind-badge')).toHaveLength(2);
    });

    const badges = screen.getAllByTestId('kind-badge');
    expect(badges.map((b) => b.getAttribute('data-kind'))).toEqual(['bot', 'webhook']);
    for (const badge of badges) {
      // Parent display name resolves through the same members projection. The
      // seal carries it in the tooltip; the row announces it (sr-only). The
      // `:bot` author reads "Agent" like any machine credential (R1).
      const word = badge.getAttribute('data-kind') === 'webhook' ? 'Webhook' : 'Agent';
      expect(badge.getAttribute('title')).toBe(`${word} account, via janedoe`);
      expect(screen.getAllByText(`${word} account, via janedoe`).length).toBeGreaterThan(0);
    }
  });
});

describe('MessageList — author-group spacing (owner, 2026-09-29)', () => {
  const PEER = '7000000000000200';
  const rowOf = (id: string) =>
    document.querySelector(`[data-testid="message-item"][data-message-id="${id}"]`)!;
  const wrapperOf = (id: string) => rowOf(id).closest('[data-testid="message-row"]')!;

  it('opens a gap above a new author group only — never inside one, never after a divider', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50);
    });
    const at = (id: string, author: string, content: string): Message => ({
      id,
      channel_id: CHANNEL,
      thread_id: null,
      author_id: author,
      content,
      created_at: '2026-08-30T12:01:00Z',
      edited_at: null,
    });
    act(() => {
      mergeChannelMessages(store, CHANNEL, [
        at('1000000000000120', PEER, 'peer one'),
        at('1000000000000121', PEER, 'peer two'),
        at('1000000000000122', ME, 'me again'),
      ]);
    });
    await waitFor(() => expect(rowOf('1000000000000122')).toBeTruthy());

    // A new author under another group: the gap, as wrapper PADDING (a
    // margin would collapse out of the virtuoso item and escape measurement).
    const peerStart = wrapperOf('1000000000000120');
    expect(peerStart.getAttribute('data-group-gap')).toBe('true');
    expect(peerStart.className).toBe('pt-3');
    expect(wrapperOf('1000000000000122').getAttribute('data-group-gap')).toBe('true');

    // A same-author continuation: exactly as tight as before.
    const cont = wrapperOf('1000000000000121');
    expect(cont.hasAttribute('data-group-gap')).toBe(false);
    expect(cont.className).toBe('');
    expect(rowOf('1000000000000121').getAttribute('data-grouped')).toBe('true');
    expect(rowOf('1000000000000121').className).toContain('py-0');

    // The highlighted box is the INNER row: the gap never carries the tint.
    expect(peerStart.className).not.toContain('hover:');
    expect(rowOf('1000000000000120').className).toContain('hover:bg-surface-strong/25');
    expect(rowOf('1000000000000120').className).not.toMatch(/\bm[ty]-/);

    // The first row of the window sits under a day divider, which already
    // provides the space: no double gap.
    const first = document.querySelector('[data-testid="message-item"]')!;
    expect(first.closest('[data-testid="message-row"]')!.hasAttribute('data-group-gap')).toBe(
      false,
    );
  });
});

describe('MessageList — unread boundary landing (#104)', () => {
  const OTHER = '7000000000000009';

  // 11-message newest page (ids 100–110 ascending). The two newest (109,
  // 110) come from another user; own rows never accrue unread, so a divider
  // must point at 109, never an own row.
  const WINDOW: Message[] = Array.from({ length: 11 }, (_, i) => {
    const id = String(100 + i);
    return {
      id,
      channel_id: CHANNEL,
      thread_id: null,
      author_id: i >= 9 ? OTHER : ME,
      content: `msg ${id}`,
      created_at: `2026-08-30T12:00:${String(i).padStart(2, '0')}Z`,
      edited_at: null,
    };
  });

  function installWindowFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          items: [...WINDOW].reverse(),
          cursor: { before: '100', after: '110', limit: 50 },
        }),
      ),
    );
  }

  /**
   * Render the list the way the pane does: the store carries the LIVE slice
   * (what the pane captured pre-ack and what its ack is about to clear), and
   * the held capture rides the `unreadAtOpen` prop. The list itself no longer
   * reads the store's unread slice — that read is the race #104 fixed.
   */
  function renderWithUnread(
    store: StateStore,
    held: { lastReadId: string | null; unreadCount: number; unreadFloor?: string | null } | null,
    props: { focusMessageId?: string | null; liveUnreadFloor?: string | null } = {},
  ) {
    return render(
      <MessageList
        channelId={CHANNEL}
        store={store}
        currentUserId={ME}
        unreadAtOpen={held}
        {...props}
      />,
    );
  }

  function seedUnread(
    store: StateStore,
    unread: { last_read_id: string | null; unread_count: number },
  ): void {
    store.setState({
      unreadByChannel: { [CHANNEL]: { ...unread, mention_count: 0 } },
    });
  }

  /** The divider element inside the row rendering message 109, if any. */
  function dividerOn109(): Element | null {
    const host = screen
      .getAllByTestId('virtuoso-item')
      .find((el) => el.textContent?.includes('msg 109'));
    return host?.querySelector('[data-testid="unread-divider"]') ?? null;
  }

  beforeEach(() => {
    startReachedCb = null;
    installWindowFetch();
  });

  it('renders the NEW rule above the first unread message, not above read rows', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '108', unread_count: 2 });
    renderWithUnread(store, { lastReadId: '108', unreadCount: 2 });

    await waitFor(() => {
      expect(dividerOn109()).not.toBeNull();
    });
    // The last-read row (108) and everything older carry no divider.
    const host108 = screen
      .getAllByTestId('virtuoso-item')
      .find((el) => el.textContent?.includes('msg 108'));
    expect(host108?.querySelector('[data-testid="unread-divider"]')).toBeNull();
    expect(screen.getAllByTestId('unread-divider')).toHaveLength(1);
  });

  it('a floor alone places the rule on the floored message (a fired reminder, count 0 — #54)', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '110', unread_count: 0 });
    renderWithUnread(store, { lastReadId: '110', unreadCount: 0, unreadFloor: '109' });

    await waitFor(() => {
      expect(dividerOn109()).not.toBeNull();
    });
    expect(screen.getAllByTestId('unread-divider')).toHaveLength(1);
  });

  it('a reminder firing while the pane is open draws the rule on the floored message (#54)', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '110', unread_count: 0 });
    const view = renderWithUnread(store, { lastReadId: '110', unreadCount: 0 });
    await waitFor(() => {
      expect(screen.getAllByTestId('virtuoso-item').length).toBeGreaterThan(0);
    });
    expect(screen.queryAllByTestId('unread-divider')).toHaveLength(0);

    view.rerender(
      <MessageList
        channelId={CHANNEL}
        store={store}
        currentUserId={ME}
        unreadAtOpen={{ lastReadId: '110', unreadCount: 0 }}
        liveUnreadFloor="109"
      />,
    );
    await waitFor(() => {
      expect(dividerOn109()).not.toBeNull();
    });
  });

  it('lands the open on the boundary with context above it — not on the newest row', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '108', unread_count: 2 });
    renderWithUnread(store, { lastReadId: '108', unreadCount: 2 });

    await waitFor(() => {
      expect(dividerOn109()).not.toBeNull();
    });
    // 109 is the last of the eleven rendered rows (chronological index 9);
    // the landing targets two rows above it, at the top of the pane.
    expect(lastLanding()).toMatchObject({ index: 7, align: 'start' });
  });

  it('the capture and the landing survive the pane’s read ack (Discord retention)', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '108', unread_count: 2 });
    renderWithUnread(store, { lastReadId: '108', unreadCount: 2 });

    await waitFor(() => {
      expect(dividerOn109()).not.toBeNull();
    });
    const landing = lastLanding();

    // The pane's open-ack clears the store slice (markChannelRead is what
    // MessagePane's effect runs) — the held line must survive it, and must
    // not be re-landed on.
    act(() => {
      markChannelRead(store, CHANNEL, '110');
    });
    expect(store.getState().unreadByChannel[CHANNEL]?.unread_count).toBe(0);
    expect(dividerOn109()).not.toBeNull();
    expect(lastLanding()).toEqual(landing);

    // A newer message landing while the pane is open is read instantly and
    // never re-divides.
    act(() => {
      mergeChannelMessages(store, CHANNEL, [
        {
          id: '111',
          channel_id: CHANNEL,
          thread_id: null,
          author_id: OTHER,
          content: 'msg 111',
          created_at: '2026-08-30T12:01:00Z',
          edited_at: null,
        },
      ]);
    });
    expect(dividerOn109()).not.toBeNull();
    expect(screen.getAllByTestId('unread-divider')).toHaveLength(1);
    expect(lastLanding()).toEqual(landing);
  });

  it('no divider and no boundary landing when the channel is fully read', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '110', unread_count: 0 });
    renderWithUnread(store, { lastReadId: '110', unreadCount: 0 });

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(11);
    });
    expect(screen.queryByTestId('unread-divider')).toBeNull();
    // Nothing to land on: the end is where the open lands, as before #104.
    expect(scrollToIndexCalls).toHaveLength(0);
    expect(followOutputValue).toBeTypeOf('function');
  });

  it('no boundary landing when the pane has not answered yet (no held slice)', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '108', unread_count: 2 });
    // The list is not allowed to fall back to the store slice: that read is
    // the race (the ack clears it before rows exist).
    renderWithUnread(store, null);

    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(11);
    });
    expect(screen.queryByTestId('unread-divider')).toBeNull();
    expect(scrollToIndexCalls).toHaveLength(0);
  });

  it('a null watermark (never read this session) reads the whole window as new: the rule opens the list', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: null, unread_count: 2 });
    renderWithUnread(store, { lastReadId: null, unreadCount: 2 });

    // Positional, like `useThreads.firstUnreadId`: with no watermark every
    // loaded row is new, so the boundary is the oldest one loaded — not the
    // oldest row somebody OTHER than you wrote.
    await waitFor(() => {
      const first = screen.getAllByTestId('virtuoso-item')[0]!;
      expect(first.querySelector('[data-testid="unread-divider"]')).not.toBeNull();
      expect(first.textContent).toContain('msg 100');
    });
    expect(screen.getAllByTestId('unread-divider')).toHaveLength(1);
    expect(lastLanding()).toMatchObject({ index: 0, align: 'start' });
  });

  it('a permalink (#114) outranks the unread jump: the rule draws, the landing yields', async () => {
    const store = makeStore();
    seedUnread(store, { last_read_id: '108', unread_count: 2 });
    renderWithUnread(store, { lastReadId: '108', unreadCount: 2 }, { focusMessageId: '105' });

    await waitFor(() => {
      expect(dividerOn109()).not.toBeNull();
    });
    // The link's own landing (the focus resolver, align 'center') is the only
    // scroll: the boundary jump must not fight it.
    expect(scrollToIndexCalls.some((c) => c.align === 'start')).toBe(false);
    expect(lastLanding()).toMatchObject({ align: 'center' });
  });
});

describe('MessageList — the boundary above the loaded window (#104)', () => {
  const OTHER = '7000000000000009';
  /** 120 rows: everything at index >= 60 is a colleague's unread traffic. */
  const PAGED: Message[] = Array.from({ length: 120 }, (_, i) => ({
    id: String(1000000000000000 + i),
    channel_id: CHANNEL,
    thread_id: null,
    author_id: i >= 60 ? OTHER : ME,
    content: `paged ${i}`,
    created_at: `2026-08-30T12:00:${String(i % 60).padStart(2, '0')}Z`,
    edited_at: null,
  }));
  const PAGED_NEWEST_FIRST = [...PAGED].reverse();

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const m = /\/channels\/[^/]+\/messages(?:\?([^#]*))?$/.exec(url);
        if (!m) return jsonResponse(404, { error: { key: 'not_found', code: 40404 } });
        const params = new URLSearchParams(m[1] ?? '');
        const before = params.get('before');
        const limit = Number(params.get('limit') ?? 50);
        let page: Message[];
        if (!before) {
          page = PAGED_NEWEST_FIRST.slice(0, limit);
        } else {
          const idx = PAGED_NEWEST_FIRST.findIndex((msg) => msg.id === before);
          page = idx >= 0 ? PAGED_NEWEST_FIRST.slice(idx + 1, idx + 1 + limit) : [];
        }
        return jsonResponse(200, {
          items: page,
          cursor: {
            before: page.length > 0 ? page[page.length - 1]!.id : null,
            after: page[0]?.id ?? null,
            limit,
          },
        });
      }),
    );
  });

  it('pages older history until the watermark is in view, then lands on the true first unread', async () => {
    const store = makeStore();
    // 59 rows newer than the watermark (rows 61..119). The newest page holds
    // only the 50 at 70..119, so the boundary (row 61) is ABOVE it.
    render(
      <MessageList
        channelId={CHANNEL}
        store={store}
        currentUserId={ME}
        unreadAtOpen={{ lastReadId: '1000000000000060', unreadCount: 59 }}
      />,
    );

    // Page 1 (50 newest) brings nothing at or below the watermark, so a
    // second page is fetched; the walk stops as soon as row 60 is in view.
    await waitFor(() => {
      expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(100);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('unread-divider')).toHaveLength(1);
    });

    // The rule sits above row 61 — the first row newer than the watermark —
    // which is chronological index 41 of the 100 loaded rows.
    const ruled = screen
      .getAllByTestId('virtuoso-item')
      .find((el) => el.querySelector('[data-testid="unread-divider"]') !== null);
    expect(ruled?.textContent).toContain('paged 61');
    expect(lastLanding()).toMatchObject({ index: 39, align: 'start' });
  });
});

// ---------------------------------------------------------------------------
// U3 — touch message actions: the long-press sheet HOST
// ---------------------------------------------------------------------------

describe('MessageList — long-press actions sheet (U3)', () => {
  const WEB_ROOT = join(__dirname, '..', '..', '..', '..');

  interface Harness {
    onReply: ReturnType<typeof vi.fn>;
    onEditSubmit: ReturnType<typeof vi.fn>;
    onDeleteConfirmed: ReturnType<typeof vi.fn>;
    onStartThreadNamed: ReturnType<typeof vi.fn>;
    onToggleReaction: ReturnType<typeof vi.fn>;
    store: StateStore;
    unmount: () => void;
  }

  function renderHarness(): Harness {
    const handlers = {
      onReply: vi.fn(),
      onEditSubmit: vi.fn(),
      onDeleteConfirmed: vi.fn(),
      onStartThreadNamed: vi.fn(),
      onToggleReaction: vi.fn(),
    };
    const store = makeStore();
    const view = render(
      <MessageList
        channelId={CHANNEL}
        store={store}
        currentUserId={ME}
        {...handlers}
      />,
    );
    return { ...handlers, store, unmount: view.unmount };
  }

  /** Long-press a row by its message content (450ms hold, coarse state). */
  function longPressRow(harness: Harness, content: string): HTMLElement {
    const row = screen.getByText(content).closest<HTMLElement>('[data-testid="message-item"]')!;
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 20, clientY: 20 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    return row;
  }

  afterEach(() => {
    coarsePointerState.coarse = false;
  });

  it('coarse pointer + long-press opens the sheet listing the full action set for an OWN message', async () => {
    coarsePointerState.coarse = true;
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      longPressRow(harness, 'message 100');
      expect(screen.getByTestId('message-actions-sheet')).toBeTruthy();
      for (const id of [
        'sheet-action-react',
        'sheet-action-reply',
        'sheet-action-edit',
        'sheet-action-thread',
        'sheet-action-copy',
        'sheet-action-delete',
      ]) {
        expect(screen.getByTestId(id), id).toBeTruthy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("another user's message hides edit + delete in the sheet; delete appears with manage-messages", async () => {
    coarsePointerState.coarse = true;
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });
    const other: Message = {
      id: '1000000000000150',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: '7000000000000001',
      content: 'not mine',
      created_at: '2026-08-30T12:02:00Z',
      edited_at: null,
    };
    act(() => {
      mergeChannelMessages(harness.store, CHANNEL, [other]);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      longPressRow(harness, 'not mine');
      expect(screen.getByTestId('message-actions-sheet')).toBeTruthy();
      expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
      expect(screen.queryByTestId('sheet-action-delete')).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // Same row, viewer holds MANAGE_MESSAGES: delete becomes reachable.
    harness.unmount();
    const manage = render(
      <MessageList
        channelId={CHANNEL}
        store={harness.store}
        currentUserId={ME}
        canManageMessages
        onEditSubmit={vi.fn()}
        onDeleteConfirmed={vi.fn()}
      />,
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = screen.getByText('not mine').closest<HTMLElement>('[data-testid="message-item"]')!;
      fireEvent.pointerDown(row, { pointerId: 1, clientX: 20, clientY: 20 });
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
      expect(screen.getByTestId('sheet-action-delete')).toBeTruthy();
    } finally {
      vi.useRealTimers();
      manage.unmount();
    }
  });

  it('Add Reaction from the sheet routes through onToggleReaction (same seam as the hover picker); Reply through onReply', async () => {
    coarsePointerState.coarse = true;
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      longPressRow(harness, 'message 100');

      fireEvent.click(screen.getByTestId('sheet-action-react'));
      fireEvent.click(
        screen
          .getAllByTestId('reaction-favorite')
          .find((c) => c.getAttribute('data-emoji') === '🎉')!,
      );
      expect(harness.onToggleReaction).toHaveBeenCalledTimes(1);
      expect(harness.onToggleReaction).toHaveBeenCalledWith(
        screen.getByText('message 100').closest('[data-testid="message-item"]')!.getAttribute('data-message-id'),
        '🎉',
      );
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();

      // Reply: the same callback the hover arrow drives.
      longPressRow(harness, 'message 100');
      fireEvent.click(screen.getByTestId('sheet-action-reply'));
      expect(harness.onReply).toHaveBeenCalledTimes(1);
      expect(harness.onReply.mock.calls[0]![0].content).toBe('message 100');
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Edit from the sheet commits via onEditSubmit WITHOUT window.prompt (in-app input)', async () => {
    coarsePointerState.coarse = true;
    const promptSpy = vi.spyOn(window, 'prompt');
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = longPressRow(harness, 'message 100');
      const rowId = row.getAttribute('data-message-id');
      fireEvent.click(screen.getByTestId('sheet-action-edit'));
      // The sheet edits in the shared Lexical editor (pills, palettes) — the
      // same one the desktop row uses; Lexical tags its root with the editor.
      const input = screen.getByTestId('sheet-edit-input');
      await waitFor(() => expect(input.textContent).toBe('message 100'));
      const lexical = (input as unknown as { __lexicalEditor: LexicalEditor }).__lexicalEditor;
      lexical.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode().append($createTextNode('message 100 (fixed)')));
      });
      await waitFor(() =>
        expect(lexical.getEditorState().read(() => $getRoot().getTextContent())).toBe(
          'message 100 (fixed)',
        ),
      );
      fireEvent.click(screen.getByTestId('sheet-edit-save'));
      await waitFor(() =>
        expect(harness.onEditSubmit).toHaveBeenCalledWith(rowId, 'message 100 (fixed)'),
      );
      expect(promptSpy).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByTestId('message-actions-sheet')).toBeNull());
    } finally {
      vi.useRealTimers();
      promptSpy.mockRestore();
    }
  });

  it('Start Thread from the sheet derives the name from the message — no window.prompt', async () => {
    coarsePointerState.coarse = true;
    const promptSpy = vi.spyOn(window, 'prompt');
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      longPressRow(harness, 'message 100');
      fireEvent.click(screen.getByTestId('sheet-action-thread'));
      const rowId = screen
        .getByText('message 100')
        .closest('[data-testid="message-item"]')!
        .getAttribute('data-message-id');
      // No name field: the seed message's text names the thread.
      expect(screen.queryByTestId('sheet-thread-name')).toBeNull();
      expect(harness.onStartThreadNamed).toHaveBeenCalledWith(rowId, 'message 100');
      expect(promptSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      promptSpy.mockRestore();
    }
  });

  it('Delete asks via the in-sheet confirm then calls onDeleteConfirmed — no window.confirm', async () => {
    coarsePointerState.coarse = true;
    const confirmSpy = vi.spyOn(window, 'confirm');
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      longPressRow(harness, 'message 100');
      fireEvent.click(screen.getByTestId('sheet-action-delete'));
      fireEvent.click(screen.getByTestId('sheet-delete-cancel'));
      expect(harness.onDeleteConfirmed).not.toHaveBeenCalled();

      longPressRow(harness, 'message 100');
      fireEvent.click(screen.getByTestId('sheet-action-delete'));
      fireEvent.click(screen.getByTestId('sheet-delete-confirm'));
      const rowId = screen
        .getByText('message 100')
        .closest('[data-testid="message-item"]')!
        .getAttribute('data-message-id');
      expect(harness.onDeleteConfirmed).toHaveBeenCalledWith(rowId);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
    } finally {
      vi.useRealTimers();
      confirmSpy.mockRestore();
    }
  });

  it('movement beyond the slop during the hold does not open the sheet; a quick tap leaves rows intact', async () => {
    coarsePointerState.coarse = true;
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = screen
        .getByText('message 100')
        .closest<HTMLElement>('[data-testid="message-item"]')!;

      // Moved finger: never a long-press. (jsdom has no PointerEvent, so
      // coordinate-bearing pointer events are dispatched as MouseEvents —
      // React keys on the type only.)
      fireEvent(
        row,
        new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }),
      );
      fireEvent(
        row,
        new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 20 }),
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();

      // Quick tap (pointerup well before the threshold): no sheet.
      fireEvent(
        row,
        new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }),
      );
      act(() => {
        vi.advanceTimersByTime(80);
      });
      fireEvent(row, new MouseEvent('pointerup', { bubbles: true }));
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fine pointer: the long-press never opens the sheet (hover toolbar contract untouched)', async () => {
    coarsePointerState.coarse = false;
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = screen
        .getByText('message 100')
        .closest<HTMLElement>('[data-testid="message-item"]')!;
      fireEvent.pointerDown(row, { pointerId: 1, clientX: 20, clientY: 20 });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the sheet closes on Escape and on scrim tap; focus returns to the message row', async () => {
    coarsePointerState.coarse = true;
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = longPressRow(harness, 'message 100');
      expect(screen.getByTestId('message-actions-sheet')).toBeTruthy();

      fireEvent.keyDown(screen.getByTestId('message-actions-sheet'), { key: 'Escape' });
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
      expect(document.activeElement).toBe(row);

      // Reopen for the scrim leg. Radix registers its outside-pointerdown
      // document listener on a macrotask — let it land first.
      longPressRow(harness, 'message 100');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      fireEvent.pointerDown(screen.getByTestId('message-actions-overlay'));
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
      expect(document.activeElement).toBe(row);
    } finally {
      vi.useRealTimers();
    }
  });

  it('axe: the open sheet hosted over the list has no violations', async () => {
    coarsePointerState.coarse = true;
    const harness = renderHarness();
    await waitFor(() => {
      expect(screen.getAllByTestId('message-item').length).toBeGreaterThan(0);
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    longPressRow(harness, 'message 100');
    vi.useRealTimers();
    expect(screen.getByTestId('message-actions-sheet')).toBeTruthy();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('stylesheet pin: coarse pointers suppress selection + the iOS callout on message rows (Copy Text is the sanctioned path)', () => {
    const css = readFileSync(join(WEB_ROOT, 'src', 'app', 'theme', 'shell.css'), 'utf8');
    const coarseBlock = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarseBlock).not.toBe('');
    const rule = coarseBlock.slice(coarseBlock.indexOf("[data-testid='message-item']"));
    expect(rule).not.toBe('');
    expect(rule).toContain('user-select: none');
    expect(rule).toContain('-webkit-touch-callout: none');
  });
});

describe('MessageList — avatar resolution', () => {
  it('self messages keep YOUR avatar even when the roster never hydrated', async () => {
    // Roster fetch failed: membersById stays empty. The session record is
    // the fallback source — a missing roster row must not strip the image
    // from your own messages (the panel/member-list mismatch report).
    const store = createStateStore();
    store.setState({
      currentUser: {
        id: ME,
        username: 'me',
        avatar_url: '/api/v1/attachments/abc123',
      },
    });
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('message-avatar').length).toBeGreaterThan(0);
    });
    const withImg = screen
      .getAllByTestId('message-avatar')
      .filter((el) => el.querySelector('img') !== null);
    expect(withImg.length).toBeGreaterThan(0);
  });
});

describe('MessageList — store subscription granularity', () => {
  it('ignores store writes that do not touch this channel', async () => {
    const store = makeStore();
    mergeChannelMessages(store, CHANNEL, NEWEST_FIRST.slice(0, 3), { isLastPage: true });

    // Profiler counts COMMITS in the subtree — a state update inside
    // MessageList does not re-render the test's own component.
    const commits = { count: 0 };
    render(
      <Profiler
        id="list"
        onRender={() => {
          commits.count += 1;
        }}
      >
        <MessageList channelId={CHANNEL} store={store} currentUserId={ME} />
      </Profiler>,
    );
    await screen.findByText('message 119');
    const base = commits.count;

    // A presence flip, an unread watermark and a message in ANOTHER channel
    // are the writes that used to re-render every visible row (each row
    // re-derives names, avatars and the mention resolver).
    act(() => {
      store.setState({
        presenceByUser: { [ME]: { status: 'online', last_seen_at: new Date().toISOString() } },
      });
      // Another channel's unread watermark — the list's own unread slice is
      // deliberately NOT written here (it feeds the divider and must land).
      markChannelRead(store, '8888888888888888', '1000000000000005');
      mergeChannelMessages(store, '8888888888888888', [ALL_MESSAGES[0]!], { isLastPage: true });
    });
    expect(commits.count).toBe(base);

    // This channel's own traffic still lands.
    act(() => {
      mergeChannelMessages(
        store,
        CHANNEL,
        [{ ...ALL_MESSAGES[0]!, id: '9999999999999999', content: 'fresh row' }],
        { isLastPage: false },
      );
    });
    await screen.findByText('fresh row');
    expect(commits.count).toBeGreaterThan(base);
  });
});


// ---------------------------------------------------------------------------
// Scrollback windowing, prefetch, keys and restore (#9 / #11 / #12 / #13)
// ---------------------------------------------------------------------------

function msg(n: number, over: Partial<Message> = {}): Message {
  return {
    id: String(1000000000000000 + n),
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content: `message ${n}`,
    created_at: '2026-08-30T12:00:00Z',
    edited_at: null,
    ...over,
  };
}

describe('MessageList — scrollback window (#9/#11/#12/#13)', () => {
  it('does not mount the scroller until the window has rows (#13)', async () => {
    const store = makeStore();
    let release: (() => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve(jsonResponse(200, { items: NEWEST_FIRST.slice(0, 50), cursor: {} }));
          }),
      ),
    );
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    expect(screen.queryByTestId('virtuoso-mock')).toBeNull();
    await waitFor(() => expect(release).not.toBeNull());
    await act(async () => {
      release!();
    });
    await waitFor(() => expect(screen.getByTestId('virtuoso-mock')).toBeTruthy());
    // First mount already sits on the newest row, measured against the
    // default row height instead of a probe.
    expect(lastVirtuosoProps!.initialTopMostItemIndex).toBe(49);
    expect(lastVirtuosoProps!.defaultItemHeight).toBe(48);
    // Sizes are reported through the rAF hop: the synchronous mode re-anchored
    // a reader scrolled up down to the newest row (measured in Chromium).
    expect(lastVirtuosoProps!.skipAnimationFrameInResizeObserver).toBeUndefined();
  });

  it('prefetches the older page from rangeChanged before the top row renders (#11)', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    const rangeChanged = lastVirtuosoProps!.rangeChanged as (r: { startIndex: number; endIndex: number }) => void;
    const first = lastVirtuosoProps!.firstItemIndex as number;
    // 40 rows of runway above: no request yet.
    act(() => rangeChanged({ startIndex: first + 40, endIndex: first + 49 }));
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(50);
    // Inside the 30-row runway: the next page is requested.
    act(() => rangeChanged({ startIndex: first + 20, endIndex: first + 30 }));
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(100));
  });

  it('reserves a fixed history band and shows "Loading older" only after a delay (#11)', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    const band = screen.getByTestId('history-header');
    expect(band.style.height).toBe('32px');
    expect(screen.queryByTestId('loading-older')).toBeNull();

    let release: (() => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve(jsonResponse(200, { items: NEWEST_FIRST.slice(50, 100), cursor: {} }));
          }),
      ),
    );
    act(() => startReachedCb!());
    await waitFor(() => expect(release).not.toBeNull());
    // In flight, but not yet long enough to announce.
    expect(screen.queryByTestId('loading-older')).toBeNull();
    const shown = await screen.findByTestId('loading-older', {}, { timeout: 2000 });
    expect(shown.textContent).toContain('Loading older');
    // The band never changed height while it toggled.
    expect(screen.getByTestId('history-header').style.height).toBe('32px');
    await act(async () => {
      release!();
    });
    await waitFor(() => expect(screen.queryByTestId('loading-older')).toBeNull());
  });

  it('pages older past the 500-row window and pages newer back down (#9)', async () => {
    const store = makeStore();
    // A full window already loaded (rows 101..600), not the start of history.
    const full = Array.from({ length: MESSAGE_SLICE_MAX }, (_, i) => msg(600 - i));
    mergeChannelMessages(store, CHANNEL, full);
    const older = Array.from({ length: 50 }, (_, i) => msg(100 - i));
    const newer = Array.from({ length: 50 }, (_, i) => msg(600 - i));
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('before=')) return jsonResponse(200, { items: older, cursor: {} });
        if (url.includes('after=')) return jsonResponse(200, { items: newer.slice(0, 50), cursor: {} });
        return jsonResponse(200, { items: full.slice(0, 50), cursor: {} });
      }),
    );
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    await act(async () => {
      startReachedCb!();
    });
    await waitFor(() => {
      const slice = store.getState().messagesByChannel[CHANNEL]!;
      // The older page LANDED (it used to be dropped past the cap)…
      expect(slice.items[slice.items.length - 1]!.id).toBe(msg(51).id);
      // …and the window records that the present is no longer in it.
      expect(slice.hasNewer).toBe(true);
    });
    expect(screen.getByTestId('newer-footer')).toBeTruthy();
    // Heading back down pages forward with the #152 cursor.
    const endReached = lastVirtuosoProps!.endReached as () => void;
    expect(typeof endReached).toBe('function');
    await act(async () => {
      endReached();
    });
    await waitFor(() =>
      expect(urls.some((u) => u.includes(`after=${msg(550).id}`))).toBe(true),
    );
  });

  it('a reader scrolled up holds the window: a live message never evicts the top row (#9)', async () => {
    const store = makeStore();
    const full = Array.from({ length: MESSAGE_SLICE_MAX }, (_, i) => msg(600 - i));
    mergeChannelMessages(store, CHANNEL, full);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { items: full.slice(0, 50), cursor: {} })));
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getAllByTestId('virtuoso-item').length).toBe(MESSAGE_SLICE_MAX));
    // The reader wheels up: the list tells the store.
    fireEvent.wheel(screen.getByTestId('message-list'), { deltaY: -120 });
    expect(store.getState().messagesByChannel[CHANNEL]!.holdOldest).toBe(true);
    const top = store.getState().messagesByChannel[CHANNEL]!.items.at(-1)!.id;
    act(() => {
      applyGatewayEvent(store, { op: 0, t: 'MessageCreate', s: 1, d: msg(601) } as never);
    });
    expect(store.getState().messagesByChannel[CHANNEL]!.items.at(-1)!.id).toBe(top);
    expect(store.getState().messagesByChannel[CHANNEL]!.hasNewer).toBe(true);
  });

  it('keys rows by the render key, so a confirmed own message keeps its row (#12)', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    let nonce = '';
    let placeholder = '';
    act(() => {
      const sent = beginOptimisticSend(store, {
        channel_id: CHANNEL,
        thread_id: null,
        author_id: ME,
        content: 'mine',
      });
      nonce = sent.nonce;
      placeholder = sent.messageId;
    });
    const computeItemKey = lastVirtuosoProps!.computeItemKey as (i: number, m: Message) => string;
    const pendingRow = store.getState().messagesByChannel[CHANNEL]!.items.find(
      (m) => m.id === placeholder,
    )!;
    // The send's client key (lane D #12) — the nonce the placeholder carries.
    expect(computeItemKey(0, pendingRow)).toBe(nonce);
    act(() => {
      confirmOptimisticSend(store, nonce, msg(500, { content: 'mine' }));
    });
    const confirmed = store.getState().messagesByChannel[CHANNEL]!.items.find(
      (m) => m.id === msg(500).id,
    )!;
    expect(computeItemKey(0, confirmed)).toBe(nonce);
  });

  it('hands a stable instant followOutput to Virtuoso (U14)', async () => {
    const store = makeStore();
    const { rerender } = render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getByTestId('virtuoso-mock')).toBeTruthy());
    const first = lastVirtuosoProps!.followOutput;
    rerender(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} canManageMessages />);
    expect(lastVirtuosoProps!.followOutput).toBe(first);
    expect((first as () => unknown)()).toBe('auto');
  });

  it('reopens at the newest when the reader left at the live edge (#13)', async () => {
    const store = makeStore();
    const { unmount } = render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getByTestId('virtuoso-mock')).toBeTruthy());
    expect(lastVirtuosoProps!.initialTopMostItemIndex).toBe(49);
    unmount();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getByTestId('virtuoso-mock')).toBeTruthy());
    expect(lastVirtuosoProps!.initialTopMostItemIndex).toBe(49);
    expect(screen.getByTestId('message-list').getAttribute('data-restored')).toBeNull();
    // Following, as on a first visit.
    expect((lastVirtuosoProps!.followOutput as () => unknown)()).toBe('auto');
  });

  it('reopens ON the row the reader was reading, at its offset (#13)', async () => {
    const store = makeStore();
    const { unmount } = render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    unmount();
    // The window holds rows 70..119; the reader was on row 90, 17px of it
    // scrolled above the edge.
    const id = ALL_MESSAGES[90]!.id;
    rememberReadingPosition(`channel:${CHANNEL}`, {
      atBottom: false,
      anchor: { key: id, id, offset: 17 },
    });
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getByTestId('virtuoso-mock')).toBeTruthy());
    expect(lastVirtuosoProps!.initialTopMostItemIndex).toEqual({ index: 20, align: 'start', offset: 17 });
    expect(screen.getByTestId('message-list').getAttribute('data-restored')).toBe('true');
    // Scrolled up: no following, and the window holds the row on screen (#9).
    expect((lastVirtuosoProps!.followOutput as () => unknown)()).toBe(false);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.holdOldest).toBe(true));
  });

  it('keeps a detached window instead of replacing it with the newest page (#13)', async () => {
    const store = makeStore();
    // Deep history: rows 0..49, detached from the live edge.
    mergeChannelMessages(store, CHANNEL, NEWEST_FIRST.slice(70, 120), { direction: 'jump' });
    const id = ALL_MESSAGES[10]!.id;
    rememberReadingPosition(`channel:${CHANNEL}`, {
      atBottom: false,
      anchor: { key: id, id, offset: 0 },
    });
    const fetchMock = vi.mocked(fetch);
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getByTestId('virtuoso-mock')).toBeTruthy());
    expect(lastVirtuosoProps!.initialTopMostItemIndex).toEqual({ index: 10, align: 'start', offset: 0 });
    // No newest-page read: it would have replaced the window, row and all.
    const newestReads = fetchMock.mock.calls.filter(([u]) => !/before=|after=/.test(String(u)));
    expect(newestReads).toHaveLength(0);
    expect(store.getState().messagesByChannel[CHANNEL]?.items.some((m) => m.id === id)).toBe(true);
  });

  it('reads the row back in when it left the window while the reader was away (#13)', async () => {
    const store = makeStore();
    const { unmount } = render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    unmount();
    // Row 10 is far below the loaded window (70..119).
    const id = ALL_MESSAGES[10]!.id;
    rememberReadingPosition(`channel:${CHANNEL}`, {
      atBottom: false,
      anchor: { key: id, id, offset: 5 },
    });
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() =>
      expect(store.getState().messagesByChannel[CHANNEL]?.items.some((m) => m.id === id)).toBe(true),
    );
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    // The row's neighbourhood replaced the window: the 10 rows before it and
    // the 50 from it on, detached from the live edge until paged forward.
    expect(slice.items).toHaveLength(60);
    expect(slice.hasNewer).toBe(true);
    await waitFor(() =>
      expect((lastVirtuosoProps!.data as Message[]).some((m) => m.id === id)).toBe(true),
    );
  });

  it('lets a permalink outrank the saved position (#13/#114)', async () => {
    const store = makeStore();
    const { unmount } = render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    unmount();
    const id = ALL_MESSAGES[90]!.id;
    rememberReadingPosition(`channel:${CHANNEL}`, {
      atBottom: false,
      anchor: { key: id, id, offset: 0 },
    });
    render(
      <MessageList
        channelId={CHANNEL}
        store={store}
        currentUserId={ME}
        focusMessageId={ALL_MESSAGES[100]!.id}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('virtuoso-mock')).toBeTruthy());
    expect(lastVirtuosoProps!.initialTopMostItemIndex).toBe(49);
    expect(screen.getByTestId('message-list').getAttribute('data-restored')).toBeNull();
  });

  it('shows the list error as an overlay, not a banner in the flow (#11)', async () => {
    const store = makeStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    await act(async () => {
      startReachedCb!();
    });
    const error = await screen.findByTestId('list-error');
    expect(error.className).toContain('absolute');
  });
});
