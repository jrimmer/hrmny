/**
 * #30 — the bot-modal form: registry claim rules, the form's states, and the
 * submit contract (body shape, client validation mirroring the server).
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { InteractionModal } from '@cytale/protocol';

import { InteractionModalHost, fieldError } from '../InteractionModalHost.js';
import {
  claimInteraction,
  EARLY_MODAL_TTL_MS,
  modalStore,
  receiveModal,
  resetModalRegistry,
} from '../modalRegistry.js';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T> extends AxeMatchers {}
}

const MODAL: InteractionModal = {
  interaction_id: '9300000000000001',
  application_id: '8000000000000001',
  channel_id: '9007199254740993',
  custom_id: 'feedback',
  title: 'Tell us more',
  components: [
    {
      type: 1,
      components: [
        { type: 4, custom_id: 'subject', style: 1, label: 'Subject', min_length: 2, max_length: 20, required: true },
      ],
    },
    {
      type: 1,
      components: [
        {
          type: 4,
          custom_id: 'details',
          style: 2,
          label: 'Details',
          min_length: 0,
          max_length: 4000,
          required: false,
          value: 'prefilled',
          placeholder: 'What happened?',
        },
      ],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return JSON.parse(String(call[1]!.body)) as Record<string, unknown>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function open(modal: InteractionModal = MODAL): void {
  act(() => {
    claimInteraction(modal.interaction_id);
    receiveModal(modal);
  });
}

function field(customId: string): HTMLInputElement | HTMLTextAreaElement {
  return screen
    .getAllByTestId('interaction-modal-field')
    .find((f) => f.getAttribute('data-custom-id') === customId) as HTMLInputElement;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(202, { interaction_id: '9300000000000002' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  resetModalRegistry();
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true, writable: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('modal registry (#30)', () => {
  it('opens only a claimed interaction, whichever arrives first', () => {
    receiveModal(MODAL); // before the 202
    expect(modalStore.getState().queue).toEqual([]);
    const onOpen = vi.fn();
    claimInteraction(MODAL.interaction_id, onOpen);
    expect(modalStore.getState().queue).toEqual([MODAL]);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('an unclaimed early modal expires (it belonged to another tab)', () => {
    vi.useFakeTimers();
    receiveModal(MODAL);
    vi.advanceTimersByTime(EARLY_MODAL_TTL_MS + 1);
    claimInteraction(MODAL.interaction_id);
    expect(modalStore.getState().queue).toEqual([]);
  });

  it('subscribes to InteractionModal on the gateway it is given', () => {
    const handlers: Record<string, (p: InteractionModal) => void> = {};
    const gw = { on: vi.fn((t: string, h: (p: InteractionModal) => void) => ((handlers[t] = h), () => {})) };
    render(<InteractionModalHost gateway={gw as never} />);
    expect(gw.on).toHaveBeenCalledWith('InteractionModal', expect.any(Function));
    act(() => {
      claimInteraction(MODAL.interaction_id);
      handlers.InteractionModal!(MODAL);
    });
    expect(screen.getByTestId('interaction-modal')).toBeTruthy();
  });
});

describe('the form (#30)', () => {
  it('renders the title, labelled fields, the optional marker, prefill and placeholder', () => {
    render(<InteractionModalHost gateway={null} />);
    open();
    expect(screen.getByRole('dialog').textContent).toContain('Tell us more');
    expect(field('subject').tagName).toBe('INPUT');
    expect(field('details').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Subject')).toBe(field('subject'));
    expect(screen.getByText('(optional)')).toBeTruthy();
    expect(field('details').value).toBe('prefilled');
    expect(field('details').getAttribute('placeholder')).toBe('What happened?');
    // The first field takes focus.
    expect(document.activeElement).toBe(field('subject'));
  });

  it('client validation mirrors the server and blocks the submit', async () => {
    render(<InteractionModalHost gateway={null} />);
    open();
    await act(async () => {
      fireEvent.click(screen.getByTestId('interaction-modal-submit'));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(field('subject').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('This field is required.')).toBeTruthy();

    fireEvent.change(field('subject'), { target: { value: 'x' } });
    expect(screen.getByText('Use at least 2 characters.')).toBeTruthy();
  });

  it('a valid submit sends every answer in the modal order, then closes', async () => {
    render(<InteractionModalHost gateway={null} />);
    open();
    fireEvent.change(field('subject'), { target: { value: 'Broken build' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('interaction-modal-submit'));
    });
    await flush();
    expect(lastBody()).toEqual({
      kind: 'modal_submit',
      interaction_id: MODAL.interaction_id,
      custom_id: 'feedback',
      components: [
        { type: 1, components: [{ type: 4, custom_id: 'subject', value: 'Broken build' }] },
        { type: 1, components: [{ type: 4, custom_id: 'details', value: 'prefilled' }] },
      ],
    });
    expect(screen.queryByTestId('interaction-modal')).toBeNull();
  });

  it('Enter in a short field submits', async () => {
    render(<InteractionModalHost gateway={null} />);
    open();
    fireEvent.change(field('subject'), { target: { value: 'Quick' } });
    await act(async () => {
      fireEvent.submit(field('subject').closest('form')!);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('Cancel sends nothing and closes', () => {
    render(<InteractionModalHost gateway={null} />);
    open();
    fireEvent.click(screen.getByTestId('interaction-modal-cancel'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('interaction-modal')).toBeNull();
  });

  it('an expired / already-sent form is terminal: the message, and Close only', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(400, { error: { key: 'modal_unavailable', message: 'That form is no longer available.' } }),
    );
    render(<InteractionModalHost gateway={null} />);
    open();
    fireEvent.change(field('subject'), { target: { value: 'Late' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('interaction-modal-submit'));
    });
    await flush();
    expect(screen.getByTestId('interaction-modal-error').textContent).toContain('expired or was already sent');
    expect(screen.queryByTestId('interaction-modal-submit')).toBeNull();
    expect(screen.getByTestId('interaction-modal-cancel').textContent).toBe('Close');
  });

  it('a validation error keeps the form open and editable', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(400, { error: { key: 'validation_failed', message: "The form's answers do not match its fields." } }),
    );
    render(<InteractionModalHost gateway={null} />);
    open();
    fireEvent.change(field('subject'), { target: { value: 'Retry me' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('interaction-modal-submit'));
    });
    await flush();
    expect(screen.getByTestId('interaction-modal-error')).toBeTruthy();
    expect(field('subject').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('interaction-modal-submit')).toBeTruthy();
  });

  it('offline: submit is disabled with a note', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true, writable: true });
    render(<InteractionModalHost gateway={null} />);
    open();
    expect(screen.getByTestId('interaction-modal-offline')).toBeTruthy();
    expect((screen.getByTestId('interaction-modal-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no axe violations', async () => {
    render(<InteractionModalHost gateway={null} />);
    open();
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});

describe('fieldError', () => {
  const short = MODAL.components[0]!.components[0];
  it('refuses a line break in a short input, whatever else holds', () => {
    expect(fieldError(short, 'two\nlines')).toBe('Keep this to a single line.');
  });
  it('counts user-perceived characters, not code units', () => {
    // Two flags = 2 graphemes, 8 UTF-16 code units: within max 20 and min 2.
    expect(fieldError(short, '🇯🇵🇺🇸')).toBeNull();
  });
});
