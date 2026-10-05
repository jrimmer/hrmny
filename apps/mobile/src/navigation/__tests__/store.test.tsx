/**
 * @cytale/mobile — `useStoreSelector` binding tests (the React half of the
 * navigation store).
 *
 * The hook's ref cache must never serve a value that was computed by a
 * DIFFERENT selector. Keyed on store-state identity alone it does: a selector
 * that closes over a prop (the channel screen's `channelId`) keeps returning
 * the previous render's slice until some store write happens to intervene,
 * which is how a channel switch resolved permissions for the workspace it had
 * just left. These tests pin both halves of the contract: a prop switch with
 * no store write re-resolves, and an unrelated store write does not hand a
 * component a new object identity for an unchanged slice.
 */
import { renderHook } from '@testing-library/react-native';

import { createStateStore, type StateStore } from '@cytale/state';

import { useStoreSelector, type StoreLike } from '../store';

const CHANNEL_A = '700000000000000001';
const CHANNEL_B = '700000000000000002';

function channel(id: string, workspaceId: string, name: string) {
  return {
    id,
    workspace_id: workspaceId,
    name,
    type: 'text' as const,
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-08T00:00:00.000Z',
  };
}

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({
    channels: {
      [CHANNEL_A]: channel(CHANNEL_A, 'ws-1', 'general'),
      [CHANNEL_B]: channel(CHANNEL_B, 'ws-2', 'private'),
    },
  });
  return store;
}

describe('useStoreSelector', () => {
  it('re-resolves a prop-dependent selector when the prop changes with no store write', async () => {
    const store = makeStore();
    const { result, rerender } = await renderHook(
      ({ channelId }: { channelId: string }) =>
        useStoreSelector(store as StoreLike, (state) => state.channels[channelId]?.name ?? null),
      { initialProps: { channelId: CHANNEL_A } },
    );
    expect(result.current).toBe('general');

    // No store write between the renders — the cache must not answer for the
    // selector that was mounted with the previous prop.
    await rerender({ channelId: CHANNEL_B });
    expect(result.current).toBe('private');

    await rerender({ channelId: CHANNEL_A });
    expect(result.current).toBe('general');
  });

  it('keeps a prop-dependent selector correct when only the prop moves (slice identity held)', async () => {
    const store = makeStore();
    const { result, rerender } = await renderHook(
      ({ channelId }: { channelId: string }) =>
        useStoreSelector(store as StoreLike, (state) => state.channels[channelId]),
      { initialProps: { channelId: CHANNEL_A } },
    );
    const first = result.current;
    expect(first?.workspace_id).toBe('ws-1');

    await rerender({ channelId: CHANNEL_B });
    expect(result.current?.workspace_id).toBe('ws-2');

    await rerender({ channelId: CHANNEL_A });
    expect(result.current).toBe(first);
  });

  it('does not hand out a new identity for an unchanged slice on an unrelated write', async () => {
    const store = makeStore();
    let renders = 0;
    const { result } = await renderHook(() => {
      renders += 1;
      return useStoreSelector(store as StoreLike, (state) => state.channels);
    });
    const channels = result.current;
    const rendersBefore = renders;

    // A write that changes some OTHER slice: every subscriber's selector
    // re-runs, but the selected slice is untouched.
    store.setState((s) => ({
      presenceByUser: { ...s.presenceByUser, u1: { status: 'online', last_seen_at: 'now' } },
    }));

    expect(result.current).toBe(channels);
    expect(renders).toBe(rendersBefore);
  });
});
