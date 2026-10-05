/**
 * cropMath — pure transform math for the crop editor (#48).
 */
import { describe, expect, it } from 'vitest';

import {
  clampTransform,
  coverScale,
  cropRect,
  exportSide,
  initialTransform,
  pan,
  zoomAtCenter,
} from '../cropMath.js';

const WIDE = { width: 800, height: 400 };
const TALL = { width: 400, height: 800 };
const V = 240;

describe('cropMath — initial cover', () => {
  it('zoom 1 covers the square; the short axis centers with negative offset', () => {
    // Wide image: height 400 maps to 240 => scale .6; width 800 -> 480,
    // centered => offsetX = (240-480)/2 = -120.
    const t = initialTransform(WIDE, V);
    expect(t).toEqual({ zoom: 1, offsetX: -120, offsetY: 0 });
  });

  it('tall image mirrors on the Y axis', () => {
    const t = initialTransform(TALL, V);
    expect(t).toEqual({ zoom: 1, offsetX: 0, offsetY: -120 });
  });

  it('coverScale grows with zoom', () => {
    expect(coverScale(WIDE, V, 1)).toBeCloseTo(0.6);
    expect(coverScale(WIDE, V, 2)).toBeCloseTo(1.2);
  });
});

describe('cropMath — clamping', () => {
  it('panning past an edge stops with the image still covering', () => {
    const t0 = initialTransform(WIDE, V);
    // Dragging LEFT moves the image left; the right edge must not reveal a bar.
    const t = pan(WIDE, V, t0, -500, 0);
    expect(t.offsetX).toBe(V - 800 * coverScale(WIDE, V, t.zoom));
    expect(t.offsetX).toBeLessThanOrEqual(0);
  });

  it('zoom is bounded to [1, 8]', () => {
    const t0 = initialTransform(WIDE, V);
    expect(zoomAtCenter(WIDE, V, t0, 0.2).zoom).toBe(1);
    expect(zoomAtCenter(WIDE, V, t0, 99).zoom).toBe(8);
  });

  it('clampTransform never produces positive offsets (no left/top bar)', () => {
    const t = clampTransform(WIDE, V, { zoom: 1.5, offsetX: 100, offsetY: 100 });
    expect(t.offsetX).toBeLessThanOrEqual(0);
    expect(t.offsetY).toBeLessThanOrEqual(0);
  });
});

describe('cropMath — zoom anchoring', () => {
  it('the image point under the viewport center stays under the center', () => {
    const t0 = initialTransform(WIDE, V);
    // Center of the viewport maps to the image center at cover.
    const t1 = zoomAtCenter(WIDE, V, t0, 2);
    const before = { x: (V / 2 - t0.offsetX) / coverScale(WIDE, V, t0.zoom), y: (V / 2 - t0.offsetY) / coverScale(WIDE, V, t0.zoom) };
    const after = { x: (V / 2 - t1.offsetX) / coverScale(WIDE, V, t1.zoom), y: (V / 2 - t1.offsetY) / coverScale(WIDE, V, t1.zoom) };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});

describe('cropMath — export', () => {
  it('crop rect is the covered square in source pixels', () => {
    const t = initialTransform(WIDE, V);
    const r = cropRect(WIDE, V, t);
    // Scale .6: the 240px square is 400 source px; Y spans the full height.
    expect(r.side).toBeCloseTo(400);
    expect(r.sy).toBeCloseTo(0);
    expect(r.sx).toBeCloseTo(200); // centered horizontally
  });

  it('exportSide caps at 512 and never upscales', () => {
    expect(exportSide({ sx: 0, sy: 0, side: 4000 }, 512)).toBe(512);
    expect(exportSide({ sx: 0, sy: 0, side: 400 }, 512)).toBe(400);
    expect(exportSide({ sx: 0, sy: 0, side: 0.4 }, 512)).toBe(1);
  });
});
