/**
 * resolveTopbarCallAccess / resolveMobileTitle / resolveMobileTitleSigil —
 * the topbar model's pure gate, table-tested per code-review finding #8:
 * owner, plain member, non-member, DM, Home, null-workspace, and
 * unknown-channel branches were previously proven only for the e2e owner
 * path.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveMobileTitle,
  resolveMobileTitleSigil,
  resolveTopbarCallAccess,
  type TopbarCallAccessInput,
} from '../useChannelCallGate.js';

function accessInput(overrides: Partial<TopbarCallAccessInput> = {}): TopbarCallAccessInput {
  return {
    homeActive: false,
    selfId: 'u1',
    activeChannel: { workspace_id: 'ws1', type: 'channel' },
    workspaces: { ws1: { owner_id: 'u1' } },
    memberIdsByWorkspace: { ws1: ['u1', 'u2'] },
    ...overrides,
  };
}

describe('resolveTopbarCallAccess — the topbar call gate (U7 review #8)', () => {
  it.each([
    ['owner of the workspace', accessInput(), true],
    [
      'plain member (not owner)',
      accessInput({ workspaces: { ws1: { owner_id: 'u9' } } }),
      true,
    ],
    [
      'non-member of the workspace',
      accessInput({
        workspaces: { ws1: { owner_id: 'u9' } },
        memberIdsByWorkspace: { ws1: ['u2'] },
      }),
      false,
    ],
    ['DM channel (excluded regardless of membership)', accessInput({ activeChannel: { workspace_id: 'ws1', type: 'dm' } }), false],
    ['Home active', accessInput({ homeActive: true }), false],
    [
      'null workspace_id (no real workspace)',
      accessInput({ activeChannel: { workspace_id: null, type: 'channel' } }),
      false,
    ],
    ['unknown channel (undefined)', accessInput({ activeChannel: undefined }), false],
    [
      'unknown workspace (channel references missing ws)',
      accessInput({ workspaces: {}, memberIdsByWorkspace: {} }),
      false,
    ],
    ['null selfId', accessInput({ selfId: null }), false],
  ])('%s -> %s', (_name, input, expected) => {
    expect(resolveTopbarCallAccess(input)).toBe(expected);
  });
});

describe('resolveMobileTitle — the topbar title chain (U7 review #8)', () => {
  const base = {
    activeDm: null,
    dmPeerName: null,
    homeActive: false,
    activeChannelId: 'c1',
    channels: { c1: { name: 'general' } } as Record<string, { name: string } | undefined>,
    activeWorkspaceId: 'ws1',
    workspaces: { ws1: { name: 'Playground' } } as Record<string, { name: string } | undefined>,
  };

  it('DM peer name wins, falling back to Home when unnamed', () => {
    expect(resolveMobileTitle({ ...base, activeDm: { id: 'd1' }, dmPeerName: 'sam' })).toBe('sam');
    expect(resolveMobileTitle({ ...base, activeDm: { id: 'd1' }, dmPeerName: null })).toBe('Home');
  });

  it('Home wins over any channel', () => {
    expect(resolveMobileTitle({ ...base, homeActive: true })).toBe('Home');
  });

  it('a takeover surface (settings, release notes) names itself over the channel beneath', () => {
    expect(resolveMobileTitle({ ...base, takeoverTitle: 'Settings' })).toBe('Settings');
    expect(resolveMobileTitle({ ...base, homeActive: true, takeoverTitle: 'Release notes' })).toBe(
      'Release notes',
    );
    expect(resolveMobileTitle({ ...base, takeoverTitle: null })).toBe('general');
  });

  it('channel name, then workspace name, then Home', () => {
    expect(resolveMobileTitle(base)).toBe('general');
    expect(
      resolveMobileTitle({ ...base, activeChannelId: 'c404' }),
    ).toBe('Playground');
    expect(
      resolveMobileTitle({ ...base, activeChannelId: 'c404', activeWorkspaceId: 'ws404' }),
    ).toBe('Home');
  });
});

describe('resolveMobileTitleSigil — the title sigil (2026-09-18 topbar rework)', () => {
  const base = {
    activeDm: null,
    dmPeerName: null,
    homeActive: false,
    activeChannelId: 'c1',
    channels: { c1: { name: 'general' } } as Record<string, { name: string } | undefined>,
    activeWorkspaceId: 'ws1',
    workspaces: { ws1: { name: 'Playground' } } as Record<string, { name: string } | undefined>,
  };

  it('named DM reads @, unnamed DM falls back to Home with no sigil', () => {
    expect(resolveMobileTitleSigil({ ...base, activeDm: { id: 'd1' }, dmPeerName: 'sam' })).toBe('@');
    expect(resolveMobileTitleSigil({ ...base, activeDm: { id: 'd1' }, dmPeerName: null })).toBeNull();
  });

  it('a takeover surface carries no sigil — it is not the channel', () => {
    expect(resolveMobileTitleSigil({ ...base, takeoverTitle: 'Settings' })).toBeNull();
    expect(resolveMobileTitleSigil(base)).toBe('#');
  });

  it('Home carries no sigil', () => {
    expect(resolveMobileTitleSigil({ ...base, homeActive: true })).toBeNull();
  });

  it('a resolved channel reads #; the workspace-name/Home fallbacks do not', () => {
    expect(resolveMobileTitleSigil(base)).toBe('#');
    expect(resolveMobileTitleSigil({ ...base, activeChannelId: 'c404' })).toBeNull();
    expect(
      resolveMobileTitleSigil({ ...base, activeChannelId: 'c404', activeWorkspaceId: 'ws404' }),
    ).toBeNull();
  });
});
