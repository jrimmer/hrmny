/**
 * Tier 3 (B) finding 9b — Invite People is offered only to a viewer holding
 * CREATE_INVITES (the server's gate since Tier 1), and a 403 in the dialog
 * says so plainly.
 */
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';
import { PERMISSIONS } from '@cytale/domain';

import { InvitePeopleDialog } from '../InvitePeopleDialog';
import { canCreateInvitesFrom, useCanCreateInvites } from '../useCanCreateInvites';

afterEach(cleanup);

const bits = (...names: Array<keyof typeof PERMISSIONS>) =>
  names.reduce((acc, n) => acc | PERMISSIONS[n], 0n).toString(10);

describe('canCreateInvitesFrom', () => {
  it('the owner always may, whatever the bits say', () => {
    expect(canCreateInvitesFrom({ selfId: '1', ownerId: '1', permissions: null })).toBe(true);
    expect(canCreateInvitesFrom({ selfId: '1', ownerId: '1', permissions: '0' })).toBe(true);
  });

  it('a member needs CREATE_INVITES (or ADMINISTRATOR)', () => {
    const base = { selfId: '2', ownerId: '1' };
    expect(canCreateInvitesFrom({ ...base, permissions: bits('VIEW_CHANNEL', 'SEND_MESSAGES') })).toBe(false);
    expect(canCreateInvitesFrom({ ...base, permissions: bits('CREATE_INVITES') })).toBe(true);
    expect(canCreateInvitesFrom({ ...base, permissions: bits('ADMINISTRATOR') })).toBe(true);
  });

  it('unknown bits are unknown, not a denial', () => {
    const base = { selfId: '2', ownerId: '1' };
    expect(canCreateInvitesFrom({ ...base, permissions: null })).toBeNull();
    expect(canCreateInvitesFrom({ ...base, permissions: 'garbage' })).toBeNull();
  });
});

describe('useCanCreateInvites', () => {
  it('fetches the viewer bits for a non-owner and answers from them', async () => {
    const fetchPermissions = vi.fn(async () => bits('VIEW_CHANNEL'));
    const { result } = renderHook(() => useCanCreateInvites('ws1', '2', '1', fetchPermissions));

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false));
    expect(fetchPermissions).toHaveBeenCalledWith('ws1');
  });

  it('never fetches for the owner', () => {
    const fetchPermissions = vi.fn(async () => '0');
    const { result } = renderHook(() => useCanCreateInvites('ws1', '1', '1', fetchPermissions));
    expect(result.current).toBe(true);
    expect(fetchPermissions).not.toHaveBeenCalled();
  });

  it('a failed read stays unknown (the dialog still answers)', async () => {
    const fetchPermissions = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result } = renderHook(() => useCanCreateInvites('ws1', '2', '1', fetchPermissions));
    await waitFor(() => expect(fetchPermissions).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});

describe('InvitePeopleDialog — the 403', () => {
  it('shows a clear permission message when the server refuses', async () => {
    const onCreateInvite = vi.fn(async () => {
      throw new ApiError({ status: 403, key: 'forbidden', code: 40003, message: 'You do not have permission to create invites.' });
    });

    render(<InvitePeopleDialog open onOpenChange={() => {}} onCreateInvite={onCreateInvite} />);
    await userEvent.click(screen.getByTestId('invite-generate'));

    const alert = await screen.findByTestId('invite-error');
    expect(alert.textContent).toMatch(/don't have permission to create invites/i);
    expect(alert.textContent).toMatch(/Ask a workspace admin/i);
  });
});
