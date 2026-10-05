/**
 * @cytale/web — presence indicator (U23).
 *
 * Per-user status dot/icon: online (green), idle (amber), dnd (red),
 * offline (gray). Rendered in the member list and message author avatars.
 * Accessible: the status is conveyed via aria-label, not color alone.
 */

import type { PresenceStatus } from '@cytale/protocol';

export interface PresenceIndicatorProps {
  status: PresenceStatus;
  /** Optional accessible label override (defaults to the status word). */
  label?: string;
}

export function PresenceIndicator({ status, label }: PresenceIndicatorProps) {
  return (
    <span
      className="presence-indicator ring-2 ring-surface-emphasized"
      data-testid={`presence-${status}`}
      data-presence={status}
      role="img"
      aria-label={label ?? status}
    />
  );
}
