/**
 * @cytale/web — Home's mention inbox surface (#117).
 *
 * What the section must show (who, where, the sentence, when), what it must
 * do (deep-link the message, answer one row, sweep, retry a failed load), and
 * what it must NOT become: a second set of unread numbers. There is no count
 * anywhere in this markup — the assertion is deliberate, not incidental.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { parsePermalinkPath } from '@cytale/domain';

import { InboxSection, relativeTime, type InboxStore } from '../InboxSection.js';
import type { InboxItem } from '../inbox.js';

afterEach(cleanup);

const CHANNEL = '2000000000000002';
const WORKSPACE = '3000000000000003';
const MESSAGE = '1000000000000001';

const store: InboxStore = {
  channels: {
    [CHANNEL]: { name: 'release', type: 'text', workspace_id: WORKSPACE },
  },
  membersById: {
    '4000000000000004': { username: 'dana' },
    '4000000000000005': { username: 'sam' },
  },
};

function row(over: Partial<InboxItem> = {}): InboxItem {
  return {
    message_id: MESSAGE,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: '4000000000000004',
    author_username: 'dana',
    kind: 'mention',
    excerpt: 'can you look at <@4000000000000005>?',
    created_at: '2026-09-14T10:00:00.000Z',
    ...over,
  };
}

function renderSection(props: Partial<React.ComponentProps<typeof InboxSection>> = {}) {
  return render(
    <InboxSection
      store={store}
      items={[row()]}
      status="ready"
      onDismiss={vi.fn()}
      onSweep={vi.fn()}
      onRetry={vi.fn()}
      now={Date.parse('2026-09-14T12:00:00.000Z')}
      {...props}
    />,
  );
}

describe('InboxSection — a row answers "who, where, what, when"', () => {
  it('names the author, the channel, the sentence and the time', () => {
    renderSection();

    const line = screen.getByTestId(`inbox-item-${MESSAGE}`);
    expect(line.textContent).toContain('dana mentioned you in #release');
    expect(line.textContent).toContain('2h ago');
    // Mention tokens are resolved to names in the sentence.
    expect(line.textContent).toContain('can you look at @sam?');
  });

  it('reads the excerpt as the timeline does: markup dropped, never shown raw', () => {
    renderSection({ items: [row({ excerpt: '**Confirmed working:** the `deploy` step for <@4000000000000005>' })] });

    const sentence = screen.getByRole('link');
    expect(sentence.textContent).toBe('Confirmed working: the deploy step for @sam');
    expect(sentence.textContent).not.toMatch(/[*`]/);
    // The Done button's label carries the same plain text.
    expect(screen.getByTestId(`inbox-done-${MESSAGE}`).getAttribute('aria-label')).toBe(
      'Mark done: Confirmed working: the deploy step for @sam',
    );
  });

  it('deep-links the row to its message (#114 permalink)', () => {
    renderSection();

    const link = screen.getByRole('link');
    const hash = new URL(link.getAttribute('href')!).hash.replace(/^#/, '');

    expect(parsePermalinkPath(hash)).toMatchObject({
      kind: 'message',
      workspaceId: WORKSPACE,
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
    expect(link.textContent).toContain('can you look at @sam?');
  });

  it('falls back to the roster and to honest placeholders', () => {
    renderSection({
      store: { channels: {}, membersById: {} },
      items: [row({ author_username: null, channel_id: '2999999999999999' })],
    });

    expect(screen.getByTestId('inbox-list').textContent).toContain('someone mentioned you in #a channel');
  });

  it('marks a thread mention as a thread and keeps the parent channel address', () => {
    renderSection({
      items: [row({ thread_id: '5000000000000005' })],
    });

    expect(screen.getByTestId(`inbox-item-${MESSAGE}`).textContent).toContain('in #release in a thread');

    const hash = new URL(screen.getByRole('link').getAttribute('href')!).hash.replace(/^#/, '');
    expect(parsePermalinkPath(hash)).toMatchObject({ threadId: '5000000000000005' });
  });

  it('renders no unread COUNT anywhere — this is not a second set of numbers', () => {
    renderSection();

    const section = screen.getByTestId('home-inbox');
    // The one number-ish token in the section is the row's time.
    expect(section.textContent).not.toMatch(/\bunread\b/i);
    expect(screen.queryByTestId('inbox-count')).toBeNull();
  });

  it('does not duplicate the catch-up rollup (no channel tally rows)', () => {
    renderSection();

    expect(screen.queryByTestId('home-catchup')).toBeNull();
    expect(screen.queryByTestId(`catchup-channel-${CHANNEL}`)).toBeNull();
  });
});

describe('InboxSection — states', () => {
  // This surface used to vanish until it had something to say, which is how
  // the owner concluded there was no inbox at all. Idle now claims nothing and
  // shows nothing pending — the same steady line a loaded-but-empty backlog
  // gets — so the heading is always where a member expects it.
  it('stays present and says nothing is waiting, with no credential', () => {
    renderSection({ status: 'idle', items: [] });

    expect(screen.getByTestId('home-inbox')).toBeTruthy();
    // The checkmark stays; the sentence is the owner's (2026-09-15).
    expect(screen.getByTestId('inbox-empty').textContent).toMatch(/✓\s*Nothing new/);
  });

  it('announces loading', () => {
    renderSection({ items: [], status: 'loading' });

    // The shared pane skeleton (app/ui/PaneStates): an announced progressbar.
    expect(screen.getByTestId('inbox-loading')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /loading your mentions/i })).toBeTruthy();
  });

  it('announces the empty backlog', () => {
    renderSection({ items: [], status: 'ready' });

    expect(screen.getByTestId('inbox-empty').textContent).toMatch(/✓\s*Nothing new/);
    expect(screen.queryByTestId('inbox-list')).toBeNull();
  });

  it('offers a retry when the load failed, and hides no backlog behind it', async () => {
    const onRetry = vi.fn();
    renderSection({ status: 'error', error: 'Could not load your mentions.', onRetry });

    expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
    // The app's ONE retry copy — not "Try again" here and "Retry" elsewhere.
    expect(screen.getByTestId('inbox-retry').textContent).toBe('Retry');
    await userEvent.setup().click(screen.getByTestId('inbox-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders mention tokens as the body pills — channel tokens included — and the author avatar', () => {
    const withAvatars: InboxStore = {
      ...store,
      membersById: {
        '4000000000000004': { username: 'dana', avatar_url: '/api/v1/attachments/dana.png' },
        '4000000000000005': { username: 'sam' },
      },
    };
    renderSection({
      store: withAvatars,
      items: [row({ excerpt: 'ship <#2000000000000002> with <@!4000000000000005> and <#2999999999999999>' })],
    });

    const line = screen.getByTestId(`inbox-item-${MESSAGE}`);
    expect(line.textContent).not.toMatch(/<[@#]/);
    const channels = line.querySelectorAll('.mention.channel-mention');
    expect([...channels].map((c) => c.textContent)).toEqual(['#release', '#unknown-channel']);
    expect(line.querySelector('.mention[data-user-id]')!.textContent).toBe('@sam');
    // The Done button's label reads names, not tokens.
    expect(screen.getByTestId(`inbox-done-${MESSAGE}`).getAttribute('aria-label')).toBe(
      'Mark done: ship #release with @sam and #unknown-channel',
    );
    // The avatar carries the author's picture, not just an initial.
    expect(line.querySelector('img')?.getAttribute('src')).toContain('dana.png');
  });

  it('surfaces a failed done without hiding the backlog', () => {
    renderSection({ actionError: 'Could not mark that done.' });

    expect(screen.getByTestId('inbox-action-error').textContent).toMatch(/could not mark that done/i);
    expect(screen.getByTestId(`inbox-item-${MESSAGE}`)).toBeTruthy();
  });

  it('has no accessibility violations in the loaded state', async () => {
    const { container } = renderSection();

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations in the error state', async () => {
    const { container } = renderSection({ status: 'error', items: [], error: 'nope' });

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('InboxSection — done and sweep', () => {
  it('answers one row by its message id', async () => {
    const onDismiss = vi.fn();
    renderSection({ onDismiss });

    await userEvent.setup().click(screen.getByTestId(`inbox-done-${MESSAGE}`));

    expect(onDismiss).toHaveBeenCalledWith(MESSAGE);
  });

  it('sweeps the backlog', async () => {
    const onSweep = vi.fn();
    renderSection({ onSweep });

    await userEvent.setup().click(screen.getByTestId('inbox-sweep'));

    expect(onSweep).toHaveBeenCalledTimes(1);
  });

  it('disables both controls while a write is in flight', () => {
    renderSection({ busy: true });

    expect(screen.getByTestId('inbox-sweep').getAttribute('disabled')).not.toBeNull();
    expect(
      screen.getByTestId(`inbox-done-${MESSAGE}`).getAttribute('disabled'),
    ).not.toBeNull();
  });

  it('offers no sweep when there is nothing to sweep', () => {
    renderSection({ items: [], status: 'ready' });

    expect(screen.queryByTestId('inbox-sweep')).toBeNull();
  });

  it('the Done control is operable by keyboard', async () => {
    const onDismiss = vi.fn();
    renderSection({ onDismiss });

    const done = screen.getByTestId(`inbox-done-${MESSAGE}`);
    done.focus();
    expect(document.activeElement).toBe(done);

    await userEvent.setup().keyboard('{Enter}');

    expect(onDismiss).toHaveBeenCalledWith(MESSAGE);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-14T12:00:00.000Z');

  it('words recent times and falls back to a date', () => {
    expect(relativeTime('2026-09-14T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-09-14T11:45:00.000Z', now)).toBe('15m ago');
    expect(relativeTime('2026-09-14T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-09-12T12:00:00.000Z', now)).toBe('2d ago');
    expect(relativeTime('2026-08-01T12:00:00.000Z', now)).not.toMatch(/ago/);
  });

  it('renders nothing rather than "NaN" for a missing or broken stamp', () => {
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('InboxSection — the heading takes the column it is rendered into', () => {
  it('reads "Inbox" in the column idiom beside Direct Messages and Mentions', () => {
    renderSection({ variant: 'column', items: [], status: 'ready' });
    const heading = screen.getByRole('heading', { name: 'Inbox' });
    // Same element + class as the column's other headings, so it shares their
    // padding and tracking instead of the dashboard's wider label.
    expect(heading.tagName).toBe('H3');
    expect(heading.className).toContain('category-label');
    expect(heading.className).not.toContain('home-section-label');
  });

  it('keeps the dashboard idiom in the wider body', () => {
    renderSection({ items: [], status: 'ready' });
    const heading = screen.getByRole('heading', { name: 'Inbox' });
    expect(heading.tagName).toBe('H2');
    expect(heading.className).toContain('home-section-label');
  });
});

describe('InboxSection — the author reads as they do everywhere else', () => {
  const BOT = '4000000000000009';
  const OWNER = '4000000000000004';
  const botStore: InboxStore = {
    ...store,
    membersById: {
      [OWNER]: { username: 'dana', nickname: 'Dana Scully' },
      [BOT]: { username: 'mia', nickname: 'Mia Helper', kind: 'bot', parent_user_id: OWNER },
    },
  };

  it('draws the shared avatar at the two-line-row size, with the agent seal for a machine author', () => {
    renderSection({ store: botStore, items: [row({ author_id: BOT, author_username: 'mia' })] });

    const line = screen.getByTestId(`inbox-item-${MESSAGE}`);
    const avatar = line.querySelector('.avatar')!;
    // The sizing class from the one scale (shell.css) — not a bare, unshaped tile.
    expect(avatar.classList.contains('inbox-row-avatar')).toBe(true);
    expect(avatar.textContent).toBe('MH');
    const seal = avatar.querySelector('[data-testid="kind-badge"]');
    expect(seal?.getAttribute('title')).toBe('Agent account, via Dana Scully');
    // A mention is a message: no presence dot, as on message avatars.
    expect(avatar.hasAttribute('data-presence')).toBe(false);
  });

  it('names the author by the timeline chain (nickname, then handle)', () => {
    renderSection({ store: botStore, items: [row({ author_id: BOT, author_username: 'mia' })] });

    const line = screen.getByTestId(`inbox-item-${MESSAGE}`);
    expect(line.querySelector('.inbox-row-author')!.textContent).toBe('Mia Helper');
    expect(line.textContent).toContain('Agent account, via Dana Scully');
  });
});
