/**
 * @cytale/web — CallSlot tests (calls plan U7).
 *
 * States-first coverage per the plan's test scenarios:
 *   happy path — a live call renders exactly one slot under its owning
 *     channel (sidebar integration), click fires the join intent (or
 *     return-to-call when already joined), the channel row shows the live
 *     badge, and the header phone affordance flips Start→Join (in
 *     MessagePane.test.tsx).
 *   edge — call ends while visible → slot disappears with no dead row;
 *     30-participant roster renders a count, not 30 avatars.
 *   error — partial roster data (SYNC in flight) renders placeholder
 *     avatars, not a crash.
 *   integration — axe zero violations (desktop + sidebar) and keyboard nav
 *     reaches and activates the slot.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Channel, Workspace } from '@cytale/domain';
import type { CallParticipantState, LiveCall } from '@cytale/state';

import { ChannelSidebar } from '../../channels/ChannelSidebar.js';
import type { SidebarStore } from '../../channels/useSidebarProjection.js';

import { CallSlot } from '../CallSlot.js';
import { setCallEngineForTests, type CallEngine } from '../useCallMedia.js';

/** An engine fake whose join intent is observable (U8: the seam is real). */
function fakeEngine(): CallEngine & { join: ReturnType<typeof vi.fn> } {
  const listeners = new Set<() => void>();
  const snapshot = {
    voice: { status: 'idle', pcConnected: false, micGranted: false, notice: null },
    channelId: null,
    muted: false,
    deafened: false,
  };
  const speaking = new Set<string>(); // identity-stable (uSES contract)
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => snapshot,
    speakingSubscribe: () => () => undefined,
    getSpeaking: () => speaking,
    start: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    toggleMute: vi.fn(),
    toggleDeafen: vi.fn(),
    ring: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
    pollConnectionState: vi.fn(),
    destroy: vi.fn(),
  } as never;
}

// -- fixtures -----------------------------------------------------------------

function participant(id: string): CallParticipantState {
  return { user_id: id, mute: false, deafen: false, leg: null };
}

function roster(...ids: string[]): CallParticipantState[] {
  return ids.map(participant);
}

function liveCall(participants: CallParticipantState[]): LiveCall {
  return {
    call_id: '5000000000000001',
    thread_id: null,
    started_by: participants[0]?.user_id ?? null,
    started_at: '2026-09-06T12:00:00Z',
    participants: Object.fromEntries(participants.map((p) => [p.user_id, p])),
  };
}

function ws(id: string, name: string): Workspace {
  return {
    id,
    name,
    icon_url: null,
    description: null,
    owner_id: '1',
    role_version: 0,
    created_at: '2026-08-30T00:00:00Z',
  };
}

function ch(id: string, name: string, position: number): Channel {
  return {
    id,
    workspace_id: 'ws-1',
    recipients: null,
    name,
    type: 'text',
    topic: null,
    position,
    last_message_id: null,
    created_at: '2026-08-30T00:00:00Z',
  };
}

function makeSidebarStore(overrides: Partial<SidebarStore> = {}): SidebarStore {
  return {
    workspaces: { 'ws-1': ws('ws-1', 'Alpha') },
    channels: {
      'c-1': ch('c-1', 'general', 0),
      'c-2': ch('c-2', 'random', 1),
    },
    unreadByChannel: {},
    channelIdsByWorkspace: { 'ws-1': ['c-1', 'c-2'] },
    memberIdsByWorkspace: { 'ws-1': ['u-1'] },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Standalone renders wrap in the CategoryGroup's list context (the slot is
 *  a listitem under its channel row in the real sidebar — axe checks that). */
function renderSlot(props: Parameters<typeof CallSlot>[0]) {
  return render(
    <ul>
      <CallSlot {...props} />
    </ul>,
  );
}

// -- CallSlot: roster states (states-first DoD) --------------------------------

describe('CallSlot — roster states', () => {
  it('renders one avatar per participant for a full roster with the participant aria-label', () => {
    renderSlot({ channelId: 'c-1', roster: roster('9001', '9002', '9003') });

    const slot = screen.getByTestId('call-slot-c-1');
    expect(slot.getAttribute('aria-label')).toBe('Call — 3 participants');
    // Plan 7.7: the row's phone is now the shared `PhoneIcon` at this site's
    // 14px + `.call-slot-icon`; pin both so the unification is not a restyle.
    const phone = slot.querySelector('svg')!;
    expect(phone.getAttribute('width')).toBe('14');
    expect(phone.getAttribute('height')).toBe('14');
    expect(phone.getAttribute('class')).toBe('call-slot-icon');
    expect(screen.getAllByTestId('call-slot-avatar')).toHaveLength(3);
    // Small roster: no count pill.
    expect(screen.queryByTestId('call-slot-count-c-1')).toBeNull();
  });

  it('renders placeholder avatars (not a crash) while the roster syncs', () => {
    renderSlot({ channelId: 'c-1', roster: [] });

    const slot = screen.getByTestId('call-slot-c-1');
    // SYNC in flight: the call is known live, the roster is not — the row
    // stays visible with placeholders and an honest label.
    expect(slot.getAttribute('data-syncing')).toBe('true');
    expect(screen.getAllByTestId('call-slot-placeholder')).toHaveLength(2);
    expect(screen.queryByTestId('call-slot-avatar')).toBeNull();
    expect(slot.getAttribute('aria-label')).toBe('Call');
  });

  it('renders a count instead of an avatar wall for a 30-participant roster', () => {
    const bigRoster = roster(
      ...Array.from({ length: 30 }, (_, i) => `900${String(i).padStart(2, '0')}`),
    );
    renderSlot({ channelId: 'c-1', roster: bigRoster });

    expect(screen.getAllByTestId('call-slot-avatar')).toHaveLength(5);
    expect(screen.getByTestId('call-slot-count-c-1').textContent).toBe('30');
    expect(screen.getByTestId('call-slot-c-1').getAttribute('aria-label')).toBe(
      'Call — 30 participants',
    );
  });

  it('highlights the speaking roster member when fed speaking ids (U8 seam)', () => {
    renderSlot({
      channelId: 'c-1',
      roster: roster('9001', '9002'),
      speakingUserIds: new Set(['9002']),
    });

    const avatars = screen.getAllByTestId('call-slot-avatar');
    expect(avatars[0]!.getAttribute('data-speaking')).toBeNull();
    expect(avatars[1]!.getAttribute('data-speaking')).toBe('true');
  });

  it('marks the slot as joined and switches the label to return-to-call (AM18)', () => {
    renderSlot({ channelId: 'c-1', roster: roster('9001', '9002'), joined: true });

    const slot = screen.getByTestId('call-slot-c-1');
    expect(slot.getAttribute('data-joined')).toBe('true');
    expect(slot.getAttribute('aria-label')).toBe('Return to call — 2 participants');
  });

  it('click fires the join intent through onJoin', async () => {
    const onJoin = vi.fn();
    renderSlot({ channelId: 'c-1', roster: roster('9001'), onJoin });

    await userEvent.click(screen.getByTestId('call-slot-c-1'));
    expect(onJoin).toHaveBeenCalledWith('c-1');
  });
});

// -- CallSlot: keyboard + accessibility ----------------------------------------

describe('CallSlot — keyboard + accessibility', () => {
  it('is keyboard-operable: Tab reaches the slot and Enter activates it', async () => {
    const onJoin = vi.fn();
    renderSlot({ channelId: 'c-1', roster: roster('9001', '9002'), onJoin });

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId('call-slot-c-1'));

    await userEvent.keyboard('{Enter}');
    expect(onJoin).toHaveBeenCalledWith('c-1');
  });

  it('has no axe violations with a full roster', async () => {
    const { container } = renderSlot({
      channelId: 'c-1',
      roster: roster('9001', '9002', '9003'),
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the syncing (partial roster) and large-roster states', async () => {
    const syncing = renderSlot({ channelId: 'c-1', roster: [] });
    expect(await axe(syncing.container)).toHaveNoViolations();

    const big = renderSlot({
      channelId: 'c-2',
      roster: roster(...Array.from({ length: 30 }, (_, i) => `900${i}`)),
    });
    expect(await axe(big.container)).toHaveNoViolations();
  });
});

// -- Sidebar integration (R3: slot + live badge, nothing when idle) ------------

describe('ChannelSidebar — call slot integration', () => {
  function renderSidebarWithCall(call: LiveCall | undefined, joinedUserId?: string) {
    return render(
      <ChannelSidebar
        store={makeSidebarStore({
          callByChannel: call ? { 'c-1': call } : {},
          currentUser: joinedUserId ? { id: joinedUserId, username: 'me' } : null,
        })}
        activeWorkspaceId="ws-1"
        activeChannelId={null}
      />,
    );
  }

  it('renders exactly one slot under its owning channel and a live badge on the channel row', () => {
    renderSidebarWithCall(liveCall(roster('9001', '9002', '9003')));

    // One slot, under c-1 (the call's channel) — not under c-2.
    expect(screen.getByTestId('call-slot-c-1')).toBeTruthy();
    expect(screen.queryByTestId('call-slot-c-2')).toBeNull();

    // DOM order: the slot row follows its owning channel row inside the
    // category group's list.
    const channelRow = screen.getByTestId('channel-c-1').closest('li')!;
    const slotRow = screen.getByTestId('call-slot-c-1').closest('li')!;
    expect(slotRow.previousElementSibling).toBe(channelRow);
    expect(slotRow.parentElement).toBe(channelRow.parentElement);

    // R3 live badge on the channel row itself.
    expect(screen.getByTestId('channel-c-1').getAttribute('data-live')).toBe('true');
    expect(screen.getByTestId('live-c-1')).toBeTruthy();
    expect(screen.getByTestId('channel-c-2').getAttribute('data-live')).toBeNull();
  });

  it('renders no slot and no badge when no call is live', () => {
    renderSidebarWithCall(undefined);

    expect(screen.queryByTestId('call-slot-c-1')).toBeNull();
    expect(screen.queryByTestId('live-c-1')).toBeNull();
  });

  it('removes the slot with no dead row when the call ends while visible', () => {
    const call = liveCall(roster('9001'));
    const { rerender } = renderSidebarWithCall(call);

    expect(screen.getByTestId('call-slot-c-1')).toBeTruthy();

    // CALL_END: rerender with the same store shape minus the live call.
    rerender(
      <ChannelSidebar
        store={makeSidebarStore({ callByChannel: {}, currentUser: null })}
        activeWorkspaceId="ws-1"
        activeChannelId={null}
      />,
    );

    expect(screen.queryByTestId('call-slot-c-1')).toBeNull();
    expect(screen.queryByTestId('call-slot-placeholder')).toBeNull();
    expect(screen.queryByTestId('live-c-1')).toBeNull();
    // The channel row itself survives untouched.
    expect(screen.getByTestId('channel-c-1')).toBeTruthy();
  });

  it('marks the slot joined when the viewer holds a voice leg', () => {
    renderSidebarWithCall(liveCall(roster('9001', '9002')), '9002');

    const slot = screen.getByTestId('call-slot-c-1');
    expect(slot.getAttribute('data-joined')).toBe('true');
    expect(slot.getAttribute('aria-label')).toBe('Return to call — 2 participants');
  });

  it('routes the slot click through the useCall seam into the call engine (U8)', async () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    try {
      renderSidebarWithCall(liveCall(roster('9001')));

      await userEvent.click(screen.getByTestId('call-slot-c-1'));

      // U8: the seam drives the real engine (op-22 join + media), and the
      // engine's join covers AM18's return-vs-join distinction.
      expect(engine.join).toHaveBeenCalledWith('c-1');
    } finally {
      setCallEngineForTests(null);
    }
  });

  it('is keyboard-reachable inside the sidebar and activates with Enter', async () => {
    const engine = fakeEngine();
    setCallEngineForTests(engine);
    try {
      renderSidebarWithCall(liveCall(roster('9001', '9002')));

      // Tab through the sidebar until the slot button has focus.
      for (
        let i = 0;
        i < 12 && document.activeElement !== screen.getByTestId('call-slot-c-1');
        i++
      ) {
        await userEvent.tab();
      }
      expect(document.activeElement).toBe(screen.getByTestId('call-slot-c-1'));

      await userEvent.keyboard('{Enter}');
      expect(engine.join).toHaveBeenCalledWith('c-1');
    } finally {
      setCallEngineForTests(null);
    }
  });

  it('has no axe violations with a live call slot (desktop sidebar)', async () => {
    const { container } = renderSidebarWithCall(liveCall(roster('9001', '9002', '9003')));
    expect(await axe(container)).toHaveNoViolations();
  });
});
