/**
 * @cytale/web — MessageItem tests (U21 slice 2, U12 attribution/embeds).
 *
 * Markdown renders, @mentions highlight + link, attachments render
 * (image vs file), hover actions show for the author (edit/delete) and
 * hide for non-authors (unless MANAGE_MESSAGES).
 *
 * U12: the shared KindBadge renders for bot/agent/webhook authors with the
 * parent named in title + screen-reader text (humans/unknowns render
 * nothing — the rule of one); webhook `author_override.username` wins the
 * displayed name (avatar_url stored-only); `embeds` render as text-only
 * cards below the content, degrading on malformed JSON. axe runs at desktop
 * and mobile widths over a list fixture containing every principal kind.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  render as rtlRender,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import React from 'react';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import type { PrincipalKind } from '@cytale/domain';
import { defaultStore } from '@cytale/state';

import { api } from '../../auth/session.js';
import { MessageItem } from '../MessageItem.js';
import { forgetPermalinkChipMessages } from '../permalinkChip.js';
import { ReactionPicker } from '../ReactionPicker.js';
import { REACTION_PALETTE, reactionAriaLabel } from '../ReactionPicker.js';
import type { MessageEmbed, MessageWithBots } from '../types.js';
import { mobileWidthState, coarsePointerState } from '../../../test/setup.js';
import { revealMessageActions } from '../../../test/revealActions.js';

const ME = '7000000000000002';

/** A server-minted media-proxy URL (the only shape the web loads). */
const proxied = (name: string) => `/api/v1/media/proxy?u=${name}&e=1900000000&s=sig-${name}`;

/**
 * The hover toolbar mounts on the row's first hover/focus (#14). These tests
 * are about what the toolbar CONTAINS, so every render hovers its rows — the
 * way a reader's pointer builds it — before the assertions run.
 */
function render(...args: Parameters<typeof rtlRender>): ReturnType<typeof rtlRender> {
  const result = rtlRender(...args);
  revealMessageActions(result.container);
  const rerender = result.rerender;
  result.rerender = (ui) => {
    rerender(ui);
    revealMessageActions(result.container);
  };
  return result;
}
const OTHER = '7000000000000001';

function makeMessage(overrides: Partial<MessageWithBots> = {}): MessageWithBots {
  return {
    id: '1000000000000001',
    channel_id: '9007199254740993',
    thread_id: null,
    author_id: OTHER,
    content: 'hello',
    created_at: '2026-08-30T12:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('MessageItem', () => {
  it('renders author, time, and content', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} />);
    expect(screen.getByTestId('message-author').textContent).toBe(OTHER);
    expect(screen.getByTestId('message-content').textContent).toContain('hello');
  });

  it('the header reads name, @tag, time (owner, 2026-09-27)', () => {
    render(
      <MessageItem message={makeMessage()} currentUserId={ME} authorName="Jordan" authorTag="jordan" />,
    );
    const author = screen.getByTestId('message-author');
    const tag = screen.getByTestId('message-author-tag');
    const time = screen.getByTestId('message-time');
    expect(author.textContent).toBe('Jordan');
    expect(tag.textContent).toBe('@jordan');
    // Order in the row: name, then tag, then time.
    expect(author.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tag.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no tag when it would only repeat the name, or for a webhook identity', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} authorName="jordan" authorTag="jordan" />);
    expect(screen.queryByTestId('message-author-tag')).toBeNull();
    cleanup();
    render(
      <MessageItem
        message={makeMessage({ author_override: { username: 'Deploy Bot' } } as Partial<MessageWithBots>)}
        currentUserId={ME}
        authorName="jordan"
        authorTag="jordan"
      />,
    );
    expect(screen.getByTestId('message-author').textContent).toBe('Deploy Bot');
    expect(screen.queryByTestId('message-author-tag')).toBeNull();
  });

  it('renders markdown: bold, italic, inline code, link', () => {
    const msg = makeMessage({
      content: '**bold** *italic* `code` [link](https://example.com)',
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const content = screen.getByTestId('message-content');
    expect(content.querySelector('strong')?.textContent).toBe('bold');
    expect(content.querySelector('em')?.textContent).toBe('italic');
    expect(content.querySelector('code')?.textContent).toBe('code');
    const link = content.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com');
  });

  it('renders a refused link scheme as plain text, not an anchor', () => {
    // The body is peer-authored and the grammar accepts any whitespace-free
    // target, so the renderer is the last gate before the browser acts on it:
    // `javascript:` and app-handoff schemes must never become clickable.
    const msg = makeMessage({
      content: '[click](javascript:alert(1)) and [call](tel:+15551234567)',
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const content = screen.getByTestId('message-content');
    expect(content.querySelectorAll('a')).toHaveLength(0);
    expect(content.textContent).toContain('click');
    expect(content.textContent).toContain('call');
  });

  it('renders @mentions resolved through the host resolver; raw id is the last resort', () => {
    const msg = makeMessage({ content: 'ping <@7000000000000001>' });
    const { rerender } = render(
      <MessageItem
        message={msg}
        currentUserId={ME}
        resolveMention={(id) => (id === '7000000000000001' ? 'alice' : undefined)}
      />,
    );
    const mention = screen.getByTestId('message-content').querySelector('.mention');
    expect(mention).toBeTruthy();
    expect(mention?.getAttribute('data-user-id')).toBe('7000000000000001');
    expect(mention?.textContent).toBe('@alice');

    // No resolver / unresolved id → the honest raw-snowflake pill.
    rerender(<MessageItem message={msg} currentUserId={ME} />);
    expect(
      screen.getByTestId('message-content').querySelector('.mention')?.textContent,
    ).toBe('@7000000000000001');
  });

  it('renders image attachments inline and file attachments as links', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: '2000000000000001',
          message_id: '1000000000000001',
          filename: 'pic.png',
          content_type: 'image/png',
          size: 1024,
          url: '/api/v1/attachments/pic.png',
        },
        {
          id: '2000000000000002',
          message_id: '1000000000000001',
          filename: 'doc.pdf',
          content_type: 'application/pdf',
          size: 2048,
          url: '/api/v1/attachments/doc.pdf',
        },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.getByTestId('attachment-image')).toBeTruthy();
    expect(screen.getByTestId('attachment-file').textContent).toContain('doc.pdf');
  });

  // Tier 3 #5: attachment urls are message content (bots, webhooks, compat
  // clients write them) — only the server's own attachment path is a trusted
  // chip/preview; an external URL is marked as such; a script URL is no link.
  it('attachment urls: same-origin path links, external is marked, javascript: is never a link', () => {
    const base = { message_id: '1000000000000001', content_type: 'application/pdf', size: 10 };
    const msg = makeMessage({
      attachments: [
        { ...base, id: '2000000000000001', filename: 'ok.pdf', url: '/api/v1/attachments/ok.pdf?e=1&s=2' },
        { ...base, id: '2000000000000002', filename: 'away.pdf', url: 'https://evil.example/away.pdf' },
        { ...base, id: '2000000000000003', filename: 'xss.pdf', url: 'javascript:alert(1)' },
        {
          ...base,
          id: '2000000000000004',
          filename: 'pixel.png',
          content_type: 'image/png',
          url: 'https://tracker.example/pixel.png',
        },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);

    const chips = screen.getAllByTestId('attachment-file');
    const byName = (name: string) => chips.find((c) => c.textContent?.includes(name))!;

    expect(byName('ok.pdf').getAttribute('href')).toBe('/api/v1/attachments/ok.pdf?e=1&s=2');
    expect(byName('ok.pdf').getAttribute('data-link')).toBe('attachment');

    expect(byName('away.pdf').getAttribute('href')).toBe('https://evil.example/away.pdf');
    expect(byName('away.pdf').getAttribute('data-link')).toBe('external');
    expect(byName('away.pdf').textContent).toContain('evil.example');

    expect(byName('xss.pdf').tagName).toBe('SPAN');
    expect(byName('xss.pdf').getAttribute('href')).toBeNull();

    // A foreign "image" attachment is not previewed inline (no tracking
    // pixel fetched for every viewer) — it is an external chip.
    expect(screen.queryByTestId('attachment-image')).toBeNull();
    expect(byName('pixel.png').getAttribute('data-link')).toBe('external');

    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  // #10: a lazy image with no box grew its row after the list measured it —
  // the reader scrolled up was shifted and the bottom pin fought the growth.
  it('reserves the image box before load: intrinsic ratio clamped, fixed box when unknown', () => {
    const base = {
      message_id: '1000000000000001',
      content_type: 'image/png',
      size: 1024,
    };
    const msg = makeMessage({
      attachments: [
        { ...base, id: '2000000000000001', filename: 'wide.png', url: '/api/v1/attachments/wide.png', width: 1600, height: 900 },
        { ...base, id: '2000000000000002', filename: 'tall.png', url: '/api/v1/attachments/tall.png', width: 300, height: 1200 },
        { ...base, id: '2000000000000003', filename: 'small.png', url: '/api/v1/attachments/small.png', width: 64, height: 32 },
        { ...base, id: '2000000000000004', filename: 'old.png', url: '/api/v1/attachments/old.png' },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const [wide, tall, small, old] = screen.getAllByTestId('attachment-image');
    // Wide: clamped by width (320), ratio kept.
    expect(wide!.style.width).toBe('320px');
    expect(wide!.style.aspectRatio).toBe('1600 / 900');
    // Tall: clamped by height (256): 300 * 256/1200 = 64.
    expect(tall!.style.width).toBe('64px');
    expect(tall!.style.aspectRatio).toBe('300 / 1200');
    // Small: never scaled UP.
    expect(small!.style.width).toBe('64px');
    // Unknown: the fixed-height placeholder box.
    expect(old!.style.height).toBe('256px');
    expect(old!.getAttribute('data-sized')).toBe('fallback');
  });

  it('reserves embed media boxes from width/height hints, fixed box otherwise', () => {
    const msg = makeMessage({
      embeds: [
        { title: 'Hinted', image: { url: 'https://x/a.png', proxy_url: proxied('a'), width: 800, height: 400 } },
        { title: 'Bare', image: { url: 'https://x/b.png', proxy_url: proxied('b') } },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const [hinted, bare] = screen.getAllByTestId('embed-image-box');
    expect(hinted!.style.width).toBe('400px');
    expect(hinted!.style.aspectRatio).toBe('800 / 400');
    expect(bare!.style.height).toBe('200px');
  });

  it('shows edit + delete for the author', () => {
    const msg = makeMessage({ author_id: ME });
    render(
      <MessageItem
        message={msg}
        currentUserId={ME}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />,
    );
    expect(screen.getByTestId('action-edit')).toBeTruthy();
    expect(screen.getByTestId('action-delete')).toBeTruthy();
  });

  it('tints the hover-toolbar Delete red, like the touch sheet (and nothing else)', () => {
    // Owner decision 2026-09-27 (corpus §3b): the destructive action reads
    // danger in the toolbar exactly as it does in MessageActionsSheet.
    const msg = makeMessage({ author_id: ME });
    render(
      <MessageItem
        message={msg}
        currentUserId={ME}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />,
    );
    expect(screen.getByTestId('action-delete').className).toContain('text-danger');
    expect(screen.getByTestId('action-edit').className).not.toContain('text-danger');
    expect(screen.getByTestId('action-reply').className).not.toContain('text-danger');
  });

  it('hides edit for a non-author but shows delete with MANAGE_MESSAGES', () => {
    const msg = makeMessage({ author_id: OTHER });
    render(
      <MessageItem
        message={msg}
        currentUserId={ME}
        canManageMessages
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('action-edit')).toBeNull();
    expect(screen.getByTestId('action-delete')).toBeTruthy();
  });

  it('hides edit and delete for a non-author without MANAGE_MESSAGES', () => {
    const msg = makeMessage({ author_id: OTHER });
    render(
      <MessageItem
        message={msg}
        currentUserId={ME}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('action-edit')).toBeNull();
    expect(screen.queryByTestId('action-delete')).toBeNull();
  });
});

describe('MessageItem — hover toolbar reveal (regression pin)', () => {
  // jsdom has no layout, so the reveal is pinned at its SOURCES (the repo's
  // stylesheet-pin idiom). The bug: `group-focus-within:` matched a plain
  // mouse click — the row is tabIndex={-1}, so clicking focuses it — and the
  // toolbar stayed pinned open over the message ABOVE, making that row's
  // hover unreachable (user report 2026-09-11). Verified in a real browser:
  // click+pointer-away leaves it hidden, hover shows it, Tab into a link
  // inside a row shows it.
  it('reveals on hover and KEYBOARD focus, never on click-focus', () => {
    const src = readFileSync(join(__dirname, '..', 'MessageItem.tsx'), 'utf8');
    const toolbar = src.slice(src.indexOf('data-testid="message-actions"') - 400);
    const cls = toolbar.slice(0, toolbar.indexOf('>'));
    expect(cls, 'hover still reveals it').toContain('group-hover:opacity-100');
    expect(cls, 'click-focus must not reveal it').not.toContain('group-focus-within');

    const css = readFileSync(
      join(__dirname, '..', '..', '..', 'app', 'theme', 'shell.css'),
      'utf8',
    );
    // The keyboard half lives in CSS, keyed on :focus-visible.
    expect(css).toContain('.message-actions-host:has(:focus-visible)');
    // …and the row must carry that host class for the rule to match.
    expect(src).toContain('message-actions-host');
  });

  it('stays hidden at rest and reveals on hover (the hover-only contract)', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} onReply={vi.fn()} />);
    const bar = screen.getByTestId('message-actions');
    // `hidden` — not merely transparent. A laid-out rail adds its own overflow
    // to the message scroller and moves the timeline's settle point
    // (pane-layout.spec.ts), so at rest it must take no space at all; hidden
    // is also pointer-inert by construction.
    expect(bar.className).toContain('hidden');
    expect(bar.className).toContain('group-hover:flex');
    expect(bar.className).toContain('opacity-0');
    expect(bar.className).toContain('group-hover:opacity-100');
  });

  it('formats row timestamps through the cached helper, not a per-call locale call', () => {
    // Reason: a per-call `toLocaleTimeString` profiled as the hottest function
    // in the app during a wheel scroll (810 samples, 2026-09-12). Row
    // timestamps must go through app/ui/time.ts, whose formatters are built
    // once.
    const src = readFileSync(join(__dirname, '..', 'MessageItem.tsx'), 'utf8');
    expect(src).toContain("from '../../app/ui/time.js'");
    // The call form, not the bare word: the file legitimately *mentions*
    // toLocaleTimeString in the comment recording this fix.
    expect(src, 'no per-call locale formatting in the row').not.toContain('.toLocaleTimeString(');
    expect(src, 'no per-call locale formatting in the row').not.toContain('.toLocaleString(');
  });

  it('renders the configured placement, and an injected one wins', () => {
    const withDefault = render(
      <MessageItem message={makeMessage()} currentUserId={ME} onReply={vi.fn()} />,
    );
    expect(
      screen.getByTestId('message-actions').getAttribute('data-placement'),
      'the config default (the top-right pill) drives the placement',
    ).toBe('top-right');
    withDefault.unmount();

    render(
      <MessageItem
        message={makeMessage()}
        currentUserId={ME}
        onReply={vi.fn()}
        actionsPlacement="left-rail"
      />,
    );
    expect(screen.getByTestId('message-actions').getAttribute('data-placement')).toBe(
      'left-rail',
    );
  });
});

describe('MessageItem — reply context line', () => {
  const reply = (content: string) =>
    makeMessage({
      content: 'ack',
      referenced: {
        message_id: '1000000000000009',
        author_id: OTHER,
        author_username: 'jordan',
        content,
      },
    });

  it('renders a mention in the snippet as @name, never the raw wire token', () => {
    // The snippet is plain text and had no resolver, so it showed
    // `<@91666177033502720>` while the message body rendered the @max pill
    // (user report 2026-09-11).
    render(
      <MessageItem
        message={reply('<@9000000000000002> acceptance 1789141445 — reply with: ack')}
        currentUserId={ME}
        resolveMention={(id) => (id === '9000000000000002' ? 'max' : undefined)}
      />,
    );
    const snippet = screen.getByTestId('reply-context').textContent ?? '';
    expect(snippet).toContain('@max acceptance 1789141445');
    expect(snippet).not.toContain('<@');
    expect(snippet).not.toContain('9000000000000002');
    // The reply's own author still resolves as before.
    expect(snippet).toContain('jordan');
  });

  it('falls back to @id when the mention target is not resolvable', () => {
    render(
      <MessageItem message={reply('hi <@9000000000000007>')} currentUserId={ME} />,
    );
    const snippet = screen.getByTestId('reply-context').textContent ?? '';
    expect(snippet).toContain('@9000000000000007');
    // Still no raw angle-bracket token.
    expect(snippet).not.toContain('<@');
  });

  it('leaves a snippet without mentions exactly as authored', () => {
    render(<MessageItem message={reply('plain text here')} currentUserId={ME} />);
    expect(screen.getByTestId('reply-context').textContent).toContain('plain text here');
  });

  it('reads the quoted body as plain text, never raw markup (owner report 2026-09-28)', () => {
    render(
      <MessageItem
        message={reply('**Confirmed working:** the `deploy` step, <@9000000000000002>')}
        currentUserId={ME}
        resolveMention={(id) => (id === '9000000000000002' ? 'max' : undefined)}
      />,
    );
    const snippet = screen.getByTestId('reply-context').querySelector('.reply-context-snippet')!;
    expect(snippet.textContent).toBe('Confirmed working: the deploy step, @max');
  });

  it('sits as a quote block UNDER the header, above the reply text (owner, 2026-09-27)', () => {
    render(<MessageItem message={reply('the original line')} currentUserId={ME} />);
    const author = screen.getByTestId('message-author');
    const quote = screen.getByTestId('reply-context');
    const body = screen.getByTestId('message-content');
    expect(author.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quote.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Small avatar + name on the first line, one line of the original below.
    const head = quote.querySelector('.reply-context-head');
    expect(head?.querySelector('.reply-context-avatar')).not.toBeNull();
    expect(head?.querySelector('.reply-context-name')?.textContent).toBe('jordan');
    expect(quote.querySelector('.reply-context-snippet')?.textContent).toBe('the original line');
  });
});

describe('MessageItem — kind badge (U12)', () => {
  it.each([
    // Both machine kinds wear the same word (R1) — the seal names the parent,
    // never the internal kind.
    ['bot', 'Agent'],
    ['agent', 'Agent'],
    ['webhook', 'Webhook'],
  ] as [PrincipalKind, string][])(
    'wears the %s seal, naming the parent in the tooltip and screen-reader text',
    (kind, word) => {
      render(
        <MessageItem
          message={makeMessage()}
          currentUserId={ME}
          authorKind={kind}
          authorParentName="Jane Doe"
        />,
      );
      const badge = screen.getByTestId('kind-badge');
      expect(badge.getAttribute('data-kind')).toBe(kind);
      // The seal is the avatar marker now; the word lives in its tooltip and
      // in the row's sr-only text (the avatar itself is aria-hidden).
      expect(badge.getAttribute('title')).toBe(`${word} account, via Jane Doe`);
      expect(screen.getByText(`${word} account, via Jane Doe`)).toBeTruthy();
      expect(screen.getByTestId('message-avatar').contains(badge)).toBe(true);
    },
  );

  it('renders no badge for a human author (rule of one)', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} authorKind="human" />);
    expect(screen.queryByTestId('kind-badge')).toBeNull();
  });

  it('renders no badge when the author is missing from the projection', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} />);
    expect(screen.queryByTestId('kind-badge')).toBeNull();
  });

  it('names only the kind when the parent is unresolvable', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} authorKind="bot" />);
    const badge = screen.getByTestId('kind-badge');
    expect(badge.getAttribute('title')).toBe('Agent account');
    expect(screen.getByText('Agent account')).toBeTruthy();
  });

  it('rides the avatar, leaving the author row name → time', () => {
    render(
      <MessageItem
        message={makeMessage()}
        currentUserId={ME}
        authorKind="bot"
        authorParentName="Jane Doe"
      />,
    );
    const row = screen.getByTestId('message-author').parentElement!;
    expect(row.children[0]).toBe(screen.getByTestId('message-author'));
    expect(row.querySelector('[data-testid="message-time"]')).not.toBeNull();
    // No seal in the name line — it rides the avatar.
    expect(row.contains(screen.getByTestId('kind-badge'))).toBe(false);
    expect(screen.getByTestId('message-avatar').contains(screen.getByTestId('kind-badge'))).toBe(
      true,
    );
  });
});

describe('MessageItem — webhook author_override (U12)', () => {
  it('renders the override username as the author name with the badge still present; avatar_url is stored-only v1', () => {
    const msg = makeMessage({
      author_override: {
        username: 'Deploy Hook',
        avatar_url: 'https://cdn.example.com/hook.png',
      },
    });
    render(
      <MessageItem
        message={msg}
        currentUserId={ME}
        authorName="Roster Webhook"
        authorKind="webhook"
        authorParentName="Jane Doe"
      />,
    );
    expect(screen.getByTestId('message-author').textContent).toBe('Deploy Hook');
    const badge = screen.getByTestId('kind-badge');
    expect(badge.getAttribute('data-kind')).toBe('webhook');
    expect(badge.getAttribute('title')).toBe('Webhook account, via Jane Doe');
    // v1: the override avatar_url is stored-only — never rendered as an image
    // (documented in MessageItem).
    expect(document.querySelector('img[src*="cdn.example.com"]')).toBeNull();
  });

  it('falls back to the roster name when the message carries no override', () => {
    render(
      <MessageItem
        message={makeMessage()}
        currentUserId={ME}
        authorName="Roster Webhook"
        authorKind="webhook"
      />,
    );
    expect(screen.getByTestId('message-author').textContent).toBe('Roster Webhook');
  });

  // Tier 3 B (10b): an override naming a member must never render as that
  // member — the WEBHOOK badge comes from the message, even when the roster
  // row is missing or claims another kind.
  it('badges an override message as a webhook with no roster kind at all', () => {
    const msg = makeMessage({ author_override: { username: 'jordan', kind: 'webhook' } } as Partial<MessageWithBots>);
    render(<MessageItem message={msg} currentUserId={ME} authorName="jordan" />);
    expect(screen.getByTestId('message-author').textContent).toBe('jordan');
    expect(screen.getByTestId('kind-badge').getAttribute('data-kind')).toBe('webhook');
  });

  it('an override without the stamped kind (older server) is still a webhook message', () => {
    const msg = makeMessage({ author_override: { username: 'jordan' } } as Partial<MessageWithBots>);
    render(<MessageItem message={msg} currentUserId={ME} authorName="jordan" authorKind="human" />);
    expect(screen.getByTestId('kind-badge').getAttribute('data-kind')).toBe('webhook');
  });
});

describe('MessageItem — embed cards (U12)', () => {
  it('renders an embed-only message as a card with title, description, and fields', () => {
    const msg = makeMessage({
      content: '',
      embeds: [
        {
          title: 'Deploy finished',
          description: 'build #42 passed',
          fields: [{ name: 'Environment', value: 'production' }],
        },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.getByTestId('embed-title').textContent).toBe('Deploy finished');
    expect(screen.getByTestId('embed-description').textContent).toBe('build #42 passed');
    const fields = screen.getByTestId('embed-fields');
    expect(fields.textContent).toContain('Environment');
    expect(fields.textContent).toContain('production');
    // dt/dd definition-style layout.
    expect(fields.querySelector('dt')?.textContent).toBe('Environment');
    expect(fields.querySelector('dd')?.textContent).toBe('production');
  });

  it('renders both the content and the embeds, with the card below the content', () => {
    const msg = makeMessage({
      content: 'pipeline update',
      embeds: [{ title: 'Deploy finished', description: 'build #42 passed' }],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.getByTestId('message-content').textContent).toContain('pipeline update');
    const content = screen.getByTestId('message-content');
    const card = screen.getByTestId('embed-card');
    // Node.DOCUMENT_POSITION_FOLLOWING: the card comes after the content.
    expect(
      content.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('degrades malformed embeds without crashing', () => {
    const msg = makeMessage({
      embeds: [
        { description: 'only description' }, // missing title
        { title: 'NoFields', fields: 'not-an-array' } as unknown as MessageEmbed, // non-array fields
        {
          title: 'Weird',
          fields: [
            { name: 'ok', value: 'fine' },
            { name: 7, value: { deep: true } },
            null,
          ],
        } as unknown as MessageEmbed, // non-string field values dropped
        { color: 0xff0000, url: 'https://example.com' } as unknown as MessageEmbed, // nothing renderable → no card
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const cards = screen.getAllByTestId('embed-card');
    expect(cards).toHaveLength(3);
    // Card 1: description only.
    expect(cards[0]!.textContent).toContain('only description');
    // Card 2: title, fields ignored (non-array).
    expect(cards[1]!.textContent).toContain('NoFields');
    expect(cards[1]!.querySelector('[data-testid="embed-fields"]')).toBeNull();
    // Card 3: only the well-formed field survives.
    const fields = cards[2]!.querySelector('[data-testid="embed-fields"]');
    expect(fields).toBeTruthy();
    expect(fields!.textContent).toContain('ok');
    expect(fields!.textContent).toContain('fine');
    expect(fields!.textContent).not.toContain('deep');
    expect(screen.queryByText('https://example.com')).toBeNull();
  });

  it('renders nothing for an empty embeds array', () => {
    const msg = makeMessage({ embeds: [] });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.queryByTestId('embed-card')).toBeNull();
  });

  // #167: Discord renders Markdown in an embed's description and field
  // values; the title and field names stay plain.
  it('renders Markdown in the description and field values, not as literal syntax', () => {
    const msg = makeMessage({
      content: '',
      embeds: [
        {
          title: '**plain title**',
          description:
            'Erase **18½ minutes**? *really* `rm -rf` [docs](https://example.com/d)\n```\nnpm run deploy\n```\n- one\n- two',
          fields: [{ name: '**plain name**', value: 'run `make tapes` by **noon**' }],
        },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);

    const description = screen.getByTestId('embed-description');
    expect(description.textContent).not.toContain('**');
    expect(description.querySelector('strong')?.textContent).toBe('18½ minutes');
    expect(description.querySelector('em')?.textContent).toBe('really');
    expect(description.querySelector('code')?.textContent).toBe('rm -rf');
    expect(description.querySelector('pre')?.textContent).toContain('npm run deploy');
    expect(description.querySelectorAll('li')).toHaveLength(2);
    const link = description.querySelector('a');
    expect(link?.textContent).toBe('docs');
    expect(link?.getAttribute('href')).toBe('https://example.com/d');

    const value = screen.getByTestId('embed-fields').querySelector('dd')!;
    expect(value.querySelector('code')?.textContent).toBe('make tapes');
    expect(value.querySelector('strong')?.textContent).toBe('noon');

    // Titles and field names are plain text, as on Discord.
    expect(screen.getByTestId('embed-title').textContent).toBe('**plain title**');
    expect(screen.getByTestId('embed-fields').querySelector('dt')?.textContent).toBe('**plain name**');
  });

  it('resolves a mention in an embed the way it does in a message body', () => {
    const msg = makeMessage({
      content: '',
      embeds: [{ description: 'Requested by <@42>' }],
    });
    render(
      <MessageItem
        message={msg}
        currentUserId={ME}
        resolveMention={(id) => (id === '42' ? 'rosemary' : undefined)}
      />,
    );
    const description = screen.getByTestId('embed-description');
    expect(description.textContent).toContain('@rosemary');
    expect(description.textContent).not.toContain('<@42>');
  });

  it('an image in embed Markdown stays a link: embed media comes only from image/thumbnail', () => {
    const msg = makeMessage({
      content: '',
      embeds: [{ description: '![tape](https://img.example.com/tape.png)' }],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const description = screen.getByTestId('embed-description');
    expect(description.querySelector('img')).toBeNull();
    expect(description.querySelector('a')?.getAttribute('href')).toBe('https://img.example.com/tape.png');
  });

  it('axe: an embed with formatted content stays clean', async () => {
    const msg = makeMessage({
      content: '',
      embeds: [
        {
          title: 'Approval',
          description: 'Run **this**?\n```\nmake deploy\n```',
          fields: [{ name: 'Who', value: '*the boss*' }],
        },
      ],
    });
    const { container } = render(<MessageItem message={msg} currentUserId={ME} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MessageItem — embed media (image/thumbnail)', () => {
  it('renders embed image and thumbnail from their PROXY copies as lazy no-referrer images below the fields', () => {
    const msg = makeMessage({
      embeds: [
        {
          title: 'Release 1.2',
          fields: [{ name: 'Channel', value: 'stable' }],
          image: { url: 'https://img.example.com/cover.png', proxy_url: proxied('cover') },
          thumbnail: { url: 'https://img.example.com/thumb.png', proxy_url: proxied('thumb') },
        },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);

    const images = screen.getAllByTestId('embed-image');
    expect(images).toHaveLength(2);
    // Never the producer's URL (the CSP would refuse it): the server's copy.
    expect(images[0]!.getAttribute('src')).toBe(proxied('cover'));
    expect(images[1]!.getAttribute('src')).toBe(proxied('thumb'));
    // The original stays one click away ("open original").
    const [coverBox] = screen.getAllByTestId('embed-image-box');
    expect(coverBox!.tagName).toBe('A');
    expect(coverBox!.getAttribute('href')).toBe('https://img.example.com/cover.png');
    expect(coverBox!.getAttribute('rel')).toBe('noreferrer noopener');
    for (const img of images) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(img.getAttribute('alt')).toBe('Release 1.2'); // title ∥ "embed image"
    }
    // Media sits below the fields inside the card.
    const fields = screen.getByTestId('embed-fields');
    const media = screen.getByTestId('embed-media');
    expect(
      fields.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('alt falls back to the generic "embed image" when the embed has no title', () => {
    const msg = makeMessage({
      embeds: [{ description: 'no title here', image: { url: 'https://x/y.png', proxy_url: proxied('y') } }],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.getByTestId('embed-image').getAttribute('alt')).toBe('embed image');
  });

  it('an image-only embed still renders a card (media only, no text)', () => {
    const msg = makeMessage({
      embeds: [{ image: { url: 'https://x/y.png', proxy_url: proxied('y') } }],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.getByTestId('embed-card')).toBeTruthy();
    expect(screen.getByTestId('embed-image').getAttribute('src')).toBe(proxied('y'));
    expect(screen.queryByTestId('embed-fields')).toBeNull();
  });

  it('malformed or missing media renders nothing (text-only behavior unchanged)', () => {
    const msg = makeMessage({
      embeds: [
        { title: 'NoMedia' },
        { title: 'BadMedia', image: { url: 42 } as never, thumbnail: 'nope' as never },
        { title: 'EmptyUrl', image: { url: '' } },
        // External with no proxy copy (proxy off): nothing the CSP would admit.
        { title: 'Unproxied', image: { url: 'https://x/raw.png' } },
        // A "proxy URL" of any other shape is never loaded.
        { title: 'Forged', image: { url: 'https://x/f.png', proxy_url: 'https://tracker.example/p.gif' } },
        { title: 'Forged2', thumbnail: { url: 'https://x/f.png', proxy_url: '//evil.example/api/v1/media/proxy?u=a' } },
      ],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.getAllByTestId('embed-card')).toHaveLength(6);
    expect(screen.queryByTestId('embed-image')).toBeNull();
    expect(screen.queryByTestId('embed-media')).toBeNull();
  });

  it('a failed image load hides the img via onError (no broken-image icon)', () => {
    const msg = makeMessage({
      embeds: [{ title: 'Broken', image: { url: 'https://x/broken.png', proxy_url: proxied('broken') } }],
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const img = screen.getByTestId('embed-image');
    expect(img.style.display).not.toBe('none');
    fireEvent.error(img);
    expect(img.style.display).toBe('none');
    // The reserved box goes too (a proxy 404/415/502 hides quietly).
    expect(screen.getByTestId('embed-image-box').style.display).toBe('none');
  });

  it('our own attachment URL loads as itself (same-origin, never proxied), without an original link', () => {
    const url = `/api/v1/attachments/${'ab'.repeat(32)}?e=1900000000&s=sig`;
    const msg = makeMessage({ embeds: [{ title: 'Chart', image: { url } }] });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.getByTestId('embed-image').getAttribute('src')).toBe(url);
    expect(screen.getByTestId('embed-image-box').tagName).toBe('SPAN');
  });

  it('axe: embed media stays clean at desktop + mobile', async () => {
    mobileWidthState.mobile = false;
    const msg = makeMessage({
      embeds: [
        {
          title: 'Release 1.2',
          description: 'build passed',
          image: { url: 'https://img.example.com/cover.png', proxy_url: proxied('cover') },
          thumbnail: { url: 'https://img.example.com/thumb.png', proxy_url: proxied('thumb') },
        },
      ],
    });
    const { container } = render(<MessageItem message={msg} currentUserId={ME} />);
    expect(await axe(container)).toHaveNoViolations();

    mobileWidthState.mobile = true;
    expect(await axe(container)).toHaveNoViolations();
    mobileWidthState.mobile = false;
  });
});

describe('MessageItem — Markdown images', () => {
  const SRC = 'https://img.example.com/whiteboard.png';

  it('renders `![alt](url)` through the message\'s content_proxy_urls map', () => {
    const msg = makeMessage({
      content: `the plan ![the whiteboard](${SRC}) today`,
      content_proxy_urls: { [SRC]: proxied('wb') },
    });
    render(<MessageItem message={msg} currentUserId={ME} />);
    const img = screen.getByTestId('markdown-image');
    expect(img.getAttribute('src')).toBe(proxied('wb'));
    expect(img.getAttribute('alt')).toBe('the whiteboard');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    const box = screen.getByTestId('markdown-image-box');
    expect(box.getAttribute('href')).toBe(SRC);
    // Capped like embed media: the fixed 200px box, reserved before load.
    expect(box.style.height).toBe('200px');
    expect(screen.getByTestId('message-content').textContent).toContain('the plan');
    expect(screen.getByTestId('message-content').textContent).not.toContain('![');
  });

  it('an image with no proxied copy is a plain link to its source (never a raw <img>)', () => {
    const msg = makeMessage({ content: `see ![chart](${SRC}) and ![](${SRC}?2)` });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.queryByTestId('markdown-image')).toBeNull();
    const body = screen.getByTestId('message-content');
    const links = Array.from(body.querySelectorAll('a'));
    expect(links.map((a) => a.textContent)).toEqual(['chart', `${SRC}?2`]);
    expect(links[0]!.getAttribute('href')).toBe(SRC);
    expect(body.querySelector('img')).toBeNull();
  });

  it('a map value of the wrong shape is never loaded', () => {
    const msg = makeMessage({ content: `![x](${SRC})`, content_proxy_urls: { [SRC]: SRC } });
    render(<MessageItem message={msg} currentUserId={ME} />);
    expect(screen.queryByTestId('markdown-image')).toBeNull();
  });

  it('a failed load hides the image and its box quietly', () => {
    const msg = makeMessage({ content: `![x](${SRC})`, content_proxy_urls: { [SRC]: proxied('x') } });
    render(<MessageItem message={msg} currentUserId={ME} />);
    fireEvent.error(screen.getByTestId('markdown-image'));
    expect(screen.getByTestId('markdown-image-box').style.display).toBe('none');
  });

  it('an empty alt still gives the image an accessible name; axe stays clean', async () => {
    const msg = makeMessage({
      content: `![](${SRC}) and ![a diagram](${SRC}?b)`,
      content_proxy_urls: { [SRC]: proxied('1'), [`${SRC}?b`]: proxied('2') },
    });
    const { container } = render(<MessageItem message={msg} currentUserId={ME} />);
    const [first, second] = screen.getAllByTestId('markdown-image');
    expect(first!.getAttribute('alt')).toBe('Image');
    expect(second!.getAttribute('alt')).toBe('a diagram');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MessageItem — accessibility (U12 DoD)', () => {
  /** Message-list fixture containing every principal kind plus embeds.
   * Plain div wrapper — mirrors the real Virtuoso list DOM (no list role,
   * which would restrict allowed children). */
  function renderListFixture() {
    return render(
      <div data-testid="message-list-fixture">
        <MessageItem message={makeMessage({ id: '1', content: 'human here' })} currentUserId={ME} />
        <MessageItem
          message={makeMessage({ id: '2', content: 'beep' })}
          currentUserId={ME}
          authorKind="bot"
          authorParentName="Jane Doe"
        />
        <MessageItem
          message={makeMessage({ id: '3', content: 'analyzing' })}
          currentUserId={ME}
          authorKind="agent"
          authorParentName="Jane Doe"
        />
        <MessageItem
          message={makeMessage({
            id: '4',
            content: '',
            author_override: { username: 'Deploy Hook' },
            embeds: [
              {
                title: 'Deploy finished',
                description: 'build #42 passed',
                fields: [{ name: 'Environment', value: 'production' }],
              },
            ],
          })}
          currentUserId={ME}
          authorKind="webhook"
          authorParentName="Jane Doe"
        />
      </div>,
    );
  }

  afterEach(() => {
    mobileWidthState.mobile = false;
  });

  it('has no axe violations at desktop width across all principal kinds', async () => {
    mobileWidthState.mobile = false;
    const { container } = renderListFixture();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations at mobile width across all principal kinds', async () => {
    mobileWidthState.mobile = true;
    const { container } = renderListFixture();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the machine attribution is announced even though the seal is decorative', () => {
    renderListFixture();
    const badges = screen.getAllByTestId('kind-badge');
    expect(badges).toHaveLength(3);
    for (const badge of badges) {
      // The seal itself is a marker inside an aria-hidden avatar; the WORD is
      // carried by the row's sr-only text and the seal's tooltip, so a screen
      // reader still hears "Agent account, via Jane Doe" (R1: both machine
      // kinds read as Agent; a webhook keeps its own word).
      const word =
        badge.getAttribute('data-kind') === 'webhook' ? 'Webhook' : 'Agent';
      expect(badge.getAttribute('title')).toBe(`${word} account, via Jane Doe`);
      expect(screen.getAllByText(`${word} account, via Jane Doe`).length).toBeGreaterThan(0);
    }
  });
});

describe('MessageItem — reaction chips (reactions UI)', () => {
  const REACTIONS = [
    { emoji: '👍', count: 2, me: true },
    { emoji: '🎉', count: 1, me: false },
  ];

  it('renders a chip per message.reactions with emoji + count', () => {
    render(
      <MessageItem
        message={makeMessage({ reactions: REACTIONS })}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
      />,
    );
    const row = screen.getByTestId('reaction-row');
    expect(row).toBeTruthy();
    const chips = screen.getAllByTestId('reaction-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toBe('👍2');
    expect(chips[1]!.textContent).toBe('🎉1');
    // The "+" add-reaction affordance rides at the row's end.
    expect(row.contains(screen.getAllByTestId('reaction-add')[0]!)).toBe(true);
  });

  it('me-state is visually distinct and carries aria-pressed', () => {
    render(
      <MessageItem
        message={makeMessage({ reactions: REACTIONS })}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
      />,
    );
    const chips = screen.getAllByTestId('reaction-chip');
    const [mineChip, otherChip] = chips;
    // aria-pressed carries the me-state semantically.
    expect(mineChip!.getAttribute('aria-pressed')).toBe('true');
    expect(otherChip!.getAttribute('aria-pressed')).toBe('false');
    // data-me + filled (accent) vs outline (line) styling.
    expect(mineChip!.getAttribute('data-me')).toBe('true');
    expect(otherChip!.getAttribute('data-me')).toBe(null);
    expect(mineChip!.className).toContain('border-accent');
    expect(mineChip!.className).toContain('bg-accent/20');
    expect(otherChip!.className).toContain('border-line');
    expect(otherChip!.className).not.toContain('border-accent');
    // Accessible labels speak count + own-reaction state.
    expect(mineChip!.getAttribute('aria-label')).toBe('👍 2 reactions, including you');
    expect(otherChip!.getAttribute('aria-label')).toBe('🎉 1 reaction');
  });

  it('click toggles call onToggleReaction with the exact (messageId, emoji) args', () => {
    const onToggleReaction = vi.fn();
    render(
      <MessageItem
        message={makeMessage({ reactions: REACTIONS })}
        currentUserId={ME}
        onToggleReaction={onToggleReaction}
      />,
    );
    fireEvent.click(screen.getAllByTestId('reaction-chip')[0]!);
    expect(onToggleReaction).toHaveBeenCalledTimes(1);
    expect(onToggleReaction).toHaveBeenCalledWith('1000000000000001', '👍');
  });

  it('no reactions key (or empty array) renders no row — RemoveAll clears the row', () => {
    const onToggleReaction = vi.fn();
    const { rerender } = render(
      <MessageItem message={makeMessage()} currentUserId={ME} onToggleReaction={onToggleReaction} />,
    );
    expect(screen.queryByTestId('reaction-row')).toBeNull();
    // No chip row → the HOVER toolbar's picker is the add affordance now.
    expect(screen.getAllByTestId('reaction-add')[0]!).toBeTruthy();

    // Empty array (all chips dropped) is equivalent to absent.
    rerender(
      <MessageItem
        message={makeMessage({ reactions: [] })}
        currentUserId={ME}
        onToggleReaction={onToggleReaction}
      />,
    );
    expect(screen.queryByTestId('reaction-row')).toBeNull();

    // A row that existed and then lost its reactions key (RemoveAll) clears.
    rerender(
      <MessageItem
        message={makeMessage({ reactions: REACTIONS })}
        currentUserId={ME}
        onToggleReaction={onToggleReaction}
      />,
    );
    expect(screen.getByTestId('reaction-row')).toBeTruthy();
    rerender(
      <MessageItem message={makeMessage()} currentUserId={ME} onToggleReaction={onToggleReaction} />,
    );
    expect(screen.queryByTestId('reaction-row')).toBeNull();
  });

  it('never renders chips on the optimistic-send placeholder row until confirmed', () => {
    render(
      <MessageItem
        message={makeMessage({ id: 'pending_abc123', reactions: REACTIONS })}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
      />,
    );
    // showReactionRow stays false (placeholder rows never show chips), and
    // the chip ROW is what must not exist until the server row confirms.
    expect(screen.queryByTestId('reaction-row')).toBeNull();
    expect(screen.queryByTestId('reaction-chip')).toBeNull();
  });

  it('offline disables chips and the add button with an explanatory title', () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true, writable: true });
    try {
      render(
        <MessageItem
          message={makeMessage({ reactions: REACTIONS })}
          currentUserId={ME}
          onToggleReaction={vi.fn()}
        />,
      );
      for (const chip of screen.getAllByTestId('reaction-chip')) {
        expect(chip.getAttribute('disabled')).toBe('');
        expect(chip.getAttribute('title')).toContain('offline');
      }
      const add = screen.getAllByTestId('reaction-add')[0]!;
      expect(add.getAttribute('disabled')).toBe('');
      expect(add.getAttribute('title')).toContain('offline');
    } finally {
      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true, writable: true });
    }
  });

  it('surfaces the failed toggle inline with Retry/Dismiss (role=alert)', () => {
    const onRetryReaction = vi.fn();
    const onDismissReaction = vi.fn();
    render(
      <MessageItem
        message={makeMessage({ reactions: REACTIONS })}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
        reactionError={{ emoji: '👍', message: 'too many emojis' }}
        onRetryReaction={onRetryReaction}
        onDismissReaction={onDismissReaction}
      />,
    );
    // Chip row stays stable alongside the error.
    expect(screen.getAllByTestId('reaction-chip')).toHaveLength(2);
    expect(screen.getByTestId('reaction-error-message').textContent).toBe('too many emojis');
    fireEvent.click(screen.getByTestId('reaction-retry'));
    expect(onRetryReaction).toHaveBeenCalledWith('1000000000000001', '👍');
    fireEvent.click(screen.getByTestId('reaction-dismiss'));
    expect(onDismissReaction).toHaveBeenCalledTimes(1);
  });
});

describe('MessageItem — reaction picker (reactions UI)', () => {
  function renderWithReactions(onToggleReaction = vi.fn()) {
    const utils = render(
      <MessageItem
        message={makeMessage({ reactions: [{ emoji: '👍', count: 1, me: false }] })}
        currentUserId={ME}
        onToggleReaction={onToggleReaction}
      />,
    );
    return { ...utils, onToggleReaction };
  }

  it('opens on the trigger to the quick FAVORITES grid + a ＋ more cell', () => {
    localStorage.removeItem('cytale.reaction-favorites');
    renderWithReactions();
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    const picker = screen.getByTestId('reaction-picker');
    expect(picker.getAttribute('role')).toBe('menu');
    const favs = screen.getAllByTestId('reaction-favorite');
    expect(favs).toHaveLength(8);
    expect(favs.map((o) => o.getAttribute('data-emoji'))).toEqual([...REACTION_PALETTE]);
    expect(favs[0]!.getAttribute('aria-label')).toBe(
      `${reactionAriaLabel('👍')} — already applied`,
    );
    // The trailing ＋ cell drills into the full picker.
    expect(screen.getByTestId('reaction-more')).toBeTruthy();
    // Opening focuses the first option.
    expect(document.activeElement?.getAttribute('data-emoji')).toBe('👍');
    localStorage.removeItem('cytale.reaction-favorites');
  });

  it('keyboard-complete: arrows move (5-col grid), Enter picks, focus returns to the trigger', () => {
    localStorage.removeItem('cytale.reaction-favorites');
    const { onToggleReaction } = renderWithReactions();
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    const pickerRoot = screen.getAllByTestId('reaction-picker-root')[0]!;

    fireEvent.keyDown(pickerRoot, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('data-emoji')).toBe('👎');
    fireEvent.keyDown(pickerRoot, { key: 'ArrowDown' }); // 1 +5 → 6
    expect(document.activeElement?.getAttribute('data-emoji')).toBe('🎉');
    fireEvent.keyDown(pickerRoot, { key: 'ArrowLeft' }); // 6-1 → 5
    expect(document.activeElement?.getAttribute('data-emoji')).toBe('😢');
    fireEvent.keyDown(pickerRoot, { key: 'ArrowUp' }); // 5-5 → 0
    expect(document.activeElement?.getAttribute('data-emoji')).toBe('👍');

    // Wrap left from the head lands on the trailing ＋; left again → 👀.
    fireEvent.keyDown(pickerRoot, { key: 'ArrowLeft' }); // (0-1+9)%9 → 8 = ＋
    expect(document.activeElement?.getAttribute('data-testid')).toBe('reaction-more');
    fireEvent.keyDown(pickerRoot, { key: 'ArrowLeft' }); // 8-1 → 7
    expect(document.activeElement?.getAttribute('data-emoji')).toBe('👀');

    fireEvent.keyDown(pickerRoot, { key: 'Enter' });
    expect(onToggleReaction).toHaveBeenCalledTimes(1);
    expect(onToggleReaction).toHaveBeenCalledWith('1000000000000001', '👀');
    // Closed after pick; focus restored to the trigger.
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    expect(document.activeElement).toBe(screen.getAllByTestId('reaction-add')[0]!);
  });

  it('Enter on the ＋ cell opens the SAME full picker the composer uses; picking flows through onPick', () => {
    localStorage.removeItem('cytale.reaction-favorites');
    const { onToggleReaction } = renderWithReactions();
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    const pickerRoot = screen.getAllByTestId('reaction-picker-root')[0]!;
    // Wrap left from the head lands on the trailing ＋; Enter drills in.
    fireEvent.keyDown(pickerRoot, { key: 'ArrowLeft' });
    fireEvent.keyDown(pickerRoot, { key: 'Enter' });
    expect(screen.getByTestId('emoji-picker-panel')).toBeTruthy();
    expect(screen.getByTestId('emoji-search')).toBeTruthy();

    // Pick 🔥 from the full grid → same toggle path, picker closed.
    const fire = screen
      .getAllByTestId('emoji-cell')
      .find((c) => c.getAttribute('data-emoji') === '🔥')!;
    fireEvent.click(fire);
    expect(onToggleReaction).toHaveBeenCalledWith('1000000000000001', '🔥');
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    expect(screen.queryByTestId('emoji-picker-panel')).toBeNull();
  });

  it('clicking the ＋ trigger while the FULL picker is open closes it (no mousedown-close/click-reopen)', () => {
    localStorage.removeItem('cytale.reaction-favorites');
    renderWithReactions();
    const trigger = screen.getAllByTestId('reaction-add')[0]!;
    fireEvent.click(trigger);
    const pickerRoot = screen.getAllByTestId('reaction-picker-root')[0]!;
    fireEvent.keyDown(pickerRoot, { key: 'ArrowLeft' });
    fireEvent.keyDown(pickerRoot, { key: 'Enter' });
    expect(screen.getByTestId('emoji-picker-panel')).toBeTruthy();

    // A real click is mousedown THEN click: the panel's outside-dismiss must
    // treat the host's trigger as inside, or the click re-opens it.
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByTestId('emoji-picker-panel')).toBeNull();
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
  });

  it('Escape cancels without picking; Tab and outside click dismiss', () => {
    localStorage.removeItem('cytale.reaction-favorites');
    const { onToggleReaction } = renderWithReactions();
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    const pickerRoot = screen.getAllByTestId('reaction-picker-root')[0]!;

    fireEvent.keyDown(pickerRoot, { key: 'Escape' });
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    expect(onToggleReaction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getAllByTestId('reaction-add')[0]!);

    // Tab (focus escape) dismisses.
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    fireEvent.keyDown(screen.getAllByTestId('reaction-picker-root')[0]!, { key: 'Tab' });
    expect(screen.queryByTestId('reaction-picker')).toBeNull();

    // Outside pointer press dismisses.
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    expect(onToggleReaction).not.toHaveBeenCalled();
  });

  it('picking by click routes through the same toggle with exact args', () => {
    localStorage.removeItem('cytale.reaction-favorites');
    const { onToggleReaction } = renderWithReactions();
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    fireEvent.click(screen.getAllByTestId('reaction-favorite')[7]!);
    expect(onToggleReaction).toHaveBeenCalledWith('1000000000000001', '👀');
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
  });

  it('axe: chips row with an open picker stays clean at desktop + mobile', async () => {
    localStorage.removeItem('cytale.reaction-favorites');
    mobileWidthState.mobile = false;
    const { container } = renderWithReactions();
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    expect(await axe(container)).toHaveNoViolations();

    mobileWidthState.mobile = true;
    expect(await axe(container)).toHaveNoViolations();
    mobileWidthState.mobile = false;
  });
});

describe('MessageItem — reaction error on a chipless row (first-reaction failure)', () => {
  it('still renders the inline affordance when the rollback emptied the chips', () => {
    render(
      <MessageItem
        message={makeMessage()}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
        reactionError={{ emoji: '👀', message: 'forbidden' }}
        onRetryReaction={vi.fn()}
        onDismissReaction={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('reaction-chip')).toBeNull();
    expect(screen.getByTestId('reaction-error').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('reaction-error-message').textContent).toBe('forbidden');
  });
});

describe('MessageItem — start thread (hover toolbar)', () => {

  it('start thread: the hover 🧵 fires onStartThread with id + seed content (no prompt)', async () => {
    const onStartThread = vi.fn();
    render(
      <MessageItem message={makeMessage()} currentUserId={ME} onStartThread={onStartThread} />,
    );
    await fireEvent.click(screen.getByTestId('action-start-thread'));
    // The host derives the thread name from the content — the callback
    // carries both, and no title prompt exists.
    expect(onStartThread).toHaveBeenCalledWith(
      makeMessage().id,
      makeMessage().content,
    );
  });
});

describe('MessageItem — grouped-row hover time (left gutter)', () => {
  it('a grouped row carries the timestamp in the left gutter, hidden until hover, stacked as lines', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} grouped />);
    const t = screen.getByTestId('message-hover-time');
    expect(t.textContent).toMatch(/\d{1,2}:\d{2}/);
    // Hidden at rest via opacity-0; the row's group-hover reveals it.
    expect(t.className).toContain('opacity-0');
    expect(t.className).toContain('group-hover:opacity-100');
    // Two stacked, individually-nowrap lines centered in the avatar column
    // (owner report 2026-09-20: the age-aware stamp is wider than the
    // gutter — one nowrap line clipped into the message text).
    expect(t.className).toContain('flex-col');
    expect(t.className).toContain('items-center');
    expect(t.className).toContain('absolute');
    const lines = t.querySelectorAll('span');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of Array.from(lines)) {
      expect(line.className).toContain('whitespace-nowrap');
    }
    // The column never grows past the avatar gutter's own band.
    expect(t.className).toContain('w-[68px]');
  });

  it('a full (ungrouped) row keeps the avatar — the header already shows the time', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} />);
    expect(screen.getByTestId('message-avatar')).toBeTruthy();
    expect(screen.queryByTestId('message-hover-time')).toBeNull();
    expect(screen.getByTestId('message-time').textContent).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('MessageItem — reaction chip hover tooltip', () => {
  it('hovering a chip fetches and lists the reacting users', async () => {
    const fetchUsers = vi.fn().mockResolvedValue({
      users: [
        { id: '7000000000000001', username: 'alice' },
        { id: '7000000000000002', username: 'bob' },
      ],
      next_after: null,
    });
    vi.spyOn(api, 'listReactionUsers').mockImplementation(fetchUsers);

    render(
      <MessageItem
        message={makeMessage({ reactions: [{ emoji: '👍', count: 2, me: false }] })}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('reaction-tooltip')).toBeNull();

    fireEvent.mouseEnter(screen.getByTestId('reaction-chip'));
    await waitFor(() => {
      expect(screen.getByTestId('reaction-tooltip')).toBeTruthy();
    });
    expect(fetchUsers).toHaveBeenCalled();
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId('reaction-chip'));
    expect(screen.queryByTestId('reaction-tooltip')).toBeNull();
  });

  it('a failed fetch degrades to an empty tooltip, never a broken chip', async () => {
    vi.spyOn(api, 'listReactionUsers').mockRejectedValue(new Error('down'));
    render(
      <MessageItem
        message={makeMessage({ reactions: [{ emoji: '👍', count: 1, me: true }] })}
        currentUserId={ME}
        onToggleReaction={vi.fn()}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('reaction-chip'));
    await waitFor(() => {
      expect(screen.getByTestId('reaction-tooltip')).toBeTruthy();
    });
    expect(screen.getByTestId('reaction-chip').textContent).toContain('1');
  });
});

describe('ReactionPicker — favorites row', () => {
  it('defaults to the palette before personalization', async () => {
    localStorage.removeItem('cytale.reaction-favorites');
    const onPick = vi.fn();
    render(<ReactionPicker onPick={onPick} />);
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    const favs = screen.getAllByTestId('reaction-favorite').map((b) => b.getAttribute('data-emoji'));
    expect(favs).toEqual([...REACTION_PALETTE]);
    localStorage.removeItem('cytale.reaction-favorites');
  });

  it('picking via the ＋ full picker bumps it to the front of the quick grid (persisted)', async () => {
    localStorage.removeItem('cytale.reaction-favorites');
    const onPick = vi.fn();
    const view = render(<ReactionPicker onPick={onPick} />);
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    fireEvent.click(screen.getByTestId('reaction-more'));
    const fire = screen
      .getAllByTestId('emoji-cell')
      .find((b) => b.getAttribute('data-emoji') === '🔥')!;
    fireEvent.click(fire);
    expect(onPick).toHaveBeenCalledWith('🔥');

    view.unmount();
    const view2 = render(<ReactionPicker onPick={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId('reaction-add')[0]!);
    const favs = screen.getAllByTestId('reaction-favorite').map((b) => b.getAttribute('data-emoji'));
    expect(favs[0]).toBe('🔥');
    expect(favs).toHaveLength(REACTION_PALETTE.length);
    localStorage.removeItem('cytale.reaction-favorites');
  });
});

describe('MessageItem — toolbar picker availability + hover-away dismissal', () => {
  function renderWithReactionsLocal(onToggleReaction = vi.fn()) {
    const utils = render(
      <MessageItem
        message={makeMessage({ reactions: [{ emoji: '👍', count: 1, me: false }] })}
        currentUserId={ME}
        onToggleReaction={onToggleReaction}
      />,
    );
    return { ...utils, onToggleReaction };
  }

  it('the toolbar react affordance is present EVEN when a chip row exists', () => {
    renderWithReactionsLocal();
    // Chip row present (reactions exist) AND the toolbar picker both render.
    expect(screen.getByTestId('reaction-row')).toBeTruthy();
    const adds = screen.getAllByTestId('reaction-add');
    expect(adds.length).toBeGreaterThanOrEqual(2);
    // The toolbar instance is the icon variant (svg trigger).
    expect(adds.some((b) => Boolean(b.querySelector('svg')))).toBe(true);
  });

  it('applied emojis are disabled inside the toolbar picker', () => {
    renderWithReactionsLocal();
    const toolbarAdd = screen
      .getAllByTestId('reaction-add')
      .find((b) => Boolean(b.querySelector('svg')))!;
    fireEvent.click(toolbarAdd);
    const favs = [...screen.getAllByTestId('reaction-favorite')];
    const applied = favs.find((b) => b.getAttribute('data-emoji') === '👍') as HTMLButtonElement;
    expect(applied.disabled).toBe(true);
    const notApplied = favs.find((b) => b.getAttribute('data-emoji') === '❤️') as HTMLButtonElement;
    expect(notApplied.disabled).toBe(false);
  });

  it('pointer leaving the row closes the open picker and blurs the trigger (hover cleared)', async () => {
    const { container } = renderWithReactionsLocal();
    const toolbarAdd = screen
      .getAllByTestId('reaction-add')
      .find((b) => Boolean(b.querySelector('svg')))!;
    fireEvent.click(toolbarAdd); // open (focus lands on trigger? — focus stays on click target)
    expect(screen.getAllByTestId('reaction-picker').length).toBeGreaterThan(0);

    // Pointer leaves the TOOLBAR picker's root (the open one) → the grace
    // timer closes it AND blurs the trigger, so the row hover clears.
    const toolbarRoot = screen
      .getAllByTestId('reaction-picker-root')
      .find((r) => r.querySelector('svg'))!;
    fireEvent.mouseLeave(toolbarRoot);
    await waitFor(() => {
      const openRoots = screen
        .getAllByTestId('reaction-picker-root')
        .filter((r) => r.querySelector('[data-testid="reaction-picker"]'));
      expect(openRoots.length).toBe(0);
    });
    expect(document.activeElement).not.toBe(toolbarAdd);
  });
});

describe('MessageItem — long-press report (U3, coarse pointers only)', () => {
  // The row is the long-press target; MessageItem only REPORTS the gesture —
  // sheet state lives above the windowing boundary (MessageList).
  const HOLD_MS = 450;
  const SLOP_PX = 10;

  function renderItem(onLongPress = vi.fn(), overrides: Partial<MessageWithBots> = {}) {
    return render(
      <MessageItem
        message={makeMessage({ author_id: ME, ...overrides })}
        currentUserId={ME}
        onLongPress={onLongPress}
      />,
    );
  }

  /**
   * jsdom has no PointerEvent, and fireEvent.pointer* degrades to a plain
   * Event that drops clientX/clientY. React only keys on the event TYPE, so
   * we dispatch MouseEvent-based pointer events — coordinates survive, the
   * synthetic handlers fire, and the production code is untouched.
   */
  function firePointer(
    el: HTMLElement,
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    x = 0,
    y = 0,
  ): void {
    fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }

  function hold(row: HTMLElement, ms: number, x = 20, y = 20): void {
    firePointer(row, 'pointerdown', x, y);
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    coarsePointerState.coarse = false;
    cleanup();
  });

  it('coarse pointer: a ~450ms hold reports the long-press (not at 449ms)', () => {
    coarsePointerState.coarse = true;
    const onLongPress = vi.fn();
    const { container } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    hold(row, HOLD_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]![0].id).toBe('1000000000000001');
  });

  it('fine pointer (desktop): the long-press NEVER fires', () => {
    coarsePointerState.coarse = false;
    const onLongPress = vi.fn();
    const { container } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    hold(row, HOLD_MS * 3);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('movement beyond the slop during the hold cancels it', () => {
    coarsePointerState.coarse = true;
    const onLongPress = vi.fn();
    const { container } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    firePointer(row, 'pointerdown', 20, 20);
    firePointer(row, 'pointermove', 20 + SLOP_PX + 6, 20);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('movement WITHIN the slop does not cancel (a jittering finger still long-presses)', () => {
    coarsePointerState.coarse = true;
    const onLongPress = vi.fn();
    const { container } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    firePointer(row, 'pointerdown', 20, 20);
    firePointer(row, 'pointermove', 20 + SLOP_PX - 4, 20);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('pointerup before the threshold is a tap — no report', () => {
    coarsePointerState.coarse = true;
    const onLongPress = vi.fn();
    const { container } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    hold(row, HOLD_MS - 50);
    firePointer(row, 'pointerup', 20, 20);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('a scroll during the hold cancels it (the list scrolled under the finger)', () => {
    coarsePointerState.coarse = true;
    const onLongPress = vi.fn();
    const { container } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    fireEvent.pointerDown(row, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.scroll(window);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('the fired long-press focuses the row (Radix restores focus there on sheet close) and swallows the trailing tap-click', () => {
    coarsePointerState.coarse = true;
    const onLongPress = vi.fn();
    const { container } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    hold(row, HOLD_MS);
    expect(document.activeElement).toBe(row);

    // The gesture's trailing click must not fall through to whatever sits
    // under the finger (chips, links…).
    const chip = document.createElement('button');
    let clicked = false;
    chip.addEventListener('click', () => {
      clicked = true;
    });
    row.appendChild(chip);
    fireEvent.click(chip);
    expect(clicked).toBe(false);

    // One swallow only — the NEXT click is an ordinary click again.
    fireEvent.click(chip);
    expect(clicked).toBe(true);
  });

  it('no onLongPress prop: the row never arms a hold (thread-panel rows etc.)', () => {
    coarsePointerState.coarse = true;
    const { container } = render(<MessageItem message={makeMessage()} currentUserId={ME} />);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;
    expect(() => {
      hold(row, HOLD_MS * 2);
    }).not.toThrow();
  });

  it('coarse pointer: contextmenu on the row is suppressed (native callout would fight the gesture)', () => {
    coarsePointerState.coarse = true;
    const { container } = renderItem(vi.fn());
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('fine pointer: contextmenu is left alone (desktop copy/paste untouched)', () => {
    coarsePointerState.coarse = false;
    const { container } = renderItem(vi.fn());
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('unmount mid-hold tears down the hold: no report, listeners gone (review #11)', () => {
    coarsePointerState.coarse = true;
    const onLongPress = vi.fn();
    const { container, unmount } = renderItem(onLongPress);
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;

    const removeSpy = vi.spyOn(window, 'removeEventListener');
    firePointer(row, 'pointerdown', 20, 20);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS - 1);
    });
    const armedRemoves = removeSpy.mock.calls.length;

    // The gesture never completes: the row unmounts mid-hold (rewindow).
    unmount();
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    window.dispatchEvent(new MouseEvent('pointerup'));
    window.dispatchEvent(new Event('scroll'));

    expect(onLongPress).not.toHaveBeenCalled();
    // Every window listener the press armed was removed at unmount.
    expect(removeSpy.mock.calls.length).toBeGreaterThan(armedRemoves);
    removeSpy.mockRestore();
  });
});

describe('MessageItem — text encoding (no HTML entity double-escape)', () => {
  it('renders apostrophes/quotes/ampersands literally, never as entities', () => {
    render(
      <MessageItem
        message={makeMessage({ content: "Nope - doesn't work. That's & fine <ok>" })}
        currentUserId={ME}
      />,
    );
    const content = screen.getByTestId('message-content').textContent ?? '';
    expect(content).toContain("doesn't work");
    expect(content).toContain("That's & fine <ok>");
    // The historical bug: entity-escaped text rendered literally.
    expect(content).not.toContain('&#39;');
    expect(content).not.toContain('&amp;');
    expect(content).not.toContain('&lt;');
  });
});

describe('MessageItem — seed-message thread indicator', () => {
  it('renders 🧵 name · replies · last activity and opens the thread on click', async () => {
    const onOpenThread = vi.fn();
    render(
      <MessageItem
        message={makeMessage()}
        currentUserId={ME}
        thread={{
          id: 't-1',
          name: 'Deploy talk',
          messageCount: 3,
          latestReplyAt: '2026-09-10T20:00:00Z',
        }}
        onOpenThread={onOpenThread}
      />,
    );
    const indicator = screen.getByTestId('thread-indicator');
    expect(indicator.textContent).toContain('Deploy talk');
    expect(indicator.textContent).toContain('3 replies');
    expect(indicator.textContent).toContain('last activity');
    await fireEvent.click(indicator);
    expect(onOpenThread).toHaveBeenCalledWith('t-1');
  });

  it('singularizes a single reply and omits activity for a reply-less thread', () => {
    render(
      <MessageItem
        message={makeMessage()}
        currentUserId={ME}
        thread={{ id: 't-2', name: 'Solo', messageCount: 1, latestReplyAt: null }}
      />,
    );
    const indicator = screen.getByTestId('thread-indicator');
    expect(indicator.textContent).toContain('1 reply');
    expect(indicator.textContent).not.toContain('last activity');
  });

  it('renders nothing when the message seeds no thread', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} />);
    expect(screen.queryByTestId('thread-indicator')).toBeNull();
  });
});

describe('MessageItem — edited marker + inline editing', () => {
  it('renders (edited) after the timestamp with the edit time as tooltip', () => {
    const editedAt = '2026-09-10T20:15:00.000Z';
    render(
      <MessageItem
        message={makeMessage({ edited_at: editedAt })}
        currentUserId={ME}
      />,
    );
    const marker = screen.getByTestId('message-edited');
    expect(marker.textContent).toBe('(edited)');
    expect(marker.getAttribute('title')).toContain('Edited');
    expect(marker.getAttribute('title')).toContain(new Date(editedAt).toLocaleString());
  });

  it('grouped rows carry the (edited) marker at the end of the text', () => {
    const editedAt = '2026-09-10T20:15:00.000Z';
    render(
      <MessageItem message={makeMessage({ edited_at: editedAt })} currentUserId={ME} grouped />,
    );
    const marker = screen.getByTestId('message-edited');
    expect(marker.textContent).toBe('(edited)');
    expect(marker.getAttribute('title')).toContain(new Date(editedAt).toLocaleString());
    // Exactly one marker per row (the header one is absent when grouped).
    expect(screen.getAllByTestId('message-edited')).toHaveLength(1);
  });

  it('renders no (edited) marker on an unedited message', () => {
    render(<MessageItem message={makeMessage()} currentUserId={ME} />);
    expect(screen.queryByTestId('message-edited')).toBeNull();
  });

  it('editing mode swaps the content for the inline editor and hides the toolbar', () => {
    render(
      <MessageItem
        message={makeMessage()}
        currentUserId={ME}
        editing
        onSaveEdit={vi.fn().mockResolvedValue(undefined)}
        onCancelEdit={vi.fn()}
        onToggleReaction={vi.fn()}
      />,
    );
    expect(screen.getByTestId('inline-edit')).toBeTruthy();
    expect(screen.queryByTestId('message-content')).toBeNull();
    // The hover toolbar's actions are meaningless mid-edit.
    expect(screen.queryByTestId('message-actions')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #118 — a permalink in a body renders as a chip
// ---------------------------------------------------------------------------
//
// The unit contract lives in PermalinkChip.test.tsx and the dispatch rule in
// markdown.test.tsx; this is the JOIN — the row that a reader actually sees.

describe('MessageItem — #118 permalink chip', () => {
  const CHANNEL_ID = '9007199254740993';
  const TARGET_ID = '4242';

  beforeEach(() => {
    // The chip's resolutions are module state that outlives a test: without
    // this, the second test here would render from the first one's cache.
    forgetPermalinkChipMessages();
  });

  afterEach(() => {
    // Unmount FIRST: the chip subscribes to the store, so clearing it while a
    // chip is still mounted would be a store write outside act.
    cleanup();
    defaultStore.setState({ channels: {} as never, membersById: {} as never });
  });

  /** The reader's own roster: the channel and the target's author, nameable. */
  function seedChipRoster(): void {
    defaultStore.setState({
      currentUser: { id: ME, username: 'me', avatar_url: null } as never,
      channels: {
        [CHANNEL_ID]: {
          id: CHANNEL_ID,
          workspace_id: '1',
          name: 'general',
          type: 'text',
          topic: null,
          position: 0,
          last_message_id: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      } as never,
      membersById: {
        [OTHER]: {
          id: OTHER,
          username: 'other',
          nickname: 'Max',
          roles: [],
          joined_at: '2026-01-01T00:00:00.000Z',
        },
      } as never,
    });
  }

  it('renders a same-instance message link as a chip, once the target resolves', async () => {
    seedChipRoster();
    vi.spyOn(api, 'getMessage').mockResolvedValue({
      ...makeMessage({ id: TARGET_ID, content: 'the deploy is green' }),
    } as never);

    const href = `${globalThis.location.origin}/#/workspace/1/channel/${CHANNEL_ID}/message/${TARGET_ID}`;
    const msg = makeMessage({ content: `context here ${href}` });
    render(<MessageItem message={msg} currentUserId={ME} store={defaultStore} />);

    const el = await screen.findByTestId('permalink-chip');
    expect(el.textContent).toContain('#general');
    expect(el.textContent).toContain('Max');
    expect(el.textContent).toContain('the deploy is green');
    expect(api.getMessage).toHaveBeenCalledWith(CHANNEL_ID, TARGET_ID);
    // The body's own words survive around it.
    expect(screen.getByTestId('message-content').textContent).toContain('context here');
  });

  it('renders a pasted /m/<token> link as a chip too — the form Copy Link writes now', async () => {
    // A token shaped like a minted one; only the server can read it, so the
    // mapping is stated rather than decoded (the resolve seam).
    const TOKEN = '3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3uP';
    const href = `${globalThis.location.origin}/m/${TOKEN}`;
    seedChipRoster();
    vi.spyOn(api, 'resolvePermalink').mockResolvedValue({
      channel_id: CHANNEL_ID,
      message_id: TARGET_ID,
    });
    vi.spyOn(api, 'getMessage').mockResolvedValue({
      ...makeMessage({ id: TARGET_ID, content: 'the deploy is green' }),
    } as never);

    const msg = makeMessage({ content: `context here ${href}` });
    render(<MessageItem message={msg} currentUserId={ME} store={defaultStore} />);

    const el = await screen.findByTestId('permalink-chip');
    expect(el.textContent).toContain('#general');
    expect(el.textContent).toContain('Max');
    expect(el.textContent).toContain('the deploy is green');
    // The token stays the link (what was copied keeps working)…
    expect(el.getAttribute('href')).toBe(href);
    // …and both halves of the resolve ran, the token one first.
    expect(api.resolvePermalink).toHaveBeenCalledWith(TOKEN);
    expect(api.getMessage).toHaveBeenCalledWith(CHANNEL_ID, TARGET_ID);
    expect(screen.getByTestId('message-content').textContent).toContain('context here');
  });
});


describe('MessageItem — the hover toolbar mounts lazily (#14)', () => {
  it('builds no toolbar at rest, and builds it on the first hover or focus', () => {
    const msg = makeMessage({ author_id: ME });
    const { container } = rtlRender(
      <MessageItem
        message={msg}
        currentUserId={ME}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onToggleReaction={vi.fn()}
      />,
    );
    // At rest: no toolbar, no picker, no buttons in the DOM.
    expect(screen.queryByTestId('message-actions')).toBeNull();
    expect(screen.queryByTestId('reaction-add')).toBeNull();
    const row = container.querySelector<HTMLElement>('[data-testid="message-item"]')!;
    fireEvent.mouseEnter(row);
    expect(screen.getByTestId('message-actions')).toBeTruthy();
    expect(screen.getByTestId('action-edit')).toBeTruthy();
  });

  it('focus entering the row builds it too (keyboard path)', () => {
    const msg = makeMessage({
      author_id: ME,
      reactions: [{ emoji: '👍', count: 1, me: false }],
    } as Partial<MessageWithBots>);
    rtlRender(<MessageItem message={msg} currentUserId={ME} onToggleReaction={vi.fn()} />);
    expect(screen.queryByTestId('message-actions')).toBeNull();
    act(() => {
      screen.getByTestId('reaction-chip').focus();
    });
    expect(screen.getByTestId('message-actions')).toBeTruthy();
  });
});
