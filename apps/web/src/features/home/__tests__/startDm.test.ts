/**
 * @cytale/web — the start-a-DM handler (#94): open or return-existing.
 *
 * The dedup contract: a member the viewer already has a 1:1 thread with
 * resolves to the EXISTING channel with no network call; a new member hits
 * the open-dm API exactly once; both outcomes navigate through onDmReady.
 * The snapshot is read per call, so a handler kept across renders never
 * dedupes against stale rows.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Channel } from '@cytale/domain';

import { findExistingDm, makeStartDm } from '../startDm.js';

function dm(id: string, recipientIds: string[]): Channel {
  return {
    id,
    workspace_id: null,
    name: '',
    type: 'dm',
    topic: null,
    position: 0,
    last_message_id: null,
    created_at: '2026-09-01T00:00:00Z',
    recipients: recipientIds.map((rid) => ({ id: rid, username: `u-${rid}` })),
  };
}

function workspace(id: string): Channel {
  return { ...dm(id, []), type: 'text', workspace_id: 'ws-1', name: 'general', recipients: null };
}

describe('findExistingDm', () => {
  const channels = {
    'ws-ch': workspace('ws-ch'),
    'd-alice': dm('d-alice', ['u-alice']),
    'd-multi': dm('d-multi', ['u-alice', 'u-carol']),
  };

  it('finds the viewer’s existing 1:1 DM with the member', () => {
    expect(findExistingDm(channels, 'u-alice')?.id).toBe('d-alice');
  });

  it('never matches a multi-recipient (group) DM for a 1:1 open', () => {
    expect(findExistingDm(channels, 'u-carol')).toBeNull();
  });

  it('returns null for workspace channels and unknown members', () => {
    expect(findExistingDm({ 'ws-ch': channels['ws-ch']! }, 'u-alice')).toBeNull();
    expect(findExistingDm(channels, 'u-nobody')).toBeNull();
  });
});

describe('makeStartDm — the dedup handler', () => {
  it('a NEW member calls the open-dm API exactly once and navigates to the returned channel', async () => {
    const created = dm('d-new', ['u-dave']);
    const openDm = vi.fn().mockResolvedValue(created);
    const onDmReady = vi.fn();
    const channels: Record<string, Channel> = {};
    const startDm = makeStartDm({
      channelsSnapshot: () => channels,
      openDm,
      onDmReady,
    });

    const result = await startDm('u-dave');

    expect(openDm).toHaveBeenCalledTimes(1);
    expect(openDm).toHaveBeenCalledWith('u-dave');
    expect(result.id).toBe('d-new');
    expect(onDmReady).toHaveBeenCalledWith(created);
  });

  it('an EXISTING thread navigates without touching the network', async () => {
    const existing = dm('d-alice', ['u-alice']);
    const openDm = vi.fn();
    const onDmReady = vi.fn();
    const startDm = makeStartDm({
      channelsSnapshot: () => ({ 'd-alice': existing }),
      openDm,
      onDmReady,
    });

    const result = await startDm('u-alice');

    expect(openDm).not.toHaveBeenCalled();
    expect(result.id).toBe('d-alice');
    expect(onDmReady).toHaveBeenCalledWith(existing);
  });

  it('selecting the same member twice → ONE API call, second navigation to the existing channel', async () => {
    const created = dm('d-new', ['u-dave']);
    const openDm = vi.fn().mockResolvedValue(created);
    const onDmReady = vi.fn();
    // The store the handler reads: empty first, hydrated by onDmReady after.
    const channels: Record<string, Channel> = {};
    const startDm = makeStartDm({
      channelsSnapshot: () => channels,
      openDm,
      onDmReady: (channel) => {
        channels[channel.id] = channel; // the parent's store write
        onDmReady(channel);
      },
    });

    await startDm('u-dave');
    const second = await startDm('u-dave');

    expect(openDm).toHaveBeenCalledTimes(1);
    expect(second.id).toBe('d-new');
    expect(onDmReady).toHaveBeenCalledTimes(2);
    expect(onDmReady).toHaveBeenLastCalledWith(created);
  });

  it('a stale snapshot never short-circuits: the store is read per call', async () => {
    const openDm = vi.fn().mockResolvedValue(dm('d-erin', ['u-erin']));
    const onDmReady = vi.fn();
    let channels: Record<string, Channel> = {};
    const startDm = makeStartDm({
      channelsSnapshot: () => channels,
      openDm,
      onDmReady: (channel) => {
        // The parent writes a NEW map (immutable store update).
        channels = { ...channels, [channel.id]: channel };
        onDmReady(channel);
      },
    });

    await startDm('u-erin');
    await startDm('u-erin');

    expect(openDm).toHaveBeenCalledTimes(1);
  });

  it('a refusal propagates — the picker retains the selection; onDmReady never fires', async () => {
    const openDm = vi.fn().mockRejectedValue(new Error('forbidden'));
    const onDmReady = vi.fn();
    const startDm = makeStartDm({
      channelsSnapshot: () => ({}),
      openDm,
      onDmReady,
    });

    await expect(startDm('u-alice')).rejects.toThrow('forbidden');
    expect(onDmReady).not.toHaveBeenCalled();
  });
});
