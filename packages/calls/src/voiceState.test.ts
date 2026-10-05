/**
 * @cytale/web — voiceState machine unit tests (calls plan U8).
 *
 * Every transition of the AM14 composite machine, including error paths
 * and no-op guards (late events after teardown must not resurrect legs).
 * The machine is pure — these tests exercise transition() exclusively.
 */
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STATUSES,
  initialVoiceState,
  isTerminal,
  transition,
  type VoiceState,
} from './voiceState.js';

/** Dispatch helper: fold inputs from the initial state. */
function run(...inputs: Parameters<typeof transition>[1][]): VoiceState {
  let s = initialVoiceState();
  for (const input of inputs) s = transition(s, input).state;
  return s;
}

describe('voiceState — happy paths', () => {
  it('idle + join-intent → connecting-signaling (flags reset, no notice)', () => {
    const next = run({ type: 'join-intent' });
    expect(next.status).toBe('connecting-signaling');
    expect(next.pcConnected).toBe(false);
    expect(next.micGranted).toBe(false);
    expect(next.micDenied).toBe(false);
    expect(next.notice).toBeNull();
  });

  it('session-confirmed → connecting-media', () => {
    const next = run({ type: 'join-intent' }, { type: 'session-confirmed' });
    expect(next.status).toBe('connecting-media');
  });

  it('pc-connected then mic-granted (either order) → connected only when both hold', () => {
    // Order A: pc first.
    const a = run(
      { type: 'join-intent' },
      { type: 'session-confirmed' },
      { type: 'pc-connected' },
    );
    expect(a.status).toBe('connecting-media'); // mic still pending
    expect(transition(a, { type: 'mic-granted' }).state.status).toBe('connected');

    // Order B: mic first.
    const b = run(
      { type: 'join-intent' },
      { type: 'session-confirmed' },
      { type: 'mic-granted' },
    );
    expect(b.status).toBe('connecting-media'); // pc still pending
    expect(transition(b, { type: 'pc-connected' }).state.status).toBe('connected');
  });

  it('mic landing during connecting-signaling does not promote before session-confirmed', () => {
    const s = run({ type: 'join-intent' }, { type: 'mic-granted' }, { type: 'pc-connected' });
    expect(s.status).toBe('connecting-signaling'); // offer raced the roster event
    // Confirmation with everything ready skips the intermediate state.
    expect(transition(s, { type: 'session-confirmed' }).state.status).toBe('connected');
  });

  it('leave-intent from any active state → clean idle', () => {
    for (const status of [...ACTIVE_STATUSES, 'reconnecting'] as const) {
      const s: VoiceState = { ...initialVoiceState(), status, pcConnected: true, micGranted: true };
      expect(transition(s, { type: 'leave-intent' }).state.status).toBe('idle');
    }
  });
});

describe('voiceState — gateway lifecycle (AM4)', () => {
  const connected: VoiceState = {
    ...initialVoiceState(),
    status: 'connected',
    pcConnected: true,
    micGranted: true,
  };

  it('gateway-resume from connected/connecting → reconnecting (flags kept)', () => {
    const next = transition(connected, { type: 'gateway-resume' }).state;
    expect(next.status).toBe('reconnecting');
    expect(next.pcConnected).toBe(true);
    expect(next.micGranted).toBe(true);
    expect(transition(next, { type: 'gateway-resume' }).state).toBe(next); // idempotent
  });

  it('backfill-ok → connected (resume confirmed the leg)', () => {
    const rc = transition(connected, { type: 'gateway-resume' }).state;
    expect(transition(rc, { type: 'backfill-ok' }).state.status).toBe('connected');
  });

  it('backfill-self-absent → idle + rejoin effect (from reconnecting AND defensively from connected)', () => {
    const rc = transition(connected, { type: 'gateway-resume' }).state;
    const out = transition(rc, { type: 'backfill-self-absent' });
    expect(out.state.status).toBe('idle');
    expect(out.effects).toEqual([{ type: 'rejoin' }]);

    const fromConnected = transition(connected, { type: 'backfill-self-absent' });
    expect(fromConnected.state.status).toBe('idle');
    expect(fromConnected.effects).toEqual([{ type: 'rejoin' }]);
  });

  it('gateway-invalid → offline with notice (media teardown mirrored by controller)', () => {
    const out = transition(connected, { type: 'gateway-invalid' });
    expect(out.state.status).toBe('offline');
    expect(out.state.notice).toBe('offline');
    // Also from reconnecting (a resume that degraded to fresh identify).
    const rc = transition(connected, { type: 'gateway-resume' }).state;
    expect(transition(rc, { type: 'gateway-invalid' }).state.status).toBe('offline');
    // Terminal states and idle ignore it.
    expect(transition(initialVoiceState(), { type: 'gateway-invalid' }).state.status).toBe('idle');
    expect(
      transition({ ...initialVoiceState(), status: 'offline', notice: 'offline' }, { type: 'gateway-invalid' }).state
        .status,
    ).toBe('offline');
  });
});

describe('voiceState — media failures', () => {
  const connected: VoiceState = {
    ...initialVoiceState(),
    status: 'connected',
    pcConnected: true,
    micGranted: true,
  };

  it('ice-failed recoverable → reconnecting (one restart policy, server re-offers)', () => {
    expect(transition(connected, { type: 'ice-failed', recoverable: true }).state.status).toBe(
      'reconnecting',
    );
    // A second recoverable failure while already reconnecting stays put.
    const rc = transition(connected, { type: 'ice-failed', recoverable: true }).state;
    expect(transition(rc, { type: 'ice-failed', recoverable: true }).state).toBe(rc);
  });

  it('ice-failed exhausted → voice-unavailable', () => {
    const out = transition(connected, { type: 'ice-failed', recoverable: false });
    expect(out.state.status).toBe('voice-unavailable');
    expect(out.state.notice).toBeNull();
    expect(out.effects).toEqual([]);
    // Also directly from connecting-media (never connected) and reconnecting.
    const cm: VoiceState = { ...initialVoiceState(), status: 'connecting-media' };
    expect(transition(cm, { type: 'ice-failed', recoverable: false }).state.status).toBe(
      'voice-unavailable',
    );
    const rc = transition(connected, { type: 'gateway-resume' }).state;
    expect(transition(rc, { type: 'ice-failed', recoverable: false }).state.status).toBe(
      'voice-unavailable',
    );
  });

  it('the restart offer applied during reconnecting exits via pc-connected', () => {
    const rc = transition(connected, { type: 'gateway-resume' }).state;
    expect(transition(rc, { type: 'pc-connected' }).state.status).toBe('connected');
  });

  it('reconnect-timeout from Reconnecting → voice-unavailable (bounded wait — never an endless park)', () => {
    // Via ice-failed (recoverable)…
    const viaIce = transition(connected, { type: 'ice-failed', recoverable: true }).state;
    // …and via gateway-resume — both Reconnecting entries the controller arms.
    const viaResume = transition(connected, { type: 'gateway-resume' }).state;
    for (const rc of [viaIce, viaResume]) {
      const out = transition(rc, { type: 'reconnect-timeout' });
      expect(out.state.status).toBe('voice-unavailable');
      expect(out.state.notice).toBeNull(); // the Retry surface explains itself
      expect(out.state.pcConnected).toBe(false); // full reset, ICE-exhaustion shape
      expect(out.effects).toEqual([]);
    }
    // The terminal result recovers through the ordinary paths.
    const dead = transition(viaIce, { type: 'reconnect-timeout' }).state;
    expect(transition(dead, { type: 'dismiss' }).state.status).toBe('idle');
    expect(transition(dead, { type: 'join-intent' }).state.status).toBe('connecting-signaling');
  });

  it('reconnect-timeout is a no-op outside Reconnecting (a late timer never kills a live leg)', () => {
    expect(transition(connected, { type: 'reconnect-timeout' }).state).toBe(connected);
    const cm: VoiceState = { ...initialVoiceState(), status: 'connecting-media' };
    expect(transition(cm, { type: 'reconnect-timeout' }).state).toBe(cm);
    const idle = initialVoiceState();
    expect(transition(idle, { type: 'reconnect-timeout' }).state).toBe(idle);
    for (const status of ['permission-denied', 'voice-unavailable', 'offline'] as const) {
      const s: VoiceState = { ...initialVoiceState(), status };
      expect(transition(s, { type: 'reconnect-timeout' }).state).toBe(s);
    }
  });

  it('mic-denied during join DEGRADES to listen-only (VM5) — never a teardown', () => {
    // During connecting-signaling: the flag lands, the status waits.
    const fromSignaling = run({ type: 'join-intent' }, { type: 'mic-denied' });
    expect(fromSignaling.status).toBe('connecting-signaling');
    expect(fromSignaling.micDenied).toBe(true);
    expect(fromSignaling.notice).toBeNull();

    // During connecting-media with the PC up: LISTEN-ONLY CONNECTED.
    const fromMedia = run(
      { type: 'join-intent' },
      { type: 'session-confirmed' },
      { type: 'pc-connected' },
      { type: 'mic-denied' },
    );
    expect(fromMedia.status).toBe('connected');
    expect(fromMedia.micDenied).toBe(true);
    expect(fromMedia.micGranted).toBe(false);

    // PC landing after the denial promotes the same way.
    const denialFirst = run(
      { type: 'join-intent' },
      { type: 'session-confirmed' },
      { type: 'mic-denied' },
      { type: 'pc-connected' },
    );
    expect(denialFirst.status).toBe('connected');
    expect(denialFirst.micDenied).toBe(true);

    // session-confirmed with everything known skips the intermediate state.
    const skip = run(
      { type: 'join-intent' },
      { type: 'pc-connected' },
      { type: 'mic-denied' },
      { type: 'session-confirmed' },
    );
    expect(skip.status).toBe('connected');

    // The leg is NOT terminal: leave-intent still resolves cleanly.
    expect(transition(fromMedia, { type: 'leave-intent' }).state.status).toBe('idle');
  });

  it('a later mic-grant upgrades a listen-only leg IN PLACE (VM5)', () => {
    const listenOnly = run(
      { type: 'join-intent' },
      { type: 'session-confirmed' },
      { type: 'pc-connected' },
      { type: 'mic-denied' },
    );
    const upgraded = transition(listenOnly, { type: 'mic-granted' }).state;
    expect(upgraded.status).toBe('connected'); // never left the call
    expect(upgraded.micGranted).toBe(true);
    expect(upgraded.micDenied).toBe(false);

    // Denial during reconnecting sets the flag without a status change.
    const rc = transition(connected, { type: 'gateway-resume' }).state;
    const deniedRc = transition(rc, { type: 'mic-denied' }).state;
    expect(deniedRc.status).toBe('reconnecting');
    expect(deniedRc.micDenied).toBe(true);
  });

  it('share-ended (VM8): a mid-call notice the connected leg KEEPS until dismissed', () => {
    const out = transition(connected, { type: 'share-ended' });
    expect(out.state.status).toBe('connected'); // the leg is unaffected
    expect(out.state.notice).toBe('share-ended');
    // Idempotent while showing.
    expect(transition(out.state, { type: 'share-ended' }).state).toBe(out.state);
    // Dismiss clears the notice WITHOUT leaving the call.
    const cleared = transition(out.state, { type: 'dismiss' }).state;
    expect(cleared.status).toBe('connected');
    expect(cleared.notice).toBeNull();
    // From idle/terminal the input is a no-op (no phantom notices).
    const idle = initialVoiceState();
    expect(transition(idle, { type: 'share-ended' }).state).toBe(idle);
  });

  it('source-revoked (KTD6): mid-call notice per source, share-ended\'s exact shape', () => {
    const cam = transition(connected, { type: 'source-revoked', source: 'camera' });
    expect(cam.state.status).toBe('connected'); // the leg keeps running
    expect(cam.state.notice).toBe('camera-stopped');
    const share = transition(connected, { type: 'source-revoked', source: 'screen' });
    expect(share.state.notice).toBe('share-stopped');
    expect(share.state.status).toBe('connected');
    // Idempotent while showing; a different revoke replaces the banner.
    expect(transition(cam.state, { type: 'source-revoked', source: 'camera' }).state).toBe(cam.state);
    expect(transition(cam.state, { type: 'source-revoked', source: 'screen' }).state.notice).toBe(
      'share-stopped',
    );
    // Dismiss clears WITHOUT leaving; from idle/terminal it is a no-op.
    const cleared = transition(cam.state, { type: 'dismiss' }).state;
    expect(cleared.status).toBe('connected');
    expect(cleared.notice).toBeNull();
    const idle = initialVoiceState();
    expect(transition(idle, { type: 'source-revoked', source: 'camera' }).state).toBe(idle);
    // Also honored while Reconnecting (the revocation raced a reconnect).
    const rc = transition(connected, { type: 'gateway-resume' }).state;
    expect(transition(rc, { type: 'source-revoked', source: 'screen' }).state.notice).toBe(
      'share-stopped',
    );
  });
});

describe('voiceState — evictions (AM3/AM8/R10)', () => {
  const connected: VoiceState = {
    ...initialVoiceState(),
    status: 'connected',
    pcConnected: true,
    micGranted: true,
  };

  it('forced-leave → permission-denied (from connected AND connecting-signaling)', () => {
    expect(transition(connected, { type: 'forced-leave' }).state.notice).toBe('forced-leave');
    const joining = run({ type: 'join-intent' });
    const out = transition(joining, { type: 'forced-leave' });
    expect(out.state.status).toBe('permission-denied');
    expect(out.state.notice).toBe('forced-leave');
  });

  it('displaced → idle carrying the displaced notice ("joined elsewhere")', () => {
    const out = transition(connected, { type: 'displaced' });
    expect(out.state.status).toBe('idle');
    expect(out.state.notice).toBe('displaced');
    // Idle-with-notice still accepts a fresh join (notice cleared).
    const rejoin = transition(out.state, { type: 'join-intent' }).state;
    expect(rejoin.status).toBe('connecting-signaling');
    expect(rejoin.notice).toBeNull();
  });
});

describe('voiceState — guards and no-op paths', () => {
  it('join-intent is ignored while any leg is active (the controller serializes)', () => {
    const s = run({ type: 'join-intent' }, { type: 'session-confirmed' });
    expect(transition(s, { type: 'join-intent' }).state).toBe(s);
  });

  it('late media events after teardown never resurrect a leg', () => {
    const dead = run({ type: 'join-intent' }, { type: 'leave-intent' });
    expect(dead.status).toBe('idle');
    for (const input of [
      { type: 'pc-connected' },
      { type: 'mic-granted' },
      { type: 'session-confirmed' },
    ] as const) {
      expect(transition(dead, input).state.status).toBe('idle');
    }
  });

  it('terminal states recover only via dismiss (or a fresh join)', () => {
    for (const status of ['permission-denied', 'voice-unavailable', 'offline'] as const) {
      const s: VoiceState = { ...initialVoiceState(), status };
      // Extra events are no-ops.
      expect(transition(s, { type: 'backfill-ok' }).state).toBe(s);
      expect(transition(s, { type: 'ice-failed', recoverable: true }).state).toBe(s);
      // Dismiss clears; a fresh join restarts.
      expect(transition(s, { type: 'dismiss' }).state.status).toBe('idle');
      expect(transition(s, { type: 'join-intent' }).state.status).toBe('connecting-signaling');
    }
  });

  it('dismiss clears a displaced notice sitting in idle', () => {
    const s = run({ type: 'join-intent' }, { type: 'session-confirmed' }, { type: 'displaced' });
    expect(s.notice).toBe('displaced');
    const cleared = transition(s, { type: 'dismiss' }).state;
    expect(cleared.status).toBe('idle');
    expect(cleared.notice).toBeNull();
  });

  it('session-confirmed/pc-connected are no-ops from idle and terminal states', () => {
    const idle = initialVoiceState();
    expect(transition(idle, { type: 'session-confirmed' }).state).toBe(idle);
    expect(transition(idle, { type: 'pc-connected' }).state).toBe(idle);
  });
});

describe('voiceState — helpers', () => {
  it('isTerminal covers exactly the three recovery-terminal statuses', () => {
    expect(isTerminal('permission-denied')).toBe(true);
    expect(isTerminal('voice-unavailable')).toBe(true);
    expect(isTerminal('offline')).toBe(true);
    expect(isTerminal('idle')).toBe(false);
    expect(isTerminal('connected')).toBe(false);
  });

  it('ACTIVE_STATUSES covers the three leg-holding statuses', () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual([
      'connected',
      'connecting-media',
      'connecting-signaling',
    ]);
  });
});
