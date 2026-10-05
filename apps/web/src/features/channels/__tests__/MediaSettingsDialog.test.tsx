/**
 * @cytale/web — workspace media settings dialog tests (calls V2 plan U8).
 *
 * States-first DoD at the api seam: loading → ready (four role=switch
 * toggles), permission-denied (403), error + retry, offline
 * (navigator.onLine false), and the optimistic toggle with rollback +
 * inline alert. Axe zero violations on the ready surface.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const getWorkspaceMediaSettings = vi.fn();
const putWorkspaceMediaSettings = vi.fn();

vi.mock('../../auth/session.js', () => ({
  api: {
    getWorkspaceMediaSettings: (...args: unknown[]) =>
      getWorkspaceMediaSettings(...(args as [string])),
    putWorkspaceMediaSettings: (...args: unknown[]) =>
      putWorkspaceMediaSettings(...(args as [string, Record<string, boolean>])),
  },
}));

import { MediaSettingsDialog } from '../MediaSettingsDialog.js';

const WS = '7700000000000050001';

const SETTINGS = { calls: true, video: true, screenshare: true, overrides_allowed: false };

function renderDialog(open = true) {
  return render(
    <MediaSettingsDialog open={open} onOpenChange={() => {}} workspaceId={WS} />,
  );
}

beforeEach(() => {
  getWorkspaceMediaSettings.mockReset();
  putWorkspaceMediaSettings.mockReset();
  getWorkspaceMediaSettings.mockResolvedValue({ ...SETTINGS });
});

afterEach(() => {
  cleanup();
});

describe('MediaSettingsDialog — states-first', () => {
  it('loading → ready: fetches once, renders the four switches with aria-checked', async () => {
    renderDialog();

    expect(screen.getByTestId('media-settings-loading')).not.toBeNull();
    await waitFor(() => {
      expect(getWorkspaceMediaSettings).toHaveBeenCalledWith(WS);
    });

    await waitFor(() => {
      expect(screen.getByTestId('media-settings-list')).not.toBeNull();
    });

    expect(screen.getByTestId('media-settings-toggle-calls').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(
      screen.getByTestId('media-settings-toggle-overrides').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('403 → the permission-denied copy (never a crash)', async () => {
    getWorkspaceMediaSettings.mockRejectedValue(
      Object.assign(new Error('Request denied.'), { status: 403 }),
    );
    renderDialog();

    const denied = await screen.findByTestId('media-settings-denied');
    expect(denied.textContent).toContain("don't have permission");
    expect(screen.queryByTestId('media-settings-list')).toBeNull();
  });

  it('generic failure → error state; Retry refetches and lands ready', async () => {
    getWorkspaceMediaSettings.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderDialog();

    expect(await screen.findByTestId('media-settings-error')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(getWorkspaceMediaSettings).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('media-settings-list')).not.toBeNull();
    });
  });

  it('offline → the offline note (browser reports no network)', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      renderDialog();

      expect(await screen.findByTestId('media-settings-offline')).not.toBeNull();
      expect(getWorkspaceMediaSettings).not.toHaveBeenCalled();
    } finally {
      onLine.mockRestore();
    }
  });

  it('closed → renders nothing', () => {
    renderDialog(false);
    expect(screen.queryByTestId('media-settings-dialog')).toBeNull();
  });
});

describe('MediaSettingsDialog — toggles (optimistic + rollback)', () => {
  it('toggle PUTs the single-key body; the server echo is authoritative', async () => {
    putWorkspaceMediaSettings.mockResolvedValue({ ...SETTINGS, video: false });
    renderDialog();

    await screen.findByTestId('media-settings-list');
    await userEvent.click(screen.getByTestId('media-settings-toggle-video'));

    await waitFor(() => {
      expect(putWorkspaceMediaSettings).toHaveBeenCalledWith(WS, { video: false });
    });
    await waitFor(() => {
      expect(screen.getByTestId('media-settings-toggle-video').getAttribute('aria-checked')).toBe(
        'false',
      );
    });
  });

  it('toggle failure → the row reverts + the inline save alert', async () => {
    putWorkspaceMediaSettings.mockRejectedValue(new TypeError('Failed to fetch'));
    renderDialog();

    await screen.findByTestId('media-settings-list');
    await userEvent.click(screen.getByTestId('media-settings-toggle-screenshare'));

    await waitFor(() => {
      expect(screen.getByTestId('media-settings-save-error')).not.toBeNull();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('media-settings-toggle-screenshare').getAttribute('aria-checked'),
      ).toBe('true');
    });
  });

  it('the overrides toggle PUTs overrides_allowed like any capability', async () => {
    putWorkspaceMediaSettings.mockResolvedValue({ ...SETTINGS, overrides_allowed: true });
    renderDialog();

    await screen.findByTestId('media-settings-list');
    await userEvent.click(screen.getByTestId('media-settings-toggle-overrides'));

    await waitFor(() => {
      expect(putWorkspaceMediaSettings).toHaveBeenCalledWith(WS, {
        overrides_allowed: true,
      });
    });
  });

  it('axe: zero violations on the ready surface', async () => {
    const { container } = renderDialog();
    await screen.findByTestId('media-settings-list');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('axe: zero violations on the denied surface', async () => {
    getWorkspaceMediaSettings.mockRejectedValue(
      Object.assign(new Error('Request denied.'), { status: 403 }),
    );
    const { container } = renderDialog();
    await screen.findByTestId('media-settings-denied');
    expect(await axe(container)).toHaveNoViolations();
  });
});
