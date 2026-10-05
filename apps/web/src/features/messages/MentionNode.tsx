/**
 * The mention NODE: an inline decorator that renders `@DisplayName` while
 * composing and serializes to Discord's token `<@id>` (#66 follow-up).
 *
 * Why a node and not plain text: the wire form must be the ID (names are
 * mutable and non-unique — #66's own table shows a name match fires on
 * `@maxine`, on emails and on prose), but showing a raw snowflake in the
 * composer is unusable. The node keeps the id as its ONLY state and resolves
 * the display name at RENDER time from the roster, so a rename never leaves a
 * stale pill behind and a draft round-trip needs no hydration pass.
 *
 * Serialization rides `@lexical/markdown`'s text-match transformer: export
 * emits `<@id>`, import turns `<@id>` back into a node — which is also what
 * makes the message EDITOR show pills for an existing message instead of raw
 * tokens.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext.js';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { TextMatchTransformer } from '@lexical/markdown';
import { createContext, useContext, type JSX } from 'react';

import { defaultStore } from '@cytale/state';

import { channelNameOf } from './ChannelMentionPill.js';

/** Resolves a user id to a display name; undefined leaves the id showing. */
export type MentionNameResolver = (userId: string) => string | undefined;

/**
 * The composer provides the roster resolver; the pill reads it. A context
 * (not a prop) because Lexical renders the decorator outside the React tree
 * that created the node.
 */
export const MentionNameContext = createContext<MentionNameResolver | null>(null);

/** The token shape, shared by the transformer and the wire: `<@id>`/`<@!id>`. */
export const MENTION_TOKEN = /<@!?(\d{1,19})>/;

export type SerializedMentionNode = Spread<
  { id: string; type: 'mention'; version: 1 },
  SerializedLexicalNode
>;

function MentionPill({ id }: { id: string }): JSX.Element {
  const resolve = useContext(MentionNameContext);
  const name = resolve?.(id);

  // `data-user-id` keeps the id reachable for tests and for a future click
  // affordance; the text is what a screen reader announces, so it carries the
  // human name (never a bare snowflake) whenever the roster can resolve one.
  return (
    <span className="mention composer-mention" data-user-id={id} data-testid="composer-mention">
      @{name ?? id}
    </span>
  );
}

export class MentionNode extends DecoratorNode<JSX.Element> {
  __id: string;

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__id, node.__key);
  }

  constructor(id: string, key?: NodeKey) {
    super(key);
    this.__id = id;
  }

  getId(): string {
    return this.__id;
  }

  /** Inline, atomic and not a tab stop: arrow keys move THROUGH it and
   * backspace deletes it whole, which is what a token-like object should do. */
  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return false;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'composer-mention-host';
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  /** The DOM projection is the wire text — a copy/paste out of the composer
   * yields the token Discord clients parse, not the display name. */
  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.textContent = token(this.__id);
    return { element };
  }

  exportJSON(): SerializedMentionNode {
    return { id: this.__id, type: 'mention', version: 1 };
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return $createMentionNode(json.id);
  }

  decorate(): JSX.Element {
    return <MentionPill id={this.__id} />;
  }
}

// ---------------------------------------------------------------------------
// Channel mentions: `#name` in the composer, `<#id>` on the wire. The same
// shape as the member node above — the id is the only state, and the name is
// resolved at render so a rename never leaves a stale pill.
// ---------------------------------------------------------------------------

/** Resolves a channel id to its name; undefined shows `#unknown-channel`. */
export type ChannelNameResolver = (channelId: string) => string | undefined;

/**
 * The composer provides a resolver over its own store; without one (the
 * message editor) the pill reads the default store.
 */
export const ChannelNameContext = createContext<ChannelNameResolver | null>(null);

/** The channel token shape: `<#id>`. */
export const CHANNEL_TOKEN = /<#(\d{1,19})>/;

export type SerializedChannelMentionNode = Spread<
  { id: string; type: 'channel-mention'; version: 1 },
  SerializedLexicalNode
>;

function ChannelPill({ id }: { id: string }): JSX.Element {
  const resolve = useContext(ChannelNameContext);
  const name = resolve ? resolve(id) : channelNameOf(defaultStore, id);
  return (
    <span className="mention composer-mention" data-channel-id={id} data-testid="composer-channel-mention">
      #{name ?? 'unknown-channel'}
    </span>
  );
}

export class ChannelMentionNode extends DecoratorNode<JSX.Element> {
  __id: string;

  static getType(): string {
    return 'channel-mention';
  }

  static clone(node: ChannelMentionNode): ChannelMentionNode {
    return new ChannelMentionNode(node.__id, node.__key);
  }

  constructor(id: string, key?: NodeKey) {
    super(key);
    this.__id = id;
  }

  getId(): string {
    return this.__id;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return false;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'composer-mention-host';
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.textContent = channelToken(this.__id);
    return { element };
  }

  exportJSON(): SerializedChannelMentionNode {
    return { id: this.__id, type: 'channel-mention', version: 1 };
  }

  static importJSON(json: SerializedChannelMentionNode): ChannelMentionNode {
    return $createChannelMentionNode(json.id);
  }

  decorate(): JSX.Element {
    return <ChannelPill id={this.__id} />;
  }
}

export function channelToken(id: string): string {
  return `<#${id}>`;
}

export function $createChannelMentionNode(id: string): ChannelMentionNode {
  return $applyNodeReplacement(new ChannelMentionNode(id));
}

export function $isChannelMentionNode(
  node: LexicalNode | null | undefined,
): node is ChannelMentionNode {
  return node instanceof ChannelMentionNode;
}

/** `<#id>` ⇄ ChannelMentionNode, the member transformer's twin. */
export const CHANNEL_MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ChannelMentionNode],
  export: (node) => ($isChannelMentionNode(node) ? channelToken(node.getId()) : null),
  importRegExp: CHANNEL_TOKEN,
  regExp: new RegExp(`${CHANNEL_TOKEN.source}$`),
  replace: (textNode, match) => {
    const id = match[1];
    if (!id) return;
    textNode.replace($createChannelMentionNode(id));
  },
  type: 'text-match',
};

/** Discord's unambiguous token form — the id IS the mention. */
export function token(id: string): string {
  return `<@${id}>`;
}

export function $createMentionNode(id: string): MentionNode {
  return $applyNodeReplacement(new MentionNode(id));
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

/**
 * `<@id>` ⇄ MentionNode. Text-match is the right transformer kind: the token
 * is plain text on the wire, so markdown import/export stay byte-identical to
 * what the server stores and what every Discord client expects.
 */
export const MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MentionNode],
  export: (node) => ($isMentionNode(node) ? token(node.getId()) : null),
  importRegExp: MENTION_TOKEN,
  regExp: new RegExp(`${MENTION_TOKEN.source}$`),
  replace: (textNode, match) => {
    const id = match[1];
    if (!id) return;
    textNode.replace($createMentionNode(id));
  },
  type: 'text-match',
};

/** Editor bootstrap: the node must be registered or import fails. */
export const MENTION_NODES = [MentionNode, ChannelMentionNode];
