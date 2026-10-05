/**
 * Diagnostics screen (plan 004 M1) — the app's runtime capability report.
 *
 * Kept as a real surface rather than a throwaway: when a dependency or SDK
 * changes, this answers "does this runtime still have X?" in one launch, and
 * it is where a shim's presence or absence becomes visible.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  gatewayProbe,
  protocolProbe,
  runtimeCapabilities,
  type Capability,
  type GatewayProbeReport,
  type ProbeResult,
} from './probes';
import { getInstalledShims } from '../shims';

/** Local dev gateway (apps/server, `scripts/dev-4000.sh`). */
const GATEWAY_URL = 'ws://localhost:4000/gateway/websocket';

function Row({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.mark, ok ? styles.pass : styles.fail]}>{ok ? 'PASS' : 'MISS'}</Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function DiagnosticsScreen({ autoProbe = __DEV__ }: { autoProbe?: boolean } = {}) {
  const [caps, setCaps] = useState<Capability[]>([]);
  const [protocol, setProtocol] = useState<ProbeResult[]>([]);
  const [shims, setShims] = useState<string[]>([]);
  const [gateway, setGateway] = useState<GatewayProbeReport | null>(null);
  const [probing, setProbing] = useState(false);

  const runGateway = useCallback(async () => {
    setProbing(true);
    setGateway(null);
    try {
      const report = await gatewayProbe(GATEWAY_URL, 'spike-placeholder-token');
      if (__DEV__) console.log('[diagnostics] gateway probe', JSON.stringify(report));
      setGateway(report);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    setCaps(runtimeCapabilities());
    setProtocol(protocolProbe());
    setShims(getInstalledShims());
    // A diagnostics screen that needs a tap to diagnose is a worse screen: in
    // dev, exercise the gateway client (socket + state machine + codec
    // negotiation) on launch. The placeholder token makes a close frame the
    // expected signal, not a failure. Tests opt out via `autoProbe`.
    if (autoProbe) void runGateway();
  }, [autoProbe, runGateway]);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Hrmny mobile diagnostics</Text>
        <Text style={styles.subtitle}>
          Shared-package runtime report: capabilities, wire codec, gateway client.
        </Text>

        <Section title="Runtime capabilities">
          {caps.map((c) => (
            <Row key={c.name} label={c.name} ok={c.present} detail={c.note} />
          ))}
        </Section>

        <Section title="Shims this runtime needed">
          {shims.length === 0 ? (
            <Row label="none — the runtime supplies everything" ok detail="native globals complete" />
          ) : (
            shims.map((name) => <Row key={name} label={name} ok detail="provided by src/shims" />)
          )}
        </Section>

        <Section title="Protocol codec (on the engine)">
          {protocol.map((p) => (
            <Row key={p.name} label={p.name} ok={p.ok} detail={p.detail} />
          ))}
        </Section>

        <Section title="Gateway client (RN WebSocket)">
          <Pressable
            onPress={runGateway}
            disabled={probing}
            accessibilityRole="button"
            accessibilityLabel="Probe the gateway"
            accessibilityState={{ disabled: probing, busy: probing }}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonLabel}>
              {probing ? 'Probing…' : `Connect to ${GATEWAY_URL}`}
            </Text>
          </Pressable>
          {gateway ? (
            <View style={styles.report}>
              <Row
                label="state machine"
                ok={gateway.states.length > 0}
                detail={gateway.states.join(' → ') || 'no transitions observed'}
              />
              <Row
                label="negotiated codec"
                ok={gateway.codec !== null}
                detail={gateway.codec ?? '—'}
              />
              <Row
                label="socket close"
                ok={gateway.close !== null}
                detail={
                  gateway.close
                    ? `code ${gateway.close.code}${gateway.close.reason ? ` — ${gateway.close.reason}` : ''}`
                    : 'still open'
                }
              />
              {gateway.error ? <Row label="socket error" ok={false} detail={gateway.error} /> : null}
            </View>
          ) : null}
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#1a1a1e' },
  content: { padding: 20, paddingTop: 72, paddingBottom: 48, gap: 4 },
  title: { color: '#f4f4f5', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#a1a1aa', fontSize: 13, marginTop: 6, marginBottom: 8, lineHeight: 18 },
  section: { marginTop: 20 },
  sectionTitle: {
    color: '#8b8b94',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 5 },
  mark: { fontSize: 11, fontWeight: '700', width: 40, paddingTop: 2 },
  pass: { color: '#4ade80' },
  fail: { color: '#f87171' },
  rowBody: { flex: 1 },
  rowLabel: { color: '#e4e4e7', fontSize: 14 },
  rowDetail: { color: '#8b8b94', fontSize: 12, marginTop: 1 },
  button: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.75 },
  buttonLabel: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  report: { marginTop: 12 },
});
