/**
 * @cytale/tui — the cross-unit seams AT THE ENTRY POINT (U8's send, U10's
 * unread/read acknowledgement, U14's reactions).
 *
 * Each of the three units landed as a module with a clean seam and no caller:
 * `compose/send.ts` had no `onSendTo`, `session/readState.ts` had no
 * `markRead`/`markUnread` wiring and column one had no `unreadCount`, and
 * `columns/Reactions.tsx` had neither a key that reaches
 * `toggleOwnReaction` nor a `gatewayPreprocessors` registration. Their own
 * reports name those seams; this file is the proof that the entry point now
 * uses them.
 *
 * Every assertion here is BEHAVIOURAL and as far down the stack as it can be:
 *
 *   * a keystroke in the composer produces a real `POST
 *     /api/v1/channels/{id}/messages` over a socket, and the shared store ends
 *     up with the SERVER's row and no optimistic placeholder;
 *   * a badge is read off a rendered frame for a channel this client never
 *     loaded a message for (R22a);
 *   * the shelf's initial landing and the `u` binding produce real `POST
 *     /channels/{id}/ack` requests — the second carrying `unread_floor`;
 *   * the reaction key produces a real `PUT .../reactions/{emoji}/@me` and the
 *     chip the pane draws, and a reaction dispatch delivered by the SESSION
 *     (not by a test calling the fold) reaches the store through the
 *     preprocessor seat.
 *
 * The harness runs the real `runClient`: a real `SessionManager`, a real
 * `CytaleApiClient` over a real loopback HTTP fixture, and the entry point's
 * own element. The element the render seam captures is then MOUNTED here (with
 * geometry added — the client's banner has no width/height of its own), so the
 * keystrokes below are keystrokes into the wired shell rather than into a
 * hand-built `App`. Two seams stay stubbed, and both are ones the client itself
 * cannot own in a test: the gateway (a stub that reports transitions and lets a
 * test push a dispatch frame) and the token descriptor (the host's half).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cloneElement, createElement, type ReactElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { Channel, Message, Workspace } from '@cytale/domain';
import type { ConnectionState, GatewayClient, GatewayClientOptions } from '@cytale/gateway-client';
import {
  createStateStore,
  type StateState,
  type StateStore,
  type UnreadState,
} from '@cytale/state';

import { App } from '../app.js';
import { runClient } from '../client.js';
import { OWN_CHIP_OPEN, OWN_CHIP_CLOSE } from '../format/rows.js';
import type { TokenDescriptor } from '../session/tokenPipe.js';

// ---------------------------------------------------------------------------
// Ids, fixtures
// ---------------------------------------------------------------------------

const ME = '900000000000000001';
const OTHER = '900000000000000002';
const W1 = '100000000000000001';
/** A channel this client has messages for. */
const C1 = '300000000000000001';
/** A channel it has never loaded a single message for (R22a, the badge test). */
const C2 = '300000000000000002';
const M1 = '800000000000000001';
/** The row id the fixture server answers a POST with. */
const SERVER_ROW = '800000000000000009';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';

const SIZE = { width: 100, height: 30 } as const;

function workspace(overrides: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return {
    owner_id: ME,
    role_version: 1,
    created_at: '2026-09-13T09:00:00.000Z',
    ...overrides,
  };
}

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return {
    workspace_id: W1,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'channel_id' | 'author_id' | 'content'>): Message {
  return {
    thread_id: null,
    created_at: '2026-09-13T12:00:00.000Z',
    edited_at: null,
    ...overrides,
  };
}

function unread(overrides: Partial<UnreadState> = {}): UnreadState {
  return { last_read_id: null, unread_count: 0, mention_count: 0, ...overrides };
}

/**
 * The store a real boot leaves behind: identity, one workspace, one channel.
 *
 * Slice convention: `@cytale/state` keeps messages NEWEST-FIRST, so the first
 * element of `messagesByChannel[id].items` is the newest message (the pane
 * reverses that order for drawing, which is why a cursor left where it opens
 * sits on the newest row).
 */
function seed(overrides: Partial<StateState> = {}): Partial<StateState> {
  return {
    currentUser: { id: ME, username: 'tester' },
    workspaces: { [W1]: workspace({ id: W1, name: 'Acme' }) },
    channels: { [C1]: channel({ id: C1, name: 'general' }) },
    membersById: {},
    memberIdsByWorkspace: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The fixture server: the real shapes the session, the hydrator, the ack route,
// the send route and the reaction routes answer with.
// ---------------------------------------------------------------------------

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface Fixture {
  readonly origin: string;
  readonly recorded: Recorded[];
  /** Refuse the next reaction write (the channel gate, server-side). */
  refuseReactions(): void;
  close(): Promise<void>;
}

const alive = new Set<Server>();

afterEach(async () => {
  cleanup();
  for (const server of [...alive]) {
    alive.delete(server);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function startFixture(): Promise<Fixture> {
  const recorded: Recorded[] = [];
  /** The channel gate, for the one test that needs a refusal. */
  let reactionsRefused = false;
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const send = (status: number): void => {
        res.writeHead(status);
        res.end();
      };
      if (req.method !== 'GET') {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          parsed = {};
        }
        recorded.push({ method: req.method ?? '', url, body: parsed });
      }

      if (url.startsWith('/api/v1/users/@me') && url !== '/api/v1/users/@me/workspaces') {
        json(200, { user: { id: ME, username: 'tester', email: null, email_verified_at: null } });
        return;
      }
      if (url === '/api/v1/auth/logout') {
        send(204);
        return;
      }
      if (url === '/api/v1/users/@me/workspaces') {
        json(200, {
          workspaces: [
            {
              id: W1,
              name: 'Acme',
              description: null,
              icon_url: null,
              owner_id: ME,
              created_at: '2026-01-01T00:00:00Z',
              member_count: 1,
            },
          ],
        });
        return;
      }
      if (url === '/api/v1/users/@me/channels') {
        json(200, { channels: [] });
        return;
      }
      if (url === `/api/v1/workspaces/${W1}/channels`) {
        json(200, {
          channels: [
            {
              id: C1,
              workspace_id: W1,
              name: 'general',
              type: 0,
              parent_id: null,
              topic: null,
              position: 0,
              last_message_id: null,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        });
        return;
      }
      if (url === `/api/v1/workspaces/${W1}/people`) {
        json(200, { people: [], next_before: null });
        return;
      }
      // U8's write path: the server's own row for the POSTed message.
      if (url === `/api/v1/channels/${C1}/messages` && req.method === 'POST') {
        json(201, {
          message: {
            id: SERVER_ROW,
            channel_id: C1,
            thread_id: null,
            author_id: ME,
            content: (JSON.parse(raw) as { content?: string }).content ?? '',
            created_at: '2026-09-13T12:30:00.000Z',
            edited_at: null,
          },
        });
        return;
      }
      // U10's watermark + floor route.
      if (url === `/api/v1/channels/${C1}/ack` && req.method === 'POST') {
        send(204);
        return;
      }
      // U14's own-reaction routes (the emoji is percent-encoded in the path).
      if (/\/reactions\/.+\/@me$/.test(url)) {
        if (reactionsRefused) {
          reactionsRefused = false;
          json(403, { error: { key: 'forbidden', code: 40301, message: 'you cannot react here' } });
          return;
        }
        send(204);
        return;
      }
      json(404, { error: { key: 'not_found', code: 40401, message: 'no route' } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  alive.add(server);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('the fixture server did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    recorded,
    refuseReactions: () => {
      reactionsRefused = true;
    },
    close: async () => {
      alive.delete(server);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The two client-side seams this suite owns: the descriptor and the gateway
// ---------------------------------------------------------------------------

interface ScriptedDescriptor extends TokenDescriptor {
  write(bytes: string): void;
}

function scriptedDescriptor(): ScriptedDescriptor {
  const queued: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let ended = false;
  return {
    write(bytes: string) {
      if (ended) return;
      const resolve = waiters.shift();
      if (resolve === undefined) queued.push(bytes);
      else resolve(bytes);
    },
    read() {
      const buffered = queued.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (ended) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      ended = true;
      for (const resolve of waiters.splice(0)) resolve(null);
    },
  };
}

interface ControllableGateway {
  readonly factory: (options: GatewayClientOptions) => GatewayClient;
  /** Push a raw dispatch frame through every `onAny` handler the session set. */
  dispatch(event: unknown): void;
}

function controllableGateway(): ControllableGateway {
  let options: GatewayClientOptions | null = null;
  const handlers = new Set<(event: unknown) => void>();
  return {
    dispatch(event) {
      for (const handler of [...handlers]) handler(event);
    },
    factory: (next: GatewayClientOptions): GatewayClient => {
      options = next;
      return {
        connect: async () => {
          options?.onStateChange?.({ from: 'connecting', to: 'connected' });
        },
        disconnect: () => undefined,
        destroy: () => undefined,
        onAny: (handler: (event: never) => void) => {
          const cast = handler as (event: unknown) => void;
          handlers.add(cast);
          return () => {
            handlers.delete(cast);
          };
        },
      } as unknown as GatewayClient;
    },
  };
}

// ---------------------------------------------------------------------------
// Booting the client, and mounting the element it hands the renderer
// ---------------------------------------------------------------------------

interface Booted {
  readonly store: StateStore;
  readonly fixture: Fixture;
  readonly gateway: ControllableGateway;
  readonly elements: ReactElement[];
  readonly running: Promise<number>;
  quit(): void;
}

type Instance = ReturnType<typeof render>;

async function boot(store: StateStore = createStateStore()): Promise<Booted> {
  const fixture = await startFixture();
  const gateway = controllableGateway();
  const descriptor = scriptedDescriptor();
  descriptor.write(`{"access_token":"${TOKEN}","expires_in":900}\n`);
  const elements: ReactElement[] = [];
  const sink = { write: (): boolean => true };

  const running = runClient({
    argv: [],
    env: { CYTALE_TOKEN_FD: '3', CYTALE_ORIGIN: fixture.origin },
    stdout: sink,
    stderr: sink,
    deps: {
      descriptor,
      createGatewayClient: gateway.factory,
      store,
      render: (node: ReactElement) => {
        elements.push(node);
        return {
          rerender: (next: ReactElement) => {
            elements.push(next);
          },
          unmount: () => undefined,
        };
      },
    },
  });

  // The session is ESTABLISHED. The online view is computed only once the
  // gateway exists — `authenticateFromTokenSource` is what creates it — so a
  // shell mounted after this wait is a shell over a live session: a token, an
  // authenticated access status, and the session's pre-dispatch seat in place.
  // (Waiting on the store's workspaces would be satisfied by the seed below,
  // and the gateway would not exist yet.)
  await waitFor(() => {
    const latest = elements[elements.length - 1] as
      | ReactElement<{ view?: { phase?: string } }>
      | undefined;
    return latest?.props.view?.phase === 'online';
  });
  return {
    store,
    fixture,
    gateway,
    elements,
    running,
    quit: () => {
      const latest = elements[elements.length - 1];
      (latest?.props as { onQuit?: () => void } | undefined)?.onQuit?.();
    },
  };
}

/**
 * Mount the element the CLIENT built — every prop is the entry point's own —
 * with only the terminal geometry added, because the client's banner has no
 * width/height of its own (it reads the real window).
 */
function shell(elements: ReactElement[]): Instance {
  const node = elements[elements.length - 1] as ReactElement<Record<string, unknown>> | undefined;
  if (node === undefined) throw new Error('the client has not rendered yet');
  return render(cloneElement(node, { width: SIZE.width, height: SIZE.height }));
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function press(instance: Instance, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('timed out waiting for the client');
}

const frame = (instance: Instance): string => instance.lastFrame() ?? '';

const acks = (fixture: Fixture): Recorded[] =>
  fixture.recorded.filter((entry) => entry.url === `/api/v1/channels/${C1}/ack`);

// ---------------------------------------------------------------------------
// A. U8 — the send path
// ---------------------------------------------------------------------------

describe('A. the composer sends through the entry point (U8)', () => {
  it('a keystroke produces a real POST and settles the server row in the store', async () => {
    const store = createStateStore();
    store.setState(seed({ messagesByChannel: {} }));
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      await press(instance, 'i');
      await press(instance, 'hello from the terminal');
      // The keystrokes reached the composer: Enter is the only thing left.
      await waitFor(() => frame(instance).includes('hello from the terminal'));
      await press(instance, '\r');

      await waitFor(() =>
        booted.fixture.recorded.some(
          (entry) => entry.method === 'POST' && entry.url === `/api/v1/channels/${C1}/messages`,
        ),
      );
      const posted = booted.fixture.recorded.find((entry) => entry.url === `/api/v1/channels/${C1}/messages`);
      expect(posted?.body.content).toBe('hello from the terminal');

      // The optimistic row is settled by the server's own row: the placeholder
      // is gone, so the member sees one message with the server's id.
      await waitFor(() =>
        (store.getState().messagesByChannel[C1]?.items ?? []).some((row) => row.id === SERVER_ROW),
      );
      const rows = store.getState().messagesByChannel[C1]?.items ?? [];
      expect(rows.filter((row) => row.id === SERVER_ROW)).toHaveLength(1);
      expect(rows.some((row) => row.id.startsWith('pending_'))).toBe(false);
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// B. U10 — the badge, the landing, and the floor
// ---------------------------------------------------------------------------

describe('B. unread and read acknowledgement (U10)', () => {
  it('draws the badge for a channel this client never loaded (R22a)', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        channels: {
          [C1]: channel({ id: C1, name: 'general', position: 0 }),
          [C2]: channel({ id: C2, name: 'random', position: 1 }),
        },
        // C2 has no slice at all: the server's count is the ONLY source.
        unreadByChannel: { [C2]: unread({ server_unread_count: 3 }) },
      }),
    );
    const instance = render(
      createElement(App, {
        view: { phase: 'online', headline: 'Connected' },
        mode: 'ssh',
        origin: 'https://chat.example.com',
        store,
        width: SIZE.width,
        height: SIZE.height,
      }),
    );
    await waitFor(() => frame(instance).includes('#random'));
    await waitFor(() => frame(instance).includes('(3)'));
    const drawn = frame(instance);
    expect(drawn).toContain('#random (3)');
    // A channel with nothing unread draws no badge at all — absence, not a zero.
    expect(drawn).not.toContain('#general (0)');
  });

  it('acknowledges the boundary the member could see when the conversation opened', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: M1, channel_id: C1, author_id: OTHER, content: 'hello there' })],
            oldestId: M1,
            hasCompleteHistory: true,
          },
        },
        unreadByChannel: { [C1]: unread({ last_read_id: null, unread_count: 1 }) },
      }),
    );
    const booted = await boot(store);
    try {
      // Mounting the client's own element IS the initial landing: the selection
      // resolves to C1 and the shell fires the read capture.
      const instance = shell(booted.elements);
      await waitFor(() => frame(instance).includes('#general'));
      await waitFor(() => acks(booted.fixture).length > 0);
      expect(acks(booted.fixture)[0]?.body).toEqual({ message_ids: [M1] });

      // The ack is PERSIST-FIRST: the local clear follows the server taking the
      // watermark, so the badge is gone once that lands.
      await waitFor(() => store.getState().unreadByChannel[C1]?.last_read_id === M1);
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });

  it('marks the highlighted message unread through the exclusive floor', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: M1, channel_id: C1, author_id: OTHER, content: 'hello there' })],
            oldestId: M1,
            hasCompleteHistory: true,
          },
        },
        unreadByChannel: { [C1]: unread({ last_read_id: null, unread_count: 1 }) },
      }),
    );
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      await waitFor(() => frame(instance).includes('hello there'));
      await waitFor(() => acks(booted.fixture).length > 0);
      // `u` marks the row the pane's cursor is on — a message action like any
      // other, addressable from either column's focus.
      await press(instance, 'u');
      await waitFor(() => acks(booted.fixture).some((entry) => 'unread_floor' in entry.body));

      const floor = acks(booted.fixture).find((entry) => 'unread_floor' in entry.body);
      // The floor is EXCLUSIVE (`last_read_id` is inclusive and cannot say
      // "this one is unread"), and the watermark rides the same request without
      // moving backwards. That rule is `readState.test.ts`'s; what this asserts
      // is that the CONVERSATION reached `markUnread` at all — without the
      // second argument the host has no channel to write the floor against.
      expect(floor?.body).toEqual({ message_ids: [M1], unread_floor: M1 });
      // The store takes the floor when the request settles, a tick after it
      // leaves — a slow runner can read in between.
      await waitFor(() => store.getState().unreadByChannel[C1]?.unread_floor !== undefined);
      expect(store.getState().unreadByChannel[C1]?.unread_floor).toBe(M1);
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// C. U14 — reactions
// ---------------------------------------------------------------------------

describe('C. reactions reach the store and the wire (U14)', () => {
  it('the reaction key adds the member’s own reaction and the pane draws the chip', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: M1, channel_id: C1, author_id: OTHER, content: 'hello there' })],
            oldestId: M1,
            hasCompleteHistory: true,
          },
        },
      }),
    );
    const booted = await boot(store);
    try {
      const instance = shell(booted.elements);
      await waitFor(() => frame(instance).includes('hello there'));
      // Column two owns the message cursor: Enter moves the keyboard there.
      await press(instance, '\r');
      await press(instance, 'e');

      await waitFor(() => booted.fixture.recorded.some((entry) => entry.url.includes('/reactions/')));
      const toggled = booted.fixture.recorded.find((entry) => entry.url.includes('/reactions/'));
      expect(toggled?.method).toBe('PUT');
      // The member's OWN route, with the emoji percent-encoded into the path —
      // the same `/api/v1` request the browser makes (R24).
      expect(toggled?.url).toBe(
        `/api/v1/channels/${C1}/messages/${M1}/reactions/${encodeURIComponent('👍')}/@me`,
      );
      // The chip the pane draws, bracketed because it is the member's own (the
      // non-colour channel).
      await waitFor(() => frame(instance).includes(`${OWN_CHIP_OPEN}👍 1${OWN_CHIP_CLOSE}`));
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });

  it('refuses a reaction the server will not take, and says why', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: M1, channel_id: C1, author_id: OTHER, content: 'hello there' })],
            oldestId: M1,
            hasCompleteHistory: true,
          },
        },
      }),
    );
    const booted = await boot(store);
    try {
      booted.fixture.refuseReactions();
      const instance = shell(booted.elements);
      await waitFor(() => frame(instance).includes('hello there'));
      await press(instance, '\r');
      await press(instance, 'e');

      // The refusal is a VALUE the shell renders — there is no other surface for
      // it, and a reaction the member cannot add must not fail silently (U14).
      await waitFor(() => frame(instance).includes('Could not add your reaction'));
      // …and the optimistic chip was rolled back, so the pane does not claim a
      // reaction the server refused.
      expect(frame(instance)).not.toContain(`${OWN_CHIP_OPEN}👍`);
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });

  it('answers a reaction keypress offline instead of swallowing it', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: M1, channel_id: C1, author_id: OTHER, content: 'hello there' })],
            oldestId: M1,
            hasCompleteHistory: true,
          },
        },
      }),
    );
    const asked: string[] = [];
    const instance = render(
      createElement(App, {
        view: { phase: 'offline', headline: 'Connection lost — reconnecting' },
        mode: 'ssh',
        origin: 'https://chat.example.com',
        store,
        width: SIZE.width,
        height: SIZE.height,
        onToggleReaction: (_target, messageId: string) => {
          asked.push(messageId);
        },
      }),
    );
    await waitFor(() => frame(instance).includes('hello there'));
    await press(instance, '\r');
    await press(instance, 'e');
    // The browser disables reactions offline; nothing is sent and the reason is
    // on the composer's own line.
    expect(asked).toEqual([]);
    await waitFor(() => frame(instance).includes('Reactions need a live connection'));
  });

  it('folds a reaction frame the SESSION delivers through the preprocessor seat', async () => {
    const store = createStateStore();
    store.setState(
      seed({
        messagesByChannel: {
          [C1]: {
            items: [message({ id: M1, channel_id: C1, author_id: OTHER, content: 'hello there' })],
            oldestId: M1,
            hasCompleteHistory: true,
          },
        },
      }),
    );
    const booted = await boot(store);
    try {
      // Pushed through the gateway the session ACTUALLY registered on, so this
      // is the client's `gatewayPreprocessors` seat under test and not a
      // hand-called fold. `@cytale/state` treats the reaction dispatches as
      // pass-through no-ops, so without the registration the store is untouched.
      booted.gateway.dispatch({
        op: 0,
        t: 'MessageReactionAdd',
        s: 1,
        d: { channel_id: C1, message_id: M1, user_id: OTHER, emoji: '🎉' },
      });
      const row = store.getState().messagesByChannel[C1]?.items[0] as
        | { reactions?: Array<{ emoji: string; count: number; me: boolean }> }
        | undefined;
      expect(row?.reactions).toEqual([{ emoji: '🎉', count: 1, me: false }]);

      const instance = shell(booted.elements);
      await waitFor(() => frame(instance).includes('🎉 1'));
    } finally {
      booted.quit();
      expect(await booted.running).toBe(0);
    }
  });
});
