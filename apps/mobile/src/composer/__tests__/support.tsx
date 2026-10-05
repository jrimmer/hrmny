/**
 * Shared fixtures for the composer tests (plan 004 M7). Not a test file —
 * jest's testMatch only picks up `*.test.ts(x)`.
 *
 * Every test renders through `renderComposer`, which supplies the two
 * provider-ish dependencies the view needs (a safe-area root and, optionally,
 * a store) and otherwise uses the production defaults. The session is never
 * mounted: `send`/`upload` are always injected, which is the seam the plan
 * names for exactly this reason.
 */
import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import type { UploadedAttachment } from '@cytale/api-client';
import {
  createEmojiPreferences,
  createMemoryEmojiStorage,
  type EmojiPreferences,
} from '@cytale/emoji';
import { createStateStore, type StateStore } from '@cytale/state';

import { Composer, type ComposerProps } from '../Composer';
import type { PickedAttachment } from '../types';

export const IDS = {
  me: '900000000000000001',
  alice: '900000000000000002',
  channel: '700000000000000001',
} as const;

export const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const UPLOADED: UploadedAttachment = {
  filename: 'cat.png',
  content_type: 'image/png',
  size: 3,
  url: '/attachments/6000000000000001/cat.png',
};

export const PICKED: PickedAttachment = {
  uri: 'file:///tmp/cat.png',
  name: 'cat.png',
  type: 'image/png',
  size: 3,
};

/** A store with the current user + one roster entry (the reply bar's name). */
export function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({
    currentUser: { id: IDS.me, username: 'rowan' },
    membersById: {
      [IDS.alice]: {
        id: IDS.alice,
        username: 'alice',
        nickname: null,
        joined_at: '2026-09-08T00:00:00.000Z',
        roles: [],
      },
    },
  });
  return store;
}

/** Preferences on a fresh in-memory store (never leaks between tests). */
export function makePreferences(): EmojiPreferences {
  return createEmojiPreferences(createMemoryEmojiStorage());
}

export interface RenderComposerOptions extends Omit<ComposerProps, 'channelId'> {
  channelId?: string;
}

/** RNTL v14's `render` is async — every call site awaits this. */
export async function renderComposer(options: RenderComposerOptions = {}): Promise<RenderResult> {
  const { channelId = IDS.channel, store = makeStore(), ...rest } = options;
  const element: ReactElement = (
    <SafeAreaProvider initialMetrics={METRICS}>
      <Composer channelId={channelId} store={store} preferences={makePreferences()} {...rest} />
    </SafeAreaProvider>
  );
  return await render(element);
}
