/**
 * @cytale/web — the web capture points (#88).
 *
 * The acceptance claims this suite proves:
 *   * an exception and an unhandled rejection each produce exactly ONE ingest
 *     call;
 *   * the same fingerprint twice produces ONE (a crash loop cannot hose the
 *     endpoint);
 *   * the React error boundary reports the render failure it caught and shows
 *     a fallback instead of a blank page;
 *   * the socket story is re-reported from the gateway client's EXISTING
 *     telemetry counters, with no new instrumentation;
 *   * a report held while offline goes out on `online`, exactly once.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ClientErrorReporter, type ClientErrorPayload } from '@cytale/api-client';
import type { GatewayClient } from '@cytale/gateway-client';

import { AppErrorBoundary } from '../AppErrorBoundary.js';
import {
  createGatewayTelemetryPoller,
  installClientErrorCapture,
  type ClientErrorSender,
} from '../clientErrors.js';

function collector() {
  const sent: ClientErrorPayload[] = [];
  const sender: ClientErrorSender = {
    reportClientError: async payload => {
      sent.push(payload);
    },
  };
  return { sent, sender };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A gateway whose telemetry the test drives directly (no socket involved). */
function fakeGateway(telemetry: Record<string, number>): GatewayClient {
  // A COPY per call, exactly like the real client's `getTelemetry()`: the
  // poller holds the snapshot it was handed, so aliasing it would hide every
  // delta and make a broken poller look correct.
  return { getTelemetry: () => ({ ...telemetry }) } as unknown as GatewayClient;
}

function reporter(options: Partial<ConstructorParameters<typeof ClientErrorReporter>[0]> = {}) {
  const sink = collector();
  const instance = new ClientErrorReporter({
    client: 'web',
    send: sink.sender.reportClientError,
    version: 'va08ce92',
    ...options,
  });
  return { ...sink, reporter: instance };
}

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe('window.onerror and unhandledrejection', () => {
  it('reports an uncaught exception exactly once', async () => {
    const { sent, sender, reporter: errors } = reporter();
    uninstall = installClientErrorCapture({ api: sender, reporter: errors });

    const error = new TypeError('boom');
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught TypeError: boom',
        filename: 'https://app.test/assets/bundle.js',
        lineno: 12,
        colno: 5,
        error,
      })
    );
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      client: 'web',
      source: 'window.onerror',
      version: 'va08ce92',
    });
    expect(sent[0]!.stack).toContain('TypeError');
  });

  it('does not report the ResizeObserver loop notice (a browser notice, not a bug)', async () => {
    const { sent, sender, reporter: errors } = reporter();
    uninstall = installClientErrorCapture({ api: sender, reporter: errors });

    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.',
      })
    );
    await settle();

    expect(sent).toHaveLength(0);
  });

  it('reports an unhandled rejection exactly once', async () => {
    const { sent, sender, reporter: errors } = reporter();
    uninstall = installClientErrorCapture({ api: sender, reporter: errors });

    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new Error('promise blew up') });
    window.dispatchEvent(event);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: 'unhandledrejection' });
    expect(sent[0]!.message).toBe('promise blew up');
  });

  it('an exception and a rejection of the same text are TWO reports', async () => {
    const { sent, sender, reporter: errors } = reporter();
    uninstall = installClientErrorCapture({ api: sender, reporter: errors });

    window.dispatchEvent(new ErrorEvent('error', { message: 'same text', error: new TypeError('same text') }));
    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new TypeError('same text') });
    window.dispatchEvent(event);
    await settle();

    expect(sent).toHaveLength(2);
    expect(new Set(sent.map(p => p.fingerprint)).size).toBe(2);
  });

  it('the SAME exception twice produces ONE report', async () => {
    const { sent, sender, reporter: errors } = reporter();
    uninstall = installClientErrorCapture({ api: sender, reporter: errors });

    for (let i = 0; i < 5; i += 1) {
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'Uncaught TypeError: boom', error: new TypeError('boom') })
      );
    }
    await settle();

    expect(sent).toHaveLength(1);
    expect(errors.getState().deduped).toBe(4);
  });

  it('never throws when the transport itself fails', async () => {
    const errors = new ClientErrorReporter({
      client: 'web',
      send: async () => {
        throw new Error('ingest down');
      },
    });
    uninstall = installClientErrorCapture({ reporter: errors });

    expect(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'x', error: new Error('x') }));
    }).not.toThrow();
    await settle();
  });

  it('holds a report raised offline and sends it once on `online`', async () => {
    const { sent, sender, reporter: errors } = reporter({ isOffline: () => true });
    uninstall = installClientErrorCapture({ api: sender, reporter: errors });

    window.dispatchEvent(new ErrorEvent('error', { message: 'offline boom', error: new Error('offline boom') }));
    await settle();
    expect(sent).toHaveLength(0);
    expect(errors.getState().queued).toBe(1);

    window.dispatchEvent(new Event('online'));
    await settle();
    expect(sent).toHaveLength(1);
  });
});

describe('the React error boundary', () => {
  it('reports the render failure once and renders a fallback instead of a blank page', async () => {
    const { sent, sender, reporter: errors } = reporter();
    uninstall = installClientErrorCapture({ api: sender, reporter: errors });

    function Exploding(): never {
      throw new Error('render exploded');
    }

    render(
      <AppErrorBoundary reporter={errors}>
        <Exploding />
      </AppErrorBoundary>
    );

    // The fallback is synchronous; the report is fire-and-forget by design
    // (reporting must never block or break the render that failed).
    expect(screen.getByTestId('app-error-fallback')).toBeTruthy();
    expect(screen.getByTestId('app-error-detail').textContent).toBe('render exploded');
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: 'error-boundary' });
  });

  it('renders its children when nothing throws', () => {
    render(
      <AppErrorBoundary>
        <p>fine</p>
      </AppErrorBoundary>
    );
    expect(screen.getByText('fine')).toBeTruthy();
  });
});

describe('the socket story (existing gateway telemetry, no new instrumentation)', () => {
  it('reports a counter that MOVED and stays silent when nothing did', async () => {
    const { sent, reporter: errors } = reporter();
    const telemetry: Record<string, number> = { malformed_frames_total: 0, reconnects_total: 1 };
    const poller = createGatewayTelemetryPoller(() => fakeGateway(telemetry), errors);

    // The first tick is the BASELINE — a snapshot taken after connect is not an
    // incident, so nothing is reported for what already happened.
    poller.poll();
    await settle();
    expect(sent).toHaveLength(0);

    telemetry.malformed_frames_total = (telemetry.malformed_frames_total ?? 0) + 2;
    telemetry.reconnects_total = (telemetry.reconnects_total ?? 0) + 1;
    poller.poll();
    await settle();

    expect(sent).toHaveLength(2);
    expect(sent.map(p => p.detail).sort()).toEqual([
      'malformed_frames_total=+2 (total 2)',
      'reconnects_total=+1 (total 2)',
    ]);
    expect(sent.every(p => p.source === 'gateway.telemetry')).toBe(true);

    // Nothing moved this time: no report, no duplicate.
    poller.poll();
    await settle();
    expect(sent).toHaveLength(2);
  });

  it('reports nothing before a session has a gateway client', async () => {
    const { sent, reporter: errors } = reporter();
    const poller = createGatewayTelemetryPoller(() => null, errors);

    poller.poll();
    await settle();
    expect(sent).toHaveLength(0);
  });
});
