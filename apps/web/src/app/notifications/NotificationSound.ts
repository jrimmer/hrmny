/**
 * @cytale/web — the "ding" for a notification worth hearing.
 *
 * SYNTHESIZED with WebAudio, not an audio asset, for the reason `RingSound`
 * already records: no binary file enters git, and a programmatic AudioContext
 * exposes autoplay policy as an inspectable `suspended` state — where an
 * `<audio>` element's `play()` rejects a promise that callers forget to catch
 * and the sound fails in silence.
 *
 * The two partials are a rising pair (A5 → E6, a bare fifth) with a fast decay,
 * chosen to read as an announcement rather than an alarm: the ring is a
 * sustained double-burst because it is demanding attention, and a message
 * arriving is not. Short enough not to overlap the next one.
 *
 * ## The restraint is the feature
 *
 * A ding on every message is WORSE than no sound. It is the notification
 * fatigue this whole system exists to avoid, in audio form, and it is the
 * failure mode members actually complain about on other platforms. So there
 * are two brakes, and both are deliberate:
 *
 *   * the caller only dings on a verdict the policy called `push` — the same
 *     decision that would have notified a device, so a muted channel or an
 *     ordinary message in a mentions-only channel stays silent;
 *   * `MIN_INTERVAL_MS` collapses a burst into one sound. A conversation
 *     arriving faster than a person can read produces one ding, not twelve.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch the OS notification sound. That belongs to the push
 * payload and the operating system's own settings, and no platform lets a page
 * control it. Conflating the two is how you promise a sound you cannot deliver.
 */

// ---------------------------------------------------------------------------
// Structural WebAudio types (only the surface actually used)
// ---------------------------------------------------------------------------

export interface AudioParamLike {
  setValueAtTime(value: number, startTime: number): AudioParamLike;
  linearRampToValueAtTime(value: number, endTime: number): AudioParamLike;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect(): void;
}

export interface OscillatorLike extends AudioNodeLike {
  type: string;
  frequency: { value: number };
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface AudioContextLike {
  state: 'running' | 'suspended' | 'closed';
  currentTime: number;
  destination: AudioNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

export interface NotificationSoundEnv {
  /** A context, or null where WebAudio is unavailable (tests, SSR). */
  audioContext(): AudioContextLike | null;
  /** Clock, injectable so the interval brake is testable without waiting. */
  now(): number;
}

export type PlayResult =
  | { played: true }
  | { played: false; reason: 'unavailable' | 'autoplay-blocked' | 'too-soon' };

export interface NotificationSoundController {
  play(): Promise<PlayResult>;
  /** Release the context (settings turned sound off, session ended). */
  dispose(): Promise<void>;
}

/** A bare rising fifth — an announcement, not an alarm. */
const PARTIALS_HZ = [880, 1318.5];
const TONE_SECONDS = 0.14;
/** Quiet on purpose: this plays under whatever the member is already hearing. */
const PEAK_GAIN = 0.06;
/** A burst faster than this is one ding, not a machine-gun. */
export const MIN_INTERVAL_MS = 1_500;

function browserNotificationSoundEnv(): NotificationSoundEnv {
  return {
    audioContext() {
      // Sourced structurally rather than as `new AudioContext()`, so an engine
      // without WebAudio degrades to 'unavailable' instead of throwing at
      // module scope.
      const Ctor =
        (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext ??
        (globalThis as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;

      return Ctor ? new Ctor() : null;
    },
    now: () => Date.now(),
  };
}

export function createNotificationSound(
  env: NotificationSoundEnv = browserNotificationSoundEnv(),
): NotificationSoundController {
  let ctx: AudioContextLike | null = null;
  let lastPlayedAt = Number.NEGATIVE_INFINITY;

  async function play(): Promise<PlayResult> {
    // The burst brake, checked BEFORE the context opens: a suppressed ding
    // should cost nothing.
    const now = env.now();
    if (now - lastPlayedAt < MIN_INTERVAL_MS) {
      return { played: false, reason: 'too-soon' };
    }

    if (ctx === null || ctx.state === 'closed') {
      ctx = env.audioContext();
    }
    if (ctx === null) return { played: false, reason: 'unavailable' };

    // Autoplay policy: a tab that has never received a gesture reports
    // suspended. One resume attempt; a context that stays suspended is the
    // documented silent fallback, reported rather than pretended away.
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // resume() rejects outright on some engines — treat as blocked.
      }
      if (ctx.state === 'suspended') {
        return { played: false, reason: 'autoplay-blocked' };
      }
    }

    const at = ctx.currentTime;

    for (const hz of PARTIALS_HZ) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      // Instant attack, exponential-feeling decay. A soft edge on both ends so
      // it reads as a blip rather than a click.
      gain.gain
        .setValueAtTime(0.0001, at)
        .linearRampToValueAtTime(PEAK_GAIN, at + 0.008)
        .linearRampToValueAtTime(0.0001, at + TONE_SECONDS);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + TONE_SECONDS + 0.02);
    }

    lastPlayedAt = now;
    return { played: true };
  }

  async function dispose(): Promise<void> {
    const context = ctx;
    ctx = null;
    if (context === null) return;
    try {
      await context.close();
    } catch {
      // Already closed or the engine refuses; nothing to recover.
    }
  }

  return { play, dispose };
}
