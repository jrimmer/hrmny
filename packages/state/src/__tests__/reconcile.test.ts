/**
 * @cytale/state — reconcile.ts tests (U17).
 *
 * Event application: gateway dispatch events (from @cytale/protocol, shared
 * with U15/U28) mutate the store; REST reads merge in; READY resets; RESUMED
 * replays from seq+1 without duplicates (AE2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@cytale/domain';
import type {
  GatewayEvent,
  MessageCreate,
  MessageUpdate,
  MessageDelete,
  ThreadCreate,
  ThreadMessageCreate,
  ThreadUpdate,
  PresenceUpdate,
  ChannelCreate,
  MemberAdd,
  MemberRemove,
  UserUpdate,
  Ready,
  Resumed,
} from '@cytale/protocol';

import { compareNewestFirst, createStateStore } from '../store.js';
import {
  applyGatewayEvent,
  mergeChannelMessages,
  resetForFreshSession,
} from '../reconcile.js';
import { SYNTHETIC_SEQ_FLOOR } from '../syntheticSeq.js';
import { beginOptimisticSend, confirmOptimisticSend } from '../optimistic.js';

// ---------------------------------------------------------------------------
// Fixtures — snowflakes are decimal strings (>53-bit safe), never numbers.
// ---------------------------------------------------------------------------

const CHANNEL = '9007199254740993'; // 2^53 + 1 — unsafe as a JS number
const THREAD = '9007199254741000';
const USER_A = '7000000000000001';
const USER_B = '7000000000000002';
const WORKSPACE = '6000000000000001';

let seq = 0;
function dispatch(t: string, d: unknown): GatewayEvent {
  seq += 1;
  return { op: 0, t, s: seq, d } as unknown as GatewayEvent;
}

function messageCreate(overrides: Partial<MessageCreate> = {}): MessageCreate {
  return {
    id: '1000000000000001',
    channel_id: CHANNEL,
    thread_id: null,
    author_id: USER_A,
    content: 'hello',
    created_at: '2026-08-28T00:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
});

describe('MESSAGE_CREATE', () => {
  it('adds the message to the channel list (happy path)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));

    const msgs = store.getState().messagesByChannel[CHANNEL];
    expect(msgs).toBeDefined();
    expect(msgs!.items).toHaveLength(1);
    expect(msgs!.items[0]).toMatchObject({ id: '1000000000000001', content: 'hello' });
  });

  it('keeps newest-first ordering regardless of arrival order (edge case)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000005' })));
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000002' })));
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000004' })));

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items.map((m) => m.id)).toEqual([
      '1000000000000005',
      '1000000000000004',
      '1000000000000002',
    ]);
  });

  it('drops exact duplicates idempotently (edge case)', () => {
    const store = createStateStore();
    const evt = messageCreate({ id: '1000000000000009' });
    applyGatewayEvent(store, dispatch('MessageCreate', evt));
    applyGatewayEvent(store, dispatch('MessageCreate', evt)); // same id, later seq

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(1);
  });

  it('retires the shadowed optimistic placeholder when the own-echo lands first (no visible double)', () => {
    const store = createStateStore();
    // Begin a send: the slice now holds the pending placeholder row.
    const { nonce, messageId } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'hello',
    });
    expect(store.getState().messagesByChannel[CHANNEL]!.items.map((m) => m.id)).toEqual([
      messageId,
    ]);

    // Gateway echo (real id) beats the REST confirm — the historical double.
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));
    const duringRace = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(duringRace.map((m) => m.id)).toEqual(['1000000000000001']);

    // REST confirm afterwards is an idempotent no-op on the items.
    confirmOptimisticSend(store, nonce, {
      id: '1000000000000001',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'hello',
      created_at: '2026-08-28T00:00:00Z',
      edited_at: null,
    });
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
    expect(store.getState().pendingByNonce[nonce]).toBeUndefined();
  });

  it('keeps both rows when a DIFFERENT author sends identical content (no false shadow)', () => {
    const store = createStateStore();
    beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'hello',
    });
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', messageCreate({ author_id: USER_B })),
    );

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    // The echo from a different author must NOT retire our placeholder.
    expect(items.some((m) => m.id.startsWith('pending_'))).toBe(true);
    expect(items.filter((m) => m.id === '1000000000000001')).toHaveLength(1);
  });

  describe('echo matching by the send key (nonce)', () => {
    function twoIdentical(store: ReturnType<typeof createStateStore>, threadId: string | null = null) {
      const first = beginOptimisticSend(store, {
        channel_id: CHANNEL,
        thread_id: threadId,
        author_id: USER_A,
        content: 'ok',
      });
      const second = beginOptimisticSend(store, {
        channel_id: CHANNEL,
        thread_id: threadId,
        author_id: USER_A,
        content: 'ok',
      });
      return { first, second };
    }

    it('settles two identical in-flight messages each on its OWN row, whatever order the echoes land', () => {
      const store = createStateStore();
      const { first, second } = twoIdentical(store);

      // The SECOND send's echo lands first: the content heuristic would hand
      // it the older placeholder; the key hands it its own.
      applyGatewayEvent(
        store,
        dispatch('MessageCreate', messageCreate({ id: '1000000000000002', content: 'ok', nonce: second.nonce })),
      );
      let items = store.getState().messagesByChannel[CHANNEL]!.items;
      expect(items.map((m) => m.id).sort()).toEqual(['1000000000000002', first.messageId].sort());
      expect(items.find((m) => m.id === '1000000000000002')!.client_key).toBe(second.nonce);

      applyGatewayEvent(
        store,
        dispatch('MessageCreate', messageCreate({ id: '1000000000000001', content: 'ok', nonce: first.nonce })),
      );
      items = store.getState().messagesByChannel[CHANNEL]!.items;
      expect(items.map((m) => m.id)).toEqual(['1000000000000002', '1000000000000001']);
      expect(items.find((m) => m.id === '1000000000000001')!.client_key).toBe(first.nonce);
    });

    it('settles identical thread replies exactly on ThreadMessageCreate', () => {
      const store = createStateStore();
      const { first, second } = twoIdentical(store, THREAD);
      const reply = (id: string, nonce: string) =>
        dispatch('ThreadMessageCreate', {
          ...messageCreate({ id, content: 'ok', nonce }),
          thread_id: THREAD,
        });

      applyGatewayEvent(store, reply('1000000000000002', second.nonce));
      const items = store.getState().messagesByThread[THREAD]!.items;
      expect(items.find((m) => m.id === '1000000000000002')!.client_key).toBe(second.nonce);
      expect(items.some((m) => m.id === first.messageId)).toBe(true);
      expect(items.some((m) => m.id === second.messageId)).toBe(false);
    });

    it('an echo whose nonce names no placeholder matches NOTHING (no content fallback)', () => {
      const store = createStateStore();
      const { messageId } = beginOptimisticSend(store, {
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_A,
        content: 'hello',
      });
      // Same author, same content — this account's other device, say — but a
      // key this client never minted.
      applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ nonce: 'someone-elses-key' })));

      const items = store.getState().messagesByChannel[CHANNEL]!.items;
      expect(items.some((m) => m.id === messageId)).toBe(true);
      expect(items.some((m) => m.id === '1000000000000001')).toBe(true);
      expect(items.find((m) => m.id === '1000000000000001')!.client_key).toBeUndefined();
    });

    it('another author echoing a colliding key never retires our row', () => {
      const store = createStateStore();
      const { nonce, messageId } = beginOptimisticSend(store, {
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_A,
        content: 'hello',
      });
      applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ author_id: USER_B, nonce })));
      expect(store.getState().messagesByChannel[CHANNEL]!.items.some((m) => m.id === messageId)).toBe(true);
    });

    it('an echo without a key still falls back to author + content (older servers)', () => {
      const store = createStateStore();
      const { messageId } = beginOptimisticSend(store, {
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_A,
        content: 'hello',
      });
      applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));
      const items = store.getState().messagesByChannel[CHANNEL]!.items;
      expect(items.map((m) => m.id)).toEqual(['1000000000000001']);
      expect(items.some((m) => m.id === messageId)).toBe(false);
    });
  });

  it('advances the narrow recency slice without re-identifying the channels record', () => {
    const store = createStateStore();
    store.setState((s) => ({
      channels: {
        ...s.channels,
        [CHANNEL]: {
          id: CHANNEL,
          workspace_id: WORKSPACE,
          name: 'general',
          type: 'text',
          topic: null,
          position: 0,
          last_message_id: '1000000000000001',
          created_at: '2026-08-28T00:00:00Z',
        },
      },
    }));
    const channelsBefore = store.getState().channels;
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000007' })));
    expect(store.getState().lastMessageIdByChannel[CHANNEL]).toBe('1000000000000007');
    // The channel RECORD is hydrated data (name/position/topic): a message
    // must not churn its identity, or every `channels` consumer re-derives.
    expect(store.getState().channels).toBe(channelsBefore);
  });

  it('does not regress the recency slice on a stale/out-of-order message', () => {
    const store = createStateStore();
    store.setState((s) => ({
      channels: {
        ...s.channels,
        [CHANNEL]: {
          id: CHANNEL,
          workspace_id: WORKSPACE,
          name: 'general',
          type: 'text',
          topic: null,
          position: 0,
          last_message_id: '1000000000000050',
          created_at: '2026-08-28T00:00:00Z',
        },
      },
    }));
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000050' })));
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000007' })));
    expect(store.getState().lastMessageIdByChannel[CHANNEL]).toBe('1000000000000050');
  });

  it('increments unread mention count for messages mentioning current user', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_B, username: 'bee' } });
    applyGatewayEvent(
      store,
      dispatch(
        'MessageCreate',
        messageCreate({ id: '1000000000000011', content: 'hey <@7000000000000002>' }),
      ),
    );
    const unread = store.getState().unreadByChannel[CHANNEL];
    expect(unread!.mention_count).toBe(1);
    expect(unread!.last_read_id).toBeNull();
  });

  it('creates no unread entry when the author is the current user (self-messages never accrue)', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_A, username: 'ay' } });
    applyGatewayEvent(
      store,
      dispatch(
        'MessageCreate',
        messageCreate({ id: '1000000000000013', content: 'just me' }),
      ),
    );
    expect(store.getState().unreadByChannel[CHANNEL]).toBeUndefined();
  });

  it('does not count mentions when the message author is the current user', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_A, username: 'ay' } });
    store.setState((s) => ({
      unreadByChannel: {
        ...s.unreadByChannel,
        [CHANNEL]: { last_read_id: null, unread_count: 3, mention_count: 0 },
      },
    }));
    applyGatewayEvent(
      store,
      dispatch(
        'MessageCreate',
        messageCreate({ id: '1000000000000012', content: 'note to self <@7000000000000001>' }),
      ),
    );
    // own-author message: accrual skipped entirely — counts stay put
    expect(store.getState().unreadByChannel[CHANNEL]).toEqual({
      last_read_id: null,
      unread_count: 3,
      mention_count: 0,
    });
  });
});

describe('mention parsing (hardening plan 7.6)', () => {
  it('counts only an exact <@id> token — prefix ids, other users and a bare "<@id" do not match', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_B, username: 'bee' } });
    const contents = [
      'hey <@7000000000000002>', // exact — the only mention
      'hey <@700000000000002>', // a different (shorter) id
      'hey <@70000000000000021>', // USER_B's id plus a digit inside the token
      'hey <@7000000000000002', // no closing bracket
      'hey <@!7000000000000002>', // nickname form is not this store's token
      'hey <@7000000000000003>', // another user entirely
    ];
    contents.forEach((content, i) => {
      applyGatewayEvent(
        store,
        dispatch(
          'MessageCreate',
          messageCreate({ id: `10000000000001${String(i).padStart(2, '0')}`, content }),
        ),
      );
    });
    expect(store.getState().unreadByChannel[CHANNEL]!.mention_count).toBe(1);
  });

  it('does not allocate a match array per message (no String.matchAll on the accrual path)', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_B, username: 'bee' } });
    const matchAll = vi.spyOn(String.prototype, 'matchAll');
    let calls = 0;
    try {
      applyGatewayEvent(
        store,
        dispatch(
          'MessageCreate',
          messageCreate({
            id: '1000000000000200',
            content: 'ping <@7000000000000002> and again <@7000000000000002>',
          }),
        ),
      );
      calls = matchAll.mock.calls.length; // read BEFORE mockRestore clears history
    } finally {
      matchAll.mockRestore();
    }
    expect(calls).toBe(0);
    expect(store.getState().unreadByChannel[CHANNEL]!.mention_count).toBe(1);
  });

  it('keeps the 8191-char guard: content at/over 8192 chars never parses mentions', () => {
    const store = createStateStore();
    store.setState({ currentUser: { id: USER_B, username: 'bee' } });
    const token = '<@7000000000000002>';
    const under = 'x'.repeat(8191 - token.length) + token; // 8191 chars
    const at = 'x'.repeat(8192 - token.length) + token; // 8192 chars — guard trips
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', messageCreate({ id: '1000000000000300', content: under })),
    );
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', messageCreate({ id: '1000000000000301', content: at })),
    );
    expect(store.getState().unreadByChannel[CHANNEL]!.mention_count).toBe(1);
  });
});

describe('MESSAGE_UPDATE', () => {
  it('patches only the changed fields, preserving identity fields (edge case)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));
    const before = store.getState().messagesByChannel[CHANNEL]!.items[0]!;

    applyGatewayEvent(
      store,
      dispatch('MessageUpdate', {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        content: 'edited body',
        edited_at: '2026-08-28T01:00:00Z',
      } satisfies MessageUpdate),
    );

    const after = store.getState().messagesByChannel[CHANNEL]!.items[0]!;
    expect(after!.content).toBe('edited body');
    expect(after!.edited_at).toBe('2026-08-28T01:00:00Z');
    // untouched fields preserved
    expect(after!.author_id).toBe(before!.author_id);
    expect(after!.created_at).toBe(before!.created_at);
    expect(after!.channel_id).toBe(CHANNEL);
    expect(after!.thread_id).toBeNull();
    // no duplicate row created
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });

  it("replaces the content's image proxy map with the edit's own (absent clears it)", () => {
    const store = createStateStore();
    const src = 'https://img.example/a.png';
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', {
        ...messageCreate(),
        content: `![a](${src})`,
        content_proxy_urls: { [src]: '/api/v1/media/proxy?u=a&e=1&s=x' },
      }),
    );
    const row = () => store.getState().messagesByChannel[CHANNEL]!.items[0] as unknown as Record<string, unknown>;
    expect(row().content_proxy_urls).toEqual({ [src]: '/api/v1/media/proxy?u=a&e=1&s=x' });

    const edit = (content: string, map?: Record<string, string>) =>
      applyGatewayEvent(
        store,
        dispatch('MessageUpdate', {
          id: '1000000000000001',
          channel_id: CHANNEL,
          thread_id: null,
          content,
          edited_at: '2026-08-28T01:00:00Z',
          ...(map ? { content_proxy_urls: map } : {}),
        } satisfies MessageUpdate),
      );

    edit(`![b](${src}2)`, { [`${src}2`]: '/api/v1/media/proxy?u=b&e=1&s=y' });
    expect(row().content_proxy_urls).toEqual({ [`${src}2`]: '/api/v1/media/proxy?u=b&e=1&s=y' });
    edit('no images');
    expect(row().content_proxy_urls).toBeUndefined();
  });

  it('applies to thread messages in the thread pane, not the parent channel', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ThreadMessageCreate', {
        id: '1000000000000021',
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: USER_A,
        content: 'thread root reply',
        created_at: '2026-08-28T00:05:00Z',
        edited_at: null,
      } satisfies ThreadMessageCreate),
    );
    applyGatewayEvent(
      store,
      dispatch('MessageUpdate', {
        id: '1000000000000021',
        channel_id: CHANNEL,
        thread_id: THREAD,
        content: 'thread edit',
        edited_at: '2026-08-28T01:05:00Z',
      }),
    );
    expect(store.getState().messagesByThread[THREAD]!.items[0]!.content).toBe('thread edit');
  });

  // Components plan U3 (R2): MessageUpdate carries the message's CURRENT
  // action rows — the live approval-card flip without a reload.
  it('patches components when the update carries them (the approval-card flip)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));

    const resolvedRow = {
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Approved', custom_id: 'approve', disabled: true },
      ],
    };

    applyGatewayEvent(
      store,
      dispatch('MessageUpdate', {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        content: 'hello',
        edited_at: '2026-09-06T00:00:00Z',
        components: [resolvedRow],
      } satisfies MessageUpdate),
    );

    const after = store.getState().messagesByChannel[CHANNEL]!.items[0]!;
    expect(after.components).toEqual([resolvedRow]);
    expect(after.edited_at).toBe('2026-09-06T00:00:00Z');
  });

  it('leaves stored components untouched when the update omits the key (plain content edit)', () => {
    const store = createStateStore();
    const row = { type: 1, components: [{ type: 2, style: 1, label: 'Go', custom_id: 'go' }] };
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', messageCreate({ components: [row] } as Partial<MessageCreate>)),
    );

    applyGatewayEvent(
      store,
      dispatch('MessageUpdate', {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        content: 'text edit only',
        edited_at: '2026-09-06T00:01:00Z',
      } satisfies MessageUpdate),
    );

    const after = store.getState().messagesByChannel[CHANNEL]!.items[0]!;
    expect(after.content).toBe('text edit only');
    expect(after.components).toEqual([row]);
  });

  // Thread cards: a bot's card posted into a thread arrives whole on
  // ThreadMessageCreate and flips in the THREAD slice — embeds swapped and
  // buttons cleared by an explicit `[]` — exactly as a channel card does.
  it('a thread card arrives with embeds + components and flips in the thread slice', () => {
    const store = createStateStore();
    const row = { type: 1, components: [{ type: 2, style: 3, label: 'Approve', custom_id: 'approve' }] };
    applyGatewayEvent(
      store,
      dispatch('ThreadMessageCreate', {
        id: '1000000000000031',
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: USER_A,
        content: '',
        created_at: '2026-09-06T00:02:00Z',
        edited_at: null,
        embeds: [{ title: 'Approve deploy?' }],
        components: [row],
      } satisfies ThreadMessageCreate),
    );
    const created = store.getState().messagesByThread[THREAD]!.items[0]! as unknown as Record<string, unknown>;
    expect(created.embeds).toEqual([{ title: 'Approve deploy?' }]);
    expect(created.components).toEqual([row]);

    applyGatewayEvent(
      store,
      dispatch('MessageUpdate', {
        id: '1000000000000031',
        channel_id: CHANNEL,
        thread_id: THREAD,
        content: '',
        edited_at: '2026-09-06T00:03:00Z',
        components: [],
        embeds: [{ title: 'Approved by clicker' }],
      } satisfies MessageUpdate),
    );
    const flipped = store.getState().messagesByThread[THREAD]!.items[0]! as unknown as Record<string, unknown>;
    expect(flipped.components).toEqual([]);
    expect(flipped.embeds).toEqual([{ title: 'Approved by clicker' }]);
    // The parent channel's slice never gained the thread row.
    expect(store.getState().messagesByChannel[CHANNEL]).toBeUndefined();
  });

  it('leaves stored embeds untouched when the update omits the key', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('MessageCreate', messageCreate({ embeds: [{ title: 'keep' }] } as Partial<MessageCreate>)),
    );
    applyGatewayEvent(
      store,
      dispatch('MessageUpdate', {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        content: 'text edit only',
        edited_at: '2026-09-06T00:04:00Z',
      } satisfies MessageUpdate),
    );
    const after = store.getState().messagesByChannel[CHANNEL]!.items[0]! as unknown as Record<string, unknown>;
    expect(after.embeds).toEqual([{ title: 'keep' }]);
  });
});

describe('MESSAGE_DELETE', () => {
  it('removes the message from the store', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));
    applyGatewayEvent(
      store,
      dispatch('MessageDelete', {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
      } satisfies MessageDelete),
    );
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(0);
  });

  it('is a no-op (not a crash) when the message is absent', () => {
    const store = createStateStore();
    expect(() =>
      applyGatewayEvent(
        store,
        dispatch('MessageDelete', {
          id: '9999999999999999',
          channel_id: CHANNEL,
          thread_id: null,
        }),
      ),
    ).not.toThrow();
  });
});

describe('THREAD_CREATE / ThreadMessageCreate', () => {
  it('registers a thread under its parent channel', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ThreadCreate', {
        id: THREAD,
        channel_id: CHANNEL,
        name: 'deploy talk',
        created_by: USER_A,
        created_at: '2026-08-28T00:04:00Z',
      } satisfies ThreadCreate),
    );
    const thread = store.getState().threadsById[THREAD];
    expect(thread).toMatchObject({ id: THREAD, name: 'deploy talk' });
    expect(store.getState().threadIdsByChannel[CHANNEL]).toContain(THREAD);
  });

  it('appends ThreadMessageCreate to the thread pane', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ThreadCreate', {
        id: THREAD,
        channel_id: CHANNEL,
        name: 't',
        created_by: USER_A,
        created_at: '2026-08-28T00:04:00Z',
      }),
    );
    applyGatewayEvent(
      store,
      dispatch('ThreadMessageCreate', {
        id: '1000000000000031',
        channel_id: CHANNEL,
        thread_id: THREAD,
        author_id: USER_A,
        content: 'first reply',
        created_at: '2026-08-28T00:06:00Z',
        edited_at: null,
      }),
    );
    const items = store.getState().messagesByThread[THREAD]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe('first reply');
  });
});

describe('thread summary — the seed indicator count (#106)', () => {
  function reply(id: string, at: string): GatewayEvent {
    return dispatch('ThreadMessageCreate', {
      id,
      channel_id: CHANNEL,
      thread_id: THREAD,
      author_id: USER_B,
      content: `reply ${id}`,
      created_at: at,
      edited_at: null,
    } satisfies ThreadMessageCreate);
  }

  /** A thread whose REST summary already counts two replies up to 00:06. */
  function seeded() {
    const store = createStateStore();
    store.setState({
      threadsById: {
        [THREAD]: {
          id: THREAD,
          channel_id: CHANNEL,
          parent_message_id: THREAD,
          name: 't',
          created_by: USER_A,
          archived: false,
          created_at: '2026-08-28T00:04:00Z',
          message_count: 2,
          latest_reply_at: '2026-08-28T00:06:00Z',
        },
      },
    });
    return store;
  }
  const summary = (store: ReturnType<typeof createStateStore>) => store.getState().threadsById[THREAD]!;

  it('a live reply newer than the summary bumps the count and last activity', () => {
    const store = seeded();
    applyGatewayEvent(store, reply('1000000000000033', '2026-08-28T00:07:00Z'));
    expect(summary(store)).toMatchObject({ message_count: 3, latest_reply_at: '2026-08-28T00:07:00Z' });
  });

  it('the echo of a reply already applied is a no-op', () => {
    const store = seeded();
    applyGatewayEvent(store, reply('1000000000000033', '2026-08-28T00:07:00Z'));
    applyGatewayEvent(store, reply('1000000000000033', '2026-08-28T00:07:00Z'));
    expect(summary(store).message_count).toBe(3);
  });

  it('replaying history the summary already counts never moves it', () => {
    const store = seeded();
    applyGatewayEvent(store, reply('1000000000000031', '2026-08-28T00:05:00Z'));
    applyGatewayEvent(store, reply('1000000000000032', '2026-08-28T00:06:00Z'));
    expect(summary(store)).toMatchObject({ message_count: 2, latest_reply_at: '2026-08-28T00:06:00Z' });
  });

  it('the first reply of a brand-new thread makes the count 1, and ThreadCreate after it keeps it', () => {
    const store = createStateStore();
    const created = {
      id: THREAD,
      channel_id: CHANNEL,
      name: 't',
      created_by: USER_A,
      created_at: '2026-08-28T00:04:00Z',
    } satisfies ThreadCreate;
    applyGatewayEvent(store, dispatch('ThreadCreate', created));
    applyGatewayEvent(store, reply('1000000000000031', '2026-08-28T00:05:00Z'));
    applyGatewayEvent(store, dispatch('ThreadCreate', created));
    expect(summary(store).message_count).toBe(1);
  });

  it('a deleted reply leaves the count once, even when delivered twice', () => {
    const store = seeded();
    applyGatewayEvent(store, reply('1000000000000033', '2026-08-28T00:07:00Z'));
    const del = { id: '1000000000000033', channel_id: CHANNEL, thread_id: THREAD } satisfies MessageDelete;
    applyGatewayEvent(store, dispatch('MessageDelete', del));
    applyGatewayEvent(store, dispatch('MessageDelete', del));
    expect(summary(store)).toMatchObject({ message_count: 2, latest_reply_at: '2026-08-28T00:07:00Z' });
  });

  it('a reply edit does not move the summary', () => {
    const store = seeded();
    applyGatewayEvent(
      store,
      dispatch('MessageUpdate', {
        id: '1000000000000032',
        channel_id: CHANNEL,
        thread_id: THREAD,
        content: 'edited',
        edited_at: '2026-08-28T00:09:00Z',
      }),
    );
    expect(summary(store)).toMatchObject({ message_count: 2, latest_reply_at: '2026-08-28T00:06:00Z' });
  });
});

describe('thread anchor — a thread someone ELSE started shows on its seed (invisible threads)', () => {
  // A bot, a webhook, another member or another device starts a thread on
  // the viewer's message: the viewer's client learns of it ONLY through the
  // live events, so the anchor they carry is the one place the seed
  // indicator can come from. Before this, ThreadCreate ignored the event's
  // anchor and the replies stayed invisible until a reload.
  const SEED = '1000000000000020';
  const created = (over: Partial<ThreadCreate> = {}): ThreadCreate => ({
    id: THREAD,
    channel_id: CHANNEL,
    parent_message_id: SEED,
    name: 'approval',
    created_by: USER_B,
    created_at: '2026-08-28T00:04:00Z',
    ...over,
  });
  /** The same event as an OLDER server sends it — no anchor key at all. */
  const createdWithoutAnchor = (): ThreadCreate => {
    const { parent_message_id: _drop, ...rest } = created();
    return rest;
  };
  const reply = (id: string, at: string): GatewayEvent =>
    dispatch('ThreadMessageCreate', {
      id,
      channel_id: CHANNEL,
      thread_id: THREAD,
      author_id: USER_B,
      content: `reply ${id}`,
      created_at: at,
      edited_at: null,
    } satisfies ThreadMessageCreate);
  const thread = (store: ReturnType<typeof createStateStore>) => store.getState().threadsById[THREAD]!;

  /** The store already knows the thread and its anchor (the roster read). */
  function known() {
    const store = createStateStore();
    store.setState({
      threadsById: {
        [THREAD]: {
          id: THREAD,
          channel_id: CHANNEL,
          parent_message_id: SEED,
          name: 'approval',
          created_by: USER_B,
          archived: false,
          created_at: '2026-08-28T00:04:00Z',
          message_count: 2,
          latest_reply_at: '2026-08-28T00:06:00Z',
        },
      },
      threadIdsByChannel: { [CHANNEL]: [THREAD] },
    });
    return store;
  }

  it('a ThreadCreate WITH an anchor stores it', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('ThreadCreate', created()));
    expect(thread(store).parent_message_id).toBe(SEED);
  });

  it('a ThreadCreate WITHOUT an anchor (older server, replay) never erases a known one', () => {
    const store = known();
    applyGatewayEvent(store, dispatch('ThreadCreate', createdWithoutAnchor()));
    expect(thread(store).parent_message_id).toBe(SEED);
    // ...nor the summary the roster already counted.
    expect(thread(store)).toMatchObject({ message_count: 2, latest_reply_at: '2026-08-28T00:06:00Z' });
  });

  it('a ThreadCreate without an anchor on an unknown thread records null, not undefined', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('ThreadCreate', createdWithoutAnchor()));
    expect(thread(store).parent_message_id).toBeNull();
  });

  it('a ThreadUpdate WITH an anchor stores it (a client that missed the create)', () => {
    const store = createStateStore();
    // Known only through a reply-side path that never learned the anchor.
    store.setState({
      threadsById: {
        [THREAD]: {
          id: THREAD,
          channel_id: CHANNEL,
          parent_message_id: null,
          name: 'approval',
          created_by: USER_B,
          archived: false,
          created_at: '2026-08-28T00:04:00Z',
        },
      },
    });
    applyGatewayEvent(
      store,
      dispatch('ThreadUpdate', {
        id: THREAD,
        channel_id: CHANNEL,
        parent_message_id: SEED,
        archived: false,
      } satisfies ThreadUpdate),
    );
    expect(thread(store).parent_message_id).toBe(SEED);
  });

  it('a ThreadUpdate WITHOUT an anchor never erases a known one', () => {
    const store = known();
    applyGatewayEvent(
      store,
      dispatch('ThreadUpdate', { id: THREAD, channel_id: CHANNEL, archived: true } satisfies ThreadUpdate),
    );
    expect(thread(store)).toMatchObject({ parent_message_id: SEED, archived: true });
  });

  it('a duplicate ThreadCreate (replay after an archive) neither erases the anchor nor un-archives', () => {
    const store = known();
    applyGatewayEvent(
      store,
      dispatch('ThreadUpdate', { id: THREAD, channel_id: CHANNEL, archived: true } satisfies ThreadUpdate),
    );
    applyGatewayEvent(store, dispatch('ThreadCreate', createdWithoutAnchor()));
    expect(thread(store)).toMatchObject({ parent_message_id: SEED, archived: true });
  });

  it('replies after the ThreadCreate make the seed summary appear with the right count', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('ThreadCreate', created()));
    // A brand-new thread has no replies yet: an explicit 0, so the seed shows
    // nothing until the first reply lands.
    expect(thread(store)).toMatchObject({ parent_message_id: SEED, message_count: 0 });

    applyGatewayEvent(store, reply('1000000000000031', '2026-08-28T00:05:00Z'));
    expect(thread(store)).toMatchObject({
      parent_message_id: SEED,
      message_count: 1,
      latest_reply_at: '2026-08-28T00:05:00Z',
    });

    applyGatewayEvent(store, reply('1000000000000032', '2026-08-28T00:06:00Z'));
    // The same reply delivered again (resume overlap) is not a third.
    applyGatewayEvent(store, reply('1000000000000032', '2026-08-28T00:06:00Z'));
    expect(thread(store)).toMatchObject({
      parent_message_id: SEED,
      message_count: 2,
      latest_reply_at: '2026-08-28T00:06:00Z',
    });
    expect(store.getState().threadIdsByChannel[CHANNEL]).toEqual([THREAD]);
  });
});

describe('PRESENCE_UPDATE aggregation', () => {
  it('aggregates status per user, replacing prior state (happy path)', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('PresenceUpdate', {
        user_id: USER_A,
        status: 'online',
        last_seen_at: '2026-08-28T00:00:00Z',
      } satisfies PresenceUpdate),
    );
    applyGatewayEvent(
      store,
      dispatch('PresenceUpdate', {
        user_id: USER_A,
        status: 'dnd',
        last_seen_at: '2026-08-28T00:01:00Z',
      }),
    );
    expect(store.getState().presenceByUser[USER_A]).toEqual({
      status: 'dnd',
      last_seen_at: '2026-08-28T00:01:00Z',
    });
  });
});

describe('channel + membership events', () => {
  it('ChannelCreate upserts a channel', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ChannelCreate', {
        id: CHANNEL,
        workspace_id: WORKSPACE,
        name: 'general',
        position: 0,
        created_at: '2026-08-28T00:00:00Z',
      } satisfies ChannelCreate),
    );
    expect(store.getState().channels[CHANNEL]).toMatchObject({ name: 'general', type: 'text' });
  });

  // The wire sends the server's numeric type column (0 = text, 1 = category),
  // and omitted the key entirely until 2026-09-15 — which is why this handler
  // used to hardcode 'text' and render every new CATEGORY as a text channel
  // until a reload replaced the row with the REST reading.
  it('ChannelCreate reads the type off the payload, and keeps parent_id', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ChannelCreate', {
        id: '700000000000000002',
        workspace_id: WORKSPACE,
        name: 'Engineering',
        type: 1,
        parent_id: null,
        position: 1,
        created_at: '2026-08-28T00:00:00Z',
      }),
    );
    expect(store.getState().channels['700000000000000002']).toMatchObject({ type: 'category' });

    // A channel created INSIDE that category must land in it, not ungrouped.
    applyGatewayEvent(
      store,
      dispatch('ChannelCreate', {
        id: CHANNEL,
        workspace_id: WORKSPACE,
        name: 'general',
        type: 0,
        parent_id: '700000000000000002',
        position: 0,
        created_at: '2026-08-28T00:00:00Z',
      }),
    );
    expect(store.getState().channels[CHANNEL]).toMatchObject({
      type: 'text',
      parent_id: '700000000000000002',
    });
  });

  // An older server sends no `type` at all (ChannelTypeWire documents that
  // every gateway Channel event used to omit the key). Reading that as text
  // keeps the row usable rather than writing `undefined` into the union, and
  // `parent_id` must stay absent rather than becoming null — the sidebar
  // treats "no parent" as the ungrouped section.
  it('ChannelCreate defaults an absent type to text', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ChannelCreate', {
        id: CHANNEL,
        workspace_id: WORKSPACE,
        name: 'general',
        position: 0,
        created_at: '2026-08-28T00:00:00Z',
      } as never),
    );
    expect(store.getState().channels[CHANNEL]).toMatchObject({ type: 'text' });
    expect(store.getState().channels[CHANNEL]!.parent_id).toBeUndefined();
  });

  it('ChannelUpdate patches only present keys and ChannelDelete removes', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ChannelCreate', {
        id: CHANNEL,
        workspace_id: WORKSPACE,
        name: 'general',
        position: 0,
        created_at: '2026-08-28T00:00:00Z',
      }),
    );
    applyGatewayEvent(
      store,
      dispatch('ChannelUpdate', { id: CHANNEL, name: 'renamed', topic: null }),
    );
    const ch = store.getState().channels[CHANNEL];
    expect(ch!.name).toBe('renamed');
    expect(ch!.topic).toBeNull();
    expect(ch!.position).toBe(0);

    applyGatewayEvent(store, dispatch('ChannelDelete', { id: CHANNEL }));
    expect(store.getState().channels[CHANNEL]).toBeUndefined();
  });

  it('MemberAdd/MemberRemove maintain the workspace member set', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: USER_A, username: 'ay' },
        joined_at: '2026-08-28T00:00:00Z',
      } satisfies MemberAdd),
    );
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).toContain(USER_A);
    expect(store.getState().membersById[USER_A]).toMatchObject({ id: USER_A });

    applyGatewayEvent(store, dispatch('MemberRemove', { workspace_id: WORKSPACE, user_id: USER_A }));
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).not.toContain(USER_A);
  });

  // Bot attribution (2026-10-02): a machine principal joins a roster by its
  // owner's GRANT, announced as a MemberAdd carrying the people row's shape.
  // The row must keep the label, avatar, kind and owner, or the bot's replies
  // and the threads it starts render as its raw snowflake.
  it('MemberAdd carries the people row: a granted bot lands named, avatared and badged', () => {
    const store = createStateStore();
    const BOT = '99587434064379904';
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        // A bot's label rides `display_name` (#168); `nickname` is its
        // per-workspace nickname, null until set (#169).
        user: {
          id: BOT,
          username: 'hermes',
          display_name: 'Hermes',
          avatar_url: '/api/v1/attachments/' + 'b'.repeat(64),
        },
        joined_at: '2026-10-02T00:00:00Z',
        nickname: null,
        roles: [],
        kind: 'bot',
        parent_user_id: USER_A,
        dm_support: 'humans',
      } satisfies MemberAdd),
    );
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).toContain(BOT);
    expect(store.getState().membersById[BOT]).toEqual({
      id: BOT,
      username: 'hermes',
      display_name: 'Hermes',
      nickname: null,
      avatar_url: '/api/v1/attachments/' + 'b'.repeat(64),
      joined_at: '2026-10-02T00:00:00Z',
      roles: [],
      kind: 'bot',
      parent_user_id: USER_A,
      dm_support: 'humans',
    });
  });

  it('an older MemberAdd (id + username only) keeps what the row already knew', () => {
    const store = createStateStore();
    store.setState({
      membersById: {
        [USER_A]: {
          id: USER_A,
          username: 'ay',
          nickname: 'Ay Nick',
          avatar_url: '/a.png',
          joined_at: '2026-08-01T00:00:00Z',
          roles: ['1'],
          kind: 'human',
        },
      },
    });
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: USER_A, username: 'ay' },
        joined_at: '2026-08-28T00:00:00Z',
      } satisfies MemberAdd),
    );
    // The shared row keeps what it knew; a nickname is never on it (#169).
    expect(store.getState().membersById[USER_A]).toMatchObject({
      nickname: null,
      avatar_url: '/a.png',
      roles: ['1'],
      kind: 'human',
    });
  });

  // A deleted bot (2026-10-02): the server now announces MemberRemove for
  // every workspace its grant reached, through the same path as a revoked
  // grant. The client's half: the bot leaves the member list at once.
  it('a deleted bot\'s MemberRemove takes it out of the member list live', () => {
    const store = createStateStore();
    const BOT = '99587434064379904';
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: BOT, username: 'hermes' },
        joined_at: '2026-10-02T00:00:00Z',
        nickname: 'Hermes',
        roles: [],
        kind: 'bot',
        parent_user_id: USER_A,
      } satisfies MemberAdd),
    );
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).toContain(BOT);

    applyGatewayEvent(store, dispatch('MemberRemove', { workspace_id: WORKSPACE, user_id: BOT }));
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).not.toContain(BOT);
    expect(store.getState().membersById[BOT]).toBeUndefined();
  });

  it('MemberRemove from one workspace keeps the row a second workspace still lists', () => {
    const store = createStateStore();
    const OTHER = '400000000000000999';
    for (const ws of [WORKSPACE, OTHER]) {
      applyGatewayEvent(
        store,
        dispatch('MemberAdd', {
          workspace_id: ws,
          user: { id: USER_A, username: 'ay' },
          joined_at: '2026-08-28T00:00:00Z',
        } satisfies MemberAdd),
      );
    }
    applyGatewayEvent(store, dispatch('MemberRemove', { workspace_id: WORKSPACE, user_id: USER_A }));
    expect(store.getState().memberIdsByWorkspace[WORKSPACE]).not.toContain(USER_A);
    expect(store.getState().membersById[USER_A]).toMatchObject({ username: 'ay' });

    applyGatewayEvent(store, dispatch('MemberRemove', { workspace_id: OTHER, user_id: USER_A }));
    expect(store.getState().membersById[USER_A]).toBeUndefined();
  });

  // #168: a person's display name is stored on every row (in its own field)
  // and kept live; the per-workspace nickname is never overwritten.
  it('MemberAdd and UserUpdate carry a person\'s display name; the nickname is untouched', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: USER_A, username: 'liddy', display_name: 'G. Gordon Liddy' },
        joined_at: '2026-08-28T00:00:00Z',
      } satisfies MemberAdd),
    );
    expect(store.getState().membersById[USER_A]).toMatchObject({
      username: 'liddy',
      display_name: 'G. Gordon Liddy',
      nickname: null,
    });

    store.setState((s) => ({
      membersById: { ...s.membersById, [USER_A]: { ...s.membersById[USER_A]!, nickname: 'Gemstone' } },
      currentUser: { id: USER_A, username: 'liddy', display_name: 'G. Gordon Liddy' },
      channels: {
        [CHANNEL]: {
          id: CHANNEL,
          type: 'dm',
          recipients: [{ id: USER_A, username: 'liddy', display_name: 'G. Gordon Liddy' }],
        } as never,
      },
    }));

    applyGatewayEvent(
      store,
      dispatch('UserUpdate', { id: USER_A, username: 'liddy', display_name: 'Gordon' } satisfies UserUpdate),
    );
    const row = store.getState().membersById[USER_A]!;
    expect(row.display_name).toBe('Gordon');
    expect(row.nickname).toBe('Gemstone');
    expect(store.getState().currentUser?.display_name).toBe('Gordon');
    expect(store.getState().channels[CHANNEL]?.recipients?.[0]?.display_name).toBe('Gordon');

    // Clearing it (null) sticks; an older server's event with no key keeps it.
    applyGatewayEvent(
      store,
      dispatch('UserUpdate', { id: USER_A, username: 'liddy', display_name: null } satisfies UserUpdate),
    );
    expect(store.getState().membersById[USER_A]!.display_name).toBeNull();
    store.setState((s) => ({
      membersById: { ...s.membersById, [USER_A]: { ...s.membersById[USER_A]!, display_name: 'Kept' } },
    }));
    applyGatewayEvent(store, dispatch('UserUpdate', { id: USER_A, username: 'liddy' } satisfies UserUpdate));
    expect(store.getState().membersById[USER_A]!.display_name).toBe('Kept');
  });

  it('UserUpdate applies username/avatar to roster rows and the self record', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: USER_A, username: 'ay' },
        joined_at: '2026-08-28T00:00:00Z',
      } satisfies MemberAdd),
    );
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: USER_B, username: 'bee' },
        joined_at: '2026-08-28T00:00:00Z',
      } satisfies MemberAdd),
    );
    // nickname is per-workspace state the event does not carry — it must
    // survive the profile update.
    store.setState((s) => ({
      membersById: { ...s.membersById, [USER_A]: { ...s.membersById[USER_A]!, nickname: 'Ay Nick' } },
    }));
    store.setState({ currentUser: { id: USER_B, username: 'bee' } });

    applyGatewayEvent(
      store,
      dispatch('UserUpdate', {
        id: USER_A,
        username: 'ay-renamed',
        display_name: 'Ay New',
        avatar_url: '/api/v1/attachments/' + 'a'.repeat(64),
      } satisfies UserUpdate),
    );

    const a = store.getState().membersById[USER_A]!;
    expect(a.username).toBe('ay-renamed');
    expect(a.avatar_url).toBe('/api/v1/attachments/' + 'a'.repeat(64));
    expect(a.nickname).toBe('Ay Nick');

    // Self record: username converges; unknown ids are a no-op (no row
    // minted).
    applyGatewayEvent(
      store,
      dispatch('UserUpdate', {
        id: USER_B,
        username: 'bee-renamed',
        display_name: null,
        avatar_url: null,
      } satisfies UserUpdate),
    );
    expect(store.getState().currentUser).toMatchObject({ id: USER_B, username: 'bee-renamed' });

    // Self avatar converges too (the store record drives message-row avatars
    // when the roster row is missing) — this is the update that made the
    // panel and message body disagree.
    applyGatewayEvent(
      store,
      dispatch('UserUpdate', {
        id: USER_B,
        username: 'bee-renamed',
        display_name: null,
        avatar_url: '/api/v1/attachments/' + 'b'.repeat(64),
      } satisfies UserUpdate),
    );
    expect(store.getState().currentUser?.avatar_url).toBe(
      '/api/v1/attachments/' + 'b'.repeat(64),
    );

    applyGatewayEvent(
      store,
      dispatch('UserUpdate', {
        id: '7000000000000999',
        username: 'ghost',
        display_name: null,
        avatar_url: null,
      } satisfies UserUpdate),
    );
    expect(store.getState().membersById['7000000000000999']).toBeUndefined();
  });

  // Bot rename (2026-10-02): the server's UserUpdate for a bot used to put its
  // LABEL in `username`, so the @tag on every client turned into the display
  // name. People and bots now publish one shape — the handle in `username`,
  // the name in `display_name` — and a machine row keeps its display name in
  // `nickname` (the people page puts the label there).
  it('a bot rename keeps the @tag and lands the new label as the display name', () => {
    const store = createStateStore();
    const BOT = '99587434064379904';
    const AVATAR = '/api/v1/attachments/' + 'c'.repeat(64);
    applyGatewayEvent(
      store,
      dispatch('MemberAdd', {
        workspace_id: WORKSPACE,
        user: { id: BOT, username: 'hermes', display_name: 'Hermes', avatar_url: AVATAR },
        joined_at: '2026-10-02T00:00:00Z',
        nickname: null,
        roles: [],
        kind: 'bot',
        parent_user_id: USER_A,
      } satisfies MemberAdd),
    );

    applyGatewayEvent(
      store,
      dispatch('UserUpdate', {
        id: BOT,
        username: 'hermes',
        display_name: 'Hermes Prime',
        avatar_url: AVATAR,
      } satisfies UserUpdate),
    );
    expect(store.getState().membersById[BOT]).toMatchObject({
      username: 'hermes',
      display_name: 'Hermes Prime',
      nickname: null,
      avatar_url: AVATAR,
      kind: 'bot',
      parent_user_id: USER_A,
    });
  });

  it("a UserUpdate never clobbers a field it does not carry (avatar, a person's nickname)", () => {
    const store = createStateStore();
    const AVATAR = '/api/v1/attachments/' + 'd'.repeat(64);
    store.setState({
      membersById: {
        [USER_A]: {
          id: USER_A,
          username: 'ay',
          nickname: 'Ay in this workspace',
          avatar_url: AVATAR,
          joined_at: '2026-08-01T00:00:00Z',
          roles: [],
          kind: 'human',
        },
      },
      currentUser: { id: USER_A, username: 'ay', avatar_url: AVATAR },
    });
    const before = store.getState().membersById;

    // An older server's event: no display_name, no avatar_url key at all.
    applyGatewayEvent(store, dispatch('UserUpdate', { id: USER_A, username: 'ay' }));
    expect(store.getState().membersById).toBe(before);
    expect(store.getState().currentUser?.avatar_url).toBe(AVATAR);

    // A person's display_name is not their per-workspace nickname.
    applyGatewayEvent(
      store,
      dispatch('UserUpdate', { id: USER_A, username: 'ay', display_name: 'Ay Global', avatar_url: AVATAR }),
    );
    expect(store.getState().membersById[USER_A]).toMatchObject({
      nickname: 'Ay in this workspace',
      avatar_url: AVATAR,
    });
  });
});

describe('seq tracking', () => {
  it('tracks lastSeq from dispatch frames', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('PresenceUpdate', {
      user_id: USER_A,
      status: 'online',
      last_seen_at: '2026-08-28T00:00:00Z',
    }));
    expect(store.getState().lastSeq).toBe(1);
    applyGatewayEvent(store, dispatch('PresenceUpdate', {
      user_id: USER_A,
      status: 'idle',
      last_seen_at: '2026-08-28T00:00:01Z',
    }));
    expect(store.getState().lastSeq).toBe(2);
  });

  it('ignores replays of an already-applied seq (idempotence at the gate)', () => {
    const store = createStateStore();
    const evt = dispatch('MessageCreate', messageCreate({ id: '1000000000000041' }));
    applyGatewayEvent(store, evt);
    applyGatewayEvent(store, evt); // replayed dispatch, same s
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });
});

describe('READY resets the store; RESUMED applies replay (integration, AE2)', () => {
  it('fresh READY resets SESSION state only and sets the current user (lane D #1)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));
    applyGatewayEvent(
      store,
      dispatch('PresenceUpdate', {
        user_id: USER_B,
        status: 'online',
        last_seen_at: '2026-09-27T00:00:00Z',
      }),
    );
    const slice = store.getState().messagesByChannel[CHANNEL];
    applyGatewayEvent(
      store,
      dispatch('Ready', {
        v: 1,
        session_id: 'sess-1',
        resume_token: 'rt-1',
        heartbeat_interval: 41250,
        user: { id: USER_B, username: 'bee' },
      } satisfies Ready),
    );
    const s = store.getState();
    // The member's data stays on screen as stale content — the same slice,
    // not a copy — until its replacement lands whole.
    expect(s.messagesByChannel[CHANNEL]).toBe(slice);
    // Session-scoped state goes (the join snapshot refills presence).
    expect(s.presenceByUser).toEqual({});
    expect(s.currentUser).toEqual({ id: USER_B, username: 'bee' });
    expect(s.sessionStatus).toBe('ready');
  });

  it('a READY carrying the roster replaces workspaces/channels in the same write (lane D #5)', () => {
    const store = createStateStore();
    store.setState({
      workspaces: {
        W_OLD: { id: 'W_OLD', name: 'old', owner_id: USER_B, role_version: 0, created_at: 'x' },
      },
      channels: {
        C_OLD: {
          id: 'C_OLD',
          workspace_id: 'W_OLD',
          name: 'gone',
          type: 'text',
          topic: null,
          position: 0,
          last_message_id: null,
          created_at: 'x',
        },
      },
      messagesByChannel: { C_OLD: { items: [], oldestId: null, hasCompleteHistory: false } },
    });
    let writes = 0;
    const unsub = store.subscribe(() => {
      writes += 1;
    });
    applyGatewayEvent(
      store,
      dispatch('Ready', {
        v: 1,
        session_id: 'sess-r',
        resume_token: 'rt-r',
        heartbeat_interval: 41250,
        user: { id: USER_B, username: 'bee' },
        workspaces: [{ id: 'W1', name: 'one', owner_id: USER_B, created_at: 'y' }],
        channels: [
          {
            id: 'C1',
            workspace_id: 'W1',
            name: 'general',
            type: 0,
            parent_id: null,
            topic: null,
            position: 0,
            last_message_id: null,
          },
        ],
        dm_channels: [
          {
            id: 'D1',
            user_ids: [USER_B, '42'],
            recipients: [{ id: '42', username: 'a' }],
            last_message_id: null,
          },
        ],
      } satisfies Ready),
    );
    unsub();
    const s = store.getState();
    expect(writes).toBe(1);
    expect(Object.keys(s.workspaces)).toEqual(['W1']);
    expect(s.channels['C1']?.type).toBe('text');
    expect(s.channels['D1']?.type).toBe('dm');
    // What left the roster leaves the store, with its per-channel slices.
    expect(s.channels['C_OLD']).toBeUndefined();
    expect(s.messagesByChannel['C_OLD']).toBeUndefined();
    expect(s.rosterSource).toBe('server');
  });

  it('RESUMED marks the session resumed without a reset', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));
    const before = store.getState().messagesByChannel[CHANNEL]!.items.length;
    applyGatewayEvent(store, dispatch('Resumed', { replayed_events: 3, heartbeat_interval: 41250 } satisfies Resumed));
    expect(store.getState().sessionStatus).toBe('resumed');
    expect(store.getState().messagesByChannel[CHANNEL]!.items.length).toBe(before);
  });

  it('replayed events after resume apply from seq+1 with no duplicates and no loss', () => {
    const store = createStateStore();
    // Pre-disconnect traffic
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000051' })));
    // replayed batch: re-delivers the pre-disconnect id (new seq) plus two
    // genuinely new ids — the duplicate must be dropped, the new ones kept.
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000051' })));
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000052' })));
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000053' })));
    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items.map((m) => m.id)).toEqual([
      '1000000000000053',
      '1000000000000052',
      '1000000000000051',
    ]);
    expect(store.getState().lastSeq).toBe(4);
  });
});

describe('REST merge (mergeChannelMessages)', () => {
  it('merges a fetched page without duplicating overlap', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000061' })));
    mergeChannelMessages(store, CHANNEL, [
      messageCreate({ id: '1000000000000061' }),
      messageCreate({ id: '1000000000000060', content: 'older from REST' }),
    ]);
    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items.map((m) => m.id)).toEqual(['1000000000000061', '1000000000000060']);
  });

  it('tracks pagination cursors from the oldest merged item', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [
      messageCreate({ id: '1000000000000071' }),
      messageCreate({ id: '1000000000000070' }),
    ]);
    const slice = store.getState().messagesByChannel[CHANNEL];
    expect(slice!.oldestId).toBe('1000000000000070');
    expect(slice!.hasCompleteHistory).toBe(false);
  });

  it('advances the cursor on a SECOND page rather than latching the first', () => {
    // The regression: `oldestId` latched the first page's cursor forever, so a
    // consumer paging by it re-requested the page it already held, the merge
    // deduped it away, and paging stalled at two pages with no error. Covered
    // only on the first merge before, which is exactly the case that worked.
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [
      messageCreate({ id: '1000000000000071' }),
      messageCreate({ id: '1000000000000070' }),
    ]);
    expect(store.getState().messagesByChannel[CHANNEL]!.oldestId).toBe('1000000000000070');

    mergeChannelMessages(store, CHANNEL, [
      messageCreate({ id: '1000000000000069' }),
      messageCreate({ id: '1000000000000060' }),
    ]);
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    expect(slice.oldestId).toBe('1000000000000060');
    // …and the rows really are older, so the cursor and the rows agree.
    expect(slice.items[slice.items.length - 1]!.id).toBe('1000000000000060');
  });

  it('keeps the cursor when a page contributes no older row', () => {
    // A fully-filtered page (or an empty one) must not clear the cursor: it
    // learned nothing, and clearing it would restart paging from the newest.
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [messageCreate({ id: '1000000000000070' })]);
    mergeChannelMessages(store, CHANNEL, []);
    expect(store.getState().messagesByChannel[CHANNEL]!.oldestId).toBe('1000000000000070');
  });

  it('flags complete history when a short page arrives', () => {
    const store = createStateStore();
    mergeChannelMessages(store, CHANNEL, [messageCreate({ id: '1000000000000081' })], {
      isLastPage: true,
    });
    expect(store.getState().messagesByChannel[CHANNEL]!.hasCompleteHistory).toBe(true);
  });
});

describe('resetForFreshSession', () => {
  it('clears caches from the prior session', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate()));
    resetForFreshSession(store);
    const s = store.getState();
    expect(s.messagesByChannel).toEqual({});
    expect(s.threadsById).toEqual({});
    expect(s.presenceByUser).toEqual({});
    expect(s.unreadByChannel).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Write economy: zustand compares the PARTIAL handed to `setState`, so an
// updater returning `{}` (or unchanged slice references) still allocates a
// fresh top-level state and notifies every subscriber — and every subscriber
// re-runs its selector. A dispatch must land as ONE write, and a branch that
// changed nothing must not write at all.
// ---------------------------------------------------------------------------

describe('dispatch write economy', () => {
  /** A store with one hydrated channel and a current user who is NOT the author. */
  function hydratedStore() {
    const store = createStateStore();
    store.setState({
      currentUser: { id: USER_B, username: 'bee' },
      channels: {
        [CHANNEL]: {
          id: CHANNEL,
          workspace_id: WORKSPACE,
          name: 'general',
          type: 'text',
          topic: null,
          position: 0,
          last_message_id: null,
          created_at: '2026-08-28T00:00:00Z',
        },
      },
    });
    return store;
  }

  /** Store notifications delivered while `run` executes. */
  function notificationsFor(store: ReturnType<typeof createStateStore>, run: () => void): number {
    let count = 0;
    const unsubscribe = store.subscribe(() => {
      count += 1;
    });
    try {
      run();
    } finally {
      unsubscribe();
    }
    return count;
  }

  it('lands one MessageCreate as a single store write', () => {
    const store = hydratedStore();
    const writes = notificationsFor(store, () => {
      applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000000000000001' })));
    });
    expect(writes).toBe(1);
    expect(store.getState().lastSeq).toBe(1);
  });

  it('lands one ThreadMessageCreate as a single store write', () => {
    const store = hydratedStore();
    applyGatewayEvent(
      store,
      dispatch('ThreadCreate', {
        id: THREAD,
        channel_id: CHANNEL,
        name: 't',
        created_by: USER_A,
        created_at: '2026-08-28T00:04:00Z',
      } satisfies ThreadCreate),
    );
    const writes = notificationsFor(store, () => {
      applyGatewayEvent(
        store,
        dispatch('ThreadMessageCreate', {
          id: '1000000000000031',
          channel_id: CHANNEL,
          thread_id: THREAD,
          author_id: USER_A,
          content: 'reply',
          created_at: '2026-08-28T00:05:00Z',
          edited_at: null,
        } satisfies ThreadMessageCreate),
      );
    });
    expect(writes).toBe(1);
  });

  it('does not notify for a dispatch that changes nothing it models', () => {
    const store = hydratedStore();
    // MESSAGE_UPDATE for a message the store has never held.
    const update = notificationsFor(store, () => {
      applyGatewayEvent(
        store,
        dispatch('MessageUpdate', {
          id: '9999999999999999',
          channel_id: CHANNEL,
          thread_id: null,
          content: 'ghost',
          edited_at: null,
        }),
      );
    });
    // MESSAGE_DELETE for the same absent message.
    const remove = notificationsFor(store, () => {
      applyGatewayEvent(
        store,
        dispatch('MessageDelete', { id: '9999999999999999', channel_id: CHANNEL, thread_id: null }),
      );
    });
    expect(update).toBe(0);
    expect(remove).toBe(0);
  });

  it('advances lastSeq for accepted pass-through dispatches (the reaction seams gate on it)', () => {
    const store = hydratedStore();
    const frame = dispatch('TypingStart', { channel_id: CHANNEL, user_id: USER_A });
    const writes = notificationsFor(store, () => applyGatewayEvent(store, frame));
    // Lane D #17: the watermark advances in place — a typing tick changes
    // nothing a subscriber renders, so it notifies nobody.
    expect(writes).toBe(0);
    expect(store.getState().lastSeq).toBe(frame.s);
  });
});

// ---------------------------------------------------------------------------
// Ordered insert: newest-first without copying + sorting the whole slice.
// ---------------------------------------------------------------------------

/**
 * Counts comparator invocations `Array.prototype.sort` makes over MESSAGE ROWS
 * (rows carry a string `id`) while `run` executes. The prototype is restored
 * in a finally block; unrelated sorts are not counted.
 */
function countMessageRowSortWork(run: () => void): { sorts: number; comparisons: number } {
  const original = Array.prototype.sort;
  let sorts = 0;
  let comparisons = 0;
  const patched = function (
    this: unknown[],
    compareFn?: (a: unknown, b: unknown) => number,
  ): unknown[] {
    const isRowArray = Array.isArray(this) && typeof (this[0] as { id?: unknown })?.id === 'string';
    if (isRowArray) {
      sorts += 1;
      if (typeof compareFn === 'function') {
        const counted = (a: unknown, b: unknown): number => {
          comparisons += 1;
          return compareFn(a, b);
        };
        return original.call(this, counted as never);
      }
    }
    return original.call(this, compareFn as never);
  };
  Array.prototype.sort = patched as unknown as typeof Array.prototype.sort;
  try {
    run();
  } finally {
    Array.prototype.sort = original;
  }
  return { sorts, comparisons };
}

/** `count` message rows, newest-first, ids descending from `base`. */
function rowRange(count: number, base: number): Message[] {
  const rows: Message[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(messageCreate({ id: String(base - i) }) as Message);
  }
  return rows;
}

describe('message ordering (ordered insert)', () => {
  it('inserts at the head, in the middle, and at the tail', () => {
    const store = createStateStore();
    store.setState({
      messagesByChannel: {
        [CHANNEL]: {
          items: rowRange(3, 1000),
          oldestId: '998',
          hasCompleteHistory: true,
        },
      },
    });

    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '2000' }))); // head
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '999' }))); // middle
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '997' }))); // tail
    expect(store.getState().messagesByChannel[CHANNEL]!.items.map((m) => m.id)).toEqual([
      '2000',
      '1000',
      '999',
      '998',
      '997',
    ]);
  });

  it('drops a duplicate id without re-identifying the slice', () => {
    const store = createStateStore();
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000' })));
    const slice = store.getState().messagesByChannel[CHANNEL]!;
    applyGatewayEvent(store, dispatch('MessageCreate', messageCreate({ id: '1000' })));
    expect(store.getState().messagesByChannel[CHANNEL]).toBe(slice);
  });

  it('keeps 250 out-of-order arrivals sorted with no comparator sweep', () => {
    const store = createStateStore();
    // Uniform-width ids (one generator's snowflakes share a width).
    const ordered = rowRange(250, 9_000_000);
    // A shuffled prefix: even ids last, odd ids reversed — nothing in order.
    const arrivals = [...ordered.filter((_, i) => i % 2 === 0)].reverse().concat(
      ordered.filter((_, i) => i % 2 === 1),
    );
    const work = countMessageRowSortWork(() => {
      for (const row of arrivals) {
        applyGatewayEvent(store, dispatch('MessageCreate', row));
      }
    });

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(250);
    // Newest-first under the documented snowflake rule (length, then lexicographic).
    expect(items.map((m) => m.id)).toEqual([...items].sort(compareNewestFirst).map((m) => m.id));
    expect(work.comparisons).toBe(0);
    expect(work.sorts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// READ_STATE_SYNC (notifications plan U1) — the cold-start hydration.
//
// Without this branch the unread slices were wiped on every READY and nothing
// refilled them, so a reload re-showed what the member had already read.
// ---------------------------------------------------------------------------

describe('ReadStateSync', () => {
  const CH = '9100000000000001';
  const CH2 = '9100000000000002';

  it('hydrates read state for a channel the client has never seen', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [{ channel_id: CH, last_read_id: '9100000000000010', unread_floor: null }],
      }),
    );

    expect(store.getState().unreadByChannel[CH]).toMatchObject({
      last_read_id: '9100000000000010',
    });
  });

  it('hydrates several channels in one sync', () => {
    const store = createStateStore();
    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [
          { channel_id: CH, last_read_id: '9100000000000010', unread_floor: null },
          { channel_id: CH2, last_read_id: '9100000000000020', unread_floor: null },
        ],
      }),
    );

    expect(store.getState().unreadByChannel[CH]?.last_read_id).toBe('9100000000000010');
    expect(store.getState().unreadByChannel[CH2]?.last_read_id).toBe('9100000000000020');
  });

  it('does NOT regress a watermark the client is already further along on', () => {
    const store = createStateStore();
    // The client reads ahead locally (it was looking at the channel).
    // Seeded directly: MESSAGE_ACK only clears a slice the store already has,
    // so it cannot stand in for "the client is ahead".
    store.setState({
      unreadByChannel: {
        [CH]: { last_read_id: '9100000000000099', unread_count: 0, mention_count: 0 },
      },
    });

    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [{ channel_id: CH, last_read_id: '9100000000000010', unread_floor: null }],
      }),
    );

    expect(store.getState().unreadByChannel[CH]?.last_read_id).toBe('9100000000000099');
  });

  it('advances a watermark the server is further along on', () => {
    const store = createStateStore();
    store.setState({
      unreadByChannel: {
        [CH]: { last_read_id: '9100000000000005', unread_count: 0, mention_count: 0 },
      },
    });

    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [{ channel_id: CH, last_read_id: '9100000000000050', unread_floor: null }],
      }),
    );

    expect(store.getState().unreadByChannel[CH]?.last_read_id).toBe('9100000000000050');
  });

  it('an empty sync hydrates nothing and leaves existing state alone', () => {
    const store = createStateStore();
    store.setState({
      unreadByChannel: {
        [CH]: { last_read_id: '9100000000000007', unread_count: 2, mention_count: 1 },
      },
    });
    const before = store.getState().unreadByChannel[CH];

    applyGatewayEvent(store, dispatch('ReadStateSync', { channels: [] }));

    expect(store.getState().unreadByChannel[CH]).toEqual(before);
  });

  it('a null server watermark does not erase a locally known one', () => {
    const store = createStateStore();
    store.setState({
      unreadByChannel: {
        [CH]: { last_read_id: '9100000000000042', unread_count: 0, mention_count: 0 },
      },
    });

    applyGatewayEvent(
      store,
      dispatch('ReadStateSync', {
        channels: [{ channel_id: CH, last_read_id: null, unread_floor: null }],
      }),
    );

    expect(store.getState().unreadByChannel[CH]?.last_read_id).toBe('9100000000000042');
  });
});

// ---------------------------------------------------------------------------
// Synthetic-seq reconciles vs the replay gate (#143)
//
// apps/web stamps local REST reconciles (thread-history backfill,
// optimistic sends/edits, avatar convergence) at s >= SYNTHETIC_SEQ_FLOOR + 1
// and feeds them through applyGatewayEvent. Real gateway seqs are per-session
// integers counting from 1 (server: Cytale.Gateway.Session.buffer_event,
// `next_seq = seq + 1` from 0; READY and RESUMED are sequence-less control
// frames, s: 0). The synthetic space must therefore never join the real
// stream's watermark: lastSeq moves only for real dispatches, or a backfill
// raises lastSeq above every real seq and the gate silently drops all live
// traffic until the next Ready/Resumed.
// ---------------------------------------------------------------------------

describe('synthetic-seq reconcile vs the replay gate (#143)', () => {
  /** Explicit real-stream seq (the `dispatch` helper above is fine too; this
   * one keeps the real vs synthetic split visible in each call). */
  function real(t: string, s: number, d: unknown): GatewayEvent {
    return { op: 0, t, s, d } as unknown as GatewayEvent;
  }

  /** What apps/web's shared counter stamps: FLOOR + 1, FLOOR + 2, ... */
  function synthetic(t: string, n: number, d: unknown): GatewayEvent {
    return { op: 0, t, s: SYNTHETIC_SEQ_FLOOR + n, d } as unknown as GatewayEvent;
  }

  function readyFrame(s: number): GatewayEvent {
    return {
      op: 0,
      t: 'Ready',
      s,
      d: {
        v: 1,
        session_id: 'sess-143',
        resume_token: 'rt-143',
        heartbeat_interval: 41250,
        user: { id: USER_B, username: 'bee' },
      } satisfies Ready,
    } as unknown as GatewayEvent;
  }

  function threadReply(id: string, threadId: string, content: string): ThreadMessageCreate {
    return {
      id,
      channel_id: CHANNEL,
      thread_id: threadId,
      author_id: USER_A,
      content,
      created_at: '2026-09-18T00:00:00Z',
      edited_at: null,
    };
  }

  it('a loadReplies-style backfill applies WITHOUT advancing lastSeq', () => {
    const store = createStateStore();
    applyGatewayEvent(store, readyFrame(0)); // READY is sequence-less (s: 0)
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate()));
    expect(store.getState().lastSeq).toBe(1);

    // The backfill: two thread replies stamped above the synthetic floor.
    applyGatewayEvent(
      store,
      synthetic('ThreadMessageCreate', 1, threadReply('8100000000000001', THREAD, 'backfill one')),
    );
    applyGatewayEvent(
      store,
      synthetic('ThreadMessageCreate', 2, threadReply('8100000000000002', THREAD, 'backfill two')),
    );

    // The rows landed (the reconcile still applied)…
    expect(store.getState().messagesByThread[THREAD]!.items).toHaveLength(2);
    // …but the synthetic space never joined the real stream's watermark.
    expect(store.getState().lastSeq).toBe(1);
  });

  it('THE DISCRIMINATOR: a real dispatch below the synthetic floor still applies after a backfill', () => {
    const store = createStateStore();
    applyGatewayEvent(store, readyFrame(0));
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate()));
    applyGatewayEvent(
      store,
      synthetic('ThreadMessageCreate', 1, threadReply('8100000000000001', THREAD, 'backfill one')),
    );
    applyGatewayEvent(
      store,
      synthetic('ThreadMessageCreate', 2, threadReply('8100000000000002', THREAD, 'backfill two')),
    );

    // Live traffic continues on the healthy socket: real seq 2, far below the
    // synthetic floor. This is the event the poisoned gate used to swallow.
    const live = real('MessageCreate', 2, messageCreate({ id: '1000000000000002', content: 'live' }));
    applyGatewayEvent(store, live);

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items.some((m) => m.id === '1000000000000002')).toBe(true);
    expect(store.getState().lastSeq).toBe(2);
  });

  it('synthetic edits converge without poisoning the gate', () => {
    const store = createStateStore();
    applyGatewayEvent(store, readyFrame(0));
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate()));
    applyGatewayEvent(
      store,
      synthetic('MessageUpdate', 1, {
        id: '1000000000000001',
        channel_id: CHANNEL,
        thread_id: null,
        content: 'edited',
        edited_at: '2026-09-18T01:00:00Z',
      }),
    );
    expect(store.getState().messagesByChannel[CHANNEL]!.items[0]!.content).toBe('edited');
    expect(store.getState().lastSeq).toBe(1);

    // The real stream still dedupes replays exactly as before.
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate()));
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });

  it('a fresh READY still resets the stream after a backfill (reset path)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, readyFrame(0));
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate()));
    applyGatewayEvent(
      store,
      synthetic('ThreadMessageCreate', 1, threadReply('8100000000000001', THREAD, 'backfill one')),
    );

    applyGatewayEvent(store, readyFrame(0)); // re-Identify: fresh stream
    expect(store.getState().lastSeq).toBe(0);
    // Lane D #1: the member's data survives READY as stale content (the
    // consumer refreshes it); only the stream position resets.
    expect(store.getState().messagesByThread[THREAD]).toBeDefined();
    expect(store.getState().sessionStatus).toBe('ready');
    // …and the fresh stream's seq 1 applies (the watermark really reset).
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate({ id: '1000000000000999' })));
    expect(store.getState().lastSeq).toBe(1);
  });

  it('RESUMED re-opens the real stream after a backfill (reset path)', () => {
    const store = createStateStore();
    applyGatewayEvent(store, readyFrame(0));
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate()));
    applyGatewayEvent(
      store,
      synthetic('ThreadMessageCreate', 1, threadReply('8100000000000001', THREAD, 'backfill one')),
    );

    applyGatewayEvent(
      store,
      real('Resumed', 0, { replayed_events: 1, heartbeat_interval: 41250 } satisfies Resumed),
    );
    // Post-resume replay: seq 1 re-delivered — the server replays the SAME
    // envelope, whose id dedupes against the retained row (RESUMED never
    // clears transients)…
    applyGatewayEvent(store, real('MessageCreate', 1, messageCreate()));
    // …and the live edge continues below the synthetic floor.
    applyGatewayEvent(
      store,
      real('MessageCreate', 2, messageCreate({ id: '1000000000000062', content: 'after resume' })),
    );
    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items.map((m) => m.id)).toEqual(['1000000000000062', '1000000000000001']);
    expect(store.getState().lastSeq).toBe(2);
  });
});
