/**
 * @cytale/web — cached locale formatters (2026-09-12).
 *
 * `Date.prototype.toLocaleTimeString([], { … })` builds locale machinery on
 * every call — resolving the locale and constructing a formatter each time.
 * That was invisible until it ran per row per render: profiling a wheel scroll
 * through a channel's history showed `formatTime` as the single largest app
 * cost (810 samples of pure self time, against 49 for the scroll handler
 * itself), because the message list re-formats every visible row's timestamp
 * as it re-windows.
 *
 * So the formatters are built once, at module scope, and shared. Each wrapper
 * keeps the exact options of the call site it replaced — `formatClock` is the
 * message-row default (bare single-digit hour), `formatClockPadded` is the
 * call log's two-digit form, and `formatDateTime` matches the no-argument
 * `toLocaleString` that the "(edited)" tooltip used, because
 * `Intl.DateTimeFormat`'s own no-options default is date-only and would have
 * silently dropped the time.
 *
 * Unparseable input returns itself, so a malformed timestamp renders as the
 * raw string rather than "Invalid Date" — the behaviour every call site had.
 */

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const CLOCK_PADDED = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

const LONG_DATE = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const SHORT_DATE = new Intl.DateTimeFormat(undefined);

/** Same component set as the no-argument `toLocaleString`: date AND time. */
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "4:35 PM" — bare single-digit hour, the message-row timestamp. */
export function formatClock(iso: string): string {
  const d = parse(iso);
  return d === null ? iso : CLOCK.format(d);
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/**
 * The message-row timestamp, age-aware (owner direction 2026-09-18): today
 * stays time-only; yesterday reads "Yesterday, 2:30 PM"; within the past week
 * the weekday ("Tuesday, 2:30 PM"); older is "Sep 2, 2:30 PM". Scrolling back
 * should always answer how long ago a thing was said.
 */
export function formatMessageStamp(iso: string, now: number = Date.now()): string {
  const d = parse(iso);
  if (d === null) return iso;

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const ageDays = Math.floor((todayStart.getTime() - startOfDay(d).getTime()) / 86_400_000);

  const clock = CLOCK.format(d);
  if (ageDays <= 0) return clock;
  if (ageDays === 1) return `Yesterday, ${clock}`;
  if (ageDays <= 7) return `${WEEKDAY.format(d)}, ${clock}`;
  return `${MONTH_DAY.format(d)}, ${clock}`;
}

function startOfDay(d: Date): Date {
  const c = new Date(d.getTime());
  c.setHours(0, 0, 0, 0);
  return c;
}

/** "04:35 PM" — zero-padded, the call log's boundary rail. */
export function formatClockPadded(iso: string): string {
  const d = parse(iso);
  return d === null ? iso : CLOCK_PADDED.format(d);
}

/** "September 12, 2026" — the timeline's date divider and the thread's start line. */
export function formatLongDate(iso: string): string {
  const d = parse(iso);
  return d === null ? iso : LONG_DATE.format(d);
}

/** "9/12/2026" — the compact form used by profile and settings rows. */
export function formatShortDate(iso: string): string {
  const d = parse(iso);
  return d === null ? iso : SHORT_DATE.format(d);
}

/** "9/12/2026, 12:36:00 PM" — tooltips that want the full stamp. */
export function formatDateTime(iso: string): string {
  const d = parse(iso);
  return d === null ? iso : DATE_TIME.format(d);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "just now" / "12m ago" / "3h ago" / "2d ago", then the short date once it
 * stops being recent (a week). The ONE relative stamp: the inbox, the threads
 * list and the all-calls list each carried a copy, and they disagreed — the
 * inbox floored (90 minutes read "1h ago") while the other two rounded ("2h
 * ago"), and only the inbox ever fell back to a date. Floored, so a stamp
 * never claims more time has passed than has. Empty for a missing or broken
 * stamp, never "NaN".
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const delta = Math.max(now - then, 0);
  if (delta < MINUTE_MS) return 'just now';
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h ago`;
  if (delta < 7 * DAY_MS) return `${Math.floor(delta / DAY_MS)}d ago`;
  return formatShortDate(iso);
}
