/**
 * @cytale/api-client — the shared client-error reporter (#88).
 *
 * The acceptance claims this file proves, in order:
 *   * a report carries the server's request id for a failed call;
 *   * the same fingerprint twice produces ONE send (a crash loop cannot hose
 *     the endpoint), and an exception and a rejection are two distinct events;
 *   * a report can carry no message content **by construction** — the payload
 *     key set is asserted exactly, and ids in a route land redacted;
 *   * reporting never throws, and a failed send is dropped, not retried.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ClientErrorReporter,
  describeThrown,
  fingerprintOf,
  gatewayTelemetryDeltas,
  hasForbiddenField,
  redact,
  redactPath,
  type ClientErrorPayload,
} from '../client-errors.js';
import type { RequestFailure } from '../http.js';
import { ApiError } from '../types.js';

/** Let the fire-and-forget `send` microtask run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function collector() {
  const sent: ClientErrorPayload[] = [];
  return {
    sent,
    send: async (payload: ClientErrorPayload) => {
      sent.push(payload);
    },
  };
}

describe('redaction', () => {
  it('replaces snowflakes, UUIDs, emails and query values with placeholders', () => {
    expect(redact('user 1323802875133952000 said something')).toBe('user :id said something');
    expect(redact('id 3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('id :id');
    expect(redact('mail jason@example.com please')).toBe('mail :email please');
    expect(redact('GET /x?token=secret&code=abc123')).toBe('GET /x?token=[redacted]&code=[redacted]');
    expect(redact('Bearer eyJhbGciOi.J9abc.def')).toBe('Bearer [redacted]');
  });

  it('redacts ids out of a captured path but keeps its shape', () => {
    // The privacy rule, as an assertion: an error row cannot be used as a map
    // of a private workspace.
    expect(redactPath('/api/v1/workspaces/1323802875133952000/channels/1323802875133952999/messages'))
      .toBe('/api/v1/workspaces/:id/channels/:id/messages');
    // Hash routes ARE the path on web and survive; their ids do not.
    expect(redactPath('#/workspaces/1323802875133952000/channels/1323802875133952999'))
      .toBe('#/workspaces/:id/channels/:id');
    // Query strings never survive — a path is not a place for a token.
    expect(redactPath('/api/v1/invites/abc?token=xyz#frag')).toBe('/api/v1/invites/abc');
  });

  it('truncates an over-long value rather than capturing it whole', () => {
    const long = 'x'.repeat(5000);
    expect(redactPath(long).length).toBeLessThan(5000);
    expect(redactPath(long)).toContain('[truncated]');
  });
});

describe('payload shape — no message content, by construction', () => {
  it('sends exactly the diagnosed fields and nothing that could hold content', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'web', send: sink.send });

    reporter.report({
      source: 'api.request',
      message: 'Request failed with status 500',
      route: '/api/v1/channels/1323802875133952000/messages',
      status: 500,
      requestId: 'GEBMr97eLMHtGWsAAAVj',
      detail: 'POST internal_error',
    });
    await settle();

    expect(sink.sent).toHaveLength(1);
    const payload = sink.sent[0]!;
    expect(Object.keys(payload).sort()).toEqual(
      ['client', 'detail', 'fingerprint', 'message', 'request_id', 'route', 'source', 'stack', 'status', 'version'].filter(
        key => key in payload
      ).sort()
    );
    // The one thing that turns an error log into a content store is absent:
    for (const forbidden of ['body', 'headers', 'cookies', 'token', 'content', 'email', 'authorization']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
    expect(hasForbiddenField(payload)).toBe(false);
    // Ids in the route are redacted before the payload leaves the process.
    expect(payload.route).toBe('/api/v1/channels/:id/messages');
    // ...and the trace handle is carried verbatim.
    expect(payload.request_id).toBe('GEBMr97eLMHtGWsAAAVj');
  });

  it('strips any content-shaped field a capture point hands in (construction, not filtering)', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'web', send: sink.send });

    // Simulate a future capture point trying to attach a failed POST's body
    // or the response headers. The payload is built from named fields, so
    // there is no path for either to reach the wire.
    reporter.report({
      source: 'api.request',
      message: 'nope',
      ...({ body: { content: 'the message text' }, headers: { authorization: 'Bearer x' } } as object),
    });
    await settle();

    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).not.toHaveProperty('body');
    expect(sink.sent[0]).not.toHaveProperty('headers');
    expect(Object.keys(sink.sent[0]!).sort()).toEqual(['client', 'fingerprint', 'message', 'source']);
  });

  it('has a runtime guard for the payload builder itself', () => {
    // The belt to the type system's braces: if a future edit widens the
    // builder, this refuses the payload rather than shipping content.
    expect(hasForbiddenField({ message: 'x', body: {} })).toBe(true);
    expect(hasForbiddenField({ message: 'x', message_content: 'hi' })).toBe(true);
    expect(hasForbiddenField({ message: 'x', request_id: 'abc', status: 500 })).toBe(false);
  });
});

describe('client discipline', () => {
  it('sends the same fingerprint ONCE per session (a crash loop cannot hose the endpoint)', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'web', send: sink.send });

    for (let i = 0; i < 25; i += 1) {
      reporter.captureThrown(new TypeError('boom'), { source: 'window.onerror' });
    }
    await settle();

    expect(sink.sent).toHaveLength(1);
    expect(reporter.getState()).toMatchObject({ sent: 1, deduped: 24 });
  });

  it('treats an exception and an unhandled rejection as two distinct events', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'web', send: sink.send });

    reporter.captureThrown(new TypeError('boom'), { source: 'window.onerror' });
    reporter.captureThrown(new TypeError('boom'), { source: 'unhandledrejection' });
    await settle();

    expect(sink.sent).toHaveLength(2);
    expect(sink.sent.map(p => p.source).sort()).toEqual(['unhandledrejection', 'window.onerror']);
    expect(sink.sent[0]!.fingerprint).not.toBe(sink.sent[1]!.fingerprint);
  });

  it('keeps two different failed routes apart even when their messages read alike', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'web', send: sink.send });

    const failure = (path: string): RequestFailure => ({
      method: 'POST',
      path,
      status: 500,
      requestId: null,
      key: 'internal_error',
      error: new ApiError({ key: 'internal_error', code: 50001, message: 'Request failed with status 500', status: 500 }),
    });

    reporter.observeApiFailure(failure('/api/v1/channels/1/messages'));
    reporter.observeApiFailure(failure('/api/v1/workspaces/2/channels'));
    await settle();

    expect(sink.sent).toHaveLength(2);
  });

  it('caps the session at maxPerSession reports', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'web', send: sink.send, maxPerSession: 3 });

    for (const marker of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']) {
      reporter.captureThrown(new Error(`distinct ${marker}`), { source: 'window.onerror' });
    }
    await settle();

    expect(sink.sent).toHaveLength(3);
    expect(reporter.getState().throttled).toBe(7);
  });

  it('caps distinct new fingerprints per window and recovers when it rolls', async () => {
    let now = 1_000;
    const sink = collector();
    const reporter = new ClientErrorReporter({
      client: 'web',
      send: sink.send,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => now,
    });

    reporter.captureThrown(new Error('a'), { source: 'window.onerror' });
    reporter.captureThrown(new Error('b'), { source: 'window.onerror' });
    reporter.captureThrown(new Error('c'), { source: 'window.onerror' });
    await settle();
    expect(sink.sent).toHaveLength(2);

    now += 60_000;
    reporter.captureThrown(new Error('d'), { source: 'window.onerror' });
    await settle();
    expect(sink.sent).toHaveLength(3);
  });

  it('never throws, even when the transport rejects or the route resolver does', async () => {
    const reporter = new ClientErrorReporter({
      client: 'mobile',
      send: async () => {
        throw new Error('offline');
      },
      route: () => {
        throw new Error('route exploded');
      },
    });

    expect(() => reporter.captureThrown(new TypeError('boom'), { source: 'unhandledrejection' })).not.toThrow();
    await settle();
    // The failed send is DROPPED, not retried: at most one attempt per event.
    expect(reporter.getState().sent).toBe(1);
  });

  it('queues while offline and sends each event exactly once on flush', async () => {
    const sink = collector();
    let offline = true;
    const reporter = new ClientErrorReporter({
      client: 'web',
      send: sink.send,
      isOffline: () => offline,
    });

    reporter.captureThrown(new TypeError('offline boom'), { source: 'window.onerror' });
    await settle();
    expect(sink.sent).toHaveLength(0);
    expect(reporter.getState().queued).toBe(1);

    offline = false;
    reporter.flush();
    await settle();
    expect(sink.sent).toHaveLength(1);

    // Flushing again is a no-op — no duplicate.
    reporter.flush();
    await settle();
    expect(sink.sent).toHaveLength(1);
  });
});

describe('describing thrown values', () => {
  it('handles Error, strings and arbitrary objects without throwing', () => {
    expect(describeThrown(new TypeError('boom')).message).toBe('boom');
    expect(describeThrown('plain string').message).toBe('plain string');
    expect(describeThrown({ reason: 'a reason' }).message).toBe('a reason');
    expect(describeThrown(null).message).toBe('Unhandled non-error value: object');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeThrown(circular)).not.toThrow();
  });

  it('redacts ids that leaked into a message', () => {
    expect(describeThrown(new Error('failed for 1323802875133952000')).message).toBe('failed for :id');
  });
});

describe('gateway telemetry → the socket story', () => {
  it('reports only the counters that INCREASED, and one report per counter', async () => {
    const previous = { malformed_frames_total: 0, reconnects_total: 1, resume_gap_total: 0 };
    const current = { malformed_frames_total: 2, reconnects_total: 3, resume_gap_total: 0 };

    const deltas = gatewayTelemetryDeltas(previous, current);
    expect(deltas).toEqual([
      { counter: 'malformed_frames_total', delta: 2, total: 2 },
      { counter: 'reconnects_total', delta: 2, total: 3 },
    ]);

    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'web', send: sink.send });
    reporter.observeGatewayDeltas(deltas);
    await settle();

    expect(sink.sent).toHaveLength(2);
    expect(sink.sent[0]).toMatchObject({
      source: 'gateway.telemetry',
      detail: 'malformed_frames_total=+2 (total 2)',
    });
    expect(sink.sent[0]!.fingerprint).not.toBe(sink.sent[1]!.fingerprint);
  });

  it('is silent when nothing moved, and on a missing snapshot', () => {
    expect(gatewayTelemetryDeltas(null, null)).toEqual([]);
    expect(gatewayTelemetryDeltas({}, { malformed_frames_total: 0 })).toEqual([]);
  });

  it('watches the dispatch-error counter (hardening 6.2)', () => {
    const deltas = gatewayTelemetryDeltas(
      { dispatch_errors_total: 0 },
      { dispatch_errors_total: 3 },
    );
    expect(deltas).toEqual([{ counter: 'dispatch_errors_total', delta: 3, total: 3 }]);
  });
});

describe('fingerprints', () => {
  it('is stable across rebuilds (digits collapse) and varies with the source', () => {
    const a = fingerprintOf('window.onerror', 'boom', 'at foo (bundle.js:12:5)');
    const b = fingerprintOf('window.onerror', 'boom', 'at foo (bundle.js:99:5)');
    expect(a).toBe(b);
    expect(fingerprintOf('unhandledrejection', 'boom')).not.toBe(fingerprintOf('window.onerror', 'boom'));
  });

  it('produces a bounded hex key', () => {
    const key = fingerprintOf('api.request', 'x', undefined, '/api/v1/channels/:id/messages');
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('the api.request capture point', () => {
  it('always carries the server request id when the response had one', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'desktop', send: sink.send });

    reporter.observeApiFailure({
      method: 'GET',
      path: '/api/v1/users/@me',
      status: 503,
      requestId: 'GEBMr97eLMHtGWsAAAVj',
      key: 'unavailable',
      error: new ApiError({ key: 'unavailable', code: 50301, message: 'down', status: 503 }),
    });
    await settle();

    expect(sink.sent[0]).toMatchObject({
      client: 'desktop',
      source: 'api.request',
      status: 503,
      request_id: 'GEBMr97eLMHtGWsAAAVj',
      route: '/api/v1/users/@me',
      detail: 'GET unavailable',
    });
  });

  it('omits request_id entirely when there was none (never fabricated)', async () => {
    const sink = collector();
    const reporter = new ClientErrorReporter({ client: 'mobile', send: sink.send });

    reporter.observeApiFailure({
      method: 'GET',
      path: '/api/v1/users/@me',
      status: 0,
      requestId: null,
      key: 'network_error',
      error: new ApiError({ key: 'network_error', code: 0, message: 'Failed to fetch', status: 0 }),
    });
    await settle();

    expect(sink.sent[0]).not.toHaveProperty('request_id');
    // status 0 (transport) is not a server status and is not sent as one.
    expect(sink.sent[0]).not.toHaveProperty('status');
  });
});
