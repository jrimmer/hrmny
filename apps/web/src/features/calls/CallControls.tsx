/**
 * @cytale/web — the compact call control set (calls plan U8; shared by U10).
 *
 * The mute/deafen/leave trio every call surface renders, extracted from
 * CallPanel so DM calls (U10) reuse the EXACT controls (AM18: the DM header
 * indicator expands into this compact set, not the full panel). Real buttons,
 * ≥40×40 hit areas, `aria-pressed` toggles, focus-visible rings, and the
 * stable `call-{mute,deafen,leave}-{context}` testid contract.
 */

import type { CallEngine, CallEngineSnapshot } from './useCallMedia.js';

const ICON_BUTTON =
  'flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

export interface CallControlsProps {
  /** The engine whose mute/deafen/leave intents the buttons drive. */
  engine: CallEngine;
  /** The engine snapshot (drives pressed state + danger coloring). */
  snapshot: CallEngineSnapshot;
  /**
   * True when the surface holds no active leg — mute/deafen render disabled.
   * Leave is ALWAYS enabled (the escape hatch from any state, per U8).
   */
  disabled?: boolean;
  /** Testid suffix — 'panel' | 'roster' | 'dm' (the owning surface). */
  context: string;
}

export function CallControls({ engine, snapshot, disabled = false, context }: CallControlsProps) {
  return (
    <>
      <button
        type="button"
        className={ICON_BUTTON + (snapshot.muted ? ' text-danger' : ' text-text-muted')}
        aria-pressed={snapshot.muted}
        aria-label={snapshot.muted ? 'Unmute microphone' : 'Mute microphone'}
        data-testid={`call-mute-${context}`}
        disabled={disabled}
        onClick={() => engine.toggleMute()}
      >
        <span aria-hidden>{snapshot.muted ? '🎙̶' : '🎙'}</span>
      </button>
      <button
        type="button"
        className={ICON_BUTTON + (snapshot.deafened ? ' text-danger' : ' text-text-muted')}
        aria-pressed={snapshot.deafened}
        aria-label={snapshot.deafened ? 'Undeafen' : 'Deafen'}
        data-testid={`call-deafen-${context}`}
        disabled={disabled}
        onClick={() => engine.toggleDeafen()}
      >
        <span aria-hidden>{snapshot.deafened ? '🎧̶' : '🎧'}</span>
      </button>
      <button
        type="button"
        className={ICON_BUTTON + ' text-danger'}
        aria-label="Leave call"
        data-testid={`call-leave-${context}`}
        onClick={() => engine.leave()}
      >
        <span aria-hidden>⏏</span>
        <span className="hidden lg:inline">Leave</span>
      </button>
    </>
  );
}
