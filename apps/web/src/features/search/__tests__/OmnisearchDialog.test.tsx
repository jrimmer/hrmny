/**
 * The Cmd-K palette's contract: debounced grouped search, keyboard + mouse
 * roving selection, jump-by-permalink, and honest states. The API is mocked —
 * these pin the INTERACTION, not the wire (the server suites own that).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/** waitFor under fake timers: advance the clock while polling. */
async function tick(check: () => void) {
  await waitFor(() => {
    vi.advanceTimersByTimeAsync(50);
    check();
  });
}
import { afterEach, afterEach as teardown, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultStore } from '@cytale/state';

import { OmnisearchDialog } from '../OmnisearchDialog.js';
import type { OmniPage } from '../api.js';
import * as api from '../api.js';

const fetchOmnisearch = vi.mocked(api.fetchOmnisearch);

vi.mock('../api.js', () => ({
  fetchOmnisearch: vi.fn(),
}));

const WS = '92000000001';
const WS_CH = '92000000002';
const DM = '92000000003';
const ME = '92000000004';
const PEER = '92000000005';
const MSG_WS = '92000000100';
const MSG_DM = '92000000101';

function hits(): OmniPage {
  return {
    results: [
      {
        kind: 'workspace',
        message_id: MSG_WS,
        channel_id: WS_CH,
        thread_id: null,
        workspace_id: WS,
        author_id: PEER,
        content: 'the deploy finished ahead of schedule',
        created_at: '2026-09-15T10:00:00Z',
        score: 3.5,
      },
      {
        kind: 'dm',
        message_id: MSG_DM,
        channel_id: DM,
        thread_id: null,
        workspace_id: null,
        author_id: PEER,
        content: 'deploy notes are in the doc',
        created_at: '2026-09-15T11:00:00Z',
        score: null,
      },
    ],
  };
}

function renderDialog(open = true) {
  return render(
    <OmnisearchDialog open={open} onOpenChange={vi.fn()} token="tok" now={Date.parse('2026-09-15T12:00:00Z')} />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchOmnisearch.mockReset();
  defaultStore.setState({
    currentUser: { id: ME, username: 'me' },
    channels: {
      [WS_CH]: {
        id: WS_CH,
        workspace_id: WS,
        name: 'general',
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-09-01T00:00:00Z',
      },
      [DM]: {
        id: DM,
        workspace_id: null,
        name: '',
        type: 'dm',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-09-01T00:00:00Z',
        recipients: [{ id: PEER, username: 'max' }],
      },
    },
    membersById: { [PEER]: { id: PEER, username: 'max', nickname: null, joined_at: '', roles: [] } },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OmnisearchDialog — states', () => {
  it('renders nothing while closed', () => {
    renderDialog(false);
    expect(screen.queryByTestId('omnisearch')).toBeNull();
  });

  it('shows the hint before the query reaches two characters, and never fetches', async () => {
    renderDialog();
    expect(screen.getByTestId('omni-hint')).toBeTruthy();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'd' } });
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchOmnisearch).not.toHaveBeenCalled();
  });

  it('debounces, then renders grouped results with the first row active', async () => {
    fetchOmnisearch.mockResolvedValue(hits());
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);

    await tick(() => expect(screen.getByTestId('omni-group-workspace')).toBeTruthy());
    expect(screen.getByTestId('omni-group-dm')).toBeTruthy();

    const wsRow = screen.getByTestId(`omni-result-${MSG_WS}`);
    expect(wsRow.getAttribute('data-selected')).toBe('true');
    expect(wsRow.textContent).toContain('#general');
    expect(wsRow.textContent).toContain('deploy finished');
    // The highlight marks the matched term.
    expect(wsRow.querySelector('.omni-mark')?.textContent).toBe('deploy');

    const dmRow = screen.getByTestId(`omni-result-${MSG_DM}`);
    expect(dmRow.querySelector('.omni-where')!.textContent).toBe('max');

    // One fetch, with the query and the token.
    expect(fetchOmnisearch).toHaveBeenCalledTimes(1);
    expect(fetchOmnisearch.mock.calls[0]![0]).toMatchObject({ q: 'deploy', token: 'tok' });
  });

  it('names a DM by the peer\'s display name, and gives every hit its author\'s 20px avatar', async () => {
    defaultStore.setState({
      membersById: {
        [PEER]: { id: PEER, username: 'max', nickname: 'Max Power', joined_at: '', roles: [], avatar_url: null },
      },
    });
    fetchOmnisearch.mockResolvedValue(hits());
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId(`omni-result-${MSG_DM}`)).toBeTruthy());

    const dmRow = screen.getByTestId(`omni-result-${MSG_DM}`);
    expect(dmRow.querySelector('.omni-where')!.textContent).toBe('Max Power');
    expect(dmRow.textContent).not.toContain('@max');
    for (const id of [MSG_WS, MSG_DM]) {
      const avatar = screen.getByTestId(`omni-result-${id}`).querySelector('[data-testid="omni-avatar"]')!;
      expect(avatar.classList.contains('avatar')).toBe(true);
      expect(avatar.classList.contains('omni-avatar')).toBe(true);
      expect(avatar.textContent).toBe('MP');
    }
  });

  it('stamps each hit the way a message row does (formatMessageStamp)', async () => {
    const now = Date.parse('2026-09-15T12:00:00Z');
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(14, 30, 0, 0);
    const older = new Date(now);
    older.setDate(older.getDate() - 20);
    older.setHours(9, 5, 0, 0);
    const page = hits();
    page.results[0]!.created_at = yesterday.toISOString();
    page.results[1]!.created_at = older.toISOString();
    fetchOmnisearch.mockResolvedValue(page);
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId(`omni-result-${MSG_WS}`)).toBeTruthy());

    const clock = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
    const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(older);
    const stamp = (id: string) =>
      screen.getByTestId(`omni-result-${id}`).querySelector('.omni-time')!.textContent;
    expect(stamp(MSG_WS)).toBe(`Yesterday, ${clock(yesterday)}`);
    expect(stamp(MSG_DM)).toBe(`${monthDay}, ${clock(older)}`);
  });

  it('a shorter keystroke than the debounce replaces the request, not the results', async () => {
    fetchOmnisearch.mockResolvedValue({ results: [] });
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'dep' } });
    await vi.advanceTimersByTimeAsync(100);
    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);

    // 'dep' never fired — its timer was cleared before the debounce elapsed.
    expect(fetchOmnisearch).toHaveBeenCalledTimes(1);
    expect(fetchOmnisearch.mock.calls[0]![0]).toMatchObject({ q: 'deploy' });
  });

  it('says so when there are no results', async () => {
    fetchOmnisearch.mockResolvedValue({ results: [] });
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'zzz' } });
    await vi.advanceTimersByTimeAsync(300);

    await tick(() => expect(screen.getByTestId('omni-empty')).toBeTruthy());
    expect(screen.getByTestId('omni-empty').textContent).toContain('zzz');
  });

  it('renders an error line and keeps the query on a failed search', async () => {
    fetchOmnisearch.mockRejectedValue({ status: 500 });
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'boom' } });
    await vi.advanceTimersByTimeAsync(300);

    await tick(() => expect(screen.getByTestId('omni-error')).toBeTruthy());
    expect((screen.getByTestId('omni-input') as HTMLInputElement).value).toBe('boom');
  });

  it('Retry (the shared pane banner) re-runs the same query', async () => {
    fetchOmnisearch.mockRejectedValueOnce({ status: 500 }).mockResolvedValue(hits());
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId('omni-retry')).toBeTruthy());
    expect(screen.getByTestId('omni-retry').textContent).toBe('Retry');

    fireEvent.click(screen.getByTestId('omni-retry'));
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId(`omni-result-${MSG_WS}`)).toBeTruthy());
    expect(fetchOmnisearch).toHaveBeenCalledTimes(2);
    expect(fetchOmnisearch.mock.calls[1]![0]).toMatchObject({ q: 'deploy' });
  });

  it('renders mention tokens in a hit as pills, never the raw wire tokens', async () => {
    const page = hits();
    page.results[0]!.content = 'deploy ping <@' + PEER + '> in <#' + WS_CH + '>';
    fetchOmnisearch.mockResolvedValue(page);
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId(`omni-result-${MSG_WS}`)).toBeTruthy());

    const row = screen.getByTestId(`omni-result-${MSG_WS}`);
    expect(row.textContent).not.toMatch(/<[@#]/);
    expect(row.querySelector('.mention[data-user-id]')!.textContent).toBe('@max');
    expect(row.querySelector('.mention.channel-mention')!.textContent).toBe('#general');
    // The query term is still highlighted in the text runs.
    expect(row.querySelector('mark.omni-mark')!.textContent!.toLowerCase()).toBe('deploy');
  });
});

describe('OmnisearchDialog — navigation', () => {
  it('ArrowDown moves the roving selection and Enter jumps by permalink', async () => {
    fetchOmnisearch.mockResolvedValue(hits());
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId('omni-group-workspace')).toBeTruthy());

    const wsRow = screen.getByTestId(`omni-result-${MSG_WS}`);
    const dmRow = screen.getByTestId(`omni-result-${MSG_DM}`);
    expect(wsRow.getAttribute('data-selected')).toBe('true');

    fireEvent.keyDown(screen.getByTestId('omni-input'), { key: 'ArrowDown' });
    expect(dmRow.getAttribute('data-selected')).toBe('true');
    // cmdk keeps data-selected='false' on unselected rows (it does not
    // remove the attribute) — the roving contract, in its vocabulary.
    expect(wsRow.getAttribute('data-selected')).toBe('false');

    // Back to the top, Enter jumps to the WORKSPACE hit. The permalink's
    // hash form encodes ids (#118's shortlink tokens), so assert the SHAPE —
    // the token round-trip is the permalink suite's contract, not this one's.
    fireEvent.keyDown(screen.getByTestId('omni-input'), { key: 'ArrowUp' });
    expect(wsRow.getAttribute('data-selected')).toBe('true');

    const originalHash = window.location.hash;
    fireEvent.keyDown(screen.getByTestId('omni-input'), { key: 'Enter' });
    await tick(() => expect(window.location.hash).not.toBe(originalHash));
    expect(window.location.hash).toContain('workspace/');
    expect(window.location.hash).toContain('/channel/');
    expect(window.location.hash).toContain('/message/');
    window.location.hash = originalHash;
  });

  it('Enter on a DM hit uses the workspace-less permalink form', async () => {
    fetchOmnisearch.mockResolvedValue(hits());
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'notes' } });
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId('omni-group-dm')).toBeTruthy());

    // The DM hit is second: arrow to it, Enter. The workspace-less form has
    // NO workspace/ segment — that absence is the DM permalink's signature.
    fireEvent.keyDown(screen.getByTestId('omni-input'), { key: 'ArrowDown' });

    const originalHash = window.location.hash;
    fireEvent.keyDown(screen.getByTestId('omni-input'), { key: 'Enter' });
    await tick(() => expect(window.location.hash).not.toBe(originalHash));
    expect(window.location.hash).toContain('/channel/');
    expect(window.location.hash).toContain('/message/');
    expect(window.location.hash).not.toContain('workspace/');
    window.location.hash = originalHash;
  });

  it('hover drives the same roving selection', async () => {
    fetchOmnisearch.mockResolvedValue(hits());
    renderDialog();

    fireEvent.change(screen.getByTestId('omni-input'), { target: { value: 'deploy' } });
    await vi.advanceTimersByTimeAsync(300);
    await tick(() => expect(screen.getByTestId('omni-group-workspace')).toBeTruthy());

    fireEvent.pointerMove(screen.getByTestId(`omni-result-${MSG_DM}`));
    expect(screen.getByTestId(`omni-result-${MSG_DM}`).getAttribute('data-selected')).toBe('true');
  });
});
