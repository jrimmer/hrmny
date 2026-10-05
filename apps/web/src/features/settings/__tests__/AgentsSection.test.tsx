/**
 * @cytale/web — "Your agents" pane tests (U13).
 *
 * Scenarios: mint with the read-only preset → POST payload correct; row
 * restriction edit → PATCH payload correct; channel-scoped preset with no
 * channel blocked client-side; states-first (loading, empty, error + retry,
 * offline destructive-disabled, ACCOUNT_UNVERIFIED permission-denied);
 * regenerate → new reveal; revoke confirm inline; dirty-guard seam
 * (onDirtyChange flips with unsaved restriction edits).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { AgentsSection } from '../AgentsSection.js';
import {
  ACCESS_GRANTED,
  BOT_ROW,
  CHANNELS,
  WORKSPACES,
  WS,
  createFetchRouter,
  type FetchRouter,
} from './helpers.js';

const BOTS_PATH = '/api/v1/bots';
const BOT_PATH = `/api/v1/bots/${BOT_ROW.id}`;
const REGEN_PATH = `/api/v1/bots/${BOT_ROW.id}/regenerate`;

let io: FetchRouter;

function listRoutes(): void {
  io.on('GET', BOTS_PATH, () => Response.json({ bots: [{ ...BOT_ROW }] }));
  io.on('POST', BOTS_PATH, () =>
    Response.json({ id: '930000000000000099', token: 'cytbot_newmint', name: 'Scraper' }, { status: 201 }),
  );
  io.on('PATCH', BOT_PATH, () => Response.json({ ...BOT_ROW, access: ACCESS_GRANTED }));
  io.on('POST', REGEN_PATH, () => Response.json({ token: 'cytbot_rotated' }, { status: 201 }));
  io.on('DELETE', BOT_PATH, () => new Response(null, { status: 204 }));
}

function renderPane(props: Partial<Parameters<typeof AgentsSection>[0]> = {}) {
  return render(
    <AgentsSection
      workspaces={WORKSPACES}
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

describe('BotsPane — minting with presets', () => {
  it('mint with the read-only preset POSTs the exact restrictions payload', async () => {
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [] }));
    io.on('POST', BOTS_PATH, () =>
      Response.json({ id: '930000000000000099', token: 'cytbot_newmint' }, { status: 201 }),
    );
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-empty')).toBeTruthy());

    await userEvent.setup().type(screen.getByTestId('bot-name-input'), 'Scraper');
    await userEvent.setup().click(screen.getByTestId('bot-create'));

    // The styled confirmation dialog — the POST fires only on confirm.
    expect(screen.getByTestId('bot-mint-dialog')).toBeTruthy();
    expect(screen.getByTestId('bot-mint-summary').textContent).toContain('Scraper');
    expect(screen.getByTestId('bot-mint-summary').textContent).toContain('@scraper');
    expect(io.recorded(BOTS_PATH).filter((c) => c.method === 'POST')).toHaveLength(0);

    await userEvent.setup().click(screen.getByTestId('bot-mint-confirm'));

    // A name and nothing else: an agent starts with no access (R6), and the
    // grant is a separate, explicit act on its row.
    const posted = io.recorded(BOTS_PATH).find((c) => c.method === 'POST');
    expect(posted?.body).toEqual({ name: 'Scraper' });

    await waitFor(() => expect(screen.getByTestId('bot-token-reveal')).toBeTruthy());
    expect(screen.getByTestId('bot-token-reveal-value').getAttribute('value')).toBe('cytbot_newmint');
  });

  it('mint WITH a tag sends the tag the user typed', async () => {
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [] }));
    io.on('POST', BOTS_PATH, () =>
      Response.json({ id: '930000000000000099', token: 'cytbot_tagged' }, { status: 201 }),
    );
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-empty')).toBeTruthy());

    await userEvent.setup().type(screen.getByTestId('bot-name-input'), 'Ada OpenClaw');
    await userEvent.setup().type(screen.getByTestId('bot-username-input'), 'ada');
    await userEvent.setup().click(screen.getByTestId('bot-create'));
    await userEvent.setup().click(screen.getByTestId('bot-mint-confirm'));

    // Regression pin: the deployed bundle once dropped the tag here — the
    // dialog previewed @ada while the POST carried only the name, so the
    // mint was refused for a tag the user never sent... and worse, a mint
    // would have created a DIFFERENT credential than the one confirmed.
    const posted = io.recorded(BOTS_PATH).find((c) => c.method === 'POST');
    expect(posted?.body).toEqual({ name: 'Ada OpenClaw', username: 'ada' });
  });

  it('renames the DISPLAY NAME without revoke/recreate — the tag never changes', async () => {
    // Own routes (no listRoutes): the mock list must reflect the rename.
    const row = { ...BOT_ROW };
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [row] }));
    let patchedBody: unknown = null;
    io.on('PATCH', BOT_PATH, (init?: RequestInit) => {
      patchedBody = JSON.parse(String(init?.body));
      row.name = (patchedBody as { name: string }).name;
      return Response.json({ ...row });
    });
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-rename-${BOT_ROW.id}`));
    const input = screen.getByTestId(`bot-rename-input-${BOT_ROW.id}`) as HTMLInputElement;
    expect(input.value).toBe(BOT_ROW.name);

    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, 'Ada Rewritten');
    await userEvent.setup().click(screen.getByTestId(`bot-rename-save-${BOT_ROW.id}`));

    await waitFor(() => expect(screen.getByText('Ada Rewritten')).toBeTruthy());
    expect(patchedBody).toEqual({ name: 'Ada Rewritten' });
    // The tag is untouched by a rename (it is set at mint, once).
    // The TAG is untouched by a rename (it is set at mint, once).
    expect(screen.getByText(`@${row.username}`)).toBeTruthy();
  });

  it('rename with an empty name is refused client-side', async () => {
    listRoutes();
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-rename-${BOT_ROW.id}`));
    const input = screen.getByTestId(`bot-rename-input-${BOT_ROW.id}`) as HTMLInputElement;
    await userEvent.setup().clear(input);
    await userEvent.setup().click(screen.getByTestId(`bot-rename-save-${BOT_ROW.id}`));

    expect(screen.getByTestId(`bot-rename-error-${BOT_ROW.id}`).textContent).toMatch(/name/i);
    expect(io.recorded(BOT_PATH).filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('an EXPLICIT tag is confirmed verbatim; cancel never posts', async () => {
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [] }));
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-empty')).toBeTruthy());

    await userEvent.setup().type(screen.getByTestId('bot-name-input'), 'Ada Openclaw');
    await userEvent.setup().type(screen.getByTestId('bot-username-input'), 'ada');
    await userEvent.setup().click(screen.getByTestId('bot-create'));

    expect(screen.getByTestId('bot-mint-summary').textContent).toContain('Ada Openclaw');
    expect(screen.getByTestId('bot-mint-summary').textContent).toContain('@ada');

    await userEvent.setup().click(screen.getByTestId('bot-mint-cancel'));
    expect(screen.queryByTestId('bot-mint-dialog')).toBeNull();
    expect(io.recorded(BOTS_PATH).filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a name is required to mint — nothing is posted without one', async () => {
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [] }));
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-empty')).toBeTruthy());

    expect(screen.getByTestId('bot-create').hasAttribute('disabled')).toBe(true);
    expect(io.recorded(BOTS_PATH).filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('BotsPane — the access tree', () => {
  it('a never-granted agent reads "No access yet" (R6) and starts the tree all-none', async () => {
    listRoutes();
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    expect(screen.getByTestId(`bot-access-${BOT_ROW.id}`).textContent).toMatch(/no access yet/i);

    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));

    // Server and Account are REPORTED, locked, and worded as fixed.
    expect(screen.getByTestId(`bot-edit-${BOT_ROW.id}-server-level`).textContent).toMatch(
      /read.*cannot change/i,
    );
    expect(screen.getByTestId(`bot-edit-${BOT_ROW.id}-account-level`).textContent).toMatch(
      /read.*its own identity/i,
    );
    expect(
      (screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-none`) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('granting All workspaces at read_write saves the WHOLE document (one save path)', async () => {
    listRoutes();
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-all`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-all-level-read_write`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-save-${BOT_ROW.id}`));

    const patched = io.recorded(BOT_PATH).find((c) => c.method === 'PATCH');
    expect(patched?.body).toEqual({
      access: {
        v: 1,
        server: 'read',
        account: { agent: 'read' },
        dms: 'none',
        workspaces: { mode: 'all', level: 'read_write', grants: {} },
      },
    });
  });

  it('None → Custom applies directly — no confirmation (modes are reversible)', async () => {
    listRoutes();
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-custom`));

    // No guard: Custom is in force at once, every workspace offered at none,
    // and the modes toggle back and forth freely.
    expect(screen.queryByTestId(`bot-edit-${BOT_ROW.id}-custom-confirm`)).toBeNull();
    expect(
      (screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-custom`) as HTMLInputElement).checked,
    ).toBe(true);

    // Custom is in force and every workspace is offered at none.
    const ws = WORKSPACES[0]!.id;
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-ws-level-${ws}-read`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-save-${BOT_ROW.id}`));

    const patched = io.recorded(BOT_PATH).find((c) => c.method === 'PATCH');
    expect(patched?.body).toEqual({
      access: {
        v: 1,
        server: 'read',
        account: { agent: 'read' },
        dms: 'none',
        workspaces: { mode: 'custom', level: null, grants: { [ws]: { level: 'read', channels: {} } } },
      },
    });
  });

  it('per-channel levels load lazily and ride the same document', async () => {
    listRoutes();
    renderPane({ loadChannels: async () => [{ id: CHANNELS[0]!.id, name: CHANNELS[0]!.name }] });
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-custom`));

    const ws = WORKSPACES[0]!.id;
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-ws-level-${ws}-read`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-ws-channels-toggle-${ws}`));

    await waitFor(() =>
      expect(screen.getByTestId(`bot-edit-${BOT_ROW.id}-ws-channels-${ws}`)).toBeTruthy(),
    );
    await userEvent.setup().click(
      screen.getByTestId(`bot-edit-${BOT_ROW.id}-ch-level-${CHANNELS[0]!.id}-read_write`),
    );
    await userEvent.setup().click(screen.getByTestId(`bot-edit-save-${BOT_ROW.id}`));

    const patched = io.recorded(BOT_PATH).find((c) => c.method === 'PATCH');
    expect(patched?.body).toEqual({
      access: {
        v: 1,
        server: 'read',
        account: { agent: 'read' },
        dms: 'none',
        workspaces: {
          mode: 'custom',
          level: null,
          grants: {
            [ws]: { level: 'read', channels: { [CHANNELS[0]!.id]: 'read_write' } },
          },
        },
      },
    });
  });

  it('while All is in force the explicit grants are RETAINED and visibly dormant (R9)', async () => {
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [{ ...BOT_ROW, access: ACCESS_GRANTED }] }));
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-all`));

    // The grant survives the mode change (never rewritten), and it is on
    // screen saying it is not the thing in force.
    const dormant = screen.getByTestId(`bot-edit-${BOT_ROW.id}-dormant`);
    expect(dormant.textContent).toMatch(/retained.*in force/i);
    expect(screen.getByTestId(`bot-edit-${BOT_ROW.id}-dormant-${WS}`).textContent).toMatch(
      /read-write/i,
    );

    // Clearing the root puts it back in force, unchanged — and going back to
    // Custom from All needs no confirmation (the guard is None → Custom only).
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-custom`));
    expect(screen.queryByTestId(`bot-edit-${BOT_ROW.id}-custom-confirm`)).toBeNull();
    expect(
      (screen.getByTestId(`bot-edit-${BOT_ROW.id}-ws-level-${WS}-read_write`) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('dirty-guard seam flips with unsaved edits and settles on save', async () => {
    listRoutes();
    const dirtyEvents: boolean[] = [];
    renderPane({ onDirtyChange: (d) => dirtyEvents.push(d) });
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-all`));
    await waitFor(() => expect(dirtyEvents[dirtyEvents.length - 1]).toBe(true));

    await userEvent.setup().click(screen.getByTestId(`bot-edit-save-${BOT_ROW.id}`));
    await waitFor(() => expect(dirtyEvents[dirtyEvents.length - 1]).toBe(false));
  });

  it('cancel collapses the editor and clears dirtiness', async () => {
    listRoutes();
    const dirtyEvents: boolean[] = [];
    renderPane({ onDirtyChange: (d) => dirtyEvents.push(d) });
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}-mode-all`));
    await waitFor(() => expect(dirtyEvents[dirtyEvents.length - 1]).toBe(true));

    await userEvent.setup().click(screen.getByTestId(`bot-edit-cancel-${BOT_ROW.id}`));
    await waitFor(() => expect(dirtyEvents[dirtyEvents.length - 1]).toBe(false));
    expect(io.recorded(BOT_PATH).filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('BotsPane — credential lifecycle', () => {
  it('regenerate → new once-only reveal (and the affordance exists after a dismissed modal)', async () => {
    listRoutes();
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    // The dismissed-modal recovery path: regenerate is visible on the row.
    expect(screen.getByTestId(`bot-regenerate-${BOT_ROW.id}-trigger`)).toBeTruthy();

    await userEvent.setup().click(screen.getByTestId(`bot-regenerate-${BOT_ROW.id}-trigger`));
    await userEvent.setup().click(screen.getByTestId(`bot-regenerate-${BOT_ROW.id}-confirm`));
    await waitFor(() => expect(screen.getByTestId('bot-token-reveal')).toBeTruthy());
    expect(screen.getByTestId('bot-token-reveal-value').getAttribute('value')).toBe('cytbot_rotated');

    // Dismiss; the regenerate affordance is still right there.
    await userEvent.setup().click(screen.getByTestId('bot-token-reveal-done'));
    expect(screen.getByTestId(`bot-regenerate-${BOT_ROW.id}-trigger`)).toBeTruthy();
  });

  it('revoke confirms inline and executes the DELETE', async () => {
    const bots = [{ ...BOT_ROW }];
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [...bots] }));
    io.on('DELETE', BOT_PATH, () => {
      bots.length = 0;
      return new Response(null, { status: 204 });
    });
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    await userEvent.setup().click(screen.getByTestId(`bot-revoke-${BOT_ROW.id}-trigger`));
    expect(screen.getByTestId(`bot-revoke-${BOT_ROW.id}-consequence`).textContent).toMatch(
      /disconnects the agent immediately/i,
    );
    await userEvent.setup().click(screen.getByTestId(`bot-revoke-${BOT_ROW.id}-confirm`));

    expect(io.recorded(BOT_PATH).filter((c) => c.method === 'DELETE')).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('bots-empty')).toBeTruthy());
  });
});

describe('BotsPane — states-first DoD', () => {
  it('renders the loading skeleton while the list is in flight', () => {
    io.on('GET', BOTS_PATH, () => new Promise<Response>(() => undefined));
    renderPane();
    expect(screen.getByTestId('bots-loading')).toBeTruthy();
  });

  it('renders the named empty state with a next-step hint', async () => {
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [] }));
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-empty')).toBeTruthy());
    expect(screen.getByTestId('bots-empty').textContent).toMatch(/no agents yet/i);
  });

  it('error state shows an alert with retry that recovers', async () => {
    let fail = true;
    io.on('GET', BOTS_PATH, () =>
      fail
        ? Response.json({ error: { key: 'boom', code: 500, message: 'agent store down' } }, { status: 500 })
        : Response.json({ bots: [{ ...BOT_ROW }] }),
    );
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-error')).toBeTruthy());

    fail = false;
    await userEvent.setup().click(screen.getByTestId('bots-retry'));
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());
  });

  it('403 ACCOUNT_UNVERIFIED renders the verification-required alert', async () => {
    io.on('GET', BOTS_PATH, () =>
      Response.json(
        { error: { key: 'ACCOUNT_UNVERIFIED', code: 40303, message: 'verify email' } },
        { status: 403 },
      ),
    );
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-permission-denied')).toBeTruthy());
    expect(screen.getByTestId('bots-permission-denied').textContent).toMatch(/verify your email/i);
  });

  // 6.4 rename window: the post-rename lower_snake spelling renders the same alert.
  it('403 account_unverified (post-6.4 spelling) renders the verification-required alert', async () => {
    io.on('GET', BOTS_PATH, () =>
      Response.json(
        { error: { key: 'account_unverified', code: 40303, message: 'verify email' } },
        { status: 403 },
      ),
    );
    renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-permission-denied')).toBeTruthy());
    expect(screen.getByTestId('bots-permission-denied').textContent).toMatch(/verify your email/i);
  });

  it('offline: banner shows and destructive actions are disabled', async () => {
    listRoutes();
    renderPane({ online: false });
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());

    expect(screen.getByTestId('bots-offline')).toBeTruthy();
    expect(screen.getByTestId(`bot-revoke-${BOT_ROW.id}-trigger`).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId(`bot-regenerate-${BOT_ROW.id}-trigger`).hasAttribute('disabled')).toBe(true);
  });
});

describe('BotsPane — accessibility', () => {
  it('axe: zero violations in the ready state with the editor open', async () => {
    listRoutes();
    const { container } = renderPane();
    await waitFor(() => expect(screen.getByTestId('bots-list')).toBeTruthy());
    await userEvent.setup().click(screen.getByTestId(`bot-edit-${BOT_ROW.id}`));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('avatar (#126)', () => {
  function rowWithAvatar(avatar_url: string | null) {
    const row = { ...BOT_ROW, avatar_url };
    io.on('GET', BOTS_PATH, () => Response.json({ bots: [row] }));
    return row;
  }

  it('upload POSTs the multipart avatar and the row renders it', async () => {
    const row = rowWithAvatar(null);
    io.on('POST', `/api/v1/bots/${BOT_ROW.id}/avatar`, () => {
      row.avatar_url = '/api/v1/attachments/set';
      return Response.json({ bot: { ...row } });
    });
    renderPane();

    await screen.findByTestId(`bot-avatar-${BOT_ROW.id}`);
    const input = document.getElementById(`bot-avatar-input-${BOT_ROW.id}`) as HTMLInputElement;
    expect(input).toBeTruthy();

    await userEvent.upload(input, new File([new Uint8Array([1, 2, 3])], 'face.png', { type: 'image/png' }));

    await waitFor(() => {
      const call = io
        .recorded(`/api/v1/bots/${BOT_ROW.id}/avatar`)
        .find((c) => c.method === 'POST');
      expect(call).toBeTruthy();
    });
    // The reload carries the avatar: Remove is offered only when the URL is set.
    await waitFor(() => expect(screen.getByTestId(`bot-avatar-remove-${BOT_ROW.id}`)).toBeTruthy());
  });

  it('remove clears the avatar back to the fallback', async () => {
    const row = rowWithAvatar('/api/v1/attachments/set');
    io.on('DELETE', `/api/v1/bots/${BOT_ROW.id}/avatar`, () => {
      row.avatar_url = null;
      return Response.json({ bot: { ...row } });
    });
    renderPane();

    await waitFor(() => expect(screen.getByTestId(`bot-avatar-remove-${BOT_ROW.id}`)).toBeTruthy());
    await userEvent.setup().click(screen.getByTestId(`bot-avatar-remove-${BOT_ROW.id}`));

    await waitFor(() => expect(screen.queryByTestId(`bot-avatar-remove-${BOT_ROW.id}`)).toBeNull());
  });
});
