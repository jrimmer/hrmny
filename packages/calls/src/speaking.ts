/**
 * @cytale/calls — per-remote-stream speaking detection (calls plan U8, AM5).
 *
 * Speaking NEVER rides the gateway (AM5): every client computes remote
 * speaking locally from received audio. This module attaches one WebAudio
 * AnalyserNode per remote MediaStream, polls amplitude on a ~100 ms
 * interval, and maintains a Set<string> of speaking user ids with
 * identity-stable snapshots (safe for useSyncExternalStore).
 *
 * Tab-visibility tolerance: the poll uses setInterval, NOT rAF — rAF stops
 * entirely in hidden tabs while an interval merely throttles (≥1s in most
 * browsers), so indicators lag but never freeze behind a background tab.
 *
 * The AudioContext factory is injectable (SpeakingEnv) — jsdom has no
 * WebAudio, and the real-browser behavior is falsified in U13's two-browser
 * e2e, not here. The real factory is the HOST's (apps/web's
 * `browserSpeakingEnv()`); this package's fallback throws, so a host that
 * forgets to inject degrades to "nobody is speaking" rather than crashing
 * the negotiation. The React binding (`useSpeakingSet`) is the host's too —
 * this package stays React-free.
 */

import { unavailableSpeakingEnv } from './platform.js';

/** The structural slice of AnalyserNode the monitor reads. */
export interface AnalyserNodeLike {
  fftSize: number;
  getByteTimeDomainData(array: Uint8Array): void;
  disconnect(): void;
}

/** The structural slice of MediaStreamAudioSourceNode used. */
export interface AudioSourceNodeLike {
  connect(node: AnalyserNodeLike): void;
  disconnect(): void;
}

/** The structural slice of AudioContext used (lazy-created per monitor). */
export interface AudioContextLike {
  readonly state: string;
  resume(): Promise<void>;
  createMediaStreamSource(stream: unknown): AudioSourceNodeLike;
  createAnalyser(): AnalyserNodeLike;
  close(): Promise<void> | void;
}

export interface SpeakingEnv {
  createContext(): AudioContextLike;
}

/** Default threshold: peak deviation from 128 in the byte time-domain data. */
export const SPEAKING_THRESHOLD_DEFAULT = 12;
/** Default poll interval (plan: throttled ~100 ms updates). */
export const SPEAKING_INTERVAL_MS_DEFAULT = 100;

interface SpeakingEntry {
  source: AudioSourceNodeLike;
  analyser: AnalyserNodeLike;
  buffer: Uint8Array;
}

export interface SpeakingMonitorOptions {
  /** Peak deviation threshold (0–127); larger = less sensitive. */
  threshold?: number;
  /** Poll interval in ms. */
  intervalMs?: number;
  env?: SpeakingEnv;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * One analyser per remote stream, one shared poll. `getSpeaking()` returns
 * an identity-stable ReadonlySet (replaced only when membership changes) —
 * React subscriptions re-render exactly on change.
 */
export class SpeakingMonitor {
  private readonly threshold: number;
  private readonly intervalMs: number;
  private readonly env: SpeakingEnv;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  private ctx: AudioContextLike | null = null;
  /** Streams attached but not yet wired into an analyser chain. */
  private streams = new Map<string, unknown>();
  private entries = new Map<string, SpeakingEntry>();
  private speaking: ReadonlySet<string> = new Set();
  private frozen: ReadonlySet<string> = this.speaking;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(options: SpeakingMonitorOptions = {}) {
    this.threshold = options.threshold ?? SPEAKING_THRESHOLD_DEFAULT;
    this.intervalMs = options.intervalMs ?? SPEAKING_INTERVAL_MS_DEFAULT;
    this.env = options.env ?? unavailableSpeakingEnv();
    // Bind the browser timers to their receiver: an invoked-as-method (or
    // otherwise detached) native `setInterval` throws "Illegal invocation"
    // — in Chromium (found by U2's real-browser e2e) AND WebKit (found
    // live again by the V2 WebKit walkthrough, 2026-09-07) — aborting the
    // call engine's begin() mid-flight. jsdom suites never saw it because
    // they inject their own timer fns.
    this.setIntervalFn = options.setIntervalFn ?? setInterval.bind(globalThis);
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval.bind(globalThis);
  }

  /** The current speaking set (identity-stable between changes). */
  getSpeaking(): ReadonlySet<string> {
    return this.frozen;
  }

  /** Subscribe to speaking-set changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start polling (idempotent). Also lazily resumes a suspended context. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = this.setIntervalFn(() => this.tick(), this.intervalMs);
  }

  /** Stop polling (attachments survive; start() resumes). */
  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /**
   * Attach (or replace) one user's remote stream. The WebAudio chain is
   * wired lazily on the next tick — attaching never constructs an
   * AudioContext, so environments without WebAudio (jsdom, ancient
   * browsers) degrade to silent no-speaking indicators instead of throwing
   * inside the media negotiation.
   */
  attach(userId: string, stream: unknown): void {
    this.detach(userId);
    this.streams.set(userId, stream);
  }

  /** Detach one user's stream/analyser and clear their speaking flag. */
  detach(userId: string): void {
    this.streams.delete(userId);
    const entry = this.entries.get(userId);
    if (!entry) return;
    this.entries.delete(userId);
    entry.source.disconnect();
    entry.analyser.disconnect();
    if (this.speaking.has(userId)) {
      const next = new Set(this.speaking);
      next.delete(userId);
      this.update(next);
    }
  }

  /** Detach everything and stop. */
  detachAll(): void {
    for (const userId of [...this.entries.keys()]) this.detach(userId);
    this.streams.clear(); // pending (attached-but-unwired) streams go too
    this.stop();
  }

  /** One poll: wire pending streams, read every analyser, update the set. */
  tick(): void {
    this.wirePending();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {
        // Autoplay policy may keep the context suspended; indicators for
        // silent streams are correct either way (silence reads as silence).
      });
    }
    let changed = false;
    const next = new Set(this.speaking);
    for (const [userId, entry] of this.entries) {
      entry.analyser.getByteTimeDomainData(entry.buffer);
      let peak = 0;
      for (let i = 0; i < entry.buffer.length; i++) {
        const deviation = Math.abs(entry.buffer[i]! - 128);
        if (deviation > peak) peak = deviation;
      }
      const speaking = peak >= this.threshold;
      if (speaking !== next.has(userId)) {
        changed = true;
        if (speaking) next.add(userId);
        else next.delete(userId);
      }
    }
    if (changed) this.update(next);
  }

  dispose(): void {
    this.detachAll();
    if (this.ctx) {
      void Promise.resolve(this.ctx.close()).catch(() => undefined);
      this.ctx = null;
    }
    this.listeners.clear();
  }

  /**
   * Wire attached streams into analyser chains, creating the AudioContext
   * on first need. A creation failure (no WebAudio) is permanent and
   * silent: the monitor reports no speakers ever — a degraded-but-honest
   * mode for environments like jsdom.
   */
  private wirePending(): void {
    if (this.streams.size === 0) return;
    if (this.ctx === null) {
      try {
        this.ctx = this.env.createContext();
      } catch {
        this.streams.clear(); // nothing to analyze without WebAudio
        return;
      }
    }
    for (const [userId, stream] of [...this.streams]) {
      try {
        const source = this.ctx.createMediaStreamSource(stream);
        const analyser = this.ctx.createAnalyser();
        source.connect(analyser);
        this.entries.set(userId, {
          source,
          analyser,
          buffer: new Uint8Array(analyser.fftSize),
        });
        this.streams.delete(userId);
      } catch {
        // A bad stream is skipped, never fatal to the monitor.
        this.streams.delete(userId);
      }
    }
  }

  private update(next: Set<string>): void {
    this.speaking = next;
    this.frozen = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a broken subscriber never breaks the monitor
      }
    }
  }
}
