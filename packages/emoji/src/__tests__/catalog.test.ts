/**
 * Catalog contract tests (plan 004 M7/KTD6).
 *
 * The catalog moved out of `apps/web` unchanged; these pin the search and
 * lookup semantics both composers depend on (the `:shortcode:` autocomplete
 * is only as good as the search), plus the shared-set guarantee: the same
 * data serves web and native.
 */
import { describe, expect, it } from 'vitest';

import {
  EMOJI_CATALOG,
  canonicalShortcode,
  emojiByShortcode,
  searchEmojiCatalog,
  shortcodesFor,
} from '../catalog.js';

describe('EMOJI_CATALOG', () => {
  it('is non-empty and every entry has a character and a shortcode', () => {
    expect(EMOJI_CATALOG.length).toBeGreaterThan(100);
    for (const entry of EMOJI_CATALOG) {
      expect(entry.e.length).toBeGreaterThan(0);
      expect(entry.n).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('searchEmojiCatalog', () => {
  it('empty query returns the whole catalog in order', () => {
    const rows = searchEmojiCatalog('');
    expect(rows).toHaveLength(EMOJI_CATALOG.length);
    expect(rows[0]).toEqual({ e: EMOJI_CATALOG[0]!.e, n: EMOJI_CATALOG[0]!.n });
  });

  it('matches shortcode fragments case-insensitively', () => {
    const rows = searchEmojiCatalog('THUMB');
    expect(rows.map((r) => r.n)).toContain('thumbs_up');
    expect(rows.map((r) => r.n)).toContain('thumbs_down');
  });

  it('matches keywords, not just shortcodes (`:sho` → shock keywords)', () => {
    const rows = searchEmojiCatalog('sho');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.n)).toContain('exploding_head');
  });

  it('returns nothing for an unknown needle', () => {
    expect(searchEmojiCatalog('definitely-not-an-emoji')).toEqual([]);
  });
});

describe('emojiByShortcode', () => {
  it('resolves an exact shortcode to its character', () => {
    expect(emojiByShortcode('rocket')?.e).toBe('🚀');
    expect(emojiByShortcode('  ROCKET ')?.e).toBe('🚀');
  });

  it('returns null for an unknown shortcode', () => {
    expect(emojiByShortcode('nope')).toBeNull();
  });
});

describe('shortcodesFor', () => {
  it('returns the canonical shortcode first, then keyword aliases', () => {
    const codes = shortcodesFor('🚀');
    expect(codes[0]).toBe('rocket');
    expect(codes).toContain('ship_it');
  });

  it('returns nothing for an emoji outside the catalog', () => {
    expect(shortcodesFor('🫠')).toEqual([]);
  });
});

describe('canonicalShortcode (the picker grid’s per-cell lookup)', () => {
  it('resolves the canonical shortcode for every catalog glyph', () => {
    // Equivalence with the pre-index rule (`find(...)` → first entry wins),
    // which is what makes the O(1) index a pure performance change.
    for (const entry of EMOJI_CATALOG) {
      expect(canonicalShortcode(entry.e)).toBe(shortcodesFor(entry.e)[0]);
    }
  });

  it('keeps first-entry precedence for the catalog’s duplicated glyphs', () => {
    // 🙏 and 😱 each appear twice; the first shortcode is the one the UI has
    // always shown, so the index must not silently switch to the later one.
    expect(canonicalShortcode('🙏')).toBe('pray');
    expect(canonicalShortcode('😱')).toBe('scream');
  });

  it('returns undefined for a glyph outside the catalog', () => {
    expect(canonicalShortcode('🫠')).toBeUndefined();
  });
});
