/**
 * @cytale/web — clipboard write with a legacy fallback (#114).
 *
 * `navigator.clipboard` only exists in a SECURE CONTEXT. This app is
 * self-hostable and routinely served over plain `http://` on a LAN, where
 * the API is `undefined` — and a Copy Link button that silently does nothing
 * on half the deployments is the bug the ticket names. The fallback is the
 * pre-Clipboard-API path (a hidden textarea + `document.execCommand('copy')`),
 * which works in exactly those contexts; it is deprecated, which is why it is
 * the fallback and not the primary.
 *
 * The writer is injectable so callers' tests can assert the copied string
 * without touching a real clipboard.
 */

/** Write `text` to the clipboard. Resolves on success, rejects otherwise. */
export type ClipboardWriter = (text: string) => Promise<void>;

/** The real writer: Clipboard API when the context allows it, legacy copy after. */
export const systemClipboardWriter: ClipboardWriter = async (text: string) => {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    await clipboard.writeText(text);
    return;
  }
  if (!legacyCopy(text)) {
    throw new Error('clipboard unavailable');
  }
};

/**
 * Textarea + `execCommand` copy (the pre-Clipboard-API route). Returns false
 * when the document or the command is unavailable — the caller must then say
 * the copy failed rather than claim it worked.
 */
function legacyCopy(text: string): boolean {
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== 'function') return false;
  const field = doc.createElement('textarea');
  field.value = text;
  // Off-screen but focusable: `display:none` would make the selection
  // unavailable to the copy command.
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '-9999px';
  doc.body.appendChild(field);
  try {
    field.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/** Write `text` with the injectable writer (defaults to the system one). */
export async function writeClipboardText(
  text: string,
  write: ClipboardWriter = systemClipboardWriter,
): Promise<void> {
  await write(text);
}
