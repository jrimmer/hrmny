/**
 * @cytale/web — messages feature local types (U12 attribution/embeds render).
 *
 * The bots-plan message JSON carries two optional native keys the shared
 * domain `Message` interface does not declare yet: `embeds` (webhook-driven
 * rich cards) and `author_override` (per-message webhook identity). The
 * reactions unit adds `reactions` (aggregate chips) the same way. All are
 * ABSENT when not applicable, and the api-client passes message JSON through
 * untouched, so they ride runtime rows. `packages/**` is outside these
 * units' surfaces — this intersection types the render half without widening
 * the shared model; if the domain later declares the keys, this alias stays
 * structurally compatible.
 */

import type { ReactionSummary } from '@cytale/api-client';
import type { Message } from '@cytale/domain';

/** name/value pair contract of an embed's `fields` array. */
export interface EmbedField {
  name: string;
  value: string;
}

/**
 * URL ref of an embed's `image` / `thumbnail` (Discord embed media keys).
 * Untrusted producer JSON: only the `url` renders, string-checked at render
 * time; width/height, when both are numbers, size the reserved media box
 * before the image loads (#10).
 */
export interface EmbedMediaRef {
  url?: string;
  /** The server's same-origin copy of an EXTERNAL `url` (media proxy),
   * minted per render. The only URL an `<img>` loads; `url` stays for the
   * "open original" link. Absent for our own attachment URLs. */
  proxy_url?: string;
  width?: number;
  height?: number;
}

/**
 * Render contract of one embed: title, description, fields, and the media
 * refs (`image`, `thumbnail`) rendered as lazy images inside the card.
 * Producers send arbitrary JSON objects; unknown keys are inert and every
 * value is treated as untrusted (string-checked at render time, never
 * dangerouslySet).
 */
export interface MessageEmbed {
  title?: string;
  description?: string;
  fields?: EmbedField[];
  image?: EmbedMediaRef | null;
  thumbnail?: EmbedMediaRef | null;
}

/**
 * Per-message webhook override. v1 renders `username` only; `avatar_url` is
 * stored-only (documented in MessageItem) — never rendered.
 */
export interface AuthorOverride {
  username: string;
  avatar_url?: string | null;
  /**
   * The author kind the server stamps on every override (only a webhook
   * execute writes one): the row's badge comes from the MESSAGE, so a
   * webhook posting under a member's name is never shown unbadged.
   */
  kind?: 'webhook';
}

/**
 * Message plus the bots-plan optional native keys (absent when n/a), plus
 * the reactions unit's optional `reactions` aggregate array (ABSENT when the
 * message has none — same wire contract as `embeds`). `components` (the
 * action rows) is declared on the shared domain Message already — it rides
 * this alias structurally.
 */
export type MessageWithBots = Message & {
  embeds?: MessageEmbed[] | null;
  author_override?: AuthorOverride | null;
  /** Reaction chips (emoji + count + me); absent/empty → no chip row. */
  reactions?: ReactionSummary[] | null;
  /** Markdown images in `content`: source URL → the server's signed
   * same-origin proxy URL (protocol `content_proxy_urls`). Absent when the
   * body has no external image; an image without an entry renders as a link. */
  content_proxy_urls?: Record<string, string> | null;
};

// ---------------------------------------------------------------------------
// Component render contracts (components plan U4 — R7)
// ---------------------------------------------------------------------------

/**
 * One parsed interactive button. `customId` is null only for defensively
 * malformed rows (styles 1-4 without a custom_id — validation makes this
 * impossible server-side); such controls render disabled and never submit.
 * Style 5 is the link variant (`url`, an anchor — never a POST).
 */
export interface ParsedButtonControl {
  kind: 'button';
  customId: string | null;
  label: string;
  /** Discord styles 1-4 interactive, 5 link. */
  style: number;
  /** Style 5's raw url (untrusted — scheme-guarded again at render, KTD7). */
  url?: unknown;
  disabled: boolean;
}

/** One string-select option (label/value string-checked; description optional). */
export interface ParsedSelectOption {
  label: string;
  value: string;
  description?: string;
}

/** One parsed string select (single-select v1 per the R1 max_values ≤ 1 cap). */
export interface ParsedSelectControl {
  kind: 'select';
  customId: string | null;
  placeholder: string;
  options: ParsedSelectOption[];
  disabled: boolean;
  /** Discord's min/max_values (#30), defaulted to 1 and clamped to the
   * option count. `maxValues > 1` renders the multi-pick variant. */
  minValues: number;
  maxValues: number;
}

export type ParsedControl = ParsedButtonControl | ParsedSelectControl;
