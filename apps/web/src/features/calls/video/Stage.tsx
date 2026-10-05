/**
 * @cytale/web — the screenshare stage (calls V2 plan U5).
 *
 * The share viewer: video surface + presenter bar (presenter name, the
 * share-audio badge per VM9, pin/unpin, the VM16 enlarge affordance) with
 * the ShareSwitcher slotted in when multiple shares are live (R8/VM4).
 *
 * VM22's stage-selection state machine ({follow-recent, viewer-selected,
 * pinned}) is the PARENT's state — Stage renders the staged share it is
 * handed and reports pin toggles; when the LAST share ends it surfaces the
 * ended state with onCollapse (collapse-to-grid is the composition's move).
 * A pinned source ending is invisible here: the parent simply re-stages
 * per follow-recent.
 *
 * States-first:
 *   empty  → renders null (VM16: no share means the GRID fills the panel;
 *            the parent unmounts or ignores the stage)
 *   ended  → notice card (reason copy: stopped vs presenter-left) + Back
 *            to grid (onCollapse)
 *   loading→ share present, stream not yet attached: skeleton + status
 *   error  → role=alert with recovery copy (track failure)
 *   live   → video + presenter bar
 *
 * VM21 announcements: share start/end and pin state ride a persistent
 * sr-only polite live region (data-testid="stage-announce").
 */

import { useEffect, useRef, type ReactNode } from 'react';

const ICON_BUTTON =
  'flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/** The share the stage is rendering (VM22's current selection). */
export interface StageShare {
  shareId: string;
  presenterId: string;
  presenterName: string;
  /** Stream to attach (structural MediaStream; fixtures pass fakes). */
  stream?: unknown;
  /** VM9: the share carries a live share-audio track. */
  shareAudio: boolean;
  /** What is shared ("Entire screen", "Window"). */
  sourceLabel?: string;
}

export interface StageProps {
  /** null + no endedReason → the empty/collapsed state (renders null). */
  share: StageShare | null;
  /** Why the (now absent) share ended — drives the ended-state copy. */
  endedReason?: 'stopped' | 'presenter-left' | null;
  /** Who presented the ended share (for the presenter-left copy). */
  endedPresenterName?: string;
  /** Track/manifest failure on the staged share (error-state copy). */
  error?: string | null;
  /** VM22 pinned state of the staged share (drives the pin control). */
  pinned?: boolean;
  /** aria-pressed state of the enlarge toggle (the parent owns geometry). */
  fullscreen?: boolean;
  onPinToggle?: () => void;
  onEnlargeToggle?: () => void;
  /** VM22: last share ended → collapse the stage region to the grid. */
  onCollapse?: () => void;
  /** Slot for ShareSwitcher (rendered in the presenter bar). */
  switcher?: ReactNode;
}

export function Stage({
  share,
  endedReason = null,
  endedPresenterName,
  error = null,
  pinned = false,
  fullscreen = false,
  onPinToggle,
  onEnlargeToggle,
  onCollapse,
  switcher,
}: StageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !share || share.stream == null) return;
    try {
      (el as unknown as { srcObject: unknown }).srcObject = share.stream;
    } catch {
      /* inert in environments without a settable srcObject */
    }
  }, [share]);

  // -- collapsed: no share, nothing ended → the grid owns the panel (VM16).
  if (!share && !endedReason) return null;

  // -- ended state (VM21 announcement + collapse affordance per VM22).
  if (!share) {
    const copy =
      endedReason === 'presenter-left'
        ? `${endedPresenterName ?? 'The presenter'} left the call — their screen share ended.`
        : 'The screen share ended.';
    return (
      <section
        className="video-stage"
        data-testid="video-stage"
        data-stage-state="ended"
        aria-label="Screen share"
      >
        <div
          className="rounded-md border border-line bg-surface-hover px-3 py-4 text-center"
          role="status"
          data-testid="stage-ended"
        >
          <p className="text-sm font-semibold text-text-primary">{copy}</p>
          <button
            type="button"
            className={ICON_BUTTON + ' mt-2 bg-surface-strong text-text-primary'}
            data-testid="stage-collapse"
            onClick={() => onCollapse?.()}
          >
            Back to grid
          </button>
        </div>
        <div role="status" aria-live="polite" className="sr-only" data-testid="stage-announce">
          The screen share ended.
        </div>
      </section>
    );
  }

  const failed = error != null;
  const showVideo = !failed && share.stream != null;
  const announcement = failed
    ? 'The screen share failed.'
    : pinned
      ? `${share.presenterName}'s screen share is pinned.`
      : `${share.presenterName} is sharing their ${share.sourceLabel ?? 'screen'}.`;

  return (
    <section
      className={'video-stage video-stage-live' + (fullscreen ? ' video-stage-fullscreen' : '')}
      data-testid="video-stage"
      data-stage-state={failed ? 'error' : 'live'}
      data-share-id={share.shareId}
      data-pinned={pinned || undefined}
      data-fullscreen={fullscreen || undefined}
      aria-label="Screen share"
    >
      <div className="video-stage-surface" data-testid="stage-surface">
        {showVideo ? (
          <video
            ref={videoRef}
            className="video-stage-video"
            data-testid="stage-video"
            autoPlay
            muted
            playsInline
          />
        ) : null}
        {!showVideo && !failed ? (
          <>
            <span
              aria-hidden
              data-testid="stage-skeleton"
              className="video-skeleton absolute inset-0 block"
            />
            <span className="sr-only" role="status">
              Loading {share.presenterName}&apos;s screen share…
            </span>
          </>
        ) : null}
        {failed ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center"
            role="alert"
            data-testid="stage-error"
          >
            <p className="text-sm font-semibold text-danger">
              <span aria-hidden>⚠</span> The screen share failed
            </p>
            <p className="text-sm text-text-muted">
              {error} The stage will return when the connection recovers.
            </p>
          </div>
        ) : null}
      </div>

      {/* Presenter bar */}
      <div
        className="flex min-h-10 shrink-0 items-center gap-2 border-t border-line px-2 py-1"
        data-testid="stage-presenter-bar"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary" data-testid="stage-presenter">
          <span aria-hidden>🖥</span>{' '}
          {share.presenterName}&apos;s {share.sourceLabel ?? 'screen'}
        </span>

        {share.shareAudio ? (
          <span
            className="flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-xs text-text-primary"
            data-testid="stage-share-audio-badge"
          >
            <span aria-hidden>🔊</span>
            <span className="sr-only">sharing audio — </span>
            Sharing audio
          </span>
        ) : null}

        <button
          type="button"
          className={ICON_BUTTON + (pinned ? ' text-text-primary' : ' text-text-muted')}
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin screen share' : 'Pin screen share'}
          data-testid="stage-pin"
          onClick={() => onPinToggle?.()}
        >
          <span aria-hidden>{pinned ? '📍' : '📌'}</span>
        </button>

        <button
          type="button"
          className={ICON_BUTTON + ' text-text-muted'}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? 'Exit fullscreen stage' : 'Enlarge stage'}
          data-testid="stage-enlarge"
          onClick={() => onEnlargeToggle?.()}
        >
          <span aria-hidden>⛶</span>
        </button>

        {switcher}
      </div>

      <div role="status" aria-live="polite" className="sr-only" data-testid="stage-announce">
        {announcement}
      </div>
    </section>
  );
}
