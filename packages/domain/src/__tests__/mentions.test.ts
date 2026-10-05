/**
 * The shared mention grammar. Four copies had drifted before this — the point
 * of one module is that a member mentioned one way is tellable everywhere.
 */

import { describe, expect, it } from 'vitest';

import {
  mentionedUserIds,
  mentionsEveryone,
  mentionsHere,
  mentionsPlainUser,
  mentionsUser,
} from '../mentions.js';

describe('mentionedUserIds', () => {
  it('extracts a plain token', () => {
    expect(mentionedUserIds('hey <@123456789> look')).toEqual(['123456789']);
  });

  // The nickname form is the drift this module exists to end: some copies
  // accepted it and some did not, so the same message was tellable on one
  // surface and invisible on another.
  it('extracts the nickname form', () => {
    expect(mentionedUserIds('hey <@!123456789> look')).toEqual(['123456789']);
  });

  it('de-duplicates and keeps first-appearance order', () => {
    expect(mentionedUserIds('<@111> and <@222> and <@111>')).toEqual(['111', '222']);
  });

  it('a bare @name is not a mention', () => {
    expect(mentionedUserIds('hey @max are you there')).toEqual([]);
  });

  it('rejects a token longer than a snowflake', () => {
    expect(mentionedUserIds('<@12345678901234567890>')).toEqual([]);
  });

  it('yields nothing for empty or absent content', () => {
    expect(mentionedUserIds('')).toEqual([]);
    expect(mentionedUserIds(null)).toEqual([]);
    expect(mentionedUserIds(undefined)).toEqual([]);
  });
});

describe('mentionsUser', () => {
  it('matches either token form', () => {
    expect(mentionsUser('ping <@42>', '42')).toBe(true);
    expect(mentionsUser('ping <@!42>', '42')).toBe(true);
  });

  it('does not match a different id, or a name match', () => {
    expect(mentionsUser('ping <@43>', '42')).toBe(false);
    expect(mentionsUser('ping @jordan', '42')).toBe(false);
  });
});

describe('mentionsPlainUser', () => {
  // The allocation-free variant `state/reconcile`'s unread accrual uses. It is
  // the SAME grammar as `mentionsUser` minus the nickname form — the contract
  // is "the token the server stores", so these two must agree on every plain
  // token and differ only where a `!` is involved.
  it('matches the plain token and agrees with mentionsUser there', () => {
    expect(mentionsPlainUser('ping <@42>', '42')).toBe(true);
    expect(mentionsPlainUser('a <@42> b <@43>', '43')).toBe(true);
    expect(
      mentionedUserIds('<@7> <@42>').every(
        (id) => mentionsPlainUser('<@7> <@42>', id) === mentionsUser('<@7> <@42>', id),
      ),
    ).toBe(true);
  });

  it('deliberately excludes the nickname form', () => {
    expect(mentionsPlainUser('ping <@!42>', '42')).toBe(false);
    expect(mentionsUser('ping <@!42>', '42')).toBe(true);
  });

  it('does not match a longer id, a truncated token, or a name', () => {
    expect(mentionsPlainUser('ping <@421>', '42')).toBe(false);
    expect(mentionsPlainUser('ping <@42', '42')).toBe(false);
    expect(mentionsPlainUser('ping @jordan', '42')).toBe(false);
  });

  it('rejects an id no token could carry, and absent content', () => {
    expect(mentionsPlainUser('ping <@42>', '42'.repeat(10))).toBe(false);
    expect(mentionsPlainUser(null, '42')).toBe(false);
    expect(mentionsPlainUser(undefined, '42')).toBe(false);
    expect(mentionsPlainUser('', '42')).toBe(false);
  });
});

describe('broadcast tokens', () => {
  it('recognizes each', () => {
    expect(mentionsEveryone('heads up @everyone')).toBe(true);
    expect(mentionsEveryone('heads up @here')).toBe(false);
    expect(mentionsHere('heads up @here')).toBe(true);
  });

  // Bounded, or a longer word starting with the token would notify a workspace.
  it('does not fire on a word that merely starts with the token', () => {
    expect(mentionsEveryone('@everyoneelse should see this')).toBe(false);
    expect(mentionsHere('@heretical')).toBe(false);
  });

  it('fires at the very end of the content', () => {
    expect(mentionsEveryone('for @everyone')).toBe(true);
  });
});
