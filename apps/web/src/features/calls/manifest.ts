/**
 * @cytale/web — re-export shim for the extracted call manifest parser.
 *
 * THE attribution source (R5/KTD1) is a pure SDP/envelope parser, so it moved
 * to `@cytale/calls` whole; call sites keep importing `./manifest.js`.
 */

export {
  emptyManifest,
  isAudioSource,
  isVideoSource,
  manifestFromEntries,
  ownEntries,
  parseCallOffer,
  parseMlines,
  trackKey,
  type CallTrackAttribution,
  type CallTrackManifest,
  type MlineInfo,
  type ParsedCallOffer,
} from '@cytale/calls';
