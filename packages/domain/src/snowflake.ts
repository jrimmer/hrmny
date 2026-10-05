/**
 * @cytale/domain — Snowflake ID utilities.
 *
 * Cytale snowflakes are 64-bit Discord-epoch IDs whose canonical JSON
 * encoding is a decimal string (>53-bit safe). Bits 22–63 encode
 * milliseconds since the Discord epoch (1420070400000); bits 0–21 carry the
 * worker/sequence suffix. All numeric math here runs through BigInt — plain
 * numbers lose precision in exactly the range snowflakes occupy.
 */

/** Unix epoch milliseconds of the Discord epoch (2015-01-01T00:00:00Z). */
export const DISCORD_EPOCH = 1420070400000n;

/** Bit offset of the timestamp field within a snowflake (high 42 bits). */
export const TIMESTAMP_SHIFT = 22n;

/** int64 maximum as a string — guards every parser against uint64 overflow. */
export const SNOWFLAKE_INT64_MAX = '9223372036854775807';

const SNOWFLAKE_RE = /^\d{1,19}$/;

/** Structural check for a wire-form snowflake: non-empty decimal string within int64. */
export function isSnowflake(value: unknown): value is string {
  if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) return false;
  return (
    value.length < SNOWFLAKE_INT64_MAX.length ||
    (value.length === SNOWFLAKE_INT64_MAX.length && value <= SNOWFLAKE_INT64_MAX)
  );
}

/**
 * Extract the generation timestamp as epoch milliseconds.
 *
 * Returns 0 for structurally invalid input rather than throwing — callers
 * sorting mixed-origin data must never crash on a malformed id.
 */
export function extractTimestamp(snowflake: string): number {
  const value = parse(snowflake);
  if (value === null) return 0;
  return Number((value >> TIMESTAMP_SHIFT) + DISCORD_EPOCH);
}

/** Extract the raw millisecond-since-Discord-epoch field (no epoch added). */
export function extractUnixMsOffset(snowflake: string): number {
  const value = parse(snowflake);
  if (value === null) return -1;
  return Number(value >> TIMESTAMP_SHIFT);
}

/** Extract the low 22-bit worker/sequence component as a number (< 2^22). */
export function extractSequenceComponent(snowflake: string): number {
  const value = parse(snowflake);
  if (value === null) return -1;
  return Number(value & ((1n << TIMESTAMP_SHIFT) - 1n));
}

/**
 * Chronological comparison of two snowflakes (snowflakes sort by id).
 * Returns negative when `a` is older, positive when `a` is newer,
 * 0 when equal. Invalid inputs compare as 0 and sort first.
 */
export function compareSnowflakes(a: string, b: string): number {
  const av = parse(a);
  const bv = parse(b);
  if (av === null && bv === null) return 0;
  if (av === null) return -1;
  if (bv === null) return 1;
  if (av === bv) return 0;
  return av > bv ? 1 : -1;
}

/** True iff snowflake `a` was generated strictly before `b`. */
export function isBefore(a: string, b: string): boolean {
  return compareSnowflakes(a, b) < 0;
}

/** True iff snowflake `a` was generated strictly after `b`. */
export function isAfter(a: string, b: string): boolean {
  return compareSnowflakes(a, b) > 0;
}

/** Milliseconds between the generation instants of two snowflakes (`b` minus `a`). */
export function deltaMillis(a: string, b: string): number {
  return extractTimestamp(b) - extractTimestamp(a);
}

/** Newest-first comparator for `Array.prototype.sort` over snowflake strings. */
export function newestFirst(a: string, b: string): number {
  return compareSnowflakes(b, a);
}

/** Oldest-first comparator for `Array.prototype.sort` over snowflake strings. */
export function oldestFirst(a: string, b: string): number {
  return compareSnowflakes(a, b);
}

function parse(snowflake: string): bigint | null {
  if (!isSnowflake(snowflake)) return null;
  return BigInt(snowflake);
}
