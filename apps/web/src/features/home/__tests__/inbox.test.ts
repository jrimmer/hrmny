/**
 * @cytale/web — the #117 inbox merge and prune rules.
 *
 * The merge is the one piece of this feature that a wrong implementation can
 * make strictly WORSE than no feature: the server's hydrate is a snapshot, and
 * anything that arrived while it was in flight is not in it. These tests pin
 * the direction (local rows survive), the precedence (the server's copy of the
 * same event wins), the prune (read state answers rows — and a channel
 * acknowledgement never answers a thread mention), and the wire wrapper's
 * shape.
 */
import { parsePermalinkPath } from '@cytale/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dismissInboxItem,
  fetchInbox,
  isAnswered,
  mentionsUser,
  mergeInbox,
  openInbox,
  renderExcerpt,
  sweepInbox,
  type InboxItem,
} from '../inbox.js';

function item(over: Partial<InboxItem> & { message_id: string }): InboxItem {
  return {
    channel_id: '2000000000000002',
    thread_id: null,
    author_id: '4000000000000004',
    author_username: 'dana',
    kind: 'mention',
    excerpt: 'can you look?',
    created_at: '2026-09-14T10:00:00.000Z',
    ...over,
  };
}

const older = item({ message_id: '1000000000000001' });
const newer = item({ message_id: '1000000000000009', excerpt: 'the live one' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mergeInbox', () => {
  it('never drops a local row the snapshot does not know about', () => {
    // The race the ticket names: a mention accrued while the fetch was in
    // flight must survive the hydrate landing on top of it.
    const merged = mergeInbox([newer], [older]);

    expect(merged.map((i) => i.message_id)).toEqual([newer.message_id, older.message_id]);
  });

  it('is a union, not a replace, in the other direction too', () => {
    const merged = mergeInbox([older], [newer]);

    expect(merged.map((i) => i.message_id)).toEqual([newer.message_id, older.message_id]);
  });

  it('takes the server copy when both hold the same event', () => {
    const local = item({ message_id: '1000000000000005', excerpt: 'stale local excerpt' });
    const server = item({ message_id: '1000000000000005', excerpt: 'server excerpt' });

    const merged = mergeInbox([local], [server]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.excerpt).toBe('server excerpt');
  });

  it('orders newest-first', () => {
    const a = item({ message_id: '1000000000000003' });
    const b = item({ message_id: '1000000000000007' });

    expect(mergeInbox([a, b], []).map((i) => i.message_id)).toEqual([
      b.message_id,
      a.message_id,
    ]);
  });

  it('is idempotent — merging the same snapshot twice changes nothing', () => {
    const once = mergeInbox([], [older, newer]);
    const twice = mergeInbox(once, [older, newer]);

    expect(twice).toEqual(once);
  });
});

describe('openInbox — answered and dismissed rows', () => {
  const none = { channel: {}, thread: {} };

  it('renders everything when nothing has been read', () => {
    expect(openInbox([older, newer], none, new Set())).toHaveLength(2);
  });

  it('drops a row the channel watermark already covers', () => {
    const open = openInbox([older, newer], { channel: { [older.channel_id]: { last_read_id: older.message_id } }, thread: {} }, new Set());

    expect(open.map((i) => i.message_id)).toEqual([newer.message_id]);
  });

  it('keeps a row newer than the watermark', () => {
    const open = openInbox(
      [newer],
      { channel: { [newer.channel_id]: { last_read_id: older.message_id } }, thread: {} },
      new Set(),
    );

    expect(open).toHaveLength(1);
  });

  it('answers a THREAD mention with the thread watermark, never the channel one', () => {
    const threadItem = item({
      message_id: '1000000000000011',
      channel_id: '2000000000000002',
      thread_id: '5000000000000005',
    });

    // A channel ack covers the timeline; the timeline hides replies. So the
    // channel watermark must NOT answer it (the server's own rule).
    expect(
      isAnswered(threadItem, {
        channel: { '2000000000000002': { last_read_id: '9999999999999999' } },
        thread: {},
      }),
    ).toBe(false);

    // The thread's own watermark does.
    expect(
      isAnswered(threadItem, {
        channel: {},
        thread: { '5000000000000005': { last_read_id: '9999999999999999' } },
      }),
    ).toBe(true);
  });

  it('filters rows dismissed in this session', () => {
    const open = openInbox([older, newer], none, new Set([newer.message_id]));

    expect(open.map((i) => i.message_id)).toEqual([older.message_id]);
  });
});

describe('mentionsUser / renderExcerpt', () => {
  it('matches both token forms', () => {
    expect(mentionsUser('hey <@42> there', '42')).toBe(true);
    expect(mentionsUser('hey <@!42> there', '42')).toBe(true);
  });

  it('does not fire on plain prose or a different id', () => {
    expect(mentionsUser('max, are you there?', '42')).toBe(false);
    expect(mentionsUser('<@43> not me', '42')).toBe(false);
    expect(mentionsUser(null, '42')).toBe(false);
    expect(mentionsUser('<@42>', null)).toBe(false);
  });

  it('resolves tokens to names for display', () => {
    expect(renderExcerpt('hi <@42> and <@!7>', (id) => (id === '42' ? 'dana' : 'sam'))).toBe(
      'hi @dana and @sam',
    );
  });
});

describe('the REST wrapper', () => {
  it('fetches the self-scoped inbox with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [older], oldest_id: older.message_id }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchInbox({ token: 'tok', limit: 25, before: '1000000000000099' });

    expect(page.items).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/users/@me/inbox?limit=25&before=1000000000000099');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('surfaces the server error shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: { key: 'not_found', message: 'nope' } }),
      }),
    );

    await expect(fetchInbox({ token: 'tok' })).rejects.toMatchObject({ status: 404, key: 'not_found' });
  });

  it('dismisses one item with DELETE on its own path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await dismissInboxItem('1000000000000001', 'tok');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/users/@me/inbox/1000000000000001');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('sweeps the collection and reports the count', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ done_count: 3 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await sweepInbox('tok')).toBe(3);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/users/@me/inbox');
    expect((init as RequestInit).method).toBe('DELETE');
  });
});

describe('the permalink a row carries', () => {
  it('addresses the message it came from', async () => {
    const { messagePermalinkUrl } = await import('../../messages/messagePermalink.js');

    const href = messagePermalinkUrl(
      { id: '1000000000000001', channel_id: '2000000000000002', thread_id: null },
      '3000000000000003',
    );

    expect(href).not.toBeNull();
    const hash = new URL(href!).hash.replace(/^#/, '');
    expect(parsePermalinkPath(hash)).toMatchObject({
      kind: 'message',
      workspaceId: '3000000000000003',
      channelId: '2000000000000002',
      messageId: '1000000000000001',
    });
  });
});
