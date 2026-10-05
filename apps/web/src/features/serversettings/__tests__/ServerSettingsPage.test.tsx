/**
 * #121 — the Server Settings surface.
 *
 * The states that matter are the operator's decision points: the editor
 * prefilled from GET, the cheap client-side JSON error, the server's
 * SPECIFIC validation error rendered, the applied-live message for a
 * runtime-only save, the "Restart now?" prompt for a boot-scoped save, and
 * the restart flow's poll-then-reload. Cancel revalidates (a fresh GET),
 * it does not merely rewind the textarea.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerSettingsPage, type ServerSettingsPageProps } from '../ServerSettingsPage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Set the editor's whole value (typing would parse `{` as a special key). */
function setEditor(value: string) {
  fireEvent.change(screen.getByTestId('serversettings-editor'), { target: { value } });
}

const DOC = {
  config: {
    operator_user_ids: ['42'],
    registration_open: true,
    backups: { frequency: 'daily', retention: 7 },
  },
  metadata: {
    'backups.frequency': {
      type: 'enum(hourly | daily | weekly)',
      scope: 'runtime',
      description: 'How often the backup job runs.',
    },
    'ssh.enabled': {
      type: 'boolean',
      scope: 'boot',
      description: 'Whether this node issues SSH user certificates.',
    },
  },
};

function makeProps(overrides: Partial<ServerSettingsPageProps> = {}) {
  return {
    load: vi.fn().mockResolvedValue(DOC),
    save: vi.fn().mockResolvedValue({ ok: true, changed: ['backups.retention'], restart_required: false }),
    restart: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    pollHealth: vi.fn().mockResolvedValue(true),
    reload: vi.fn(),
    ...overrides,
  } satisfies ServerSettingsPageProps;
}

describe('ServerSettingsPage', () => {
  it('renders a loading state before the document arrives', () => {
    render(<ServerSettingsPage {...makeProps({ load: () => new Promise(() => undefined) })} />);
    expect(screen.getByTestId('serversettings-loading')).toBeDefined();
  });

  it('renders the editor prefilled from GET with the key reference help text', async () => {
    render(<ServerSettingsPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByTestId('serversettings-editor')).toBeDefined());
    const editor = screen.getByTestId('serversettings-editor') as HTMLTextAreaElement;
    expect(editor.value).toContain('"registration_open": true');
    // Help text renders from the per-key metadata.
    const help = screen.getByTestId('serversettings-keys-help');
    expect(help.textContent).toContain('boot');
    expect(help.textContent).toContain('How often the backup job runs.');
  });

  it('renders a load failure as an error state (the deep-linked non-operator 403 lands here)', async () => {
    render(
      <ServerSettingsPage
        {...makeProps({ load: vi.fn().mockRejectedValue(new Error('Request denied.')) })}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('serversettings-error')).toBeDefined());
    expect(screen.getByTestId('serversettings-error').textContent).toContain('Request denied.');
  });

  it('Save with invalid JSON shows the cheap client-side error and never calls the API', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<ServerSettingsPage {...props} />);
    await waitFor(() => expect(screen.getByTestId('serversettings-editor')).toBeDefined());

    setEditor('{not json');
    await user.click(screen.getByTestId('serversettings-save'));

    const shown = screen.getByTestId('serversettings-save-error');
    expect(shown.textContent).toContain('Invalid JSON');
    expect(props.save).not.toHaveBeenCalled();
  });

  it('a valid save calls PUT with the parsed document and says it applied live', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue({ ok: true, changed: ['backups.retention'], restart_required: false });
    render(<ServerSettingsPage {...makeProps({ save })} />);
    await waitFor(() => expect(screen.getByTestId('serversettings-editor')).toBeDefined());

    await user.click(screen.getByTestId('serversettings-save'));

    await waitFor(() => expect(screen.getByTestId('serversettings-saved')).toBeDefined());
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0] as unknown[])[0]).toMatchObject({ registration_open: true });
    expect(screen.getByTestId('serversettings-saved').textContent).toContain('applied live');
    // No restart prompt for a runtime-only save.
    expect(screen.queryByTestId('serversettings-restart-prompt')).toBeNull();
  });

  it('the server validation error renders SPECIFICALLY (key + reason in the message)', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockRejectedValue(new Error('backups.retention: expected an integer >= 1, got: 0'));
    render(<ServerSettingsPage {...makeProps({ save })} />);
    await waitFor(() => expect(screen.getByTestId('serversettings-editor')).toBeDefined());

    setEditor('{"backups": {"retention": 0}}');
    await user.click(screen.getByTestId('serversettings-save'));

    const shown = await screen.findByTestId('serversettings-save-error');
    expect(shown.textContent).toContain('backups.retention');
    expect(shown.textContent).toContain('integer >= 1');
  });

  it('a boot-scoped save prompts "Restart now?" and restart polls health then reloads', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue({
      ok: true,
      changed: ['ssh.enabled'],
      restart_required: true,
    });
    let healthCalls = 0;
    const pollHealth = vi.fn().mockImplementation(async () => {
      healthCalls += 1;
      return healthCalls >= 3; // down, down, up
    });
    const reload = vi.fn();
    render(<ServerSettingsPage {...makeProps({ save, pollHealth, reload })} />);
    await waitFor(() => expect(screen.getByTestId('serversettings-editor')).toBeDefined());

    await user.click(screen.getByTestId('serversettings-save'));

    const prompt = await screen.findByTestId('serversettings-restart-prompt');
    expect(prompt.textContent).toContain('Restart now?');

    await user.click(screen.getByTestId('serversettings-restart-now'));
    expect(screen.getByTestId('serversettings-restarting')).toBeDefined();

    // The poll waits a beat between attempts (the node has to go DOWN
    // first), so the reload lands a few polls in.
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 8_000 });
    expect(pollHealth).toHaveBeenCalledTimes(3);
  });

  it('"Later" dismisses the restart prompt without restarting', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue({ ok: true, changed: ['ssh.enabled'], restart_required: true });
    const props = makeProps({ save });
    render(<ServerSettingsPage {...props} />);
    await waitFor(() => expect(screen.getByTestId('serversettings-editor')).toBeDefined());

    await user.click(screen.getByTestId('serversettings-save'));
    await user.click(await screen.findByTestId('serversettings-restart-later'));

    expect(screen.queryByTestId('serversettings-restart-prompt')).toBeNull();
    expect(props.restart).not.toHaveBeenCalled();
    expect(props.reload).not.toHaveBeenCalled();
  });

  it('Cancel re-fetches from GET (revalidates the display), not just a local rewind', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue(DOC);
    render(<ServerSettingsPage {...makeProps({ load })} />);
    await waitFor(() => expect(screen.getByTestId('serversettings-editor')).toBeDefined());

    await user.type(screen.getByTestId('serversettings-editor'), 'junk');
    await user.click(screen.getByTestId('serversettings-cancel'));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const editor = screen.getByTestId('serversettings-editor') as HTMLTextAreaElement;
      expect(editor.value).not.toContain('junk');
    });
  });
});
