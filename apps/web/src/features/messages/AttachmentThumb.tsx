/**
 * @cytale/web — AttachmentThumb (#56): a staged image in the composer tray
 * rendered as an INLINE, bounded thumbnail (Slack-style), not a filename
 * chip.
 *
 * The preview is instant: the LOCAL object URL shows the file before any
 * upload resolves; once the upload completes, the served (immutably
 * cached) descriptor URL takes over. The thumb is deliberately resized —
 * clicking opens the shared ImageLightbox for the entire image. Object
 * URLs are revoked on removal/unmount (hygiene).
 */
import { useEffect, useState } from 'react';

import { ImageLightbox } from './ImageLightbox.js';

export interface AttachmentThumbProps {
  file: File;
  /** Descriptor URL once the upload completed (null while in flight). */
  uploadedUrl?: string | null;
  status: 'uploading' | 'done' | 'error';
  /** Inline error text once `error`. */
  error?: string;
  onRemove(): void;
}

/** The staged preview is a fixed square: `object-contain` so the WHOLE image
 *  is inside the box (cover cropped it — the owner's report, 2026-09-18). */
const THUMB = 96;

export function AttachmentThumb({ file, uploadedUrl, status, error, onRemove }: AttachmentThumbProps) {
  // Local instant preview — created once per file, revoked on unmount.
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setLocalUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Served descriptor takes over once the upload is done — the local URL
  // then dies with this component instead of living past the send.
  const src = status === 'done' && uploadedUrl ? uploadedUrl : localUrl;
  const [zoom, setZoom] = useState(false);

  return (
    <li
      className="relative shrink-0"
      data-testid="attachment-thumb"
      data-status={status}
      aria-label={`Staged image ${file.name}`}
    >
      <button
        type="button"
        className="block overflow-hidden rounded-md border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        style={{ width: THUMB, height: THUMB }}
        aria-label={`Preview ${file.name} full size`}
        data-testid="attachment-thumb-preview"
        disabled={!src}
        onClick={() => src && setZoom(true)}
        // #56 keyboard path: Enter/Space opens the lightbox (native button
        // behavior); Delete/Backspace removes the file without a mouse.
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            onRemove();
          }
        }}
      >
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full select-none object-contain"
          />
        ) : null}
      </button>

      {status === 'uploading' ? (
        <span
          className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60 text-xs font-semibold text-text"
          role="status"
          data-testid="attachment-thumb-uploading"
        >
          Uploading…
        </span>
      ) : null}

      {status === 'error' ? (
        <span
          className="absolute inset-x-0 bottom-0 truncate rounded-b-md bg-danger/85 px-1 py-0.5 text-[10px] font-semibold text-text-onaccent"
          role="alert"
          data-testid="attachment-thumb-error"
          title={error ?? 'Upload failed'}
        >
          {error ?? 'Upload failed'}
        </span>
      ) : null}

      <button
        type="button"
        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-surface-strong text-xs font-bold text-text shadow hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        aria-label={`Remove ${file.name}`}
        data-testid="attachment-thumb-remove"
        onClick={onRemove}
      >
        ✕
      </button>

      {zoom && src ? (
        <ImageLightbox
          src={src}
          filename={file.name}
          open
          onOpenChange={(open) => {
            if (!open) setZoom(false);
          }}
        />
      ) : null}
    </li>
  );
}
