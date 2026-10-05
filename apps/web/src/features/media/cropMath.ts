/**
 * @cytale/web — crop-editor math (#48): pure, testable transforms shared by
 * the live preview and the export canvas.
 *
 * Model: a source image (natural w/h) is viewed through a square viewport
 * of side V. A transform {zoom, offsetX, offsetY} places the image's
 * top-left at (offsetX, offsetY) in viewport pixels; zoom 1 is the smallest
 * scale that COVERS the viewport (no empty bars). Offsets are clamped so
 * the image always covers the square entirely — the crop is whatever part
 * of the image the square reveals.
 */

export interface CropTransform {
  /** 1 = cover fit; >1 zoomed in. */
  zoom: number;
  /** Image top-left X in viewport px (<= 0). */
  offsetX: number;
  /** Image top-left Y in viewport px (<= 0). */
  offsetY: number;
}

export interface CropSource {
  width: number;
  height: number;
}

/** The scale factor mapping image px -> viewport px at the given zoom. */
export function coverScale(img: CropSource, viewport: number, zoom: number): number {
  return (Math.max(viewport / img.width, viewport / img.height)) * zoom;
}

/** Centered cover transform for a fresh image. */
export function initialTransform(img: CropSource, viewport: number): CropTransform {
  const s = coverScale(img, viewport, 1);
  return { zoom: 1, offsetX: (viewport - img.width * s) / 2, offsetY: (viewport - img.height * s) / 2 };
}

/** Keep the image covering the square: offsets stay within [V - size, 0]. */
export function clampTransform(img: CropSource, viewport: number, t: CropTransform): CropTransform {
  const s = coverScale(img, viewport, t.zoom);
  const maxX = viewport - img.width * s;
  const maxY = viewport - img.height * s;
  return {
    zoom: t.zoom,
    offsetX: Math.min(0, Math.max(maxX, t.offsetX)),
    offsetY: Math.min(0, Math.max(maxY, t.offsetY)),
  };
}

/** Pan by viewport-pixel deltas, then clamp. */
export function pan(img: CropSource, viewport: number, t: CropTransform, dx: number, dy: number): CropTransform {
  return clampTransform(img, viewport, { ...t, offsetX: t.offsetX + dx, offsetY: t.offsetY + dy });
}

/** Zoom keeping the viewport CENTER anchored on the same image point. */
export function zoomAtCenter(
  img: CropSource,
  viewport: number,
  t: CropTransform,
  nextZoom: number,
): CropTransform {
  const zoom = Math.max(1, Math.min(8, nextZoom));
  const before = coverScale(img, viewport, t.zoom);
  const after = coverScale(img, viewport, zoom);

  // Image point currently under the viewport center…
  const cx = (viewport / 2 - t.offsetX) / before;
  const cy = (viewport / 2 - t.offsetY) / before;
  // …stays under the center at the new scale.
  return clampTransform(img, viewport, {
    zoom,
    offsetX: viewport / 2 - cx * after,
    offsetY: viewport / 2 - cy * after,
  });
}

/** The square crop as a SOURCE rect in image pixels (for canvas drawImage). */
export interface CropRect {
  sx: number;
  sy: number;
  side: number;
}

export function cropRect(img: CropSource, viewport: number, t: CropTransform): CropRect {
  const s = coverScale(img, viewport, t.zoom);
  return {
    sx: -t.offsetX / s,
    sy: -t.offsetY / s,
    side: viewport / s,
  };
}

/**
 * Export size: the crop's source side capped at `max` — never upscale
 * beyond the image's own pixels, never exceed the cap.
 */
export function exportSide(rect: CropRect, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(rect.side)));
}
