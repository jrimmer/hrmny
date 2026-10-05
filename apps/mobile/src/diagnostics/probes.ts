/**
 * RN portability spike — the empirical answer to "do the shared TS packages
 * run on Hermes?" Three probes:
 *
 *   1. runtime  — which web-standard globals the packages touch are missing?
 *   2. protocol — does the wire codec behave on Hermes (guards + narrowing)?
 *   3. gateway  — does the client state machine run over RN's WebSocket?
 *
 * Disposable by design: this module seeds the mobile app's diagnostics screen,
 * it is not a product surface. Findings feed plan-004's shim work.
 */
import { GatewayClient, type ConnectionState } from '@cytale/gateway-client';
import {
  GATEWAY_OP_NAMES,
  GATEWAY_VERSION,
  PROTOCOL_PACKAGE_VERSION,
  isGatewayEnvelope,
  isKnownOp,
  isSnowflake,
  makeSnowflake,
  narrowDispatch,
} from '@cytale/protocol';

// ---------------------------------------------------------------------------
// 1. Runtime capabilities
// ---------------------------------------------------------------------------

export interface Capability {
  name: string;
  present: boolean;
  note?: string;
}

const g = globalThis as Record<string, unknown>;

function has(name: string): boolean {
  try {
    return typeof g[name] !== 'undefined';
  } catch {
    return false;
  }
}

export function runtimeCapabilities(): Capability[] {
  const cryptoObj = g.crypto as { randomUUID?: () => string } | undefined;
  const perf = g.performance as { now?: unknown } | undefined;
  return [
    { name: 'Hermes engine', present: typeof g.HermesInternal !== 'undefined' },
    { name: 'WebSocket', present: has('WebSocket') },
    { name: 'fetch', present: has('fetch') },
    { name: 'FormData', present: has('FormData') },
    { name: 'URLSearchParams', present: has('URLSearchParams') },
    { name: 'TextEncoder', present: has('TextEncoder') },
    { name: 'TextDecoder', present: has('TextDecoder') },
    { name: 'btoa / atob', present: has('btoa') && has('atob') },
    { name: 'crypto.randomUUID', present: typeof cryptoObj?.randomUUID === 'function' },
    {
      name: 'DecompressionStream',
      present: has('DecompressionStream'),
      note: 'zstd/zlib stream decode',
    },
    { name: 'structuredClone', present: has('structuredClone') },
    { name: 'performance.now', present: typeof perf?.now === 'function' },
  ];
}

// ---------------------------------------------------------------------------
// 2. Protocol codec
// ---------------------------------------------------------------------------

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function protocolProbe(): ProbeResult[] {
  const results: ProbeResult[] = [];
  const push = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  const sf = makeSnowflake('1756920000000000000');
  push('makeSnowflake / isSnowflake', isSnowflake(sf) && !isSnowflake('nope'), `sample ${sf}`);

  push(
    'opcode table',
    isKnownOp(0) && !isKnownOp(9999),
    `${Object.keys(GATEWAY_OP_NAMES).length} ops, gateway v${GATEWAY_VERSION}`,
  );

  const dispatch = {
    op: 0,
    t: 'MessageCreate',
    s: 42,
    d: { id: '1', channel_id: '2', content: 'hello from Hermes' },
  };
  push('isGatewayEnvelope(dispatch)', isGatewayEnvelope(dispatch), 'synthetic op-0 frame');
  push('rejects unknown op', !isGatewayEnvelope({ op: 4242, d: {} }), 'guard holds');

  const narrowed = narrowDispatch(dispatch, 'MessageCreate');
  push(
    'narrowDispatch',
    narrowed !== null && narrowed.s === 42,
    `seq ${narrowed?.s ?? 'null'}, t ${narrowed?.t ?? 'null'}`,
  );

  push('package version', PROTOCOL_PACKAGE_VERSION === '0.1.0', PROTOCOL_PACKAGE_VERSION);
  return results;
}

// ---------------------------------------------------------------------------
// 3. Gateway client over RN's WebSocket
// ---------------------------------------------------------------------------

export interface GatewayProbeReport {
  states: ConnectionState[];
  codec: string | null;
  close: { code: number; reason: string } | null;
  error: string | null;
  telemetry: Record<string, number> | null;
}

/**
 * Connect, watch the state machine, then tear down. A close with an auth
 * code is a PASS: it proves the socket, envelope decode, and reconnect loop
 * all ran — the credential is simply a spike placeholder.
 */
export function gatewayProbe(
  url: string,
  token: string,
  timeoutMs = 8000,
): Promise<GatewayProbeReport> {
  return new Promise((resolve) => {
    const report: GatewayProbeReport = {
      states: [],
      codec: null,
      close: null,
      error: null,
      telemetry: null,
    };
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        report.codec = client.compressionCodec;
        report.telemetry = client.getTelemetry() as unknown as Record<string, number>;
      } catch {
        // Probe teardown must never throw into the UI.
      }
      client.destroy();
      resolve(report);
    };

    const client = new GatewayClient({
      url,
      tokenProvider: () => token,
      onStateChange: (change) => report.states.push(change.to),
      onClosed: (info) => {
        report.close = { code: info.code, reason: info.reason };
      },
      onSocketError: (err) => {
        report.error = err.message ?? 'socket error';
      },
    });

    setTimeout(finish, timeoutMs);
    client.connect().catch((err: unknown) => {
      report.error = err instanceof Error ? err.message : String(err);
      finish();
    });
  });
}
