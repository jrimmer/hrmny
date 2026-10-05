/**
 * @cytale/web — manifest module tests (calls V2 plan U4, R5/KTD1).
 *
 * Envelope-v2 parse → the mid→(user,source,rids) map; tolerance cases
 * (missing tracks, duplicate mids, V1 bodies, malformed JSON, answers,
 * ICE); the m-line parser.
 */
import { describe, expect, it } from 'vitest';

import {
  emptyManifest,
  isAudioSource,
  isVideoSource,
  manifestFromEntries,
  ownEntries,
  parseCallOffer,
  parseMlines,
  trackKey,
} from './manifest.js';

const ME = '7300000000000000001';
const U2 = '7300000000000000002';

const SDP = [
  'v=0',
  'm=audio 9 RTP/AVP 111',
  'a=mid:0',
  'a=recvonly',
  'm=audio 9 RTP/AVP 111',
  'a=mid:1',
  'a=sendonly',
  'm=video 9 RTP/AVP 96',
  'a=mid:2',
  'a=sendonly',
  'a=rid:f recv',
  'a=rid:h recv',
  'a=rid:q recv',
  'a=simulcast:recv q;h;f',
].join('\n');

function envelope(tracks: unknown, sdp = SDP): string {
  return JSON.stringify({ v: 2, type: 'offer', sdp, tracks });
}

describe('parseCallOffer', () => {
  it('parses an envelope-v2 offer into sdp + the mid-keyed manifest', () => {
    const out = parseCallOffer(
      envelope([
        { mid: '0', user_id: ME, source: 'mic' },
        { mid: '1', user_id: U2, source: 'mic' },
        { mid: '2', user_id: U2, source: 'camera', rids: ['f', 'h', 'q'] },
      ]),
    )!;
    expect(out.envelope).toBe(true);
    expect(out.sdp).toBe(SDP);
    expect(out.manifest.get('0')).toEqual({ userId: ME, source: 'mic' });
    expect(out.manifest.get('1')).toEqual({ userId: U2, source: 'mic' });
    expect(out.manifest.get('2')).toEqual({
      userId: U2,
      source: 'camera',
      rids: ['f', 'h', 'q'],
    });
    expect(out.manifest.size).toBe(3);
  });

  it('audio-only legs and manifest gaps are tolerated (nothing is guessed)', () => {
    // No video m-lines; mid 1 omitted from the manifest entirely.
    const out = parseCallOffer(
      envelope([{ mid: '0', user_id: ME, source: 'mic' }]),
    )!;
    expect(out.manifest.size).toBe(1);
    expect(out.manifest.get('1')).toBeUndefined();
  });

  it('a V1-shaped offer body negotiates with an EMPTY manifest', () => {
    const out = parseCallOffer(JSON.stringify({ type: 'offer', sdp: SDP }))!;
    expect(out.envelope).toBe(false);
    expect(out.manifest.size).toBe(0);
    expect(emptyManifest().size).toBe(0);
  });

  it('answers, ICE bodies, malformed JSON, and wrong versions are null', () => {
    expect(parseCallOffer(JSON.stringify({ type: 'answer', sdp: SDP }))).toBeNull();
    expect(parseCallOffer('{"candidate":"c","sdpMid":"0"}')).toBeNull();
    expect(parseCallOffer('not json')).toBeNull();
    expect(parseCallOffer(envelope([], SDP).replace('"v":2', '"v":1'))).toBeNull();
    expect(
      parseCallOffer(JSON.stringify({ v: 2, type: 'offer', sdp: SDP, tracks: 'nope' })),
    ).toBeNull();
    // Invalid manifest rows (bad snowflake, unknown source) reject wholesale.
    expect(
      parseCallOffer(envelope([{ mid: '0', user_id: 'not-a-snowflake', source: 'mic' }])),
    ).toBeNull();
    expect(parseCallOffer(envelope([{ mid: '0', user_id: ME, source: 'carrier_pigeon' }]))).toBeNull();
  });

  it('duplicate mids collapse deterministically (last entry wins)', () => {
    const out = parseCallOffer(
      envelope([
        { mid: '0', user_id: ME, source: 'mic' },
        { mid: '0', user_id: U2, source: 'mic' },
      ]),
    )!;
    expect(out.manifest.get('0')).toEqual({ userId: U2, source: 'mic' });
  });
});

describe('manifest helpers', () => {
  it('ownEntries lists the send-side binding set for a user', () => {
    const manifest = manifestFromEntries([
      { mid: '0', user_id: ME, source: 'mic' },
      { mid: '1', user_id: U2, source: 'mic' },
      { mid: '2', user_id: ME, source: 'screen' },
    ]);
    expect(ownEntries(manifest, ME)).toEqual([
      { mid: '0', source: 'mic' },
      { mid: '2', source: 'screen' },
    ]);
    expect(ownEntries(manifest, '7300000000000000099')).toEqual([]);
  });

  it('source-kind predicates and keys', () => {
    expect(isAudioSource('mic')).toBe(true);
    expect(isAudioSource('screen_audio')).toBe(true);
    expect(isAudioSource('camera')).toBe(false);
    expect(isVideoSource('camera')).toBe(true);
    expect(isVideoSource('screen')).toBe(true);
    expect(isVideoSource('mic')).toBe(false);
    expect(trackKey(U2, 'screen')).toBe(`${U2}:screen`);
  });
});

describe('parseMlines', () => {
  it('reports kind, mid, active, and direction for every m-line', () => {
    const sdp = [
      'v=0',
      'm=audio 9 RTP/AVP 111',
      'a=mid:0',
      'a=recvonly',
      'm=audio 0 RTP/AVP 111',
      'a=mid:1',
      'a=sendonly',
      'm=video 9 RTP/AVP 96',
      'a=mid:2',
      'a=inactive',
      'm=video 9 RTP/AVP 96',
      'a=mid:3',
    ].join('\n');
    expect(parseMlines(sdp)).toEqual([
      { kind: 'audio', mid: '0', active: true, direction: 'recvonly' },
      { kind: 'audio', mid: '1', active: false, direction: 'sendonly' },
      { kind: 'video', mid: '2', active: false, direction: 'inactive' },
      { kind: 'video', mid: '3', active: true, direction: '' },
    ]);
  });

  it('tolerates CRLF endings', () => {
    const info = parseMlines('v=0\r\nm=audio 9 RTP/AVP 111\r\na=mid:0\r\na=recvonly\r\n');
    expect(info).toEqual([{ kind: 'audio', mid: '0', active: true, direction: 'recvonly' }]);
  });
});
