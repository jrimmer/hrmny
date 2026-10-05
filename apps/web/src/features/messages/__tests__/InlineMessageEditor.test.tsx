/**
 * InlineMessageEditor — the in-row editor (2026-09-10 decision: inline, not
 * a dialog). jsdom can't drive Lexical text input, so tests seed the editor
 * through the onEditorReady seam and assert the save/cancel/keyboard
 * contract against the real Lexical wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { createStateStore } from '@cytale/state';

import { InlineMessageEditor } from '../InlineMessageEditor.js';

afterEach(cleanup);

async function setText(editor: LexicalEditor, text: string): Promise<void> {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    root.append($createParagraphNode().append($createTextNode(text)));
  });
  // Lexical's update flush is async-ish in jsdom — reading before it lands
  // sees the pre-update state (the composer suite's documented pattern).
  await waitFor(() =>
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(text),
  );
}

function renderEditor(overrides: Partial<Parameters<typeof InlineMessageEditor>[0]> = {}) {
  let editor: LexicalEditor | null = null;
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(
    <InlineMessageEditor
      initialContent="original text"
      onSave={onSave}
      onCancel={onCancel}
      onEditorReady={(e) => {
        editor = e;
      }}
      {...overrides}
    />,
  );
  return { getEditor: () => editor!, onSave, onCancel };
}

describe('InlineMessageEditor', () => {
  it('seeds the editor from the message markdown', async () => {
    const { getEditor } = renderEditor();
    await waitFor(() => expect(getEditor()).toBeTruthy());
    const text = getEditor().getEditorState().read(() => $getRoot().getTextContent());
    expect(text).toBe('original text');
  });

  it('Enter saves the edited markdown', async () => {
    const { getEditor, onSave } = renderEditor();
    await waitFor(() => expect(getEditor()).toBeTruthy());
    await setText(getEditor(), 'edited text');
    fireEvent.keyDown(screen.getByTestId('inline-edit-input'), { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('edited text'));
  });

  it('Shift+Enter does not save (newline path)', async () => {
    const { getEditor, onSave } = renderEditor();
    await waitFor(() => expect(getEditor()).toBeTruthy());
    await setText(getEditor(), 'line one');
    fireEvent.keyDown(screen.getByTestId('inline-edit-input'), { key: 'Enter', shiftKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Escape cancels without saving', async () => {
    const { getEditor, onCancel } = renderEditor();
    await waitFor(() => expect(getEditor()).toBeTruthy());
    await setText(getEditor(), 'discard me');
    fireEvent.keyDown(screen.getByTestId('inline-edit-input'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('empty content refuses to save with an inline reason', async () => {
    const { getEditor, onSave } = renderEditor();
    await waitFor(() => expect(getEditor()).toBeTruthy());
    await setText(getEditor(), '   ');
    fireEvent.click(screen.getByTestId('inline-edit-save'));
    await waitFor(() => expect(screen.getByTestId('inline-edit-error').textContent).toMatch(/cannot be empty/i));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a failed save keeps the editor open with Retry', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('network down'));
    const { getEditor } = renderEditor({ onSave: failing });
    await waitFor(() => expect(getEditor()).toBeTruthy());
    await setText(getEditor(), 'will fail');
    fireEvent.click(screen.getByTestId('inline-edit-save'));
    await waitFor(() =>
      expect(screen.getByTestId('inline-edit-error').textContent).toContain('network down'),
    );
    fireEvent.click(screen.getByTestId('inline-edit-retry'));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
  });

  it('Save/Cancel buttons carry the same actions as the keys', async () => {
    const { getEditor, onSave, onCancel } = renderEditor();
    await waitFor(() => expect(getEditor()).toBeTruthy());
    await setText(getEditor(), 'via button');
    fireEvent.click(screen.getByTestId('inline-edit-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('via button'));
    fireEvent.click(screen.getByTestId('inline-edit-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('InlineMessageEditor — the shared editor palettes (UI consistency)', () => {
  const WS = '9100000000000001';
  const CH = '9100000000000002';
  const MAX = { id: '9100000000000010', username: 'max', nickname: null };

  function paletteStore() {
    const store = createStateStore();
    store.setState({
      currentUser: { id: '9100000000000099', username: 'me' },
      channels: { [CH]: { id: CH, workspace_id: WS, name: 'general', type: 'text' } },
      membersById: { [MAX.id]: MAX },
      memberIdsByWorkspace: { [WS]: [MAX.id] },
    } as never);
    return store;
  }

  function typeAtEnd(editor: LexicalEditor, text: string) {
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const node = $createTextNode(text);
      root.append($createParagraphNode().append(node));
      node.select(text.length, text.length);
    });
  }

  it('typing @ in an edit opens the SAME member palette the composer uses; Tab inserts a mention', async () => {
    const { getEditor, onSave } = renderEditor({ store: paletteStore(), channelId: CH });
    await waitFor(() => expect(getEditor()).toBeTruthy());
    typeAtEnd(getEditor(), 'hey @ma');
    await waitFor(() => expect(screen.getByTestId('mention-autocomplete')).toBeTruthy());
    expect(screen.getByTestId('inline-edit-input').getAttribute('aria-expanded')).toBe('true');

    getEditor().dispatchCommand(KEY_TAB_COMMAND, {
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as KeyboardEvent);
    await waitFor(() => expect(screen.queryByTestId('mention-autocomplete')).toBeNull());
    fireEvent.click(screen.getByTestId('inline-edit-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(`hey <@${MAX.id}>`));
  });

  it('Enter with the palette open and nothing highlighted still SAVES (the palettes never steal Enter)', async () => {
    const { getEditor, onSave } = renderEditor({ store: paletteStore(), channelId: CH });
    await waitFor(() => expect(getEditor()).toBeTruthy());
    typeAtEnd(getEditor(), 'see #gen');
    await waitFor(() => expect(screen.getByTestId('channel-autocomplete')).toBeTruthy());
    fireEvent.keyDown(screen.getByTestId('inline-edit-input'), { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('see #gen'));
  });
});
