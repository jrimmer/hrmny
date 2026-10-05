/**
 * @cytale/web — the in-app permalink chip (#118).
 *
 * Three things are pinned here, and all three are contracts rather than
 * cosmetics:
 *
 *   1. WHICH hrefs are ours (`instancePermalinkTarget`) — a link to any other
 *      host must never start a request, and a shorter permalink form (a
 *      channel, a workspace) carries no author or snippet to show;
 *   2. what the chip says and how a reader reaches it — channel, author, the
 *      target's own first words, with an accessible name that spells the
 *      relationship out and a real focusable anchor underneath;
 *   3. that it ALWAYS degrades — still resolving, 404, transport failure, an
 *      unknown channel or an unnameable author all render the plain link the
 *      message already contained, because a chip must never be the reason a
 *      message fails to render, nor a way to learn anything about a message
 *      the reader cannot read.
 *
 * `api.getMessage` is spied (the same seam MessageItem's own suite uses)
 * rather than fetch stubbed: the count of calls IS the "one point read,
 * cached, deduped" claim.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { defaultStore } from '@cytale/state';

import { api } from '../../auth/session.js';
import { renderMarkdown, type PermalinkChipRenderer } from '../markdown.js';
import { instancePermalinkTarget } from '../messagePermalink.js';
import {
  CHIP_CACHE_MAX,
  PermalinkChip,
  forgetPermalinkChipMessages,
  permalinkChipCacheSizesForTests,
  resolvePermalinkChipMessage,
} from '../permalinkChip.js';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const ORIGIN = globalThis.location.origin;
const WS = '1001';
const CHANNEL = '2002';
const TARGET = '3003';
const AUTHOR = '7000000000000001';
const ME = '7000000000000002';
const CHANNEL_NAME = 'release-war-room';
const AUTHOR_NAME = 'Dana Scully';
const HREF = `${ORIGIN}/#/workspace/1001/channel/2002/message/3003`;
const TARGET_TEXT = 'the deploy is green';

/** The store a chip reads names from — the reader's own roster. */
function seedStore(): void {
  defaultStore.setState({
    currentUser: { id: ME, username: 'me', avatar_url: null } as never,
    channels: {
      [CHANNEL]: {
        id: CHANNEL,
        workspace_id: WS,
        name: CHANNEL_NAME,
        type: 'text',
        topic: null,
        position: 0,
        last_message_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      [WS]: {
        id: WS,
        workspace_id: null,
        name: null,
        type: 'dm',
        topic: null,
        position: 0,
        last_message_id: null,
        recipients: [{ id: AUTHOR, username: 'dana-peer' }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never,
    membersById: {
      [AUTHOR]: {
        id: AUTHOR,
        username: 'dana',
        nickname: AUTHOR_NAME,
        roles: [],
        joined_at: '2026-01-01T00:00:00.000Z',
      },
    } as never,
  });
}

/** The payload #114's resolver answers with (the fields a chip reads). */
const resolvedMessage = {
  id: TARGET,
  channel_id: CHANNEL,
  thread_id: null,
  author_id: AUTHOR,
  content: TARGET_TEXT,
  created_at: '2026-09-14T12:00:00Z',
  edited_at: null,
};

const chipTarget = () => {
  const target = instancePermalinkTarget(HREF);
  if (target === null) throw new Error('fixture href must parse');
  return target;
};

const chip = () =>
  render(<PermalinkChip href={HREF} text={HREF} target={chipTarget()} store={defaultStore} />);

beforeEach(() => {
  seedStore();
  forgetPermalinkChipMessages();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetPermalinkChipMessages();
});

describe('instancePermalinkTarget — which hrefs are OURS', () => {
  it('reads a same-instance message permalink, in either spelling', () => {
    expect(instancePermalinkTarget(HREF)).toMatchObject({
      kind: 'message',
      workspaceId: WS,
      channelId: CHANNEL,
      messageId: TARGET,
    });
    // The origin-relative spelling of the same address, and the DM form.
    expect(instancePermalinkTarget(`/#/workspace/${WS}/channel/${CHANNEL}/message/${TARGET}`)).toMatchObject({ messageId: TARGET });
    expect(instancePermalinkTarget(`/#/channel/${CHANNEL}/message/${TARGET}`)).toMatchObject({
      workspaceId: undefined,
      channelId: CHANNEL,
      messageId: TARGET,
    });
    // A link copied before #118 (decimal ids) is still one of ours.
    expect(instancePermalinkTarget(`${ORIGIN}/#/workspace/1001/channel/2002/message/3003`)).toMatchObject({ messageId: TARGET });
  });

  it('refuses every href that is not a message address on this instance', () => {
    for (const href of [
      'https://elsewhere.example/#/workspace/1/channel/2/message/3', // another host
      `${ORIGIN}/#/workspace/1/channel/2`, // a channel, not a message
      `${ORIGIN}/#/workspace/1`, // a workspace
      `${ORIGIN}/#/workspace/1/channel/2/thread/4`, // a thread
      `${ORIGIN}/somewhere-else/#/workspace/1/channel/2/message/3`, // not the SPA root
      `${ORIGIN}/api/v1/channels/2/messages/3`, // the REST route, not an address
      'https://example.com/', // a plain link
      'javascript:alert(1)', // a scheme the link policy refuses anyway
      '', // nothing
    ]) {
      expect(
        instancePermalinkTarget(href),
        `expected ${JSON.stringify(href)} not to be a chip target`,
      ).toBeNull();
    }
  });

  it('uses the CONFIGURED origin, not the webview (the packaged shell case)', () => {
    const shell = 'https://chat.example.com';
    const href = `${shell}/#/workspace/1/channel/2/message/3`;
    expect(instancePermalinkTarget(href, shell)).toMatchObject({ messageId: '3' });
    // The shell's own origin is `tauri://localhost` — never a match.
    expect(instancePermalinkTarget(href, 'tauri://localhost')).toBeNull();
    // An unknown origin (no configured origin and no `location`) matches nothing.
    expect(instancePermalinkTarget(href, '')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #118 option B — the `/m/<token>` form is ours too
// ---------------------------------------------------------------------------
//
// The newer, preferred spelling: one opaque token, resolved server-side. It
// must be recognized by the SAME rule (this instance's origin), carry the SAME
// chip, and degrade the SAME way — the token only inserts one more step
// (resolve the token, then the message) before the chip can render.

/** A token shaped exactly like a minted one (30 base62 characters). */
const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';
const TOKEN_HREF = `${ORIGIN}/m/${TOKEN}`;

/** What `GET /permalinks/{token}` answers for TOKEN (the resolver's payload). */
const TOKEN_RESOLUTION = { channel_id: CHANNEL, message_id: TARGET };

/** The chip renderer MessageItem wires into `renderMarkdown` (#118). */
const renderChip: PermalinkChipRenderer = (href, text, target, key) => (
  <PermalinkChip key={key} href={href} text={text} target={target} store={defaultStore} />
);

/** A message BODY, rendered exactly the way a message row renders one. */
const renderBody = (body: string) =>
  render(<div>{renderMarkdown(body, undefined, renderChip)}</div>);

describe('instancePermalinkTarget — the /m/<token> form', () => {
  it('reads a same-instance token permalink, absolute or page-relative', () => {
    expect(instancePermalinkTarget(TOKEN_HREF)).toEqual({ kind: 'token', token: TOKEN });
    // The origin-relative spelling of the same address — this page's instance
    // by construction.
    expect(instancePermalinkTarget(`/m/${TOKEN}`)).toEqual({ kind: 'token', token: TOKEN });
    // The CONFIGURED origin decides here too (the packaged shell case).
    expect(instancePermalinkTarget(`${ORIGIN}/m/${TOKEN}`, ORIGIN)).toEqual({
      kind: 'token',
      token: TOKEN,
    });
    expect(
      instancePermalinkTarget(`https://chat.example.com/m/${TOKEN}`, 'https://chat.example.com'),
    ).toEqual({ kind: 'token', token: TOKEN });
    // The shell's own origin, and an unknown one, match nothing.
    expect(instancePermalinkTarget(TOKEN_HREF, 'tauri://localhost')).toBeNull();
    expect(instancePermalinkTarget(TOKEN_HREF, '')).toBeNull();
  });

  it('refuses every token-shaped href that is not exactly a token path', () => {
    for (const href of [
      `https://elsewhere.example/m/${TOKEN}`, // another host: never a request
      `${ORIGIN}/m/${TOKEN}#/workspace/1/channel/2/message/3`, // a fragment we never wrote
      `${ORIGIN}/m/`, // no token at all
      `${ORIGIN}/m/${TOKEN}/extra`, // a suffix the route cannot read
      `${ORIGIN}/m/${'a'.repeat(65)}`, // past the token length cap
      `${ORIGIN}/m/${TOKEN}%20`, // a token is an id-shaped segment, never encoded
      `${ORIGIN}/somewhere-else/m/${TOKEN}`, // neither the SPA root nor the token route
    ]) {
      expect(
        instancePermalinkTarget(href),
        `expected ${JSON.stringify(href)} not to be a chip target`,
      ).toBeNull();
    }
    // An unknown origin (no configured origin and no `location`) matches
    // nothing at all — the same rule the `#/…` form obeys.
    expect(instancePermalinkTarget(TOKEN_HREF, '')).toBeNull();
  });
});

describe('#118 option B — the chip a resolved token renders', () => {
  it('resolves the token, then shows channel, author and the message\u2019s own words', async () => {
    const resolve = vi.spyOn(api, 'resolvePermalink').mockResolvedValue(TOKEN_RESOLUTION);
    const getMessage = vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { container } = renderBody(`the deploy link ${TOKEN_HREF} for you`);
    const el = await screen.findByTestId('permalink-chip');

    expect(el.textContent).toContain(`#${CHANNEL_NAME}`);
    expect(el.textContent).toContain(AUTHOR_NAME);
    expect(el.textContent).toContain(TARGET_TEXT);
    // A real anchor whose href is the token the sender pasted — the link on the
    // clipboard is what stays on the clipboard.
    expect(el.getAttribute('href')).toBe(TOKEN_HREF);
    expect(el.getAttribute('data-message-id')).toBe(TARGET);
    expect(container.querySelector('.link')).toBeNull();
    // The body's own words survive around it.
    expect(container.textContent).toContain('the deploy link');
    expect(container.textContent).toContain('for you');
    // The resolve is the one the `/m/<token>` landing makes, and the chip reads
    // the message through the SAME point read a legacy link uses.
    expect(resolve).toHaveBeenCalledWith(TOKEN);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledWith(CHANNEL, TARGET);
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('still chips the legacy #/… form, in the same body', async () => {
    vi.spyOn(api, 'resolvePermalink').mockResolvedValue(TOKEN_RESOLUTION);
    const getMessage = vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    renderBody(`${HREF} and ${TOKEN_HREF}`);

    const chips = await screen.findAllByTestId('permalink-chip');
    expect(chips.map((chip) => chip.getAttribute('href'))).toEqual([HREF, TOKEN_HREF]);
    for (const chip of chips) {
      expect(chip.textContent).toContain(`#${CHANNEL_NAME}`);
      expect(chip.textContent).toContain(AUTHOR_NAME);
      expect(chip.textContent).toContain(TARGET_TEXT);
    }
    // One message, addressed two ways: the legacy half needs no token resolve,
    // and both halves share the one point read.
    expect(api.resolvePermalink).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
  });
});

describe('#118 option B — a /m/<token> degrades to the plain link — always', () => {
  /**
   * The exact anchor the renderer emits for any other link. Asserted on the
   * ELEMENT (href, class, target), not merely on the chip's absence: "no chip"
   * is only degraded if the link is still a link.
   */
  const expectPlainTokenLink = (container: HTMLElement, href = TOKEN_HREF) => {
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe(href);
    expect(anchor!.textContent).toBe(href);
    expect(anchor!.className).toBe('link');
    expect(anchor!.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('[data-testid="permalink-chip"]')).toBeNull();
  };

  it('while the token resolve is in flight (a chip is not worth a spinner)', () => {
    const resolve = vi.spyOn(api, 'resolvePermalink').mockReturnValue(
      new Promise(() => undefined) as never,
    );
    const getMessage = vi.spyOn(api, 'getMessage');

    const { container } = renderBody(TOKEN_HREF);
    expectPlainTokenLink(container);
    expect(resolve).toHaveBeenCalledWith(TOKEN);
    // The ids are the server's to disclose: until it does, nothing is asked of
    // the message route at all.
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('on a token that does not resolve (404 — gone, tampered, or not for this reader)', async () => {
    const resolve = vi.spyOn(api, 'resolvePermalink').mockRejectedValue(
      Object.assign(new Error('No permalink with that token'), { status: 404 }),
    );
    const getMessage = vi.spyOn(api, 'getMessage');

    const { container } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expectPlainTokenLink(container);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('on a transport failure resolving the token (offline, a 500)', async () => {
    const resolve = vi.spyOn(api, 'resolvePermalink').mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    const { container } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expectPlainTokenLink(container);
  });

  it('when the token resolves but the message read fails (transport, then 404)', async () => {
    vi.spyOn(api, 'resolvePermalink').mockResolvedValue(TOKEN_RESOLUTION);
    const getMessage = vi.spyOn(api, 'getMessage').mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    const { container } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(getMessage).toHaveBeenCalledWith(CHANNEL, TARGET));
    expectPlainTokenLink(container);
  });

  it('when the reader\u2019s roster cannot name the author', async () => {
    defaultStore.setState({ membersById: {} as never });
    vi.spyOn(api, 'resolvePermalink').mockResolvedValue(TOKEN_RESOLUTION);
    vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { container } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainTokenLink(container);
  });

  it('when the store does not know the channel the token names', async () => {
    defaultStore.setState({ channels: {} as never });
    vi.spyOn(api, 'resolvePermalink').mockResolvedValue(TOKEN_RESOLUTION);
    vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { container } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainTokenLink(container);
  });

  it('when the target has no text to preview (an attachment-only message)', async () => {
    vi.spyOn(api, 'resolvePermalink').mockResolvedValue(TOKEN_RESOLUTION);
    vi.spyOn(api, 'getMessage').mockResolvedValue({ ...resolvedMessage, content: '' } as never);

    const { container } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainTokenLink(container);
  });

  it('for a href that only LOOKS like a token link, asking nothing', () => {
    const resolve = vi.spyOn(api, 'resolvePermalink');
    const getMessage = vi.spyOn(api, 'getMessage');

    for (const href of [
      `${ORIGIN}/m/${TOKEN}/extra`,
      `${ORIGIN}/m/`,
      `${ORIGIN}/m/${TOKEN}#/workspace/1/channel/2/message/3`,
      `https://elsewhere.example/m/${TOKEN}`,
    ]) {
      const { container, unmount } = renderBody(href);
      expectPlainTokenLink(container, href);
      unmount();
    }

    expect(resolve).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();
  });
});

describe('#118 option B — a token leaks nothing either', () => {
  it('renders only what the pasted URL already said when the resolve is refused', async () => {
    // The store knows the channel AND the author, so a chip built from the
    // store rather than from a RESOLVED message would show both. The server
    // refuses the token (which is also what it answers for a channel this
    // reader cannot see), and nothing but the URL may render.
    const resolve = vi.spyOn(api, 'resolvePermalink').mockRejectedValue(
      Object.assign(new Error('No permalink with that token'), { status: 404 }),
    );
    const getMessage = vi.spyOn(api, 'getMessage');

    const { container } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(resolve).toHaveBeenCalled());

    expect(container.querySelector('[data-testid="permalink-chip"]')).toBeNull();
    // The link, exactly as the sender wrote it…
    expect(container.textContent).toBe(TOKEN_HREF);
    expect(container.querySelector('a')!.getAttribute('href')).toBe(TOKEN_HREF);
    // …and no channel, no author, no snippet.
    expect(container.textContent).not.toContain(CHANNEL_NAME);
    expect(container.textContent).not.toContain(AUTHOR_NAME);
    expect(container.textContent).not.toContain(TARGET_TEXT);
    // Nor are the ids the store could pair with the token ever fetched: the
    // token's answer is the only thing that may unpick it.
    expect(getMessage).not.toHaveBeenCalled();
  });
});

describe('#118 option B — cost — one token resolve per unique token, deduped', () => {
  it('resolves a token quoted twice in ONE body once, and a re-mount from none', async () => {
    const resolve = vi.spyOn(api, 'resolvePermalink').mockResolvedValue(TOKEN_RESOLUTION);
    const getMessage = vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { unmount } = renderBody(`[first](${TOKEN_HREF}) and [second](${TOKEN_HREF})`);
    expect(await screen.findAllByTestId('permalink-chip')).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledTimes(1);

    // Cached by TOKEN for the session, not per render: a remounted row
    // (virtualized scrollback) — and a channel page that re-renders constantly
    // — costs nothing.
    unmount();
    renderBody(TOKEN_HREF);
    expect(await screen.findByTestId('permalink-chip')).toBeTruthy();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failed token resolve — a drop is not a verdict', async () => {
    const resolve = vi
      .spyOn(api, 'resolvePermalink')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(TOKEN_RESOLUTION);
    vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { container, unmount } = renderBody(TOKEN_HREF);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-testid="permalink-chip"]')).toBeNull();

    // A later mount tries again and the chip appears.
    unmount();
    renderBody(TOKEN_HREF);
    expect(await screen.findAllByTestId('permalink-chip')).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe('the chip a resolved message renders', () => {
  it('shows channel, author and the target\u2019s own words', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { container } = chip();
    const el = await screen.findByTestId('permalink-chip');

    expect(el.textContent).toContain(`#${CHANNEL_NAME}`);
    expect(el.textContent).toContain(AUTHOR_NAME);
    expect(el.textContent).toContain(TARGET_TEXT);
    expect(container.querySelector('.link')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is a real focusable link whose accessible name says what it is', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    chip();
    const el = (await screen.findByTestId('permalink-chip')) as HTMLAnchorElement;

    // A real anchor: same href (a middle-click or Copy Link Address behaves
    // as it did before the chip), same new-tab posture as every other link.
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe(HREF);
    expect(el.getAttribute('target')).toBe('_blank');
    expect(el.getAttribute('rel')).toBe('noreferrer noopener');

    // …and a name that spells out channel + author + "link", since the visual
    // text alone leaves the relationship implicit.
    expect(
      screen.getByRole('link', {
        name: new RegExp(`Link to a message in #${CHANNEL_NAME} from ${AUTHOR_NAME}`),
      }),
    ).toBe(el);

    // Focusable, not merely clickable (WCAG 2.1 keyboard reachability).
    el.focus();
    expect(document.activeElement).toBe(el);
  });

  it('caps the snippet instead of spilling the message into the row', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue({
      ...resolvedMessage,
      content: `${'word '.repeat(60)}end`,
    } as never);

    chip();
    const el = await screen.findByTestId('permalink-chip');
    const snippet = el.querySelector('.permalink-chip-snippet')!.textContent ?? '';
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(80);
  });

  it('reads the snippet as the shared plain preview: no markup, no raw channel token', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue({
      ...resolvedMessage,
      content: '**green** on `main` — see <#999999999999>',
    } as never);

    chip();
    const el = await screen.findByTestId('permalink-chip');
    const snippet = el.querySelector('.permalink-chip-snippet')!.textContent ?? '';
    expect(snippet).toBe('green on main — see #unknown-channel');
  });

  it('names a DM message by its peer (a DM has no channel name)', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue({ ...resolvedMessage, channel_id: WS } as never);
    const dmHref = `${ORIGIN}/#/channel/${WS}/message/${TARGET}`;

    render(
      <PermalinkChip
        href={dmHref}
        text={dmHref}
        target={instancePermalinkTarget(dmHref)!}
        store={defaultStore}
      />,
    );

    const el = await screen.findByTestId('permalink-chip');
    expect(el.textContent).toContain('dana-peer');
  });
});

describe('it degrades to the plain link — always', () => {
  /** The exact anchor the renderer emits for any other link. */
  const expectPlainLink = (container: HTMLElement) => {
    const anchor = container.querySelector('a');
    expect(container.querySelector('[data-testid="permalink-chip"]')).toBeNull();
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe(HREF);
    expect(anchor!.textContent).toBe(HREF);
    expect(anchor!.className).toBe('link');
  };

  it('while the resolution is in flight (a chip is not worth a spinner)', () => {
    vi.spyOn(api, 'getMessage').mockReturnValue(new Promise(() => undefined) as never);
    const { container } = chip();
    expectPlainLink(container);
  });

  it('on 404 — gone, or not for this reader', async () => {
    vi.spyOn(api, 'getMessage').mockRejectedValue(
      Object.assign(new Error('No message with that id'), { status: 404 }),
    );
    const { container } = chip();
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainLink(container);
  });

  it('on a transport failure (offline, a 500)', async () => {
    vi.spyOn(api, 'getMessage').mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = chip();
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainLink(container);
  });

  it('when the reader\u2019s roster cannot name the author', async () => {
    defaultStore.setState({ membersById: {} as never });
    vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { container } = chip();
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainLink(container);
  });

  it('when the store does not know the channel', async () => {
    defaultStore.setState({ channels: {} as never });
    vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { container } = chip();
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainLink(container);
  });

  it('when the target has no text to preview (an attachment-only message)', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue({ ...resolvedMessage, content: '' } as never);

    const { container } = chip();
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());
    expectPlainLink(container);
  });
});

describe('a chip leaks nothing about a message the reader cannot have', () => {
  it('renders only what the pasted URL already said when the resolve is refused', async () => {
    // The store knows the channel AND the author (this reader is a member) —
    // so a chip built from the store rather than from the RESOLVED message
    // would show both. The resolve is refused, and nothing may show.
    vi.spyOn(api, 'getMessage').mockRejectedValue(
      Object.assign(new Error('No message with that id'), { status: 404 }),
    );

    const { container } = chip();
    await waitFor(() => expect(api.getMessage).toHaveBeenCalled());

    expect(container.querySelector('[data-testid="permalink-chip"]')).toBeNull();
    // The link, exactly as the sender wrote it…
    expect(container.textContent).toBe(HREF);
    // …and no channel, no author, no snippet.
    expect(container.textContent).not.toContain(CHANNEL_NAME);
    expect(container.textContent).not.toContain(AUTHOR_NAME);
    expect(container.textContent).not.toContain(TARGET_TEXT);
  });
});

describe('cost — one point read per unique target, deduped', () => {
  it('serves two copies of the same link from one request, and a re-mount from none', async () => {
    const getMessage = vi.spyOn(api, 'getMessage').mockResolvedValue(resolvedMessage as never);

    const { unmount } = render(
      <>
        <PermalinkChip href={HREF} text={HREF} target={chipTarget()} store={defaultStore} />
        <PermalinkChip href={HREF} text={HREF} target={chipTarget()} store={defaultStore} />
      </>,
    );
    expect(await screen.findAllByTestId('permalink-chip')).toHaveLength(2);
    expect(getMessage).toHaveBeenCalledTimes(1);

    unmount();
    chip();
    expect(await screen.findByTestId('permalink-chip')).toBeTruthy();
    // Cached for the session: a remounted row (virtualized scrollback) costs
    // nothing.
    expect(getMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure — a drop is not a verdict', async () => {
    const getMessage = vi
      .spyOn(api, 'getMessage')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(resolvedMessage as never);

    const { container } = chip();
    await waitFor(() => expect(getMessage).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-testid="permalink-chip"]')).toBeNull();

    // A later mount tries again and the chip appears.
    cleanup();
    chip();
    expect(await screen.findAllByTestId('permalink-chip')).toHaveLength(1);
    expect(getMessage).toHaveBeenCalledTimes(2);
  });
});

describe('chip cache bound (lane D #16)', () => {
  it('keeps at most CHIP_CACHE_MAX resolved messages', async () => {
    forgetPermalinkChipMessages();
    const spy = vi.spyOn(api, 'getMessage').mockImplementation(async (channelId, messageId) => ({
      id: messageId,
      channel_id: channelId,
      thread_id: null,
      author_id: '7000000000000001',
      content: 'x',
      created_at: '2026-09-27T00:00:00Z',
      edited_at: null,
    }));
    for (let i = 0; i < CHIP_CACHE_MAX + 25; i++) {
      await resolvePermalinkChipMessage('9007199254740993', String(1000000000000000 + i));
    }
    expect(permalinkChipCacheSizesForTests().messages).toBe(CHIP_CACHE_MAX);
    // The most recent entry is still a hit (no second read).
    const calls = spy.mock.calls.length;
    await resolvePermalinkChipMessage('9007199254740993', String(1000000000000000 + CHIP_CACHE_MAX + 24));
    expect(spy.mock.calls.length).toBe(calls);
    spy.mockRestore();
    forgetPermalinkChipMessages();
  });
});
