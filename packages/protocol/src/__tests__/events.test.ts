import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  CALL_END_REASONS,
  CALL_UPDATE_STATES,
  EVENT_NAMES,
  GATEWAY_EVENTS,
  isCallEndReason,
  isCallUpdateState,
  type CallEndReason,
  type CallSync,
  type CallUpdateState,
  type EventName,
  type EventNameToPayload,
  type EventPayloadMap,
  type GatewayEvent,
  type InteractionCreate,
  type MessageCreate,
  type MessageUpdate,
  type ThreadListSync,
  type ThreadMessageCreate,
} from '../events.js';

/**
 * Representative fixtures: one per event in the spec's required list.
 * Contextually typed against EventPayloadMap — a compile failure here means an
 * event interface drifted from its representative shape (spec happy path).
 */
const fixtures: EventPayloadMap = {
  MessageCreate: {
    id: '7300000000000000001',
    channel_id: '7300000000000000100',
    thread_id: null,
    author_id: '7300000000000000200',
    content: 'hello world',
    created_at: '2026-08-27T12:00:00.000Z',
    edited_at: null,
  },
  MessageUpdate: {
    id: '7300000000000000002',
    channel_id: '7300000000000000100',
    thread_id: '7300000000000000300',
    content: 'edited body',
    edited_at: '2026-08-27T12:05:00.000Z',
  },
  MessageDelete: { id: '7300000000000000003', channel_id: '7300000000000000100', thread_id: null },
  MessageReactionAdd: {
    channel_id: '7300000000000000100',
    message_id: '7300000000000000003',
    user_id: '7300000000000000200',
    emoji: '👍',
  },
  MessageReactionRemove: {
    channel_id: '7300000000000000100',
    message_id: '7300000000000000003',
    user_id: '7300000000000000200',
    emoji: '👍',
  },
  MessageReactionRemoveAll: { channel_id: '7300000000000000100', message_id: '7300000000000000003' },
  MessageAck: {
    channel_id: '7300000000000000100',
    message_ids: ['7300000000000000004', '7300000000000000005'],
    user_id: '7300000000000000200',
    acknowledged_at: '2026-08-27T12:06:00.000Z',
  },
  ChannelCreate: {
    id: '7300000000000000100' as string,
    workspace_id: '7300000000000004000',
    name: 'general',
    position: 0,
    created_at: '2026-08-27T10:00:00.000Z',
  },
  ChannelUpdate: { id: '7300000000000000101', name: 'general-2' },
  ChannelDelete: { id: '7300000000000000102' },
  UserUpdate: {
    id: '7300000000000000400',
    username: 'avatar_owner',
    display_name: 'Avatar Owner',
    avatar_url: '/api/v1/attachments/' + 'a'.repeat(64),
  },
  ThreadCreate: {
    id: '7300000000000000300',
    channel_id: '7300000000000000100',
    parent_message_id: '7300000000000000299',
    name: 'incident-42',
    created_by: '7300000000000000200',
    created_at: '2026-08-27T12:01:00.000Z',
  },
  // channel_id is REQUIRED here (#109): the fan-out routes by it, so a payload
  // without one is silently delivered to nobody. The fixture carries what the
  // server actually sends.
  ThreadUpdate: {
    id: '7300000000000000300',
    channel_id: '7300000000000000100',
    parent_message_id: '7300000000000000299',
    name: 'incident-42-postmortem',
    archived: true,
  },
  // channel_id is REQUIRED here (#110 audit): the fan-out routes by it, and
  // Threads.Events.thread_delete/1 always emits it — the fixture carries what
  // the server actually sends.
  ThreadDelete: { id: '7300000000000000301', channel_id: '7300000000000000100' },
  ThreadMemberAdd: { thread_id: '7300000000000000300', user_id: '7300000000000000200' },
  ThreadMemberRemove: { thread_id: '7300000000000000300', user_id: '7300000000000000201' },
  ThreadListSync: {
    workspace_id: '7300000000000004000',
    threads: [
      {
        id: '7300000000000000302',
        channel_id: '7300000000000000100',
        parent_message_id: null,
        name: 'synced-thread',
        created_by: '7300000000000000200',
        created_at: '2026-08-27T12:03:00.000Z',
      },
    ],
  },
  // channel_id is REQUIRED here (#110 audit): the wire has always carried it
  // (Messages.Message.to_wire/1, the production producer, emits it) — only the
  // type omitted it, which is how it kept looking optional to clients.
  ThreadMessageCreate: {
    id: '7300000000000000006',
    channel_id: '7300000000000000100',
    thread_id: '7300000000000000300',
    author_id: '7300000000000000200',
    content: 'thread reply',
    created_at: '2026-08-27T12:02:00.000Z',
    edited_at: null,
  },
  PresenceUpdate: {
    user_id: '7300000000000000200',
    status: 'online',
    last_seen_at: '2026-08-27T12:07:00.000Z',
  },
  TypingStart: {
    channel_id: '7300000000000000100',
    thread_id: null,
    user_id: '7300000000000000200',
    timestamp: 1795828800000,
  },
  Ready: {
    v: 1,
    session_id: 'sess-abc123',
    resume_token: 'rt-secret-001',
    heartbeat_interval: 45000,
    user: { id: '7300000000000000200', username: 'jason' },
  },
  Resumed: { replayed_events: 12, heartbeat_interval: 45000 },
  RoleCreate: {
    id: '7300000000000005000',
    workspace_id: '7300000000000004000',
    name: 'admin',
    permissions: '1152921504606846975',
    position: 1,
    color: null,
  },
  RoleUpdate: { id: '7300000000000005000', name: 'moderator' },
  RoleDelete: { id: '7300000000000005001', workspace_id: '7300000000000004000' },
  MemberAdd: {
    workspace_id: '7300000000000004000',
    user: { id: '7300000000000000203', username: 'newbie' },
    joined_at: '2026-08-27T11:00:00.000Z',
  },
  MemberRemove: { workspace_id: '7300000000000004000', user_id: '7300000000000000203' },
  MemberUpdate: { workspace_id: '7300000000000004000', user_id: '7300000000000000203', nickname: 'Gemstone' },
  AccountDelete: { user_id: '7300000000000000204', deleted_at: '2026-08-27T13:00:00.000Z' },
  InteractionCreate: {
    id: '7300000000000000006',
    token: 'qkcDEacTOAXdfzf6fxVCf1H9_4sqGwnlQbi4sl-G3cx',
    application_id: '7300000000006000',
    command: { id: '7300000000006001', name: 'echo' },
    options: { text: 'hi' },
    channel_id: '7300000000000100',
    workspace_id: '7300000000004000',
    user: { id: '7300000000000200', username: 'invoker' },
  },
  InteractionSuccess: {
    interaction_id: '7300000000000006',
    nonce: 'click-1',
    application_id: '7300000000006000',
    channel_id: '7300000000000100',
    thread_id: null,
    message_id: '7300000000000300',
    custom_id: 'approve',
    response_type: 6,
  },
  InteractionModal: {
    interaction_id: '7300000000000006',
    application_id: '7300000000006000',
    channel_id: '7300000000000100',
    custom_id: 'feedback',
    title: 'Tell us more',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: 'details',
            style: 2,
            label: 'Details',
            min_length: 0,
            max_length: 4000,
            required: true,
          },
        ],
      },
    ],
  },
  CallStart: {
    channel_id: '7300000000000100',
    call_id: '7300000000007000',
    thread_id: '7300000000000300',
    started_by: '7300000000000200',
    started_at: '2026-09-06T12:00:00.000Z',
  },
  CallUpdate: {
    channel_id: '7300000000000100',
    call_id: '7300000000007000',
    user_id: '7300000000000200',
    leg: 'sVbXv2xKqP9mQwRt',
    state: 'joined',
  },
  CallEnd: {
    channel_id: '7300000000000100',
    call_id: '7300000000007000',
    reason: 'last_left',
    ended_at: '2026-09-06T12:31:00.000Z',
  },
  ReadStateSync: {
    channels: [
      {
        channel_id: '7300000000000100',
        last_read_id: '7300000000000100',
        unread_floor: null,
      },
      {
        channel_id: '7300000000000101',
        last_read_id: '7300000000000102',
        unread_floor: '7300000000000102',
      },
    ],
  },  ReadStateUpdate: {
    channel_id: '7300000000000101',
    last_read_id: '7300000000000102',
    unread_floor: '7300000000000101',
    unread_count: 2,
  },

  CallSync: {
    calls: [
      {
        channel_id: '7300000000000100',
        call_id: '7300000000007000',
        thread_id: '7300000000000300',
        participants: [
          { user_id: '7300000000000200', mute: false, deafen: false },
          { user_id: '7300000000000201', mute: true, deafen: false },
        ],
      },
    ],
    dm_calls: [],
  },
  CallRing: {
    channel_id: '7300000000000100',
    call_id: '7300000000007000',
    from_user: '7300000000000200',
  },
  CallSignal: {
    channel_id: '7300000000000100',
    body: '{"kind":"sdp","sdp":"v=0..."}',
  },
};

describe('event name catalog', () => {
  it('exposes every event name required by the plan', () => {
    const required: EventName[] = [
      'MessageCreate',
      'MessageUpdate',
      'MessageDelete',
      'MessageReactionAdd',
      'MessageReactionRemove',
      'MessageReactionRemoveAll',
      'MessageAck',
      'ChannelCreate',
      'ChannelUpdate',
      'ChannelDelete',
      'UserUpdate',
      'ThreadCreate',
      'ThreadUpdate',
      'ThreadDelete',
      'ThreadMemberAdd',
      'ThreadMemberRemove',
      'ThreadListSync',
      'ThreadMessageCreate',
      'PresenceUpdate',
      'TypingStart',
      'Ready',
      'Resumed',
      'RoleCreate',
      'RoleUpdate',
      'RoleDelete',
      'MemberAdd',
      'MemberRemove',
      'MemberUpdate',
      'AccountDelete',
      'InteractionCreate',
      'InteractionModal',
      'InteractionSuccess',
      'CallStart',
      'CallUpdate',
      'CallEnd',
      'CallSync',
      'ReadStateSync',
      'ReadStateUpdate',
      'CallRing',
      'CallSignal',
    ];
    for (const name of required) {
      expect(GATEWAY_EVENTS.has(name), `missing event: ${name}`).toBe(true);
    }
    expect(GATEWAY_EVENTS.size).toBe(required.length);
  });

  it('EVENT_NAMES is an array of exactly those names', () => {
    expect([...EVENT_NAMES].sort()).toEqual([...GATEWAY_EVENTS].sort());
    expect(EVENT_NAMES.length).toBe(GATEWAY_EVENTS.size);
  });

  it('maps every event name to a distinct non-empty payload shape via EventPayloadMap', () => {
    const check: { [K in keyof EventPayloadMap]: EventPayloadMap[K] extends object ? true : never } =
      {
        MessageCreate: true,
        MessageUpdate: true,
        MessageDelete: true,
        MessageReactionAdd: true,
        MessageReactionRemove: true,
        MessageReactionRemoveAll: true,
        MessageAck: true,
        ChannelCreate: true,
        ChannelUpdate: true,
        ChannelDelete: true,
        UserUpdate: true,
        ThreadCreate: true,
        ThreadUpdate: true,
        ThreadDelete: true,
        ThreadMemberAdd: true,
        ThreadMemberRemove: true,
        ThreadListSync: true,
        ThreadMessageCreate: true,
        PresenceUpdate: true,
        TypingStart: true,
        Ready: true,
        Resumed: true,
        RoleCreate: true,
        RoleUpdate: true,
        RoleDelete: true,
        MemberAdd: true,
        MemberRemove: true,
        MemberUpdate: true,
        AccountDelete: true,
        InteractionCreate: true,
        InteractionModal: true,
        InteractionSuccess: true,
        CallStart: true,
        CallUpdate: true,
        CallEnd: true,
        CallSync: true,
        ReadStateSync: true,
        ReadStateUpdate: true,
        CallRing: true,
        CallSignal: true,
      };
      void check;
  });
});

describe('representative fixtures satisfy their event payloads', () => {
  it('every event has a fixture with runtime-present fields', () => {
    // Fixtures are contextually typed against EventPayloadMap at declaration;
    // this loop asserts each declared key exists at runtime too.
    for (const name of EVENT_NAMES) {
      expect(fixtures[name], `fixture present for ${name}`).toBeDefined();
    }
  });

  it('MessageCreate payload shape matches its interface exactly', () => {
    const mc: MessageCreate = fixtures.MessageCreate;
    expect(mc.id).toBe('7300000000000000001');
    expect(mc.thread_id).toBeNull();
  });

  // Components plan U2: InteractionCreate widens ADDITIVELY — the component
  // variant carries kind/component fields and omits command/options; DM
  // clicks omit workspace_id. Both variants satisfy the ONE payload type.
  it('InteractionCreate admits the component-click variant (kind discriminator)', () => {
    const componentClick: InteractionCreate = {
      id: '7300000000000000007',
      token: 'qkcDEacTOAXdfzf6fxVCf1H9_4sqGwnlQbi4sl-G3cx',
      application_id: '7300000000000006000',
      kind: 'component',
      channel_id: '7300000000000000100',
      workspace_id: '7300000000000004000',
      user: { id: '7300000000000000200', username: 'clicker' },
      message_id: '7300000000000000009',
      custom_id: 'approve',
      component_type: 2,
      values: undefined,
      app_permissions: 65535,
      message: { id: '7300000000000000009', channel_id: '7300000000000000100' },
    };
    expect(componentClick.kind).toBe('component');

    // The DM shape: workspace_id omitted.
    const dmClick: InteractionCreate = {
      id: '7300000000000000008',
      token: 'tok',
      application_id: '7300000000000006000',
      kind: 'component',
      channel_id: '7300000000000000110',
      user: { id: '7300000000000000200', username: 'clicker' },
      custom_id: 'model',
      component_type: 3,
      values: ['one'],
      app_permissions: 65535,
    };
    expect(dmClick.values).toEqual(['one']);
  });

  // Thread cards: a bot's content + embed + buttons posted into a THREAD
  // rides ThreadMessageCreate with the same embeds/components a channel
  // MessageCreate carries, and a click on it names the thread.
  it('ThreadMessageCreate carries a card (embeds + components), as MessageCreate does', () => {
    const card: ThreadMessageCreate = {
      ...fixtures.ThreadMessageCreate,
      content: '',
      embeds: [{ title: 'Approve deploy?', description: 'prod · web' }],
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 3, label: 'Approve', custom_id: 'approve' }],
        },
      ],
    };
    expect(card.embeds?.[0]?.title).toBe('Approve deploy?');
    expect(card.components?.[0]?.type).toBe(1);
    expectTypeOf<ThreadMessageCreate['components']>().toEqualTypeOf<
      MessageCreate['components']
    >();
  });

  it('InteractionCreate names the thread of a clicked thread card; MessageUpdate may clear a card', () => {
    const threadClick: InteractionCreate = {
      id: '7300000000000000011',
      token: 'tok',
      application_id: '7300000000000006000',
      kind: 'component',
      channel_id: '7300000000000000100',
      thread_id: '7300000000000000300',
      workspace_id: '7300000000000004000',
      user: { id: '7300000000000000200', username: 'clicker' },
      message_id: '7300000000000000009',
      custom_id: 'approve',
      component_type: 2,
    };
    expect(threadClick.thread_id).toBe('7300000000000000300');

    const cleared: MessageUpdate = {
      id: '7300000000000000009',
      channel_id: '7300000000000000100',
      thread_id: '7300000000000000300',
      content: 'Approved by clicker',
      edited_at: '2026-08-27T12:09:00.000Z',
      components: [],
      embeds: [],
    };
    expect(cleared.components).toEqual([]);
    expect(cleared.embeds).toEqual([]);
  });
});

describe('voice-call events (calls plan U1)', () => {
  it('CALL_UPDATE.state is exhaustive: the runtime const mirrors the type union exactly', () => {
    // Compile-time: the union IS the const's element union — a new state
    // added to either side alone fails right here.
    expectTypeOf<CallUpdateState>().toEqualTypeOf<(typeof CALL_UPDATE_STATES)[number]>();
    const states: readonly CallUpdateState[] = CALL_UPDATE_STATES;
    expect(states).toEqual([
      'joined',
      'left',
      'muted',
      'unmuted',
      'deafened',
      'undeafened',
      'displaced',
      'forced_leave',
      // Calls V2 plan U2 (KTD1/KTD3): per-source publish states, additive.
      'camera_on',
      'camera_off',
      'screen_on',
      'screen_off',
      'screen_audio_on',
      'screen_audio_off',
    ]);
    expect(new Set(states).size).toBe(states.length); // no duplicates
  });

  it('CALL_UPDATE.state supports an exhaustive switch (never default)', () => {
    const classify = (state: CallUpdateState): string => {
      switch (state) {
        case 'joined':
          return 'roster-add';
        case 'left':
          return 'roster-remove';
        case 'muted':
        case 'unmuted':
          return 'mute-flag';
        case 'deafened':
        case 'undeafened':
          return 'deafen-flag';
        case 'displaced':
          return 'teardown-own-leg';
        case 'forced_leave':
          return 'teardown-own-leg';
        case 'camera_on':
        case 'camera_off':
        case 'screen_on':
        case 'screen_off':
        case 'screen_audio_on':
        case 'screen_audio_off':
          return 'source-state';
        default: {
          // Adding a state without a branch fails this build, not production.
          const _exhaustive: never = state;
          void _exhaustive;
          return 'unreachable';
        }
      }
    };
    expect(classify('displaced')).toBe('teardown-own-leg');
    expect(classify('muted')).toBe('mute-flag');
    expect(classify('screen_audio_off')).toBe('source-state');
  });

  it('isCallUpdateState accepts every defined state and rejects others', () => {
    for (const state of CALL_UPDATE_STATES) expect(isCallUpdateState(state)).toBe(true);
    expect(isCallUpdateState('ringing')).toBe(false);
    expect(isCallUpdateState('camera')).toBe(false); // a source kind, not a state
    expect(isCallUpdateState('JOINED')).toBe(false);
    expect(isCallUpdateState(null)).toBe(false);
    expect(isCallUpdateState(1)).toBe(false);
  });

  it('CALL_END.reason is exhaustive: joined|left-style two-value enum with guard', () => {
    expectTypeOf<CallEndReason>().toEqualTypeOf<(typeof CALL_END_REASONS)[number]>();
    expect(CALL_END_REASONS).toEqual(['last_left', 'swept']);
    expect(isCallEndReason('last_left')).toBe(true);
    expect(isCallEndReason('swept')).toBe(true);
    expect(isCallEndReason('deleted')).toBe(false);
    expect(isCallEndReason(undefined)).toBe(false);
  });

  it('CALL_SYNC round-trips with empty arrays (no calls anywhere)', () => {
    const sync: CallSync = { calls: [], dm_calls: [] };
    const parsed = JSON.parse(JSON.stringify(sync)) as CallSync;
    expect(parsed).toEqual({ calls: [], dm_calls: [] });
    expect(parsed.calls).toHaveLength(0);
    expect(parsed.dm_calls).toHaveLength(0);
  });

  it('CALL_SYNC carries a DM call present alongside channel calls', () => {
    const sync: CallSync = {
      calls: [
        {
          channel_id: '7300000000000100',
          call_id: '7300000000007000',
          thread_id: '7300000000000300',
          participants: [{ user_id: '7300000000000200', mute: false, deafen: false }],
        },
      ],
      dm_calls: [
        {
          channel_id: '7300000000000110',
          call_id: '7300000000007001',
          participants: [{ user_id: '7300000000000201', mute: true, deafen: false }],
        },
      ],
    };
    const parsed = JSON.parse(JSON.stringify(sync)) as CallSync;
    expect(parsed.dm_calls).toHaveLength(1);
    // DM entries have NO thread linkage on the wire shape (R11: no artifact).
    expect(Object.keys(parsed.dm_calls[0]!).sort()).toEqual([
      'call_id',
      'channel_id',
      'participants',
    ]);
    expect(parsed.calls[0]!.thread_id).toBe('7300000000000300');
  });

  it('CALL_START admits the DM shape (thread_id null — no call-log artifact)', () => {
    const dmStart: EventPayloadMap['CallStart'] = {
      channel_id: '7300000000000110',
      call_id: '7300000000007001',
      thread_id: null,
      started_by: '7300000000000200',
      started_at: '2026-09-06T12:00:00.000Z',
    };
    expect(dmStart.thread_id).toBeNull();
    // Channel calls carry the standing call-log thread id.
    expect(fixtures.CallStart.thread_id).toBe('7300000000000300');
  });
});

describe('EventNameToPayload mapping', () => {
  it('yields precise payload types for select events', () => {
    expectTypeOf<EventNameToPayload<'MessageCreate'>>().toHaveProperty('id');
    expectTypeOf<EventNameToPayload<'Ready'>>().toHaveProperty('session_id');
    expectTypeOf<EventNameToPayload<'TypingStart'>>().toHaveProperty('user_id');
    expectTypeOf<EventPayloadMap['MessageDelete']>().not.toHaveProperty('content');
    expectTypeOf<EventNameToPayload<'InteractionCreate'>>().toHaveProperty('token');
    expectTypeOf<EventNameToPayload<'InteractionCreate'>>().toHaveProperty('command');
  });

  it('covers every event name key', () => {
    const full: EventPayloadMap = {
      MessageCreate: fixtures.MessageCreate,
      MessageUpdate: fixtures.MessageUpdate,
      MessageDelete: fixtures.MessageDelete,
      MessageReactionAdd: fixtures.MessageReactionAdd,
      MessageReactionRemove: fixtures.MessageReactionRemove,
      MessageReactionRemoveAll: fixtures.MessageReactionRemoveAll,
      MessageAck: fixtures.MessageAck,
      ChannelCreate: fixtures.ChannelCreate,
      ChannelUpdate: fixtures.ChannelUpdate,
      ChannelDelete: fixtures.ChannelDelete,
      UserUpdate: fixtures.UserUpdate,
      ThreadCreate: fixtures.ThreadCreate,
      ThreadUpdate: fixtures.ThreadUpdate,
      ThreadDelete: fixtures.ThreadDelete,
      ThreadMemberAdd: fixtures.ThreadMemberAdd,
      ThreadMemberRemove: fixtures.ThreadMemberRemove,
      ThreadListSync: fixtures.ThreadListSync,
      ThreadMessageCreate: fixtures.ThreadMessageCreate,
      PresenceUpdate: fixtures.PresenceUpdate,
      TypingStart: fixtures.TypingStart,
      Ready: fixtures.Ready,
      Resumed: fixtures.Resumed,
      RoleCreate: fixtures.RoleCreate,
      RoleUpdate: fixtures.RoleUpdate,
      RoleDelete: fixtures.RoleDelete,
      MemberAdd: fixtures.MemberAdd,
      MemberRemove: fixtures.MemberRemove,
      MemberUpdate: fixtures.MemberUpdate,
      AccountDelete: fixtures.AccountDelete,
      InteractionCreate: fixtures.InteractionCreate,
      InteractionModal: fixtures.InteractionModal,
      InteractionSuccess: fixtures.InteractionSuccess,
      CallStart: fixtures.CallStart,
      CallUpdate: fixtures.CallUpdate,
      CallEnd: fixtures.CallEnd,
      CallSync: fixtures.CallSync,
      ReadStateSync: fixtures.ReadStateSync,
      ReadStateUpdate: fixtures.ReadStateUpdate,
      CallRing: fixtures.CallRing,
      CallSignal: fixtures.CallSignal,
    };
    expect(Object.keys(full).length).toBe(40);
  });
});

describe('GatewayEvent discriminated union', () => {
  function handle(event: GatewayEvent): string {
    switch (event.t) {
      case 'MessageCreate':
        return `msg:${event.d.id}`;
      case 'TypingStart':
        return `typing:${event.d.user_id}`;
      case 'Ready':
        return `ready:${event.d.session_id}`;
      case 'InteractionCreate':
        return `interaction:${event.d.command?.name ?? event.d.custom_id}:${event.d.token}`;
      default:
        return 'other';
    }
  }

  it('dispatches on t with narrowed payloads', () => {
    const envelope: GatewayEvent<'MessageCreate'> = {
      op: 0,
      t: 'MessageCreate',
      s: 7,
      d: {
        id: '7300000000000000009',
        channel_id: '7300000000000000100',
        thread_id: null,
        author_id: '7300000000000000200',
        content: 'payload',
        created_at: '2026-08-27T12:10:00.000Z',
        edited_at: null,
      },
    };
    expect(envelope.op).toBe(0);
    expect(handle(envelope)).toBe('msg:7300000000000000009');
  });

  it('distinguishes variants and requires a discriminant', () => {
    const create: GatewayEvent['t'] = 'MessageCreate';
    const update: GatewayEvent['t'] = 'MessageUpdate';
    expect(create).not.toBe(update);
  });

  it('exposes precise payload types per member of the union', () => {
    expectTypeOf<GatewayEvent<'ThreadListSync'>['d']>().toEqualTypeOf<ThreadListSync>();
    expectTypeOf<GatewayEvent<'MessageCreate'>['op']>().toEqualTypeOf<0>();
  });
});
