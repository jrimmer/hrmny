/**
 * threadRows — what a roster row says (owner direction 2026-10-08): a
 * generated name gives way to the start message, the newest reply previews
 * as plain text, and rows group by when they last moved.
 */
import { describe, expect, it } from 'vitest';

import type { ThreadMessagePreview } from '@cytale/domain';

import {
  activityGroup,
  groupByActivity,
  isGeneratedThreadName,
  messagePreview,
  previewLine,
  threadSubject,
} from '../threadRows.js';

const preview = (over: Partial<ThreadMessagePreview> = {}): ThreadMessagePreview => ({
  id: 'm-1',
  author_id: 'u-1',
  author_name: null,
  content: '',
  embed_title: null,
  attachment_count: 0,
  created_at: '2026-10-08T12:00:00Z',
  ...over,
});

describe('isGeneratedThreadName', () => {
  it('knows a bot-made id name and the composer default', () => {
    for (const n of ['thread-388032', 'Thread_12', 'thread 7', 'New thread', '  ']) {
      expect(isGeneratedThreadName(n)).toBe(true);
    }
  });

  it('leaves a chosen name alone', () => {
    for (const n of ['Door tape', 'thread-safety review', 'threads', '388032']) {
      expect(isGeneratedThreadName(n)).toBe(false);
    }
  });
});

describe('previewLine', () => {
  it('drops markup and names mentions', () => {
    const p = preview({ content: '**Shredded:** 2 notebooks\nfor <@42>' });
    expect(previewLine(p, (id) => (id === '42' ? 'hunt' : undefined))).toBe('Shredded: 2 notebooks for @hunt');
  });

  it("falls back to a card's title, then to what it attached", () => {
    expect(previewLine(preview({ embed_title: 'Reconciliation' }))).toBe('Reconciliation');
    expect(previewLine(preview({ attachment_count: 1 }))).toBe('Sent an attachment');
    expect(previewLine(preview({ attachment_count: 3 }))).toBe('Sent 3 attachments');
    expect(previewLine(null)).toBe('');
  });
});

describe('threadSubject', () => {
  it('uses the start message when the name is generated', () => {
    expect(threadSubject({ name: 'thread-388032', starter: preview({ content: 'Final checklist' }) })).toBe(
      'Final checklist',
    );
  });

  it('keeps a chosen name, and the generated one when there is nothing better', () => {
    expect(threadSubject({ name: 'Door tape', starter: preview({ content: 'Taping the doors' }) })).toBe('Door tape');
    expect(threadSubject({ name: 'thread-1', starter: null })).toBe('thread-1');
  });
});

describe('messagePreview', () => {
  it("takes a loaded message's text, first card title and attachment count", () => {
    const p = messagePreview({
      id: 'm-9',
      author_id: 'u-9',
      content: '',
      created_at: '2026-10-08T12:00:00Z',
      attachments: null,
      embeds: [{ title: null }, { title: 'Nightly backup' }],
    });
    expect(previewLine(p)).toBe('Nightly backup');
    expect(p.attachment_count).toBe(0);
  });
});

describe('activity groups', () => {
  // Local noon, so the calendar-day edges below hold in any time zone.
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime();
  const at = (d: number, h = 9) => new Date(2026, 9, d, h, 0, 0).toISOString();

  it('splits today, the six days before it, and older', () => {
    expect(activityGroup(at(8, 0), now)).toBe('today');
    expect(activityGroup(at(7, 23), now)).toBe('week');
    expect(activityGroup(at(2), now)).toBe('week');
    expect(activityGroup(at(1), now)).toBe('older');
    expect(activityGroup('not a date', now)).toBe('older');
  });

  it('orders by newest activity and skips empty groups', () => {
    const rows = [
      { id: 'old', latest_reply_at: at(1), created_at: at(1) },
      { id: 'a', latest_reply_at: at(8, 9), created_at: at(3) },
      { id: 'b', latest_reply_at: null, created_at: at(8, 11) },
    ];
    const groups = groupByActivity(rows, now);
    expect(groups.map((g) => g.group)).toEqual(['today', 'older']);
    expect(groups[0]!.threads.map((t) => t.id)).toEqual(['b', 'a']);
  });
});
