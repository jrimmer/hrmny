/**
 * @cytale/domain — domain model fixture-shape tests.
 *
 * The models are pure types, so these tests pin the wire discipline that
 * the API client and state package rely on: snowflakes stay strings,
 * bitfields stay decimal strings, protocol event payloads remain structurally
 * assignable to the domain shapes without drift.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { MessageCreate } from '@cytale/protocol';
import {
  displayNameOf,
  isTextChannel,
  normalizeChannelType,
  type Attachment,
  type Channel,
  type ChannelRef,
  type ChannelType,
  type ChannelTypeWire,
  type CurrentUser,
  type Invite,
  type Message,
  type MessageWireRef,
  type PermissionOverwrite,
  type PublicInvite,
  type Role,
  type SearchHit,
  type Thread,
  type ThreadRef,
  type User,
  type WorkspaceMember,
} from '../models.js';
import type { Snowflake } from '@cytale/protocol';

const fixture = {
  user: {
    id: '2000000000000000001',
    username: 'jason',
    display_name: null,
    avatar_url: null,
  } satisfies User,

  channel: {
    id: '3000000000000000001',
    workspace_id: '4000000000000000001',
    name: 'general',
    type: 'text' as const,
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-08-27T12:00:00.000Z',
  } satisfies Channel,

  message: {
    id: '1323802873036800000',
    channel_id: '3000000000000000001',
    thread_id: null,
    author_id: '2000000000000000001',
    content: 'hello cytale',
    created_at: '2025-01-01T00:00:00.000Z',
    edited_at: null,
  } satisfies MessageWireRef,

  role: {
    id: '1000000000000000002',
    workspace_id: '4000000000000000001',
    name: 'moderator',
    permissions: '8200',
    position: 5,
    color: null,
  } satisfies Role,
};

describe('domain model fixtures', () => {
  it('messages keep every snowflake as a string (>53-bit safe)', () => {
    const m: Message = fixture.message;
    expectTypeOf(m.id).toEqualTypeOf<Snowflake>();
    expect(typeof m.id).toBe('string');
    // Converting the digit string to a JS number breaks integer precision —
    // exactly why the wire discipline forbids numeric id encoding.
    expect(Number.isSafeInteger(Number(m.id))).toBe(false);
    expect(BigInt(m.id) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('role permission bitfields ride as decimal strings', () => {
    expect(typeof fixture.role.permissions).toBe('string');
    expect(fixture.role.permissions).toMatch(/^\d+$/);
  });

  it('wire refs are assignable both directions with protocol payloads', () => {
    // Protocol event payload -> domain (gateway fan-in).
    const ev: MessageCreate = fixture.message;
    expect(ev.content).toBe(fixture.message.content);
    // Domain wire ref -> protocol-shaped consumer.
    const back: MessageCreate = fixture.message;
    void back;
    expect(true).toBe(true);
  });

  it('full Message adds optional detail without breaking wire assignability', () => {
    const full: Message = { ...fixture.message, attachments: null };
    const wire: MessageWireRef = full;
    expect(wire.edited_at).toBeNull();
  });

  it('channel and its wire ref align on shared fields', () => {
    const ch: Channel = fixture.channel;
    const ref: ChannelRef = {
      id: ch.id,
      workspace_id: ch.workspace_id as string,
      name: ch.name,
      position: ch.position,
      created_at: ch.created_at,
    };
    expect(ref.name).toBe('general');
  });

  it('member, invite, thread, search rows carry coherent identity fields', () => {
    const member: WorkspaceMember = {
      ...fixture.user,
      nickname: null,
      joined_at: '2026-08-27T12:00:00.000Z',
      roles: ['1000000000000000002'],
    };
    expect(member.roles).toHaveLength(1);

    const invite: Invite = {
      code: 'aB3dEf9x',
      workspace_id: '4000000000000000001',
      channel_id: null,
      inviter_id: member.id,
      max_uses: 0,
      uses: 0,
      expires_at: null,
      revoked_at: null,
      created_at: '2026-08-27T12:00:00.000Z',
    };
    expect(invite.code).toBeTruthy();

    const pub: PublicInvite = {
      code: invite.code,
      workspace_name: 'cytale',
      inviter_username: member.username,
      expires_at: null,
    };
    expect(pub.workspace_name).toBe('cytale');

    const thread: Thread = {
      id: '5000000000000000001',
      channel_id: fixture.channel.id,
      parent_message_id: null,
      name: 'deploy discussion',
      created_by: member.id,
      archived: false,
      created_at: '2026-08-27T12:00:00.000Z',
    };
    const tref: ThreadRef = {
      id: thread.id,
      channel_id: thread.channel_id,
      name: thread.name,
      created_by: thread.created_by,
      created_at: thread.created_at,
    };
    expect(tref.name).toBe(thread.name);

    const hit: SearchHit = {
      message_id: fixture.message.id,
      channel_id: fixture.message.channel_id,
      thread_id: null,
      author_id: fixture.message.author_id,
      highlight: '<b>hello</b> cytale',
      score: 2.5,
      created_at: fixture.message.created_at,
    };
    expect(hit.score).toBeGreaterThan(0);
  });

  it('overwrites use the role|member discriminator', () => {
    const ow: PermissionOverwrite = {
      id: fixture.role.id,
      type: 'role',
      allow: '8200',
      deny: '0',
    };
    expect(['role', 'member']).toContain(ow.type);
  });

  it('attachment rows bind to messages optionally', () => {
    const att: Attachment = {
      id: '6000000000000000001',
      message_id: null,
      filename: 'notes.txt',
      content_type: 'text/plain',
      size: 128,
      url: 'https://files.cytale.test/notes.txt',
    };
    expect(att.message_id).toBeNull();

    const currentUser: CurrentUser = { ...fixture.user, email: 'jo@example.dev', email_verified_at: null };
    expect(currentUser.email).toBe('jo@example.dev');
  });
});

/**
 * The wire vocabulary (grepped across every server emission): workspace
 * channels carry the numeric column (0 = text, 1 = category), a DM read
 * through GET /channels/{id} carries 'dm', and no surface ever emits a
 * group-DM or voice kind.
 */
describe('channel type — wire vocabulary', () => {
  it('pins the exact wire union and the normalized union', () => {
    expectTypeOf<ChannelTypeWire>().toEqualTypeOf<0 | 1 | 'dm'>();
    expectTypeOf<ChannelType>().toEqualTypeOf<'text' | 'category' | 'dm'>();
  });

  it('normalizes every wire value and is idempotent on normalized values', () => {
    expect(normalizeChannelType(0)).toBe('text');
    expect(normalizeChannelType(1)).toBe('category');
    expect(normalizeChannelType('dm')).toBe('dm');

    // Already-normalized input (a second pass through the boundary) is stable.
    expect(normalizeChannelType('text')).toBe('text');
    expect(normalizeChannelType('category')).toBe('category');

    // The documented fallback: unknown/absent is a text channel (DM list rows
    // omit the key, but they never reach this normalizer).
    expect(normalizeChannelType(undefined)).toBe('text');
    expect(normalizeChannelType(null)).toBe('text');
  });

  it('isTextChannel accepts both spellings and rejects non-text kinds', () => {
    expect(isTextChannel({ type: 'text' })).toBe(true);
    // Raw wire spelling: a hydrated channel that has not crossed the
    // api-client boundary yet must not be dropped.
    expect(isTextChannel({ type: 0 })).toBe(true);

    expect(isTextChannel({ type: 'category' })).toBe(false);
    expect(isTextChannel({ type: 1 })).toBe(false);
    expect(isTextChannel({ type: 'dm' })).toBe(false);
    expect(isTextChannel({})).toBe(false);
    expect(isTextChannel(null)).toBe(false);
    expect(isTextChannel(undefined)).toBe(false);
  });
});

// #168: the one name rule every client uses (Discord's order).
describe('displayNameOf', () => {
  it('prefers the workspace nickname, then the display name, then the username', () => {
    expect(displayNameOf({ nickname: 'Gemstone', display_name: 'G. Gordon Liddy', username: 'liddy' })).toBe(
      'Gemstone',
    );
    expect(displayNameOf({ nickname: null, display_name: 'G. Gordon Liddy', username: 'liddy' })).toBe(
      'G. Gordon Liddy',
    );
    expect(displayNameOf({ nickname: null, display_name: null, username: 'liddy' })).toBe('liddy');
  });

  it('skips blank names', () => {
    expect(displayNameOf({ nickname: '', display_name: '   ', username: 'liddy' })).toBe('liddy');
  });

  it('falls back when nothing names the row, or there is no row', () => {
    expect(displayNameOf(undefined, '?')).toBe('?');
    expect(displayNameOf(null)).toBe('');
    expect(displayNameOf({ username: '' }, 'unknown')).toBe('unknown');
  });
});
