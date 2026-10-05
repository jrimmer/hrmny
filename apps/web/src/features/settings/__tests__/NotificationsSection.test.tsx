/**
 * notifications plan U10 — the settings surface.
 *
 * The surface exists to make the resolved state LEGIBLE, so the tests that
 * matter are the ones asserting what a member can read off it: every row names
 * its level AND the layer that decided it, and every delivery state renders as
 * itself rather than as a control that cannot work.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildNotificationTree,
  computeDeliveryState,
  describeChildren,
  describeDelivery,
  describeRow,
  describeTestResult,
  NotificationsSection,
  resolveFromOverrides,
  type NotificationRow,
} from '../NotificationsSection.js';

afterEach(() => {
  cleanup();
});

/**
 * A realistic tree: the account default, a workspace, and the workspace's
 * channels. The channels are what the surface must NOT render until the
 * workspace is opened (owner direction 2026-09-14: a tree that opens expanded
 * only moves the wall of rows behind a scrollbar).
 */
const ROWS: NotificationRow[] = [
  {
    id: 'account',
    label: 'Default for everything',
    level: 'mentions',
    decidedBy: 'account',
    overridden: false,
    scope: 'account',
  },
  {
    id: 'ws-1',
    label: 'Cytale',
    level: 'mentions',
    decidedBy: 'workspace',
    overridden: true,
    scope: 'workspace',
  },
  {
    id: 'ch-1',
    label: '#general',
    level: 'all',
    decidedBy: 'channel',
    overridden: true,
    scope: 'channel',
    parentId: 'ws-1',
  },
  {
    id: 'ch-2',
    label: '#noisy',
    level: 'all',
    decidedBy: 'participation',
    overridden: true,
    scope: 'channel',
    parentId: 'ws-1',
  },
];

function renderSection(overrides: Partial<React.ComponentProps<typeof NotificationsSection>> = {}) {
  const load = vi.fn().mockResolvedValue(ROWS);
  const setLevel = vi.fn().mockResolvedValue(undefined);

  render(
    <NotificationsSection
      load={load}
      setLevel={setLevel}
      permission="granted"
      deliverable
      {...overrides}
    />,
  );

  return { load, setLevel };
}

describe('states', () => {
  it('renders a loading state before the rows arrive', () => {
    renderSection({ load: () => new Promise(() => undefined) });
    expect(screen.getByTestId('notifications-loading')).toBeDefined();
  });

  it('renders the rows once loaded', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());
    expect(screen.getByTestId('notifications-row-account')).toBeDefined();
    expect(screen.getByTestId('notifications-row-ws-1')).toBeDefined();
  });

  it('renders an error with a retry that reloads', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(ROWS);
    renderSection({ load });

    await waitFor(() => expect(screen.getByTestId('notifications-error')).toBeDefined());

    await userEvent.click(screen.getByTestId('notifications-retry'));

    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('renders an empty state rather than a bare list', async () => {
    renderSection({ load: vi.fn().mockResolvedValue([]) });
    await waitFor(() => expect(screen.getByTestId('notifications-empty')).toBeDefined());
  });
});

describe('the tree — workspaces collapsed, channels nested', () => {
  it('hides a workspace’s channels until it is opened', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    // The whole point: a member's first look is a handful of workspaces, not
    // every channel in every one of them.
    expect(screen.queryByTestId('notifications-row-ch-1')).toBeNull();
    expect(screen.queryByTestId('notifications-row-ch-2')).toBeNull();

    await userEvent.click(screen.getByTestId('notifications-toggle-ws-1'));

    expect(await screen.findByTestId('notifications-row-ch-1')).toBeDefined();
    expect(screen.getByTestId('notifications-row-ch-2')).toBeDefined();
  });

  it('reports open/closed on the disclosure control', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    const toggle = screen.getByTestId('notifications-toggle-ws-1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The control's accessible name says what it does, not just what it is.
    expect(toggle.getAttribute('aria-label')).toContain('Cytale');

    await userEvent.click(toggle);
    expect(screen.getByTestId('notifications-toggle-ws-1').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows, while collapsed, how much is inside and how much is set', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    expect(screen.getByTestId('notifications-children-summary-ws-1').textContent).toBe(
      '2 channels · 2 set here',
    );
  });

  it('offers no disclosure on a row with no children', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    expect(screen.queryByTestId('notifications-toggle-account')).toBeNull();
  });

  it('a channel whose parent is missing is promoted rather than dropped', () => {
    // A row disappearing is indistinguishable from a setting that does not
    // exist — the failure this surface exists to remove.
    const orphan: NotificationRow = {
      id: 'ch-orphan',
      label: '#gone',
      level: 'mute',
      decidedBy: 'channel',
      overridden: true,
      scope: 'channel',
      parentId: 'ws-missing',
    };
    const tree = buildNotificationTree([...ROWS, orphan]);

    expect(tree.roots.map((r) => r.id)).toContain('ch-orphan');
    expect(tree.childrenByParent.get('ws-1')?.map((r) => r.id)).toEqual(['ch-1', 'ch-2']);
  });

  it('summarises children in both directions', () => {
    expect(describeChildren([])).toBe('0 channels · all following the workspace');
    expect(
      describeChildren([
        { ...ROWS[2]!, overridden: false },
        { ...ROWS[3]!, overridden: false },
      ]),
    ).toBe('2 channels · all following the workspace');
    expect(describeChildren([{ ...ROWS[2]!, overridden: true }])).toBe('1 channel · 1 set here');
  });
});

describe('legibility — the readout names its layer', () => {
  // This is the whole point of the surface: Discord never displays the
  // resolved outcome, which is how members end up with settings that cancel
  // each other invisibly.
  it('says an un-overridden row is inherited and from where', () => {
    expect(describeRow(ROWS[0]!)).toBe('Mentions only — inherited from your account default');
  });

  it('names the layer for an override', () => {
    expect(describeRow(ROWS[1]!)).toBe('Mentions only — this workspace');
    expect(describeRow(ROWS[2]!)).toBe('All messages — this channel');
  });

  // The answer to the question a member will actually ask.
  it('explains a participation-raised row as such', () => {
    expect(describeRow(ROWS[3]!)).toBe('All messages — because you posted here');
  });

  it('renders the resolved text for every row', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    // Nested rows render on expand, and carry the same readout as any other.
    await userEvent.click(screen.getByTestId('notifications-toggle-ws-1'));
    await waitFor(() => expect(screen.getByTestId('notifications-resolved-ch-2')).toBeDefined());

    expect(screen.getByTestId('notifications-resolved-ch-2').textContent).toContain(
      'because you posted here',
    );
  });
});

describe('changing a level', () => {
  it('sends the picked level and re-reads the rows', async () => {
    const { setLevel, load } = renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    await userEvent.click(screen.getByTestId('notifications-toggle-ws-1'));
    await screen.findByTestId('notifications-row-ch-1');
    await userEvent.click(screen.getByTestId('notifications-ch-1-mute'));

    await waitFor(() => expect(setLevel).toHaveBeenCalledWith('ch-1', 'mute'));
    // Re-read so the readout reflects what the server now resolves to, rather
    // than what this component hoped it set.
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('marks the current level as the checked radio', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    await userEvent.click(screen.getByTestId('notifications-toggle-ws-1'));
    await screen.findByTestId('notifications-row-ch-1');

    expect(screen.getByTestId('notifications-ch-1-all').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('notifications-ch-1-mute').getAttribute('aria-checked')).toBe('false');
  });

  // A failed save that renders as a success is the failure this surface
  // exists to prevent: the member walks away believing a level is set.
  it('surfaces a failed save on the row rather than looking saved', async () => {
    const setLevel = vi.fn().mockRejectedValue(new Error('nope'));
    renderSection({ setLevel });
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    await userEvent.click(screen.getByTestId('notifications-ws-1-mute'));

    await waitFor(() =>
      expect(screen.getByTestId('notifications-save-error-ws-1')).toBeDefined(),
    );
  });
});

// Notification controls (2026-09-27): the overview is live — every surface
// writes the one shared store, so a change made elsewhere must re-derive the
// rows — and a workspace row carries the "Suppress @everyone and @here" switch.
describe('live overview and the broadcast switch', () => {
  it('re-reads the rows when the subscription fires', async () => {
    let fire: () => void = () => undefined;
    const subscribe = vi.fn((onChange: () => void) => {
      fire = onChange;
      return () => undefined;
    });
    const muted: NotificationRow[] = ROWS.map((r) =>
      r.id === 'ws-1' ? { ...r, level: 'mute' as const } : r,
    );
    const load = vi.fn().mockResolvedValueOnce(ROWS).mockResolvedValue(muted);
    renderSection({ load, subscribe });
    await screen.findByTestId('notifications-list');
    expect(screen.getByTestId('notifications-ws-1-mentions').getAttribute('aria-checked')).toBe('true');

    fire();
    await waitFor(() =>
      expect(screen.getByTestId('notifications-ws-1-mute').getAttribute('aria-checked')).toBe('true'),
    );
    expect(subscribe).toHaveBeenCalled();
  });

  it('a workspace row offers the switch and writes it', async () => {
    const rows = ROWS.map((r) => (r.id === 'ws-1' ? { ...r, suppressBroadcasts: false } : r));
    const setSuppressBroadcasts = vi.fn().mockResolvedValue(undefined);
    renderSection({ load: vi.fn().mockResolvedValue(rows), setSuppressBroadcasts });
    const box = (await screen.findByTestId('notifications-suppress-checkbox-ws-1')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId('notifications-suppress-ws-1').textContent).toContain(
      'Suppress @everyone and @here',
    );
    await userEvent.click(box);
    expect(setSuppressBroadcasts).toHaveBeenCalledWith('ws-1', true);
  });

  it('a failed switch write surfaces on the row', async () => {
    const rows = ROWS.map((r) => (r.id === 'ws-1' ? { ...r, suppressBroadcasts: false } : r));
    const setSuppressBroadcasts = vi.fn().mockRejectedValue(new Error('offline'));
    renderSection({ load: vi.fn().mockResolvedValue(rows), setSuppressBroadcasts });
    await userEvent.click(await screen.findByTestId('notifications-suppress-checkbox-ws-1'));
    expect(await screen.findByTestId('notifications-save-error-ws-1')).toBeTruthy();
  });

  it('no switch is offered without a writer', async () => {
    const rows = ROWS.map((r) => (r.id === 'ws-1' ? { ...r, suppressBroadcasts: false } : r));
    renderSection({ load: vi.fn().mockResolvedValue(rows) });
    await screen.findByTestId('notifications-list');
    expect(screen.queryByTestId('notifications-suppress-ws-1')).toBeNull();
  });
});

describe('the self-test', () => {
  it('is not offered when no transport is wired', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    expect(screen.queryByTestId('notifications-send-test')).toBeNull();
  });

  it('sends, and reports the transport outcome', async () => {
    const onSendTest = vi.fn().mockResolvedValue({ targets: 2, sent: 2, outcomes: ['ok', 'ok'] });
    renderSection({ onSendTest });

    await userEvent.click(await screen.findByTestId('notifications-send-test'));

    await waitFor(() => expect(onSendTest).toHaveBeenCalledTimes(1));
    const result = await screen.findByTestId('notifications-test-result');
    expect(result.getAttribute('data-sent')).toBe('2');
    expect(result.textContent).toContain('2 of your 2 registered browsers');
  });

  // The three failures have three different fixes, so they read differently.
  it('names the no-target state as the thing to fix', () => {
    expect(describeTestResult({ targets: 0, sent: 0, outcomes: [], note: 'none' })).toContain(
      'no browsers registered',
    );
  });

  it('names an all-dead-registrations state as a re-register', () => {
    expect(
      describeTestResult({ targets: 2, sent: 0, outcomes: ['{:gone, 410}', '{:gone, 404}'] }),
    ).toContain('turn notifications off and on again');
  });

  it('names a transport failure as the instance, not the member', () => {
    const message = describeTestResult({
      targets: 1,
      sent: 0,
      outcomes: ['{:error, :nxdomain}'],
    });
    expect(message).toContain('push service');
    expect(message).not.toContain('turn notifications off and on');
  });

  it('surfaces a failed test rather than appearing to send', async () => {
    const onSendTest = vi.fn().mockRejectedValue(new Error('down'));
    renderSection({ onSendTest });

    await userEvent.click(await screen.findByTestId('notifications-send-test'));

    await waitFor(() => expect(screen.getByTestId('notifications-test-error')).toBeDefined());
  });
});

describe('delivery honesty', () => {
  it('reports enabled when the platform allows it and the member has', () => {
    expect(computeDeliveryState('granted', null, true)).toBe('enabled');
    expect(describeDelivery('enabled', null)).toBeNull();
  });

  // Permission is not a subscription. A member who allowed notifications and
  // then never turned them on — or turned them off on this device — holds no
  // subscription, and a box that read "on" for that browser was contradicted
  // by the test button sitting right below it (found live 2026-09-14).
  it('does not claim enabled on permission alone when no subscription exists', () => {
    expect(computeDeliveryState('granted', null, true, false)).toBe('granted-not-enabled');
    expect(describeDelivery('granted-not-enabled', null)).toContain('none registered');
  });

  it('still reports enabled once a subscription is known to exist', () => {
    expect(computeDeliveryState('granted', null, true, true)).toBe('enabled');
  });

  // `undefined` = the host did not probe; behaviour must not change for it.
  it('keeps the permission-only reading when the subscription is unknown', () => {
    expect(computeDeliveryState('granted', null, true, undefined)).toBe('enabled');
  });

  it('reports needs-permission for an undecided prompt', () => {
    expect(computeDeliveryState('default', null, true)).toBe('needs-permission');
    expect(describeDelivery('needs-permission', null)).toContain('has not allowed');
  });

  it('reports browser-blocked for a refused permission (a way out exists)', () => {
    expect(computeDeliveryState('denied', null, true)).toBe('browser-blocked');
  });

  // Telling someone to grant a permission that cannot help them is worse than
  // telling them the real reason, so a platform block outranks the permission.
  it('a platform blocker outranks a grantable permission', () => {
    expect(computeDeliveryState('default', 'ios_install', true)).toBe('blocked');
    expect(describeDelivery('blocked', 'ios_install')).toContain('home screen');
  });

  it('explains the iOS version floor', () => {
    expect(describeDelivery('blocked', 'ios_update')).toContain('16.4');
  });

  it('explains an insecure origin', () => {
    expect(describeDelivery('blocked', 'insecure')).toContain('HTTPS');
  });

  it('renders the delivery state on the surface', async () => {
    renderSection({ permission: 'default', blocker: null, deliverable: true });

    await waitFor(() =>
      expect(screen.getByTestId('notifications-delivery-state').getAttribute('data-state')).toBe(
        'needs-permission',
      ),
    );
  });

  it('renders a blocked platform with its reason', async () => {
    renderSection({ permission: 'default', blocker: 'ios_install', deliverable: true });

    await waitFor(() =>
      expect(screen.getByTestId('notifications-delivery-state').getAttribute('data-state')).toBe('blocked'),
    );
    expect(screen.getByTestId('notifications-delivery-state').textContent).toContain('home screen');
  });
});

describe('resolveFromOverrides — the same walk the server runs', () => {
  const O = (scope: string, id: string, level: 'all' | 'mentions' | 'mute') => ({
    [`${scope}:${id}`]: level,
  });

  it('an unconfigured member gets the default, attributed to the account layer', () => {
    expect(resolveFromOverrides({ overrides: {} })).toEqual({
      level: 'mentions',
      decidedBy: 'account',
      overridden: false,
    });
  });

  it('a channel override wins over a workspace one', () => {
    const resolved = resolveFromOverrides({
      overrides: { ...O('workspace', 'w', 'mute'), ...O('channel', 'c', 'all') },
      workspaceId: 'w',
      channelId: 'c',
    });
    expect(resolved).toMatchObject({ level: 'all', decidedBy: 'channel', overridden: true });
  });

  // An absent layer is SKIPPED, not terminating — a member with only a
  // workspace setting must still be decided by it.
  it('skips an absent layer rather than stopping the walk', () => {
    const resolved = resolveFromOverrides({
      overrides: O('workspace', 'w', 'all'),
      workspaceId: 'w',
      channelId: 'unset',
    });
    expect(resolved).toMatchObject({ level: 'all', decidedBy: 'workspace' });
  });

  it('a thread with no override inherits its channel', () => {
    const resolved = resolveFromOverrides({
      overrides: O('channel', 'c', 'mute'),
      channelId: 'c',
      threadId: 't',
    });
    expect(resolved).toMatchObject({ level: 'mute', decidedBy: 'channel' });
  });

  it('a thread override wins over its channel', () => {
    const resolved = resolveFromOverrides({
      overrides: { ...O('channel', 'c', 'mute'), ...O('thread', 't', 'all') },
      channelId: 'c',
      threadId: 't',
    });
    expect(resolved).toMatchObject({ level: 'all', decidedBy: 'thread' });
  });

  // The client must show the SAME lift the server applies, or a member who
  // muted a channel they posted in would be told they will hear nothing while
  // notifications arrive — the readout contradicting reality, which is the
  // one thing this surface exists to prevent.
  it('lifts a mute to all when the member has participated', () => {
    const resolved = resolveFromOverrides({
      overrides: O('channel', 'c', 'mute'),
      channelId: 'c',
      participated: true,
    });
    expect(resolved).toMatchObject({ level: 'all', decidedBy: 'participation' });
  });

  it('does not lift a mute the member did not participate through', () => {
    const resolved = resolveFromOverrides({
      overrides: O('channel', 'c', 'mute'),
      channelId: 'c',
      participated: false,
    });
    expect(resolved).toMatchObject({ level: 'mute', decidedBy: 'channel' });
  });
});

describe('NotificationsSection — a11y', () => {
  it('has no accessibility violations', async () => {
    renderSection({ permission: 'granted', deliverable: true });
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    expect(await axe(screen.getByTestId('settings-notifications'))).toHaveNoViolations();
  });

  it('has no violations in the blocked-delivery state either', async () => {
    renderSection({ permission: 'default', blocker: 'ios_install', deliverable: true });
    await waitFor(() => expect(screen.getByTestId('notifications-list')).toBeDefined());

    expect(await axe(screen.getByTestId('settings-notifications'))).toHaveNoViolations();
  });
});

describe('the enable / disable action', () => {
  // One control for one on/off state. A button PAIR read as two competing
  // actions rather than a switch (owner report 2026-09-15).
  it('renders an unchecked checkbox when the browser has not been asked', async () => {
    renderSection({ permission: 'default', deliverable: true, onEnable: vi.fn() });

    const box = await screen.findByTestId<HTMLInputElement>('notifications-browser-checkbox');
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
  });

  it('renders a checked checkbox once delivery is on', async () => {
    renderSection({ permission: 'granted', deliverable: true, onDisable: vi.fn() });

    const box = await screen.findByTestId<HTMLInputElement>('notifications-browser-checkbox');
    expect(box.checked).toBe(true);
  });

  it('checking it calls the enable action', async () => {
    const onEnable = vi.fn().mockResolvedValue(undefined);
    renderSection({ permission: 'default', deliverable: true, onEnable });

    await userEvent.click(await screen.findByTestId('notifications-browser-checkbox'));

    await waitFor(() => expect(onEnable).toHaveBeenCalledTimes(1));
  });

  it('unchecking it calls the disable action', async () => {
    const onDisable = vi.fn().mockResolvedValue(undefined);
    renderSection({ permission: 'granted', deliverable: true, onDisable });

    await userEvent.click(await screen.findByTestId('notifications-browser-checkbox'));

    await waitFor(() => expect(onDisable).toHaveBeenCalledTimes(1));
  });

  // Disabled rather than hidden: a control that vanishes leaves the member
  // wondering what changed.
  it('is disabled, not hidden, when the browser blocks notifications', async () => {
    renderSection({ permission: 'denied', deliverable: true, onEnable: vi.fn() });

    const box = await screen.findByTestId<HTMLInputElement>('notifications-browser-checkbox');
    expect(box.disabled).toBe(true);
  });

  // A member who believes notifications are on and is never told anything is
  // the failure this surface exists to prevent, so a failed toggle must show.
  it('surfaces a failed enable rather than appearing to succeed', async () => {
    const onEnable = vi.fn().mockRejectedValue(new Error('nope'));
    renderSection({ permission: 'default', deliverable: true, onEnable });

    await userEvent.click(await screen.findByTestId('notifications-browser-checkbox'));

    await waitFor(() => expect(screen.getByTestId('notifications-toggle-error')).toBeDefined());
  });

  it('offers no action when the platform is blocked', async () => {
    renderSection({
      permission: 'default',
      blocker: 'ios_install',
      deliverable: true,
      onEnable: vi.fn(),
    });

    await waitFor(() => expect(screen.getByTestId('notifications-delivery-state')).toBeDefined());
    const box = screen.getByTestId<HTMLInputElement>('notifications-browser-checkbox');
    expect(box.disabled).toBe(true);
  });
});

describe('browser-blocked — the way back from a Block', () => {
  // A member who chose "Block" in the browser dialog has NO in-app control,
  // because the permission can only be changed in the browser's own settings.
  // Showing nothing leaves them with no idea a way out exists.
  it('explains the browser-settings route rather than showing nothing', () => {
    expect(computeDeliveryState('denied', null, true)).toBe('browser-blocked');

    const note = describeDelivery('browser-blocked', null);
    expect(note).toContain('browser');
    expect(note).toContain('Allow');
  });

  it('renders that explanation on the surface', async () => {
    renderSection({ permission: 'denied', deliverable: true });

    await waitFor(() =>
      expect(screen.getByTestId('notifications-delivery-state').getAttribute('data-state')).toBe(
        'browser-blocked',
      ),
    );
    expect(screen.getByTestId('notifications-delivery-state').textContent).toContain('Allow');
  });

  // Deliberately NO enable button here: it could not work, and offering it
  // would be the dead control the no-dead-controls rule forbids.
  it('offers no enable button while the browser is blocking', async () => {
    renderSection({ permission: 'denied', deliverable: true, onEnable: vi.fn() });

    await waitFor(() => expect(screen.getByTestId('notifications-delivery-state')).toBeDefined());
    const box = screen.getByTestId<HTMLInputElement>('notifications-browser-checkbox');
    expect(box.disabled).toBe(true);
  });

  it('offers a way to see the in-app invitation again', async () => {
    const onRestorePrompt = vi.fn();
    renderSection({ permission: 'denied', deliverable: true, onRestorePrompt });

    await waitFor(() => expect(screen.getByTestId('notifications-restore-prompt')).toBeDefined());
    await userEvent.click(screen.getByTestId('notifications-restore-prompt'));

    expect(onRestorePrompt).toHaveBeenCalledTimes(1);
  });
});
