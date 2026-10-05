/**
 * The ONE author resolver (authorIdentity.ts) — people, bots, webhooks and the
 * unknown, resolved the same way everywhere a name is shown (2026-10-02).
 */
import { describe, expect, it } from 'vitest';

import { actorName, resolveAuthor, UNKNOWN_ACTOR, type AuthorRoster } from '../authorIdentity.js';

const ME = '7000000000000002';
const BOT = '99587434064379904';
const ROSTER: AuthorRoster = {
  [ME]: { username: 'me', nickname: 'Me Myself', avatar_url: '/me.png', kind: 'human' },
  [BOT]: { username: 'hermes', nickname: 'Hermes', avatar_url: '/bot.png', kind: 'bot', parent_user_id: ME },
};

describe('resolveAuthor', () => {
  it('a bot resolves exactly like a person: display name, tag, avatar, badge, owner', () => {
    expect(resolveAuthor(ROSTER, BOT)).toEqual({
      name: 'Hermes',
      tag: 'hermes',
      avatarUrl: '/bot.png',
      kind: 'bot',
      parentName: 'Me Myself',
      known: true,
    });
    expect(resolveAuthor(ROSTER, ME)).toMatchObject({ name: 'Me Myself', tag: 'me', kind: 'human', known: true });
  });

  it('a webhook override wins over the roster row behind the id, and badges as a webhook', () => {
    const who = resolveAuthor(ROSTER, ME, { override: { username: 'CI Hook', avatar_url: 'https://x/y.png' } });
    expect(who).toMatchObject({ name: 'CI Hook', tag: undefined, kind: 'webhook', known: true });
    // Stored-only: a webhook's remote avatar is never rendered.
    expect(who.avatarUrl).toBeNull();
  });

  it('falls back to the session self, then a fallback roster, then a wire name', () => {
    expect(resolveAuthor({}, ME, { self: { id: ME, username: 'me', avatar_url: '/s.png' } })).toMatchObject({
      name: 'me',
      avatarUrl: '/s.png',
      known: true,
    });
    expect(resolveAuthor({}, '5', { fallbackRoster: { '5': { username: 'peer' } } })).toMatchObject({
      name: 'peer',
      known: true,
    });
    expect(resolveAuthor({}, '5', { wireName: 'wired' })).toMatchObject({ name: 'wired', known: true });
  });

  it('an unknown id is marked unknown (the row keeps the id as its last resort)', () => {
    expect(resolveAuthor(ROSTER, '123')).toMatchObject({ name: '123', known: false, kind: undefined });
  });
});

describe('actorName', () => {
  it('names a known actor, and says "Someone" — never an id, never a stand-in — otherwise', () => {
    expect(actorName(ROSTER, BOT)).toBe('Hermes');
    expect(actorName(ROSTER, '123')).toBe(UNKNOWN_ACTOR);
    expect(actorName(ROSTER, null)).toBe('Someone');
  });
});
