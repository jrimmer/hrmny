/**
 * @cytale/web — cached locale formatters (2026-09-12).
 *
 * These exist because `Date.prototype.toLocaleTimeString([], { … })` builds
 * locale machinery per call, and the message list calls it per row per render:
 * a CPU profile of a wheel scroll through a channel's history showed it as the
 * single largest app cost (810 samples against the scroll handler's 49). The
 * tests below pin the two things that matter — the output is IDENTICAL to the
 * per-call form it replaced (so this is a performance change, never a
 * formatting one), and unparseable input still comes back unchanged.
 */
import { describe, expect, it } from 'vitest';

import {
  formatClock,
  formatClockPadded,
  formatDateTime,
  formatLongDate,
  formatRelative,
  formatShortDate,
  formatMessageStamp,
} from '../time.js';

const ISO = '2026-09-12T16:35:07.000Z';

describe('cached formatters — behaviour is unchanged from the per-call forms', () => {
  it('formatClock matches toLocaleTimeString with the row options', () => {
    expect(formatClock(ISO)).toBe(
      new Date(ISO).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    );
  });

  it('formatClockPadded matches the call log’s two-digit options', () => {
    expect(formatClockPadded(ISO)).toBe(
      new Date(ISO).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('formatLongDate matches the divider’s long-date options', () => {
    expect(formatLongDate(ISO)).toBe(
      new Date(ISO).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }),
    );
  });

  it('formatShortDate matches a bare toLocaleDateString', () => {
    expect(formatShortDate(ISO)).toBe(new Date(ISO).toLocaleDateString());
  });

  it('formatDateTime matches a bare toLocaleString — date AND time, not date alone', () => {
    // The trap this pins: Intl.DateTimeFormat's own no-options default is
    // date-only, so a careless cache would have silently dropped the time from
    // every "(edited)" tooltip.
    expect(formatDateTime(ISO)).toBe(new Date(ISO).toLocaleString());
  });
});

describe('cached formatters — malformed input', () => {
  it('returns the raw string rather than "Invalid Date"', () => {
    expect(formatClock('not-a-date')).toBe('not-a-date');
    expect(formatLongDate('not-a-date')).toBe('not-a-date');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  it('is stable across repeated calls (the formatter is reused, not rebuilt)', () => {
    expect(formatClock(ISO)).toBe(formatClock(ISO));
  });
});

describe('formatMessageStamp — the age-aware message timestamp (owner direction 2026-09-18)', () => {
  const NOW = Date.parse('2026-09-18T15:00:00.000Z');
  // A fixed local noon reference keeps the day ladder deterministic without
  // depending on the runner's timezone: build ISO strings from local dates.
  const local = (daysAgo: number, h: number, m: number): string => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  it('today stays time-only, matching the row clock exactly', () => {
    const iso = local(0, 14, 35);
    expect(formatMessageStamp(iso, NOW)).toBe(formatClock(iso));
  });

  it('yesterday reads "Yesterday, <time>"', () => {
    const iso = local(1, 9, 5);
    expect(formatMessageStamp(iso, NOW)).toBe(`Yesterday, ${formatClock(iso)}`);
  });

  it('within the past week reads the weekday', () => {
    const iso = local(3, 11, 45);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(iso));
    expect(formatMessageStamp(iso, NOW)).toBe(`${weekday}, ${formatClock(iso)}`);
  });

  it('past the week reads short month + day number', () => {
    const iso = local(12, 8, 0);
    const md = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
    expect(formatMessageStamp(iso, NOW)).toBe(`${md}, ${formatClock(iso)}`);
  });

  it('exactly seven days ago is still the weekday; eight is the month-day form', () => {
    const seven = local(7, 10, 0);
    const eight = local(8, 10, 0);
    expect(formatMessageStamp(seven, NOW)).toMatch(/^[A-Z][a-z]+, /);
    expect(formatMessageStamp(eight, NOW)).toMatch(/^[A-Z][a-z]{2} \d+, /);
  });

  it('the ladder is boundary-exact across midnight, not by 24h subtraction', () => {
    // 23:59 yesterday is 15h before NOW — a 24h-subtraction would call it
    // today. Midnight boundaries decide.
    const iso = local(1, 23, 59);
    expect(formatMessageStamp(iso, NOW)).toMatch(/^Yesterday, /);
  });

  it('malformed input returns the raw string', () => {
    expect(formatMessageStamp('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('formatRelative — the one relative stamp', () => {
  const now = Date.parse('2026-09-14T12:00:00.000Z');

  it('floors: 90 minutes is "1h ago", never rounded up to 2h', () => {
    expect(formatRelative('2026-09-14T10:30:00.000Z', now)).toBe('1h ago');
  });

  it('words recent times, then falls back to the short date after a week', () => {
    expect(formatRelative('2026-09-14T11:59:40.000Z', now)).toBe('just now');
    expect(formatRelative('2026-09-14T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatRelative('2026-09-12T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatRelative('2026-08-01T12:00:00.000Z', now)).toBe(formatShortDate('2026-08-01T12:00:00.000Z'));
  });

  it('is empty for a missing or broken stamp', () => {
    expect(formatRelative(null, now)).toBe('');
    expect(formatRelative('nope', now)).toBe('');
  });
});
