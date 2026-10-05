/**
 * @cytale/web — MessageList REGION-follow tests (#128 defect 3, mechanism 2).
 *
 * The composer well steps down while a typist goes live; the reply bar, a
 * banner, a call marker — each shrinks the scroll region under a stationary
 * reader, and scrollTop does not move by itself, so the newest message slides
 * beneath the composer. The list watches its own wrapper's box and, AT THE
 * BOTTOM, compensates; SCROLLED UP it must never drag.
 *
 * react-virtuoso needs real layout, so Virtuoso is mocked (as in
 * MessageList.test.tsx) with a `data-virtuoso-scroller` node the pin can
 * write; jsdom has no ResizeObserver, so the test stubs it and fires the
 * callback the component registered. The RULE is unit-tested in
 * scrollFollow.test.ts; the pixels are proven in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import React from 'react';

import type { Message } from '@cytale/domain';
import { createStateStore, mergeChannelMessages, type StateStore } from '@cytale/state';

import { MessageList } from '../MessageList.js';

const CHANNEL = '9007199254740993';
const ME = '7000000000000002';

// -- ResizeObserver stub -------------------------------------------------------
interface ROInstance {
  callback: ResizeObserverCallback;
  targets: Element[];
}
const roInstances: ROInstance[] = [];

class ResizeObserverStub {
  callback: ResizeObserverCallback;
  targets: Element[] = [];
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    roInstances.push({ callback: cb, targets: this.targets });
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0;
  }
}

/** Fire every observer watching `target` (a resize of it just happened). */
function fireObservers(target: Element) {
  for (const ro of roInstances) {
    if (ro.targets.includes(target)) {
      ro.callback([] as unknown as ResizeObserverEntry[], ro as unknown as ResizeObserver);
    }
  }
}

/** jsdom has no layout: install browser-like scroll state — the scrollTop
 * setter CLAMPS to [0, scrollHeight - clientHeight], exactly what the real
 * scroller does, because the pin writes `scrollTop = scrollHeight` and the
 * browser is what turns that into "the end". Returns the live state so a
 * test can simulate the composer shrinking the viewport. */
function installScrollState(
  el: HTMLElement,
  init: { scrollTop: number; scrollHeight: number; clientHeight: number },
): { scrollTop: number; scrollHeight: number; clientHeight: number } {
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

// -- Virtuoso mock -------------------------------------------------------------
// Renders the scroller node the pin writes (`data-virtuoso-scroller="true"`),
// plus a plain item-list marker (absent from this mock, so the item-height
// observer finds nothing and only the REGION observer is under test).
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  const Virtuoso = React.forwardRef(function Virtuoso(
    props: { data?: readonly unknown[]; itemContent: (index: number, data: unknown) => React.ReactNode },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: () => {},
      scrollTo: () => {},
      scrollBy: () => {},
    }));
    const items = props.data ?? [];
    return (
      <div data-virtuoso-scroller="true">
        <div>
          {items.map((item, i) => (
            <div key={i}>{props.itemContent(i, item)}</div>
          ))}
        </div>
      </div>
    );
  });
  return { Virtuoso };
});

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ items: [], cursor: { before: null, after: null, limit: 50 } }),
  })),
);
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  // Rows to lay out: the list mounts its scroller only once the window has
  // any (#13 — an empty mount settled at index 0 and re-landed later).
  const rows: Message[] = [3, 2, 1].map((i) => ({
    id: String(1000000000000000 + i),
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content: `row ${i}`,
    created_at: '2026-08-30T12:00:00Z',
    edited_at: null,
  }));
  mergeChannelMessages(store, CHANNEL, rows);
  return store;
}

beforeEach(() => {
  roInstances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MessageList — the composer grows under a reader at the bottom (#128 defect 3)', () => {
  it('a region resize while at the bottom re-pins the scroller to the end', async () => {
    const store = makeStore();
    const { container } = render(
      <MessageList channelId={CHANNEL} store={store} currentUserId={ME} />,
    );
    await waitFor(() => container.querySelector('[data-virtuoso-scroller="true"]'));

    const wrapper = container.querySelector<HTMLElement>('[data-testid="message-list"]')!;
    const scroller = container.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')!;
    // The reader sits pinned to a 1000px transcript in a 300px viewport…
    const wrapperState = installScrollState(wrapper, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    const scrollerState = installScrollState(scroller, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    // …the observer for the region is registered on the wrapper…
    expect(
      roInstances.some((ro) => ro.targets.includes(wrapper)),
      'the list watches its own region box',
    ).toBe(true);
    // …the composer well grows 25px: the region shrinks by exactly that.
    wrapperState.clientHeight = 275;
    scrollerState.clientHeight = 275;

    act(() => fireObservers(wrapper));

    // The compensation: the newest message is fully visible above the
    // composer again (scrollTop at the new end, 1000 - 275).
    expect(scroller.scrollTop).toBe(725);
  });

  it('a region resize while the reader has scrolled up never drags them', async () => {
    const store = makeStore();
    const { container } = render(
      <MessageList channelId={CHANNEL} store={store} currentUserId={ME} />,
    );
    await waitFor(() => container.querySelector('[data-virtuoso-scroller="true"]'));

    const wrapper = container.querySelector<HTMLElement>('[data-testid="message-list"]')!;
    const scroller = container.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')!;
    const wrapperState = installScrollState(wrapper, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    const scrollerState = installScrollState(scroller, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });

    // The reader wheels up: WHEEL IS INTENT — the follow disarms — and climbs
    // to 400.
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      scrollerState.scrollTop = 400;
      wrapperState.scrollTop = 400;
    });
    expect(scroller.scrollTop).toBe(400);

    // The typist goes live anyway; the region shrinks. The view is the
    // reader's: nothing moves.
    wrapperState.clientHeight = 275;
    scrollerState.clientHeight = 275;
    act(() => fireObservers(wrapper));

    expect(scroller.scrollTop).toBe(400);
  });
});
