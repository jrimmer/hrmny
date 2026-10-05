/**
 * U13 — raw native-dialect resume prober (the soak bot's deliberate-underrun
 * pattern, on the NATIVE wire).
 *
 * Why raw: the production GatewayClient always Resumes with its true
 * high-water seq, so it can never force a buffered-tail REPLAY — and U13's
 * busy-call scenario must prove the resume buffer replays gap-free. This
 * prober speaks the minimal native envelope set by hand (Identify/Resume/
 * Heartbeat + the dispatch envelope), exactly the boundary already
 * documented for the Elixir sidecar: the VirtualVoiceClient (production
 * @cytale/gateway-client) stays the codec-authoritative path; this leg only
 * exists to underrun the acked seq, which no production client may do.
 */

type WireFrame = { op: number; t?: string; s?: number; d?: Record<string, unknown> };

/** The minimal WebSocket surface the prober needs (tests inject fakes). */
export interface ProberSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  removeEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

export interface RawProberEvent {
  seq: number;
  t: string;
  at: number;
}

export interface RawResumeResult {
  resumed: boolean;
  /** Refused (op 9 / no Resumed) — the replay-refusal oracle. */
  refused: boolean;
  replayed: RawProberEvent[];
  contiguous: boolean;
  firstBadIndex: number;
}

export class RawResumeProber {
  private ws: ProberSocketLike | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ingest = (ev: { data: unknown }): void => {
    let f: WireFrame;
    try {
      f = JSON.parse(String(ev.data)) as WireFrame;
    } catch {
      return;
    }
    if (f.op === 0 && typeof f.s === 'number' && f.s > 0) {
      this.lastSeq = f.s;
      this.events.push({ seq: f.s, t: String(f.t), at: Date.now() });
    }
  };

  sessionId = '';
  resumeToken = '';
  lastSeq = 0;
  readonly events: RawProberEvent[] = [];

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly socketFactory: (url: string) => ProberSocketLike = (u) =>
      new WebSocket(u) as unknown as ProberSocketLike,
  ) {}

  /** Connect + Identify; resolves at READY (session secrets captured). */
  async connect(timeoutMs = 15_000): Promise<void> {
    const ws = this.socketFactory(this.url);
    this.ws = ws;
    ws.addEventListener('message', this.ingest);

    const hello = await this.nextFrame((f) => f.op === 10, timeoutMs);
    const interval = heartbeatInterval(hello);

    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          v: 1,
          compress: null,
          properties: { $os: 'load-test', $browser: 'raw-resume-prober', $device: 'load-test' },
        },
      }),
    );
    ws.send(JSON.stringify({ op: 1, d: null }));

    const ready = await this.nextFrame((f) => f.op === 0 && f.t === 'Ready', timeoutMs);
    const d = (ready.d ?? {}) as { session_id?: string; resume_token?: string };
    this.sessionId = String(d.session_id ?? '');
    this.resumeToken = String(d.resume_token ?? '');

    this.armHeartbeat(ws, interval);
  }

  /** Drop the socket (resume-eligible polite close). */
  drop(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeEventListener('message', this.ingest);
      try {
        ws.close(1000, 'prober drop');
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Reconnect and Resume with a DELIBERATELY UNDERRUN seq (the
   * falsification the production client cannot perform): the server must
   * replay exactly every buffered dispatch with s > seq, oldest first,
   * gap-free (gateway.md "Resume buffer cap and the eviction watermark").
   */
  async resumeWith(seq: number, timeoutMs = 15_000, drainMs = 1_500): Promise<RawResumeResult> {
    const ws = this.socketFactory(this.url);
    this.ws = ws;
    ws.addEventListener('message', this.ingest);

    let refused = false;
    const refusalProbe = (ev: { data: unknown }): void => {
      try {
        const f = JSON.parse(String(ev.data)) as WireFrame;
        if (f.op === 9) refused = true;
      } catch {
        /* ignore */
      }
    };
    ws.addEventListener('message', refusalProbe);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('prober: resume socket never opened')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const hello = await this.nextFrame((f) => f.op === 10, timeoutMs);
    const interval = heartbeatInterval(hello);

    const before = this.events.length;
    const { sessionId, resumeToken, token } = this;

    ws.send(
      JSON.stringify({
        op: 5,
        d: { token, session_id: sessionId, seq, resume_token: resumeToken },
      }),
    );

    let resumed = false;
    try {
      await this.nextFrame((f) => f.op === 0 && f.t === 'Resumed', timeoutMs);
      resumed = true;
    } catch {
      resumed = false;
    }

    // The replay follows RESUMED immediately; drain the window.
    await new Promise((r) => setTimeout(r, drainMs));

    ws.removeEventListener('message', refusalProbe);
    if (resumed) this.armHeartbeat(ws, interval);

    const replayed = this.events.slice(before);
    let expected = seq;
    let firstBadIndex = -1;
    for (let i = 0; i < replayed.length; i++) {
      if (replayed[i]!.seq !== expected + 1) {
        firstBadIndex = i;
        break;
      }
      expected = replayed[i]!.seq;
    }

    return { resumed, refused: refused || !resumed, replayed, contiguous: firstBadIndex === -1, firstBadIndex };
  }

  /** Terminal teardown. */
  destroy(): void {
    this.drop();
  }

  private armHeartbeat(ws: ProberSocketLike, interval: number): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ op: 1, d: this.lastSeq > 0 ? this.lastSeq : null }));
      }
    }, Math.max(interval - 5_000, 5_000));
  }

  /** Wait for one matching frame (no ingestion side effects — ingest owns that). */
  private nextFrame(pred: (f: WireFrame) => boolean, timeoutMs: number): Promise<WireFrame> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('prober: no socket'));
    return new Promise<WireFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMessage);
        reject(new Error(`prober: no matching frame within ${timeoutMs}ms`));
      }, timeoutMs);
      const onMessage = (ev: { data: unknown }): void => {
        let f: WireFrame;
        try {
          f = JSON.parse(String(ev.data)) as WireFrame;
        } catch {
          return;
        }
        if (pred(f)) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          resolve(f);
        }
      };
      ws.addEventListener('message', onMessage);
    });
  }
}

function heartbeatInterval(hello: WireFrame): number {
  const d = (hello.d ?? {}) as { heartbeat_interval?: number };
  return Number(d.heartbeat_interval ?? 30_000);
}
