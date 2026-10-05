/**
 * @cytale/mobile — attachment prefilter (plan 004 M7, R10).
 *
 * Mirrors the server's upload allowlist (`apps/server/config/config.exs`,
 * `:attachments`) so a blocked file is rejected BEFORE any bytes leave the
 * device, with a message the user can act on. The server stays the
 * authority; this is the fast, offline-safe first gate (the same one web's
 * composer applies).
 *
 * The mime set is exact-match on the part's content type; when the picker
 * reports no mime (common for Android content providers) the extension is
 * consulted, and only then is the file refused.
 */

/** 25 MB per-file cap — `:attachments` `max_upload_bytes`. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The server's `allowed_mime_types` (SVG is deliberately absent). */
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

/** Extension fallback for pickers that report an empty/unknown mime. */
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

/** Human-readable size (web's `formatBytes`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Why the file cannot be uploaded, or null when it passes the prefilter.
 * Size is only checked when known (see `PickedAttachment.size`).
 */
export function uploadRejection(file: {
  name: string;
  type: string;
  size: number | null;
}): string | null {
  if (file.size !== null && file.size > MAX_UPLOAD_BYTES) {
    return `File is too large — ${formatBytes(MAX_UPLOAD_BYTES)} max.`;
  }
  if (file.type) {
    return ALLOWED_UPLOAD_MIME.has(file.type) ? null : 'File type not allowed.';
  }
  const ext = extensionOf(file.name);
  return ext !== '' && ALLOWED_UPLOAD_EXT.has(ext) ? null : 'File type not allowed.';
}
