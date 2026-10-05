/**
 * Dev-only call spike (media spike, step 2).
 *
 * NOT a product surface. It exists to answer one question with evidence: does
 * the extracted engine, running on Hermes through the react-native-webrtc
 * adapter, complete a negotiation against our ex_webrtc SFU?
 *
 * It renders the engine's own snapshot plus every state transition, so the
 * answer is readable on the device AND from `adb logcat` (the trace is also
 * echoed to the console for headless capture). The route gate mirrors
 * `diagnostics.tsx`: `cytale://call-spike` deep-links past the drawer, so the
 * ROUTE redirects outside development rather than trusting the drawer link.
 *
 * Deliberately absent (spike scope): ringing, participants UI, video tiles,
 * device pickers, audio routing. The last one is CallKit's job, not an env
 * method (docs/architecture/platform-clients.md).
 */
import { Redirect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { VoiceStatus } from '@cytale/calls';

import { getCallEngine } from '../../src/calls/wiring';
import { useSession } from '../../src/navigation/session';
import { useShell } from '../../src/navigation/ShellContext';
import { SurfaceScaffold } from '../../src/navigation/SurfaceScaffold';
import { theme } from '../../src/theme';

/** One observed transition, newest first. */
interface TraceEntry {
  key: number;
  at: string;
  text: string;
}

export default function CallSpikeRoute() {
  const { openDrawer } = useShell();
  const manager = useSession();

  const [channelId, setChannelId] = useState('');
  const [voice, setVoice] = useState<VoiceStatus>('idle');
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const nextKey = useRef(0);

  const append = useCallback((text: string) => {
    const entry = { key: nextKey.current++, at: new Date().toISOString().slice(11, 23), text };
    // Echoed so a headless run can read the SAME trace from logcat without a
    // screenshot (the emulator screenshot path is unreliable under load).
    console.log(`[call-spike] ${entry.at} ${text}`);
    setTrace((prev) => [entry, ...prev].slice(0, 80));
  }, []);

  // One voice leg per client: the engine is a module singleton, so a route
  // remount must not tear down a live call.
  const engineRef = useRef<ReturnType<typeof getCallEngine> | null>(null);
  const ensureEngine = useCallback(() => {
    engineRef.current ??= getCallEngine(manager);
    return engineRef.current;
  }, [manager]);

  useEffect(() => {
    const engine = ensureEngine();
    append(`engine ready; voice=${engine.getSnapshot().voice.status}`);
    return engine.subscribe(() => {
      const snapshot = engine.getSnapshot();
      setVoice(snapshot.voice.status);
      append(
        `voice=${snapshot.voice.status} pcConnected=${String(snapshot.voice.pcConnected)} ` +
          `micGranted=${String(snapshot.voice.micGranted)} muted=${String(snapshot.muted)} ` +
          `listenOnly=${String(snapshot.listenOnly)} channel=${snapshot.channelId ?? '-'}`,
      );
    });
  }, [append, ensureEngine]);

  const onJoin = useCallback(() => {
    const id = channelId.trim();
    if (id === '') {
      append('join refused: no channel id');
      return;
    }
    append(`join(${id})`);
    ensureEngine().join(id);
  }, [append, channelId, ensureEngine]);

  const onLeave = useCallback(() => {
    append('leave()');
    ensureEngine().leave();
  }, [append, ensureEngine]);

  // Dev-only route: a release build must never mount a screen that opens a call.
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SurfaceScaffold testID="surface-call-spike" title="Call spike" onOpenDrawer={openDrawer}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Channel id (voice-capable)</Text>
        <TextInput
          testID="call-spike-channel"
          style={styles.input}
          value={channelId}
          onChangeText={setChannelId}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="700000000000000001"
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel="Channel id"
        />

        <View style={styles.row}>
          <Pressable
            testID="call-spike-join"
            accessibilityRole="button"
            accessibilityLabel="Join call"
            onPress={onJoin}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Join</Text>
          </Pressable>
          <Pressable
            testID="call-spike-leave"
            accessibilityRole="button"
            accessibilityLabel="Leave call"
            onPress={onLeave}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Leave</Text>
          </Pressable>
        </View>

        {/* The machine-readable fact this spike exists to produce. */}
        <Text testID="call-spike-voice" style={styles.readout}>
          {`voice=${voice}`}
        </Text>
        {trace.map((entry) => (
          <Text key={entry.key} style={styles.trace}>
            {`${entry.at} ${entry.text}`}
          </Text>
        ))}
      </ScrollView>
    </SurfaceScaffold>
  );
}

const styles = StyleSheet.create({
  body: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  label: { color: theme.colors.textMuted, fontSize: 12, textTransform: 'uppercase' },
  input: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    color: theme.colors.text,
    fontSize: 15,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  row: { flexDirection: 'row', gap: theme.spacing.sm, marginVertical: theme.spacing.sm },
  button: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radii.sm,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 96,
    paddingHorizontal: theme.spacing.lg,
  },
  buttonText: { color: theme.colors.text, fontSize: 15, textAlign: 'center' },
  readout: { color: theme.colors.text, fontSize: 16, marginTop: theme.spacing.md },
  trace: { color: theme.colors.textMuted, fontSize: 12 },
});
