/**
 * NicknameDialog (#169): your own nickname from the workspace menu, someone
 * else's from their profile. Seeded with the current nickname; Save sends
 * the trimmed value, blank or Reset clears; a refusal renders inline.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';
import { createStateStore } from '@cytale/state';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

vi.mock('../../auth/session.js', () => ({ api: { setNickname: vi.fn() } }));

import { NicknameDialog } from '../NicknameDialog.js';

const WS = '7700000000000060001';
const ME = '7000000000000001';
const BOB = '7000000000000002';

function storeWith(nicknames: Record<string, string> = {}) {
  const store = createStateStore();
  store.setState({
    currentUser: { id: ME, username: 'liddy', display_name: 'G. Gordon Liddy' },
    nicknamesByWorkspace: { [WS]: nicknames },
  });
  return store;
}

afterEach(() => cleanup());

describe('NicknameDialog', () => {
  it('your own: seeded with the current nickname, saves the trimmed value as @me', async () => {
    const setNickname = vi.fn().mockResolvedValue({});
    const onOpenChange = vi.fn();
    render(
      <NicknameDialog
        open
        onOpenChange={onOpenChange}
        workspaceId={WS}
        userId="@me"
        setNickname={setNickname}
        store={storeWith({ [ME]: 'Gemstone' })}
      />,
    );
    const input = screen.getByTestId('nickname-input') as HTMLInputElement;
    expect(input.value).toBe('Gemstone');
    expect(screen.getByText('Change Nickname')).toBeTruthy();

    fireEvent.change(input, { target: { value: '  Gordo  ' } });
    fireEvent.click(screen.getByTestId('nickname-save'));
    await waitFor(() => expect(setNickname).toHaveBeenCalledWith(WS, '@me', 'Gordo'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('the placeholder is your name without a nickname; Save is idle until something changes', () => {
    render(
      <NicknameDialog open onOpenChange={() => {}} workspaceId={WS} userId="@me" setNickname={vi.fn()} store={storeWith()} />,
    );
    expect((screen.getByTestId('nickname-input') as HTMLInputElement).placeholder).toBe('G. Gordon Liddy');
    expect((screen.getByTestId('nickname-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('nickname-reset')).toBeNull();
  });

  it('Reset clears the nickname (null)', async () => {
    const setNickname = vi.fn().mockResolvedValue({});
    render(
      <NicknameDialog
        open
        onOpenChange={() => {}}
        workspaceId={WS}
        userId="@me"
        setNickname={setNickname}
        store={storeWith({ [ME]: 'Gemstone' })}
      />,
    );
    fireEvent.click(screen.getByTestId('nickname-reset'));
    await waitFor(() => expect(setNickname).toHaveBeenCalledWith(WS, '@me', null));
  });

  it("someone else's: titled with their name, sent with their id; a 403 renders the refusal", async () => {
    const setNickname = vi
      .fn()
      .mockRejectedValue(new ApiError({ key: 'forbidden', code: 40003, message: 'nope', status: 403 }));
    const onOpenChange = vi.fn();
    render(
      <NicknameDialog
        open
        onOpenChange={onOpenChange}
        workspaceId={WS}
        userId={BOB}
        baseName="Bernard Barker"
        setNickname={setNickname}
        store={storeWith()}
      />,
    );
    expect(screen.getByText('Change Nickname for Bernard Barker')).toBeTruthy();
    fireEvent.change(screen.getByTestId('nickname-input'), { target: { value: 'Macho' } });
    fireEvent.click(screen.getByTestId('nickname-save'));
    await waitFor(() => expect(setNickname).toHaveBeenCalledWith(WS, BOB, 'Macho'));
    expect((await screen.findByTestId('nickname-error')).textContent).toContain("can't change this member's nickname");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('axe: no violations', async () => {
    const { baseElement } = render(
      <NicknameDialog open onOpenChange={() => {}} workspaceId={WS} userId="@me" setNickname={vi.fn()} store={storeWith({ [ME]: 'Gemstone' })} />,
    );
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
