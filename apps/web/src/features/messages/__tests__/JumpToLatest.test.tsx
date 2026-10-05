/**
 * @cytale/web — jump to latest (owner, 2026-10-01).
 *
 * "When the cursor's at a history message (in which the latest message isn't
 * in view) ... draw a down arrow in a circle above the main compose at the
 * right that takes the user to the new message (at the bottom)."
 *
 * The button rides the list's own at-bottom rule (scrollFollow.ts — no second
 * detector), so these tests drive that rule the way the browser does: a
 * wheel on the list, scroll offsets on the scroller (jsdom has no layout, so
 * the scroller's offsets are installed, clamping like the real one). Virtuoso
 * is the shared layout-free stand-in. The pixels — placement over the
 * composer, the theme looks, the frames of a jump — are proven in
 * e2e/jump-to-latest.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Message, Thread } from '@cytale/domain';
import { createStateStore, mergeChannelMessages, mergeThreadMessages, type StateStore } from '@cytale/state';

import { MessageList, forgetSavedListStates } from '../MessageList.js';
import { rememberReadingPosition } from '../readingAnchor.js';
import { ThreadSidePanel } from '../../threads/ThreadSidePanel.js';
import type { UseThreads } from '../../threads/useThreads.js';
import { virtuosoMockState } from '../../../test/virtuosoMock.js';
import { AUDITED_PALETTES } from '../../../app/theme/palettes.js';

vi.mock('react-virtuoso', async () => (await import('../../../test/virtuosoMock.js')).virtuosoModule());

const CHANNEL = '9007199254740993';
const THREAD = '9007199254741000';
const ME = '7000000000000002';
const LABEL = 'Jump to latest messages';

const ALL: Message[] = Array.from({ length: 120 }, (_, i) => ({
  id: String(1000000000000000 + i),
  channel_id: CHANNEL,
  thread_id: null,
  author_id: ME,
  content: `message ${i}`,
  created_at: `2026-08-30T12:00:${String(i % 60).padStart(2, '0')}Z`,
  edited_at: null,
}));
const NEWEST_FIRST = [...ALL].reverse();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

/** History pages as the server cuts them (newest-first, exclusive cursors). */
function installFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = /\/channels\/[^/]+\/messages(?:\?([^#]*))?$/.exec(url);
    if (!m) return jsonResponse(404, { error: { key: 'not_found', code: 40404, message: 'no route' } });
    const params = new URLSearchParams(m[1] ?? '');
    const before = params.get('before');
    const after = params.get('after');
    const limit = Number(params.get('limit') ?? 50);
    let page: Message[];
    if (after) page = ALL.filter((x) => BigInt(x.id) > BigInt(after)).slice(0, limit).reverse();
    else if (!before) page = NEWEST_FIRST.slice(0, limit);
    else {
      const idx = NEWEST_FIRST.findIndex((x) => x.id === before);
      page = idx >= 0 ? NEWEST_FIRST.slice(idx + 1, idx + 1 + limit) : [];
    }
    return jsonResponse(200, { items: page, cursor: { before: page.at(-1)?.id ?? null, after: page[0]?.id ?? null, limit } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Browser-like offsets on a scroller: the setter clamps, as the real one does. */
function installScrollState(el: HTMLElement, init: ScrollState): ScrollState {
  const state = { ...init };
  Object.defineProperty(el, 'scrollHeight', { get: () => state.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => state.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    get: () => state.scrollTop,
    set: (v: number) => {
      state.scrollTop = Math.max(0, Math.min(v, state.scrollHeight - state.clientHeight));
    },
    configurable: true,
  });
  return state;
}

function scrollerIn(root: HTMLElement = document.body): HTMLElement {
  return root.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')!;
}

/** Let the bottom pin's settle (rAF / 60ms / 250ms) run out. */
async function settle(ms = 320): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** The reader wheels up and the list scrolls to `top` (the browser's two events). */
async function readerScrollsUp(scroller: HTMLElement, state: ScrollState, top: number): Promise<void> {
  await act(async () => {
    fireEvent.wheel(scroller, { deltaY: -120 });
    state.scrollTop = top;
    fireEvent.scroll(scroller);
  });
}

function follows(): unknown {
  return (virtuosoMockState.lastProps!.followOutput as () => unknown)();
}

beforeEach(() => {
  forgetSavedListStates();
  virtuosoMockState.lastProps = null;
  virtuosoMockState.scrollToIndexCalls.length = 0;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A window that does NOT hold the newest page (#9): deep history, detached
 * from the live edge, reopened on a reader's saved row inside it (#13) — the
 * return keeps the window rather than reading the newest page over it.
 */
function detachedStore(): StateStore {
  const store = makeStore();
  mergeChannelMessages(store, CHANNEL, NEWEST_FIRST.slice(70, 120), { direction: 'jump' });
  expect(store.getState().messagesByChannel[CHANNEL]?.hasNewer).toBe(true);
  const id = ALL[10]!.id;
  rememberReadingPosition(`channel:${CHANNEL}`, { atBottom: false, anchor: { key: id, id, offset: 0 } });
  return store;
}

/** A list at the live edge with a scrollable history (3000px in a 500px view). */
async function mountAtEnd(store = makeStore()) {
  const utils = render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
  await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
  const scroller = scrollerIn();
  const state = installScrollState(scroller, { scrollTop: 0, scrollHeight: 3000, clientHeight: 500 });
  await settle(); // the pin lands the list at its end
  expect(state.scrollTop).toBe(2500);
  return { ...utils, store, scroller, state };
}

describe('jump to latest — when it shows', () => {
  it('is not offered while the newest message is in view (mounted, but hidden from everyone)', async () => {
    await mountAtEnd();
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
    const button = screen.getByTestId('jump-to-latest');
    expect(button.getAttribute('data-state')).toBe('hidden');
    expect(button.getAttribute('aria-hidden')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('appears when the reader scrolls up, and goes when they scroll back down by hand', async () => {
    const { scroller, state } = await mountAtEnd();
    await readerScrollsUp(scroller, state, 1200);
    const button = screen.getByRole('button', { name: LABEL });
    expect(button.getAttribute('data-state')).toBe('visible');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    // Back to the end: the at-bottom rule re-arms, the button goes.
    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: 600 });
      state.scrollTop = 2500;
      fireEvent.scroll(scroller);
    });
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it('a live row landing below a scrolled-up reader keeps it up (the newest is now further away)', async () => {
    const { scroller, state, store } = await mountAtEnd();
    await readerScrollsUp(scroller, state, 1200);
    await act(async () => {
      mergeChannelMessages(store, CHANNEL, [
        { ...ALL[119]!, id: '1000000000000500', content: 'live arrival' },
      ]);
      state.scrollHeight = 3060;
    });
    expect(screen.getByRole('button', { name: LABEL })).toBeTruthy();
  });

  it('is up at once when the window does not hold the newest page (#9 detached)', async () => {
    const store = detachedStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    await waitFor(() => expect(screen.getByRole('button', { name: LABEL })).toBeTruthy());
    expect(store.getState().messagesByChannel[CHANNEL]?.hasNewer).toBe(true);
  });

  it('carries its name, is a real button in the tab order, and passes axe', async () => {
    const { scroller, state, container } = await mountAtEnd();
    await readerScrollsUp(scroller, state, 1200);
    const button = screen.getByRole('button', { name: LABEL });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('tabindex')).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    // The glyph is decoration; the label is the name.
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('jump to latest — the click', () => {
  it('a short way: smooth-scrolls to the end, the button goes at once, and the list follows again on arrival', async () => {
    const { scroller, state, store } = await mountAtEnd();
    await readerScrollsUp(scroller, state, 1800); // 700px from the end: under 3 viewports
    expect(follows()).toBe(false);
    expect(store.getState().messagesByChannel[CHANNEL]?.holdOldest).toBe(true);

    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      state.scrollTop = opts.top ?? state.scrollTop;
    });
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    fireEvent.click(screen.getByRole('button', { name: LABEL }), { detail: 1 });
    expect(scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();

    await act(async () => {
      fireEvent(scroller, new Event('scrollend'));
    });
    expect(follows()).toBe('auto');
    expect(store.getState().messagesByChannel[CHANNEL]?.holdOldest).not.toBe(true);
    expect(state.scrollTop).toBe(2500);

    // Following: content growing under the reader is pinned to (no button).
    await act(async () => {
      mergeChannelMessages(store, CHANNEL, [{ ...ALL[119]!, id: '1000000000000500', content: 'after the jump' }]);
      state.scrollHeight = 3060;
    });
    await settle();
    expect(state.scrollTop).toBe(2560);
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it('a smooth jump with no scrollend (WebKit) still lands and follows once its settle runs out', async () => {
    const { scroller, state } = await mountAtEnd();
    await readerScrollsUp(scroller, state, 1800);
    scroller.scrollTo = vi.fn() as unknown as typeof scroller.scrollTo; // never moves, never ends
    fireEvent.click(screen.getByRole('button', { name: LABEL }), { detail: 1 });
    await settle(800);
    expect(follows()).toBe('auto');
    expect(state.scrollTop).toBe(2500);
  });

  it('a long way: instant, no animation through screens of rows', async () => {
    const { scroller, state } = await mountAtEnd();
    await readerScrollsUp(scroller, state, 0); // 2500px: five viewports
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    fireEvent.click(screen.getByRole('button', { name: LABEL }), { detail: 1 });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(state.scrollTop).toBe(2500);
    expect(follows()).toBe('auto');
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it('reduced motion: instant even for a short way', async () => {
    const { scroller, state } = await mountAtEnd();
    await readerScrollsUp(scroller, state, 1800);
    const original = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) =>
      q.includes('prefers-reduced-motion') ? ({ matches: true, media: q } as MediaQueryList) : original(q),
    );
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    fireEvent.click(screen.getByRole('button', { name: LABEL }), { detail: 1 });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(state.scrollTop).toBe(2500);
    expect(follows()).toBe('auto');
  });

  it('a windowed list loads the newest page FIRST, then lands at its end following', async () => {
    const store = detachedStore();
    const fetchMock = vi.mocked(fetch);
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    const button = await screen.findByRole('button', { name: LABEL });
    const scroller = scrollerIn();
    const state = installScrollState(scroller, { scrollTop: 0, scrollHeight: 3000, clientHeight: 500 });
    const reads = () =>
      fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => /\/messages\?/.test(u) && !/before=|after=/.test(u));
    const before = reads().length;
    const indexBefore = virtuosoMockState.lastProps!.firstItemIndex;

    fireEvent.click(button, { detail: 1 });
    // Down at once — the present is on its way.
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.hasNewer).not.toBe(true));
    expect(reads().length).toBe(before + 1);
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.items[0]!.id).toBe(ALL[119]!.id); // the TRUE newest is in the window
    expect(slice.items.some((m) => m.id === ALL[10]!.id)).toBe(false); // the old window went
    // The present takes the window's index space as is (moving past the old
    // window left Virtuoso a phantom band of rows to land in — measured).
    expect(virtuosoMockState.lastProps!.firstItemIndex).toBe(indexBefore);
    await settle();
    expect(follows()).toBe('auto');
    expect(state.scrollTop).toBe(2500);
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it('a failed read of the present says so and leaves the button up to try again', async () => {
    const store = detachedStore();
    render(<MessageList channelId={CHANNEL} store={store} currentUserId={ME} />);
    const button = await screen.findByRole('button', { name: LABEL });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: { key: 'boom', code: 50000, message: 'boom' } })));
    fireEvent.click(button, { detail: 1 });
    await waitFor(() => expect(screen.getByTestId('list-error').textContent).toMatch(/latest messages/));
    expect(screen.getByRole('button', { name: LABEL })).toBeTruthy();
    expect(store.getState().messagesByChannel[CHANNEL]?.hasNewer).toBe(true);
  });
});

describe('jump to latest — focus', () => {
  /** The pane shape: the list's region, then the composer as a later sibling. */
  function Pane({ store }: { store: StateStore }) {
    return (
      <div>
        <div className="timeline-region">
          <MessageList channelId={CHANNEL} store={store} currentUserId={ME} />
        </div>
        <div>
          <div contentEditable="true" suppressContentEditableWarning data-testid="fake-composer" />
        </div>
      </div>
    );
  }

  async function mountPane() {
    const store = makeStore();
    render(<Pane store={store} />);
    await waitFor(() => expect(store.getState().messagesByChannel[CHANNEL]?.items).toHaveLength(50));
    const scroller = scrollerIn();
    const state = installScrollState(scroller, { scrollTop: 0, scrollHeight: 3000, clientHeight: 500 });
    await settle();
    await readerScrollsUp(scroller, state, 0);
    return { scroller, state };
  }

  it('a keyboard activation moves focus on to the composer (the button goes away under it)', async () => {
    await mountPane();
    const button = screen.getByRole('button', { name: LABEL });
    button.focus();
    fireEvent.click(button, { detail: 0 }); // Enter / Space
    expect(document.activeElement).toBe(screen.getByTestId('fake-composer'));
  });

  it('a pointer click leaves focus alone (a phone keyboard must not pop up)', async () => {
    await mountPane();
    fireEvent.click(screen.getByRole('button', { name: LABEL }), { detail: 1 });
    expect(document.activeElement).not.toBe(screen.getByTestId('fake-composer'));
  });
});

describe('jump to latest — the thread panel', () => {
  const PARENT: Message = {
    id: '1000000000000001',
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content: 'origin message',
    created_at: '2026-08-30T12:00:00Z',
    edited_at: null,
  };
  const META: Thread = {
    id: THREAD,
    channel_id: CHANNEL,
    parent_message_id: PARENT.id,
    name: 'origin message',
    created_by: ME,
    archived: false,
    message_count: 40,
    member_state: { notify: true, last_read_id: null },
    created_at: '2026-08-30T12:00:00Z',
  } as Thread;
  const REPLIES: Message[] = Array.from({ length: 40 }, (_, i) => ({
    id: String(1000000000001000 + i),
    channel_id: CHANNEL,
    thread_id: THREAD,
    author_id: ME,
    content: `reply ${i}`,
    created_at: '2026-08-30T12:01:00Z',
    edited_at: null,
  }));

  function threadsFor(store: StateStore): UseThreads {
    return {
      openThreadId: THREAD,
      firstUnreadId: () => null,
      openThread: vi.fn(),
      closeThread: vi.fn(),
      follow: vi.fn(async () => {}),
      unfollow: vi.fn(async () => {}),
      markUnread: vi.fn(async () => {}),
      leave: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
      loadReplies: vi.fn(async () => {}),
      replies: (id: string) => store.getState().messagesByThread[id]?.items ?? [],
      thread: (id: string) => store.getState().threadsById[id] ?? null,
      isNotified: () => true,
      unreadCount: () => 0,
      parseDeepLink: () => null,
    };
  }

  it('has its own button above the thread composer, with the same behaviour', async () => {
    const store = makeStore();
    store.setState((s) => ({ threadsById: { ...s.threadsById, [THREAD]: META } }));
    mergeChannelMessages(store, CHANNEL, [PARENT]);
    mergeThreadMessages(store, THREAD, [...REPLIES].reverse(), { direction: 'newest', isLastPage: true });
    render(<ThreadSidePanel threadId={THREAD} channelId={CHANNEL} store={store} threads={threadsFor(store)} />);
    const replies = await screen.findByTestId('thread-replies');
    await waitFor(() => expect(within(replies).getAllByTestId('message-item').length).toBeGreaterThan(30));
    // The region contract the CSS reads: the list's box, then the composer.
    expect(replies.classList.contains('timeline-region')).toBe(true);
    const scroller = scrollerIn(replies);
    const state = installScrollState(scroller, { scrollTop: 0, scrollHeight: 3000, clientHeight: 500 });
    await settle();
    expect(within(replies).queryByRole('button', { name: LABEL })).toBeNull();

    await readerScrollsUp(scroller, state, 0);
    const button = within(replies).getByRole('button', { name: LABEL });
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(state.scrollTop).toBe(2500);
    expect(within(replies).queryByRole('button', { name: LABEL })).toBeNull();
    // Focus went on to THIS panel's composer.
    const panel = screen.getByTestId('thread-side-panel');
    const composer = within(panel).getByTestId('composer-input');
    expect(composer.contains(document.activeElement) || composer === document.activeElement).toBe(true);
  });
});

describe('jump to latest — the look is the tokens', () => {
  const shellCss = readFileSync(join(__dirname, '..', '..', '..', 'app', 'theme', 'shell.css'), 'utf8');
  const block = (selector: string) => {
    const start = shellCss.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return shellCss.slice(start, shellCss.indexOf('}', start));
  };

  it('fill, glyph, edge, shadow, radius and focus ring all come from tokens', () => {
    const base = block('.jump-latest');
    expect(base).toContain('background: var(--color-popover)');
    expect(base).toContain('color: var(--color-text-primary)');
    expect(base).toContain('border: 1px solid var(--color-input-line)');
    expect(base).toContain('box-shadow: var(--shadow-popover)');
    // Round in Harmony; the Pixel style zeroes --radius-full (square).
    expect(base).toContain('border-radius: var(--radius-full)');
    expect(base).toContain('position: absolute'); // floats; never in flow
    expect(block('.jump-latest:focus-visible')).toContain('outline: 2px solid var(--color-focus)');
  });

  it('reduced motion drops the slide and the fade', () => {
    const at = shellCss.indexOf('@media (prefers-reduced-motion: reduce) {\n  .jump-latest');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(shellCss.slice(at, at + 200)).toContain('transition: visibility 0s');
  });

  /** WCAG relative luminance contrast of two #rrggbb colours. */
  function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, bl] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  it('the glyph clears 3:1 (non-text UI) on the fill in every palette', () => {
    const palettes = {
      ...AUDITED_PALETTES,
      // harmony/dark (tokens.css :root): --tk-text-top on --tk-surface-strong.
      'harmony/dark': { 'text-top': '#f2f3f5', 'surface-strong': '#070709' },
    } as Record<string, { 'text-top': string; 'surface-strong': string }>;
    for (const [name, p] of Object.entries(palettes)) {
      expect(contrast(p['text-top'], p['surface-strong']), name).toBeGreaterThanOrEqual(3);
    }
  });
});
