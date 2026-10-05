/**
 * @cytale/web — ImageLightbox (#56): full-size image viewer shared by the
 * composer's staged thumbnails and sent-message attachment images (both
 * render resized previews; the lightbox is the "see the entire image"
 * clickthrough).
 *
 * Radix dialog + tokens: Esc closes, focus is trapped and restored, the
 * overlay click closes, and the image is capped to the viewport with
 * scrolling for oversized originals.
 */
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

export interface ImageLightboxProps {
  /** Full-size source (object URL pre-upload, descriptor URL after). */
  src: string;
  /** Accessible name — the filename. */
  filename: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function ImageLightbox({ src, filename, open, onOpenChange }: ImageLightboxProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Full-bleed surface: the wrapper's centering utilities are replaced
          wholesale through cn/twMerge — inset-0 flex centering, no panel
          chrome (the image IS the content, the scrim is the backdrop). */}
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/85"
        overlayTestId="image-lightbox-overlay"
        className="inset-0 top-0 left-0 w-auto translate-x-0 translate-y-0 flex flex-col items-center justify-center gap-3 rounded-none border-0 bg-transparent p-4 shadow-none focus-visible:outline-none"
        aria-label={filename}
        data-testid="image-lightbox"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{filename}</DialogTitle>
        <img
          src={src}
          alt={filename}
          className="max-h-[85vh] max-w-[92vw] rounded-md object-contain"
          data-testid="image-lightbox-img"
        />
        <div className="flex items-center gap-3">
          <span className="max-w-[70vw] truncate text-sm text-white/80" data-testid="image-lightbox-name">
            {filename}
          </span>
          <DialogClose asChild>
            <button
              type="button"
              className="min-h-9 rounded-md border border-white/30 px-3 text-sm font-medium text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              data-testid="image-lightbox-close"
            >
              Close
            </button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
