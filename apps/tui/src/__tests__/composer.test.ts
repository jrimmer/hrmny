/**
 * @cytale/tui — the composer, sending, and live arrival (U8; R20, R21).
 *
 * Driven through `App` by keyboard alone, against a real `createStateStore()`
 * filled the way U12's hydration and the gateway fill it. The HOST SEAM is the
 * part that matters: a send is the app handing a resolved `ContentTarget` and
 * the typed text to the host, and the host — `client.ts`, over
 * `compose/send.ts` — writing the optimistic row into the SHARED store. So the
 * assertion is never "the callback fired": it is what the pane DRAWS after the
 * send, which is the only thing the member can see.
 *
 * Three scenarios are asserted the hard way, because they are the ones that can
 * pass while the product is broken:
 *
 *   * the arrival policy asserts the reader's ANCHORED MESSAGE (which row the
 *     `▸` cursor is on) and the presence of the affordance — not that the row
 *     landed in the store;
 *   * the reconciliation asserts the RENDERED row count and identity (one line
 *     per message, by id order), not the store's array length;
 *   * a rejected send asserts the TEXT IS STILL IN THE COMPOSER, not merely
 *     that an error string was rendered.
 *
 * The api-client's own behavior (the optimistic row, the REST 201, the
 * gateway echo, the token a request carries) lives in `send.test.ts`; this file
 * is the surface the member types into.
 */
import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Message, Thread, Workspace, WorkspaceMember } from '@cytale/domain';
import { ApiError } from '@cytale/api-client';
import {
  applyGatewayEvent,
  createStateStore,
  type StateStore,
  type StateState,
} from '@cytale/state';

import { App } from '../app.js';
import {
  ARRIVAL_JUMP_KEY,
  COMPOSER_PROMPT,
  arrivalBaseline,
  arrivalLine,
  atNewestRow,
  composerHeight,
  composerLines,
  decisionOf,
  newerRowCount,
  type ComposerModel,
} from '../compose/Composer.js';
import { createSender } from '../compose/send.js';
import { layoutFor } from '../columns/layout.js';
import type { ContentTarget } from '../columns/ContentColumn.js';
import { displayWidth } from '../format/markdown.js';
import type { HistoryRequest } from '../format/rows.js';

// ---------------------------------------------------------------------------
// Fixtures — a store filled the way hydration fills it
// ---------------------------------------------------------------------------

const ORIGIN = 'https://chat.example.com';
const WORKSPACE = '100000000000000001';
const GENERAL = '300000000000000001';
const RANDOM = '300000000000000002';
const RENAMED = '300000000000000003';
const ME = '900000000000000001';
const DANA = '900000000000000002';
const ERIN = '900000000000000003';
const THREAD = '700000000000000001';
const SEED = '800000000000000006';
const REPLY = '800000000000000009';
/** The id the api stub answers with when it "saves" a message. */
const SERVER_ROW = '800000000000000010';

const SIZE = { width: 100, height: 30 } as const;
/** A pane too short to hold the history, so "scrolled back" is a real state. */
const SHORT = { width: 100, height: 14 } as const;

function channel(overrides: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return {
    workspace_id: WORKSPACE,
    type: 'text',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function message(
  overrides: Partial<Message> & Pick<Message, 'id' | 'author_id' | 'content'>,
): Message {
  return {
    channel_id: GENERAL,
    thread_id: null,
    created_at: '2026-09-13T12:00:00.000Z',
    edited_at: null,
    ...overrides,
  };
}

function member(id: string, username: string): WorkspaceMember {
  return { id, username, nickname: null, joined_at: '', roles: [] };
}

function workspace(id = WORKSPACE, name = 'Acme'): Workspace {
  return {
    id,
    name,
    owner_id: '1',
    role_version: 1,
    created_at: '2026-09-13T09:00:00.000Z',
  };
}

/** The channel's loaded page, NEWEST FIRST — the order the store keeps. */
function channelPage(): Message[] {
  return [
    message({ id: SEED, author_id: DANA, content: 'sixth line' }),
    message({ id: '800000000000000005', author_id: DANA, content: 'fifth line' }),
    message({ id: '800000000000000004', author_id: DANA, content: 'fourth line' }),
  ];
}

function threadRecord(): Thread {
  return {
    id: THREAD,
    channel_id: GENERAL,
    parent_message_id: SEED,
    name: 'a thread',
    created_by: DANA,
    archived: false,
    created_at: '2026-09-13T12:00:00.000Z',
  };
}

function stateWith(overrides: Partial<StateState> = {}): Partial<StateState> {
  return {
    currentUser: { id: ME, username: 'tester' },
    workspaces: { [WORKSPACE]: workspace() },
    channels: {
      [GENERAL]: channel({ id: GENERAL, name: 'general' }),
      [RANDOM]: channel({ id: RANDOM, name: 'random', position: 1 }),
    },
    membersById: {
      [ME]: member(ME, 'tester'),
      [DANA]: member(DANA, 'dana'),
      [ERIN]: member(ERIN, 'erin'),
    },
    memberIdsByWorkspace: { [WORKSPACE]: [ME, DANA, ERIN] },
    messagesByChannel: {
      [GENERAL]: { items: channelPage(), oldestId: '800000000000000004', hasCompleteHistory: false },
    },
    ...overrides,
  };
}

function storeWith(state: Partial<StateState> = stateWith()): StateStore {
  const store = createStateStore();
  store.setState(state);
  return store;
}

// ---------------------------------------------------------------------------
// The gateway, as the session folds it
// ---------------------------------------------------------------------------

/** The dispatch sequence: every delivered frame takes the next one. */
let seq = 0;

/** A `MessageCreate` folded the way `SessionManager.onAny` folds it. */
function deliver(store: StateStore, row: Message, at = ++seq): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageCreate',
    s: at,
    d: {
      id: row.id,
      channel_id: row.channel_id,
      thread_id: row.thread_id,
      author_id: row.author_id,
      content: row.content,
      created_at: row.created_at,
      edited_at: row.edited_at,
    },
  });
}

/** A `ThreadMessageCreate` folded the way `SessionManager.onAny` folds it. */
function deliverThreadReply(store: StateStore, threadId: string, body: string): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'ThreadMessageCreate',
    s: ++seq,
    d: {
      id: `8000000000000000${seq.toString().padStart(2, '0')}`,
      channel_id: GENERAL,
      thread_id: threadId,
      author_id: ERIN,
      content: body,
      created_at: '2026-09-13T12:40:00.000Z',
      edited_at: null,
    },
  });
}

/** A fresh Identify (op 2 accepted): the store resets, the epoch advances. */
function freshIdentify(store: StateStore, user = { id: ME, username: 'tester' }): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'Ready',
    s: 0,
    d: {
      v: 1,
      session_id: 'session-1',
      resume_token: 'resume-1',
      heartbeat_interval: 45000,
      user,
    },
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The host's send seam. The host owns the optimistic write (through
 * `@cytale/state`'s helpers) and the REST leg; this file asserts the surface,
 * so the two halves it exercises are the ones the member can see.
 */
type SendResult = { ok: true } | { ok: false; reason: string };
type SendSeam = (target: ContentTarget, text: string) => void | Promise<SendResult>;

interface Options {
  readonly store?: StateStore;
  readonly width?: number;
  readonly height?: number;
  readonly phase?: 'connecting' | 'online' | 'offline' | 'expired' | 'failed' | 'signed_out';
  readonly onLoadHistory?: (request: HistoryRequest) => Promise<void>;
  readonly onSendTo?: SendSeam;
  readonly onSend?: (text: string) => void;
}

function mount(options: Options = {}) {
  return render(
    createElement(App, {
      view:
        options.phase === undefined || options.phase === 'online'
          ? { phase: 'online', headline: `Connected to ${ORIGIN}` }
          : { phase: options.phase, headline: `Phase ${options.phase}` },
      mode: 'ssh',
      origin: ORIGIN,
      store: options.store ?? storeWith(),
      width: options.width ?? SIZE.width,
      height: options.height ?? SIZE.height,
      ...(options.onLoadHistory === undefined ? {} : { onLoadHistory: options.onLoadHistory }),
      ...(options.onSendTo === undefined ? {} : { onSendTo: options.onSendTo }),
      ...(options.onSend === undefined ? {} : { onSend: options.onSend }),
    }),
  );
}

type Instance = ReturnType<typeof mount>;

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function press(instance: Instance, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

const KEYS = {
  tab: '\t',
  enter: '\r',
  escape: '\u001b',
  shiftEnter: '\u001b[13;2u',
  backspace: '\u007f',
  ctrlD: '\u0004',
} as const;

const frame = (instance: Instance): string => instance.lastFrame() ?? '';

/** The composer's own line: the prompt when focused, the hint when it is not. */
const PROMPT = /(?:▸ >|i writes)/;

function promptLine(instance: Instance): string {
  return frame(instance).split('\n').find((line) => PROMPT.test(line)) ?? '';
}

/** Every line the frame holds, so a body can be counted rather than found. */
const frameLines = (instance: Instance): string[] => frame(instance).split('\n');

/** A body's gutter line — the line above the one that holds the body. */
function gutterFor(instance: Instance, body: string): string {
  const lines = frameLines(instance);
  const at = lines.findIndex((line) => line.includes(body));
  return at > 0 ? (lines[at - 1] ?? '') : '';
}

/** The pane's lines only: the two-column block, column two, text intact. */
function paneText(instance: Instance, size: { width: number; height: number } = SIZE): string {
  const layout = layoutFor(size);
  const body = frame(instance).split('\n').slice(2, 2 + layout.height);
  if (layout.kind !== 'two-column') return body.join('\n');
  return body.map((line) => line.slice(layout.navigationWidth + 1)).join('\n');
}

/**
 * Which column a line was drawn in: column one, or column two. The columns are
 * side by side, so a line is column two's when its text starts past the
 * navigation column (U6's geometry decides where that is).
 */
function columnOf(
  instance: Instance,
  text: string,
  size: { width: number; height: number } = SIZE,
): 1 | 2 | null {
  const layout = layoutFor(size);
  for (const line of frameLines(instance)) {
    const at = line.indexOf(text);
    if (at === -1) continue;
    if (layout.kind !== 'two-column') return 1;
    return at > layout.navigationWidth ? 2 : 1;
  }
  return null;
}

/** Type `text` into the composer (one keystroke per character, as a human types). */
async function type(instance: Instance, text: string): Promise<void> {
  await press(instance, 'i');
  for (const character of text) await press(instance, character);
}

/**
 * The host's send: `compose/send.ts`'s real sender over an api stub. The
 * optimistic row, the settle, the rollback on failure and the outcome are the
 * unit's own code; the only thing faked is the socket, whose behavior this file
 * is not the place to assert (see `send.test.ts`).
 */
interface Call {
  readonly channelId: string;
  readonly threadId: string | null;
  readonly text: string;
  /** The nonce the POST carried as its Idempotency-Key. */
  readonly idempotencyKey: string | undefined;
}

function sender(
  store: StateStore,
  answer?: (call: Call) => Promise<Message>,
): { seam: SendSeam; calls: Call[] } {
  const calls: Call[] = [];
  const api = {
    sendMessage: async (
      channelId: string,
      body: { content: string; thread_id?: string | null },
      idempotencyKey?: string,
    ): Promise<Message> => {
      const call: Call = {
        channelId,
        threadId: body.thread_id ?? null,
        text: body.content,
        idempotencyKey,
      };
      calls.push(call);
      if (answer !== undefined) return await answer(call);
      // The server's own echo: the row it persisted, in the pane it belongs to.
      return message({
        id: SERVER_ROW,
        channel_id: call.channelId,
        thread_id: call.threadId,
        author_id: ME,
        content: call.text,
      });
    },
  };
  return { seam: createSender({ store, api }), calls };
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// R20 — composing and sending
// ---------------------------------------------------------------------------

describe('sending a message', () => {
  it('sends the typed text to the selected channel and draws it without a reload', async () => {
    const store = storeWith();
    const { seam, calls } = sender(store);
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await type(instance, 'hello');
    expect(promptLine(instance)).toContain('hello');
    await press(instance, KEYS.enter);
    await tick();

    // The destination is asserted as an ID, not as a `#general` label; the
    // nonce rode as the Idempotency-Key, so a retry cannot double-post.
    expect(calls).toEqual([
      expect.objectContaining({
        channelId: GENERAL,
        threadId: null,
        text: 'hello',
        idempotencyKey: expect.any(String),
      }),
    ]);
    // The row is DRAWN, in the pane, under the author's own name…
    expect(paneText(instance)).toContain('hello');
    expect(gutterFor(instance, 'hello')).toContain('tester');
    // …and the composer gave the text up: the prompt is empty again.
    expect(promptLine(instance)).not.toContain('hello');
  });

  it('sends a reply from the thread view into that thread, not the channel', async () => {
    const store = storeWith({
      ...stateWith(),
      threadsById: { [THREAD]: threadRecord() },
      threadIdsByChannel: { [GENERAL]: [THREAD] },
      messagesByThread: {
        [THREAD]: { items: [message({ id: REPLY, thread_id: THREAD, author_id: ERIN, content: 'a reply' })], oldestId: REPLY, hasCompleteHistory: true },
      },
    });
    const { seam, calls } = sender(store);
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await press(instance, KEYS.tab); // into column two, on the newest message
    await press(instance, 't'); // open its thread
    expect(frame(instance)).toContain('thread: a thread');
    await type(instance, 'into the thread');
    await press(instance, KEYS.enter);
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channelId: GENERAL,
      threadId: THREAD,
      text: 'into the thread',
    });
    // The reply is drawn in the THREAD pane, and the channel's slice is not
    // where it landed.
    expect(paneText(instance)).toContain('into the thread');
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(3);
  });

  it('leaves nothing behind when the member presses Enter on an empty composer', async () => {
    const store = storeWith();
    const { seam, calls } = sender(store);
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await press(instance, 'i');
    await press(instance, KEYS.enter);
    await tick();

    expect(calls).toHaveLength(0);
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(3);
  });

  it('inserts a newline on Shift+Enter and sends the whole message on Enter', async () => {
    const store = storeWith();
    const { seam, calls } = sender(store);
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await type(instance, 'first');
    await press(instance, KEYS.shiftEnter);
    await tick();
    // Shift+Enter is a newline, not a send: nothing left the composer…
    expect(calls).toHaveLength(0);
    await press(instance, 'second');
    await tick();
    // …and the second line is VISIBLE while it is being typed — in column two,
    // under the first line, not in column one — and it is NOT flattened onto the
    // prompt line, which is a single line and draws only the first.
    expect(frame(instance)).toContain('second');
    expect(columnOf(instance, 'second')).toBe(2);
    expect(promptLine(instance)).toContain('first');
    expect(promptLine(instance)).not.toContain('second');

    await press(instance, KEYS.enter);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('first\nsecond');
    // One message, two body lines, drawn once.
    expect(paneText(instance)).toContain('first');
    expect(paneText(instance)).toContain('second');
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(4);
  });

  it('refunds the composer its lines, so the shell still fits the window', async () => {
    const store = storeWith();
    const { seam } = sender(store, async () => {
      throw new Error('unreachable while the composer is full');
    });
    const instance = mount({ store, onSendTo: seam, height: SHORT.height });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k');

    await type(instance, 'one');
    // Three lines of draft (two continuations and the failing send's reason)
    // and an arrival affordance, all drawn by the composer.
    await press(instance, KEYS.shiftEnter);
    await press(instance, 'two');
    await press(instance, KEYS.shiftEnter);
    await press(instance, 'three');
    deliver(store, message({ id: '800000000000000007', author_id: ERIN, content: 'seventh line' }));
    await tick();
    await press(instance, KEYS.enter); // a send that fails: the reason is a line
    await tick();

    expect(frame(instance)).toContain('two');
    expect(frame(instance)).toContain('three');
    expect(frame(instance)).toContain('newer message');
    expect(frame(instance)).toContain('Could not send');
    // The pane gave up exactly what the composer took: the reader's row is
    // still on screen, and the frame is still inside the window the shell was
    // measured against. Without the refund the pane would keep its full budget
    // and the frame would run past the terminal, scrolling the banner away.
    expect(frame(instance)).toContain('fifth line');
    expect(frameLines(instance).filter((line) => line !== '').length).toBeLessThanOrEqual(
      SHORT.height,
    );
  });

  it('refuses a message longer than the server accepts, locally, and keeps it', async () => {
    const store = storeWith();
    const { seam, calls } = sender(store);
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await press(instance, 'i');
    await press(instance, 'x'.repeat(4001)); // a paste, one chunk
    await press(instance, KEYS.enter);
    await tick();

    // Nothing was sent: the server's 4000-byte body limit is enforced here.
    expect(calls).toHaveLength(0);
    expect(frame(instance)).toContain('4000');
    // The text was NOT dropped: the refusal is about the draft, not about the
    // member's words, so they can shorten what they wrote.
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(3);
    expect(promptLine(instance)).not.toContain('i writes');
  });
});

describe('sending states', () => {
  it('shows the send in flight and keeps the text until the server answers', async () => {
    const store = storeWith();
    // A boxed release, so the closure that fills it is visible to the compiler
    // (the same shape U7's paging tests use for a gated load).
    const gate: { release: (() => void) | null } = { release: null };
    const { seam } = sender(
      store,
      async (call) =>
        await new Promise<Message>((resolve) => {
          gate.release = () =>
            resolve(message({ id: SERVER_ROW, author_id: ME, content: call.text }));
        }),
    );
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await type(instance, 'slow');
    await press(instance, KEYS.enter);
    await tick();
    // In flight: said so, and the text has not been thrown away yet. The
    // optimistic row is already in the pane, which is what "sends immediately"
    // means for the member.
    expect(frame(instance)).toContain('sending');
    expect(promptLine(instance)).toContain('slow');
    expect(paneText(instance)).toContain('slow');

    gate.release?.();
    await tick();
    expect(frame(instance)).not.toContain('sending');
    expect(promptLine(instance)).not.toContain('slow');
    // One row: the placeholder settled into the server's row, not beside it.
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(4);
  });

  it('keeps the text and renders the reason when the send is rejected', async () => {
    const store = storeWith();
    const { seam } = sender(store, async () => {
      throw new ApiError({
        key: 'forbidden',
        code: 40301,
        message: 'you cannot post in this channel',
        status: 403,
      });
    });
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await type(instance, 'rejected words');
    await press(instance, KEYS.enter);
    await tick();

    // The reason is rendered, in the client's own words plus the cause…
    expect(paneText(instance)).toContain('Could not send');
    expect(paneText(instance)).toContain('you cannot post in this channel');
    // …and the member's text is still there to retry or copy, while the
    // optimistic row was rolled back rather than left standing as a lie.
    expect(promptLine(instance)).toContain('rejected words');
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(3);
    // The shared store keeps the record of the failed send, the way the other
    // clients' retry surfaces read it — the terminal just renders its own copy.
    expect(Object.values(store.getState().failedByNonce)).toHaveLength(1);

    // The way out is the same keystroke: fixing nothing and pressing Enter
    // sends again (the text never left the composer).
    await press(instance, KEYS.enter);
    await tick();
    expect(paneText(instance)).toContain('you cannot post in this channel');
  });

  it('keeps the text when the send fails while the gateway link is down', async () => {
    const store = storeWith();
    const { seam } = sender(store, async () => {
      throw new TypeError('fetch failed');
    });
    const instance = mount({ store, onSendTo: seam, phase: 'offline' });
    await tick();

    // The view survives the dropped link: the history is still on screen.
    expect(frame(instance)).toContain('Phase offline');
    expect(paneText(instance)).toContain('fifth line');

    await type(instance, 'while down');
    await press(instance, KEYS.enter);
    await tick();
    expect(paneText(instance)).toContain('fetch failed');
    expect(promptLine(instance)).toContain('while down');
  });

  it('renders a transport cause inertly (R26a)', async () => {
    const store = storeWith();
    const { seam } = sender(store, async () => {
      throw new Error('bad gateway \u001b[2J\u001b[31m whoops');
    });
    const instance = mount({ store, onSendTo: seam });
    await tick();

    await type(instance, 'hi');
    await press(instance, KEYS.enter);
    await tick();
    const drawn = frame(instance);
    expect(drawn).not.toContain('\u001b[2J');
    expect(drawn).not.toContain('\u001b[31m');
    expect(drawn).toContain('bad gateway');
    expect(drawn).toContain('whoops');
  });
});

describe('the optimistic send against the gateway echo', () => {
  it('reconciles to ONE row, whichever of the 201 and the echo lands first', async () => {
    const store = storeWith();

    // The REST 201 wins the race: the optimistic row is settled by it, and the
    // gateway's echo of the SAME message arrives afterwards.
    const first = sender(store);
    const one = mount({ store, onSendTo: first.seam });
    await tick();
    await type(one, 'once');
    await press(one, KEYS.enter);
    await tick();

    deliver(store, message({ id: SERVER_ROW, author_id: ME, content: 'once' }));
    await tick();

    // The row count AND its identity: one server row, no placeholder left.
    const rows = store.getState().messagesByChannel[GENERAL]?.items ?? [];
    expect(rows.filter((row) => row.id === SERVER_ROW)).toHaveLength(1);
    expect(rows.some((row) => row.id.startsWith('pending_'))).toBe(false);
    expect(rows).toHaveLength(4);
    // …and the pane draws it once, as the newest row.
    expect(frameLines(one).filter((line) => line.includes('once'))).toHaveLength(1);
    cleanup();

    // The gateway echo wins the race this time: the row is already there when
    // the 201 lands, so the settle pass must replace the placeholder with the
    // row it already has rather than adding a second one.
    const other = storeWith();
    const second = sender(other, async (call) => {
      deliver(other, message({ id: SERVER_ROW, author_id: ME, content: call.text }));
      return message({ id: SERVER_ROW, author_id: ME, content: call.text });
    });
    const two = mount({ store: other, onSendTo: second.seam });
    await tick();
    await type(two, 'early echo');
    await press(two, KEYS.enter);
    await tick();
    deliver(other, message({ id: SERVER_ROW, author_id: ME, content: 'early echo' }));
    await tick();

    const echoed = other.getState().messagesByChannel[GENERAL]?.items ?? [];
    expect(echoed.filter((row) => row.id === SERVER_ROW)).toHaveLength(1);
    expect(echoed.some((row) => row.id.startsWith('pending_'))).toBe(false);
    expect(echoed).toHaveLength(4);
    expect(frameLines(two).filter((line) => line.includes('early echo'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R21 — live arrival, and the reader's position
// ---------------------------------------------------------------------------

describe('a message arriving from another member', () => {
  it('appends to the selected channel without a reload', async () => {
    const store = storeWith();
    const instance = mount({ store });
    await tick();
    await press(instance, KEYS.tab); // reading column two

    deliver(store, message({ id: '800000000000000007', author_id: ERIN, content: 'live arrival' }));
    await tick();

    expect(paneText(instance)).toContain('live arrival');
    expect(gutterFor(instance, 'live arrival')).toContain('erin');
  });

  it('appends a thread reply to the open thread, not to the channel', async () => {
    const store = storeWith({
      ...stateWith(),
      threadsById: { [THREAD]: threadRecord() },
      threadIdsByChannel: { [GENERAL]: [THREAD] },
      messagesByThread: {
        [THREAD]: {
          items: [message({ id: REPLY, thread_id: THREAD, author_id: ERIN, content: 'a reply' })],
          oldestId: REPLY,
          hasCompleteHistory: true,
        },
      },
    });
    const instance = mount({ store });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 't');
    expect(frame(instance)).toContain('thread: a thread');

    deliverThreadReply(store, THREAD, 'another reply');
    await tick();

    expect(paneText(instance)).toContain('another reply');
    // The channel's slice is not the thread's to write: a thread reply never
    // rides the channel timeline (the gateway sends a different event for it).
    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(3);
  });

  it('pins to the newest when the reader is already at the newest message', async () => {
    const store = storeWith();
    const instance = mount({ store });
    await tick();
    await press(instance, KEYS.tab);
    // The member MOVES the cursor onto the newest row. Without this the cursor
    // is absent from the shell's map, and every render re-derives "the newest"
    // — so the pane would look right whatever the policy did, which is exactly
    // how this scenario passes while the product is broken.
    await press(instance, 'k');
    await press(instance, 'j');
    await tick();
    expect(gutterFor(instance, 'sixth line')).toContain('▸');

    deliver(store, message({ id: '800000000000000007', author_id: ERIN, content: 'seventh line' }));
    await tick();

    // The anchored row moved with the arrival: the cursor is on the NEW
    // message, not left behind above it…
    expect(gutterFor(instance, 'seventh line')).toContain('▸');
    expect(gutterFor(instance, 'sixth line')).not.toContain('▸');
    // …and there is nothing to jump to, so no affordance claims otherwise.
    expect(frame(instance)).not.toContain('newer message');
  });

  it('holds position when the reader is scrolled back, and offers a jump', async () => {
    const store = storeWith();
    const instance = mount({ store, height: SHORT.height });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k'); // walk up, away from the newest
    await tick();
    expect(gutterFor(instance, 'fifth line')).toContain('▸');

    deliver(store, message({ id: '800000000000000007', author_id: ERIN, content: 'seventh line' }));
    await tick();

    // Position held: the reader's row is still the anchored one…
    expect(gutterFor(instance, 'fifth line')).toContain('▸');
    expect(gutterFor(instance, 'seventh line')).not.toContain('▸');
    // …and the arrival is announced, with the key that goes to it.
    expect(frame(instance)).toContain('newer message');
    expect(frame(instance)).toContain('Ctrl+D');
  });

  it('jumps to the newest when the affordance is showing, and the affordance clears', async () => {
    const store = storeWith();
    const instance = mount({ store, height: SHORT.height });
    await tick();
    await press(instance, KEYS.tab);
    await press(instance, 'k');
    await tick();
    deliver(store, message({ id: '800000000000000007', author_id: ERIN, content: 'seventh line' }));
    await tick();
    expect(frame(instance)).toContain('newer message');

    await press(instance, KEYS.ctrlD);
    await tick();

    expect(gutterFor(instance, 'seventh line')).toContain('▸');
    expect(frame(instance)).not.toContain('newer message');
  });

  it('does not shout about the rows an Identify re-hydrates', async () => {
    const store = storeWith();
    const instance = mount({ store });
    await tick();

    freshIdentify(store);
    store.setState({
      ...stateWith(),
      // The re-hydrated graph: the same messages, read again from REST.
      messagesByChannel: {
        [GENERAL]: {
          items: channelPage(),
          oldestId: '800000000000000004',
          hasCompleteHistory: true,
        },
      },
    });
    await tick();

    // Everything is "newer" than a fresh pane's baseline, and claiming a
    // backlog of unread arrivals would be a lie: a re-hydration is not an
    // arrival.
    expect(frame(instance)).not.toContain('newer message');
    expect(paneText(instance)).toContain('sixth line');
  });
});

// ---------------------------------------------------------------------------
// R21 — recovery
// ---------------------------------------------------------------------------

describe('a dropped connection', () => {
  it('resumes without rendering a message twice', async () => {
    const store = storeWith();
    const instance = mount({ store });
    await tick();

    deliver(store, message({ id: '800000000000000007', author_id: ERIN, content: 'once only' }), 5);
    await tick();
    // A Resume replays the frames the client missed; the same dispatch must not
    // double the row.
    deliver(store, message({ id: '800000000000000007', author_id: ERIN, content: 'once only' }), 5);
    await tick();

    expect(store.getState().messagesByChannel[GENERAL]?.items).toHaveLength(4);
    const drawn = frameLines(instance).filter((line) => line.includes('once only'));
    expect(drawn).toHaveLength(1);
  });

  it('re-derives the selection after a fresh Identify instead of emptying the pane', async () => {
    const store = storeWith();
    const instance = mount({ store });
    await tick();
    await press(instance, 'j'); // column one's selection: the second row
    await tick();
    expect(frame(instance)).toContain('#random');

    // The link dropped and the fresh Identify reset the store; the boot load
    // re-hydrated a graph in which the previously selected id is GONE.
    freshIdentify(store);
    store.setState({
      currentUser: { id: ME, username: 'tester' },
      workspaces: { [WORKSPACE]: workspace() },
      channels: {
        [GENERAL]: channel({ id: GENERAL, name: 'general' }),
        [RENAMED]: channel({ id: RENAMED, name: 'renamed', position: 1 }),
      },
      membersById: { [ME]: member(ME, 'tester'), [DANA]: member(DANA, 'dana') },
      memberIdsByWorkspace: { [WORKSPACE]: [ME, DANA] },
      messagesByChannel: {
        [GENERAL]: { items: channelPage(), oldestId: null, hasCompleteHistory: true },
        [RENAMED]: {
          items: [message({ id: '800000000000000008', author_id: DANA, content: 'rehydrated line' })],
          oldestId: null,
          hasCompleteHistory: true,
        },
      },
    });
    await tick();

    // Re-derived from the loaded list — not the stale id, and not an empty pane.
    expect(frame(instance)).toContain('#renamed');
    expect(frame(instance)).not.toContain('#random');
    expect(paneText(instance)).toContain('rehydrated line');
  });
});

// ---------------------------------------------------------------------------
// The arrival policy and the composer's lines, as tables
// ---------------------------------------------------------------------------

describe('the arrival policy, stated', () => {
  const rows = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const baseline = (newestId: string | null, atNewest: boolean, key = 'channel:c') => ({
    key,
    epoch: 1,
    newestId,
    atNewest,
  });

  it('counts the rows below the anchor, and calls the last row the newest', () => {
    expect(newerRowCount(rows, 2)).toBe(0);
    expect(newerRowCount(rows, 0)).toBe(2);
    expect(newerRowCount([], 0)).toBe(0);
    // A cursor past the end (a shrunken slice) cannot report a negative count.
    expect(newerRowCount(rows, 99)).toBe(0);
    expect(atNewestRow(rows, 2)).toBe(true);
    expect(atNewestRow(rows, 1)).toBe(false);
  });

  it('offers nothing to jump to when there is nothing newer, and names the key when there is', () => {
    expect(arrivalLine(0)).toBeNull();
    expect(arrivalLine(-1)).toBeNull();
    expect(arrivalLine(1)).toContain('1 newer message');
    expect(arrivalLine(1)).toContain(ARRIVAL_JUMP_KEY);
    expect(arrivalLine(3)).toContain('3 newer messages');
  });

  it('pins only for a reader who was at the newest, and holds otherwise', () => {
    // No baseline yet (a new pane, or a fresh session): adopt, never act.
    expect(decisionOf(null, baseline('3', true))).toBe('baseline');
    // A re-hydration under a new session epoch is not an arrival.
    expect(decisionOf({ ...baseline('3', true), epoch: 0 }, baseline('3', true))).toBe('baseline');
    // A different pane is not an arrival either.
    expect(decisionOf(baseline('3', true, 'channel:a'), baseline('3', true, 'channel:b'))).toBe(
      'baseline',
    );
    // Nothing moved.
    expect(decisionOf(baseline('3', true), baseline('3', true))).toBe('idle');
    // The reader was at the newest: follow it down.
    expect(decisionOf(baseline('3', true), baseline('4', false))).toBe('pin');
    // The reader was reading history above it: stay exactly where they were.
    expect(decisionOf(baseline('3', false), baseline('4', false))).toBe('hold');
  });

  it('reads the baseline off the pane the reader is looking at', () => {
    expect(arrivalBaseline('channel:c', 2, rows, 1)).toEqual({
      key: 'channel:c',
      epoch: 2,
      newestId: '3',
      atNewest: false,
    });
    expect(arrivalBaseline('channel:c', 2, [], 0)).toEqual({
      key: 'channel:c',
      epoch: 2,
      newestId: null,
      atNewest: true,
    });
  });
});

describe('the composer lines', () => {
  const model = (overrides: Partial<ComposerModel> = {}): ComposerModel => ({
    buffer: '',
    pending: false,
    problem: null,
    newerCount: 0,
    target: '#general',
    ...overrides,
  });

  it('costs nothing while it is idle, so the pane keeps its whole budget', () => {
    expect(composerHeight(model(), 66)).toBe(0);
    expect(composerLines(model(), 66)).toEqual([]);
  });

  it('draws a line per continuation, indented under the prompt column two draws', () => {
    const lines = composerLines(model({ buffer: 'one\ntwo\nthree' }), 66);
    expect(lines).toHaveLength(2);
    // The indent is the prompt's own width, so a continuation sits under the
    // first line's TEXT rather than under its marker.
    const indent = ' '.repeat(displayWidth(COMPOSER_PROMPT));
    expect(lines[0]).toBe(`${indent}two`);
    expect(lines[1]).toBe(`${indent}three`);
  });

  it('keeps the member newlines and sanitizes every line (R26a)', () => {
    const lines = composerLines(model({ buffer: 'ok\u001b[2J\n\u001b[31mred' }), 66);
    // The newline survived (the first line is column two's; this is the rest)…
    expect(lines).toHaveLength(1);
    // …and the escapes did not reach the terminal.
    expect(lines.join('\n')).not.toContain('\u001b[2J');
    expect(lines.join('\n')).not.toContain('\u001b[31m');
    expect(lines[0]).toContain('red');
  });

  it('stacks the status lines in a fixed order and wraps them to the width', () => {
    const lines = composerLines(
      model({ pending: true, problem: '\u2716 Could not send: nope', newerCount: 2 }),
      40,
    );
    // A wide glyph (CJK, an emoji) must not push a line past the pane either.
    const wide = composerLines(model({ problem: '\u6f22'.repeat(40) }), 20);
    const text = lines.join(' ');
    expect(text.indexOf('sending')).toBeLessThan(text.indexOf('Could not send'));
    expect(text.indexOf('Could not send')).toBeLessThan(text.indexOf('newer messages'));
    for (const line of [...lines, ...wide]) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// The composer's place in the shell (U6's surface, unchanged)
// ---------------------------------------------------------------------------

describe('the composer and focus', () => {
  it('keeps Enter for column one when the composer is not focused', async () => {
    const store = storeWith();
    const onSend = vi.fn();
    const instance = mount({ store, onSend });
    await tick();

    await press(instance, KEYS.enter);
    await tick();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('still dispatches the host callback a caller that returns nothing wires', async () => {
    // U7's seam, unchanged: a synchronous `onSendTo` clears the composer, which
    // is all a caller with no promise to await can say.
    const store = storeWith();
    const onSendTo = vi.fn();
    const instance = mount({ store, onSendTo });
    await tick();

    await type(instance, 'hi');
    await press(instance, KEYS.enter);
    await tick();
    expect(onSendTo).toHaveBeenCalledWith(expect.objectContaining({ channelId: GENERAL }), 'hi');
    expect(promptLine(instance)).not.toContain('hi');
  });
});
