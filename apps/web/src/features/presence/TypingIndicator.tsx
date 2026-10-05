/**
 * @cytale/web — typing indicator (U23).
 *
 * Renders "A is typing…", "A and B are typing…", or "A, B, and +N others
 * are typing…" above the composer, with the animated three-dot cluster
 * (each dot glows up in order left→right, opacity-glow only, no scale
 * bounce; prefers-reduced-motion renders static dots). Typists are ordered
 * by most recent event; at most two names, then "+N others"; individual
 * names clamp before the aggregate count.
 *
 * Layout per the measured spec: the strip sits ABOVE and OUTSIDE the
 * composer field, absolutely positioned inside a relative wrapper with
 * ~18–20px reserved height so nothing shifts on appear/disappear.
 */

import { useMemo } from 'react';

import type { Typist } from './useTyping.js';

export interface TypingIndicatorProps {
  /** Typists currently typing, newest-first. */
  typists: Typist[];
  /** Display-name resolver (falls back to the user id). */
  displayName?: (userId: string) => string;
}

/** Build the aggregated label per the product rule (≤2 names + "+N others"). */
export function typingLabel(
  typists: Typist[],
  displayName: (userId: string) => string,
): string {
  if (typists.length === 0) return '';
  const names = typists.slice(0, 2).map((t) => displayName(t.userId));
  const others = typists.length - names.length;

  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2 && others === 0) return `${names[0]} and ${names[1]} are typing...`;
  if (names.length === 2) return `${names[0]}, ${names[1]}, and +${others} others are typing...`;
  return `${names[0]} is typing...`;
}

export function TypingIndicator({ typists, displayName }: TypingIndicatorProps) {
  const name = (id: string) => displayName?.(id) ?? id;

  const label = useMemo(() => typingLabel(typists, name), [typists, displayName]);
  if (label === '') return null;

  return (
    <div
      className="typing-indicator"
      data-testid="typing-indicator"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot" data-testid="typing-dot" data-dot="1" />
        <span className="typing-dot" data-testid="typing-dot" data-dot="2" />
        <span className="typing-dot" data-testid="typing-dot" data-dot="3" />
      </span>
      <span className="typing-label">
        <span className="typing-names">
          {label.replace(/ is typing\.\.\.$| are typing\.\.\.$/, '')}
        </span>
        <span className="typing-remainder">
          {label.includes(' is typing...') ? ' is typing...' : ' are typing...'}
        </span>
      </span>
    </div>
  );
}
