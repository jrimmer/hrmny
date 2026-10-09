/**
 * Discord's timestamp tag, `<t:UNIX>` / `<t:UNIX:STYLE>`: the parse, the
 * labels per style, the relative countdown and how often it must refresh.
 * Locale and zone are pinned (`en-US`, UTC) so the labels are exact.
 */
import { describe, expect, it } from 'vitest';

import {
  formatTimestamp,
  parseInlineMarkdown,
  previewText,
  relativeRefreshMs,
  timestampPlainText,
  type TimestampNode,
} from '../index.js';

/** 2026-10-06 23:20:00 UTC, a Tuesday. */
const AT = 1791328800;
const US = { locale: 'en-US', timeZone: 'UTC' } as const;
/** ICU puts a narrow no-break space before AM/PM; compare as plain spaces. */
const plain = (label: string) => label.replace(/\s/g, ' ');

describe('the <t:…> tag parses', () => {
  it('with a style', () => {
    expect(parseInlineMarkdown(`answer <t:${AT}:R> or not`)).toEqual([
      { type: 'text', text: 'answer ' },
      { type: 'timestamp', unix: AT, style: 'R', source: `<t:${AT}:R>` },
      { type: 'text', text: ' or not' },
    ]);
  });

  it('without one, as Discord does: date and time (f)', () => {
    expect(parseInlineMarkdown(`<t:${AT}>`)).toEqual([
      { type: 'timestamp', unix: AT, style: 'f', source: `<t:${AT}>` },
    ]);
  });

  it('before the epoch', () => {
    expect(parseInlineMarkdown('<t:-86400:D>')[0]).toMatchObject({ type: 'timestamp', unix: -86400 });
  });

  it.each([
    [`<t:${AT}:x>`, 'an unknown style'],
    ['<t:9999999999999>', 'an instant no date can hold'],
    ['<t:abc>', 'no number'],
    [`\\<t:${AT}:R>`, 'an escaped bracket'],
  ])('%s stays text (%s)', (source) => {
    expect(parseInlineMarkdown(source).every((node) => node.type === 'text')).toBe(true);
  });

  it('never inside a code span', () => {
    expect(parseInlineMarkdown(`\`<t:${AT}:R>\``)).toEqual([{ type: 'code', text: `<t:${AT}:R>` }]);
  });

  it('inside emphasis, and the span reads as the moment', () => {
    const [bold] = parseInlineMarkdown(`**<t:${AT}:t>**`);
    expect(bold).toMatchObject({ type: 'bold', children: [{ type: 'timestamp', style: 't' }] });
  });
});

describe('each style reads as Discord’s does', () => {
  it.each([
    ['t', '11:20 PM'],
    ['T', '11:20:00 PM'],
    ['d', '10/06/2026'],
    ['D', 'October 6, 2026'],
    ['f', 'October 6, 2026 at 11:20 PM'],
    ['F', 'Tuesday, October 6, 2026 at 11:20 PM'],
  ] as const)('%s → %s', (style, label) => {
    expect(plain(formatTimestamp(AT, style, US))).toBe(label);
  });

  it('in the reader’s own zone', () => {
    expect(plain(formatTimestamp(AT, 't', { locale: 'en-US', timeZone: 'America/Los_Angeles' }))).toBe('4:20 PM');
  });
});

describe('R counts toward the moment and away from it', () => {
  const at = (secondsBefore: number) => formatTimestamp(AT, 'R', { ...US, now: (AT - secondsBefore) * 1000 });

  it.each([
    [5 * 60, 'in 5 minutes'],
    [4 * 60 + 40, 'in 5 minutes'],
    [4 * 60 + 20, 'in 4 minutes'],
    [90, 'in 2 minutes'],
    [45, 'in 45 seconds'],
    [1, 'in 1 second'],
    [0, 'now'],
    [-5 * 60, '5 minutes ago'],
    [59 * 60 + 50, 'in 1 hour'],
    [3 * 3600, 'in 3 hours'],
    [-26 * 3600, 'yesterday'],
    [-40 * 86400, 'last month'],
    [-3 * 365 * 86400, '3 years ago'],
  ])('%i seconds before → %s', (before, label) => {
    expect(at(before)).toBe(label);
  });

  it('refreshes every second within the hour, then less often', () => {
    const now = AT * 1000;
    expect(relativeRefreshMs(AT + 300, now)).toBe(1000);
    expect(relativeRefreshMs(AT - 300, now)).toBe(1000);
    expect(relativeRefreshMs(AT + 5 * 3600, now)).toBe(60_000);
    expect(relativeRefreshMs(AT + 3 * 86400, now)).toBe(3_600_000);
  });
});

describe('where nothing re-renders, a countdown reads as its moment', () => {
  it('plain text uses the style, except R, which reads as f', () => {
    const node = (style: TimestampNode['style']): TimestampNode => ({ type: 'timestamp', unix: AT, style, source: '' });
    expect(timestampPlainText(node('D'), US)).toBe('October 6, 2026');
    expect(plain(timestampPlainText(node('R'), US))).toBe('October 6, 2026 at 11:20 PM');
  });

  it('previews never show the tag', () => {
    expect(previewText(`answer <t:${AT}:R> or it will NOT run`)).not.toContain('<t:');
  });
});
