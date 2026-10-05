/**
 * WebhooksSection — the owner-scoped webhook surface (plan 2026-09-15-1200, U3).
 *
 * It replaced the rail's channel-scoped pane, so what these pin is the SCOPE
 * CHANGE, not just the rendering: the list is the caller's own webhooks from
 * ONE read (`GET /users/@me/webhooks`), the URL is theirs to copy, and a rename
 * or revoke addresses the OWNER route `/webhooks/:id` rather than the
 * destination's `/channels/:id/webhooks/:hook` — which is the difference that
 * lets a creator manage a webhook after losing `manage_channels` on the channel
 * it posts into.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyWebhook } from '../api.js';
import { createFetchRouter, type FetchRouter } from './helpers.js';

import { WebhooksSection, describeDestination } from '../WebhooksSection.js';

const MINE = '/api/v1/users/@me/webhooks';
const HOOK_PATH = '/api/v1/webhooks/9200';
const CHANNELS = [
  { id: '300', name: 'general' },
  { id: '301', name: 'random' },
];
const WORKSPACES = [{ id: '900', name: 'Cytale' }];

/** A hook the caller owns, with its destination already named by the server. */
const HOOK: MyWebhook = {
  id: '9200',
  name: 'Deploy bot',
  channel_id: '300',
  created_at: '2026-09-01T00:00:00Z',
  url: 'https://api.test/api/webhooks/9200/tok',
  destination: {
    channel_id: '300',
    channel_name: 'general',
    workspace_id: '900',
    workspace_name: 'Cytale',
  },
};

let io: FetchRouter;

function serve(rows: MyWebhook[] = [HOOK]) {
  io.on('GET', MINE, () => Response.json({ webhooks: rows }));
}

function renderSection(props: Record<string, unknown> = {}) {
  return render(
    <WebhooksSection
      workspaces={WORKSPACES}
      activeWorkspaceId="900"
      channels={CHANNELS}
      loadChannels={async () => [...CHANNELS]}
      online
      {...props}
    />,
  );
}

beforeEach(() => {
  io = createFetchRouter();
  vi.stubGlobal('fetch', io.fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the owner-scoped list', () => {
  it('reads the caller’s OWN webhooks — one request, not a fan-out', async () => {
    serve();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('webhooks-list')).toBeDefined());

    // The scope change in one assertion: the owner read is called, and no
    // channel-scoped read is used at all (the pane fanned out across every
    // channel of the workspace to assemble the same list).
    expect(io.recorded(MINE)).toHaveLength(1);
    expect(screen.getByTestId('webhook-row-9200').textContent).toContain('Deploy bot');
    expect(
      screen.getByTestId<HTMLInputElement>('webhook-url-9200').value,
    ).toContain('/api/webhooks/9200/tok');
  });

  it('names the destination so the row reads without a workspace id', async () => {
    serve();
    renderSection();
    await waitFor(() => expect(screen.getByTestId('webhooks-list')).toBeDefined());

    expect(screen.getByTestId('webhook-destination-9200').textContent).toBe('#general · Cytale');
  });

  it('names a missing destination rather than rendering a blank', () => {
    expect(describeDestination({ ...HOOK, destination: null })).toBe('Destination unavailable');
    expect(
      describeDestination({
        ...HOOK,
        destination: {
          channel_id: '300',
          channel_name: 'general',
          workspace_id: null,
          workspace_name: null,
        },
      }),
    ).toBe('#general');
  });
});

describe('states', () => {
  it('renders a loading state before the list arrives', () => {
    io.on('GET', MINE, () => new Promise<Response>(() => undefined));
    renderSection();
    expect(screen.getByTestId('webhooks-loading')).toBeDefined();
  });

  it('renders an error with a retry that recovers', async () => {
    let calls = 0;
    io.on('GET', MINE, () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: { key: 'boom', message: 'down' } }, { status: 500 })
        : Response.json({ webhooks: [HOOK] });
    });
    renderSection();

    await waitFor(() => expect(screen.getByTestId('webhooks-error')).toBeDefined());
    await userEvent.setup().click(screen.getByTestId('webhooks-retry'));
    await waitFor(() => expect(screen.getByTestId('webhooks-list')).toBeDefined());
  });

  it('a failed read is reported, never rendered as “no webhooks”', async () => {
    // The distinction this whole surface exists to make: "you have none" and
    // "we could not ask" are different screens, and the second one must not
    // send a member hunting for a webhook that is still out there posting.
    io.on('GET', MINE, () =>
      Response.json({ error: { key: 'boom', message: 'down' } }, { status: 500 }),
    );
    renderSection();

    await waitFor(() => expect(screen.getByTestId('webhooks-error')).toBeDefined());
    expect(screen.queryByTestId('webhooks-empty')).toBeNull();
  });

  it('renders a named empty state that still offers the create form', async () => {
    serve([]);
    renderSection();
    await waitFor(() => expect(screen.getByTestId('webhooks-empty')).toBeDefined());
    expect(screen.getByTestId('webhook-create')).toBeDefined();
  });

  it('disables creation offline, and says why', async () => {
    serve();
    renderSection({ online: false });
    await waitFor(() => expect(screen.getByTestId('webhooks-list')).toBeDefined());

    expect(screen.getByTestId('webhooks-offline')).toBeDefined();
    expect(screen.getByTestId<HTMLButtonElement>('webhook-create').disabled).toBe(true);
  });
});

describe('managing a webhook you own', () => {
  it('renames through the OWNER route, not the channel route', async () => {
    serve();
    io.on('PATCH', HOOK_PATH, () => Response.json({ webhook: { ...HOOK, name: 'Renamed' } }));
    renderSection();
    await waitFor(() => expect(screen.getByTestId('webhooks-list')).toBeDefined());

    await userEvent.setup().click(screen.getByTestId('webhook-rename-9200'));
    await userEvent.setup().clear(screen.getByTestId('webhook-rename-input-9200'));
    await userEvent.setup().type(screen.getByTestId('webhook-rename-input-9200'), 'Renamed');
    await userEvent.setup().click(screen.getByTestId('webhook-rename-save-9200'));

    await waitFor(() => expect(io.recorded(HOOK_PATH)).toHaveLength(1));
    expect(io.recorded(HOOK_PATH)[0]!.method).toBe('PATCH');
    // …and it is NOT the channel-scoped path, which needs `manage_channels` on
    // the destination — the whole reason the owner route exists.
    expect(io.recorded('/api/v1/channels/300/webhooks/9200')).toHaveLength(0);
  });

  it('revokes through the owner route, behind an inline confirm', async () => {
    serve();
    io.on('DELETE', HOOK_PATH, () => new Response(null, { status: 204 }));
    renderSection();
    await waitFor(() => expect(screen.getByTestId('webhooks-list')).toBeDefined());

    // Cancel writes nothing, and the consequence is stated before the confirm.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('webhook-delete-9200-trigger'));
    expect(screen.getByTestId('webhook-delete-9200-consequence').textContent).toContain(
      'stops working',
    );
    await user.click(screen.getByTestId('webhook-delete-9200-cancel'));
    expect(io.recorded(HOOK_PATH)).toHaveLength(0);

    await user.click(screen.getByTestId('webhook-delete-9200-trigger'));
    await user.click(screen.getByTestId('webhook-delete-9200-confirm'));

    await waitFor(() => expect(io.recorded(HOOK_PATH)).toHaveLength(1));
    expect(io.recorded(HOOK_PATH)[0]!.method).toBe('DELETE');
  });

  it('creates into the picked channel and re-reads the owner list', async () => {
    serve([]);
    io.on('POST', '/api/v1/channels/300/webhooks', () =>
      Response.json({ id: '9300', url: 'https://api.test/api/webhooks/9300/new' }, { status: 201 }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByTestId('webhooks-empty')).toBeDefined());

    const user = userEvent.setup();
    await user.type(screen.getByTestId('webhook-name-input'), 'CI bot');
    await user.click(screen.getByTestId('webhook-create'));

    await waitFor(() => expect(io.recorded('/api/v1/channels/300/webhooks')).toHaveLength(1));
    expect(io.recorded('/api/v1/channels/300/webhooks')[0]!.body).toEqual({ name: 'CI bot' });
    // Re-read so the new row comes from the server rather than from a local
    // guess about the shape an owner's row has.
    await waitFor(() => expect(io.recorded(MINE).length).toBeGreaterThan(1));
  });
});
