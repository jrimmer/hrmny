/**
 * @cytale/web — the synthesized ring sound (calls plan U11, AM6).
 *
 * MECHANISM (recorded per the unit brief): the ring is SYNTHESIZED with the
 * WebAudio API (dual-sine bursts at 800 Hz + 1000 Hz in a 2s double-burst
 * cadence, ~30s bounded by the toast lifecycle) — deliberately NOT an audio
 * asset: no binary file enters git, and a programmatic AudioContext surfaces
 * autoplay policy as an inspectable state (`suspended`) instead of a silently
 * rejected `<audio>.play()` promise. Browsers gate programmatic WebAudio
 * behind the same user-gesture policy as media elements, so the ring honours
 * the identical contract: an un-gesture'd tab reports `suspended`, we attempt
 * one `resume()`, and a still-suspended context means NO sound — the visual
 * toast/slot surfaces carry the ring alone (WCAG: the visual equivalent of
 * the audio ring is mandatory, never sound-only).
 *
 * Everything browser-shaped sits behind `RingSoundEnv` so tests run a fake
 * AudioContext; `start()` reports exactly why sound did or did not begin.
 */

// ---------------------------------------------------------------------------
// Structural WebAudio types (the used surface of AudioContext)
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

export interface RingSoundEnv {
  /** A fresh context, or null where WebAudio is unavailable (tests, SSR). */
  audioContext(): AudioContextLike | null;
  /** Cadence scheduler; defaults to window.setInterval. */
  scheduleInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export type RingSoundStartResult =
  | { audible: true }
  | { audible: false; reason: 'unavailable' | 'autoplay-blocked' };

export interface RingSoundController {
  /**
   * Begin the ring cadence. Resolves `{ audible: false, reason }` when the
   * context could not start (no WebAudio / autoplay still suspended) — the
   * caller's visual surfaces are already up and carry the ring alone.
   */
  start(): Promise<RingSoundStartResult>;
  /** Stop the cadence and tear the context down (toast expiry/dismiss/join). */
  stop(): void;
}

/** One full cycle every 2s: two bursts, 0.6s apart (phone double-ring). */
export const RING_CADENCE_MS = 2_000;
const BURST_LENGTH_S = 0.4;
const BURST_GAP_S = 0.6;
/** Peak amplitude per partial — deliberately quiet (0.08 ≈ 12% volume). */
const BURST_PEAK = 0.08;
const RING_PARTIALS_HZ = [800, 1_000];

function browserRingSoundEnv(): RingSoundEnv {
  return {
    audioContext(): AudioContextLike | null {
      const Ctor =
        typeof window !== 'undefined' &&
        'AudioContext' in window &&
        typeof window.AudioContext === 'function'
          ? window.AudioContext
          : null;
      if (Ctor === null) return null;
      return new Ctor() as unknown as AudioContextLike;
    },
    scheduleInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

/**
 * Build the ring sound controller. One controller owns at most one live
 * AudioContext; `stop()` tears it down cleanly and a subsequent `start()`
 * opens a fresh one, so a single long-lived controller can serve many ring
 * sessions (toast expiry → later new ring).
 */
export function createRingSound(env: RingSoundEnv = browserRingSoundEnv()): RingSoundController {
  let ctx: AudioContextLike | null = null;
  let cadence: ReturnType<typeof setInterval> | null = null;
  const liveNodes = new Set<OscillatorLike>();

  function burst(at: number): void {
    if (ctx === null) return;
    for (const hz of RING_PARTIALS_HZ) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      // Fast attack, sustain, fast release — a soft bell-ish trill per burst.
      gain.gain
        .setValueAtTime(0.0001, at)
        .linearRampToValueAtTime(BURST_PEAK, at + 0.02)
        .setValueAtTime(BURST_PEAK, at + BURST_LENGTH_S - 0.05)
        .linearRampToValueAtTime(0.0001, at + BURST_LENGTH_S);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + BURST_LENGTH_S + 0.05);
      liveNodes.add(osc);
    }
  }

  function cycle(): void {
    if (ctx === null) return;
    const t = ctx.currentTime;
    burst(t);
    burst(t + BURST_GAP_S);
  }

  async function start(): Promise<RingSoundStartResult> {
    if (cadence !== null) return { audible: true }; // already sounding

    const context = env.audioContext();
    if (context === null) return { audible: false, reason: 'unavailable' };
    ctx = context;

    // Autoplay policy: a suspended context means the tab never received a
    // user gesture (or the OS blocked audio). One resume attempt; a context
    // that stays suspended is the documented visual-only fallback.
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // resume() rejects outright on some engines — treat as blocked.
      }
      if (ctx.state === 'suspended') {
        await closeCtx();
        return { audible: false, reason: 'autoplay-blocked' };
      }
    }

    cycle(); // the first double-burst lands immediately
    cadence = env.scheduleInterval(cycle, RING_CADENCE_MS);
    return { audible: true };
  }

  async function closeCtx(): Promise<void> {
    const context = ctx;
    ctx = null;
    if (context === null) return;
    try {
      await context.close();
    } catch {
      // close() on a partially-initialized context can reject; harmless.
    }
  }

  function stop(): void {
    if (cadence !== null) {
      env.clearInterval(cadence);
      cadence = null;
    }
    for (const osc of liveNodes) {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // already ended — nothing to silence
      }
    }
    liveNodes.clear();
    void closeCtx();
  }

  return { start, stop };
}
