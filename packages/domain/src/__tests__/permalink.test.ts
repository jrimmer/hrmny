/**
 * #114 — the permalink grammar, as one contract.
 *
 * This is the module that replaces two spellings of the same address with
 * one, so the tests pin BOTH boundaries' accepted language plus the
 * round-trip between them: what `deepLink.ts` (scheme) and the hash router
 * (path) feed in, and what `buildMessagePermalink` writes out. A link the
 * builder mints must parse back to what it was minted from — otherwise the
 * Copy Link button would be writing addresses the route cannot read.
 *
 * #118 added the second spelling: the builder writes base62 ids now, and the
 * parser reads BOTH that and the decimal one every pre-#118 link carries, so
 * the suite pins the pair rather than one form ("base62 reads" + "legacy
 * decimal still reads" are the same target).
 */

import { describe, expect, it } from 'vitest';

import {
  buildMessagePermalink,
  buildPermalinkPath,
  parsePermalinkPath,
  type PermalinkTarget,
} from '../permalink.js';

describe('parsePermalinkPath — the accepted language', () => {
  it('parses a message address in a workspace channel', () => {
    expect(parsePermalinkPath('/workspace/1001/channel/2002/message/3003')).toEqual({
      kind: 'message',
      workspaceId: '1001',
      channelId: '2002',
      threadId: undefined,
      messageId: '3003',
    });
  });

  it('parses it with or without the leading slash (the same path the OS hands over)', () => {
    expect(parsePermalinkPath('workspace/1001/channel/2002/message/3003')).toEqual(
      parsePermalinkPath('/workspace/1001/channel/2002/message/3003'),
    );
  });

  it('parses a thread reply, addressed as a segment between channel and message', () => {
    expect(parsePermalinkPath('/workspace/1001/channel/2002/thread/4004/message/3003')).toEqual({
      kind: 'message',
      workspaceId: '1001',
      channelId: '2002',
      threadId: '4004',
      messageId: '3003',
    });
  });

  it('parses a DM message: a channel id is a complete address with no workspace', () => {
    expect(parsePermalinkPath('/channel/2002/message/3003')).toEqual({
      kind: 'message',
      workspaceId: undefined,
      channelId: '2002',
      threadId: undefined,
      messageId: '3003',
    });
  });

  it('parses the shorter nesting forms (workspace, channel, thread)', () => {
    expect(parsePermalinkPath('/workspace/1001')).toEqual({
      kind: 'workspace',
      workspaceId: '1001',
      channelId: undefined,
      threadId: undefined,
      messageId: undefined,
    });
    expect(parsePermalinkPath('/workspace/1001/channel/2002')).toEqual({
      kind: 'channel',
      workspaceId: '1001',
      channelId: '2002',
      threadId: undefined,
      messageId: undefined,
    });
    expect(parsePermalinkPath('/workspace/1001/channel/2002/thread/4004')).toEqual({
      kind: 'thread',
      workspaceId: '1001',
      channelId: '2002',
      threadId: '4004',
      messageId: undefined,
    });
    expect(parsePermalinkPath('/channel/2002')).toEqual({
      kind: 'channel',
      workspaceId: undefined,
      channelId: '2002',
      threadId: undefined,
      messageId: undefined,
    });
  });

  it('rejects a child segment without its parent', () => {
    // A message id with no channel has no route to land on.
    expect(parsePermalinkPath('/workspace/1001/message/3003')).toBeNull();
    expect(parsePermalinkPath('/message/3003')).toBeNull();
    expect(parsePermalinkPath('/thread/4004')).toBeNull();
    // A thread without a channel is equally unlandable.
    expect(parsePermalinkPath('/workspace/1001/thread/4004')).toBeNull();
  });

  it('rejects incomplete, unknown and malformed shapes', () => {
    for (const bad of [
      '',
      '/',
      '/workspace',
      '/workspace/',
      '/channel',
      '/channel/',
      '/workspace/1001/',
      '/workspace/1001/channel/2002/',
      '/42',
      '/unknown/1001',
      '/workspace/1001/channels/2002',
      '/workspace/1001/channel/2002/thread/4004/message', // a keyword with no id
      '/workspace/1001/channel/2002/message/3003/extra',
      '/workspace/' + '9'.repeat(21),
      '/workspace/1001/channel/20 02',
      '/workspace/1001?x=1',
      '/workspace/1001#top',
      '/workspace/1000%2Fchannel%2F2002',
      '/workspace/100%',
      '/workspace/%zz',
      // base62 (#118) rejections: outside the alphabet, longer than a u64 can
      // need, or a value past the u64 ceiling.
      '/workspace/a_b',
      '/workspace/-1',
      '/workspace/' + 'z'.repeat(12),
      '/workspace/zzzzzzzzzzz',
    ]) {
      expect(parsePermalinkPath(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBeNull();
    }
  });

  /*
   * #118 — the two spellings of one id. base62 is what a copied link now
   * carries; decimal is what EVERY link copied before this change carries, so
   * the pair below is the same assertion twice: an old link and a new link
   * must land on the same message.
   */
  it('reads the base62 spelling into the same decimal ids', () => {
    expect(parsePermalinkPath('/workspace/qj/channel/Gs/message/WB')).toEqual({
      kind: 'message',
      workspaceId: '1001',
      channelId: '2002',
      threadId: undefined,
      messageId: '3003',
    });
    expect(parsePermalinkPath('/workspace/qj/channel/Gs/thread/bcK/message/WB')).toEqual({
      kind: 'message',
      workspaceId: '1001',
      channelId: '2002',
      threadId: '4004',
      messageId: '3003',
    });
    // The DM form is the same rule with no workspace segment.
    expect(parsePermalinkPath('/channel/Gs/message/WB')).toEqual({
      kind: 'message',
      workspaceId: undefined,
      channelId: '2002',
      threadId: undefined,
      messageId: '3003',
    });
  });

  it('still reads the LEGACY decimal spelling — links copied before #118 keep working', () => {
    const legacy =
      '/workspace/92562633470771200/channel/92562633470771201/message/92562633470771202';
    const shortened = '/workspace/gZ6jet53G8/channel/gZ6jet53G9/message/gZ6jet53Ha';

    // Byte-for-byte the two real-world URLs, one from before the change and
    // one from after, resolving to the SAME target.
    expect(parsePermalinkPath(shortened)).toEqual(parsePermalinkPath(legacy));
    expect(parsePermalinkPath(legacy)).toEqual({
      kind: 'message',
      workspaceId: '92562633470771200',
      channelId: '92562633470771201',
      threadId: undefined,
      messageId: '92562633470771202',
    });

    // A decimal id is NOT read as base62 by accident: "1001" is 1001, not the
    // number "qj" happens to encode (238329).
    expect(parsePermalinkPath('/workspace/1001')).toMatchObject({ workspaceId: '1001' });
  });

  it('rejects a non-string (the boundary is reachable from untyped text)', () => {
    expect(parsePermalinkPath(null as unknown as string)).toBeNull();
    expect(parsePermalinkPath(undefined as unknown as string)).toBeNull();
  });
});

describe('buildPermalinkPath', () => {
  it('writes every accepted path in the base62 spelling (#118)', () => {
    for (const path of [
      '/workspace/1001',
      '/workspace/1001/channel/2002',
      '/workspace/1001/channel/2002/thread/4004',
      '/workspace/1001/channel/2002/message/3003',
      '/workspace/1001/channel/2002/thread/4004/message/3003',
      '/channel/2002/message/3003',
    ]) {
      const target = parsePermalinkPath(path);
      expect(target).not.toBeNull();
      const built = buildPermalinkPath(target as PermalinkTarget);
      // Shorter than the spelling the parser was given, and the same address.
      expect(built!.length).toBeLessThan(path.length);
      expect(parsePermalinkPath(built!)).toEqual(target);
    }
  });

  it('builds the exact canonical form for a message address', () => {
    expect(
      buildPermalinkPath({
        kind: 'message',
        workspaceId: '1001',
        channelId: '2002',
        messageId: '3003',
      }),
    ).toBe('/workspace/qj/channel/Gs/message/WB');
  });

  it('refuses to mint what the parser would refuse to read', () => {
    expect(
      buildPermalinkPath({ kind: 'message', channelId: '2002', messageId: 'abc' }),
    ).toBeNull();
    expect(buildPermalinkPath({ kind: 'message', messageId: '3003' })).toBeNull();
    expect(buildPermalinkPath({ kind: 'thread', threadId: '4004' })).toBeNull();
    expect(buildPermalinkPath({ kind: 'workspace' })).toBeNull();
    // Past the u64 ceiling: an id no snowflake can hold is not mintable.
    expect(
      buildPermalinkPath({
        kind: 'message',
        channelId: '2002',
        messageId: '18446744073709551616',
      }),
    ).toBeNull();
  });
});

describe('buildMessagePermalink — what Copy Link writes', () => {
  it('writes the workspace-channel URL the route can open', () => {
    const url = buildMessagePermalink({
      origin: 'https://chat.example.com',
      workspaceId: '1001',
      channelId: '2002',
      messageId: '3003',
    });
    expect(url).toBe('https://chat.example.com/#/workspace/qj/channel/Gs/message/WB');
    // …and it parses back to the same target (the link and the route agree).
    expect(parsePermalinkPath(new URL(url!).hash.slice(1))).toEqual(
      parsePermalinkPath('/workspace/1001/channel/2002/message/3003'),
    );
  });

  it('is materially shorter than the pre-#118 URL for a real snowflake', () => {
    const before = `https://chat.example.com/#/workspace/92562633470771200/channel/92562633470771201/message/92562633470771202`;
    const after = buildMessagePermalink({
      origin: 'https://chat.example.com',
      workspaceId: '92562633470771200',
      channelId: '92562633470771201',
      messageId: '92562633470771202',
    })!;
    expect(after).toBe(
      'https://chat.example.com/#/workspace/gZ6jet53G8/channel/gZ6jet53G9/message/gZ6jet53Ha',
    );
    expect(before.length).toBe(106);
    expect(after.length).toBe(85);
    expect(before.length - after.length).toBe(21);
  });

  it('writes the thread-reply URL with the thread segment', () => {
    expect(
      buildMessagePermalink({
        origin: 'https://chat.example.com',
        workspaceId: '1001',
        channelId: '2002',
        threadId: '4004',
        messageId: '3003',
      }),
    ).toBe('https://chat.example.com/#/workspace/qj/channel/Gs/thread/bcK/message/WB');
  });

  it('writes a DM URL with no workspace segment', () => {
    expect(
      buildMessagePermalink({ origin: 'https://chat.example.com', channelId: '2002', messageId: '3003' }),
    ).toBe('https://chat.example.com/#/channel/Gs/message/WB');
    // A null workspace (the domain's DM shape) behaves as absent.
    expect(
      buildMessagePermalink({
        origin: 'https://chat.example.com',
        workspaceId: null,
        channelId: '2002',
        messageId: '3003',
      }),
    ).toBe('https://chat.example.com/#/channel/Gs/message/WB');
  });

  it('normalizes a trailing slash on the origin instead of doubling it', () => {
    expect(
      buildMessagePermalink({ origin: 'https://chat.example.com/', channelId: '2', messageId: '3' }),
    ).toBe('https://chat.example.com/#/channel/c/message/d');
  });

  it('refuses to build a link for an unaddressable message', () => {
    expect(
      buildMessagePermalink({ origin: 'https://chat.example.com', channelId: '2', messageId: 'pending_1' }),
    ).toBeNull();
  });
});
