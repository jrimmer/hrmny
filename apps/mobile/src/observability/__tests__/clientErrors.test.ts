/**
 * @cytale/mobile — the RN capture points (#88).
 *
 * The claims this suite proves:
 *   * an uncaught error the RN global handler receives is reported ONCE, and
 *     the handler RN installed is still called (chaining, not replacement);
 *   * an unhandled rejection is reported once, and any previous handler is
 *     still called;
 *   * the same fingerprint twice produces ONE report;
 *   * the socket story comes from the gateway client's EXISTING telemetry;
 *   * reporting never throws, and a report that fails to send is dropped.
 */
import { ClientErrorReporter, type ClientErrorPayload } from '@cytale/api-client';

import {
  getClientErrorRoute,
  installMobileErrorHandlers,
  setClientErrorRoute,
} from '../clientErrors';

type Handler = (error: unknown, isFatal?: boolean) => void;

function fakeGlobals() {
  const previousCalls: unknown[] = [];
  let handler: Handler = (error, isFatal) => {
    previousCalls.push([error, isFatal]);
  };
  const target = {
    ErrorUtils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next: Handler) => {
        handler = next;
      },
    },
    onunhandledrejection: ((event: unknown) => {
      previousCalls.push(['rejection', event]);
    }) as ((event: unknown) => void) | null,
  };
  return {
    target,
    previousCalls,
    fire: (error: unknown, isFatal?: boolean) => handler(error, isFatal),
  };
}

function reporter() {
  const sent: ClientErrorPayload[] = [];
  const instance = new ClientErrorReporter({
    client: 'mobile',
    send: async payload => {
      sent.push(payload);
    },
    version: 'va08ce92',
    // The module-level route the shell sets, read the same way the production
    // singleton reads it — so the wiring `setClientErrorRoute` → payload is
    // what this exercises.
    route: getClientErrorRoute,
  });
  return { sent, reporter: instance };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** Flush the reporter's fire-and-forget microtask without touching timers. */
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('RN global error handler', () => {
  it('reports an uncaught error once and still calls the handler it replaced', async () => {
    const { sent, reporter: errors } = reporter();
    const globals = fakeGlobals();
    const uninstall = installMobileErrorHandlers({ reporter: errors, target: globals.target });

    globals.fire(new TypeError('rn boom'), true);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      client: 'mobile',
      source: 'window.onerror',
      version: 'va08ce92',
      detail: 'fatal=true',
    });

    // Chaining, not replacement: RN's own redbox/LogBox handling still runs.
    expect(globals.previousCalls).toHaveLength(1);
    expect((globals.previousCalls[0] as unknown[])[1]).toBe(true);

    uninstall();
  });

  it('reports the same error twice as ONE report', async () => {
    const { sent, reporter: errors } = reporter();
    const globals = fakeGlobals();
    const uninstall = installMobileErrorHandlers({ reporter: errors, target: globals.target });

    for (let i = 0; i < 4; i += 1) globals.fire(new TypeError('rn boom'));
    await settle();

    expect(sent).toHaveLength(1);
    expect(errors.getState().deduped).toBe(3);

    uninstall();
  });

  it('restores the previous handler on uninstall', () => {
    const { reporter: errors } = reporter();
    const globals = fakeGlobals();
    const original = globals.target.ErrorUtils.getGlobalHandler();

    const uninstall = installMobileErrorHandlers({ reporter: errors, target: globals.target });
    expect(globals.target.ErrorUtils.getGlobalHandler()).not.toBe(original);

    uninstall();
    expect(globals.target.ErrorUtils.getGlobalHandler()).toBe(original);
  });
});

describe('unhandled rejections', () => {
  it('reports the rejection reason once and chains the previous hook', async () => {
    const { sent, reporter: errors } = reporter();
    const globals = fakeGlobals();
    const uninstall = installMobileErrorHandlers({ reporter: errors, target: globals.target });

    const hook = globals.target.onunhandledrejection;
    expect(typeof hook).toBe('function');
    hook!({ reason: new Error('rejected in rn') });
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: 'unhandledrejection', message: 'rejected in rn' });
    // The hook that was there before still ran (the fake records it as a pair).
    expect(globals.previousCalls.some(call => Array.isArray(call) && call[0] === 'rejection')).toBe(true);

    uninstall();
  });

  it('handles a non-object rejection reason without throwing', async () => {
    const { sent, reporter: errors } = reporter();
    const globals = fakeGlobals();
    const uninstall = installMobileErrorHandlers({ reporter: errors, target: globals.target });

    expect(() => globals.target.onunhandledrejection!('just a string')).not.toThrow();
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toBe('just a string');

    uninstall();
  });
});

describe('context on every report', () => {
  it('carries the current route, redacted of ids', async () => {
    const { sent, reporter: errors } = reporter();
    const globals = fakeGlobals();
    const uninstall = installMobileErrorHandlers({ reporter: errors, target: globals.target });

    setClientErrorRoute('/channel/1323802875133952000');
    globals.fire(new Error('route test'));
    await settle();

    expect(sent[0]!.route).toBe('/channel/:id');

    setClientErrorRoute(undefined);
    uninstall();
  });
});

describe('the socket story', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports the counters that MOVED — no new socket instrumentation', async () => {
    jest.useFakeTimers();
    const { sent, reporter: errors } = reporter();
    const globals = fakeGlobals();
    const telemetry: Record<string, number> = { malformed_frames_total: 0, reconnects_total: 2 };

    const uninstall = installMobileErrorHandlers({
      reporter: errors,
      target: globals.target,
      gateway: () => ({ getTelemetry: () => ({ ...telemetry }) }),
      pollIntervalMs: 10,
    });

    // The install's first poll is the BASELINE: what already happened is the
    // state of the world, not an incident.
    expect(sent).toHaveLength(0);

    telemetry.malformed_frames_total = (telemetry.malformed_frames_total ?? 0) + 3;
    jest.advanceTimersByTime(10);
    await flushMicrotasks();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      source: 'gateway.telemetry',
      detail: 'malformed_frames_total=+3 (total 3)',
    });

    // Nothing moved: no duplicate.
    jest.advanceTimersByTime(10);
    await flushMicrotasks();
    expect(sent).toHaveLength(1);

    uninstall();
  });
});

describe('never throws', () => {
  it('swallows a transport failure instead of raising into the global handler', async () => {
    const errors = new ClientErrorReporter({
      client: 'mobile',
      send: async () => {
        throw new Error('ingest unreachable');
      },
    });
    const globals = fakeGlobals();
    const uninstall = installMobileErrorHandlers({ reporter: errors, target: globals.target });

    expect(() => globals.fire(new Error('boom'))).not.toThrow();
    await settle();
    // The failed send is dropped, never retried.
    expect(errors.getState().sent).toBe(1);

    uninstall();
  });
});
