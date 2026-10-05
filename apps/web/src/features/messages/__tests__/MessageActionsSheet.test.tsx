/**
 * @cytale/web — MessageActionsSheet tests (U3, touch message actions).
 *
 * The long-press bottom sheet's own contract (the host wiring lives in the
 * MessageList suite, the gesture in the MessageItem suite):
 *   * the action list mirrors the hover toolbar's gating — edit for the
 *     author only, delete for the author or MANAGE_MESSAGES,
 *   * Add Reaction embeds the existing ReactionPicker (same onPick seam),
 *   * Reply routes through the same callback the hover arrow uses,
 *   * Edit / Start Thread / Delete are IN-SHEET surfaces — system
 *     window.prompt/window.confirm are never invoked at mobile,
 *   * Copy Text rides the clipboard API with visible feedback,
 *   * the sheet closes on action, scrim tap, and Escape; axe stays clean.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical';
import React, { useState } from 'react';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { REACTION_PALETTE } from '../ReactionPicker.js';
import { MessageActionsSheet, type MessageActionsSheetProps } from '../MessageActionsSheet.js';
import type { MessageWithBots } from '../types.js';

const ME = '7000000000000002';
const OTHER = '7000000000000001';
const CHANNEL = '9007199254740993';

function makeMessage(overrides: Partial<MessageWithBots> = {}): MessageWithBots {
  return {
    id: '1000000000000001',
    channel_id: CHANNEL,
    thread_id: null,
    author_id: OTHER,
    content: 'hello from a touch device',
    created_at: '2026-08-30T12:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

/** Controlled harness: the sheet starts open; closes flow through state.
 *  An explicit `open` prop overrides the internal state (lets a test force
 *  a reopen). */
function SheetHarness(
  props: Partial<MessageActionsSheetProps> & { message: MessageWithBots },
) {
  const [fallbackOpen, setFallbackOpen] = useState(true);
  const { open: openProp, onOpenChange, currentUserId = ME, message, ...rest } = props;
  const open = openProp ?? fallbackOpen;
  return (
    <MessageActionsSheet
      {...rest}
      message={message}
      currentUserId={currentUserId}
      open={open}
      onOpenChange={(o) => {
        onOpenChange?.(o);
        setFallbackOpen(o);
      }}
    />
  );
}

function renderSheet(overrides: Partial<MessageActionsSheetProps> & { message?: MessageWithBots } = {}) {
  return render(
    <SheetHarness
      message={overrides.message ?? makeMessage({ author_id: ME })}
      currentUserId={ME}
      // The full handler set by default — presence gates the action list
      // exactly the way the hover toolbar's callbacks do.
      onToggleReaction={vi.fn()}
      onReply={vi.fn()}
      onEditSubmit={vi.fn()}
      onDeleteConfirmed={vi.fn()}
      onStartThreadNamed={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  localStorage.removeItem('cytale.reaction-favorites');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem('cytale.reaction-favorites');
});

describe('MessageActionsSheet — action list (U3)', () => {
  it('lists react/reply/edit/thread/copy/delete for an OWN message', () => {
    renderSheet();
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
  });

  it("hides edit for another user's message; delete only with MANAGE_MESSAGES", () => {
    renderSheet({ message: makeMessage({ author_id: OTHER }) });
    expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
    expect(screen.queryByTestId('sheet-action-delete')).toBeNull();
    // The rest of the set stays reachable.
    expect(screen.getByTestId('sheet-action-react')).toBeTruthy();
    expect(screen.getByTestId('sheet-action-reply')).toBeTruthy();
  });

  it("shows delete (never edit) for another user's message when manage-messages is granted", () => {
    renderSheet({ message: makeMessage({ author_id: OTHER }), canManageMessages: true });
    expect(screen.queryByTestId('sheet-action-edit')).toBeNull();
    expect(screen.getByTestId('sheet-action-delete')).toBeTruthy();
  });
});

describe('MessageActionsSheet — react (embeds the hover picker)', () => {
  it('Add Reaction opens the SAME favorites grid; a pick applies and closes the sheet', () => {
    const onToggleReaction = vi.fn();
    const onOpenChange = vi.fn();
    renderSheet({
      message: makeMessage({
        author_id: ME,
        reactions: [{ emoji: '👍', count: 1, me: false }],
      }),
      onToggleReaction,
      onOpenChange,
    });
    fireEvent.click(screen.getByTestId('sheet-action-react'));
    // The existing ReactionPicker (favorites + ＋ drill-in), embedded open.
    const picker = screen.getByTestId('sheet-reaction-picker');
    expect(picker).toBeTruthy();
    const favs = screen.getAllByTestId('reaction-favorite');
    expect(favs).toHaveLength(8);
    expect(favs.map((o) => o.getAttribute('data-emoji'))).toEqual([...REACTION_PALETTE]);
    // Already-applied emojis are disabled inside — same as the hover picker.
    const applied = favs.find((o) => o.getAttribute('data-emoji') === '👍') as HTMLButtonElement;
    expect(applied.disabled).toBe(true);

    fireEvent.click(favs.find((o) => o.getAttribute('data-emoji') === '👀')!);
    expect(onToggleReaction).toHaveBeenCalledTimes(1);
    expect(onToggleReaction).toHaveBeenCalledWith('1000000000000001', '👀');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });
});

describe('MessageActionsSheet — reply', () => {
  it('Reply routes through the same callback the hover arrow uses, then closes', () => {
    const onReply = vi.fn();
    renderSheet({ onReply });
    fireEvent.click(screen.getByTestId('sheet-action-reply'));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]![0].id).toBe('1000000000000001');
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });
});

/** The Lexical editor behind a ContentEditable (Lexical tags its root). */
function lexicalOf(el: HTMLElement): LexicalEditor {
  const editor = (el as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (!editor) throw new Error('no Lexical editor on this element');
  return editor;
}

async function setEditorText(editor: LexicalEditor, text: string): Promise<void> {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    root.append($createParagraphNode().append($createTextNode(text)));
  });
  await waitFor(() =>
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(text),
  );
}

describe('MessageActionsSheet — edit (the inline Lexical editor, never window.prompt)', () => {
  it('seeds the shared editor; saving commits via onEditSubmit without window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const onEditSubmit = vi.fn();
    renderSheet({ onEditSubmit });
    fireEvent.click(screen.getByTestId('sheet-action-edit'));
    const input = screen.getByTestId('sheet-edit-input');
    // A Lexical surface (the desktop inline editor), not a textarea.
    expect(input.getAttribute('contenteditable')).toBe('true');
    await waitFor(() => expect(input.textContent).toBe('hello from a touch device'));
    expect(promptSpy).not.toHaveBeenCalled();

    await setEditorText(lexicalOf(input), 'edited by touch');
    fireEvent.click(screen.getByTestId('sheet-edit-save'));
    await waitFor(() =>
      expect(onEditSubmit).toHaveBeenCalledWith('1000000000000001', 'edited by touch'),
    );
    expect(promptSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('message-actions-sheet')).toBeNull());
  });

  it('renders mention tokens as pills, not the raw <@id> / <#id> wire text', async () => {
    renderSheet({
      onEditSubmit: vi.fn(),
      message: makeMessage({ author_id: ME, content: 'ping <@4000000000000004> about <#2000000000000002>' }),
    });
    fireEvent.click(screen.getByTestId('sheet-action-edit'));
    const input = screen.getByTestId('sheet-edit-input');
    await waitFor(() => expect(input.textContent).toContain('ping'));
    expect(input.textContent).not.toMatch(/<[@#]\d/);
  });

  it('an emptied edit cannot commit; Cancel returns to the action list', async () => {
    const onEditSubmit = vi.fn();
    renderSheet({ onEditSubmit });
    fireEvent.click(screen.getByTestId('sheet-action-edit'));
    await setEditorText(lexicalOf(screen.getByTestId('sheet-edit-input')), '   ');
    fireEvent.click(screen.getByTestId('sheet-edit-save'));
    expect(onEditSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet-edit-input')).toBeTruthy();

    fireEvent.click(screen.getByTestId('sheet-edit-cancel'));
    expect(screen.queryByTestId('sheet-edit-input')).toBeNull();
    expect(screen.getByTestId('sheet-action-reply')).toBeTruthy();
  });
});

describe('MessageActionsSheet — start thread (derived name, no title prompt)', () => {
  it('starts immediately with the seed message text as the name — no prompt, no field', () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const onStartThreadNamed = vi.fn();
    renderSheet({ onStartThreadNamed });
    fireEvent.click(screen.getByTestId('sheet-action-thread'));

    // No name field anywhere: the name is the (truncated) seed content.
    expect(screen.queryByTestId('sheet-thread-name')).toBeNull();
    expect(onStartThreadNamed).toHaveBeenCalledWith(
      '1000000000000001',
      'hello from a touch device',
    );
    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });

  it('a media-only seed still starts (deriver falls back to a generic label)', () => {
    const onStartThreadNamed = vi.fn();
    renderSheet({
      message: makeMessage({ author_id: ME, content: '' }),
      onStartThreadNamed,
    });
    fireEvent.click(screen.getByTestId('sheet-action-thread'));
    expect(onStartThreadNamed).toHaveBeenCalledWith('1000000000000001', 'Thread');
  });
});

describe('MessageActionsSheet — delete (in-sheet confirm, never window.confirm)', () => {
  it('asks in the sheet, then deletes via onDeleteConfirmed without window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onDeleteConfirmed = vi.fn();
    renderSheet({ onDeleteConfirmed });
    fireEvent.click(screen.getByTestId('sheet-action-delete'));
    expect(screen.getByTestId('sheet-delete-prompt').textContent).toMatch(/delete/i);
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sheet-delete-confirm'));
    expect(onDeleteConfirmed).toHaveBeenCalledWith('1000000000000001');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });

  it('Cancel backs out without deleting', () => {
    const onDeleteConfirmed = vi.fn();
    renderSheet({ onDeleteConfirmed });
    fireEvent.click(screen.getByTestId('sheet-action-delete'));
    fireEvent.click(screen.getByTestId('sheet-delete-cancel'));
    expect(onDeleteConfirmed).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet-action-reply')).toBeTruthy();
  });
});

describe('MessageActionsSheet — copy text', () => {
  function stubClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it('writes the message content to the clipboard, shows feedback, then dismisses', async () => {
    vi.useFakeTimers();
    try {
      const writeText = stubClipboard();
      renderSheet();
      fireEvent.click(screen.getByTestId('sheet-action-copy'));
      expect(writeText).toHaveBeenCalledWith('hello from a touch device');
      // Feedback is spoken: an aria-live region.
      const status = screen.getByTestId('sheet-copy-status');
      expect(status.textContent).toMatch(/copied/i);
      expect(status.getAttribute('aria-live')).toBe('polite');
      // The sheet dismisses after the feedback beat (close-on-action contract).
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * #114 — Copy link on the touch surface. The host builds and writes the URL
 * (MessageList's `copyLinkFor`); the sheet's job is the affordance and a
 * VISIBLE confirmation — its own row label, because the host's status pill
 * renders under this sheet's layer and the live region here is `sr-only`.
 */
describe('MessageActionsSheet — copy link (#114)', () => {
  it('is absent unless the host wires the seam', () => {
    renderSheet();
    expect(screen.queryByTestId('sheet-action-copy-link')).toBeNull();
  });

  it('hands the message to the host, confirms on its own row, then dismisses', async () => {
    vi.useFakeTimers();
    try {
      const onCopyLink = vi.fn();
      renderSheet({ onCopyLink });
      const row = screen.getByTestId('sheet-action-copy-link');
      expect(row.textContent).toContain('Copy link');

      fireEvent.click(row);
      expect(onCopyLink).toHaveBeenCalledTimes(1);
      expect(onCopyLink.mock.calls[0]![0].id).toBe('1000000000000001');
      // The row that was pressed claims the word; the other copy row does not.
      expect(screen.getByTestId('sheet-action-copy-link').textContent).toContain('Copied!');
      expect(screen.getByTestId('sheet-action-copy').textContent).toContain('Copy text');
      expect(screen.getByTestId('sheet-copy-status').textContent).toMatch(/link copied/i);

      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not offered for an optimistic placeholder (no address yet)', () => {
    renderSheet({ onCopyLink: vi.fn(), message: makeMessage({ id: 'pending_1' }) });
    expect(screen.queryByTestId('sheet-action-copy-link')).toBeNull();
  });
});

describe('MessageActionsSheet — dismissal + accessibility', () => {
  it('scrim tap closes the sheet', async () => {
    renderSheet();
    // Radix registers its outside-pointerdown listener on a macrotask —
    // flush it before the gesture (jsdom timers are real here).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(screen.getByTestId('message-actions-overlay'));
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });

  it('Escape closes the sheet', () => {
    renderSheet();
    fireEvent.keyDown(screen.getByTestId('message-actions-sheet'), { key: 'Escape' });
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });

  it('reopening for another message resets to the action list (a stale edit view never survives)', () => {
    const { rerender } = render(
      <SheetHarness
        message={makeMessage({ author_id: ME, id: '1000000000000001' })}
        currentUserId={ME}
        onEditSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('sheet-action-edit'));
    expect(screen.getByTestId('sheet-edit-input')).toBeTruthy();

    // Close, then REOPEN (forced open) for a DIFFERENT message.
    fireEvent.keyDown(screen.getByTestId('message-actions-sheet'), { key: 'Escape' });
    rerender(
      <SheetHarness
        open
        message={makeMessage({ author_id: ME, id: '1000000000000009', content: 'next one' })}
        currentUserId={ME}
        onEditSubmit={vi.fn()}
      />,
    );
    expect(screen.getByTestId('message-actions-sheet')).toBeTruthy();
    // Copy is always on the action list — its presence proves the view reset
    // (and the stale edit form is gone).
    expect(screen.getByTestId('sheet-action-copy')).toBeTruthy();
    expect(screen.queryByTestId('sheet-edit-input')).toBeNull();
  });

  it('axe: the open sheet has no violations', async () => {
    const { container } = renderSheet();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MessageActionsSheet — legacy react fallback (review #14)', () => {
  // onReact-only hosts (no onToggleReaction) take handleLegacyReact — the
  // only path for them; the picker view must never mount.
  it('Add Reaction fires onReact and closes the sheet without mounting the picker', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const onReact = vi.fn();
    const onOpenChange = vi.fn();
    renderSheet({ onToggleReaction: undefined, onReact, onOpenChange });
    const action = screen.getByTestId('sheet-action-react');
    await userEvent.click(action);
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Closed for real (harness state flows through onOpenChange) — the
    // picker view never mounted.
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull();
  });
});
