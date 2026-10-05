/**
 * The gates that decide whether a message is HEARD.
 *
 * These are the feature: a ding on every message is the notification-fatigue
 * failure the whole system exists to avoid, in audio form. The tone is
 * incidental; the restraint is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOTIFICATION_SOUND_KEY,
  readNotificationSoundEnabled,
  shouldDing,
  writeNotificationSoundEnabled,
  type NoticeDeps,
} from '../coordinator.js';

const ME = '9000000000000001';
const OTHER = '9000000000000002';
const CHANNEL = '9000000000000010';
const WORKSPACE = '9000000000000100';

function notice(over: Partial<Parameters<typeof shouldDing>[0]> = {}) {
  return {
    channel_id: CHANNEL,
    thread_id: null,
    author_id: OTHER,
    content: 'just chatting',
    workspace_id: WORKSPACE,
    ...over,
  };
}

function deps(over: Partial<NoticeDeps> = {}): NoticeDeps {
  return { selfId: ME, overrides: {}, isDm: false, ...over };
}

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    // storage unavailable
  }
});

describe('the default level', () => {
  // A member who configured nothing gets the DEFAULT: mentions reach them,
  // ordinary channel traffic does not. An audible default of "everything" is
  // how a chat app becomes unbearable on day one.
  it('does not ding ordinary channel traffic', () => {
    expect(shouldDing(notice(), deps())).toBe(false);
  });

  it('dings a direct mention', () => {
    expect(shouldDing(notice({ content: `hey <@${ME}> look` }), deps())).toBe(true);
  });

  it('dings the nickname form of a mention too', () => {
    expect(shouldDing(notice({ content: `hey <@!${ME}> look` }), deps())).toBe(true);
  });

  it('does not ding a mention of somebody else', () => {
    expect(shouldDing(notice({ content: `hey <@${OTHER}>` }), deps())).toBe(false);
  });
});

// 2026-09-27: "Mentions only" includes @everyone/@here unless the member
// suppressed broadcasts in the workspace — the server policy's rule.
describe('broadcasts', () => {
  it('dings @everyone and @here at the default level', () => {
    expect(shouldDing(notice({ content: '@everyone standup' }), deps())).toBe(true);
    expect(shouldDing(notice({ content: '@here quick q' }), deps())).toBe(true);
  });

  it('does not ding a broadcast the member suppressed', () => {
    expect(shouldDing(notice({ content: '@everyone standup' }), deps({ broadcastSuppressed: true }))).toBe(false);
  });

  it('a suppressed broadcast that also names me still dings', () => {
    expect(
      shouldDing(notice({ content: `@everyone and <@${ME}>` }), deps({ broadcastSuppressed: true })),
    ).toBe(true);
  });

  it('a muted channel stays silent on a broadcast', () => {
    expect(
      shouldDing(notice({ content: '@everyone standup' }), deps({ overrides: { [`channel:${CHANNEL}`]: 'mute' } })),
    ).toBe(false);
  });

  it('@heretical is prose, not a broadcast', () => {
    expect(shouldDing(notice({ content: '@heretical take' }), deps())).toBe(false);
  });
});

describe('the member’s own instructions outrank the event', () => {
  it('never dings my own message', () => {
    expect(shouldDing(notice({ author_id: ME, content: `<@${ME}>` }), deps())).toBe(false);
  });

  // The readout-lies case: a ding from a channel the settings screen reports
  // as muted. The same resolver decides both, so they cannot disagree.
  it('does not ding a muted channel even on a mention', () => {
    const d = deps({ overrides: { [`channel:${CHANNEL}`]: 'mute' } });
    expect(shouldDing(notice({ content: `<@${ME}>` }), d)).toBe(false);
  });

  it('does not ding a channel muted at the workspace layer', () => {
    const d = deps({ overrides: { [`workspace:${WORKSPACE}`]: 'mute' } });
    expect(shouldDing(notice({ content: `<@${ME}>` }), d)).toBe(false);
  });

  it('does not ding when the channel’s ring mute is set', () => {
    expect(shouldDing(notice({ content: `<@${ME}>` }), deps({ channelMuted: true }))).toBe(false);
  });

  it('dings a channel set to all activity', () => {
    const d = deps({ overrides: { [`channel:${CHANNEL}`]: 'all' } });
    expect(shouldDing(notice(), d)).toBe(true);
  });

  // The participation sweep reaches the sound too. Without this the settings
  // readout would say "because you posted here" while the app stayed silent.
  it('dings a muted channel the member has participated in', () => {
    const d = deps({ overrides: { [`channel:${CHANNEL}`]: 'mute' }, participated: true });
    expect(shouldDing(notice(), d)).toBe(true);
  });

  it('still does not ding a muted channel with no participation', () => {
    const d = deps({ overrides: { [`channel:${CHANNEL}`]: 'mute' }, participated: false });
    expect(shouldDing(notice(), d)).toBe(false);
  });
});

describe('direct messages', () => {
  it('always ding — they are addressed by construction', () => {
    expect(shouldDing(notice({ content: 'hi' }), deps({ isDm: true }))).toBe(true);
  });

  it('a muted DM still does not ding', () => {
    const d = deps({ isDm: true, overrides: { [`channel:${CHANNEL}`]: 'mute' } });
    expect(shouldDing(notice(), d)).toBe(false);
  });
});

describe('an unknown viewer', () => {
  // Before hydration nothing can be addressed to us, and a ding for a frame
  // that arrived in that window would be for somebody else's account state.
  it('does not ding', () => {
    expect(shouldDing(notice({ content: `<@${ME}>` }), deps({ selfId: null }))).toBe(false);
  });
});

describe('the per-device preference', () => {
  it('defaults to on when never set', () => {
    expect(readNotificationSoundEnabled()).toBe(true);
  });

  it('remembers an explicit off', () => {
    writeNotificationSoundEnabled(false);
    expect(readNotificationSoundEnabled()).toBe(false);
    expect(localStorage.getItem(NOTIFICATION_SOUND_KEY)).toBe('0');
  });

  it('remembers an explicit on', () => {
    writeNotificationSoundEnabled(false);
    writeNotificationSoundEnabled(true);
    expect(readNotificationSoundEnabled()).toBe(true);
  });
});
