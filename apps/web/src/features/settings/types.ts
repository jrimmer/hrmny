/**
 * @cytale/web — the integrations surface's shared shapes.
 *
 * `ChannelOption` is deliberately the same shape as an access-tree channel:
 * both are "a channel the caller may point something at", and having one type
 * means a channel picker and a grant row can never drift apart.
 */

/** A channel a picker or a grant row can point at. */
export interface ChannelOption {
  id: string;
  name: string;
}

/** A workspace a grant can target — the caller's own (R5). */
export interface TreeWorkspace {
  id: string;
  name: string;
}
