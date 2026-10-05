/**
 * @cytale/web — MessageCompose tests (U21 slice 1, bots plan U9).
 *
 * Enter sends, Shift+Enter newline, optimistic send via the messages hook,
 * view-only disabled + banner, ACCOUNT_UNVERIFIED flips the banner, draft
 * persists per channel.
 *
 * U9 composer command surface: "/" at compose-start opens the slash palette
 * (keyboard walkthrough: arrows/enter/escape through the real Lexical command
 * wiring), zero-option selection invokes immediately, optioned commands enter
 * the options-fill phase (required gate → invoke), invocation holds a bounded
 * pending affordance near the composer, the ~10s timeout lands the named
 * "no response" error with re-invoke, and the bot's response clears pending
 * by landing in the store. Normal sends stay unaffected. axe desktop + mobile.
 *
 * jsdom cannot drive Lexical text input (no `beforeinput`), so tests set
 * editor content via `editor.update()` and dispatch the Enter command
 * directly through the `onEditorReady` seam — exercising the real
 * Enter→send wiring without a live browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isElementNode,
  $isTextNode,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  KEY_ENTER_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  BLUR_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { $exportComposerMarkdown, $importComposerMarkdown } from '../composerMarkdown.js';
import type { ApplicationCommand } from '@cytale/api-client';
import { applyGatewayEvent, createStateStore, type StateStore } from '@cytale/state';

import { api, authStore } from '../../auth/session.js';
import { mobileWidthState } from '../../../test/setup.js';
import type { CommandsState, UseCommands, UseInteraction } from '../../commands/index.js';
import { INTERACTION_TIMEOUT_MS } from '../../commands/index.js';
import { MessageCompose } from '../MessageCompose.js';
import type { UseMessages } from '../useMessages.js';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const CHANNEL = '9007199254740993';
const BOT_ID = '8000000000000001';

function makeMessages(overrides: Partial<UseMessages> = {}): UseMessages {
  return {
    messages: () => [],
    send: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    toggleReaction: vi.fn(async () => {}),
    reactionError: () => null,
    clearReactionError: () => {},
    currentUserId: () => '7000000000000002',
    ...overrides,
  };
}

/** Set the editor's text content (bypasses jsdom's Lexical input gap). */
function setEditorText(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const textNode = $createTextNode(text);
    root.append($createParagraphNode().append(textNode));
    // A real typist has a caret — park it at the end, the state typing leaves.
    // (#129: the mention trigger is caret-relative, so a caretless update
    // would no longer open any palette.)
    textNode.select(text.length, text.length);
  });
}

/**
 * Content `before + after` with the caret parked between them — the state
 * right after typing `before` INTO existing text `after` (start- or
 * mid-message insertion, #129).
 */
function setEditorTextWithCaret(
  editor: LexicalEditor,
  before: string,
  after: string,
): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const textNode = $createTextNode(before + after);
    root.append($createParagraphNode().append(textNode));
    textNode.select(before.length, before.length);
  });
}

/** The last paragraph's child kinds — the decorator mention carries no text. */
function mentionShape(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() => {
    const paragraph = $getRoot().getLastChild();
    if (paragraph === null || !$isElementNode(paragraph)) return [];
    return paragraph.getChildren().map((child) => {
      const kind = child.getType();
      return kind === 'text' ? `text:${child.getTextContent()}` : `node:${kind}`;
    });
  });
}

/** A minimal event payload for direct command dispatch (the handlers only
 *  preventDefault/stopPropagation). */
function keyboardEvent(): KeyboardEvent {
  return { preventDefault() {}, stopPropagation() {} } as KeyboardEvent;
}

/** Dispatch Enter (send) or Shift+Enter (newline) through the editor. */
function pressEnter(editor: LexicalEditor, shift = false): void {
  editor.dispatchCommand(KEY_ENTER_COMMAND, {
    shiftKey: shift,
    preventDefault: () => {},
  } as unknown as KeyboardEvent);
}

beforeEach(() => {
  authStore.getState().reset();
  authStore.getState().setStatus('authenticated');
  authStore.getState().setVerified(true);
  authStore.getState().setUser({
    id: '7000000000000002',
    username: 'me',
    email: 'me@example.com',
    email_verified_at: '2026-08-30T00:00:00Z',
  });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MessageCompose — view-only gate', () => {
  it('renders the verify banner when the account is unverified', () => {
    authStore.getState().setVerified(false);
    render(React.createElement(MessageCompose, { channelId: CHANNEL, messages: makeMessages() }));
    expect(screen.getByTestId('composer-banner')).toBeTruthy();
  });

  it('hides the banner when the account is verified', () => {
    render(React.createElement(MessageCompose, { channelId: CHANNEL, messages: makeMessages() }));
    expect(screen.queryByTestId('composer-banner')).toBeNull();
  });
});

  // Regression: clearing after a send used to leave the caret pointing at the
  // removed content, so the NEXT keystroke inserted as a new paragraph and the
  // fresh empty one stayed behind — a one-line message rendered two lines tall
  // (the well measured 58px → 80px in a real browser when typing straight after
  // Enter, which is the state a person is in; clicking first masked it by
  // normalising the caret).
  it('leaves the caret anchored in one empty paragraph after a send', async () => {
    const send = vi.fn(async () => {});
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages({ send }),
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    await waitFor(() => expect(editor).not.toBeNull());

    setEditorText(editor!, 'sent then continue');
    pressEnter(editor!);
    await waitFor(() => expect(send).toHaveBeenCalled());

    const shape = await waitFor(() =>
      editor!.getEditorState().read(() => {
        const root = $getRoot();
        const selection = $getSelection();
        const anchor = $isRangeSelection(selection) ? $getNodeByKey(selection.anchor.key) : null;
        return {
          paragraphs: root.getChildrenSize(),
          text: root.getTextContent(),
          // The caret's top-level element must be the paragraph that is
          // actually in the document — not a detached one.
          anchoredInDocument: anchor !== null && anchor.getTopLevelElement() === root.getFirstChild(),
        };
      }),
    );

    expect(shape.paragraphs, 'one paragraph survives the clear').toBe(1);
    expect(shape.text).toBe('');
    expect(shape.anchoredInDocument, 'the caret is re-anchored in it').toBe(true);
  });

describe('MessageCompose — typing (U23 wiring)', () => {
  it('emits a typing signal when the author puts text in the box', async () => {
    const sendTyping = vi.fn();
    const typists = vi.fn(() => []);
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        typing: { typists, sendTyping },
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    await waitFor(() => expect(editor).not.toBeNull());

    setEditorText(editor!, 'hello');
    await waitFor(() => expect(sendTyping).toHaveBeenCalledWith(CHANNEL, null));
  });

  it('shows the aggregated label above the well, on a line that only exists while typing', async () => {
    const typists = vi.fn(() => [
      { userId: '9000000000000001', lastTypedAt: 2 },
      { userId: '9000000000000002', lastTypedAt: 1 },
      { userId: '9000000000000003', lastTypedAt: 0 },
    ]);
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        typing: { typists, sendTyping: vi.fn() },
      }),
    );

    const strip = await screen.findByTestId('typing-indicator');
    // ≤2 names then "+N others" — the product rule, ids when unresolvable.
    expect(strip.textContent).toBe('9000000000000001, 9000000000000002, and +1 others are typing...');

    // The strip rides the typing LINE, the composer stack's first element — in
    // flow, so it cannot paint over the reply bar or the banners (the absolute
    // variant did; caught by rendering the composer with typists injected,
    // 2026-09-11).
    const line = screen.getByTestId('typing-line');
    expect(line.contains(strip)).toBe(true);
    const wrapper = screen.getByTestId('message-compose');
    expect(wrapper.firstElementChild).toBe(line);
    // The SIDE surround is gone (owner direction 2026-09-14) but the 12px
    // bottom gutter stays: it is what puts the well's bottom edge on the same
    // line as the user status card in the next column over.
    expect(wrapper.className ?? '').not.toContain('px-2');
    expect(wrapper.className ?? '').toContain('pb-3');
  });

  it('the typing line reserves nothing, and the pill keeps its column (stylesheet pin)', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', '..', 'app', 'theme', 'shell.css'),
      'utf8',
    );
    const line = css.slice(css.indexOf('.typing-line {'));
    const lineRule = line.slice(0, line.indexOf('}'));
    // The reservation is GONE (owner direction 2026-09-14 — "Typing-band
    // needs to go"): the line is rendered only while a typist exists, so an
    // idle channel has nothing between the timeline and the well. Both height
    // and the old 4px reservation are absent from the idle document.
    expect(lineRule).not.toContain('min-height');
    expect(lineRule).not.toContain('height:');
    // While it IS visible, the 16px inset keeps the dots in the avatar column.
    expect(lineRule).toContain('padding: 0 16px');
    // The indicator must NOT be absolutely positioned any more.
    const indicator = css.slice(css.indexOf('.typing-indicator {'));
    const rule = indicator.slice(0, indicator.indexOf('}'));
    expect(rule).not.toContain('position: absolute');
    expect(rule).not.toContain('bottom: 100%');
    // Dots sit in the avatar column (the message row's 40px gutter), so the
    // label starts at the content inset the corpus measured.
    const dots = css.slice(css.indexOf('.typing-dots {'));
    expect(dots.slice(0, dots.indexOf('}'))).toContain('width: 40px');
  });

  it('renders nothing when nobody is typing — and reserves no space either', async () => {
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        typing: { typists: () => [], sendTyping: vi.fn() },
      }),
    );
    expect(screen.queryByTestId('typing-indicator')).toBeNull();
    // The line is not in the document at all now: zero space above the well on
    // a quiet channel (owner direction 2026-09-14, replacing the always-on
    // band whose reservation was what prevented the shift).
    expect(screen.queryByTestId('typing-line')).toBeNull();
  });
});

describe('MessageCompose — send', () => {
  it('Enter sends the composed markdown through the messages hook', async () => {
    const send = vi.fn(async () => {});
    const msgs = makeMessages({ send });
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: msgs,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );

    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'hello world');
    pressEnter(editor!);

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(CHANNEL, 'hello world', null, null);
    });
  });

  // Optimistic send (2026-09-28): the RETRY of a failed or unanswered send
  // lives on the failed row (SendStatus.tsx → retrySend, same nonce), not in
  // the composer — the text has already left the box. The nonce contract
  // itself is pinned in optimisticSend.test.tsx.
  it('a timed-out send leaves the box empty: the next Enter is a NEW message, never a silent retry', async () => {
    let calls = 0;
    const send = vi.fn(async (..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('timed out') as Error & { key: string; sendNonce: string };
        err.key = 'timeout';
        err.sendNonce = 'nonce-1';
        throw err;
      }
    });
    const msgs = makeMessages({ send: send as unknown as UseMessages['send'] });
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: msgs,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    await waitFor(() => expect(editor).not.toBeNull());

    setEditorText(editor!, 'hello again');
    pressEnter(editor!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(editor!.getEditorState().read(() => $getRoot().getTextContent())).toBe(''),
    );
    // Enter on the empty box sends nothing at all.
    pressEnter(editor!);
    setEditorText(editor!, 'the next one');
    pressEnter(editor!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![1]).toBe('the next one');
    expect(send.mock.calls[1]![5]).toBeUndefined();
  });

  it('an edited message after a failure is a fresh send (lane D #22)', async () => {
    const send = vi.fn(async (..._args: unknown[]) => {
      if (send.mock.calls.length === 1) {
        const err = new Error('boom') as Error & { sendNonce: string };
        err.sendNonce = 'nonce-2';
        throw err;
      }
    });
    const msgs = makeMessages({ send: send as unknown as UseMessages['send'] });
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: msgs,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'first try');
    pressEnter(editor!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    setEditorText(editor!, 'first try, edited');
    pressEnter(editor!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![5]).toBeUndefined();
  });

  it('ACCOUNT_UNVERIFIED from send flips the verify banner', async () => {
    const msgs = makeMessages({
      send: vi.fn(async () => {
        const err = new Error('verify your email') as Error & { key: string };
        err.key = 'ACCOUNT_UNVERIFIED';
        throw err;
      }),
    });
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: msgs,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );

    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'nope');
    pressEnter(editor!);

    await waitFor(() => {
      expect(screen.getByTestId('composer-banner')).toBeTruthy();
    });
  });

  // 6.4 rename window: the post-rename lower_snake spelling flips the same banner.
  it('account_unverified (post-6.4 spelling) from send flips the verify banner', async () => {
    const msgs = makeMessages({
      send: vi.fn(async () => {
        const err = new Error('verify your email') as Error & { key: string };
        err.key = 'account_unverified';
        throw err;
      }),
    });
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: msgs,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );

    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'nope');
    pressEnter(editor!);

    await waitFor(() => {
      expect(screen.getByTestId('composer-banner')).toBeTruthy();
    });
  });

  // The failed ROW carries a send failure now (reason + Retry/Delete/Edit);
  // the composer, already cleared and possibly holding the next message,
  // shows no error for it and is never refilled.
  it('a send failure is not a composer error, and never refills the box', async () => {
    const msgs = makeMessages({
      send: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: msgs,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );

    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'x');
    pressEnter(editor!);

    await waitFor(() => expect(msgs.send).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('composer-error')).toBeNull();
    expect(editor!.getEditorState().read(() => $getRoot().getTextContent())).toBe('');
  });
});


// Tier 3 #6: drafts are keyed by the signed-in member — a shared browser
// must never show one member's unsent text in the next member's composer.
describe('MessageCompose — drafts are per member', () => {
  it("loads only the signed-in member's draft for the channel, never another member's", async () => {
    globalThis.localStorage?.setItem(`cytale.draft.7000000000000009.${CHANNEL}`, 'someone else wrote this');
    globalThis.localStorage?.setItem(`cytale.draft.${CHANNEL}`, 'legacy unscoped text');
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor).not.toBeNull();
    const text = editor!.getEditorState().read(() => $getRoot().getTextContent());
    expect(text).not.toContain('someone else');
    expect(text).not.toContain('legacy');
  });

  it("restores the member's own draft", async () => {
    globalThis.localStorage?.setItem(`cytale.draft.7000000000000002.${CHANNEL}`, 'my own unsent text');
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    await waitFor(() =>
      expect(editor!.getEditorState().read(() => $getRoot().getTextContent())).toContain('my own unsent text'),
    );
  });
});

describe('MessageCompose — drafts', () => {
  it('persists a draft per channel on change', async () => {
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );

    await waitFor(() => expect(editor).not.toBeNull());
    setEditorText(editor!, 'draft text');

    await waitFor(() => {
      expect(globalThis.localStorage?.getItem(`cytale.draft.7000000000000002.${CHANNEL}`)).toBeTruthy();
    });
  });

  // Hardening plan 7.5: the write is debounced (~300ms), and the pending
  // value is flushed by blur and by unmount. Fake timers fake ONLY
  // setTimeout/clearTimeout — Lexical commits on microtasks, and faking
  // those would stall the editor.
  const draftKey = `cytale.draft.7000000000000002.${CHANNEL}`;

  it('debounces a typing burst into ONE write, persisting the latest text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      globalThis.localStorage?.removeItem(draftKey);
      // Spy where the method LIVES. On jsdom's Storage a property set on the
      // instance becomes a stored item, so an instance spy never intercepts
      // setItem; it only worked on the plain-object shim test/setup.ts
      // installs under Node's inert global.
      const storage = globalThis.localStorage!;
      const setItem = vi.spyOn(
        Object.prototype.hasOwnProperty.call(storage, 'setItem') ? storage : Object.getPrototypeOf(storage),
        'setItem',
      );
      let editor: LexicalEditor | null = null;
      render(
        React.createElement(MessageCompose, {
          channelId: CHANNEL,
          messages: makeMessages(),
          onEditorReady: (e) => {
            editor = e;
          },
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(editor).not.toBeNull();
      // Only count writes caused by the burst below.
      setItem.mockClear();

      act(() => {
        setEditorText(editor!, 'a');
        setEditorText(editor!, 'ab');
        setEditorText(editor!, 'abc');
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Still inside the window: nothing written.
      expect(setItem).not.toHaveBeenCalled();
      expect(globalThis.localStorage?.getItem(draftKey)).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(setItem).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      // ONE write for three keystrokes, carrying the LATEST text.
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(setItem.mock.calls.at(-1)?.[0]).toBe(draftKey);
      expect(setItem.mock.calls.at(-1)?.[1]).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the pending draft immediately on blur', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      globalThis.localStorage?.removeItem(draftKey);
      let editor: LexicalEditor | null = null;
      render(
        React.createElement(MessageCompose, {
          channelId: CHANNEL,
          messages: makeMessages(),
          onEditorReady: (e) => {
            editor = e;
          },
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });

      act(() => setEditorText(editor!, 'blur me'));
      await act(async () => {
        await Promise.resolve();
      });
      // Debounced: not written before the window elapses…
      expect(globalThis.localStorage?.getItem(draftKey)).toBeNull();

      // …but blur flushes it with no timer advance at all.
      act(() => {
        editor!.dispatchCommand(BLUR_COMMAND, new FocusEvent('blur'));
      });
      expect(globalThis.localStorage?.getItem(draftKey)).toBe('blur me');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the pending draft on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      globalThis.localStorage?.removeItem(draftKey);
      let editor: LexicalEditor | null = null;
      const { unmount } = render(
        React.createElement(MessageCompose, {
          channelId: CHANNEL,
          messages: makeMessages(),
          onEditorReady: (e) => {
            editor = e;
          },
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });

      act(() => setEditorText(editor!, 'unsaved tail'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(globalThis.localStorage?.getItem(draftKey)).toBeNull();

      unmount();
      expect(globalThis.localStorage?.getItem(draftKey)).toBe('unsaved tail');
    } finally {
      vi.useRealTimers();
    }
  });

  // NOT the same path as unmount: a real tab close does not run React's effect
  // cleanup, so the pending burst is only saved because the plugin listens for
  // `pagehide`. Review finding on the first cut of 7.5 — the test above is named
  // for unmount and this is the event that actually fires on close.
  it('flushes the pending draft on pagehide (a real tab close)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      globalThis.localStorage?.removeItem(draftKey);
      let editor: LexicalEditor | null = null;
      render(
        React.createElement(MessageCompose, {
          channelId: CHANNEL,
          messages: makeMessages(),
          onEditorReady: (e) => {
            editor = e;
          },
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });

      act(() => setEditorText(editor!, 'closing tail'));
      await act(async () => {
        await Promise.resolve();
      });
      // Still inside the debounce window: nothing written yet.
      expect(globalThis.localStorage?.getItem(draftKey)).toBeNull();

      act(() => {
        globalThis.dispatchEvent(new Event('pagehide'));
      });
      expect(globalThis.localStorage?.getItem(draftKey)).toBe('closing tail');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Composer command surface (bots plan U9)
// ---------------------------------------------------------------------------

const SHRUG: ApplicationCommand = {
  id: '9100000000000001',
  application_id: BOT_ID,
  name: 'shrug',
  description: 'Appends a shrug',
  options: null,
};

const ECHO: ApplicationCommand = {
  id: '9100000000000002',
  application_id: BOT_ID,
  name: 'echo',
  description: 'Echoes text',
  options: [
    { name: 'text', description: 'What to echo', required: true },
    { name: 'decoration', description: 'Optional flair' },
  ],
};

function makeCommands(
  state: CommandsState = { status: 'ready', commands: [SHRUG, ECHO] },
): UseCommands {
  return { state, load: vi.fn(), retry: vi.fn() };
}

function makeInteraction(): UseInteraction {
  return {
    status: { kind: 'idle' },
    invoke: vi.fn(async () => {}),
    reinvoke: vi.fn(async () => {}),
    dismiss: vi.fn(),
  };
}

/** Render the composer with the U9 hooks injected and capture the editor. */
function renderCompose(
  props: Partial<Parameters<typeof MessageCompose>[0]> = {},
): { editor: () => LexicalEditor } {
  let editor: LexicalEditor | null = null;
  render(
    React.createElement(MessageCompose, {
      channelId: CHANNEL,
      messages: makeMessages(),
      commands: makeCommands(),
      interaction: makeInteraction(),
      onEditorReady: (e) => {
        editor = e;
      },
      ...props,
    }),
  );
  return { editor: () => editor! };
}

function pressKey(editor: LexicalEditor, command: Parameters<typeof editor.dispatchCommand>[0]): void {
  editor.dispatchCommand(command, {
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent);
}

describe('MessageCompose — slash palette (U9)', () => {
  it('"/" at compose-start opens the palette over the workspace commands', async () => {
    const load = vi.fn();
    const { editor } = renderCompose({
      commands: { state: { status: 'ready', commands: [SHRUG, ECHO] }, load, retry: vi.fn() },
    });

    act(() => setEditorText(editor(), '/'));
    await waitFor(() => {
      expect(screen.getByTestId('command-autocomplete')).toBeTruthy();
    });
    expect(screen.getAllByTestId('command-option')).toHaveLength(2);
    expect(load).toHaveBeenCalled(); // fetch on open

    // Combobox wiring: input exposes the popup — and NOTHING is preselected
    // (the no-autoselect rule), so aria-activedescendant is absent until an
    // arrow points at a row (owner, 2026-09-19).
    const input = screen.getByTestId('composer-input');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-haspopup')).toBe('listbox');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(
      screen.getAllByTestId('command-option').every((o) => o.getAttribute('aria-selected') === 'false'),
    ).toBe(true);
  });

  it('typing after "/" filters; normal text never opens the palette', async () => {
    const { editor } = renderCompose();

    act(() => setEditorText(editor(), '/ec'));
    await waitFor(() => {
      expect(screen.getAllByTestId('command-option')).toHaveLength(1);
    });
    expect(screen.getByTestId('command-option').getAttribute('data-command-name')).toBe('echo');

    act(() => setEditorText(editor(), 'hello there'));
    await waitFor(() => {
      expect(screen.queryByTestId('command-autocomplete')).toBeNull();
    });
  });

  it('arrows walk aria-selected; Enter invokes a zero-option command and clears the composer', async () => {
    const interaction = makeInteraction();
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({
      messages: makeMessages({ send }),
      interaction,
    });

    act(() => setEditorText(editor(), '/'));
    await waitFor(() => {
      expect(screen.getAllByTestId('command-option')).toHaveLength(2);
    });

    // From "nothing highlighted", ↓ takes the FIRST row (the wrap-from-
    // nothing rule); ↑ then wraps to the LAST (shrug).
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() => {
      expect(
        screen.getAllByTestId('command-option')[0]!.getAttribute('aria-selected'),
      ).toBe('true');
    });
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() => {
      expect(
        screen.getAllByTestId('command-option')[1]!.getAttribute('aria-selected'),
      ).toBe('true');
    });
    act(() => pressKey(editor(), KEY_ARROW_UP_COMMAND));
    await waitFor(() => {
      expect(
        screen.getAllByTestId('command-option')[0]!.getAttribute('aria-selected'),
      ).toBe('true');
    });

    // Enter invokes the row the user pointed at (shrug, back on row 0).
    act(() => pressKey(editor(), KEY_ENTER_COMMAND));

    await waitFor(() => {
      expect(interaction.invoke).toHaveBeenCalledWith(SHRUG, CHANNEL, {});
    });
    // Enter selected — it did NOT send a message.
    expect(send).not.toHaveBeenCalled();
    // Palette closed, composer cleared (text + draft).
    await waitFor(() => {
      expect(screen.queryByTestId('command-autocomplete')).toBeNull();
    });
    expect(globalThis.localStorage?.getItem(`cytale.draft.7000000000000002.${CHANNEL}`)).toBeNull();
  });

  it('Enter with no matches closes the palette without sending', async () => {
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    act(() => setEditorText(editor(), '/zzz'));
    await waitFor(() => {
      expect(screen.getByTestId('command-no-matches')).toBeTruthy();
    });

    act(() => pressKey(editor(), KEY_ENTER_COMMAND));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(CHANNEL, '/zzz', null, null);
    });
  });

  it('Escape closes the palette and typing more keeps it closed until the text leaves slash shape', async () => {
    const { editor } = renderCompose();

    act(() => setEditorText(editor(), '/ec'));
    await waitFor(() => {
      expect(screen.getByTestId('command-autocomplete')).toBeTruthy();
    });

    act(() => pressKey(editor(), KEY_ESCAPE_COMMAND));
    await waitFor(() => {
      expect(screen.queryByTestId('command-autocomplete')).toBeNull();
    });
    expect(screen.queryByTestId('composer-input')).toBeTruthy(); // composer intact

    // Still slash-shaped text — stays dismissed.
    act(() => setEditorText(editor(), '/ech'));
    await Promise.resolve();
    expect(screen.queryByTestId('command-autocomplete')).toBeNull();
  });

  it('renders the named empty state when the workspace has no commands (distinct from error)', async () => {
    const { editor } = renderCompose({
      commands: makeCommands({ status: 'ready', commands: [] }),
    });

    act(() => setEditorText(editor(), '/'));
    await waitFor(() => {
      expect(screen.getByTestId('command-empty')).toBeTruthy();
    });
    expect(screen.queryByTestId('command-error-load')).toBeNull();
  });

  it('offline: the palette states offline, loads are suppressed, invocation is disabled', async () => {
    const load = vi.fn();
    const { editor } = renderCompose({
      commands: { state: { status: 'ready', commands: [SHRUG, ECHO] }, load, retry: vi.fn() },
    });

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    act(() => setEditorText(editor(), '/'));
    await waitFor(() => {
      expect(screen.getByTestId('command-offline')).toBeTruthy();
    });
    expect(load).not.toHaveBeenCalled();

    // An options-fill opened while online goes disabled when offline strikes.
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    act(() => setEditorText(editor(), '/ec'));
    await waitFor(() => {
      expect(screen.getAllByTestId('command-option')).toHaveLength(1);
    });
    // Enter needs a pointed-at row now: ↓ highlights echo first.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    act(() => pressKey(editor(), KEY_ENTER_COMMAND));
    await waitFor(() => {
      expect(screen.getByTestId('command-options-fill')).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId('command-option-input-text'), {
      target: { value: 'hi' },
    });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(
      (screen.getByTestId('command-invoke') as HTMLButtonElement).disabled,
    ).toBe(true);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
  });
});

describe('MessageCompose — options-fill phase (U9)', () => {
  async function openFill(
    props: Partial<Parameters<typeof MessageCompose>[0]> = {},
  ): Promise<{ editor: () => LexicalEditor }> {
    const { editor } = renderCompose(props);
    act(() => setEditorText(editor(), '/ec'));
    await waitFor(() => {
      expect(screen.getAllByTestId('command-option')).toHaveLength(1);
    });
    // Enter needs a pointed-at row now: ↓ highlights echo first.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    act(() => pressKey(editor(), KEY_ENTER_COMMAND));
    await waitFor(() => {
      expect(screen.getByTestId('command-options-fill')).toBeTruthy();
    });
    expect(screen.queryByTestId('command-autocomplete')).toBeNull();
    return { editor };
  }

  it('required option empty blocks invoke; filled invokes with the option values', async () => {
    const interaction = makeInteraction();
    await openFill({ interaction });

    const run = screen.getByTestId('command-invoke') as HTMLButtonElement;
    expect(run.disabled).toBe(true); // required gate

    fireEvent.change(screen.getByTestId('command-option-input-text'), {
      target: { value: 'hello' },
    });
    fireEvent.change(screen.getByTestId('command-option-input-decoration'), {
      target: { value: '!' },
    });
    expect(run.disabled).toBe(false);

    fireEvent.click(run);
    await waitFor(() => {
      expect(interaction.invoke).toHaveBeenCalledWith(ECHO, CHANNEL, {
        text: 'hello',
        decoration: '!',
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('command-options-fill')).toBeNull();
    });
  });

  it('Enter on an option input submits when armed; Escape cancels back to normal compose', async () => {
    const interaction = makeInteraction();
    const { editor } = await openFill({ interaction });

    fireEvent.change(screen.getByTestId('command-option-input-text'), {
      target: { value: 'hi' },
    });
    fireEvent.keyDown(screen.getByTestId('command-option-input-text'), { key: 'Enter' });
    await waitFor(() => {
      expect(interaction.invoke).toHaveBeenCalledWith(ECHO, CHANNEL, { text: 'hi' });
    });

    // Cancel path: reopen the fill and escape out of it.
    act(() => setEditorText(editor(), '/ec'));
    await waitFor(() => {
      expect(screen.getAllByTestId('command-option')).toHaveLength(1);
    });
    // Enter needs a pointed-at row now: ↓ highlights echo first.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    act(() => pressKey(editor(), KEY_ENTER_COMMAND));
    await waitFor(() => {
      expect(screen.getByTestId('command-options-fill')).toBeTruthy();
    });
    fireEvent.keyDown(screen.getByTestId('command-options-fill'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('command-options-fill')).toBeNull();
    });
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('leaves normal sends untouched while the surface is closed', async () => {
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    act(() => setEditorText(editor(), 'plain message'));
    await waitFor(() => {
      expect(screen.queryByTestId('command-autocomplete')).toBeNull();
    });
    pressEnter(editor());
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(CHANNEL, 'plain message', null, null);
    });
  });
});

describe('MessageCompose — invocation lifecycle (U9, real hooks)', () => {
  let store: StateStore;
  let seq = 1_000_000;

  function landBotResponse(content: string): void {
    applyGatewayEvent(store, {
      op: 0,
      t: 'MessageCreate',
      s: ++seq,
      d: {
        id: String(1_900_000_000_000_000 + seq),
        channel_id: CHANNEL,
        thread_id: null,
        author_id: BOT_ID,
        content,
        created_at: '2026-09-04T12:00:00Z',
        edited_at: null,
      },
    } as never);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStateStore();
    store.setState({ currentUser: { id: '7000000000000002', username: 'me' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 202,
        headers: { get: () => 'application/json' },
        json: async () => ({ interaction_id: '9300000000000001' }),
      }) as unknown as Response),
    );
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /**
   * Render with the REAL useInteraction (only the commands roster is
   * injected) against the describe's store — pending/timeout/response all
   * flow through the production hook wiring.
   */
  function renderReal(
    overrides: Partial<Parameters<typeof MessageCompose>[0]> = {},
  ): { editor: () => LexicalEditor } {
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        commands: makeCommands(),
        store,
        onEditorReady: (e) => {
          editor = e;
        },
        ...overrides,
      }),
    );
    return { editor: () => editor! };
  }

  /** Open the palette and invoke `shrug` (zero options) through the real
   *  wiring. Tab completes (the no-autoselect rule's key — no highlight
   *  needed, the top match). */
  async function invokeShrug(): Promise<{ editor: () => LexicalEditor }> {
    const { editor } = renderReal();
    await act(async () => {
      setEditorText(editor(), '/');
    });
    expect(screen.getByTestId('command-autocomplete')).toBeTruthy();
    await act(async () => {
      pressKey(editor(), KEY_TAB_COMMAND);
    });
    return { editor };
  }

  it('shows a near-composer pending affordance — never an in-transcript placeholder', async () => {
    await invokeShrug();

    expect(screen.getByTestId('command-pending')).toBeTruthy();
    expect(screen.getByTestId('command-pending').getAttribute('role')).toBe('status');
    // The bot's response clears pending when it lands in the channel slice.
    act(() => landBotResponse('¯\\_(ツ)_/¯'));
    expect(screen.queryByTestId('command-pending')).toBeNull();
    // And the response itself is an ordinary message in the store.
    const items = store.getState().messagesByChannel[CHANNEL]?.items ?? [];
    expect(items.some((m) => m.content === '¯\\_(ツ)_/¯' && m.author_id === BOT_ID)).toBe(true);
  });

  it('10s without a response lands the named no-response error with re-invoke', async () => {
    await invokeShrug();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUT_MS + 10);
    });
    const alert = screen.getByTestId('command-no-response');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('/shrug');

    fireEvent.click(screen.getByTestId('command-reinvoke'));
    expect(screen.getByTestId('command-pending')).toBeTruthy();
    // The re-POST rides several microtask hops (token provider → Http) —
    // drain them before counting wire calls.
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);

    // Dismiss closes the affordance; the composer keeps working.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUT_MS + 10);
    });
    fireEvent.click(screen.getByTestId('command-dismiss'));
    expect(screen.queryByTestId('command-no-response')).toBeNull();
  });

  it('a late-arriving response after the deadline renders as a normal message — nothing to clean up', async () => {
    await invokeShrug();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUT_MS + 10);
    });
    expect(screen.getByTestId('command-no-response')).toBeTruthy();

    // The bot answers after the client deadline: the message simply lands.
    act(() => landBotResponse('sorry, slow'));
    const items = store.getState().messagesByChannel[CHANNEL]?.items ?? [];
    expect(items.some((m) => m.content === 'sorry, slow' && m.author_id === BOT_ID)).toBe(true);
    // No transcript placeholder was ever rendered by the composer.
    expect(screen.queryByTestId('command-response-placeholder')).toBeNull();
  });

  it('invocation 4xx renders an inline error with retry; normal sends still work', async () => {
    vi.mocked(globalThis.fetch)!.mockImplementation(
      async () =>
        ({
          ok: false,
          status: 403,
          headers: { get: () => 'application/json' },
          json: async () => ({
            error: { key: 'forbidden', code: 40303, message: 'no send right' },
          }),
        }) as unknown as Response,
    );

    const send = vi.fn(async () => {});
    const { editor } = renderReal({ messages: makeMessages({ send }) });
    await act(async () => {
      setEditorText(editor(), '/');
    });
    // Tab invokes the top match (Enter declines with nothing highlighted).
    await act(async () => {
      pressKey(editor(), KEY_TAB_COMMAND);
    });
    // The 403 rejection lands on a microtask — flush it before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    const alert = screen.getByTestId('command-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('command-error-message').textContent).toContain(
      "You can't run /shrug here.",
    );

    // Retry re-POSTs; recovery flips the fetch back to 202.
    vi.mocked(globalThis.fetch)!.mockImplementation(
      async () =>
        ({
          ok: true,
          status: 202,
          headers: { get: () => 'application/json' },
          json: async () => ({ interaction_id: '9300000000000009' }),
        }) as unknown as Response,
    );
    fireEvent.click(screen.getByTestId('command-retry-invoke'));
    expect(screen.getByTestId('command-pending')).toBeTruthy();

    // The composer still sends normal messages.
    act(() => setEditorText(editor(), 'still fine'));
    await act(async () => {
      pressEnter(editor());
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(CHANNEL, 'still fine', null, null);
  });
});

describe('MessageCompose — accessibility (U9)', () => {
  it('axe: zero violations desktop + mobile with the palette open and options-fill active', async () => {
    mobileWidthState.mobile = false;
    const { editor, container } = (() => {
      let editor: LexicalEditor | null = null;
      const utils = render(
        React.createElement(MessageCompose, {
          channelId: CHANNEL,
          messages: makeMessages(),
          commands: makeCommands(),
          interaction: makeInteraction(),
          onEditorReady: (e) => {
            editor = e;
          },
        }),
      );
      return { editor: () => editor!, container: utils.container };
    })();

    act(() => setEditorText(editor(), '/'));
    await waitFor(() => {
      expect(screen.getByTestId('command-autocomplete')).toBeTruthy();
    });
    expect(await axe(container)).toHaveNoViolations();

    // Filter to the optioned command so Enter opens the options-fill phase.
    act(() => setEditorText(editor(), '/ec'));
    await waitFor(() => {
      expect(screen.getAllByTestId('command-option')).toHaveLength(1);
    });
    // Enter needs a pointed-at row now: ↓ highlights echo first.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    act(() => pressKey(editor(), KEY_ENTER_COMMAND));
    await waitFor(() => {
      expect(screen.getByTestId('command-options-fill')).toBeTruthy();
    });
    expect(await axe(container)).toHaveNoViolations();

    // Mobile width walkthrough of the same two states.
    mobileWidthState.mobile = true;
    await act(async () => {
      await Promise.resolve();
    });
    expect(await axe(container)).toHaveNoViolations();
    mobileWidthState.mobile = false;
  });
});

// ---------------------------------------------------------------------------
// Composer attachment affordance (paperclip → upload → staged chips → send)
// ---------------------------------------------------------------------------

const UPLOADED = {
  id: '6000000000000001',
  filename: 'cat.png',
  content_type: 'image/png',
  size: 1024,
  url: '/attachments/6000000000000001/cat.png',
};

function makeFile(name = 'cat.png', type = 'image/png'): File {
  return new File(['bits'], name, { type });
}

/** Drive the hidden file input the paperclip opens (jsdom can't click it). */
function pickFiles(files: File[]): void {
  fireEvent.change(screen.getByTestId('composer-file-input'), {
    target: { files },
  });
}

describe('MessageCompose — attachments', () => {
  afterEach(() => {
    mobileWidthState.mobile = false;
  });

  it('the ＋ actions trigger is present; upload lives in its menu', async () => {
    renderCompose();
    const plus = screen.getByTestId('composer-plus');
    expect(plus.getAttribute('aria-label')).toBe('Add to message');
    await userEvent.setup().click(plus);
    expect(screen.getByTestId('composer-plus-menu').getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('composer-plus-upload').textContent).toContain('Upload a File');
  });

  it('picking a file stages a chip, uploads to the channel, send binds it and clears the tray', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    pickFiles([makeFile()]);
    // In-flight state renders immediately on the chip…
    expect(screen.getByTestId('attachment-thumb').getAttribute('data-status')).toBe('uploading');
    expect(screen.getByTestId('attachment-thumb-uploading')).toBeTruthy();
    // …and rides the channel the compose targets.
    await waitFor(() => {
      expect(upload).toHaveBeenCalledWith(CHANNEL, expect.any(File));
    });

    await waitFor(() => {
      expect(screen.getByTestId('attachment-thumb').getAttribute('data-status')).toBe('done');
    });

    act(() => setEditorText(editor(), 'look at this'));
    pressEnter(editor());

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(CHANNEL, 'look at this', null, null, [UPLOADED]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('attachment-thumb')).toBeNull();
    });
  });

  it('upload failure renders an inline error chip; send still works without it', async () => {
    vi.spyOn(api, 'uploadChannelAttachment').mockRejectedValue(new Error('disk full'));
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    pickFiles([makeFile()]);
    const alert = await screen.findByTestId('attachment-thumb-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('disk full');

    act(() => setEditorText(editor(), 'text only'));
    pressEnter(editor());
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(CHANNEL, 'text only', null, null);
    });
  });

  // #136: a 201 whose body carries no usable descriptor must never become a
  // done chip — an empty object is truthy, so the old filter bound it and the
  // send body carried attachments:[{}], which the server stored as a stub
  // every reader rendered as a phantom attachment. The chip errors instead
  // (producer gate) and the send filter would drop it even if it did not.
  it('an upload that resolves descriptor-less stages an error chip and never rides the send', async () => {
    for (const useless of [{}, { attachment: null }]) {
      vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(
        useless as unknown as typeof UPLOADED,
      );
      const send = vi.fn(async () => {});
      const { editor } = renderCompose({ messages: makeMessages({ send }) });

      pickFiles([makeFile()]);
      const alert = await screen.findByTestId('attachment-thumb-error');
      expect(alert.getAttribute('role')).toBe('alert');
      // The chip reports error — never done — for a descriptor-less upload.
      expect(screen.getByTestId('attachment-thumb').getAttribute('data-status')).toBe('error');

      act(() => setEditorText(editor(), 'text only'));
      pressEnter(editor());
      await waitFor(() => {
        // Four args: the send body carried NO attachments array at all.
        expect(send).toHaveBeenCalledWith(CHANNEL, 'text only', null, null);
      });

      cleanup();
    }
  });

  it('image-only send: empty content plus a finished chip sends', async () => {
    vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    pickFiles([makeFile()]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-thumb').getAttribute('data-status')).toBe('done');
    });

    pressEnter(editor()); // editor is empty
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(CHANNEL, '', null, null, [UPLOADED]);
    });
  });

  it('Enter waits out an in-flight upload instead of dropping the attachment', async () => {
    let resolveUpload: (value: typeof UPLOADED) => void = () => {};
    vi.spyOn(api, 'uploadChannelAttachment').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    pickFiles([makeFile()]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-thumb')).toBeTruthy();
    });

    act(() => setEditorText(editor(), 'with pic'));
    pressEnter(editor());
    expect(send).not.toHaveBeenCalled(); // gated on the upload, not skipped

    await act(async () => {
      resolveUpload(UPLOADED);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(CHANNEL, 'with pic', null, null, [UPLOADED]);
    });
  });

  it('a duplicate Enter during the upload wait does not double-send', async () => {
    let resolveUpload: (value: typeof UPLOADED) => void = () => {};
    vi.spyOn(api, 'uploadChannelAttachment').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    pickFiles([makeFile()]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-thumb')).toBeTruthy();
    });

    act(() => setEditorText(editor(), 'with pic'));
    pressEnter(editor());
    pressEnter(editor()); // duplicate while the first send waits on the upload

    await act(async () => {
      resolveUpload(UPLOADED);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send).toHaveBeenCalledWith(CHANNEL, 'with pic', null, null, [UPLOADED]);
  });

  // Optimistic send: the tray leaves WITH the message — a failed send keeps
  // its attachments on the failed row (and a retry resends them), so the
  // tray is free for the next message.
  it('a failed send clears the tray too: its attachments stay with the failed message', async () => {
    vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    const send = vi.fn(async () => {
      throw new Error('boom');
    });
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    pickFiles([makeFile()]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-thumb').getAttribute('data-status')).toBe('done');
    });
    act(() => setEditorText(editor(), 'with pic'));
    pressEnter(editor());

    await waitFor(() => expect(send).toHaveBeenCalledWith(CHANNEL, 'with pic', null, null, [UPLOADED]));
    await waitFor(() => expect(screen.queryByTestId('attachment-thumb')).toBeNull());
    expect(screen.queryByTestId('composer-error')).toBeNull();
  });

  it('removes a staged chip via its ✕ button', async () => {
    vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    renderCompose();

    pickFiles([makeFile()]);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-thumb')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('attachment-thumb-remove'));
    expect(screen.queryByTestId('attachment-thumb')).toBeNull();

    // The orphaned upload settles after removal — flush it inside act.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('offline disables the ＋ trigger; reconnection re-enables it', () => {
    renderCompose();
    const attach = screen.getByTestId('composer-plus') as HTMLButtonElement;
    expect(attach.disabled).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(attach.disabled).toBe(true);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(attach.disabled).toBe(false);
  });

  it('axe: zero violations desktop + mobile with staged chips', async () => {
    mobileWidthState.mobile = false;
    vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    const { container } = render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: makeMessages(),
        commands: makeCommands(),
        interaction: makeInteraction(),
      }),
    );

    pickFiles([makeFile(), makeFile('notes.txt', 'text/plain')]);
    await waitFor(() => {
      // The png stages as an inline thumbnail (#56); the txt keeps the chip.
      const thumbs = screen.getAllByTestId('attachment-thumb');
      expect(thumbs).toHaveLength(1);
      expect(thumbs[0]!.getAttribute('data-status')).toBe('done');
      const chips = screen.getAllByTestId('attachment-chip');
      expect(chips).toHaveLength(1);
      expect(chips[0]!.getAttribute('data-status')).toBe('done');
    });
    expect(screen.getAllByTestId('attachment-thumb-remove')).toHaveLength(1);
    expect(screen.getAllByTestId('attachment-chip-remove')).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();

    mobileWidthState.mobile = true;
    await act(async () => {
      await Promise.resolve();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MessageCompose — :shortcode: emoji autocomplete + picker', () => {
  it('the emoji palette never preselects; Enter declines and sends, Tab completes the top match (the unified rule)', async () => {
    const send = vi.fn(async () => {});
    const { editor } = renderCompose({ messages: makeMessages({ send }) });

    act(() => setEditorText(editor(), ':ha'));
    await waitFor(() => {
      expect(screen.getByTestId('emoji-autocomplete')).toBeTruthy();
    });
    // NOTHING is preselected (the no-autoselect rule, unified 2026-09-19).
    expect(
      screen.getAllByTestId('emoji-option').every((o) => o.getAttribute('aria-selected') === 'false'),
    ).toBe(true);

    // Enter with no highlighted row declines: the literal text SENDS (which
    // clears the composer and closes the palette with it).
    act(() => pressEnter(editor()));
    await waitFor(() => expect(send).toHaveBeenCalledWith(CHANNEL, ':ha', null, null));
    expect(send).toHaveBeenCalledTimes(1);

    // A fresh palette, still nothing highlighted: Tab completes the TOP
    // match and closes the palette without sending.
    act(() => setEditorText(editor(), ':ha'));
    await waitFor(() => {
      expect(screen.getByTestId('emoji-autocomplete')).toBeTruthy();
    });
    act(() => {
      editor().dispatchCommand(KEY_TAB_COMMAND, keyboardEvent());
    });
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a HIGHLIGHTED emoji row is what Enter inserts (arrows point, Enter acts)', async () => {
    const { editor } = renderCompose();

    act(() => setEditorText(editor(), ':ha'));
    await waitFor(() => {
      expect(screen.getByTestId('emoji-autocomplete')).toBeTruthy();
    });
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() => {
      expect(screen.getAllByTestId('emoji-option')[0]!.getAttribute('aria-selected')).toBe('true');
    });
    act(() => {
      editor().dispatchCommand(KEY_ENTER_COMMAND, keyboardEvent());
    });
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
    });
  });

  it('one char does not open the palette; non-emoji text closes it', async () => {
    const { editor } = renderCompose();

    act(() => setEditorText(editor(), ':h'));
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
    });

    act(() => setEditorText(editor(), ':hand'));
    await waitFor(() => {
      expect(screen.getByTestId('emoji-autocomplete')).toBeTruthy();
    });

    act(() => setEditorText(editor(), 'plain words'));
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
    });
  });

  it('the composer well hosts the GIF (disabled) and emoji toggle; the picker panel renders and inserts', async () => {
    const { editor } = renderCompose();

    // The GIF affordance is removed (no GIF source yet); only the emoji
    // toggle sits right of the editor.
    expect(screen.queryByTestId('composer-gif')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-emoji'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('emoji-picker-panel')).toBeTruthy();
    });
    expect(screen.getByTestId('emoji-search')).toBeTruthy();

    // Pick from the panel → inserted into the editor, frecents recorded.
    const cell = screen.getAllByTestId('emoji-cell')[0]!;
    const emoji = cell.getAttribute('data-emoji')!;
    await act(async () => {
      fireEvent.click(cell);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-picker-panel')).toBeNull();
    });
    act(() => {
      editor().read(() => {
        expect($getRoot().getTextContent()).toContain(emoji);
      });
    });
  });
});

describe('MessageCompose — the emoji picker is a Radix popover', () => {
  it('a second click on the trigger CLOSES it (no mousedown-close/click-reopen), and focus returns to the editor', async () => {
    const { editor } = renderCompose();
    const focusSpy = vi.spyOn(editor(), 'focus');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('composer-emoji'));
    await waitFor(() => expect(screen.getByTestId('emoji-picker-panel')).toBeTruthy());
    expect(screen.getByTestId('composer-emoji').getAttribute('aria-expanded')).toBe('true');

    await user.click(screen.getByTestId('composer-emoji'));
    await waitFor(() => expect(screen.queryByTestId('emoji-picker-panel')).toBeNull());
    expect(focusSpy).toHaveBeenCalled();
  });

  it('Escape closes it and returns focus to the editor', async () => {
    const { editor } = renderCompose();
    const focusSpy = vi.spyOn(editor(), 'focus');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('composer-emoji'));
    await waitFor(() => expect(screen.getByTestId('emoji-search')).toBeTruthy());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('emoji-picker-panel')).toBeNull());
    expect(focusSpy).toHaveBeenCalled();
  });
});

describe('MessageCompose — reply focus', () => {
  it('an active reply target focuses the editor (caret ready in the message line)', async () => {
    // jsdom has no real selection engine, so assert the editor.focus()
    // contract instead of document.activeElement.
    let editor: LexicalEditor | null = null;
    const base = {
      channelId: CHANNEL,
      onEditorReady: (e: LexicalEditor): void => {
        editor = e;
      },
    };
    const view = render(React.createElement(MessageCompose, base));
    await waitFor(() => expect(editor).toBeTruthy());
    const focusSpy = vi.spyOn(editor!, 'focus');

    view.rerender(
      React.createElement(MessageCompose, {
        ...base,
        replyTo: {
          messageId: '9007199254740993',
          authorId: '7000000000000002',
          authorName: 'bob',
          snippet: 'hi',
          ping: true,
        },
      }),
    );
    await waitFor(() => expect(focusSpy).toHaveBeenCalled());
  });
});

describe('MessageCompose — closed :shortcode: conversion', () => {
  it('typing the closing colon converts :thumbs_up: to the emoji immediately', async () => {
    const { editor } = renderCompose();

    act(() => setEditorText(editor(), ':thumbs_up'));
    await waitFor(() => {
      expect(screen.getByTestId('emoji-autocomplete')).toBeTruthy();
    });

    // The closing colon converts at once — palette gone, emoji in the line.
    act(() => setEditorText(editor(), ':thumbs_up:'));
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
    });
    act(() => {
      editor().read(() => {
        expect($getRoot().getTextContent()).toBe('👍');
      });
    });
  });

  it('an unknown closed shortcode stays literal text (no palette, no mangling)', async () => {
    const { editor } = renderCompose();
    act(() => setEditorText(editor(), ':notanemoji:'));
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
    });
    act(() => {
      editor().read(() => {
        expect($getRoot().getTextContent()).toBe(':notanemoji:');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Drag-drop + clipboard paste intake (startUploads seam + prefilter)
// ---------------------------------------------------------------------------

describe('MessageCompose — paste + drop intake', () => {
  it('pasting a file on the well stages it as an upload', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    renderCompose();

    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: { files: [makeFile('shot.png', 'image/png')] },
    });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('attachment-tray')).toBeTruthy();
    upload.mockRestore();
  });

  it('Enter with only a FAILED upload says so instead of silently sending nothing (owner report 2026-09-16)', async () => {
    vi.spyOn(api, 'uploadChannelAttachment').mockRejectedValue(
      new Error('413 too large'),
    );
    const send = vi.fn(async () => {});
    const msgs = makeMessages({ send });
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages: msgs,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    await waitFor(() => expect(editor).not.toBeNull());

    // A file whose upload fails.
    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: { files: [makeFile('huge.png', 'image/png')] },
    });
    // The chip (image files render as thumbs) reaches its error state.
    await waitFor(() => {
      const chip = screen.queryByTestId('attachment-thumb-error') ?? screen.queryByTestId('attachment-upload-error');
      expect(chip).toBeTruthy();
    });

    // Enter on the failed-chip-only composer: no send, an honest notice.
    pressEnter(editor!);
    await waitFor(() => expect(screen.getByTestId('composer-error').textContent).toMatch(/not ready|remove/i));
    expect(send).not.toHaveBeenCalled();
  });

  it('a FILE-LESS HTML paste (macOS screenshot clipboard) stages the data-URL image, never the editor (owner report 2026-09-16)', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    renderCompose();

    // One red pixel, as a clipboard HTML payload with NO file entry.
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === 'text/html' ? `<img src="data:image/png;base64,${pngB64}">` : '',
      },
    });

    // The data URL became a File and rode the SAME upload seam.
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]![1]).toBeInstanceOf(File);
    expect((upload.mock.calls[0]![1] as File).type).toBe('image/png');
    expect(screen.getByTestId('attachment-tray')).toBeTruthy();
    // And nothing was inserted into the message line.
    const editor = document.querySelector('[data-testid="composer-input"]');
    expect(editor?.querySelector('img')).toBeNull();
    upload.mockRestore();
  });

  it('a paste whose HTML carries a REMOTE image is left to the editor (no bogus staging)', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    renderCompose();

    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === 'text/html' ? '<img src="https://example.com/cat.png">' : '',
      },
    });

    await waitFor(() => {
      expect(screen.queryByTestId('attachment-tray')).toBeNull();
    });
    expect(upload).not.toHaveBeenCalled();
    upload.mockRestore();
  });

  it('a nameless pasted image gets an honest filename (no empty chip label)', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    renderCompose();

    const nameless = new File(['bits'], '', { type: 'image/png' });
    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: { files: [nameless] },
    });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const sent = upload.mock.calls[0]?.[1] as File;
    expect(sent.name).toMatch(/^pasted-image-\d+\.png$/);
    upload.mockRestore();
  });

  it('pasting disallowed types stages an instant error chip with no upload', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment');
    renderCompose();

    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: { files: [makeFile('evil.sh', 'application/x-sh')] },
    });

    await waitFor(() =>
      expect(screen.getByTestId('attachment-upload-error').textContent).toContain(
        'File type not allowed',
      ),
    );
    expect(upload).not.toHaveBeenCalled();
    upload.mockRestore();
  });


  it('pasting while OFFLINE no-ops: no upload, no chip, no error noise', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment');
    renderCompose();

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: { files: [makeFile('shot.png', 'image/png')] },
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(upload).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
    upload.mockRestore();

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
  });

  it('pasting multiple files stages every one of them', async () => {
    const upload = vi.spyOn(api, 'uploadChannelAttachment').mockResolvedValue(UPLOADED);
    renderCompose();

    fireEvent.paste(screen.getByTestId('composer-well'), {
      clipboardData: { files: [makeFile('a.png'), makeFile('b.png'), makeFile('c.png')] },
    });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    upload.mockRestore();
  });
});

describe('MessageCompose — mobile composer (U4)', () => {
  // jsdom has no layout engine, so the mobile geometry contract is pinned at
  // the sources (the repo's stylesheet-pin idiom) and proven geometrically by
  // e2e/mobile.spec.ts's `mobile composer (U4)` describe.

  it('the viewport meta carries interactive-widget=resizes-content (soft keyboard resizes the ICB, keeping 100dvh honest)', () => {
    const html = readFileSync(join(__dirname, '..', '..', '..', '..', 'index.html'), 'utf8');
    const meta = /<meta name="viewport" content="([^"]+)"/.exec(html);
    expect(meta, 'viewport meta present').not.toBeNull();
    const content = meta![1]!;
    expect(content).toContain('viewport-fit=cover'); // pre-existing PWA contract stays
    expect(content).toContain('interactive-widget=resizes-content');
  });

  it('stylesheet: the ≤767px block full-bleeds the composer with safe-area insets', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'src', 'app', 'theme', 'shell.css'),
      'utf8',
    );
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(mobileBlock).toContain('message-compose');
    const rule = mobileBlock.slice(mobileBlock.indexOf("[data-testid='message-compose']"));
    expect(rule).toContain('env(safe-area-inset-left)');
    expect(rule).toContain('env(safe-area-inset-right)');
    expect(rule).toContain('env(safe-area-inset-bottom)');
  });

  it('structure: the ＋ attach and emoji controls sit INSIDE the composer row container', () => {
    renderCompose();
    const row = screen.getByTestId('composer-row');
    expect(row.contains(screen.getByTestId('composer-plus'))).toBe(true);
    expect(row.contains(screen.getByTestId('composer-emoji'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `@` mention typeahead (#66 follow-up: tokenization)
// ---------------------------------------------------------------------------

describe('MessageCompose — @ mention typeahead (#66)', () => {
  const WS = 'ws-mention';

  // The shown name is the display name (#168); a nickname is per-workspace
  // and never on the shared row (#169).
  const member = (id: string, username: string, displayName: string | null = null) => ({
    id,
    username,
    display_name: displayName,
    nickname: null,
    joined_at: '2026-09-01T00:00:00Z',
    roles: [],
  });

  const MAX = member('8100000000000001', 'max');
  const MAXINE = member('8100000000000002', 'maxine');
  const ZOE = member('8100000000000003', 'zoe', 'Zoe Z');

  let store: StateStore;

  function renderMentions(): {
    editor: () => LexicalEditor;
    send: ReturnType<typeof vi.fn>;
    container: HTMLElement;
  } {
    const messages = makeMessages();
    let editor: LexicalEditor | null = null;
    const { container } = render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages,
        commands: makeCommands(),
        store,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    return {
      editor: () => editor!,
      send: messages.send as unknown as ReturnType<typeof vi.fn>,
      container,
    };
  }

  const enter = (editor: LexicalEditor) =>
    editor.dispatchCommand(KEY_ENTER_COMMAND, {
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as KeyboardEvent);

  beforeEach(() => {
    store = createStateStore();
    store.setState({
      currentUser: { id: '7000000000000002', username: 'me' },
      channels: { [CHANNEL]: { workspace_id: WS } },
      membersById: { [MAX.id]: MAX, [MAXINE.id]: MAXINE, [ZOE.id]: ZOE },
      memberIdsByWorkspace: { [WS]: [MAX.id, MAXINE.id, ZOE.id] },
    } as never);
  });

  it('the palette floats in the shared anchor above the well — never in the well\'s flow', async () => {
    const { editor } = renderMentions();

    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    // The owner's report (2026-09-28): the palette used to sit IN the well,
    // so opening it grew the composer and pushed the conversation up. It now
    // renders inside `.editor-palettes` (position: absolute, bottom: 100% —
    // pinned in popoverRecipe.test.ts), a direct child of the relative well.
    const anchor = screen.getByTestId('editor-palettes');
    expect(anchor.className).toBe('editor-palettes');
    expect(anchor.contains(screen.getByTestId('mention-autocomplete'))).toBe(true);
    expect(anchor.parentElement).toBe(screen.getByTestId('composer-well'));
    // Listbox semantics survive the move.
    const input = screen.getByTestId('composer-input');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(
      screen.getByTestId('mention-autocomplete').id,
    );
    // Closing it removes the anchor too — nothing lingers above the well.
    act(() => setEditorText(editor(), 'plain'));
    await waitFor(() => expect(screen.queryByTestId('editor-palettes')).toBeNull());
  });

  it('typing @ma opens the palette over the matching members', async () => {
    const { editor } = renderMentions();

    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    const options = screen.getAllByTestId('mention-option');
    expect(options.map((o) => o.getAttribute('data-user-id'))).toEqual([MAX.id, MAXINE.id]);
    expect(options[0]!.textContent).toContain('max');
    // NOTHING is highlighted on open (owner, 2026-09-18): the palette must not
    // select a row the user never pointed at.
    expect(options.every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  it('the palette tile shows the same initials as every other avatar surface', async () => {
    const { editor } = renderMentions();

    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    // ZOE's nickname is two-part: its first+last initials ('ZZ') differ from
    // both `slice(0,2)` ('ZO') and `slice(0,1)` ('Z') — the ONLY pin that can
    // catch a revert to either inline form (PR #132 review: a single-word
    // fixture like 'max'→'MA' is indistinguishable from slice(0,2)).
    act(() => setEditorText(editor(), '@zo'));
    await waitFor(() => expect(screen.getAllByTestId('mention-option').length).toBeGreaterThan(0));
    const zoeOption = screen.getAllByTestId('mention-option')[0]!;
    expect(zoeOption.getAttribute('data-user-id')).toBe(ZOE.id);
    expect(zoeOption.querySelector('.mention-autocomplete-avatar')!.textContent).toBe('ZZ');
  });

  it('arrow-selected member + Enter completes it, and the wire carries <@id>', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorText(editor(), 'hey @max'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    // The user points at a row first (↓ takes the first match out of "nothing
    // highlighted"); only then does Enter complete instead of send.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[0]!.getAttribute('aria-selected')).toBe('true'),
    );

    act(() => enter(editor()));

    // Enter did NOT send — it completed the picked mention (Discord's behavior).
    expect(send).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    expect(screen.getByTestId('composer-mention').textContent).toBe('@max');

    // The pill is a DECORATOR (no text of its own), so assert the paragraph
    // shape: text, the mention node, and the trailing space that stops the
    // palette reopening (markdown export trims it from the wire).
    expect(mentionShape(editor())).toEqual(['text:hey ', 'node:mention', 'text: ']);

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, 'hey <@8100000000000001>', null, null);
  });

  it('Enter with NOTHING highlighted sends the literal text — the palette does not pick', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorText(editor(), 'hey @max'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() => pressEnter(editor()));

    // No row was pointed at, so there was nothing to complete: Enter belongs
    // to the composer and the half-typed token goes out as typed (owner,
    // 2026-09-18 — "don't autoselect").
    expect(send).toHaveBeenCalledWith(CHANNEL, 'hey @max', null, null);
    expect(screen.queryByTestId('composer-mention')).toBeNull();
  });

  it('Tab completes without a highlight — the top match — and never sends', async () => {
    const { editor, send } = renderMentions();

    // 'maxi' matches only MAXINE, and Tab needs no highlight to take it: this
    // is the key the owner wants doing the populating.
    act(() => setEditorText(editor(), '@maxi'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() =>
      editor().dispatchCommand(KEY_TAB_COMMAND, {
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as KeyboardEvent),
    );

    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    expect(send).not.toHaveBeenCalled();

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, '<@8100000000000002>', null, null);
  });

  it('Tab takes the HIGHLIGHTED row, not the top (the priority half of the contract)', async () => {
    const { editor } = renderMentions();

    // '@ma' matches MAX then MAXINE. Arrow down to the SECOND row, Tab —
    // MAXINE must land, not the top match (PR #140 review: the priority was
    // half-pinned; a revert to "always top" passed).
    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    // Two downs: from nothing to row 0, then to row 1 (MAXINE).
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[1]!.getAttribute('aria-selected')).toBe('true'),
    );
    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    // The pill names the member Tab committed — MAXINE, the highlighted
    // second row, not the top match.
    expect(screen.getByTestId('composer-mention').textContent).toBe('@maxine');
  });

  it('↑ from nothing highlights the LAST row (wrap-from-nothing)', async () => {
    const { editor } = renderMentions();

    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    act(() => {
      editor().dispatchCommand(KEY_ARROW_UP_COMMAND, undefined as never);
    });
    const options = screen.getAllByTestId('mention-option');
    expect(options[options.length - 1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('arrows move the highlight out of "nothing", wrapping; Enter takes the pointed row', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    // Nothing is highlighted until an arrow says so.
    expect(
      screen
        .getAllByTestId('mention-option')
        .every((o) => o.getAttribute('aria-selected') === 'false'),
    ).toBe(true);

    // ↓ takes the FIRST match (row 0) — not row 0 plus one.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[0]!.getAttribute('aria-selected')).toBe('true'),
    );

    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[1]!.getAttribute('aria-selected')).toBe('true'),
    );

    // ↑ off the second row, ↑ again wraps forward through the first.
    act(() => pressKey(editor(), KEY_ARROW_UP_COMMAND));
    act(() => pressKey(editor(), KEY_ARROW_UP_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[1]!.getAttribute('aria-selected')).toBe('true'),
    );

    act(() => enter(editor()));
    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, '<@8100000000000002>', null, null);
  });

  it('Escape dismisses it, and Enter then SENDS (no accidental completion)', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() => pressKey(editor(), KEY_ESCAPE_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, '@ma', null, null);
  });

  it('a single match is NOT auto-populated — the palette waits, Tab commits it', async () => {
    const { editor, send } = renderMentions();

    // 'zo' matches only Zoe. The owner's earlier spec auto-populated a lone
    // match; reversed 2026-09-18 — nothing happens without a key.
    act(() => setEditorText(editor(), 'ping @zo'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    expect(screen.queryByTestId('composer-mention')).toBeNull();
    expect(mentionShape(editor())).toEqual(['text:ping @zo']);

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    expect(mentionShape(editor())).toEqual(['text:ping ', 'node:mention', 'text: ']);

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, 'ping <@8100000000000003>', null, null);
  });

  it('a bare @ lists the roster but never auto-populates; Tab completes the lone member', async () => {
    const { editor, send } = renderMentions();

    store.setState({ memberIdsByWorkspace: { [WS]: [ZOE.id] } } as never);

    act(() => setEditorText(editor(), '@'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    // Opening the palette inserts nothing: a lone member is not picked for
    // someone who typed only '@'.
    expect(screen.queryByTestId('composer-mention')).toBeNull();
    expect(mentionShape(editor())).toEqual(['text:@']);

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, '<@8100000000000003>', null, null);
  });

  it('clicking an option completes the mention (pointer parity)', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorText(editor(), '@max'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() => {
      fireEvent.mouseDown(screen.getAllByTestId('mention-option')[1]!);
    });

    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, '<@8100000000000002>', null, null);
  });

  it('no member matches → the palette says so and Enter still sends', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorText(editor(), '@nobodyhere'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete-empty')).toBeTruthy());

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, '@nobodyhere', null, null);
  });

  it('is keyboard-accessible with no axe violations while open', async () => {
    const { editor, container } = renderMentions();

    act(() => setEditorText(editor(), '@ma'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    const input = screen.getByTestId('composer-input');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('role')).toBe('combobox');
    // Nothing is highlighted on open, so nothing is announced yet.
    expect(input.getAttribute('aria-activedescendant')).toBeNull();

    // The pointed-at option is announced through the combobox, not by moving
    // focus: focus stays in the text field, as every chat app does.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toContain(MAX.id));

    expect(await axe(container)).toHaveNoViolations();
  });

  it('the pill shows the member TAG, not the display name (owner, 2026-09-27)', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorText(editor(), 'hi @zo'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    // The palette still lists the display name to pick from…
    expect(screen.getAllByTestId('mention-option')[0]!.textContent).toContain('Zoe Z');

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.getByTestId('composer-mention')).toBeTruthy());
    // …but the inserted pill is the @username handle.
    expect(screen.getByTestId('composer-mention').textContent).toBe('@zoe');

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, `hi <@${ZOE.id}>`, null, null);
  });
});

describe('MessageCompose — # channel typeahead', () => {
  const WS = 'ws-channels';
  const GENERAL = '8200000000000001';
  const GENTOO = '8200000000000002';
  const RANDOM = '8200000000000003';
  const OTHER_WS = '8200000000000004';
  const CATEGORY = '8200000000000005';

  const channel = (id: string, name: string, workspace_id: string | null, type = 'text') => ({
    id,
    name,
    workspace_id,
    type,
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-01T00:00:00Z',
  });

  let store: StateStore;

  function renderChannels(): { editor: () => LexicalEditor; send: ReturnType<typeof vi.fn> } {
    const messages = makeMessages();
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages,
        commands: makeCommands(),
        store,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    return { editor: () => editor!, send: messages.send as unknown as ReturnType<typeof vi.fn> };
  }

  beforeEach(() => {
    store = createStateStore();
    store.setState({
      currentUser: { id: '7000000000000002', username: 'me' },
      channels: {
        [CHANNEL]: channel(CHANNEL, 'here', WS),
        [GENERAL]: channel(GENERAL, 'general', WS),
        [GENTOO]: channel(GENTOO, 'gentoo', WS),
        [RANDOM]: channel(RANDOM, 'random', WS),
        [OTHER_WS]: channel(OTHER_WS, 'general-elsewhere', 'ws-other'),
        [CATEGORY]: channel(CATEGORY, 'gen-category', WS, 'category'),
      },
    } as never);
  });

  it("typing #gen lists this workspace's matching text channels — no categories, no other workspace", async () => {
    const { editor } = renderChannels();

    act(() => setEditorText(editor(), 'see #gen'));
    await waitFor(() => expect(screen.getByTestId('channel-autocomplete')).toBeTruthy());

    const ids = screen.getAllByTestId('channel-option').map((o) => o.getAttribute('data-channel-id'));
    expect(ids).toEqual([GENERAL, GENTOO]);
    expect(screen.queryByTestId('mention-autocomplete')).toBeNull();
  });

  it('Tab completes the top match: the pill shows #name and the wire carries <#id>', async () => {
    const { editor, send } = renderChannels();

    act(() => setEditorText(editor(), 'see #ran'));
    await waitFor(() => expect(screen.getByTestId('channel-autocomplete')).toBeTruthy());

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('channel-autocomplete')).toBeNull());
    expect(screen.getByTestId('composer-channel-mention').textContent).toBe('#random');
    expect(mentionShape(editor())).toEqual(['text:see ', 'node:channel-mention', 'text: ']);

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, `see <#${RANDOM}>`, null, null);
  });

  it('Enter with nothing highlighted sends the literal text', async () => {
    const { editor, send } = renderChannels();

    act(() => setEditorText(editor(), 'issue #gen'));
    await waitFor(() => expect(screen.getByTestId('channel-autocomplete')).toBeTruthy());

    act(() => pressEnter(editor()));
    expect(send).toHaveBeenCalledWith(CHANNEL, 'issue #gen', null, null);
  });

  it('a # inside a word never opens the palette', async () => {
    const { editor } = renderChannels();

    act(() => setEditorText(editor(), 'I write C#'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('channel-autocomplete')).toBeNull();
  });

  it('a <#id> token round-trips through markdown import as a channel pill', async () => {
    const { editor } = renderChannels();
    act(() => {
      editor().update(() => {
        $importComposerMarkdown(`go to <#${GENERAL}>`);
      });
    });
    expect((await screen.findByTestId('composer-channel-mention')).textContent).toBe('#general');
    const md = editor()
      .getEditorState()
      .read(() => $exportComposerMarkdown());
    expect(md).toBe(`go to <#${GENERAL}>`);
  });
});

// ---------------------------------------------------------------------------
// `@` mention ANYWHERE in the message (#129) — the trigger and the commit are
// caret-relative, not end-anchored.
// ---------------------------------------------------------------------------

describe('MessageCompose — @ mention anywhere in the message (#129)', () => {
  const WS = 'ws-mention-129';

  // The shown name is the display name (#168); a nickname is per-workspace
  // and never on the shared row (#169).
  const member = (id: string, username: string, displayName: string | null = null) => ({
    id,
    username,
    display_name: displayName,
    nickname: null,
    joined_at: '2026-09-01T00:00:00Z',
    roles: [],
  });

  const MAX = member('8100000000000001', 'max');
  const MAXINE = member('8100000000000002', 'maxine');

  let store: StateStore;

  function renderMentions(): {
    editor: () => LexicalEditor;
    send: ReturnType<typeof vi.fn>;
  } {
    const messages = makeMessages();
    let editor: LexicalEditor | null = null;
    render(
      React.createElement(MessageCompose, {
        channelId: CHANNEL,
        messages,
        commands: makeCommands(),
        store,
        onEditorReady: (e) => {
          editor = e;
        },
      }),
    );
    return {
      editor: () => editor!,
      send: messages.send as unknown as ReturnType<typeof vi.fn>,
    };
  }

  /** The wire markdown the composer would send right now. */
  const wireText = (editor: LexicalEditor): string =>
    editor.getEditorState().read(() => $exportComposerMarkdown());

  beforeEach(() => {
    store = createStateStore();
    store.setState({
      currentUser: { id: '7000000000000002', username: 'me' },
      channels: { [CHANNEL]: { workspace_id: WS } },
      membersById: { [MAX.id]: MAX, [MAXINE.id]: MAXINE },
      memberIdsByWorkspace: { [WS]: [MAX.id, MAXINE.id] },
    } as never);
  });

  it('typing @ma at the START of existing text opens the palette; Tab lands the mention there with the caret after it', async () => {
    const { editor, send } = renderMentions();

    // Owner's repro: "hello world" in progress, caret clicked back to the
    // start, `@ma` typed.
    act(() => setEditorTextWithCaret(editor(), '@ma', ' hello world'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    expect(
      screen
        .getAllByTestId('mention-option')
        .map((o) => o.getAttribute('data-user-id')),
    ).toEqual([MAX.id, MAXINE.id]);

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    // The mention sits at the START; the rest of the message follows intact.
    // (Lexical merges the inserted space into a following text node when one
    // exists, so the suffix reads with both spaces in one node.)
    expect(mentionShape(editor())).toEqual(['node:mention', 'text:  hello world']);
    expect(wireText(editor())).toBe('<@8100000000000001>  hello world');
    expect(send).not.toHaveBeenCalled();

    // The caret lands right after the trailing space, in place — not parked
    // at the end of the message.
    const caret = editor().getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return null;
      const node = sel.anchor.getNode();
      return $isTextNode(node) ? node.getTextContent().slice(0, sel.anchor.offset) : null;
    });
    expect(caret).toBe(' ');
  });

  it('typing @ma MID-TEXT (caret in an earlier sentence) opens the palette and replaces exactly the run', async () => {
    const { editor } = renderMentions();

    act(() => setEditorTextWithCaret(editor(), 'first say @ma', ' then more'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    // Only the `@ma` run became the token; both neighbours survive (the
    // trailing space merges into the following text node).
    expect(mentionShape(editor())).toEqual([
      'text:first say ',
      'node:mention',
      'text:  then more',
    ]);
    expect(wireText(editor())).toBe('first say <@8100000000000001>  then more');
  });

  it('a query split across text nodes (undo / transform split) still completes at the caret', async () => {
    const { editor } = renderMentions();

    act(() => {
      editor().update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const a = $createTextNode('hey @');
        const b = $createTextNode('ma');
        paragraph.append(a, b);
        root.append(paragraph);
        b.select(2, 2);
      });
    });
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    expect(mentionShape(editor())).toEqual(['text:hey ', 'node:mention', 'text: ']);
    // The composer carries the trailing space; handleSend trims it from the wire.
    expect(wireText(editor())).toBe('hey <@8100000000000001> ');
  });

  it('opens immediately after a line break and completes onto the new line', async () => {
    const { editor } = renderMentions();

    act(() => {
      editor().update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const query = $createTextNode('@ma');
        paragraph.append($createTextNode('first line'), $createLineBreakNode(), query);
        root.append(paragraph);
        query.select(3, 3);
      });
    });
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() => pressKey(editor(), KEY_TAB_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    // A line break in a paragraph becomes a paragraph of its own (the
    // composer's Markdown normaliser: every line can start a list), so the
    // mention completes on the new line's paragraph.
    expect(mentionShape(editor())).toEqual(['node:mention', 'text: ']);
    expect(editor().getEditorState().read(() => $getRoot().getFirstChild()?.getTextContent())).toBe('first line');
  });

  it('moving the caret away from an open @query closes the palette', async () => {
    const { editor } = renderMentions();

    act(() => setEditorTextWithCaret(editor(), '@ma', ' hello world'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    act(() => {
      editor().update(() => {
        const paragraph = $getRoot().getLastChild();
        if (paragraph !== null && $isElementNode(paragraph)) paragraph.selectEnd();
      });
    });
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
  });

  it('does NOT trigger for a space-closed token, @@, an over-length query, or an email-shaped caret', async () => {
    const { editor } = renderMentions();

    // '@' followed by a space — the token already ended.
    act(() => setEditorTextWithCaret(editor(), 'hey @max ', ''));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    // '@@' — the second @ has no word boundary before it.
    act(() => setEditorTextWithCaret(editor(), '@@', ''));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    // Over the 32-char cap.
    act(() => setEditorTextWithCaret(editor(), `@${'a'.repeat(33)}`, ''));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    // Email mid-word — the caret sits inside `me@example.com`.
    act(() => setEditorTextWithCaret(editor(), 'write to me@ex', 'ample.com'));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
  });

  it('the keyboard flow works mid-text: arrows walk, Escape dismisses, Enter then sends the literal text', async () => {
    const { editor, send } = renderMentions();

    act(() => setEditorTextWithCaret(editor(), 'first say @ma', ' then more'));
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());

    // Nothing is highlighted until an arrow says so: ↓ takes row 0, the
    // second ↓ walks to row 1.
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[0]!.getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    act(() => pressKey(editor(), KEY_ARROW_DOWN_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[1]!.getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    act(() => pressKey(editor(), KEY_ARROW_UP_COMMAND));
    act(() => pressKey(editor(), KEY_ARROW_UP_COMMAND));
    await waitFor(() =>
      expect(screen.getAllByTestId('mention-option')[1]!.getAttribute('aria-selected')).toBe(
        'true',
      ),
    );

    act(() => pressKey(editor(), KEY_ESCAPE_COMMAND));
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());

    // Palette dismissed → Enter is a SEND again, of the untouched message.
    act(() => pressEnter(editor()));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(CHANNEL, 'first say @ma then more', null, null),
    );
  });
});
