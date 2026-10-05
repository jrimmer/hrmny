/**
 * @cytale/web — typing state hook (U23; lane D #17/#21).
 *
 * Tracks "user X is typing" per channel/thread from gateway TYPING_START
 * dispatches, expiring each typist independently after TYPING_TIMEOUT_MS of
 * no fresh events. Owns emission: keystrokes call `sendTyping` through the
 * gateway client (throttled by the client itself to one signal per channel
 * per TYPING_THROTTLE_MS), so the signal has exactly one owner end-to-end
 * (U10 routes it; U23 emits + expires it).
 *
 * Lane D #17 — WHERE the state lives. It used to be `useState` inside the
 * hook, returned as a fresh object every render: every TypingStart re-rendered
 * the component that called `useTyping()` — the Lexical composer — and the
 * new object churned the composer's `emitTyping` callback, re-registering its
 * editor listener. The typists now live in a small EXTERNAL store, one per
 * gateway client, keyed per channel(:thread) with per-key subscriptions: a
 * typing event re-renders only what shows THAT key's typists (`useTypists`),
 * and `useTyping()` returns an object that is stable for the life of the
 * gateway client.
 *
 * The gateway client and store are injectable for tests; the app uses the
 * live session gateway.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { GatewayClient } from '@cytale/gateway-client';

import { session } from '../auth/session.js';

/**
 * Client-side expiry for a typist with no fresh events (lane D #21: 7 s).
 * Senders emit at most every 5 s while typing (the gateway client's
 * TYPING_THROTTLE_MS); the expiry outlasts that gap plus delivery latency, so
 * the indicator never blinks off between two emits, and clears ~2 s after the
 * last one when the typist stops.
 */
export const TYPING_TIMEOUT_MS = 7_000;

/** A single typist in a channel/thread. */
export interface Typist {
  userId: string;
  /** Unix epoch ms of the most recent typing event. */
  lastTypedAt: number;
}

/** Typists keyed by channel id, then by user id. */
export type TypingByChannel = Record<string, Record<string, Typist>>;

export interface UseTyping {
  /** Typists currently typing in a channel (or thread), newest-first. */
  typists(channelId: string, threadId?: string | null): Typist[];
  /** Emit a typing signal for the given channel/thread (throttled). */
  sendTyping(channelId: string, threadId?: string | null): void;
  /**
   * Subscribe to ONE channel(:thread)'s typists (lane D #17). Optional so a
   * test double of `{ typists, sendTyping }` stays valid — `useTypists` then
   * reads `typists()` per render, as the display always used to.
   */
  subscribe?(channelId: string, threadId: string | null, onChange: () => void): () => void;
}

function typingKey(channelId: string, threadId?: string | null): string {
  // Thread-scoped typing keys under the parent channel with a thread
  // discriminator so channel and thread panes stay separate.
  return threadId ? `${channelId}:${threadId}` : channelId;
}

const NO_TYPISTS: Typist[] = [];

/**
 * One gateway client's typists. Lists are immutable per key (a new array per
 * change), so a key's snapshot is identity-stable between its own events.
 */
class TypingStore {
  readonly #byKey = new Map<string, Typist[]>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #unsubscribeGateway: (() => void) | null = null;
  #holders = 0;

  constructor(readonly gateway: GatewayClient) {}

  /** Ref-counted gateway listener: attached while any hook holds this store. */
  retain(): () => void {
    this.#holders += 1;
    if (this.#unsubscribeGateway === null) {
      this.#unsubscribeGateway = this.gateway.on('TypingStart', (payload) => {
        this.#apply(payload.channel_id, payload.thread_id ?? null, payload.user_id, payload.timestamp);
      });
    }
    return () => {
      this.#holders -= 1;
      if (this.#holders > 0) return;
      this.#unsubscribeGateway?.();
      this.#unsubscribeGateway = null;
      for (const t of this.#timers.values()) clearTimeout(t);
      this.#timers.clear();
      const keys = [...this.#byKey.keys()];
      this.#byKey.clear();
      for (const key of keys) this.#notify(key);
    };
  }

  typists = (channelId: string, threadId?: string | null): Typist[] =>
    this.#byKey.get(typingKey(channelId, threadId)) ?? NO_TYPISTS;

  subscribe = (channelId: string, threadId: string | null, onChange: () => void): (() => void) => {
    const key = typingKey(channelId, threadId);
    let set = this.#listeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(onChange);
    return () => {
      set.delete(onChange);
      if (set.size === 0) this.#listeners.delete(key);
    };
  };

  #apply(channelId: string, threadId: string | null, userId: string, timestamp: number): void {
    const key = typingKey(channelId, threadId);
    const rest = (this.#byKey.get(key) ?? NO_TYPISTS).filter((t) => t.userId !== userId);
    const next = [...rest, { userId, lastTypedAt: timestamp }].sort((a, b) => b.lastTypedAt - a.lastTypedAt);
    this.#byKey.set(key, next);
    this.#scheduleExpiry(key, userId);
    this.#notify(key);
  }

  #scheduleExpiry(key: string, userId: string): void {
    const timerKey = `${key}|${userId}`;
    const existing = this.#timers.get(timerKey);
    if (existing) clearTimeout(existing);
    this.#timers.set(
      timerKey,
      setTimeout(() => {
        this.#timers.delete(timerKey);
        const list = this.#byKey.get(key);
        if (!list || !list.some((t) => t.userId === userId)) return;
        const next = list.filter((t) => t.userId !== userId);
        if (next.length === 0) this.#byKey.delete(key);
        else this.#byKey.set(key, next);
        this.#notify(key);
      }, TYPING_TIMEOUT_MS),
    );
  }

  #notify(key: string): void {
    const set = this.#listeners.get(key);
    if (set === undefined) return;
    for (const cb of [...set]) cb();
  }
}

const storesByGateway = new WeakMap<GatewayClient, TypingStore>();

function typingStoreFor(gateway: GatewayClient): TypingStore {
  let store = storesByGateway.get(gateway);
  if (store === undefined) {
    store = new TypingStore(gateway);
    storesByGateway.set(gateway, store);
  }
  return store;
}

const noSubscribe = (): (() => void) => () => {};

/**
 * The typing surface for a gateway client. `gateway` is injectable for tests;
 * when omitted, the live session gateway is used (no-op when disconnected).
 * The returned object is referentially stable while the gateway client is.
 */
export function useTyping(gateway?: GatewayClient | null): UseTyping {
  const gw = gateway === undefined ? session.getGateway() : gateway;
  const store = gw ? typingStoreFor(gw) : null;

  useEffect(() => {
    if (store === null) return;
    return store.retain();
  }, [store]);

  // Emission resolves the client at CALL time when not injected: a reconnect
  // replaces the session's gateway client without re-rendering the composer.
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;
  const sendTyping = useCallback((channelId: string, threadId?: string | null) => {
    const client = gatewayRef.current === undefined ? session.getGateway() : gatewayRef.current;
    if (!client) return;
    client.sendTyping(channelId, threadId ?? undefined);
  }, []);

  return useMemo<UseTyping>(
    () => ({
      typists: store ? store.typists : () => NO_TYPISTS,
      sendTyping,
      subscribe: store ? store.subscribe : noSubscribe,
    }),
    [store, sendTyping],
  );
}

/**
 * The typists of ONE channel(:thread), re-rendering only when that key's list
 * changes (lane D #17). A `UseTyping` without `subscribe` (a test double)
 * is read per render, as before.
 */
export function useTypists(typing: UseTyping, channelId: string, threadId: string | null = null): Typist[] {
  const subscribe = useCallback(
    (cb: () => void) => (typing.subscribe ? typing.subscribe(channelId, threadId, cb) : () => {}),
    [typing, channelId, threadId],
  );
  // A double without `subscribe` may mint a fresh array per call, which
  // `useSyncExternalStore` would read as an endless change — it gets a
  // constant snapshot and is read directly below instead.
  const getSnapshot = useCallback(
    () => (typing.subscribe ? typing.typists(channelId, threadId) : NO_TYPISTS),
    [typing, channelId, threadId],
  );
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return typing.subscribe ? live : typing.typists(channelId, threadId);
}
