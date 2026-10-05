/**
 * #54 U7 — "Remind me…": the picker's presets, custom time, pending state,
 * cancel, re-set, refusal rollback, keyboard contract and offline state.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { MarkPicker } from '../MarkPicker.js';
import { REMINDER_PRESETS, resetMarksForTests } from '../useMarks.js';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T> extends AxeMatchers {}
}

const CH = '9007199254740993';
const MSG = '1000000000000001';
const PATH = `/api/v1/users/@me/marks/snooze/channels/${CH}/messages/${MSG}`;

let fetchMock: ReturnType<typeof vi.fn>;
let listed: unknown[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = [RequestInfo | URL, RequestInit?];
const calls = (method: string) =>
  (fetchMock.mock.calls as Call[]).filter(([u, init]) => String(u).includes('/users/@me/marks') && (init?.method ?? 'GET') === method);

function renderPicker(props: { disabled?: boolean } = {}) {
  return render(
    <MarkPicker
      channelId={CH}
      messageId={MSG}
      buttonClassName="btn"
      icon={() => <span>⏰</span>}
      {...props}
    />,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  listed = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/users/@me/marks') && method === 'GET') return jsonResponse(200, { marks: listed });
    if (url.endsWith(PATH) && method === 'PUT') {
      const { due_at } = JSON.parse(String(init!.body)) as { due_at: string };
      return jsonResponse(200, { mark: { kind: 'snooze', channel_id: CH, message_id: MSG, due_at, state: 'pending' } });
    }
    if (url.endsWith(PATH) && method === 'DELETE') return jsonResponse(204, null);
    return jsonResponse(404, { error: { key: 'not_found', message: 'nope' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  resetMarksForTests();
  vi.unstubAllGlobals();
});

describe('MarkPicker (#54)', () => {
  it('a preset sets an ABSOLUTE instant and the action shows the pending reminder', async () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('action-remind'));
    const before = Date.now();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('mark-preset').find((b) => b.getAttribute('data-preset') === '1h')!);
    });
    await flush();

    const [put] = calls('PUT');
    const due = Date.parse((JSON.parse(String(put![1]!.body)) as { due_at: string }).due_at);
    expect(due).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 1_000);

    // Closed, and the trigger now names the pending time.
    expect(screen.queryByTestId('mark-picker')).toBeNull();
    const trigger = screen.getByTestId('action-remind');
    expect(trigger.getAttribute('data-pending')).toBe('true');
    expect(trigger.getAttribute('aria-label')).toMatch(/^Reminder set for .* — change or cancel$/);
  });

  it('a custom past time is refused in the picker; a future one is sent as that instant', async () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('action-remind'));
    fireEvent.change(screen.getByTestId('mark-custom'), { target: { value: '2001-01-01T09:00' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mark-custom-set'));
    });
    expect(screen.getByTestId('mark-error').textContent).toBe('Pick a time in the future.');
    expect(calls('PUT')).toHaveLength(0);

    fireEvent.change(screen.getByTestId('mark-custom'), { target: { value: '2099-06-01T15:30' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mark-custom-set'));
    });
    await flush();
    const body = JSON.parse(String(calls('PUT')[0]![1]!.body)) as { due_at: string };
    expect(new Date(body.due_at).getTime()).toBe(new Date('2099-06-01T15:30').getTime());
  });

  it('a pending reminder shows its time; the same action re-sets it or cancels it', async () => {
    listed = [{ kind: 'snooze', channel_id: CH, message_id: MSG, due_at: '2099-01-01T09:00:00.000Z', state: 'pending' }];
    renderPicker();
    await waitFor(() => expect(screen.getByTestId('action-remind').getAttribute('data-pending')).toBe('true'));

    fireEvent.click(screen.getByTestId('action-remind'));
    expect(screen.getByTestId('mark-picker-pending')).toBeTruthy();

    // Re-set: another PUT on the same path (one reminder per message).
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('mark-preset')[0]!);
    });
    await flush();
    expect(calls('PUT')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('action-remind'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('mark-cancel'));
    });
    await flush();
    expect(calls('DELETE')).toHaveLength(1);
    expect(screen.getByTestId('action-remind').getAttribute('data-pending')).toBeNull();
  });

  it('a refusal rolls the optimistic state back and says why', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        return jsonResponse(409, { error: { key: 'cap_reached', message: 'You have too many pending reminders.' } });
      }
      return jsonResponse(200, { marks: [] });
    });
    renderPicker();
    fireEvent.click(screen.getByTestId('action-remind'));
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('mark-preset')[0]!);
    });
    await flush();

    expect(screen.getByTestId('mark-error').textContent).toBe('You have too many pending reminders.');
    expect(screen.getByTestId('action-remind').getAttribute('data-pending')).toBeNull();
  });

  it('Escape closes the picker and returns focus to the action', () => {
    renderPicker();
    const trigger = screen.getByTestId('action-remind');
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByTestId('mark-picker-root'), { key: 'Escape' });
    expect(screen.queryByTestId('mark-picker')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('offline: the action is disabled and says why', () => {
    renderPicker({ disabled: true });
    const trigger = screen.getByTestId('action-remind') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toMatch(/offline/);
  });

  it('has no axe violations when open', async () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('action-remind'));
    expect(await axe(screen.getByTestId('mark-picker-root'))).toHaveNoViolations();
  });
});

describe('reminder presets resolve in the local zone (KTD8)', () => {
  const at = (id: string, now: Date) => REMINDER_PRESETS.find((p) => p.id === id)!.at(now);

  it('tomorrow is 9:00 local the next day', () => {
    const r = at('tomorrow', new Date(2026, 8, 26, 22, 15));
    expect([r.getFullYear(), r.getMonth(), r.getDate(), r.getHours(), r.getMinutes()]).toEqual([2026, 8, 27, 9, 0]);
  });

  it('next week is the NEXT Monday at 9:00 — a Monday goes a full week ahead', () => {
    const fromSat = at('next-week', new Date(2026, 8, 26, 10, 0)); // Sat 26 Sep 2026
    expect([fromSat.getDate(), fromSat.getDay(), fromSat.getHours()]).toEqual([28, 1, 9]);
    const fromMon = at('next-week', new Date(2026, 8, 28, 8, 0)); // Mon 28 Sep
    expect([fromMon.getMonth(), fromMon.getDate(), fromMon.getDay()]).toEqual([9, 5, 1]);
  });
});
