/**
 * @cytale/domain — the ONE message-permalink grammar (#114, #118).
 *
 * ## Two shapes, and which one is "the link"
 *
 * The COPIED link is not in this grammar any more. Since #118 (option B) Copy
 * Link mints an opaque, server-keyed token and writes
 * `https://<origin>/m/<token>` — one segment that publishes nothing about how
 * the app is organised (no `workspace`/`channel`/`message` keywords, no ids,
 * no length that varies with the target). Only the server can mint or read one
 * — the key never leaves it (`Cytale.Permalinks`), which is why there is no
 * token machinery in this module, only the alphabet the token shares with the
 * ids below.
 *
 * What lives HERE is the app's own route grammar: the shape the SPA routes on,
 * the shape the OS scheme (`cytale://workspace/1/channel/2/message/3`) hands
 * over, the shape the mobile client writes, and the shape every permalink
 * copied before #118 spells in somebody's history. Those links must keep
 * resolving forever, so this grammar, its parsers and its spellings are
 * untouched.
 *
 * Before this module there were two spellings of the same address and no
 * shared definition: `apps/web/src/tauri/deepLink.ts` parsed the OS scheme
 * (`cytale://workspace/1/channel/2/message/3`, the boundary a Tauri/Expo
 * launch hands over) with one regex, and
 * `apps/web/src/features/threads/useThreads.ts` parsed the in-app path
 * (`/workspace/1/channel/2/message/3`) with another. A "Copy Link" button
 * would have been the third writer of a shape nobody owned, so the grammar
 * lives here and both boundaries DELEGATE to it — the OS boundary keeps its
 * security work (scheme match, length cap), the route keeps its job
 * (strip the leading `/`), and the segment rules exist once.
 *
 * ## The grammar
 *
 * Each segment NESTS inside the one before it, exactly as the scheme parser
 * always required: a message id without its channel has no route to land on,
 * so it cannot parse alone.
 *
 *     workspace/<ws>                                          → the workspace
 *     workspace/<ws>/channel/<ch>                             → a channel
 *     workspace/<ws>/channel/<ch>/thread/<t>                  → a thread
 *     workspace/<ws>/channel/<ch>[/thread/<t>]/message/<mid>  → a message
 *     channel/<ch>[/thread/<t>]/message/<mid>                 → a DM message
 *
 * The workspace prefix is OPTIONAL because a DM channel has no workspace
 * (`Channel.workspace_id` is null for one): its channel id is already
 * globally unique, so `channel/<ch>` is a complete address on its own. That
 * is the same grammar with one optional root, not a second one.
 *
 * ## The id spelling — base62, with the decimal spelling still read (#118)
 *
 * Nobody copies THIS spelling any more (`/m/<token>` is what Copy Link
 * writes), but the grammar still sizes itself for pasted text — it is what the
 * mobile client and the OS scheme write, and what an old link says — so
 * `buildPermalinkPath` writes every id in base62, which turns a 17-digit
 * snowflake into 10 characters:
 *
 *     …/#/workspace/92562633470771200/channel/92562633470771201/message/92562633470771202
 *     …/#/workspace/gZ6jet53G8       /channel/gZ6jet53G9       /message/gZ6jet53Ha
 *
 * The GRAMMAR is unchanged (the same segments, the same nesting, the same DM
 * form) — only the digits inside an id segment are. Both spellings must read,
 * because links copied before this change are in circulation and a permalink
 * that stops working is the one thing a permalink may not do. `parsePermalinkPath`
 * therefore accepts either, and `PermalinkTarget` always carries DECIMAL ids:
 * the decode normalizes, so every consumer downstream (route state, the
 * resolver) sees the canonical snowflake either way.
 *
 * ## Why the two spellings cannot be confused
 *
 * The decimal spelling is a per-token FALLBACK, not a second grammar: a token
 * of digits is a snowflake (that is what `1001` always meant), anything else
 * is read as base62. That is unambiguous because the base62 alphabet is
 * ordered LETTERS FIRST (`a…zA…Z0…9`), so a canonical base62 token always
 * starts with a letter — no encoded id can ever look like a legacy decimal
 * one, and no extra marker character has to ride in the URL to tell them
 * apart. `1001` stays the snowflake 1001; `qj` is that same id, shorter.
 *
 * ## Why the parse is strict
 *
 * A permalink is attacker-writable text that ends up in route state, so the
 * parse is a boundary rather than a convenience: the input is percent-decoded
 * ONCE (guarded — malformed sequences are a rejection, not a crash) so an
 * encoded id cannot smuggle a separator past the segment split, every id token
 * must then be a bare snowflake or a canonical base62 id that fits in a u64,
 * and every literal keyword is matched exactly.
 */

export interface PermalinkTarget {
  kind: 'workspace' | 'channel' | 'thread' | 'message';
  /**
   * The workspace, or `undefined` for a DM address (`channel/<ch>` with no
   * workspace segment). Present on every workspace-channel and message
   * address; a channel target may legitimately lack it.
   */
  workspaceId?: string;
  channelId?: string;
  /**
   * A thread is addressed as a SEGMENT between the channel and the message,
   * because a notification for a thread reply has to land inside the thread
   * rather than the parent channel — and before this segment existed there
   * was no link shape that could express it.
   */
  threadId?: string;
  messageId?: string;
}

/**
 * Snowflakes are decimal and fit in a u64 (20 digits max). Anything else is
 * not an id this app can address, and rejecting it here is what keeps the
 * parse from becoming a generic string pass-through into route state.
 */
const ID_RE = /^\d{1,20}$/;

/**
 * The base62 alphabet, LETTERS FIRST (the `a-zA-Z0-9` ordering). The ordering
 * is load-bearing, not cosmetic: it is what makes a canonical encoding always
 * begin with a letter, which is in turn what makes "all digits ⇒ legacy
 * snowflake" a total rule rather than a heuristic (see the module header).
 */
const B62_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * A canonical base62 id is at most 11 characters: `62^11` already exceeds a
 * u64, so a 12-character token is out of address space whatever it decodes
 * to. The cap is what keeps a `z`-run from becoming a BigInt walk.
 */
const B62_MAX_LENGTH = 11;

/** The largest id this schema can hold (u64) — the decode's ceiling. */
const U64_MAX = 18_446_744_073_709_551_615n;

const WORKSPACE = 'workspace';
const CHANNEL = 'channel';
const THREAD = 'thread';
const MESSAGE = 'message';

/**
 * Decode percent sequences once. `decodeURIComponent` throws on malformed
 * input (`%`, `%zz`), which is itself a rejection — not a crash.
 */
function decodeOnce(value: string): string | null {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isId(value: string | undefined): value is string {
  return value !== undefined && ID_RE.test(value);
}

/**
 * Write one id the way a copied link carries it (#118): base62, so a
 * 17-digit snowflake costs 10 characters. Null for anything that is not a
 * snowflake this schema can hold — the same refusal `buildPermalinkPath`
 * needs, so a caller can never mint a link the parser would fail to read.
 */
function encodeId(id: string): string | null {
  if (!isId(id)) return null;
  let value = BigInt(id);
  if (value > U64_MAX) return null;
  let out = '';
  while (value > 0n) {
    out = B62_ALPHABET[Number(value % 62n)] + out;
    value /= 62n;
  }
  // Value 0 (an id no snowflake generator produces, but `ID_RE` admits it as
  // "0") encodes as the alphabet's first character, never the empty string.
  return out === '' ? B62_ALPHABET[0]! : out;
}

/**
 * Read one id SEGMENT back to its decimal snowflake, from either spelling:
 * the base62 one this module writes, or the decimal one links copied before
 * #118 carry (see the module header for why "all digits" is a total rule).
 * Returns null when the segment is neither.
 */
function decodeId(token: string | undefined): string | null {
  if (token === undefined) return null;
  // The legacy decimal spelling, kept forever: it is what every link in
  // circulation before #118 says, and `1001` must keep meaning 1001.
  if (ID_RE.test(token)) return token;
  if (token.length > B62_MAX_LENGTH) return null;

  let value = 0n;
  for (const char of token) {
    const digit = B62_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 62n + BigInt(digit);
  }
  if (value > U64_MAX) return null;
  return value.toString();
}

/**
 * Parse a permalink PATH — `/workspace/1/channel/2/message/3`, or the same
 * string without its leading slash (which is how the OS scheme parser has
 * it after the scheme is stripped). Each id may be spelled either way: the
 * base62 form `buildPermalinkPath` writes, or the decimal form a link copied
 * before #118 carries. The returned target is always DECIMAL.
 *
 * Returns null for anything that is not a complete address in the grammar
 * above: an unknown keyword, a missing parent segment, a trailing slash, a
 * query string, a fragment, or an id that is neither a bare snowflake nor a
 * canonical base62 id.
 */
export function parsePermalinkPath(path: string): PermalinkTarget | null {
  if (typeof path !== 'string' || path.length === 0) return null;

  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  if (trimmed.length === 0) return null;

  // Every segment is decoded before it is judged: an id that decoded to
  // something containing a separator is not an id, and an empty segment
  // (a double slash, or a trailing one) is not a segment.
  const parts: string[] = [];
  for (const raw of trimmed.split('/')) {
    const decoded = decodeOnce(raw);
    if (decoded === null || decoded === '') return null;
    parts.push(decoded);
  }

  let i = 0;
  let workspaceId: string | undefined;
  let channelId: string | undefined;
  let threadId: string | undefined;
  let messageId: string | undefined;

  if (parts[i] === WORKSPACE) {
    workspaceId = decodeId(parts[i + 1]) ?? undefined;
    if (workspaceId === undefined) return null;
    i += 2;
  }

  if (parts[i] === CHANNEL) {
    channelId = decodeId(parts[i + 1]) ?? undefined;
    if (channelId === undefined) return null;
    i += 2;

    if (parts[i] === THREAD) {
      threadId = decodeId(parts[i + 1]) ?? undefined;
      if (threadId === undefined) return null;
      i += 2;
    }

    if (parts[i] === MESSAGE) {
      messageId = decodeId(parts[i + 1]) ?? undefined;
      if (messageId === undefined) return null;
      i += 2;
    }
  }

  // Everything must have been consumed: a suffix the grammar does not know
  // is not a target we can render.
  if (i !== parts.length) return null;
  // A bare id with neither a workspace nor a channel ("/42") is not an
  // address; `/workspace` alone is not one either (the id check above
  // already rejected it).
  if (workspaceId === undefined && channelId === undefined) return null;

  if (messageId !== undefined) {
    return { kind: 'message', workspaceId, channelId, threadId, messageId };
  }
  if (threadId !== undefined) {
    return { kind: 'thread', workspaceId, channelId, threadId };
  }
  if (channelId !== undefined) {
    return { kind: 'channel', workspaceId, channelId };
  }
  return { kind: 'workspace', workspaceId };
}

/**
 * The path half of a permalink — no origin, no `#`. Every id is written in
 * base62 (#118), so the path is the SHORT spelling of the same address.
 * Returns null when the parts do not describe an address (`channelId`-less
 * message, a non-snowflake id), so a caller can never mint a link the parser
 * would refuse to read.
 *
 * `buildPermalinkPath(parsePermalinkPath(path))` is that path's CANONICAL
 * form, not necessarily `path` itself: the parser also reads the legacy
 * decimal spelling, which a builder never writes (both are pinned by the
 * tests).
 */
export function buildPermalinkPath(target: PermalinkTarget): string | null {
  const { workspaceId, channelId, threadId, messageId } = target;

  if (threadId !== undefined && channelId === undefined) return null;
  if (messageId !== undefined && channelId === undefined) return null;
  if (channelId === undefined && workspaceId === undefined) return null;

  const parts: string[] = [];
  const push = (keyword: string, id: string): boolean => {
    const encoded = encodeId(id);
    if (encoded === null) return false;
    parts.push(keyword, encoded);
    return true;
  };

  if (workspaceId !== undefined && !push(WORKSPACE, workspaceId)) return null;
  if (channelId !== undefined && !push(CHANNEL, channelId)) return null;
  if (threadId !== undefined && !push(THREAD, threadId)) return null;
  if (messageId !== undefined && !push(MESSAGE, messageId)) return null;
  return `/${parts.join('/')}`;
}

export interface MessagePermalinkParts {
  /** The absolute origin, e.g. `https://chat.example.com` (no trailing `/`). */
  origin: string;
  /** The workspace, or null/undefined for a DM message (no workspace). */
  workspaceId?: string | null;
  channelId: string;
  /** The thread the message is a reply in, when it is one. */
  threadId?: string | null;
  messageId: string;
}

/**
 * The absolute URL for a message in the app's own hash grammar:
 *
 *     https://chat.example.com/#/workspace/gZ6jet53G8/channel/gZ6jet53G9/message/gZ6jet53Ha
 *     https://chat.example.com/#/workspace/1/channel/2/thread/4/message/3
 *     https://chat.example.com/#/channel/2/message/3            (a DM)
 *
 * The path is the base62 spelling (#118); the ids above are the ones the
 * parser normalizes back to, so a link is short AND round-trips.
 *
 * It is NOT what Copy Link puts on the clipboard any more — that is the
 * server-minted `https://<origin>/m/<token>` (#118 option B), which no client
 * can build because the key is the server's. This is the IN-APP address: the
 * hyperlink a surface renders to navigate inside the app (the inbox rows) and
 * the address the OS scheme is translated into. Mobile does not copy it
 * either — since #118 that client mints a token like every other — and the
 * fragment spelling survives because it is in people's histories and because
 * the app still ROUTES it, not because anyone still writes it to a clipboard.
 *
 * The SPA is served at the origin root and routes on the HASH (U19), which is
 * why the `#` is load-bearing: the fragment is what the router reads, and it
 * is also what keeps the link working when the page has not loaded yet.
 * `origin` is a parameter (not read from a global) so the desktop shell can
 * pass its SERVER origin — inside the shell `location.origin` is
 * `tauri://localhost`, which nobody else can open.
 *
 * Returns null for the same shapes `buildPermalinkPath` refuses.
 */
export function buildMessagePermalink(parts: MessagePermalinkParts): string | null {
  const path = buildPermalinkPath({
    kind: 'message',
    workspaceId: parts.workspaceId ?? undefined,
    channelId: parts.channelId,
    threadId: parts.threadId ?? undefined,
    messageId: parts.messageId,
  });
  if (path === null) return null;
  const origin = parts.origin.replace(/\/+$/, '');
  return `${origin}/#${path}`;
}
