/**
 * @cytale/web — TypingIndicator tests (U23).
 *
 * Label aggregation (≤2 names + "+N others"), the animated dot cluster, and
 * the empty state (no typists → nothing rendered).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

import { TypingIndicator, typingLabel } from '../TypingIndicator.js';

const name = (id: string) => (id === 'a' ? 'Alice' : id === 'b' ? 'Bob' : id);

describe('typingLabel', () => {
  it('singular form for one typist', () => {
    expect(typingLabel([{ userId: 'a', lastTypedAt: 1 }], name)).toBe('Alice is typing...');
  });

  it('two names for two typists', () => {
    expect(
      typingLabel(
        [
          { userId: 'a', lastTypedAt: 2 },
          { userId: 'b', lastTypedAt: 1 },
        ],
        name,
      ),
    ).toBe('Alice and Bob are typing...');
  });

  it('aggregates +N others beyond two names', () => {
    expect(
      typingLabel(
        [
          { userId: 'a', lastTypedAt: 3 },
          { userId: 'b', lastTypedAt: 2 },
          { userId: 'c', lastTypedAt: 1 },
        ],
        name,
      ),
    ).toBe('Alice, Bob, and +1 others are typing...');
  });

  it('empty for no typists', () => {
    expect(typingLabel([], name)).toBe('');
  });
});

describe('TypingIndicator', () => {
  it('renders nothing when no typists', () => {
    const { container } = render(<TypingIndicator typists={[]} displayName={name} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the label and dot cluster for a typist', () => {
    render(<TypingIndicator typists={[{ userId: 'a', lastTypedAt: 1 }]} displayName={name} />);
    expect(screen.getByTestId('typing-indicator')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Alice is typing...');
    expect(screen.getAllByTestId('typing-dot')).toHaveLength(3);
  });
});

/**
 * The pill contract (owner direction 2026-09-12): the indicator carries its OWN
 * background, only as wide as its contents — not a full-width band — and it
 * does so by PAINTING (padding plus an equal negative margin) rather than by
 * growing the text box, so the dots stay in the avatar column and the label on
 * the message content inset. jsdom has no layout engine, so this reads the
 * stylesheet — the same idiom the mobile settings-list contract uses.
 */
describe('shell.css — the typing pill (stylesheet pin)', () => {
  // Same WEB_ROOT idiom as SettingsMobile's stylesheet pin (four levels up
  // from a feature's `__tests__/`).
  const css = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'src', 'app', 'theme', 'shell.css'),
    'utf8',
  );

  it('the typing line reserves NO space — it exists only while a typist does', () => {
    const rule = css.slice(css.indexOf('.typing-line {'));
    const body = rule.slice(0, rule.indexOf('}'));
    // Owner direction 2026-09-14: the band's permanent reservation is gone
    // ("Typing-band needs to go"), so an idle channel shows nothing between
    // the timeline and the well. The line's own element is rendered only when
    // someone is typing (MessageCompose gates it on the typist list), which is
    // why a reserved min-height here would be the bug, not the safeguard.
    expect(body).not.toContain('min-height');
    expect(body).not.toContain('height:');
    // Visibility only: the 16px inset is what holds the pill's column while the
    // line is on screen.
    expect(body).toContain('padding: 0 16px');
  });

  it('the indicator paints a content-sized pill rather than a full-width band', () => {
    const rule = css.slice(css.indexOf('.typing-indicator {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('background: var(--color-surface-strong)');
    expect(body).toContain('border-radius: var(--radius-full)');
    // Padding paints, the equal negative margin cancels it, so the text does
    // not move. Losing one of the pair silently breaks the alignment.
    expect(body).toContain('padding: 2px 10px');
    expect(body).toContain('margin: -2px -10px');
  });
});
