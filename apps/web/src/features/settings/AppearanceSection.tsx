/**
 * @cytale/web — AppearanceSection, the gear surface's "Appearance" section.
 *
 * #151 — the two-axis selector:
 *   Mode  (data-theme):  Dark | Light — the house palette in each mode.
 *   Style (data-style):  Harmony | Pixel — Harmony is the house chrome;
 *                        Pixel is the fully implemented Starbase theme
 *                        (its own palette AND chrome) in the selected
 *                        mode, per owner direction 2026-09-24.
 * Both apply LIVE (the token layer keys on the document attributes) and
 * persist per-browser; boot-theme.js resolves both before first paint, so
 * a saved choice never flashes. The Mode default honors
 * prefers-color-scheme when nothing is stored.
 *
 * Reduce motion is REAL and client-local: a persisted per-browser flag
 * that sets <html data-reduce-motion> (shell.css zeroes transitions and
 * animations under it). AppShell applies the stored flag at boot; this
 * section owns the toggle.
 *
 * Lane D #8: "Don't keep messages on this device" — the per-device opt-out of
 * the persisted device cache (`app/persist/deviceCache.ts`). It lives here
 * beside the other per-browser preferences: it is a property of THIS device
 * (a shared computer), not of the account. Switching it on clears whatever
 * the cache already holds.
 */

import { useEffect, useState } from 'react';

import {
  applyStyle,
  applyTheme,
  persistStyle,
  persistTheme,
  readStyle,
  readTheme,
  type ThemeMode,
  type ThemeStyle,
} from '../../app/theme/prefs.js';
import { isDeviceCacheEnabled, setDeviceCacheEnabled } from '../../app/persist/deviceCache.js';

export const REDUCE_MOTION_KEY = 'cytale.reduce-motion';

/** Read the persisted reduce-motion preference (storage failures = off). */
export function readReduceMotion(): boolean {
  try {
    return localStorage.getItem(REDUCE_MOTION_KEY) === '1';
  } catch {
    return false;
  }
}

/** Apply/remove the document attribute the CSS rule keys on. */
export function applyReduceMotion(on: boolean): void {
  document.documentElement.toggleAttribute('data-reduce-motion', on);
}

const MODES: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: 'dark', label: 'Dark', hint: "Hrmny's home ground" },
  { value: 'light', label: 'Light', hint: 'The same design, in daylight' },
];

const STYLES: Array<{ value: ThemeStyle; label: string; hint: string }> = [
  { value: 'harmony', label: 'Harmony', hint: 'The house look — smooth, quiet' },
  { value: 'pixel', label: 'Pixel', hint: 'Starbase — CRT bezels, ink frames, mono type' },
];

interface AxisRowProps {
  name: string;
  options: Array<{ value: string; label: string; hint: string }>;
  value: string;
  onSelect: (value: string) => void;
  testPrefix: string;
}

function AxisRow({ name, options, value, onSelect, testPrefix }: AxisRowProps) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-col gap-2">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <label
            key={option.value}
            className={
              'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-4 py-2 text-sm ' +
              (active ? 'border-accent bg-surface-strong' : 'border-line bg-surface')
            }
            data-testid={`${testPrefix}-${option.value}`}
          >
            <input
              type="radio"
              name={name}
              className="accent-[var(--color-accent)]"
              checked={active}
              onChange={() => onSelect(option.value)}
            />
            <span className="font-medium text-text-primary">{option.label}</span>
            <span className="text-text-muted">— {option.hint}</span>
          </label>
        );
      })}
    </div>
  );
}

export function AppearanceSection() {
  const [mode, setMode] = useState<ThemeMode>(readTheme);
  const [style, setStyle] = useState<ThemeStyle>(readStyle);
  const [reduceMotion, setReduceMotion] = useState(readReduceMotion);
  // Stored as "keep" (the default); the switch reads as the opt-OUT.
  const [dontKeep, setDontKeep] = useState(() => !isDeviceCacheEnabled());

  useEffect(() => {
    applyTheme(mode);
    persistTheme(mode);
  }, [mode]);

  useEffect(() => {
    applyStyle(style);
    persistStyle(style);
  }, [style]);

  useEffect(() => {
    applyReduceMotion(reduceMotion);
    try {
      localStorage.setItem(REDUCE_MOTION_KEY, reduceMotion ? '1' : '0');
    } catch {
      // storage unavailable — the preference just doesn't persist
    }
  }, [reduceMotion]);

  return (
    <div className="flex flex-col gap-8" data-testid="settings-appearance">
      <section aria-label="Theme" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Theme</h2>
        <p className="text-sm text-text-muted">
          Mode and style are independent — any combination stands.
        </p>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Mode</p>
            <AxisRow
              name="Color mode"
              options={MODES}
              value={mode}
              onSelect={(v) => setMode(v as ThemeMode)}
              testPrefix="appearance-mode"
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Style</p>
            <AxisRow
              name="Interface style"
              options={STYLES}
              value={style}
              onSelect={(v) => setStyle(v as ThemeStyle)}
              testPrefix="appearance-style"
            />
          </div>
        </div>
      </section>

      <section aria-label="Motion" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Motion</h2>
        <div className="flex items-center justify-between gap-4 rounded-md border border-line bg-surface px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">Reduce motion</p>
            <p className="text-sm text-text-muted">
              Removes transitions and animations across the app.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={reduceMotion}
            data-testid="appearance-reduce-motion"
            className={
              'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--duration-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
              (reduceMotion ? 'bg-accent' : 'bg-surface-hover')
            }
            onClick={() => setReduceMotion((on) => !on)}
          >
            <span
              aria-hidden="true"
              className={
                'absolute top-0.5 h-5 w-5 rounded-full bg-background transition-[left] duration-[var(--duration-control)] ' +
                (reduceMotion ? 'left-[22px]' : 'left-0.5')
              }
            />
          </button>
        </div>
      </section>

      <section aria-label="Privacy" className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Privacy</h2>
        <div className="flex items-center justify-between gap-4 rounded-md border border-line bg-surface px-4 py-3">
          <div className="min-w-0">
            <p id="device-cache-label" className="text-sm font-medium text-text">
              Don&apos;t keep messages on this device
            </p>
            <p id="device-cache-help" className="text-sm text-text-muted">
              Recent messages and your channel list are normally saved in this browser so the app
              opens instantly. Turn this on for a shared or public computer — anything already
              saved is removed.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={dontKeep}
            aria-labelledby="device-cache-label"
            aria-describedby="device-cache-help"
            data-testid="appearance-device-cache-off"
            className={
              'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--duration-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
              (dontKeep ? 'bg-accent' : 'bg-surface-hover')
            }
            onClick={() => {
              const next = !dontKeep;
              setDontKeep(next);
              setDeviceCacheEnabled(!next);
            }}
          >
            <span
              aria-hidden="true"
              className={
                'absolute top-0.5 h-5 w-5 rounded-full bg-background transition-[left] duration-[var(--duration-control)] ' +
                (dontKeep ? 'left-[22px]' : 'left-0.5')
              }
            />
          </button>
        </div>
      </section>
    </div>
  );
}
