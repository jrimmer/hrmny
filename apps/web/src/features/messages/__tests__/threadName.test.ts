/**
 * Thread name derivation (2026-09-10): threads are named from the seed
 * message — no title prompt anywhere.
 */
import { describe, expect, it } from 'vitest';

import { THREAD_NAME_FALLBACK, THREAD_NAME_MAX, threadNameFromMessage } from '../threadName.js';

describe('threadNameFromMessage', () => {
  it('uses the message text verbatim when short', () => {
    expect(threadNameFromMessage('deploy checklist')).toBe('deploy checklist');
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(threadNameFromMessage('line one\n\n  line   two')).toBe('line one line two');
  });

  it('resolves mention tokens to @names when the resolver knows them', () => {
    expect(threadNameFromMessage('ping <@9007199254740993> about it', (id) => (id === '9007199254740993' ? 'alice' : undefined))).toBe(
      'ping @alice about it',
    );
  });

  it('drops unresolvable mentions instead of leaking a snowflake', () => {
    expect(threadNameFromMessage('ping <@9007199254740993> now')).toBe('ping now');
  });

  it('keeps link text and strips emphasis/code markers', () => {
    expect(threadNameFromMessage('**bold** and [docs](https://x.test/a) and `code`')).toBe(
      'bold and docs and code',
    );
  });

  it('truncates long content with an ellipsis inside the cap', () => {
    const long = 'x'.repeat(THREAD_NAME_MAX + 40);
    const name = threadNameFromMessage(long);
    expect(name.length).toBe(THREAD_NAME_MAX);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back for a media-only message (the server requires a name)', () => {
    expect(threadNameFromMessage('')).toBe(THREAD_NAME_FALLBACK);
    expect(threadNameFromMessage('   \n  ')).toBe(THREAD_NAME_FALLBACK);
    expect(threadNameFromMessage('<@9007199254740993>')).toBe(THREAD_NAME_FALLBACK);
  });
});
