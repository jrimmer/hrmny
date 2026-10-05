/**
 * The default-channel gate — the cases that made selecting a DM on Home render
 * the dashboard, and the one that made the FIRST fix put a DM in a workspace's
 * pane. Both directions are pinned here.
 */
import { describe, expect, it } from 'vitest';

import { shouldDefaultChannel, type ChannelSelectionInput } from '../channelSelection.js';

const WORKSPACE_CHANNELS = ['100', '101'];

function input(overrides: Partial<ChannelSelectionInput> = {}): ChannelSelectionInput {
  return {
    activeChannelId: null,
    workspaceChannelIds: WORKSPACE_CHANNELS,
    hashPinned: null,
    homeActive: false,
    selectedType: undefined,
    ...overrides,
  };
}

describe('shouldDefaultChannel', () => {
  it('defaults when nothing is selected', () => {
    expect(shouldDefaultChannel(input())).toBe(true);
  });

  it('keeps a workspace channel the active workspace lists', () => {
    expect(shouldDefaultChannel(input({ activeChannelId: '101', selectedType: 'text' }))).toBe(false);
  });

  it('corrects a workspace channel the active workspace no longer lists', () => {
    // The real work this gate does: switching workspaces, or a channel that
    // was deleted or had access revoked.
    expect(shouldDefaultChannel(input({ activeChannelId: '999', selectedType: 'text' }))).toBe(true);
  });

  it('never corrects a hash-pinned channel (#114), whatever else is true', () => {
    expect(
      shouldDefaultChannel(
        input({ activeChannelId: '999', selectedType: 'text', hashPinned: '999' }),
      ),
    ).toBe(false);
  });

  it('keeps a DM selected while HOME owns the pane — even with a workspace still active', () => {
    // The reported defect: `activeWorkspaceId` is whatever workspace was last
    // open, so the DM is in no workspace list and the fallback replaced it.
    expect(
      shouldDefaultChannel(input({ activeChannelId: 'dm-1', selectedType: 'dm', homeActive: true })),
    ).toBe(false);
  });

  it('corrects that same DM once a WORKSPACE owns the pane', () => {
    // The first attempt at the fix exempted every DM, which left a DM sitting
    // in the workspace's pane after the member switched to a workspace.
    expect(
      shouldDefaultChannel(input({ activeChannelId: 'dm-1', selectedType: 'dm', homeActive: false })),
    ).toBe(true);
  });

  it('defaults a DM on Home when the store does not know the channel yet', () => {
    // An unknown id is not a DM the member selected; it is a stale address.
    expect(
      shouldDefaultChannel(input({ activeChannelId: 'gone', selectedType: undefined, homeActive: true })),
    ).toBe(true);
  });
});
