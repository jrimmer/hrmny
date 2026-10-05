/**
 * @cytale/domain — snowflake utility tests.
 *
 * Fixture vectors are derived with BigInt: `(ms - DISCORD_EPOCH) << 22`.
 */
import { describe, it, expect } from 'vitest';
import {
  DISCORD_EPOCH,
  compareSnowflakes,
  deltaMillis,
  extractSequenceComponent,
  extractTimestamp,
  extractUnixMsOffset,
  isAfter,
  isBefore,
  isSnowflake,
  newestFirst,
  oldestFirst,
} from '../snowflake.js';

// Snowflake whose embedded timestamp is 2025-01-01T00:00:00Z.
const Y2025 = '1323802873036800000';
// Same instant +500ms.
const Y2025_PLUS_500MS = '1323802875133952000';

describe('snowflake timestamp extraction', () => {
  it('extracts the correct generation time (epoch millis)', () => {
    expect(extractTimestamp(Y2025)).toBe(1735689600000);
    expect(extractTimestamp(Y2025_PLUS_500MS)).toBe(1735689600500);
  });

  it('exposes the raw ms-since-Discord-epoch field', () => {
    expect(extractUnixMsOffset(Y2025)).toBe(1735689600000 - Number(DISCORD_EPOCH));
  });

  it('round-trips a constructed timestamp through extraction', () => {
    const ms = Date.UTC(2026, 4, 1, 12, 30, 45, 123);
    const sf = ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
    expect(extractTimestamp(sf)).toBe(ms);
  });

  it('returns 0 for malformed input instead of throwing', () => {
    expect(extractTimestamp('')).toBe(0);
    expect(extractTimestamp('not-a-snowflake')).toBe(0);
    expect(extractTimestamp('-42')).toBe(0);
    expect(extractTimestamp('99999999999999999999')).toBe(0); // > int64
  });

  it('rejects non-string and out-of-range values structurally', () => {
    expect(isSnowflake('1323802873036800000')).toBe(true);
    expect(isSnowflake(1323802873036800000)).toBe(false); // number, not string
    expect(isSnowflake('')).toBe(false);
    expect(isSnowflake('9223372036854775808')).toBe(false); // int64 overflow
  });
});

describe('snowflake comparison', () => {
  it('orders chronologically by generation time', () => {
    const older = '1000000000000000000';
    const newer = '2000000000000000000';
    expect(compareSnowflakes(older, newer)).toBeLessThan(0);
    expect(compareSnowflakes(newer, older)).toBeGreaterThan(0);
    expect(compareSnowflakes(older, older)).toBe(0);
  });

  it('isBefore / isAfter agree with compare', () => {
    expect(isBefore(Y2025, Y2025_PLUS_500MS)).toBe(true);
    expect(isAfter(Y2025_PLUS_500MS, Y2025)).toBe(true);
    expect(isBefore(Y2025, Y2025)).toBe(false);
  });

  it('breaks ties on the low 22 bits for same-ms generation', () => {
    // Same timestamp field; sequence component differs (lower sorts first).
    const first = ((BigInt(1735689600000) - DISCORD_EPOCH) << 22n) | 1n;
    const second = ((BigInt(1735689600000) - DISCORD_EPOCH) << 22n) | 2n;
    expect(compareSnowflakes(first.toString(), second.toString())).toBeLessThan(0);
    expect(extractSequenceComponent(first.toString())).toBe(1);
    expect(extractSequenceComponent(second.toString())).toBe(2);
  });

  it('deltaMillis measures the gap between two generations', () => {
    expect(deltaMillis(Y2025, Y2025_PLUS_500MS)).toBe(500);
    expect(deltaMillis(Y2025_PLUS_500MS, Y2025)).toBe(-500);
  });

  it('sorts arrays newest-first and oldest-first', () => {
    const arr = [Y2025_PLUS_500MS, '1000000000000000000', Y2025];
    expect([...arr].sort(newestFirst)[0]).toBe(Y2025_PLUS_500MS);
    expect([...arr].sort(oldestFirst)[0]).toBe('1000000000000000000');
  });

  it('treats malformed ids consistently in comparisons', () => {
    expect(compareSnowflakes('garbage', Y2025)).toBeLessThan(0);
    expect(compareSnowflakes(Y2025, 'garbage')).toBeGreaterThan(0);
    expect(compareSnowflakes('garbage', 'also-garbage')).toBe(0);
  });
});
