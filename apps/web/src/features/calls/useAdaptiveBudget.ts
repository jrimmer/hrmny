/**
 * @cytale/web — re-export shim for the extracted adaptive budget ladder.
 *
 * The getStats ladder is DOM-free and host-neutral (it rides the engine's
 * stats feed and video_want sink), so it moved to `@cytale/calls` whole; the
 * web call surfaces keep importing `./useAdaptiveBudget.js` unchanged.
 */

export {
  AdaptiveBudget,
  DEGRADE_FREEZE_DELTA,
  DEGRADE_JITTER_S,
  DEGRADE_STALLED_BYTES_PER_POLL,
  LADDER_INITIAL_TILES,
  LADDER_MAX_TILES,
  LADDER_MIN_TILES,
  LADDER_POLL_MS,
  LADDER_UPSHIFT_WINDOWS,
  LADDER_WINDOW_MS,
  collectInboundVideoStats,
  type AdaptiveBudgetHandle,
  type AdaptiveBudgetOptions,
  type InboundVideoStats,
  type LadderClearInterval,
  type LadderSetInterval,
  type StatsRecordLike,
  type StatsReportLike,
} from '@cytale/calls';
