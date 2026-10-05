/**
 * @cytale/web — one video tile (calls V2 plan U5).
 *
 * A single participant's camera rendered as a focusable surface. The tile
 * IS a button (VM21): its accessible name announces (name, camera state),
 * and Enter/Space activate enlargement (onEnlarge). Attachment is a plain
 * prop — the wiring half (U5b) feeds engine streams in; fixtures pass fakes.
 *
 * States (fixture-driven, no engine knowledge):
 *   loading             → skeleton + sr-only "connecting" (aria-busy)
 *   live                → the <video> element (srcObject attached by ref)
 *   camera-off          → avatar + "Camera off" chip (the publisher's choice)
 *   connection-paused   → avatar + "Video paused — connection" chip (VM18:
 *                         beyond the receiver's live-tile budget — a DIFFERENT
 *                         affordance from camera-off, never a blank tile)
 *   error               → avatar + role=alert (track/manifest failure)
 *
 * A live tile may carry `frozen` (the freeze→avatar degradation hint): a
 * text badge, never color alone. Speaking renders as ring AND icon (WCAG
 * non-color). Self-view passes `mirrored` (VM15 — remote video never).
 */

import { useEffect, useRef } from 'react';

import { Avatar } from '../../../app/ui/UserAvatar.js';

export type TileVideoState =
  | 'loading'
  | 'live'
  | 'camera-off'
  | 'connection-paused'
  | 'error';

/** The camera-state half of the accessible name (VM21). */
export function tileCameraStateText(state: TileVideoState): string {
  switch (state) {
    case 'live':
      return 'camera on';
    case 'camera-off':
      return 'camera off';
    case 'connection-paused':
      return 'video paused — connection';
    case 'loading':
      return 'connecting video';
    case 'error':
      return 'video unavailable';
  }
}

export interface TileProps {
  userId: string;
  /** Display name ("You" is the caller's choice via isSelf). */
  name: string;
  state: TileVideoState;
  /** Stream to attach when live (structural MediaStream; fixtures pass fakes). */
  stream?: unknown;
  /** Current-speaker ring + icon (non-color pairing). */
  speaking?: boolean;
  /** Freeze→avatar degradation hint on a live tile. */
  frozen?: boolean;
  /** Self-view mirroring (VM15) — the ONLY mirrored surface. */
  mirrored?: boolean;
  /** Thumbnail-strip compactness (VM19's collapsed grid). */
  compact?: boolean;
  /** VM21: Enter/Space/click activation → enlarge this participant. */
  onEnlarge?: (userId: string) => void;
}

export function Tile({
  userId,
  name,
  state,
  stream = null,
  speaking = false,
  frozen = false,
  mirrored = false,
  compact = false,
  onEnlarge,
}: TileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Attach by ref (plain prop — no engine coupling). jsdom lacks srcObject;
  // the guarded assignment is inert there and live in real browsers.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || state !== 'live') return;
    try {
      (el as unknown as { srcObject: unknown }).srcObject = stream;
    } catch {
      /* environments without a settable srcObject — the tile stays visual */
    }
  }, [state, stream]);

  const cameraText = tileCameraStateText(state);
  const showVideo = state === 'live' && stream != null;
  // live-without-a-stream-yet degrades to the skeleton, never a blank tile.
  const showSkeleton = state === 'loading' || (state === 'live' && !showVideo);
  const showAvatar =
    state === 'camera-off' || state === 'connection-paused' || state === 'error';

  return (
    <button
      type="button"
      className={
        'video-tile' +
        (mirrored ? ' video-mirrored' : '') +
        (compact ? ' video-tile-compact' : '')
      }
      data-testid="video-tile"
      data-user-id={userId}
      data-state={state}
      data-speaking={speaking || undefined}
      data-frozen={frozen || undefined}
      aria-busy={state === 'loading' || undefined}
      aria-label={`${name}, ${cameraText}`}
      onClick={() => onEnlarge?.(userId)}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          data-testid="tile-video"
          autoPlay
          muted
          playsInline
        />
      ) : null}

      {showSkeleton ? (
        <span
          aria-hidden
          data-testid="tile-skeleton"
          className="video-skeleton absolute inset-0 block"
        />
      ) : null}
      {showSkeleton ? (
        <span className="sr-only" role="status">
          Connecting {name}&apos;s video…
        </span>
      ) : null}

      {showAvatar ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <Avatar id={userId} name={name} size={48} />
          {state === 'camera-off' ? (
            <span
              className="flex items-center gap-1 rounded-full bg-scrim px-2 py-0.5 text-xs text-text-primary"
              data-testid="tile-camera-off"
            >
              <span aria-hidden>📹̶</span> Camera off
            </span>
          ) : null}
          {state === 'connection-paused' ? (
            <span
              className="flex items-center gap-1 rounded-full bg-scrim px-2 py-0.5 text-xs text-text-primary"
              data-testid="tile-paused-connection"
            >
              <span aria-hidden>⏸</span> Video paused — connection
            </span>
          ) : null}
          {state === 'error' ? (
            <span className="text-xs text-warning" role="alert" data-testid="tile-error">
              <span aria-hidden>⚠</span> Video unavailable
            </span>
          ) : null}
        </span>
      ) : null}

      {/* Speaking: ring (CSS) AND an icon — never color alone. */}
      {speaking ? (
        <span
          className="absolute right-1.5 top-1.5 rounded-full bg-scrim px-1.5 py-0.5 text-xs text-text-primary"
          data-testid="tile-speaking-icon"
        >
          <span aria-hidden>🔊</span>
          <span className="sr-only">speaking</span>
        </span>
      ) : null}

      {/* Freeze hint (degradation ladder's middle rung — text, not color). */}
      {frozen && state === 'live' ? (
        <span
          className="absolute inset-x-1.5 top-1.5 rounded bg-scrim px-1.5 py-0.5 text-left text-xs text-text-primary"
          data-testid="tile-freeze-hint"
        >
          <span aria-hidden>❄</span> Video may be frozen
        </span>
      ) : null}

      <span
        className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-12px)] truncate rounded bg-scrim px-1.5 py-0.5 text-xs text-text-primary"
        data-testid="tile-name"
      >
        {name}
      </span>
    </button>
  );
}
