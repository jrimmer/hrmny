/**
 * @cytale/web — upload intake helpers (picker, drag-drop, paste share one
 * allowlist).
 *
 * The server's upload contract lives in apps/server config.exs
 * (`allowed_mime_types`). This module is the single CLIENT-side encoding of
 * it: the file picker's accept attribute, and the drop/paste prefilter,
 * both derive from the same sets — so the picker never offers a type the
 * server would 415, and a disallowed drop/paste stages an instant error
 * chip with no network round-trip.
 *
 * Keeping this in sync with config.exs is a recorded residual (#47): a
 * server-side allowlist widening needs the same types added here or the
 * client rejects newly-allowed files.
 */

/** Mime types the server accepts for MESSAGE attachments. */
export const ALLOWED_UPLOAD_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'text/csv',
]);

/** Extension fallback for typeless blobs (pasted files, some drops). */
export const ALLOWED_UPLOAD_EXT: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.json',
]);

/** File-picker accept attribute — derived, never hand-listed. */
export const ATTACH_ACCEPT: string = Array.from(ALLOWED_UPLOAD_MIME).join(',') +
  ',' +
  Array.from(ALLOWED_UPLOAD_EXT).join(',');

/** Does the file pass the client-side prefilter? (Server re-validates.) */
export function uploadAllowed(file: File): boolean {
  if (file.type) return ALLOWED_UPLOAD_MIME.has(file.type);
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  return ext !== '' && ALLOWED_UPLOAD_EXT.has(ext);
}

/** Is the file an image (thumbnail-able on the staged tray)? */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
}

/** Pasted image blobs can arrive nameless — mint a stable, honest name. */
export function pastedName(file: File, seq: number): string {
  if (file.name) return file.name;
  const ext = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] ?? 'png');
  return `pasted-image-${seq}.${ext}`;
}

/** Nameless pasted blobs get an honest filename before staging. */
export function namedPasteFile(file: File, seq: number): File {
  if (file.name) return file;
  try {
    return new File([file], pastedName(file, seq), { type: file.type || 'image/png' });
  } catch {
    return file;
  }
}
