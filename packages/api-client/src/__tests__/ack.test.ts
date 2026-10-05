/**
 * @cytale/api-client — POST /channels/{id}/ack body shape (tui plan U11).
 *
 * The method used to send `{ message_id }` (singular). The server's route
 * matches a NON-EMPTY LIST:
 *
 *   def ack(conn, %{"channel_id" => cid, "message_ids" => ids})
 *       when is_list(ids) and ids != [] do
 *     ...
 *   def ack(conn, _params), do: error(conn, 400, "validation_failed", "message_ids is required")
 *     — apps/server/lib/cytale_web/controllers/message_controller.ex:55-87
 *
 * so every call 400'd. It had no production caller (the shipping clients ack
 * over the gateway) until the terminal client became its first one, where a
 * mark-read rides this REST path because it is the only one that persists the
 * watermark. The body this fix sends is the one the server's own suite and
 * compat surface already post:
 *   * `apps/server/test/cytale_web/controllers/message_controller_test.exs:543`
 *     and `native_authorization_test.exs:131` post `%{"message_ids" => [id]}`;
 *   * `apps/server/lib/cytale_web/controllers/compat/messages_controller.ex:240`
 *     builds `message_ids: [message_id]`.
 *
 * The server's guard is mirrored below so both halves are asserted: the body
 * this method now sends passes it, and the body it used to send does not.
 * (A full wire round-trip against a running server belongs to the server
 * suite / U17's end-to-end script, not to this package's unit suite.)
 */
import { describe, expect, it } from 'vitest';

import { CytaleApiClient } from '../api-client.js';
import { createInMemoryTokenProvider } from '../types.js';

const CHANNEL = '3000000000000000001';
const MESSAGE = '5000000000000000001';

type Handler = (request: Request) => Response | Promise<Response>;

function createFetchMock() {
  const calls: Request[] = [];
  const routes = new Map<string, Handler>();
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    // Record a CLONE: a route handler reads the real request's body, and a
    // test that reads the recorded one afterwards would find it consumed.
    calls.push(request.clone());
    const handler = routes.get(`${request.method} ${new URL(request.url).pathname}`);
    if (!handler) {
      return Response.json({ error: { key: 'no_route', code: 40404, message: 'unrouted' } }, { status: 404 });
    }
    return await handler(request);
  };
  return {
    fetchMock: fetchMock as unknown as typeof fetch,
    calls,
    on(method: string, path: string, handler: Handler) {
      routes.set(`${method} ${path}`, handler);
    },
  };
}

function makeClient(io: ReturnType<typeof createFetchMock>): CytaleApiClient {
  return new CytaleApiClient({
    baseUrl: 'https://api.test',
    tokens: createInMemoryTokenProvider({
      access_token: 'at-v1',
      refresh_token: 'rt-v1',
      expires_in: 900,
    }),
    fetchImpl: io.fetchMock,
  });
}

/**
 * The server's ack validation, transcribed from
 * `CytaleWeb.MessageController.ack/2`: a non-empty list of decimal-string ids
 * (the handler maps them through `String.to_integer/1`), else 400
 * `validation_failed` / "message_ids is required".
 */
function serverAckGuard(body: unknown): { status: number; body: unknown } {
  const ids = (body as { message_ids?: unknown } | null)?.message_ids;
  const valid =
    Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && /^\d+$/.test(id));
  if (!valid) {
    return {
      status: 400,
      body: { error: { key: 'validation_failed', code: 40001, message: 'message_ids is required' } },
    };
  }
  return { status: 200, body: { acknowledged: (ids as string[])[ids.length - 1] } };
}

describe('ackChannel', () => {
  it('posts a non-empty message_ids list that the server’s own validation accepts', async () => {
    const io = createFetchMock();
    io.on('POST', `/api/v1/channels/${CHANNEL}/ack`, async (request) => {
      const body = (await request.json()) as unknown;
      const result = serverAckGuard(body);
      return Response.json(result.body as object, { status: result.status });
    });

    await expect(makeClient(io).ackChannel(CHANNEL, MESSAGE)).resolves.toBeUndefined();

    expect(io.calls).toHaveLength(1);
    const request = io.calls[0]!;
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(`/api/v1/channels/${CHANNEL}/ack`);
    expect(request.headers.get('authorization')).toBe('Bearer at-v1');
    // The list, exactly — not `message_id`, and not a bare string.
    expect(await request.text()).toBe(JSON.stringify({ message_ids: [MESSAGE] }));
  });

  it('surfaces nothing as an error for a 200 acknowledgement', async () => {
    const io = createFetchMock();
    io.on('POST', `/api/v1/channels/${CHANNEL}/ack`, () =>
      Response.json({ acknowledged: MESSAGE }),
    );

    await expect(makeClient(io).ackChannel(CHANNEL, MESSAGE)).resolves.toBeUndefined();
  });

  it('the singular body this method used to send is rejected by that validation', async () => {
    // The regression this unit fixes, asserted rather than described.
    expect(serverAckGuard({ message_id: MESSAGE })).toMatchObject({
      status: 400,
      body: { error: { key: 'validation_failed' } },
    });
    // …and the valid shapes stay accepted.
    expect(serverAckGuard({ message_ids: [MESSAGE] })).toEqual({
      status: 200,
      body: { acknowledged: MESSAGE },
    });
    expect(serverAckGuard({ message_ids: [] })).toMatchObject({ status: 400 });
  });

  it('a 404 from an unreadable channel surfaces as ApiError, not a silent success', async () => {
    const io = createFetchMock();
    io.on('POST', `/api/v1/channels/${CHANNEL}/ack`, () =>
      Response.json({ error: { key: 'channel_not_found', code: 40404, message: 'No channel with that id' } }, { status: 404 }),
    );

    const err = await makeClient(io)
      .ackChannel(CHANNEL, MESSAGE)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ key: 'channel_not_found', status: 404 });
  });
});

/**
 * The floor half of the same route (terminal plan U10/R22).
 *
 * `last_read_id` is INCLUSIVE, so the ack can only ever mark things read; a
 * floor is the only way to tell the server "this message is unread" and have it
 * persist. The route reads three distinct states off the key's presence, so
 * the client must be able to express all three — and the important one is the
 * default: a caller that knows nothing about floors must send a body that
 * leaves the floor alone.
 */
function serverFloorGuard(body: unknown): 'leave' | 'clear' | number | 'invalid' {
  const params = body as { unread_floor?: unknown } | null;
  if (params === null || !('unread_floor' in params)) return 'leave';
  const value = params.unread_floor;
  if (value === null) return 'clear';
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 'invalid';
}

describe('ackChannel — the exclusive unread floor', () => {
  async function sentBody(options?: { unreadFloor?: string | null }): Promise<string> {
    const io = createFetchMock();
    let seen = '';
    io.on('POST', `/api/v1/channels/${CHANNEL}/ack`, async (request) => {
      seen = await request.text();
      return Response.json({ acknowledged: MESSAGE });
    });
    await makeClient(io).ackChannel(CHANNEL, MESSAGE, options ?? {});
    return seen;
  }

  it('omits the key entirely when no floor is asked for, so the floor is left alone', async () => {
    const raw = await sentBody();
    expect(raw).toBe(JSON.stringify({ message_ids: [MESSAGE] }));
    expect(Object.hasOwn(JSON.parse(raw) as object, 'unread_floor')).toBe(false);
    expect(serverFloorGuard(JSON.parse(raw))).toBe('leave');
  });

  it('sends an id to set the floor — the message named is the one that reads unread', async () => {
    const floor = '5000000000000000009';
    const raw = await sentBody({ unreadFloor: floor });
    expect(JSON.parse(raw)).toEqual({ message_ids: [MESSAGE], unread_floor: floor });
    expect(serverFloorGuard(JSON.parse(raw))).toBe(Number(floor));
  });

  it('sends an explicit null to clear the floor — distinct from omitting it', async () => {
    const raw = await sentBody({ unreadFloor: null });
    expect(JSON.parse(raw)).toEqual({ message_ids: [MESSAGE], unread_floor: null });
    // The distinction that matters: `null` clears, absence leaves. A client
    // that collapsed the two would silently stop clearing floors.
    expect(serverFloorGuard(JSON.parse(raw))).toBe('clear');
    expect(serverFloorGuard({ message_ids: [MESSAGE] })).toBe('leave');
  });

  it('a non-id floor is rejected by the server’s own validation', () => {
    expect(serverFloorGuard({ message_ids: [MESSAGE], unread_floor: 'not-an-id' })).toBe('invalid');
    expect(serverFloorGuard({ message_ids: [MESSAGE], unread_floor: 0 })).toBe('invalid');
    expect(serverFloorGuard({ message_ids: [MESSAGE], unread_floor: -1 })).toBe('invalid');
  });
});
