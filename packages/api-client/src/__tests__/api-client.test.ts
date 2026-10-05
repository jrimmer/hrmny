/**
 * @cytale/api-client — typed method surface tests (fetch stubbed in-test).
 *
 * Scenarios: getMessages newest-first happy path, cursor param encoding,
 * Bearer injection, Idempotency-Key generation/override, error envelope →
 * ApiError, people/search/push/attachment surfaces.
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CytaleApiClient, PEOPLE_PAGE_CAP } from '../api-client.js';
import { IDEMPOTENCY_KEY_HEADER } from '../http.js';
import { ApiError, createInMemoryTokenProvider, isNativeFileDescriptor, type ApplicationCommand, type CallStateResponse, type ChannelMediaOverrideView, type IceConfigResponse, type ListResponse, type StoredTokens, type WorkspaceMediaSettings } from '../types.js';
import type { Channel, Message, WorkspaceMember } from '@cytale/domain';

type Handler = (request: Request) => Response | Promise<Response>;

function createFetchMock() {
  const calls: Request[] = [];
  const routes = new Map<string, Handler>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request);
    const handler = routes.get(`${request.method} ${new URL(request.url).pathname}`);
    if (!handler) {
      return Response.json(
        { error: { key: 'no_route', code: 40404, message: `unrouted ${request.method}` } },
        { status: 404 }
      );
    }
    return await handler(request);
  });
  return {
    fetchMock,
    calls,
    on(method: string, path: string, handler: Handler) {
      routes.set(`${method} ${path}`, handler);
    },
  };
}

function message(id: string, content: string): Message {
  return {
    id,
    channel_id: '3000000000000000001',
    thread_id: null,
    author_id: '2000000000000000001',
    content,
    created_at: '2025-01-01T00:00:00.000Z',
    edited_at: null,
  };
}

/** Newest-first page: msg2 is newer than msg1 (snowflake order). */
// Server envelope (U9 shipped shape): {"messages": [...], "oldest_id": ...}.
// oldest_id = the OLDEST id in the page = the `before` cursor for the next
// older page. Fixture items are newest-first, so oldest = the LAST item.
const MESSAGES_FIXTURE = {
  messages: [message('1323802875133952000', 'second'), message('1323802873036800000', 'first')],
  oldest_id: '1323802873036800000',
};

const TOKENS: StoredTokens = { access_token: 'at-v1', refresh_token: 'rt-v1', expires_in: 900 };

function makeClient(io: ReturnType<typeof createFetchMock>): CytaleApiClient {
  return new CytaleApiClient({
    baseUrl: 'https://api.test',
    tokens: createInMemoryTokenProvider({ ...TOKENS }),
    fetchImpl: io.fetchMock as unknown as typeof fetch,
  });
}


// The server envelope is {"attachment": descriptor}; the wrapper must hand
// back the FLAT descriptor or sends carry a nested map the server rejects
// (owner report 2026-09-16).
it('uploadChannelAttachment unwraps the {attachment: …} envelope', async () => {
  const descriptor = {
    id: '1', url: '/api/v1/attachments/' + 'ab'.repeat(32),
    filename: 'a.png', content_type: 'image/png', size: 10,
  };
  const io = createFetchMock();
  io.on('POST', '/api/v1/channels/9/attachments', () =>
    Response.json({ attachment: descriptor }, { status: 201 })
  );
  const client = makeClient(io);
  const out = await client.uploadChannelAttachment('9', new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }));
  expect(out).toEqual(descriptor);
  expect((out as unknown as Record<string, unknown>).attachment).toBeUndefined();
});

describe('getMessages (spec happy path)', () => {
  let io: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    io = createFetchMock();
    io.on('GET', '/api/v1/channels/3000000000000000001/messages', () =>
      Response.json(MESSAGES_FIXTURE)
    );
  });

  it('returns typed newest-first Message[]', async () => {
    const client = makeClient(io);
    const messages = await client.getMessages('3000000000000000001');

    expectTypeOf(messages).toEqualTypeOf<Message[]>();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.id).toBe('1323802875133952000'); // newer first
    expect(messages[1]!.id).toBe('1323802873036800000');
    expect(messages[1]!.content).toBe('first');
  });

  it('encodes before/after/limit cursor params exactly once', async () => {
    const client = makeClient(io);
    await client.getMessages('3000000000000000001', {
      before: '1323802873036800000',
      limit: 50,
    });

    const url = new URL(io.calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/channels/3000000000000000001/messages');
    expect(url.searchParams.get('before')).toBe('1323802873036800000');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.has('after')).toBe(false);
  });

  it('getMessagePage exposes cursor metadata for pagination loops', async () => {
    const client = makeClient(io);
    const page = await client.getMessagePage('3000000000000000001');
    expect(page.items).toHaveLength(2);
    expect(page.cursor.before).toBe('1323802873036800000'); // oldest id = next-older cursor
    expect(page.cursor.limit).toBe(50);
  });
});

describe('permalinks (#118 — mint and resolve an opaque link)', () => {
  let io: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    io = createFetchMock();
    io.on('POST', '/api/v1/permalinks', () =>
      Response.json({ token: '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP', url: 'https://cytale.test/m/3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP' })
    );
    io.on('GET', '/api/v1/permalinks/3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP', () =>
      Response.json({ channel_id: '2002', message_id: '3003' })
    );
  });

  it('mints with the two ids and returns the token plus the server URL', async () => {
    const client = makeClient(io);
    const minted = await client.mintPermalink('2002', '3003');

    expect(minted.token).toBe('3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP');
    expect(minted.url).toContain('/m/');

    const request = io.calls[0]!;
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/api/v1/permalinks');
    expect(await request.json()).toEqual({ channel_id: '2002', message_id: '3003' });
  });

  it('resolves a token back to its ids', async () => {
    const client = makeClient(io);
    const target = await client.resolvePermalink('3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP');

    expect(target).toEqual({ channel_id: '2002', message_id: '3003' });
    expect(new URL(io.calls[0]!.url).pathname).toBe('/api/v1/permalinks/3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP');
  });

  it('a miss is an ApiError carrying the route\'s uniform 404 body', async () => {
    io.on('GET', '/api/v1/permalinks/nope', () =>
      Response.json(
        { error: { key: 'permalink_not_found', code: 40401, message: 'No such permalink' } },
        { status: 404 }
      )
    );

    const client = makeClient(io);
    await expect(client.resolvePermalink('nope')).rejects.toMatchObject({
      status: 404,
      key: 'permalink_not_found',
    });
  });

  it('a mint that answers without a token is an error, not an empty link', async () => {
    const bare = createFetchMock();
    bare.on('POST', '/api/v1/permalinks', () => Response.json({ url: 'https://cytale.test/m/' }));
    await expect(makeClient(bare).mintPermalink('1', '2')).rejects.toMatchObject({
      key: 'malformed_response',
    });
  });
});

describe('auth header injection', () => {
  it('sends Authorization: Bearer <access_token>', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/users/@me', request => {
      expect(request.headers.get('authorization')).toBe('Bearer at-v1');
      return Response.json({
        id: '2000000000000000001',
        username: 'jason',
        email: 'jo@example.dev',
        email_verified_at: null,
      });
    });
    const me = await makeClient(io).getCurrentUser();
    expect(me.username).toBe('jason');
  });

  it('omits Authorization on unauthenticated auth endpoints', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/auth/login', request => {
      expect(request.headers.get('authorization')).toBeNull();
      return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 900 });
    });
    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider(null),
      fetchImpl: io.fetchMock as unknown as typeof fetch,
    });
    await client.login({ identifier: 'jason', password: 'pw' });
    expect(io.calls).toHaveLength(1);
  });
});

describe('Idempotency-Key convention', () => {
  it('auto-generates distinct UUID keys per mutating POST', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/workspaces/400/channels', () =>
      Response.json({ id: '301', name: 'general', position: 0 })
    );
    const client = makeClient(io);

    await client.createChannel('400', { name: 'general' });
    await client.createChannel('400', { name: 'random' });

    const keys = io.calls.map(c => c.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('respects an explicit key so retries dedupe server-side', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/messages', () => Response.json(message('1', 'hi')));
    const client = makeClient(io);
    await client.sendMessage('300', { content: 'hi' }, 'fixed-key-123');
    expect(io.calls[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe('fixed-key-123');
  });

  it('never sends the header on GETs', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/400/channels', () => Response.json({ items: [], cursor: { before: null, after: null, limit: 50 } }));
    await makeClient(io).listChannels('400');
    expect(io.calls[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBeNull();
  });
});

describe('error envelope handling', () => {
  it('maps {error:{key,code,message}} into ApiError fields', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/messages', () =>
      Response.json(
        { error: { key: 'ACCOUNT_UNVERIFIED', code: 40303, message: 'verify your email to post' } },
        { status: 403 }
      )
    );
    const client = makeClient(io);

    const err = await client.sendMessage('300', { content: 'hello' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.key).toBe('ACCOUNT_UNVERIFIED');
    expect(apiErr.code).toBe(40303);
    expect(apiErr.message).toBe('verify your email to post');
    expect(apiErr.status).toBe(403);
  });

  it('non-JSON failure bodies still produce a well-formed ApiError', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/400', () => new Response('<html>boom</html>', { status: 502 }));

    const err = await makeClient(io).getWorkspace('400').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('unknown_error');
    expect((err as ApiError).status).toBe(502);
  });
});


describe('machine principals — bots (user-owned)', () => {
  it('createBot POSTs /bots and returns the credential', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/bots', () =>
      Response.json({ id: '9100', token: 'cytbot_cccc', name: 'CI', kind: 'bot' }, { status: 201 })
    );
    const minted = await makeClient(io).createBot({ name: 'CI' });
    expect(minted.token).toBe('cytbot_cccc');
    expect(await io.calls[0]!.json()).toEqual({ name: 'CI' });
  });

  it('listBots unwraps {"bots": [...]}', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/bots', () =>
      Response.json({ bots: [{ id: '9100', name: 'CI', kind: 'bot', created_at: '2026-09-01T00:00:00Z' }] })
    );
    const bots = await makeClient(io).listBots();
    expect(bots[0]!.id).toBe('9100');
  });

  it('updateBot / regenerateBotToken / deleteBot hit the user-owned routes', async () => {
    const io = createFetchMock();
    io.on('PATCH', '/api/v1/bots/9100', () =>
      Response.json({ id: '9100', name: 'CI', kind: 'bot', created_at: '2026-09-01T00:00:00Z', restrictions: null })
    );
    io.on('POST', '/api/v1/bots/9100/regenerate', () => Response.json({ token: 'cytbot_dddd' }, { status: 201 }));
    io.on('DELETE', '/api/v1/bots/9100', () => new Response(null, { status: 204 }));
    const client = makeClient(io);

    await client.updateBot('9100', { restrictions: null });
    const regen = await client.regenerateBotToken('9100');
    await client.deleteBot('9100');

    expect(regen.token).toBe('cytbot_dddd');
    expect(io.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'PATCH /api/v1/bots/9100',
      'POST /api/v1/bots/9100/regenerate',
      'DELETE /api/v1/bots/9100',
    ]);
  });
});

describe('webhooks (two readers: the creator sees the URL, the destination does not)', () => {
  it('createWebhook POSTs {name} and returns the capability URL', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/webhooks', () =>
      Response.json(
        { id: '9200', name: 'CI hook', channel_id: '300', url: 'https://api.test/api/webhooks/9200/tok' },
        { status: 201 }
      )
    );
    const hook = await makeClient(io).createWebhook('300', { name: 'CI hook' });
    expect(hook.url).toContain('/api/webhooks/9200/tok');
    expect(await io.calls[0]!.json()).toEqual({ name: 'CI hook' });
  });

  // The destination's governance read: what posts into this channel, with NO
  // capability URL — its reader is a manager who is usually not the creator.
  it('listWebhooks returns the channel rows and their destination fields', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/channels/300/webhooks', () =>
      Response.json({
        webhooks: [{ id: '9200', name: 'CI hook', channel_id: '300', created_at: '2026-09-01T00:00:00Z' }],
      })
    );
    const hooks = await makeClient(io).listWebhooks('300');
    expect(hooks[0]!.name).toBe('CI hook');
    expect(hooks[0]!.channel_id).toBe('300');
  });

  it('listMyWebhooks unwraps the owner read, url and destination included', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/users/@me/webhooks', () =>
      Response.json({
        webhooks: [
          {
            id: '9200',
            name: 'CI hook',
            channel_id: '300',
            created_at: '2026-09-01T00:00:00Z',
            url: 'https://api.test/api/webhooks/9200/tok',
            destination: {
              channel_id: '300',
              channel_name: 'general',
              workspace_id: '900',
              workspace_name: 'Cytale',
            },
          },
        ],
      })
    );
    const hooks = await makeClient(io).listMyWebhooks();
    expect(hooks[0]!.url).toContain('/api/webhooks/9200/tok');
    expect(hooks[0]!.destination?.workspace_name).toBe('Cytale');
  });

  it('updateMyWebhook and deleteMyWebhook address the owner routes, not the channel ones', async () => {
    const io = createFetchMock();
    io.on('PATCH', '/api/v1/webhooks/9200', () =>
      Response.json({ webhook: { id: '9200', name: 'Renamed', channel_id: '300' } })
    );
    io.on('DELETE', '/api/v1/webhooks/9200', () => new Response(null, { status: 204 }));

    const client = makeClient(io);
    const updated = await client.updateMyWebhook('9200', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    await client.deleteMyWebhook('9200');

    expect(io.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'PATCH /api/v1/webhooks/9200',
      'DELETE /api/v1/webhooks/9200',
    ]);
  });

  it('updateWebhook unwraps the {"webhook": {...}} envelope', async () => {
    const io = createFetchMock();
    io.on('PATCH', '/api/v1/channels/300/webhooks/9200', () =>
      Response.json({
        webhook: { id: '9200', name: 'Renamed hook', channel_id: '300', created_at: '2026-09-01T00:00:00Z' },
      })
    );
    const hook = await makeClient(io).updateWebhook('300', '9200', { name: 'Renamed hook' });
    expect(hook.name).toBe('Renamed hook');
  });

  it('deleteWebhook issues DELETE on the nested route', async () => {
    const io = createFetchMock();
    io.on('DELETE', '/api/v1/channels/300/webhooks/9200', () => new Response(null, { status: 204 }));
    await makeClient(io).deleteWebhook('300', '9200');
    expect(io.calls[0]!.method).toBe('DELETE');
  });
});

describe('application commands & interactions (bots plan U8)', () => {
  it('listWorkspaceCommands GETs the member-gated palette route and unwraps {"commands": [...]}', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/500/commands', (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer at-v1');
      return Response.json({
        commands: [
          {
            id: '9100000000000001',
            application_id: '8000000000000001',
            name: 'shrug',
            description: 'Appends a shrug',
            options: null,
          },
          {
            id: '9100000000000002',
            application_id: '8000000000000001',
            name: 'echo',
            description: 'Echoes text',
            options: [{ name: 'text', description: 'What to echo', required: true }],
          },
        ],
      });
    });
    const commands = await makeClient(io).listWorkspaceCommands('500');

    expectTypeOf(commands).toEqualTypeOf<ApplicationCommand[]>();
    expect(commands).toHaveLength(2);
    expect(commands[1]!.options![0]).toMatchObject({ name: 'text', required: true });
    expect(io.calls[0]!.url).toBe('https://api.test/api/v1/workspaces/500/commands');
  });

  it('listWorkspaceCommands surfaces non-member 403 as ApiError', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/500/commands', () =>
      Response.json({ error: { key: 'forbidden', code: 40303, message: 'not a member' } }, { status: 403 })
    );
    const err = await makeClient(io).listWorkspaceCommands('500').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it('invokeInteraction POSTs {command_id, channel_id, options} with an Idempotency-Key and unwraps {interaction_id}', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/interactions', async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer at-v1');
      expect(request.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/[\w-]{8,}/);
      return Response.json({ interaction_id: '9300000000000001' }, { status: 202 });
    });
    const res = await makeClient(io).invokeInteraction({
      command_id: '9100000000000002',
      channel_id: '3000000000000000001',
      options: { text: 'hi' },
    });

    expect(res.interaction_id).toBe('9300000000000001');
    expect(await io.calls[0]!.json()).toEqual({
      command_id: '9100000000000002',
      channel_id: '3000000000000000001',
      options: { text: 'hi' },
    });
  });

  it('invokeInteraction surfaces send-right 403 and unknown-command 404 as ApiError', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/interactions', () =>
      Response.json({ error: { key: 'forbidden', code: 40303, message: 'no send right' } }, { status: 403 })
    );
    const err = await makeClient(io)
      .invokeInteraction({ command_id: '9100000000000002', channel_id: '300' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('forbidden');
    expect((err as ApiError).status).toBe(403);
  });

  it('invokeComponentInteraction POSTs the message-keyed body exactly (no values key for buttons) and unwraps {interaction_id}', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/interactions', async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer at-v1');
      expect(request.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/[\w-]{8,}/);
      return Response.json({ interaction_id: '9300000000000009' }, { status: 202 });
    });
    const res = await makeClient(io).invokeComponentInteraction({
      channel_id: '3000000000000000001',
      message_id: '1000000000000001',
      custom_id: 'approve-btn',
      component_type: 2,
    });

    expect(res.interaction_id).toBe('9300000000000009');
    expect(await io.calls[0]!.json()).toEqual({
      channel_id: '3000000000000000001',
      message_id: '1000000000000001',
      custom_id: 'approve-btn',
      component_type: 2,
    });
  });

  it('invokeComponentInteraction carries select values verbatim (single-select v1)', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/interactions', () =>
      Response.json({ interaction_id: '9300000000000010' }, { status: 202 })
    );
    await makeClient(io).invokeComponentInteraction({
      channel_id: '3000000000000000001',
      message_id: '1000000000000001',
      custom_id: 'model-pick',
      component_type: 3,
      values: ['gpt-5.3'],
    });
    expect(await io.calls[0]!.json()).toEqual({
      channel_id: '3000000000000000001',
      message_id: '1000000000000001',
      custom_id: 'model-pick',
      component_type: 3,
      values: ['gpt-5.3'],
    });
  });

  it('invokeComponentInteraction surfaces the dead-button 410 and stale-click 400 as ApiError', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/interactions', () =>
      Response.json(
        {
          error: {
            key: 'component_unavailable',
            code: 41001,
            message: 'The bot behind this component is no longer active.',
          },
        },
        { status: 410 }
      )
    );
    const err = await makeClient(io)
      .invokeComponentInteraction({
        channel_id: '3000000000000000001',
        message_id: '1000000000000001',
        custom_id: 'approve-btn',
        component_type: 2,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(410);
    expect((err as ApiError).key).toBe('component_unavailable');
  });
});

describe('voice calls (calls plan U1 — GET /channels/{id}/call)', () => {
  const CHANNEL = '3000000000000000001';

  /** Full always-present shape (rest.md): live call + thread anchor + boundaries. */
  const CALL_FIXTURE = {
    thread_id: '500000000000000009',
    live: {
      call_id: '700000000000000001',
      started_by: '200000000000000001',
      started_at: '2026-09-06T12:00:00.000Z',
      participants: [
        { user_id: '200000000000000001', mute: false, deafen: false },
        { user_id: '200000000000000002', mute: true, deafen: false },
      ],
    },
    recently_ended: [
      {
        call_id: '700000000000000014',
        started_by: '200000000000000001',
        started_at: '2026-09-06T09:00:00.000Z',
        ended_at: '2026-09-06T09:21:00.000Z',
        reason: 'last_left',
      },
    ],
  };

  it('GETs the route and returns the typed always-present shape', async () => {
    const io = createFetchMock();
    io.on('GET', `/api/v1/channels/${CHANNEL}/call`, () => Response.json(CALL_FIXTURE));
    const client = makeClient(io);

    const call = await client.getCall(CHANNEL);

    expectTypeOf(call).toEqualTypeOf<CallStateResponse>();
    expect(call.thread_id).toBe('500000000000000009');
    expect(call.live!.call_id).toBe('700000000000000001');
    expect(call.live!.participants).toHaveLength(2);
    expect(call.live!.participants[1]).toEqual({
      user_id: '200000000000000002',
      mute: true,
      deafen: false,
    });
    expect(call.recently_ended[0]!.reason).toBe('last_left');
    expect(new URL(io.calls[0]!.url).pathname).toBe(`/api/v1/channels/${CHANNEL}/call`);
  });

  it('carries the idle shape verbatim (live null, empty boundaries, DM thread null)', async () => {
    const io = createFetchMock();
    io.on('GET', `/api/v1/channels/${CHANNEL}/call`, () =>
      Response.json({ thread_id: null, live: null, recently_ended: [] })
    );
    const client = makeClient(io);

    const call = await client.getCall(CHANNEL);
    expect(call.thread_id).toBeNull();
    expect(call.live).toBeNull();
    expect(call.recently_ended).toEqual([]);
  });

  it('surfaces the anti-enumeration 404 as ApiError', async () => {
    const io = createFetchMock();
    io.on('GET', `/api/v1/channels/${CHANNEL}/call`, () =>
      Response.json(
        { error: { key: 'channel_not_found', code: 40404, message: 'unknown channel' } },
        { status: 404 }
      )
    );
    const err = await makeClient(io)
      .getCall(CHANNEL)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).key).toBe('channel_not_found');
  });
});

describe('call notification mute (calls plan U11, AM6)', () => {
  const CHANNEL = '3000000000000000001';

  it('setCallNotificationMute PATCHes {"muted": true} and returns the echo', async () => {
    const io = createFetchMock();
    io.on('PATCH', `/api/v1/channels/${CHANNEL}/call-notification-mute`, () =>
      Response.json({ muted: true })
    );
    const client = makeClient(io);

    const res = await client.setCallNotificationMute(CHANNEL, true);

    expectTypeOf(res).toEqualTypeOf<{ muted: boolean }>();
    expect(res).toEqual({ muted: true });
    const request = io.calls[0]!;
    expect(request.method).toBe('PATCH');
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/channels/${CHANNEL}/call-notification-mute`
    );
    expect(await request.json()).toEqual({ muted: true });
  });

  it('clearCallNotificationMute PATCHes {"muted": false}', async () => {
    const io = createFetchMock();
    io.on('PATCH', `/api/v1/channels/${CHANNEL}/call-notification-mute`, () =>
      Response.json({ muted: false })
    );
    const client = makeClient(io);

    const res = await client.clearCallNotificationMute(CHANNEL);

    expect(res).toEqual({ muted: false });
    expect(await io.calls[0]!.json()).toEqual({ muted: false });
  });

  it('surfaces the non-boolean 400 as ApiError (validation envelope)', async () => {
    const io = createFetchMock();
    io.on('PATCH', `/api/v1/channels/${CHANNEL}/call-notification-mute`, () =>
      Response.json(
        {
          error: {
            key: 'validation_failed',
            code: 40001,
            message: 'muted must be a boolean',
          },
        },
        { status: 400 }
      )
    );
    const client = makeClient(io);

    const err = await client
      .setCallNotificationMute(CHANNEL, true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('validation_failed');
  });
});

describe('call ICE config (calls plan U12)', () => {
  it('GETs /calls/ice and returns the minted TURN entry typed', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/calls/ice', () =>
      Response.json({
        ice_servers: [
          {
            urls: 'turn:turn.cytale.test:3478',
            username: '1800003600',
            credential: 'TzQdJjc/Vqz1cSptekQHSXhwv+Q=',
          },
        ],
      })
    );
    const client = makeClient(io);

    const res = await client.getIceServers();

    expectTypeOf(res).toEqualTypeOf<IceConfigResponse>();
    expect(res.ice_servers).toHaveLength(1);
    expect(res.ice_servers[0]!.urls).toBe('turn:turn.cytale.test:3478');
    expect(new URL(io.calls[0]!.url).pathname).toBe('/api/v1/calls/ice');
  });

  it('carries the no-TURN degradation verbatim (empty list)', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/calls/ice', () => Response.json({ ice_servers: [] }));
    const client = makeClient(io);

    const res = await client.getIceServers();
    expect(res.ice_servers).toEqual([]);
  });
});

describe('workspace media settings (calls V2 plan U8, R16/R17)', () => {
  const WORKSPACE = '7000000000000000001';
  const CHANNEL = '3000000000000000001';

  const SETTINGS = {
    calls: true,
    video: false,
    screenshare: true,
    overrides_allowed: true,
  };

  it('getWorkspaceMediaSettings GETs the route and unwraps {"media_settings": {...}}', async () => {
    const io = createFetchMock();
    io.on('GET', `/api/v1/workspaces/${WORKSPACE}/media-settings`, () =>
      Response.json({ media_settings: SETTINGS })
    );
    const client = makeClient(io);

    const res = await client.getWorkspaceMediaSettings(WORKSPACE);

    expectTypeOf(res).toEqualTypeOf<WorkspaceMediaSettings>();
    expect(res).toEqual(SETTINGS);
    expect(new URL(io.calls[0]!.url).pathname).toBe(
      `/api/v1/workspaces/${WORKSPACE}/media-settings`
    );
  });

  it('putWorkspaceMediaSettings PUTs the partial body and returns the merged echo', async () => {
    const io = createFetchMock();
    io.on('PUT', `/api/v1/workspaces/${WORKSPACE}/media-settings`, () =>
      Response.json({ media_settings: SETTINGS })
    );
    const client = makeClient(io);

    const res = await client.putWorkspaceMediaSettings(WORKSPACE, { video: false });

    expect(res).toEqual(SETTINGS);
    const request = io.calls[0]!;
    expect(request.method).toBe('PUT');
    expect(await request.json()).toEqual({ video: false });
  });

  it('getWorkspaceMediaSettings surfaces the non-admin 403 as ApiError', async () => {
    const io = createFetchMock();
    io.on('GET', `/api/v1/workspaces/${WORKSPACE}/media-settings`, () =>
      Response.json(
        { error: { key: 'forbidden', code: 40003, message: 'Request denied.' } },
        { status: 403 }
      )
    );
    const client = makeClient(io);

    const err = await client
      .getWorkspaceMediaSettings(WORKSPACE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it('getChannelMediaOverride GETs the channel view verbatim', async () => {
    const io = createFetchMock();
    const view = {
      override: { calls: null, video: false, screenshare: null },
      overrides_allowed: true,
      master: SETTINGS,
    };
    io.on('GET', `/api/v1/channels/${CHANNEL}/media-override`, () =>
      Response.json(view)
    );
    const client = makeClient(io);

    const res = await client.getChannelMediaOverride(CHANNEL);

    expectTypeOf(res).toEqualTypeOf<ChannelMediaOverrideView>();
    expect(res).toEqual(view);
    expect(new URL(io.calls[0]!.url).pathname).toBe(
      `/api/v1/channels/${CHANNEL}/media-override`
    );
  });

  it('putChannelMediaOverride PUTs the FULL tri-state map (null = inherit)', async () => {
    const io = createFetchMock();
    io.on('PUT', `/api/v1/channels/${CHANNEL}/media-override`, () =>
      Response.json({
        override: { calls: true, video: null, screenshare: null },
        overrides_allowed: true,
        master: SETTINGS,
      })
    );
    const client = makeClient(io);

    const res = await client.putChannelMediaOverride(CHANNEL, {
      calls: true,
      video: null,
      screenshare: null,
    });

    expect(res.override).toEqual({ calls: true, video: null, screenshare: null });
    const request = io.calls[0]!;
    expect(request.method).toBe('PUT');
    expect(await request.json()).toEqual({
      calls: true,
      video: null,
      screenshare: null,
    });
  });

  it('putChannelMediaOverride surfaces the allowed-off 409 as ApiError', async () => {
    const io = createFetchMock();
    io.on('PUT', `/api/v1/channels/${CHANNEL}/media-override`, () =>
      Response.json(
        {
          error: {
            key: 'overrides_not_allowed',
            code: 40901,
            message: 'This workspace does not allow channel media overrides.',
          },
        },
        { status: 409 }
      )
    );
    const client = makeClient(io);

    const err = await client
      .putChannelMediaOverride(CHANNEL, { calls: true, video: null, screenshare: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).key).toBe('overrides_not_allowed');
  });
});

describe('attachments (composer upload surface)', () => {
  const UPLOADED = {
    id: '6000000000000001',
    filename: 'cat.png',
    content_type: 'image/png',
    size: 3,
    url: '/attachments/6000000000000001/cat.png',
  };

  it('uploadChannelAttachment POSTs multipart FormData to /channels/{id}/attachments', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/attachments', () => Response.json(UPLOADED));
    const client = makeClient(io);

    const uploaded = await client.uploadChannelAttachment(
      '300',
      new File(['abc'], 'cat.png', { type: 'image/png' }),
    );

    expect(uploaded).toEqual(UPLOADED);
    expect(io.calls).toHaveLength(1);
    const request = io.calls[0]!;
    // Multipart boundary must survive: the Http layer must NOT force an
    // application/json Content-Type over the FormData body.
    const contentType = request.headers.get('content-type') ?? '';
    expect(contentType).toContain('multipart/form-data');
    expect(contentType).not.toContain('application/json');
    const form = await request.formData();
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('cat.png');
  });

  it('uploadChannelAttachment accepts an RN {uri,name,type} descriptor (KTD7)', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/attachments', () => Response.json(UPLOADED));
    const client = makeClient(io);

    // RN's FormData takes the descriptor as the VALUE and has no filename
    // parameter, so the widened path must append exactly two arguments.
    const appendSpy = vi.spyOn(FormData.prototype, 'append');
    const descriptor = { uri: 'file:///tmp/cat.png', name: 'cat.png', type: 'image/png' };
    // Snapshot before restoring — `mockRestore()` also clears recorded calls.
    let appendCalls: unknown[][] = [];
    try {
      const uploaded = await client.uploadChannelAttachment('300', descriptor);
      expect(uploaded).toEqual(UPLOADED);
      appendCalls = appendSpy.mock.calls.map((args) => [...args]);
    } finally {
      appendSpy.mockRestore();
    }

    expect(io.calls).toHaveLength(1);
    expect(appendCalls).toHaveLength(1);
    const [field, value, filename] = appendCalls[0]!;
    expect(field).toBe('file');
    expect(value).toBe(descriptor);
    expect(filename).toBeUndefined();
  });

  it('isNativeFileDescriptor distinguishes descriptors from browser files', () => {
    expect(isNativeFileDescriptor({ uri: 'file:///a.png', name: 'a.png', type: 'image/png' })).toBe(
      true
    );
    expect(isNativeFileDescriptor(new File(['a'], 'a.png', { type: 'image/png' }))).toBe(false);
    expect(isNativeFileDescriptor(null)).toBe(false);
    expect(isNativeFileDescriptor({ uri: 'file:///a.png' })).toBe(false);
  });

  it('sendMessage binds staged attachment metadata into the create body', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/messages', () =>
      Response.json({ message: message('5000000000000001', 'look at this') })
    );
    const client = makeClient(io);
    const attachments = [UPLOADED];

    await client.sendMessage('300', { content: 'look at this', attachments });

    const body = JSON.parse((await io.calls[0]!.text()) as string) as {
      content: string;
      attachments: typeof attachments;
    };
    expect(body.content).toBe('look at this');
    expect(body.attachments).toEqual([UPLOADED]);
  });

  it('sendMessage serializes thread_id so a channel POST lands in the thread', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/messages', () =>
      Response.json({ message: message('5000000000000003', 'thread reply') })
    );
    const client = makeClient(io);

    await client.sendMessage('300', { content: 'thread reply', thread_id: '700' });

    const body = JSON.parse((await io.calls[0]!.text()) as string) as {
      content: string;
      thread_id?: string;
    };
    expect(body.thread_id).toBe('700');
  });

  it('sendMessage omits thread_id for a channel-timeline post', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/channels/300/messages', () =>
      Response.json({ message: message('5000000000000004', 'hi') })
    );
    const client = makeClient(io);

    await client.sendMessage('300', { content: 'hi' });

    const body = JSON.parse((await io.calls[0]!.text()) as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('thread_id');
  });

  it('sendThreadMessage carries the attachments param for the thread composer', async () => {
    const io = createFetchMock();
    io.on('POST', '/api/v1/threads/700/messages', () =>
      Response.json({ message: message('5000000000000002', '') })
    );
    const client = makeClient(io);

    await client.sendThreadMessage('700', { content: '', attachments: [UPLOADED] });

    const body = JSON.parse((await io.calls[0]!.text()) as string) as {
      content: string;
      attachments: unknown[];
    };
    expect(body.content).toBe('');
    expect(body.attachments).toEqual([UPLOADED]);
  });

  it('getThreadMessages unwraps the {"messages": [...]} envelope (calls plan U9)', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/threads/700/messages', () =>
      Response.json({ messages: [message('1323802875133952000', 'reply')] })
    );
    const client = makeClient(io);

    const messages = await client.getThreadMessages('700');

    expectTypeOf(messages).toEqualTypeOf<Message[]>();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('reply');
  });

  it('getThreadMessagePage carries both cursors and sends after (#152)', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/threads/700/messages', () =>
      Response.json({
        messages: [message('1323802875133952002', 'newer'), message('1323802875133952001', 'older')],
        oldest_id: '1323802875133952001',
        newest_id: '1323802875133952002',
      })
    );
    const client = makeClient(io);

    const page = await client.getThreadMessagePage('700', { after: '1323802875133952000', limit: 2 });

    expect(page.items.map((m) => m.content)).toEqual(['newer', 'older']);
    expect(page.cursor).toEqual({
      before: '1323802875133952001',
      after: '1323802875133952002',
      limit: 2,
    });
    expect(new URL(io.calls[0]!.url).searchParams.get('after')).toBe('1323802875133952000');
  });

  it('an empty page has no cursors — and a legacy `false` oldest_id reads as none', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/channels/9/messages', () => Response.json({ messages: [], oldest_id: false }));
    const client = makeClient(io);

    const page = await client.getMessagePage('9');

    expect(page.cursor.before).toBeNull();
    expect(page.cursor.after).toBeNull();
  });
});

describe('message marks (#54)', () => {
  it('setMark PUTs the kind/channel/message path with an absolute ISO instant', async () => {
    const io = createFetchMock();
    const mark = {
      kind: 'snooze',
      channel_id: '9',
      message_id: '10',
      due_at: '2026-10-01T09:00:00.000Z',
      state: 'pending',
    };
    io.on('PUT', '/api/v1/users/@me/marks/snooze/channels/9/messages/10', () => Response.json({ mark }));
    const client = makeClient(io);

    const out = await client.setMark('snooze', '9', '10', new Date('2026-10-01T09:00:00Z'));

    expect(out).toEqual(mark);
    const call = io.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(await call.clone().json()).toEqual({ due_at: '2026-10-01T09:00:00.000Z' });
  });

  it('listMarks unwraps the envelope; cancelMark DELETEs the same path', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/users/@me/marks', () => Response.json({ marks: [] }));
    io.on('DELETE', '/api/v1/users/@me/marks/snooze/channels/9/messages/10', () => new Response(null, { status: 204 }));
    const client = makeClient(io);

    expect(await client.listMarks()).toEqual([]);
    await client.cancelMark('snooze', '9', '10');
    expect(io.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });
});

describe('reactions (contract-pinned routes)', () => {
  // 👍 percent-encodes to %F0%9F%91%8D in the path segment — the pinned wire
  // form of a raw-Unicode emoji on the reactions routes.
  const THUMBS = encodeURIComponent('👍');

  it('addReaction PUTs the @me route (204, no body, Bearer)', async () => {
    const io = createFetchMock();
    io.on('PUT', `/api/v1/channels/3000000000000000001/messages/5000000000000001/reactions/${THUMBS}/@me`, (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer at-v1');
      return new Response(null, { status: 204 });
    });
    const client = makeClient(io);

    await client.addReaction('3000000000000000001', '5000000000000001', '👍');

    expect(io.calls).toHaveLength(1);
    const req = io.calls[0]!;
    expect(req.method).toBe('PUT');
    expect(new URL(req.url).pathname).toBe(
      `/api/v1/channels/3000000000000000001/messages/5000000000000001/reactions/${THUMBS}/@me`,
    );
    // No request body on the own-reaction add.
    expect(await req.text()).toBe('');
    expect(req.headers.get(IDEMPOTENCY_KEY_HEADER)).toBeNull();
  });

  it('removeReaction DELETEs the @me route (204)', async () => {
    const io = createFetchMock();
    io.on('DELETE', `/api/v1/channels/3000000000000000001/messages/5000000000000001/reactions/${THUMBS}/@me`, () =>
      new Response(null, { status: 204 })
    );
    const client = makeClient(io);

    await client.removeReaction('3000000000000000001', '5000000000000001', '👍');

    expect(io.calls).toHaveLength(1);
    expect(io.calls[0]!.method).toBe('DELETE');
    expect(new URL(io.calls[0]!.url).pathname).toBe(
      `/api/v1/channels/3000000000000000001/messages/5000000000000001/reactions/${THUMBS}/@me`,
    );
  });

  it('listReactionUsers GETs limit/after exactly once and returns users + next_after', async () => {
    const io = createFetchMock();
    io.on('GET', `/api/v1/channels/3000000000000000001/messages/5000000000000001/reactions/${THUMBS}`, () =>
      Response.json({
        users: [
          { id: '2000000000000000001', username: 'jason' },
          { id: '2000000000000000002', username: 'ada' },
        ],
        next_after: '2000000000000000002',
      })
    );
    const client = makeClient(io);

    const page = await client.listReactionUsers(
      '3000000000000000001',
      '5000000000000001',
      '👍',
      { limit: 25, after: '2000000000000000000' },
    );

    expect(page.users).toHaveLength(2);
    expect(page.users[0]).toEqual({ id: '2000000000000000001', username: 'jason' });
    expect(page.next_after).toBe('2000000000000000002');
    const url = new URL(io.calls[0]!.url);
    expect(url.pathname).toBe(
      `/api/v1/channels/3000000000000000001/messages/5000000000000001/reactions/${THUMBS}`,
    );
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('after')).toBe('2000000000000000000');
    expect([...url.searchParams.keys()]).toHaveLength(2); // each param once
  });
});

describe('thread follow (the shipped members/@me contract)', () => {
  const THREAD = '4000000000000000001';

  it('followThread PATCHes /threads/{id}/members/@me with notify:true', async () => {
    const io = createFetchMock();
    io.on('PATCH', `/api/v1/threads/${THREAD}/members/@me`, () => Response.json({ ok: true }));
    const client = makeClient(io);

    await client.followThread(THREAD);

    const request = io.calls[0]!;
    expect(request.method).toBe('PATCH');
    expect(new URL(request.url).pathname).toBe(`/api/v1/threads/${THREAD}/members/@me`);
    expect(await request.json()).toEqual({ notify: true });
  });

  it('unfollowThread PATCHes notify:false (never the nonexistent /follow route)', async () => {
    const io = createFetchMock();
    io.on('PATCH', `/api/v1/threads/${THREAD}/members/@me`, () => Response.json({ ok: true }));
    const client = makeClient(io);

    await client.unfollowThread(THREAD);

    const request = io.calls[0]!;
    expect(request.method).toBe('PATCH');
    expect(new URL(request.url).pathname).toBe(`/api/v1/threads/${THREAD}/members/@me`);
    expect(await request.json()).toEqual({ notify: false });
  });
});

describe('updateThread (archive, #109)', () => {
  const THREAD = '4000000000000000002';

  it('PATCHes /threads/{id} with archived and unwraps the {"thread": …} envelope', async () => {
    const io = createFetchMock();
    io.on('PATCH', `/api/v1/threads/${THREAD}`, () =>
      Response.json({
        thread: { id: THREAD, channel_id: '900', name: 't', archived: true, created_by: '7' },
      }),
    );
    const client = makeClient(io);

    const thread = await client.updateThread(THREAD, { archived: true });

    const request = io.calls[0]!;
    expect(request.method).toBe('PATCH');
    expect(new URL(request.url).pathname).toBe(`/api/v1/threads/${THREAD}`);
    expect(await request.json()).toEqual({ archived: true });

    // The CALLER gets the thread, not the envelope: reading the raw envelope
    // left `archived` undefined, which is the bug this unwrap prevents.
    expect(thread.archived).toBe(true);
    expect(thread.id).toBe(THREAD);
  });
});

describe('listRoles envelope', () => {
  it('unwraps the server\'s {"roles": [...]} envelope into items', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/42/roles', () =>
      Response.json({ roles: [{ id: '1', name: 'admin', permissions: '0' }] })
    );
    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({ ...TOKENS }),
      fetchImpl: io.fetchMock as unknown as typeof fetch,
    });

    const page = await client.listRoles('42');

    expect(io.calls[0]?.url).toContain('/workspaces/42/roles');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.name).toBe('admin');
  });
});

describe('listPeople envelope', () => {
  it("unwraps the server's {people, next_before} envelope and carries the cursor", async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/42/people', () =>
      Response.json({
        people: [{ id: '7', username: 'ace', roles: [], kind: 'human' }],
        next_before: '7',
      })
    );
    const client = new CytaleApiClient({
      baseUrl: 'https://api.test',
      tokens: createInMemoryTokenProvider({ ...TOKENS }),
      fetchImpl: io.fetchMock as unknown as typeof fetch,
    });

    const page = await client.listPeople('42');

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.username).toBe('ace');
    expect(page.cursor.before).toBe('7');
  });
});

describe('listAllPeople (bounded cursor paging)', () => {
  /**
   * The server's people read, modelled exactly: rows in DESCENDING id order,
   * at most `limit` per page, `next_before` = the page's last id and ONLY
   * when the page came back full (a short page means the roster is
   * exhausted — user_controller.ex `people/2`).
   */
  function peopleResponder(count: number, pageSize = 50) {
    const all = Array.from({ length: count }, (_, i) => String(1_000_000 + i)).sort().reverse();
    return (request: Request) => {
      const before = new URL(request.url).searchParams.get('before');
      const remaining = before === null ? all : all.filter((id) => id < before);
      const page = remaining.slice(0, pageSize);
      return Response.json({
        people: page.map((id) => ({
          id,
          username: `member-${id}`,
          nickname: null,
          joined_at: '2025-01-01T00:00:00.000Z',
          roles: [],
          kind: 'human',
        })),
        next_before: page.length === pageSize ? page[page.length - 1] : null,
      });
    };
  }

  function setup(handler: Handler) {
    const io = createFetchMock();
    io.on('GET', '/api/v1/workspaces/42/people', handler);
    return { io, client: makeClient(io) };
  }

  it('follows next_before until the roster is exhausted (120 members → 3 requests)', async () => {
    const { io, client } = setup(peopleResponder(120));

    const page = await client.listAllPeople('42');

    expect(page.items).toHaveLength(120);
    expect(new Set(page.items.map((m) => m.id)).size).toBe(120); // no duplicates
    expect(page.truncated).toBe(false);
    expect(io.calls).toHaveLength(3); // 50 + 50 + 20
  });

  it('feeds the previous page’s cursor into the next request', async () => {
    const { io, client } = setup(peopleResponder(120));

    await client.listAllPeople('42');

    const before = (index: number) =>
      new URL(io.calls[index]!.url).searchParams.get('before');
    expect(before(0)).toBeNull();
    // Server order is DESCENDING, so the 50th row of page 1 (id 1000119 down
    // to 1000070) is the next page's exclusive cursor.
    expect(before(1)).toBe('1000070');
    expect(before(2)).toBe('1000020');
  });

  it('is one request for a roster that fits a page', async () => {
    const { io, client } = setup(peopleResponder(12));

    const page = await client.listAllPeople('42');

    expect(page.items).toHaveLength(12);
    expect(page.truncated).toBe(false);
    expect(io.calls).toHaveLength(1);
  });

  it('stops at PEOPLE_PAGE_CAP and reports the truncation', async () => {
    const { io, client } = setup(peopleResponder(600));

    const page = await client.listAllPeople('42');

    expect(io.calls).toHaveLength(PEOPLE_PAGE_CAP);
    expect(page.items).toHaveLength(PEOPLE_PAGE_CAP * 50); // 500 of 600
    expect(page.truncated).toBe(true);
  });

  it('refuses to loop on a cursor that does not advance', async () => {
    const { io, client } = setup(() =>
      Response.json({ people: [{ id: '5', username: 'stuck', roles: [], kind: 'human' }], next_before: '5' })
    );

    const page = await client.listAllPeople('42');

    expect(io.calls).toHaveLength(2); // page 1, then the repeat cursor ends it
    expect(page.truncated).toBe(false);
  });

  it('keeps the caller’s filters on every page', async () => {
    const { io, client } = setup(peopleResponder(120));

    await client.listAllPeople('42', { query: 'jan', limit: 50 });

    for (const call of io.calls) {
      const url = new URL(call.url);
      expect(url.searchParams.get('query')).toBe('jan');
      expect(url.searchParams.get('limit')).toBe('50');
    }
  });
});

describe('DMs (#94 — the create/list boundary the web picker builds on)', () => {
  let io: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    io = createFetchMock();
  });

  function dmRow(id: string, peerId: string) {
    // The wire's DM row shape: no type/workspace_id/name (U9).
    return {
      id,
      user_ids: ['2000000000000000001', peerId],
      recipients: [{ id: peerId, username: 'peer', avatar_url: null }],
      created_at: '2026-09-01T00:00:00.000Z',
      last_message_id: null,
    };
  }

  it('createDM posts to /users/{id}/channels and completes the DM row', async () => {
    io.on('POST', '/api/v1/users/500000000000000001/channels', () =>
      Response.json({ channel: dmRow('600000000000000001', '500000000000000001') }, { status: 201 })
    );
    const client = makeClient(io);

    const channel = await client.createDM('500000000000000001');

    const url = new URL(io.calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/users/500000000000000001/channels');
    expect(io.calls[0]!.method).toBe('POST');
    // The row is a DM by definition — the column's `type === 'dm'` filter
    // must see it, and the workspace-less identity is explicit.
    expect(channel.type).toBe('dm');
    expect(channel.workspace_id).toBeNull();
    expect(channel.name).toBe('');
    expect(channel.id).toBe('600000000000000001');
    expect(channel.recipients).toEqual([{ id: '500000000000000001', username: 'peer', avatar_url: null }]);
  });

  it('createDM surfaces the server’s refusal as ApiError (dedup/rejection path)', async () => {
    io.on('POST', '/api/v1/users/500000000000000001/channels', () =>
      Response.json(
        { error: { key: 'validation_failed', code: 40001, message: 'DMs require a human participant' } },
        { status: 400 }
      )
    );
    const client = makeClient(io);

    await expect(client.createDM('500000000000000001')).rejects.toBeInstanceOf(ApiError);
  });

  it('listDMChannels unwraps the {"channels": [...]} envelope and completes rows', async () => {
    io.on('GET', '/api/v1/users/@me/channels', () =>
      Response.json({ channels: [dmRow('600000000000000001', '500000000000000001')] })
    );
    const client = makeClient(io);

    const page: ListResponse<Channel> = await client.listDMChannels();

    const url = new URL(io.calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/users/@me/channels');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.type).toBe('dm');
    expect(page.items[0]!.workspace_id).toBeNull();
  });
});

// Notification controls (2026-09-27): the preference read carries the
// per-workspace broadcast switch beside the levels, and the switch has its
// own write that never restates a level.
describe('notification preferences', () => {
  it('getNotificationPreferences returns levels and the broadcast switch list', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/users/@me/notification-preferences', () =>
      Response.json({
        preferences: [{ scope: 'channel', entity_id: '5', level: 'mute' }],
        suppress_broadcasts: ['9'],
      }),
    );
    const set = await makeClient(io).getNotificationPreferences();
    expect(set.preferences).toEqual([{ scope: 'channel', entity_id: '5', level: 'mute' }]);
    expect(set.suppress_broadcasts).toEqual(['9']);
  });

  it('an older server with no switch list reads as nothing suppressed', async () => {
    const io = createFetchMock();
    io.on('GET', '/api/v1/users/@me/notification-preferences', () => Response.json({ preferences: [] }));
    const set = await makeClient(io).getNotificationPreferences();
    expect(set.suppress_broadcasts).toEqual([]);
  });

  it('setBroadcastSuppression PUTs the workspace scope with the boolean only', async () => {
    const io = createFetchMock();
    let body: unknown = null;
    io.on('PUT', '/api/v1/users/@me/notification-preferences', async (req) => {
      body = await req.json();
      return Response.json({ scope: 'workspace', entity_id: '9', suppress_broadcasts: true });
    });
    await makeClient(io).setBroadcastSuppression('9', true);
    expect(body).toEqual({ scope: 'workspace', entity_id: '9', suppress_broadcasts: true });
  });

  it('a thread level PUTs the thread scope', async () => {
    const io = createFetchMock();
    let body: unknown = null;
    io.on('PUT', '/api/v1/users/@me/notification-preferences', async (req) => {
      body = await req.json();
      return Response.json({});
    });
    await makeClient(io).setNotificationPreference('thread', 'mute', '77');
    expect(body).toEqual({ scope: 'thread', level: 'mute', entity_id: '77' });
  });
});
