/**
 * @cytale/markdown — Discord's timestamp tag, `<t:UNIX>` / `<t:UNIX:STYLE>`.
 *
 * A message carries a moment in time, not a string: every reader sees it in
 * their own locale and time zone, and the `R` style counts toward (or away
 * from) it — "in 5 minutes", "in 4 minutes", … "5 minutes ago". A bot's
 * prompt can say "If you don't answer <t:1791328800:R> it will NOT run" and
 * mean the same instant to everyone, whenever they open the channel.
 *
 * The styles are Discord's:
 *
 *   t  short time        4:20 PM
 *   T  long time         4:20:30 PM
 *   d  short date        10/06/2026
 *   D  long date         October 6, 2026
 *   f  date and time     October 6, 2026 at 4:20 PM   (the default)
 *   F  with weekday      Tuesday, October 6, 2026 at 4:20 PM
 *   R  relative          in 5 minutes / 5 minutes ago
 *
 * The exact wording is the reader's locale's (`Intl`), as it is on Discord.
 * This module only formats; whether a label keeps ticking is the renderer's
 * business ({@link relativeRefreshMs} says how often it should).
 */

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/** `<t:UNIX:STYLE>` — `unix` is in seconds; `source` is the exact tag. */
export interface TimestampNode {
  readonly type: 'timestamp';
  readonly unix: number;
  readonly style: TimestampStyle;
  readonly source: string;
}

/** Discord's default when a tag names no style. */
export const DEFAULT_TIMESTAMP_STYLE: TimestampStyle = 'f';

/** The farthest instant a JS `Date` holds, in seconds (±8.64e15 ms). */
const MAX_UNIX_SECONDS = 8.64e12;

/** True when `unix` (seconds) is an instant a `Date` can represent. */
export function isValidUnixSeconds(unix: number): boolean {
  return Number.isSafeInteger(unix) && Math.abs(unix) <= MAX_UNIX_SECONDS;
}

export interface TimestampFormatOptions {
  /** The reader's clock in ms (`Date.now()` when absent) — `R` only. */
  readonly now?: number;
  /** BCP 47 locale; the runtime's default when absent. */
  readonly locale?: string;
  /** IANA zone; the runtime's (the reader's) when absent. */
  readonly timeZone?: string;
}

const ABSOLUTE: Record<Exclude<TimestampStyle, 'R'>, Intl.DateTimeFormatOptions> = {
  t: { hour: 'numeric', minute: '2-digit' },
  T: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { year: 'numeric', month: 'long', day: 'numeric' },
  f: { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  F: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
};

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The unit ladder for `R`: a value is shown in the largest unit it reaches
 * once rounded, so 59.6 minutes reads "in 1 hour", never "in 60 minutes".
 */
const RELATIVE_UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; seconds: number; upTo: number }[] = [
  { unit: 'second', seconds: SECOND, upTo: 60 },
  { unit: 'minute', seconds: MINUTE, upTo: 60 },
  { unit: 'hour', seconds: HOUR, upTo: 24 },
  { unit: 'day', seconds: DAY, upTo: 30 },
  { unit: 'month', seconds: 30 * DAY, upTo: 12 },
  { unit: 'year', seconds: 365 * DAY, upTo: Infinity },
];

function relative(unix: number, opts: TimestampFormatOptions): string {
  const now = opts.now ?? Date.now();
  const diff = unix - now / 1000; // seconds; negative is the past
  const format = new Intl.RelativeTimeFormat(opts.locale, { numeric: 'auto' });
  for (const { unit, seconds, upTo } of RELATIVE_UNITS) {
    const value = Math.round(diff / seconds);
    if (Math.abs(value) < upTo) return format.format(value, unit);
  }
  return format.format(Math.round(diff / (365 * DAY)), 'year');
}

/** A timestamp's label in `style`, for this reader. */
export function formatTimestamp(unix: number, style: TimestampStyle, opts: TimestampFormatOptions = {}): string {
  if (style === 'R') return relative(unix, opts);
  return new Intl.DateTimeFormat(opts.locale, { ...ABSOLUTE[style], timeZone: opts.timeZone }).format(
    new Date(unix * 1000),
  );
}

/**
 * How a timestamp reads where nothing re-renders it (previews, plain text):
 * its own style, except `R`, which would freeze — "in 5 minutes" is a lie an
 * hour later — and reads as the full date and time instead.
 */
export function timestampPlainText(node: TimestampNode, opts: TimestampFormatOptions = {}): string {
  return formatTimestamp(node.unix, node.style === 'R' ? 'f' : node.style, opts);
}

/**
 * How long until an `R` label may change, in ms: every second within the
 * hour either side (the countdown a prompt shows), every minute within a
 * day, hourly beyond.
 */
export function relativeRefreshMs(unix: number, now: number = Date.now()): number {
  const away = Math.abs(unix - now / 1000);
  if (away < HOUR) return 1000;
  if (away < DAY) return 60 * 1000;
  return 60 * 60 * 1000;
}
