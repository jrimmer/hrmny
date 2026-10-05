/**
 * Diagnostics screen tests (plan 004 M1): the screen renders a row per probe
 * from the real runtime, so a probe that silently stops reporting is caught.
 *
 * The expected rows are literals, deliberately NOT derived from
 * `runtimeCapabilities()` / `protocolProbe()`. Deriving them made the expected
 * and rendered sets move together, so dropping a probe kept this suite green
 * while the diagnostics screen under-reported on device.
 */
import { render, screen } from '@testing-library/react-native';

import { DiagnosticsScreen } from '../DiagnosticsScreen';
import { protocolProbe, runtimeCapabilities } from '../probes';

/** Every row `runtimeCapabilities()` must report, in order. */
const RUNTIME_ROWS = [
  'Hermes engine',
  'WebSocket',
  'fetch',
  'FormData',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'btoa / atob',
  'crypto.randomUUID',
  'DecompressionStream',
  'structuredClone',
  'performance.now',
];

/** Every row `protocolProbe()` must report, in order. */
const PROTOCOL_ROWS = [
  'makeSnowflake / isSnowflake',
  'opcode table',
  'isGatewayEnvelope(dispatch)',
  'rejects unknown op',
  'narrowDispatch',
  'package version',
];

describe('DiagnosticsScreen', () => {
  it('keeps the runtime capability probe set pinned', () => {
    expect(runtimeCapabilities().map((c) => c.name)).toEqual(RUNTIME_ROWS);
  });

  it('keeps the protocol probe set pinned', () => {
    expect(protocolProbe().map((p) => p.name)).toEqual(PROTOCOL_ROWS);
  });

  it('renders every runtime capability row', async () => {
    await render(<DiagnosticsScreen autoProbe={false} />);

    expect(screen.getByText('Runtime capabilities')).toBeTruthy();
    for (const name of RUNTIME_ROWS) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('renders every protocol probe row', async () => {
    await render(<DiagnosticsScreen autoProbe={false} />);

    expect(screen.getByText('Protocol codec (on the engine)')).toBeTruthy();
    for (const name of PROTOCOL_ROWS) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('renders the gateway probe control', async () => {
    await render(<DiagnosticsScreen autoProbe={false} />);
    expect(screen.getByText(/Connect to ws:\/\//)).toBeTruthy();
  });
});
