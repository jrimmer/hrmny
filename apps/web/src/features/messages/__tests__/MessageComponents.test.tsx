/**
 * @cytale/web — MessageComponents tests (components plan U4, R7/R8 render).
 *
 * Every U4 scenario, verbatim: the content→embeds→attachments→components→reactions
 * order pin; the click loop (POST body exact → pending disables THAT
 * control → MessageUpdate flip → resolved/disabled); the type-4
 * reply's completion with NO timeout affordance (the false-timeout pin),
 * and a bot message with no answer ending in the Dismiss-only "didn't
 * confirm" notice; pre-disabled history render; the 10s timeout affordance with
 * armed-store-side late signals; the virtualization remount pending pin;
 * http/https link anchors with inert javascript:/data: urls; thread-panel
 * inherited render; offline / view-only / revoked-bot disables; the stale
 * select submit's 400 dead-control state; 4xx retry vs 403 dismiss-only vs
 * the distinct dead-button copy; the keyboard walkthrough (buttons in tab
 * order, select arrows/enter/escape + focus return); ≥40×40px hit areas at
 * mobile width; live-region announcements; axe zero violations desktop +
 * mobile over a fixture with an active card, a resolved card, an open
 * select, and a pending control.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { MessageItem } from '../MessageItem.js';
import { safeLinkHref } from '../MessageComponents.js';
import type { MessageWithBots } from '../types.js';
import { ThreadSidePanel } from '../../threads/ThreadSidePanel.js';
import type { UseThreads } from '../../threads/useThreads.js';
import { resetComponentClicks, COMPONENT_CLICK_TIMEOUT_MS } from '../../commands/useComponentClick.js';
import { modalStore, receiveModal, resetModalRegistry } from '../../interactions/modalRegistry.js';
import {
  receiveInteractionSuccess,
  resetInteractionAnswers,
} from '../../interactions/interactionAnswers.js';
import { mobileWidthState } from '../../../test/setup.js';

const ME = '7000000000000002';
const BOT = '8000000000000001';
const CHANNEL = '9007199254740993';
const MESSAGE_ID = '1000000000000001';

const APPROVE_ROW = [
  {
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Approve', custom_id: 'approve-btn' },
      { type: 2, style: 4, label: 'Deny', custom_id: 'deny-btn' },
    ],
  },
];

const RESOLVED_ROW = [
  {
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Approved', custom_id: 'approve-btn', disabled: true },
    ],
  },
];

const SELECT_ROW = [
  {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: 'model-pick',
        placeholder: 'Pick a model',
        options: [
          { label: 'GLM 5.3', value: 'glm-5.3', description: 'fast' },
          { label: 'GLM 5.3 Air', value: 'glm-5.3-air' },
        ],
      },
    ],
  },
];

function makeMessage(overrides: Partial<MessageWithBots> = {}): MessageWithBots {
  return {
    id: MESSAGE_ID,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: BOT,
    content: 'Run this command?',
    created_at: '2026-09-06T12:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

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

/** Seed the channel slice with the message (the watch's window into the row). */
function seedStore(message: MessageWithBots): void {
  store.setState({
    messagesByChannel: {
      [CHANNEL]: { items: [message], oldestId: null, hasCompleteHistory: true },
    },
  });
}

/** Land the type-7 flip: MessageUpdate patches components + edited_at. */
function landFlip(message: MessageWithBots): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageUpdate',
    s: ++seq,
    d: {
      id: message.id,
      channel_id: CHANNEL,
      thread_id: null,
      content: message.content,
      edited_at: message.edited_at ?? '2026-09-06T12:00:05Z',
      components: message.components,
    },
  } as never);
}

/** Land the type-4/followup reply: an ordinary bot-authored MessageCreate. */
function landBotReply(content: string): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageCreate',
    s: ++seq,
    d: {
      id: String(2_000_000_000_000_000 + seq),
      channel_id: CHANNEL,
      thread_id: null,
      author_id: BOT,
      content,
      created_at: '2026-09-06T12:00:06Z',
      edited_at: null,
    },
  } as never);
}

/** Render one MessageItem the way MessageList does (bot attribution + store). */
function renderItem(
  message: MessageWithBots,
  props: { authorKind?: string | null; viewOnly?: boolean } = {},
) {
  const utils = render(
    <MessageItem
      message={message}
      authorName="Roster Bot"
      authorKind={(props.authorKind ?? 'bot') as never}
      currentUserId={ME}
      store={store}
      viewOnly={props.viewOnly}
      onToggleReaction={vi.fn()}
    />,
  );
  lastRerender = (ui: React.ReactElement) => utils.rerender(ui);
  return utils;
}

/** The button carrying a custom_id (rows may hold several buttons). */
function getControl(customId: string): HTMLElement {
  const el = screen
    .getAllByTestId('component-button')
    .find((b) => b.getAttribute('data-custom-id') === customId);
  if (!el) throw new Error(`no component button with custom_id ${customId}`);
  return el;
}

/** Flush the transport microtask chain after a click. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return JSON.parse(String(call[1]!.body)) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(202, { interaction_id: '9300000000000001' }));
  vi.stubGlobal('fetch', fetchMock);
  store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
});

afterEach(() => {
  cleanup();
  resetComponentClicks();
  resetModalRegistry();
  resetInteractionAnswers();
  mobileWidthState.mobile = false;
  Object.defineProperty(window.navigator, 'onLine', {
    value: true,
    configurable: true,
    writable: true,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MessageComponents — rendering (R7)', () => {
  it('renders rows at the BOTTOM of the body — content→embeds→attachments→components→reactions', () => {
    const message = makeMessage({
      components: APPROVE_ROW,
      embeds: [{ title: 'Deploy finished', description: 'build #42 passed' }],
      attachments: [
        {
          id: '2000000000000001',
          message_id: MESSAGE_ID,
          filename: 'pic.png',
          content_type: 'image/png',
          size: 1024,
          url: '/api/v1/attachments/pic.png',
        },
      ],
      reactions: [{ emoji: '👍', count: 1, me: false }],
    });
    renderItem(message);
    const content = screen.getByTestId('message-content');
    const embed = screen.getByTestId('embed-card');
    const attachment = screen.getByTestId('attachment-image');
    const block = screen.getByTestId('component-block');
    const reactions = screen.getByTestId('reaction-row');
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(content, embed)).toBe(true);
    expect(follows(embed, attachment)).toBe(true);
    // The action rows come LAST — below the card they decide about (owner,
    // 2026-09-18: "move the option buttons to the underside of the box asking
    // the question instead of above the top"). U4's R7 text asserted the
    // opposite and called it "Discord's order"; U4's own Files line had named
    // this slot.
    expect(follows(attachment, block)).toBe(true);
    expect(follows(block, reactions)).toBe(true);
  });

  it('renders buttons with data-custom-id and token-disciplined style mapping (1 accent / 4 danger)', () => {
    renderItem(makeMessage({ components: APPROVE_ROW }));
    const approve = getControl('approve-btn');
    expect(approve.getAttribute('data-custom-id')).toBe('approve-btn');
    expect(approve.getAttribute('data-style')).toBe('1');
    expect(approve.className).toContain('bg-accent');
    const deny = screen.getAllByTestId('component-button')[1]!;
    expect(deny.getAttribute('data-custom-id')).toBe('deny-btn');
    expect(deny.className).toContain('bg-danger');
    // Real buttons, in the tab order (keyboard-first pin).
    expect(approve.tagName).toBe('BUTTON');
    expect(approve.getAttribute('type')).toBe('button');
    expect(approve.getAttribute('tabindex')).not.toBe('-1');
  });

  it('renders a pre-disabled row disabled from history (resolved-card initial render)', () => {
    renderItem(makeMessage({ components: RESOLVED_ROW }));
    const button = screen.getByTestId('component-button');
    expect(button.getAttribute('disabled')).toBe('');
    expect(button.textContent).toBe('Approved');
    expect(button.getAttribute('data-pending')).toBe(null);
  });

  it('renders nothing for a human-authored message carrying a components key (defensive)', () => {
    renderItem(makeMessage({ components: APPROVE_ROW }), { authorKind: 'human' });
    expect(screen.queryByTestId('component-block')).toBeNull();
  });

  it('renders nothing on the optimistic-send placeholder row', () => {
    renderItem(makeMessage({ id: 'pending_abc', components: APPROVE_ROW }));
    expect(screen.queryByTestId('component-block')).toBeNull();
  });

  it('degrades malformed component JSON without crashing (unknown types drop out)', () => {
    renderItem(
      makeMessage({
        components: [
          'not-a-row',
          { type: 9, components: [] },
          { type: 1, components: 'nope' },
          { type: 1, components: [{ type: 42, label: '??' }, null, { type: 2, style: 2, label: 'Ok', custom_id: 'ok-btn' }] },
        ] as never,
      }),
    );
    const buttons = screen.getAllByTestId('component-button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('data-custom-id')).toBe('ok-btn');
  });
});

describe('MessageComponents — link buttons (KTD7)', () => {
  it('renders an http/https link as an anchor (target blank), never a POST', () => {
    renderItem(
      makeMessage({
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Docs', url: 'https://docs.example.com/x' }] }],
      }),
    );
    const link = screen.getByTestId('component-link');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://docs.example.com/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    fireEvent.click(link);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)', 'data:text/html,evil', '//protocol-relative.example', 'ftp://files.example', 42, null])(
    'renders a %s url INERT (no href, aria-disabled, never navigates)',
    (url) => {
      expect(safeLinkHref(url)).toBeNull();
      renderItem(
        makeMessage({
          components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Bad', url }] }],
        }),
      );
      const link = screen.getByTestId('component-link');
      expect(link.getAttribute('href')).toBe(null);
      expect(link.getAttribute('aria-disabled')).toBe('true');
      expect(link.hasAttribute('data-inert')).toBe(true);
    },
  );
});

describe('MessageComponents — the click loop (KTD6)', () => {
  it('click → POST body exact → pending disables THAT control only → MessageUpdate flip → resolved/disabled', async () => {
    const message = makeMessage({ components: APPROVE_ROW });
    seedStore(message);
    renderItem(message);

    const approve = getControl('approve-btn');
    await act(async () => {
      fireEvent.click(approve);
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody()).toEqual({
      channel_id: CHANNEL,
      message_id: MESSAGE_ID,
      custom_id: 'approve-btn',
      component_type: 2,
      nonce: expect.any(String),
    });
    // Pending disables ONLY the clicked control.
    expect(approve.getAttribute('disabled')).toBe('');
    expect(approve.getAttribute('data-pending')).toBe('true');
    expect(approve.getAttribute('title')).toBe('Waiting for the bot to respond');
    const deny = screen.getAllByTestId('component-button')[1]!;
    expect(deny.getAttribute('disabled')).toBe(null);
    expect(deny.getAttribute('data-pending')).toBe(null);

    // The type-7 flip lands in the store (watch clears pending store-side)…
    const flipped = makeMessage({ components: RESOLVED_ROW, edited_at: '2026-09-06T12:00:05Z' });
    act(() => landFlip(flipped));
    // …and MessageList re-derives the row (props catch up to the store).
    const resolved = makeMessage({ components: RESOLVED_ROW, edited_at: '2026-09-06T12:00:05Z' });
    rerenderWith(resolved);

    const resolvedButton = screen.getByTestId('component-button');
    expect(resolvedButton.getAttribute('disabled')).toBe('');
    expect(resolvedButton.textContent).toBe('Approved');
    expect(resolvedButton.getAttribute('data-pending')).toBe(null);
    // No error affordance: the click resolved.
    expect(screen.queryByTestId('component-error')).toBeNull();
  });

  it('type-4 reply completion clears pending with NO timeout affordance (false-timeout pin)', async () => {
    vi.useFakeTimers();
    try {
      const message = makeMessage({ components: APPROVE_ROW });
      seedStore(message);
      renderItem(message);
      await act(async () => {
        fireEvent.click(getControl('approve-btn'));
      });
      await flush();
      expect(getControl('approve-btn').getAttribute('data-pending')).toBe('true');

      // The bot replies with a NEW MESSAGE (type 4), not an update; the
      // server's InteractionSuccess for it is the answer.
      act(() => landBotReply('done!'));
      act(() => {
        receiveInteractionSuccess({
          interaction_id: '9300000000000001',
          nonce: lastBody().nonce as string,
          application_id: BOT,
          channel_id: CHANNEL,
          thread_id: null,
          message_id: MESSAGE_ID,
          custom_id: 'approve-btn',
          response_type: 4,
        });
      });
      expect(getControl('approve-btn').getAttribute('data-pending')).toBe(null);

      // The deadline passing afterwards mints NOTHING.
      await act(async () => {
        vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 5);
      });
      expect(screen.queryByTestId('component-error')).toBeNull();
      expect(getControl('approve-btn').getAttribute('disabled')).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a bot message with no answer keeps the click pending, then shows the Dismiss-only "didn\'t confirm" notice', async () => {
    vi.useFakeTimers();
    try {
      const message = makeMessage({ components: APPROVE_ROW });
      seedStore(message);
      renderItem(message);
      await act(async () => {
        fireEvent.click(getControl('approve-btn'));
      });
      await flush();

      // The bot acted and posted, but never acknowledged the click.
      act(() => landBotReply('running it now'));
      expect(getControl('approve-btn').getAttribute('data-pending')).toBe('true');

      await act(async () => {
        vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 2);
      });
      expect(screen.getByTestId('component-error-message').textContent).toContain(
        "The bot didn't confirm this click",
      );
      // No Retry: the bot may already have acted on the first click.
      expect(screen.queryByTestId('component-retry')).toBeNull();
      expect(screen.getByTestId('component-live-region').textContent).not.toBe('Your request completed');

      act(() => {
        fireEvent.click(screen.getByTestId('component-dismiss'));
      });
      expect(screen.queryByTestId('component-error')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('10s timeout: dismissable affordance with Retry, control re-enables; a late flip still renders and clears it', async () => {
    vi.useFakeTimers();
    try {
      const message = makeMessage({ components: APPROVE_ROW });
      seedStore(message);
      renderItem(message);
      await act(async () => {
        fireEvent.click(getControl('approve-btn'));
      });
      await flush();

      await act(async () => {
        vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 2);
      });
      // The affordance: role=alert, Retry + Dismiss; the control re-enabled.
      expect(screen.getByTestId('component-error').getAttribute('role')).toBe('alert');
      expect(screen.getByTestId('component-error-message').textContent).toContain('No response yet');
      expect(screen.getByTestId('component-retry')).toBeTruthy();
      expect(screen.getByTestId('component-dismiss')).toBeTruthy();
      expect(getControl('approve-btn').getAttribute('data-pending')).toBe(null);
      expect(getControl('approve-btn').getAttribute('disabled')).toBe(null);

      // Retry re-POSTs (a fresh pending + a second POST).
      await act(async () => {
        fireEvent.click(screen.getByTestId('component-retry'));
      });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(getControl('approve-btn').getAttribute('data-pending')).toBe('true');

      // Neither signal again → affordance; then the LATE flip arrives: it
      // still renders through the store and the armed watch clears the
      // stale affordance.
      await act(async () => {
        vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 2);
      });
      expect(screen.queryByTestId('component-error')).toBeTruthy();
      const flipped = makeMessage({ components: RESOLVED_ROW, edited_at: '2026-09-06T12:00:09Z' });
      act(() => landFlip(flipped));
      rerenderWith(flipped);
      expect(screen.queryByTestId('component-error')).toBeNull();
      expect(screen.getByTestId('component-button').getAttribute('disabled')).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('virtualization remount: scroll-out/in keeps the control pending, the flip clears it', async () => {
    const message = makeMessage({ components: APPROVE_ROW });
    seedStore(message);
    const { unmount } = renderItem(message);
    await act(async () => {
      fireEvent.click(getControl('approve-btn'));
    });
    await flush();
    expect(getControl('approve-btn').getAttribute('data-pending')).toBe('true');

    // react-virtuoso unmounts the row…
    unmount();
    // …and remounts it later: the store-scoped pending survives.
    renderItem(message);
    expect(getControl('approve-btn').getAttribute('data-pending')).toBe('true');
    expect(getControl('approve-btn').getAttribute('disabled')).toBe('');

    const flipped = makeMessage({ components: RESOLVED_ROW, edited_at: '2026-09-06T12:00:05Z' });
    act(() => landFlip(flipped));
    rerenderWith(flipped);
    expect(screen.getByTestId('component-button').getAttribute('data-pending')).toBe(null);
  });
});

// The rerender helper needs the LAST render's rerender fn — MessageItem is
// re-rendered with new props exactly the way MessageList re-derives rows.
let lastRerender: ((ui: React.ReactElement) => void) | null = null;
function rerenderWith(message: MessageWithBots): void {
  expect(lastRerender).not.toBeNull();
  act(() => {
    lastRerender!(
      <MessageItem
        message={message}
        authorName="Roster Bot"
        authorKind={'bot' as never}
        currentUserId={ME}
        store={store}
        onToggleReaction={vi.fn()}
      />,
    );
  });
}

describe('MessageComponents — disabled states (R7/R8)', () => {
  it('offline disables controls with an explanatory title', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true, writable: true });
    renderItem(makeMessage({ components: APPROVE_ROW }));
    for (const button of screen.getAllByTestId('component-button')) {
      expect(button.getAttribute('disabled')).toBe('');
      expect(button.getAttribute('title')).toContain('offline');
    }
  });

  it('read-only viewer (no send right) → pre-disabled with an explanatory title, never enabled-buttons-that-403', () => {
    renderItem(makeMessage({ components: APPROVE_ROW }), { viewOnly: true });
    for (const button of screen.getAllByTestId('component-button')) {
      expect(button.getAttribute('disabled')).toBe('');
      expect(button.getAttribute('title')).toContain('Read-only');
    }
  });

  it('bot revoked mid-flight → the roster flip disables the remaining controls', async () => {
    const message = makeMessage({ components: APPROVE_ROW });
    seedStore(message);
    const { rerender } = renderItem(message);
    await act(async () => {
      fireEvent.click(getControl('approve-btn'));
    });
    await flush();

    // The roster loses the bot (revoked → synthesized entry gone).
    act(() => {
      rerender(
        <MessageItem
          message={message}
          authorName={undefined}
          authorKind={undefined}
          currentUserId={ME}
          store={store}
          onToggleReaction={vi.fn()}
        />,
      );
    });
    const deny = screen.getAllByTestId('component-button')[1]!;
    expect(deny.getAttribute('disabled')).toBe('');
    expect(deny.getAttribute('title')).toContain('no longer active');
  });
});

describe('MessageComponents — error copy (R7)', () => {
  it('4xx (other) → inline error + Retry; retry re-POSTs', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { key: 'message_not_found', code: 40404, message: 'gone' } }),
    );
    const message = makeMessage({ components: APPROVE_ROW });
    seedStore(message);
    renderItem(message);
    await act(async () => {
      fireEvent.click(getControl('approve-btn'));
    });
    await flush();

    expect(screen.getByTestId('component-error').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('component-error-message').textContent).toBe('gone');
    expect(screen.getByTestId('component-retry')).toBeTruthy();

    fetchMock.mockResolvedValue(jsonResponse(202, { interaction_id: '9300000000000002' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('component-retry'));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getControl('approve-btn').getAttribute('data-pending')).toBe('true');
  });

  it('403 → permission-denied copy with Dismiss ONLY (no retry)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { key: 'forbidden', code: 40303, message: 'no send right' } }),
    );
    renderItem(makeMessage({ components: APPROVE_ROW }));
    await act(async () => {
      fireEvent.click(getControl('approve-btn'));
    });
    await flush();

    expect(screen.getByTestId('component-error-message').textContent).toBe(
      "You can't interact with components in this channel.",
    );
    expect(screen.queryByTestId('component-retry')).toBeNull();
    expect(screen.getByTestId('component-dismiss')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('component-dismiss'));
    });
    expect(screen.queryByTestId('component-error')).toBeNull();
  });

  it('dead-button (410) copy renders distinctly from the 403 copy, Dismiss only', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(410, {
        error: {
          key: 'component_unavailable',
          code: 41001,
          message: 'The bot behind this component is no longer active.',
        },
      }),
    );
    renderItem(makeMessage({ components: APPROVE_ROW }));
    await act(async () => {
      fireEvent.click(getControl('approve-btn'));
    });
    await flush();

    const copy = screen.getByTestId('component-error-message').textContent;
    expect(copy).toBe('This component is no longer available.');
    expect(copy).not.toContain("can't interact");
    expect(screen.queryByTestId('component-retry')).toBeNull();
    expect(screen.getByTestId('component-dismiss')).toBeTruthy();
  });
});

describe('MessageComponents — string select (ReactionPicker contract)', () => {
  function renderSelect() {
    const message = makeMessage({ components: SELECT_ROW });
    seedStore(message);
    return renderItem(message);
  }

  it('renders the trigger with placeholder; opens with options + descriptions', () => {
    renderSelect();
    const trigger = screen.getByTestId('component-select');
    expect(trigger.getAttribute('data-custom-id')).toBe('model-pick');
    expect(trigger.textContent).toContain('Pick a model');
    expect(screen.queryByTestId('component-select-menu')).toBeNull();

    fireEvent.click(trigger);
    const menu = screen.getByTestId('component-select-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    const options = screen.getAllByTestId('component-option');
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual(['glm-5.3', 'glm-5.3-air']);
    expect(options[0]!.textContent).toContain('GLM 5.3');
    expect(options[0]!.textContent).toContain('fast'); // description
    // Opening focuses the first option.
    expect(document.activeElement?.getAttribute('data-value')).toBe('glm-5.3');
  });

  it('keyboard walkthrough: arrows move, Enter picks with exact values, focus returns to the trigger', async () => {
    renderSelect();
    fireEvent.click(screen.getByTestId('component-select'));
    const root = screen.getByTestId('component-select-root');

    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-value')).toBe('glm-5.3-air');
    fireEvent.keyDown(root, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('data-value')).toBe('glm-5.3');

    await act(async () => {
      fireEvent.keyDown(root, { key: 'Enter' });
    });
    await flush();
    expect(lastBody()).toEqual({
      channel_id: CHANNEL,
      message_id: MESSAGE_ID,
      custom_id: 'model-pick',
      component_type: 3,
      values: ['glm-5.3'],
      nonce: expect.any(String),
    });
    // Closed after pick; focus restored to the trigger; the picked label shows.
    expect(screen.queryByTestId('component-select-menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('component-select'));
    expect(screen.getByTestId('component-select').textContent).toContain('GLM 5.3');
  });

  it('Escape cancels without submitting; Tab and outside click dismiss', async () => {
    renderSelect();
    fireEvent.click(screen.getByTestId('component-select'));
    const root = screen.getByTestId('component-select-root');

    fireEvent.keyDown(root, { key: 'Escape' });
    expect(screen.queryByTestId('component-select-menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('component-select'));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('component-select'));
    fireEvent.keyDown(root, { key: 'Tab' });
    expect(screen.queryByTestId('component-select-menu')).toBeNull();

    fireEvent.click(screen.getByTestId('component-select'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('component-select-menu')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('click-pick routes through the same submit; the trigger goes pending', async () => {
    renderSelect();
    fireEvent.click(screen.getByTestId('component-select'));
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('component-option')[1]!);
    });
    await flush();
    expect(lastBody()).toMatchObject({ custom_id: 'model-pick', values: ['glm-5.3-air'] });
    const trigger = screen.getByTestId('component-select');
    expect(trigger.getAttribute('data-pending')).toBe('true');
    expect(trigger.getAttribute('disabled')).toBe('');
  });

  it('stale select submit: popover open across a row replacement → the 400 dead-control state renders, no crash', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          key: 'component_unavailable',
          code: 40001,
          message: 'That component is not available on this message.',
        },
      }),
    );
    const message = makeMessage({ components: SELECT_ROW });
    seedStore(message);
    renderItem(message);
    fireEvent.click(screen.getByTestId('component-select'));
    expect(screen.getByTestId('component-select-menu')).toBeTruthy();

    // A MessageUpdate replaces the row (new custom_id + new options) while
    // the popover is open: the menu stays mounted and re-renders.
    const replaced = makeMessage({
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: 'model-pick-v2',
              placeholder: 'Pick a model',
              options: [{ label: 'GLM 5.4', value: 'glm-5.4' }],
            },
          ],
        },
      ],
      edited_at: '2026-09-06T12:00:07Z',
    });
    act(() => landFlip(replaced));
    rerenderWith(replaced);
    expect(screen.getByTestId('component-select-menu')).toBeTruthy();
    expect(screen.getAllByTestId('component-option').map((o) => o.getAttribute('data-value'))).toEqual(['glm-5.4']);

    // The submit races the stored row → 400 component_unavailable.
    await act(async () => {
      fireEvent.click(screen.getByTestId('component-option'));
    });
    await flush();
    expect(screen.getByTestId('component-error').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('component-error-message').textContent).toBe(
      'This component is no longer available.',
    );
    expect(screen.queryByTestId('component-retry')).toBeNull();
  });
});

describe('MessageComponents — multi-select (#30)', () => {
  const MULTI_ROW = [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: 'tags',
          placeholder: 'Pick tags',
          min_values: 1,
          max_values: 2,
          options: [
            { label: 'Alpha', value: 'a' },
            { label: 'Beta', value: 'b' },
            { label: 'Gamma', value: 'c' },
          ],
        },
      ],
    },
  ];

  function renderMulti() {
    const message = makeMessage({ components: MULTI_ROW });
    seedStore(message);
    return renderItem(message);
  }

  it('renders checkbox items and a Submit row; Space/Enter toggle, Enter on Submit sends the set in OPTION order', async () => {
    renderMulti();
    fireEvent.click(screen.getByTestId('component-select'));
    const root = screen.getByTestId('component-select-root');
    const options = screen.getAllByTestId('component-option');
    expect(options.map((o) => o.getAttribute('role'))).toEqual([
      'menuitemcheckbox',
      'menuitemcheckbox',
      'menuitemcheckbox',
    ]);
    expect(options.every((o) => o.getAttribute('aria-checked') === 'false')).toBe(true);

    // Nothing picked: Submit is disabled and names the rule.
    const submit = screen.getByTestId('component-select-submit');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(submit.textContent).toContain('Choose 1–2');

    // Toggle Gamma (Space) then Alpha (Enter) — picked out of option order.
    fireEvent.keyDown(root, { key: 'ArrowUp' }); // wraps to the Submit row
    fireEvent.keyDown(root, { key: 'ArrowUp' }); // Gamma
    fireEvent.keyDown(root, { key: ' ' });
    fireEvent.keyDown(root, { key: 'ArrowDown' }); // Submit
    fireEvent.keyDown(root, { key: 'ArrowDown' }); // wraps to Alpha
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(screen.getAllByTestId('component-option').map((o) => o.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'true',
    ]);

    // A third pick past max_values does not tick.
    fireEvent.click(screen.getAllByTestId('component-option')[1]!);
    expect(screen.getAllByTestId('component-option')[1]!.getAttribute('aria-checked')).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(root, { key: 'ArrowUp' }); // Submit (focus was on Alpha)
    await act(async () => {
      fireEvent.keyDown(root, { key: 'Enter' });
    });
    await flush();
    expect(lastBody()).toEqual({
      channel_id: CHANNEL,
      message_id: MESSAGE_ID,
      custom_id: 'tags',
      component_type: 3,
      values: ['a', 'c'],
      nonce: expect.any(String),
    });
    expect(screen.queryByTestId('component-select-menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('component-select'));
    expect(screen.getByTestId('component-select').textContent).toContain('2 selected');
  });

  it('Escape throws the draft away and sends nothing', () => {
    renderMulti();
    fireEvent.click(screen.getByTestId('component-select'));
    fireEvent.click(screen.getAllByTestId('component-option')[0]!);
    fireEvent.keyDown(screen.getByTestId('component-select-root'), { key: 'Escape' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Reopened: the discarded pick is gone.
    fireEvent.click(screen.getByTestId('component-select'));
    expect(screen.getAllByTestId('component-option')[0]!.getAttribute('aria-checked')).toBe('false');
  });

  it('a single-value select keeps the plain menu (no checkboxes, no Submit row)', () => {
    const message = makeMessage({ components: SELECT_ROW });
    seedStore(message);
    renderItem(message);
    fireEvent.click(screen.getByTestId('component-select'));
    expect(screen.getAllByTestId('component-option')[0]!.getAttribute('role')).toBe('menuitem');
    expect(screen.queryByTestId('component-select-submit')).toBeNull();
  });
});

describe('MessageComponents — a modal answers the click (#30)', () => {
  it('the click claims its interaction: a modal for it queues, and the control stops being pending', async () => {
    const message = makeMessage({ components: APPROVE_ROW });
    seedStore(message);
    renderItem(message);

    await act(async () => {
      fireEvent.click(screen.getAllByTestId('component-button')[0]!);
    });
    await flush();
    expect(screen.getAllByTestId('component-button')[0]!.getAttribute('data-pending')).toBe('true');

    await act(async () => {
      receiveModal({
        interaction_id: '9300000000000001',
        application_id: BOT,
        channel_id: CHANNEL,
        custom_id: 'why',
        title: 'Why?',
        components: [
          {
            type: 1,
            components: [
              { type: 4, custom_id: 'r', style: 1, label: 'Reason', min_length: 0, max_length: 50, required: true },
            ],
          },
        ],
      });
    });

    expect(modalStore.getState().queue.map((m) => m.custom_id)).toEqual(['why']);
    expect(screen.getAllByTestId('component-button')[0]!.getAttribute('data-pending')).toBeNull();
  });

  it("a modal for someone else's interaction (another tab) never queues", async () => {
    await act(async () => {
      receiveModal({
        interaction_id: '9399999999999999',
        application_id: BOT,
        channel_id: CHANNEL,
        custom_id: 'x',
        title: 'X',
        components: [],
      });
    });
    expect(modalStore.getState().queue).toEqual([]);
  });
});

describe('MessageComponents — live region (R7 announcements)', () => {
  it('a card flip is announced politely', () => {
    const message = makeMessage({ components: APPROVE_ROW });
    seedStore(message);
    renderItem(message);
    expect(screen.getByTestId('component-live-region').textContent).toBe('');

    const flipped = makeMessage({ components: RESOLVED_ROW, edited_at: '2026-09-06T12:00:05Z' });
    rerenderWith(flipped);
    const region = screen.getByTestId('component-live-region');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('Card updated');
  });

  it('pending→resolved is announced to the clicker', async () => {
    const message = makeMessage({ components: APPROVE_ROW });
    seedStore(message);
    renderItem(message);
    await act(async () => {
      fireEvent.click(getControl('approve-btn'));
    });
    await flush();
    expect(screen.getByTestId('component-live-region').textContent).toBe('');

    const flipped = makeMessage({ components: RESOLVED_ROW, edited_at: '2026-09-06T12:00:05Z' });
    act(() => landFlip(flipped));
    rerenderWith(flipped);
    expect(screen.getByTestId('component-live-region').textContent).toBe('Your request completed');
  });

  // The owner's report (2026-10-01): after a click on a card whose bot had
  // stopped listening, the card showed "Your request completed" AND "No
  // response yet". The fallback ends pending; it is not completion.
  it('the no-response fallback is never announced as completion; a late answer is', async () => {
    vi.useFakeTimers();
    try {
      const message = makeMessage({ components: APPROVE_ROW });
      seedStore(message);
      renderItem(message);
      await act(async () => {
        fireEvent.click(getControl('approve-btn'));
      });
      await flush();

      await act(async () => {
        vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS + 2);
      });
      expect(screen.getByTestId('component-error-message').textContent).toContain('No response yet');
      expect(screen.getByTestId('component-live-region').textContent).not.toBe('Your request completed');

      // The bot answers late (a deferred update): the fallback clears and
      // completion is announced.
      act(() => {
        receiveInteractionSuccess({
          interaction_id: '9300000000000001',
          nonce: lastBody().nonce as string,
          application_id: BOT,
          channel_id: CHANNEL,
          thread_id: null,
          message_id: MESSAGE_ID,
          custom_id: 'approve-btn',
          response_type: 6,
        });
      });
      expect(screen.queryByTestId('component-error')).toBeNull();
      expect(screen.getByTestId('component-live-region').textContent).toBe('Your request completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deferred answer (no store change at all) resolves the click and the fallback never shows', async () => {
    vi.useFakeTimers();
    try {
      const message = makeMessage({ components: APPROVE_ROW });
      seedStore(message);
      renderItem(message);
      await act(async () => {
        fireEvent.click(getControl('approve-btn'));
      });
      await flush();
      expect(getControl('approve-btn').getAttribute('data-pending')).toBe('true');

      act(() => {
        receiveInteractionSuccess({
          interaction_id: '9300000000000001',
          nonce: lastBody().nonce as string,
          application_id: BOT,
          channel_id: CHANNEL,
          thread_id: null,
          message_id: MESSAGE_ID,
          custom_id: 'approve-btn',
          response_type: 6,
        });
      });
      expect(getControl('approve-btn').getAttribute('data-pending')).toBe(null);
      expect(screen.getByTestId('component-live-region').textContent).toBe('Your request completed');

      await act(async () => {
        vi.advanceTimersByTimeAsync(COMPONENT_CLICK_TIMEOUT_MS * 3);
      });
      expect(screen.queryByTestId('component-error')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MessageComponents — hit areas (UX_SPEC §6)', () => {
  it('every control and option carries a ≥40×40px hit area at mobile width', () => {
    mobileWidthState.mobile = true;
    renderItem(makeMessage({ components: [...APPROVE_ROW, ...SELECT_ROW] }));
    const buttons = screen.getAllByTestId('component-button');
    for (const button of buttons) {
      expect(button.className).toContain('h-10'); // 40px tall
      expect(button.className).toContain('min-w-10'); // 40px wide floor
    }
    fireEvent.click(screen.getByTestId('component-select'));
    for (const option of screen.getAllByTestId('component-option')) {
      expect(option.className).toContain('min-h-10'); // 40px tall floor
    }
    mobileWidthState.mobile = false;
  });
});

describe('MessageComponents — thread panel (inherited-render pin)', () => {
  it('the thread-panel parent message renders its action rows', () => {
    const parent = makeMessage({ components: APPROVE_ROW });
    const threads: UseThreads = {
      openThreadId: 'T1',
      firstUnreadId: () => null,
    openThread: () => undefined,
      closeThread: () => undefined,
      follow: async () => undefined,
      unfollow: async () => undefined,
      loadReplies: async () => undefined,
      markUnread: async () => undefined,
      leave: async () => undefined,
      archive: async () => undefined,
      replies: () => [],
      thread: () => ({
        id: 'T1',
        channel_id: CHANNEL,
        parent_message_id: MESSAGE_ID,
        name: 'approve thread',
        created_by: ME,
        archived: false,
        created_at: '2026-09-06T12:00:00Z',
      }),
      isNotified: () => false,
      unreadCount: () => 0,
      parseDeepLink: () => null,
    };
    render(
      <ThreadSidePanel
        threadId="T1"
        channelId={CHANNEL}
        store={store}
        threads={threads}
        parentMessage={parent}
      />,
    );
    const pin = screen.getByTestId('thread-parent-pin');
    expect(pin.querySelector('[data-testid="component-block"]')).toBeTruthy();
    expect(pin.querySelectorAll('[data-testid="component-button"]')).toHaveLength(2);
  });
});

describe('MessageComponents — axe (U4 DoD)', () => {
  /**
   * The fixture: an ACTIVE card (enabled buttons + link + select), a
   * RESOLVED card (pre-disabled), an OPEN select, and a PENDING control —
   * at desktop and mobile widths.
   */
  async function renderAxeFixture(): Promise<void> {
    const active = makeMessage({ id: '1000000000000001', components: [...APPROVE_ROW, ...SELECT_ROW] });
    const resolved = makeMessage({
      id: '1000000000000002',
      content: 'already handled',
      components: RESOLVED_ROW,
      created_at: '2026-09-06T11:00:00Z',
    });
    const withLink = makeMessage({
      id: '1000000000000003',
      content: 'see docs',
      created_at: '2026-09-06T10:00:00Z',
      components: [
        { type: 1, components: [{ type: 2, style: 5, label: 'Docs', url: 'https://docs.example.com/x' }] },
      ],
    });
    seedStore(active);
    const { container } = render(
      <div>
        <MessageItem message={active} authorKind={'bot' as never} currentUserId={ME} store={store} />
        <MessageItem message={resolved} authorKind={'bot' as never} currentUserId={ME} store={store} />
        <MessageItem message={withLink} authorKind={'bot' as never} currentUserId={ME} store={store} />
      </div>,
    );

    // Open the select + leave one control pending (no signals → stays pending).
    fireEvent.click(screen.getByTestId('component-select'));
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('component-button')[0]!);
    });
    await flush();
    expect(screen.getAllByTestId('component-button')[0]!.getAttribute('data-pending')).toBe('true');

    mobileWidthState.mobile = false;
    expect(await axe(container)).toHaveNoViolations();
    mobileWidthState.mobile = true;
    expect(await axe(container)).toHaveNoViolations();
    mobileWidthState.mobile = false;
  }

  it('has no axe violations at desktop AND mobile width on the full-state fixture', async () => {
    await renderAxeFixture();
  });
});
