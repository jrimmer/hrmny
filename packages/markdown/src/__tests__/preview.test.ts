/**
 * previewText — the one-line plain form every preview surface shares (owner
 * report 2026-09-28: the inbox excerpt showed raw `**…**` and backticks).
 */
import { describe, expect, it } from 'vitest';

import { previewText } from '../index.js';

describe('previewText', () => {
  it('drops inline markup the body renders', () => {
    expect(previewText('**Confirmed working:** the `deploy` step, *really* ~~not~~ __u__')).toBe(
      'Confirmed working: the deploy step, really not u',
    );
  });

  it('leaves exactly what the BODY leaves: markup the timeline does not parse stays', () => {
    // The body renders `_word_` literally in this position, so the preview
    // must too — it walks the same parser rather than a looser regex.
    expect(previewText('if it _regresses_.')).toBe('if it _regresses_.');
  });

  it('keeps a link’s text and an autolink’s address', () => {
    expect(previewText('see [the docs](https://example.com/x) or https://example.com')).toBe(
      'see the docs or https://example.com',
    );
  });

  it('keeps mention and channel tokens as tokens (normalizing the nickname form)', () => {
    expect(previewText('hey <@!123> and <@456> in <#789>')).toBe('hey <@123> and <@456> in <#789>');
  });

  it('flattens blocks: headings, quotes, lists and fenced code read as words on one line', () => {
    const body = ['# Title', '', '> quoted *bit*', '', '- one', '- **two**', '', '```js', 'const x = 1;', '```'].join('\n');
    expect(previewText(body)).toBe('Title quoted bit one two const x = 1;');
  });

  it('collapses whitespace and leaves plain text alone', () => {
    expect(previewText('  just   plain\n\ntext  ')).toBe('just plain text');
    expect(previewText('')).toBe('');
  });

  it('an escaped marker stays literal', () => {
    expect(previewText('2 \\* 3')).toBe('2 * 3');
  });
});
