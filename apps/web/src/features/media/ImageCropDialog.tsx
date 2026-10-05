/**
 * @cytale/web — ImageCropDialog (#48): zoom/pan positioning with a live
 * mask preview and confirm/cancel, shared by the avatar and workspace-icon
 * uploaders.
 *
 * Confirm exports the CROPPED square through a canvas at a bounded
 * resolution (never upscaled, capped at 512px) as PNG; cancel discards.
 * No upload happens until confirm — the caller owns the network. Keyboard:
 * arrows pan, +/- zoom, Esc cancels (Radix), Enter confirms.
 *
 * jsdom (no canvas 2d): the export degrades to the ORIGINAL blob — real
 * browsers always take the canvas path; tests mock toBlob to pin it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

import {
  clampTransform,
  cropRect,
  exportSide,
  initialTransform,
  pan,
  zoomAtCenter,
  type CropSource,
  type CropTransform,
} from './cropMath.js';

/** Preview square side in CSS px — big enough to judge, small enough to dock. */
const VIEWPORT = 240;
/** Export cap (px) — the bounded-export half of #48's bandwidth goal. */
const MAX_EXPORT = 512;
/** Keyboard pan step (viewport px). */
const KEY_PAN = 8;

export interface ImageCropDialogProps {
  /** The picked file to position. */
  file: File;
  /** Render-shape preview mask: round for avatars, rounded square for icons. */
  mask: 'circle' | 'rounded';
  title: string;
  /** Confirm: the cropped, bounded PNG blob plus an honest filename. */
  onConfirm(blob: Blob, filename: string): void;
  /** Cancel: discard, no upload. */
  onCancel(): void;
}

export function ImageCropDialog({ file, mask, title, onConfirm, onCancel }: ImageCropDialogProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [img, setImg] = useState<CropSource | null>(null);
  const [transform, setTransform] = useState<CropTransform | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const [exporting, setExporting] = useState(false);

  // Local object URL for the picked file (no upload until confirm).
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const onImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    imgElRef.current = el;
    const src: CropSource = { width: el.naturalWidth, height: el.naturalHeight };
    setImg(src);
    setTransform(initialTransform(src, VIEWPORT));
  }, []);

  const dragStart = (e: React.PointerEvent) => {
    if (!img) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY };
  };

  const dragMove = (e: React.PointerEvent) => {
    const start = dragRef.current;
    if (!start || !img || !transform) return;
    setTransform(pan(img, VIEWPORT, transform, e.clientX - start.x, e.clientY - start.y));
    dragRef.current = { x: e.clientX, y: e.clientY };
  };

  const dragEnd = () => {
    dragRef.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!img || !transform) return;
    switch (e.key) {
      case 'ArrowLeft':
        setTransform(pan(img, VIEWPORT, transform, KEY_PAN, 0));
        break;
      case 'ArrowRight':
        setTransform(pan(img, VIEWPORT, transform, -KEY_PAN, 0));
        break;
      case 'ArrowUp':
        setTransform(pan(img, VIEWPORT, transform, 0, KEY_PAN));
        break;
      case 'ArrowDown':
        setTransform(pan(img, VIEWPORT, transform, 0, -KEY_PAN));
        break;
      case '+':
      case '=':
        setTransform(zoomAtCenter(img, VIEWPORT, transform, transform.zoom * 1.25));
        break;
      case '-':
      case '_':
        setTransform(zoomAtCenter(img, VIEWPORT, transform, transform.zoom / 1.25));
        break;
      case 'Enter':
        e.preventDefault();
        void handleConfirm();
        break;
      default:
        return;
    }
    if (e.key !== 'Enter') e.preventDefault();
  };

  const handleConfirm = useCallback(async () => {
    if (!img || !transform || !url || exporting) return;
    setExporting(true);
    try {
      const rect = cropRect(img, VIEWPORT, transform);
      const side = exportSide(rect, MAX_EXPORT);
      const source = imgElRef.current;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (source && ctx && typeof canvas.toBlob === 'function') {
        canvas.width = side;
        canvas.height = side;
        ctx.drawImage(source, rect.sx, rect.sy, rect.side, rect.side, 0, 0, side, side);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (blob) {
          const base = file.name.replace(/\.[^.]+$/, '') || 'image';
          onConfirm(blob, `${base}-crop.png`);
          return;
        }
      }
      // No canvas (jsdom) or export failure: degrade to the original bytes
      // rather than blocking the upload — the server caps still apply.
      onConfirm(file, file.name);
    } finally {
      setExporting(false);
    }
  }, [img, transform, url, file, onConfirm, exporting]);

  const maskStyle = mask === 'circle' ? 'rounded-full' : 'rounded-[24px]';
  const ready = img !== null && transform !== null;

  // Rendered image size at the current transform (for width/height attrs).
  const displayed = useMemo(() => {
    if (!img || !transform) return null;
    const s = Math.max(VIEWPORT / img.width, VIEWPORT / img.height) * transform.zoom;
    return { w: img.width * s, h: img.height * s };
  }, [img, transform]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/60"
        overlayTestId="crop-overlay"
        // The surface's own utilities ride through cn/twMerge over the
        // wrapper's baked ones; block/gap-0 neutralize the grid stack.
        className="block gap-0 left-1/2 top-1/2 z-50 w-[min(92vw,360px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        aria-label={title}
        data-testid="crop-dialog"
        onKeyDown={onKeyDown}
      >
          <DialogTitle className="text-sm font-bold uppercase tracking-wide text-text-muted">
            {title}
          </DialogTitle>

          <div
            className={`relative mx-auto mt-3 overflow-hidden border border-line ${maskStyle}`}
            data-testid="crop-viewport"
            style={{ width: VIEWPORT, height: VIEWPORT, touchAction: 'none' }}
            onPointerDown={dragStart}
            onPointerMove={dragMove}
            onPointerUp={dragEnd}
            onPointerCancel={dragEnd}
          >
            {url ? (
              <img
                src={url}
                alt=""
                onLoad={onImgLoad}
                draggable={false}
                className="absolute max-w-none select-none"
                data-testid="crop-image"
                style={
                  displayed && transform
                    ? {
                        width: displayed.w,
                        height: displayed.h,
                        left: transform.offsetX,
                        top: transform.offsetY,
                      }
                    : undefined
                }
              />
            ) : null}
          </div>

          <div className="mt-3 flex items-center gap-2" role="group" aria-label="Zoom">
            <button
              type="button"
              className="min-h-9 w-9 rounded-md border border-line bg-surface-strong text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-50"
              aria-label="Zoom out"
              data-testid="crop-zoom-out"
              disabled={!ready}
              onClick={() => ready && setTransform((t) => t && img && zoomAtCenter(img, VIEWPORT, t, t.zoom / 1.25))}
            >
              −
            </button>
            <input
              type="range"
              className="min-w-0 flex-1 accent-[var(--color-accent)]"
              aria-label="Zoom level"
              data-testid="crop-zoom"
              min={1}
              max={8}
              step={0.05}
              value={transform?.zoom ?? 1}
              disabled={!ready}
              onChange={(e) =>
                ready && setTransform((t) => t && img && zoomAtCenter(img, VIEWPORT, t, Number(e.target.value)))
              }
            />
            <button
              type="button"
              className="min-h-9 w-9 rounded-md border border-line bg-surface-strong text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-50"
              aria-label="Zoom in"
              data-testid="crop-zoom-in"
              disabled={!ready}
              onClick={() => ready && setTransform((t) => t && img && zoomAtCenter(img, VIEWPORT, t, t.zoom * 1.25))}
            >
              +
            </button>
          </div>

          <p className="mt-2 text-xs text-text-muted">
            Drag to reposition. Arrow keys pan; + and − zoom.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <button
                type="button"
                className="min-h-10 rounded-md border border-line bg-surface-strong px-4 text-sm font-medium text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                data-testid="crop-cancel"
              >
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              className="min-h-10 rounded-md bg-accent px-4 text-sm font-semibold text-text-onaccent hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="crop-confirm"
              disabled={!ready || exporting}
              onClick={() => void handleConfirm()}
            >
              {exporting ? 'Preparing…' : 'Confirm'}
            </button>
          </div>
      </DialogContent>
    </Dialog>
  );
}

export { VIEWPORT as CROP_VIEWPORT, MAX_EXPORT as CROP_MAX_EXPORT };
