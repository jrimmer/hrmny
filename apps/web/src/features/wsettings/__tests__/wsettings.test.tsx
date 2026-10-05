/**
 * Workspace settings surface: router normalization + the Overview
 * section's admin gating, upload/remove flows, and rename.
 *
 * U5 — the nav's mobile list variant: same list→content stack as user
 * settings (its own rows; ✕ closes from the list header; no Log out row —
 * that is user-settings-only).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { Workspace } from '@cytale/domain';

import { parseWSettingsPath } from '../router.js';
import { WorkspaceOverview } from '../WorkspaceOverview.js';
import { WorkspaceSettingsNav } from '../WorkspaceSettingsNav.js';

afterEach(() => cleanup());

const ICON_URL = '/api/v1/attachments/' + 'b'.repeat(64);

const workspace: Workspace = {
  id: '6001',
  name: 'Playground',
  icon_url: null,
  description: null,
  owner_id: '9001',
  role_version: 0,
  created_at: '2026-01-01T00:00:00Z',
};

function renderOverview(overrides: Partial<Parameters<typeof WorkspaceOverview>[0]> = {}) {
  const props = {
    workspace,
    isAdmin: true,
    onUploadIcon: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onRemoveIcon: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<WorkspaceOverview {...props} />);
  return props;
}

describe('wsettings router', () => {
  it('normalizes the bare prefix and unknown sections to overview', () => {
    expect(parseWSettingsPath('/wsettings')).toEqual({ open: true, section: 'overview' });
    expect(parseWSettingsPath('/wsettings/overview')).toEqual({ open: true, section: 'overview' });
    expect(parseWSettingsPath('/wsettings/nonsense')).toEqual({
      open: true,
      section: 'overview',
    });
  });

  it('stays closed for other surfaces', () => {
    expect(parseWSettingsPath('/settings/account').open).toBe(false);
    expect(parseWSettingsPath('/').open).toBe(false);
  });
});

describe('WorkspaceOverview — admin', () => {
  it('uploads a picked image through onUploadIcon', async () => {
    const onUploadIcon = vi.fn().mockResolvedValue(undefined);
    renderOverview({ onUploadIcon });

    const file = new File([new Uint8Array([0x89, 0x50])], 'logo.png', { type: 'image/png' });
    const input = screen.getByTestId('wsettings-icon-input') as HTMLInputElement;
    await userEvent.setup().upload(input, file);

    // #48: picking stages into the crop dialog; confirm (no canvas in
    // jsdom -> original bytes) reaches the upload.
    expect(screen.getByTestId('crop-dialog')).toBeTruthy();
    // The dialog's <img> loads the object URL — jsdom never fetches blob:,
    // so prime natural dims + fire load like the dialog suite does.
    const cropImg = screen.getByTestId('crop-image') as HTMLImageElement;
    Object.defineProperty(cropImg, 'naturalWidth', { value: 800 });
    Object.defineProperty(cropImg, 'naturalHeight', { value: 400 });
    fireEvent.load(cropImg);
    await userEvent.setup().click(screen.getByTestId('crop-confirm'));
    await waitFor(() => expect(onUploadIcon).toHaveBeenCalledTimes(1));
    expect((onUploadIcon.mock.calls[0]![0] as File).name).toBe('logo.png');
    expect(screen.queryByTestId('wsettings-error')).toBeNull();
  });

  it('Remove appears only when an icon is set and clears through onRemoveIcon', async () => {
    const onRemoveIcon = vi.fn().mockResolvedValue(undefined);
    renderOverview({ onRemoveIcon });
    expect(screen.queryByTestId('wsettings-icon-remove')).toBeNull();

    cleanup();
    renderOverview({ onRemoveIcon, workspace: { ...workspace, icon_url: ICON_URL } });
    await userEvent.setup().click(screen.getByTestId('wsettings-icon-remove'));
    await waitFor(() => expect(onRemoveIcon).toHaveBeenCalled());
  });

  it('rename saves the dirty name only', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    renderOverview({ onRename });

    expect((screen.getByTestId('wsettings-name-save') as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByTestId('wsettings-name-input');
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, 'Renamed Ground');
    await userEvent.setup().click(screen.getByTestId('wsettings-name-save'));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Renamed Ground'));
  });

  it('a failed save surfaces the error alert', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('name must be 2-100 characters'));
    renderOverview({ onRename });

    const input = screen.getByTestId('wsettings-name-input');
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, 'Second Name');
    await userEvent.setup().click(screen.getByTestId('wsettings-name-save'));

    await waitFor(() =>
      expect(screen.getByTestId('wsettings-error').textContent).toContain('2-100'),
    );
  });
});

describe('WorkspaceOverview — non-admin', () => {
  it('controls are visible-disabled with the reason on the control', () => {
    renderOverview({ isAdmin: false });

    const upload = screen.getByTestId('wsettings-icon-upload') as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    expect(upload.title).toContain('Only workspace admins');

    const name = screen.getByTestId('wsettings-name-input') as HTMLInputElement;
    expect(name.disabled).toBe(true);

    expect((screen.getByTestId('wsettings-name-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the icon preview renders the uploaded image', () => {
    renderOverview({ workspace: { ...workspace, icon_url: ICON_URL } });
    const img = screen.getByTestId('wsettings-icon-preview').querySelector('img');
    expect(img?.getAttribute('src')).toBe(ICON_URL);
  });

  it('workspace null renders the loading state', () => {
    renderOverview({ workspace: null });
    expect(screen.getByTestId('wsettings-loading')).toBeTruthy();
  });
});

describe('WorkspaceSettingsNav — desktop col-2 menu (doctrine pin)', () => {
  it('renders the col-2 menu with no close control of its own (the pane owns ✕/Escape)', () => {
    render(
      <WorkspaceSettingsNav
        workspaceName="Playground"
        active="overview"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId('wsettings-nav')).toBeTruthy();
    expect(screen.getByTestId('wsettings-nav-overview')).toBeTruthy();
    expect(screen.queryByTestId('wsettings-nav-close')).toBeNull();
  });
});

describe('WorkspaceSettingsNav — mobile full-width list (U5)', () => {
  function renderMobileList() {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <WorkspaceSettingsNav
        workspaceName="Playground"
        active="overview"
        onSelect={onSelect}
        mobile
        onClose={onClose}
      />,
    );
    return { onSelect, onClose, container };
  }

  it('renders the workspace-scoped list with the header ✕ (no Log out row)', () => {
    const { container } = renderMobileList();
    expect(screen.getByTestId('wsettings-nav').getAttribute('data-mobile')).toBe('true');
    const row = screen.getByTestId('wsettings-nav-overview');
    expect(row.className).toContain('settings-list-row');
    expect(screen.queryByTestId('settings-nav-logout')).toBeNull();
    expect(container.textContent).toContain('Playground');
    expect(screen.getByTestId('wsettings-nav-close')).toBeTruthy();
  });

  it('selection reports the section id', async () => {
    const { onSelect } = renderMobileList();
    await userEvent.setup().click(screen.getByTestId('wsettings-nav-overview'));
    expect(onSelect).toHaveBeenCalledWith('overview');
  });

  it('the header ✕ closes the surface', async () => {
    const { onClose } = renderMobileList();
    await userEvent.setup().click(screen.getByTestId('wsettings-nav-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape on the list closes the surface (user settings’ close contract)', () => {
    const { onClose } = renderMobileList();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderMobileList();
    expect(await axe(container)).toHaveNoViolations();
  });
});
