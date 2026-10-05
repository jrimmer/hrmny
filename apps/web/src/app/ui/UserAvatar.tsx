/**
 * @cytale/web — Avatar: the one identity circle.
 *
 * Renders the uploaded image when `src` is set and loads, falling back to
 * the deterministic hue tile every surface already shared (avatar.ts) when
 * there is no image — and when the image FAILS to load (a stale blob hash
 * after a store reset must never paint a broken-image icon). No crop
 * pipeline in v1: the img fills the circle via object-fit cover, so any
 * aspect renders centered.
 *
 * Shape is not the caller's business: the base `.avatar` class (shell.css)
 * is a complete default — a circle with centred, size-scaled initials and an
 * img that fills and clips to it. A surface picks only a SIZE, from the one
 * scale: a sizing class that sets `--avatar-size` (`.people-avatar`,
 * `.home-avatar`, …) or the `size` prop. Callers used to restate the shape
 * per surface, and one that passed nothing got a square tile with body-sized
 * initials (Home's inbox, owner report 2026-09-28).
 *
 * Machine principals (bot/agent/webhook) carry a ROBOT SEAL at the avatar's
 * top-right — the mirror of the presence dot at the bottom-right. It replaced
 * the inline "BOT" text pill (user direction 2026-09-11): one marker on the
 * identity circle, where a reader is already looking, instead of a word in
 * the name line. The glyph is decorative (the surrounding row carries the
 * accessible attribution); its tooltip names the kind and, for a machine
 * entry, the human it belongs to.
 */
import { useState } from 'react';
import type { PrincipalKind } from '@cytale/domain';

import { assetUrl } from '../origin.js';
import { avatarInitials, avatarTileStyle } from './avatar.js';
import { useRetryingImage } from './useRetryingImage.js';

export type AvatarProps = Omit<React.ComponentProps<'span'>, 'children' | 'style'> & {
  /** Identity for the fallback tile's deterministic hue (prefer the id). */
  id?: string;
  /** Display name — initials for the fallback tile. */
  name: string;
  /** Uploaded image url (attachment path); empty/absent renders the tile. */
  src?: string | null;
  /** Principal kind; a machine kind renders the robot seal. */
  kind?: PrincipalKind | null;
  /** Owning human's display name (machine principals only). */
  parentName?: string | null;
  /**
   * Diameter in px, for a surface without a sizing class in shell.css.
   * Sets `--avatar-size`; the initials and the circle scale with it.
   */
  size?: number;
  /**
   * How many initials the fallback tile shows (default 2). A workspace tile
   * is ONE character on the rail, so its settings preview asks for 1.
   */
  maxInitials?: 1 | 2;
};

/**
 * Machine kinds worded for people; humans have no word (and no seal). One
 * user-facing word covers every machine credential (R1): a workspace-scoped
 * credential and a user-scoped one are the same thing to a reader — an
 * agent — and their distinct internal kinds (`:bot` / `:agent`) never
 * surface as vocabulary.
 */
const KIND_WORD: Partial<Record<PrincipalKind, string>> = {
  bot: 'Agent',
  agent: 'Agent',
  webhook: 'Webhook',
};

/** Accessible/tooltip text for a machine principal: "Agent", "Agent via Ada". */
export function kindTitle(
  kind: PrincipalKind | null | undefined,
  parentName?: string | null,
): string {
  const word = kind ? KIND_WORD[kind] : undefined;
  if (!word) return '';
  return parentName ? `${word} account, via ${parentName}` : `${word} account`;
}

/**
 * The robot seal drawn on machine avatars.
 *
 * Drawn to FILL its box: the seal is ~12px, so the head, the antenna and the
 * two eye cut-outs are the only shapes with room to survive — a small detailed
 * head collapses into an unreadable blob (user report 2026-09-11: "doesn't
 * read robot to me"). The antenna is what makes it a robot rather than a
 * domino, so it stays legible even at the smallest size.
 */
function RobotGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="9" height="9" aria-hidden="true" focusable="false">
      {/* antenna */}
      <circle cx="12" cy="2.7" r="2.3" fill="currentColor" />
      <rect x="10.8" y="3.4" width="2.4" height="3.4" fill="currentColor" />
      {/* head */}
      <rect x="1.8" y="5.8" width="20.4" height="14.8" rx="4.6" fill="currentColor" />
      {/* eyes */}
      <circle cx="8.1" cy="12.6" r="3.3" fill="var(--seal-disc)" />
      <circle cx="15.9" cy="12.6" r="3.3" fill="var(--seal-disc)" />
    </svg>
  );
}

export function Avatar({
  id,
  name,
  src,
  kind,
  parentName,
  className,
  size,
  maxInitials = 2,
  ...rest
}: AvatarProps) {
  // Code points, never UTF-16 units (a surrogate pair is one initial).
  const initials = Array.from(avatarInitials(name)).slice(0, maxInitials).join('');
  const sizeStyle = size ? ({ '--avatar-size': `${size}px` } as React.CSSProperties) : undefined;
  // Server-relative attachment paths (`/api/v1/attachments/<hash>`) resolve
  // against the configured origin in the desktop shell; unchanged in the browser.
  // A failed load retries (with a cache bust) before the tile is pinned: the
  // URL is content-addressed, so a transient 404 would otherwise stick until
  // the app restarted.
  const { url, onError, onLoad, retry } = useRetryingImage(assetUrl(src));

  // Every avatar carries the base `avatar` class: the presence dot and the
  // agent seal anchor to the AVATAR, so a caller that passes its own class
  // (`.people-avatar`, `.home-avatar`, …) still gets both. Anchor-less avatars
  // used to put the seal wherever the nearest positioned ancestor happened to
  // be — on Home's DM rows it landed at the far right of the row (owner report
  // 2026-09-15).
  const avatarClass = className ? `avatar ${className}` : 'avatar';

  const seal = kindTitle(kind, parentName);
  const sealNode = seal ? (
    <span className="avatar-kind" data-kind={kind} data-testid="kind-badge" title={seal} aria-hidden="true">
      <RobotGlyph />
    </span>
  ) : null;

  if (!url) {
    // A real src that exhausted its retries becomes an operable retry
    // button — the manual re-attempt covers the byte-identical re-upload
    // (same hash, same URL) the automatic cycle cannot (#47).
    if (src) {
      return (
        <span
          role="button"
          tabIndex={0}
          aria-label="Retry loading image"
          className={avatarClass}
          style={{ ...avatarTileStyle(id ?? name), ...sizeStyle }}
          onClick={retry}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              retry();
            }
          }}
          {...rest}
        >
          {initials}
          {sealNode}
        </span>
      );
    }

    return (
      <span
        aria-hidden
        className={avatarClass}
        style={{ ...avatarTileStyle(id ?? name), ...sizeStyle }}
        {...rest}
      >
        {initials}
        {sealNode}
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={avatarClass}
      style={sizeStyle}
      {...rest}
    >
      {/* Fills and clips to the circle: `.avatar > img` in shell.css. */}
      <img src={url} alt="" loading="lazy" onError={onError} onLoad={onLoad} />
      {sealNode}
    </span>
  );
}
