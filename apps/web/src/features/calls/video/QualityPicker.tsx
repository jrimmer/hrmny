/**
 * @cytale/web — the video quality picker (calls V2 plan U5, R2/R9, VM20).
 *
 * Two fixtures in one control:
 *   sender   → publisher caps per source (R2, Discord-style): camera
 *              low/medium/high; screen low/medium/high/source. The tier ids
 *              ARE usePublish's PublishQualityId vocabulary and the labels
 *              mirror CAMERA/SCREEN_QUALITY_PRESETS' numbers — kept as a
 *              display map so the surface stays engine-free (the wiring
 *              unit passes engine values straight through).
 *   receiver → max-quality preference (R9, simulcast/GO branch only):
 *              high/medium/low — @cytale/protocol's VideoQualityPreference.
 *
 * VM20 (ratified): a permission-denied picker renders PRE-DISABLED with an
 * explanatory title — visible-but-unusable, never enabled-buttons-that-403,
 * never disappearing. `disabledTitle` is REQUIRED semantically when
 * disabled (a defensive generic is provided but tests pin the caller's
 * copy).
 *
 * Keyboard: the house menu contract — ArrowUp/Down move, Enter/Space pick,
 * Escape closes and returns focus to the trigger, outside click closes, Tab
 * escaping the menu dismisses it. The current tier reads as aria-checked
 * AND a leading glyph (never color alone).
 */

import { useEffect, useRef, useState } from 'react';

import type { VideoQualityPreference } from '@cytale/protocol';

import type { PublishQualityId } from '../usePublish.js';

/** Display tiers per picker surface (ids = the engine's vocabulary). */
interface QualityOption {
  id: string;
  label: string;
}

const CAMERA_OPTIONS: readonly QualityOption[] = [
  { id: 'low', label: '240p · 15 fps' },
  { id: 'medium', label: '360p · 30 fps' },
  { id: 'high', label: '720p · 30 fps' },
];

const SCREEN_OPTIONS: readonly QualityOption[] = [
  { id: 'low', label: '720p · 15 fps' },
  { id: 'medium', label: '1080p · 15 fps' },
  { id: 'high', label: '1080p · 30 fps' },
  { id: 'source', label: 'Source (uncapped)' },
];

const RECEIVER_OPTIONS: readonly QualityOption[] = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

export interface QualityPickerProps {
  /** Sender caps (per source) or the receiver's max-quality preference. */
  kind: 'sender' | 'receiver';
  /** The capped source (sender only; ignored by the receiver variant). */
  source?: 'camera' | 'screen';
  /** Current tier id (PublishQualityId | VideoQualityPreference). */
  value: string;
  /** Fired with the picked tier id. */
  onPick: (id: string) => void;
  /** VM20: pre-disabled (permission-denied / capability-off / offline). */
  disabled?: boolean;
  /** The explanatory title REQUIRED when disabled (VM20's honest copy). */
  disabledTitle?: string;
  /** Stable testid suffix (the owning surface — 'panel' | 'dm' | ...). */
  context: string;
}

const TRIGGER_CLASS =
  'flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
  'text-text-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

export function QualityPicker({
  kind,
  source = 'camera',
  value,
  onPick,
  disabled = false,
  disabledTitle,
  context,
}: QualityPickerProps) {
  const options =
    kind === 'receiver'
      ? RECEIVER_OPTIONS
      : source === 'screen'
        ? SCREEN_OPTIONS
        : CAMERA_OPTIONS;

  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const current = options.find((o) => o.id === value) ?? null;
  const triggerLabel =
    kind === 'receiver' ? 'Max video quality' : `${source === 'screen' ? 'Screen' : 'Camera'} quality`;
  const title = disabled
    ? (disabledTitle ?? 'Video quality is unavailable')
    : `${triggerLabel}: ${current?.label ?? value}`;

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (id: string): void => {
    onPick(id);
    close();
  };

  const step = (delta: number): void => {
    const n = options.length;
    setFocusIndex((i) => (i + delta + n * Math.ceil(Math.abs(delta) / n)) % n);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(options[focusIndex]?.id ?? options[0]!.id);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="relative inline-flex"
      ref={rootRef}
      onKeyDown={open ? onKeyDown : undefined}
      data-testid={`quality-picker-${context}`}
      data-kind={kind}
      data-source={kind === 'sender' ? source : undefined}
      data-disabled={disabled || undefined}
    >
      <button
        type="button"
        ref={triggerRef}
        className={TRIGGER_CLASS}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${triggerLabel}${current ? `: ${current.label}` : ''}`}
        title={title}
        data-testid={`quality-trigger-${context}`}
        disabled={disabled}
        onClick={() => {
          const currentIdx = options.findIndex((o) => o.id === value);
          setFocusIndex(currentIdx >= 0 ? currentIdx : 0);
          setOpen((o) => !o);
        }}
      >
        <span aria-hidden>⚙</span>
        <span aria-hidden className="max-w-28 truncate text-xs">
          {current?.label ?? value}
        </span>
      </button>

      {open ? (
        <div
          className="absolute top-full right-0 z-30 mt-1 flex w-56 flex-col gap-0.5 popover p-1.5"
          role="menu"
          aria-label={triggerLabel}
          data-testid={`quality-menu-${context}`}
        >
          {options.map((option, i) => {
            const isActive = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                className={
                  'flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ' +
                  'text-text-primary transition-colors duration-[var(--duration-control)] ' +
                  'hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none ' +
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]'
                }
                aria-checked={isActive}
                aria-label={`${triggerLabel}: ${option.label}`}
                data-testid={`quality-option-${context}`}
                data-quality={option.id}
                tabIndex={-1}
                ref={i === focusIndex ? (el) => el?.focus() : undefined}
                onClick={() => choose(option.id)}
              >
                <span aria-hidden className="w-3 shrink-0 text-center text-xs">
                  {isActive ? '●' : ''}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isActive ? (
                  <span
                    className="shrink-0 rounded-full bg-surface-hover px-1.5 py-0.5 text-[11px] text-text-primary"
                    data-testid={`quality-current-${context}`}
                  >
                    Current
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Option ids per surface (test seams + the wiring unit's value unions). */
export const CAMERA_QUALITY_IDS = CAMERA_OPTIONS.map((o) => o.id) as readonly Exclude<
  PublishQualityId,
  'source'
>[];
export const SCREEN_QUALITY_IDS = SCREEN_OPTIONS.map((o) => o.id) as readonly PublishQualityId[];
export const RECEIVER_QUALITY_IDS = RECEIVER_OPTIONS.map((o) => o.id) as readonly VideoQualityPreference[];
