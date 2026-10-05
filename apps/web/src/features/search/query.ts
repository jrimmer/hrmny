/**
 * @cytale/web — search query parser (U24).
 *
 * Parses the Discord-style filter syntax from the search input into a
 * free-text keyword plus structured filters:
 *
 *   from:janet before:last week deploy
 *   in:#general after:2026-08-01
 *
 * Supported filters: `from:` (author handle), `in:` (channel), `before:`
 * and `after:` (date or relative like "last week"). Unknown `key:value`
 * tokens are treated as free-text keywords (graceful fallback per the plan's
 * "invalid filter syntax → graceful error or fallback to keyword search").
 */

export interface ParsedSearch {
  /** Free-text keyword remainder (non-filter tokens). */
  q: string;
  filters: {
    from?: string;
    in?: string;
    before?: string;
    after?: string;
  };
}

const FILTER_KEYS = new Set(['from', 'in', 'before', 'after']);

/** Normalize a channel filter value: strip a leading `#` if present. */
function normalizeChannel(value: string): string {
  return value.startsWith('#') ? value.slice(1) : value;
}

/**
 * Parse a search input string into keyword + filters. Tokens of the form
 * `key:value` where key is a known filter are extracted; everything else is
 * free-text. A bare `key:` with no value is dropped (no filter, no keyword).
 */
export function parseSearchQuery(input: string): ParsedSearch {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const filters: ParsedSearch['filters'] = {};
  const keywords: string[] = [];

  for (const token of tokens) {
    const colon = token.indexOf(':');
    if (colon > 0) {
      const key = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1);
      if (FILTER_KEYS.has(key) && value.length > 0) {
        if (key === 'in') {
          filters.in = normalizeChannel(value);
        } else {
          filters[key as 'from' | 'before' | 'after'] = value;
        }
        continue;
      }
    }
    keywords.push(token);
  }

  return { q: keywords.join(' '), filters };
}
