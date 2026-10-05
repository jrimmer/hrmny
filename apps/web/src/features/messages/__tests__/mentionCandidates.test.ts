/**
 * The `@`-mention typeahead's decision layer (#66 follow-up): when the palette
 * opens, who it offers, and in what order. Pure functions, so the trigger
 * rules and the ranking bands are pinned without driving Lexical.
 */

import { describe, expect, it } from 'vitest';

import { createStateStore } from '@cytale/state';

import {
  MENTION_LIMIT,
  channelCandidatesFor,
  channelQueryOf,
  mentionCandidatesFor,
  mentionTagFor,
  rankChannelCandidates,
  mentionDisplayName,
  mentionQueryOf,
  rankMentionCandidates,
  type MentionCandidate,
} from '../mentionCandidates.js';

const candidate = (username: string, nickname: string | null = null): MentionCandidate => ({
  id: `id-${username}`,
  username,
  nickname,
});

describe('mentionQueryOf — the trigger rule', () => {
  it('opens on a trailing @, including a bare one', () => {
    expect(mentionQueryOf('@')).toBe('');
    expect(mentionQueryOf('hi @')).toBe('');
    expect(mentionQueryOf('@ma')).toBe('ma');
    expect(mentionQueryOf('hey @max.')).toBe('max.');
  });

  it('follows the text across a line break (the palette works on any line)', () => {
    expect(mentionQueryOf('first line\n@ma')).toBe('ma');
  });

  it('does NOT fire inside a word — emails and handles stay prose', () => {
    // The whole point of requiring a word boundary: `me@example.com` must not
    // open a member picker mid-sentence.
    expect(mentionQueryOf('write to me@example.com')).toBeNull();
    expect(mentionQueryOf('me@exa')).toBeNull();
    expect(mentionQueryOf('foo@bar')).toBeNull();
  });

  it('closes when the token ends (space, punctuation that ends the token)', () => {
    expect(mentionQueryOf('@max ')).toBeNull();
    expect(mentionQueryOf('@max hello')).toBeNull();
    expect(mentionQueryOf('plain text')).toBeNull();
    expect(mentionQueryOf('')).toBeNull();
  });

  it('caps the query at username length', () => {
    const long = 'a'.repeat(40);
    expect(mentionQueryOf(`@${long}`)).toBeNull();
    expect(mentionQueryOf(`@${'a'.repeat(32)}`)).toBe('a'.repeat(32));
  });
});

describe('rankMentionCandidates — Discord banding', () => {
  // #168: a person is found by the name they are SHOWN by.
  it('matches a display name like a nickname, and shows it ahead of the handle', () => {
    const liddy: MentionCandidate = { ...candidate('liddy'), display_name: 'G. Gordon Liddy' };
    const ranked = rankMentionCandidates('g. gor', [candidate('hunt'), liddy]);
    expect(ranked.map((c) => c.username)).toEqual(['liddy']);
    expect(rankMentionCandidates('gordon', [liddy]).map((c) => c.username)).toEqual(['liddy']);
    expect(mentionDisplayName(liddy)).toBe('G. Gordon Liddy');
    expect(mentionDisplayName({ ...liddy, nickname: 'Gemstone' })).toBe('Gemstone');
  });

  it('ranks username prefixes above nickname prefixes above substrings', () => {
    const ranked = rankMentionCandidates('ma', [
      candidate('zoe', 'maxie'), // nickname prefix
      candidate('amanda'), // substring
      candidate('max'), // username prefix
      candidate('marcus'), // username prefix
      candidate('unrelated'),
    ]);

    expect(ranked.map((c) => c.username)).toEqual(['marcus', 'max', 'zoe', 'amanda']);
  });

  it('is case-insensitive and alphabetical inside a band', () => {
    const ranked = rankMentionCandidates('MA', [
      candidate('Max'),
      candidate('marcus'),
      candidate('MANDY'),
    ]);
    expect(ranked.map((c) => c.username)).toEqual(['MANDY', 'marcus', 'Max']);
  });

  it('a bare @ offers the roster in name order', () => {
    const ranked = rankMentionCandidates('', [
      candidate('zed'),
      candidate('ann'),
      candidate('moe'),
    ]);
    expect(ranked.map((c) => c.username)).toEqual(['ann', 'moe', 'zed']);
  });

  it('drops non-matches and honours the limit', () => {
    expect(rankMentionCandidates('nobody', [candidate('max')])).toEqual([]);

    const many = Array.from({ length: MENTION_LIMIT + 4 }, (_, i) => candidate(`mate${i}`));
    expect(rankMentionCandidates('mate', many)).toHaveLength(MENTION_LIMIT);
  });

  it('a nickname-only match still resolves (display name prefers the nickname)', () => {
    const [only] = rankMentionCandidates('captain', [candidate('max', 'Captain Max')]);
    expect(only).toBeDefined();
    expect(mentionDisplayName(only!)).toBe('Captain Max');
    expect(mentionDisplayName(candidate('solo'))).toBe('solo');
  });
});

describe('mentionCandidatesFor — the roster read', () => {
  const store = (state: unknown) =>
    ({ getState: () => state }) as unknown as Parameters<typeof mentionCandidatesFor>[0];

  it('projects the workspace roster with nicknames', () => {
    const candidates = mentionCandidatesFor(
      store({
        memberIdsByWorkspace: { ws1: ['1', '2'] },
        membersById: {
          '1': { id: '1', username: 'ann', nickname: null, display_name: 'Ann', avatar_url: '/a.png', kind: 'human' },
          '2': { id: '2', username: 'bob', nickname: null, kind: 'bot' },
        },
        // The nickname is this workspace's (#169), never the shared row's.
        nicknamesByWorkspace: { ws1: { '1': 'Annie' } },
      }),
      'ws1',
    );

    // The avatar and kind ride along: the palette row draws the shared Avatar.
    // The display name rides too (#168): the palette names people by it.
    expect(candidates).toEqual([
      { id: '1', username: 'ann', nickname: 'Annie', display_name: 'Ann', avatar_url: '/a.png', kind: 'human' },
      { id: '2', username: 'bob', nickname: null, display_name: null, avatar_url: null, kind: 'bot' },
    ]);
  });

  it('is empty without a workspace, and skips ids the roster has not hydrated', () => {
    const state = {
      memberIdsByWorkspace: { ws1: ['1', 'ghost'] },
      membersById: { '1': { id: '1', username: 'ann', nickname: null } },
    };

    expect(mentionCandidatesFor(store(state), null)).toEqual([]);
    expect(mentionCandidatesFor(store(state), undefined)).toEqual([]);
    expect(mentionCandidatesFor(store(state), 'ws1')).toHaveLength(1);
    expect(mentionCandidatesFor(store(state), 'unknown-ws')).toEqual([]);
  });
});

describe('channelQueryOf (# trigger)', () => {
  it('opens on a # at a word boundary, bare or with a query', () => {
    expect(channelQueryOf('#')).toBe('');
    expect(channelQueryOf('see #gen')).toBe('gen');
    expect(channelQueryOf('line one\n#dev-ops')).toBe('dev-ops');
  });

  it('never fires inside a word, and a space closes it', () => {
    expect(channelQueryOf('C#')).toBeNull();
    expect(channelQueryOf('issue#4')).toBeNull();
    expect(channelQueryOf('https://x.dev/#frag')).toBeNull();
    expect(channelQueryOf('# heading')).toBeNull();
  });
});

describe('rankChannelCandidates', () => {
  const ch = (name: string) => ({ id: `c-${name}`, name });

  it('prefix matches first, then substrings, each alphabetical; bare # lists all', () => {
    const all = [ch('random'), ch('general'), ch('dev-general'), ch('gentoo')];
    expect(rankChannelCandidates('gen', all).map((c) => c.name)).toEqual(['general', 'gentoo', 'dev-general']);
    expect(rankChannelCandidates('', all).map((c) => c.name)).toEqual(['dev-general', 'general', 'gentoo', 'random']);
    expect(rankChannelCandidates('GEN', all)[0]!.name).toBe('general');
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ch(`c${String(i).padStart(2, '0')}`));
    expect(rankChannelCandidates('', many)).toHaveLength(MENTION_LIMIT);
  });
});

describe('channelCandidatesFor', () => {
  it("offers only this workspace's text channels", () => {
    const store = createStateStore();
    store.setState({
      channels: {
        a: { id: 'a', name: 'general', workspace_id: 'ws1', type: 'text' },
        b: { id: 'b', name: 'Projects', workspace_id: 'ws1', type: 'category' },
        c: { id: 'c', name: 'elsewhere', workspace_id: 'ws2', type: 'text' },
        d: { id: 'd', name: '', workspace_id: null, type: 'dm' },
      },
    } as never);
    expect(channelCandidatesFor(store, 'ws1')).toEqual([{ id: 'a', name: 'general' }]);
    expect(channelCandidatesFor(store, null)).toEqual([]);
  });
});

describe('mentionTagFor', () => {
  it('is the username, never the nickname; self resolves too', () => {
    const store = createStateStore();
    store.setState({
      currentUser: { id: 'me', username: 'myself' },
      membersById: { u1: { id: 'u1', username: 'zoe', nickname: 'Zoe Z' } },
    } as never);
    expect(mentionTagFor(store, 'u1')).toBe('zoe');
    expect(mentionTagFor(store, 'me')).toBe('myself');
    expect(mentionTagFor(store, 'nobody')).toBeUndefined();
  });
});
