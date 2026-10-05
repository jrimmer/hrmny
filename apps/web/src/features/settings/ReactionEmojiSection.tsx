/**
 * @cytale/web — ReactionEmojiSection (#43, the gear surface).
 *
 * Favorites management for BOTH pickers, existing emoji only:
 *
 *   - Reaction favorites — the quick grid the reaction picker opens with.
 *     The storage helpers ship with the picker (ReactionPicker.tsx); this
 *     section is the editing UI they were always waiting for. Any catalog
 *     emoji may be a favorite (the picker's full-panel picks bump in).
 *   - Composer emoji favorites — the #43 skeleton: same pattern (curated
 *     set, cap 8, settings-owned) feeding the favorites row the picker now
 *     renders above Frequently Used.
 *
 * Both sets are per-browser localStorage; both pickers re-read on every
 * open, so edits here take effect on next use with zero wiring. Personal
 * emoji UPLOADS live in #44 (later — they ride #31's substrate).
 *
 * Chip controls follow the hover-controls doctrine: ‹ › ✕ sit inside each
 * chip, visually hidden at rest (opacity-0 + pointer-inert), revealed on
 * hover/focus-within — keyboard tab order reaches them regardless, and the
 * layout zone is reserved (no shift on reveal).
 */

import { useMemo, useState } from 'react';

import {
  readReactionFavorites,
  writeReactionFavorites,
} from '../messages/ReactionPicker.js';
import {
  readFavoriteEmoji,
  searchEmojiCatalog,
  writeFavoriteEmoji,
} from '../messages/emojiCatalog.js';

/** Both families cap at 8 (the pickers' single-row quick sets). */
const FAVORITES_CAP = 8;
/** How many add-candidates the search grid shows. */
const CANDIDATE_LIMIT = 24;

const searchInputClass =
  'min-h-9 w-full rounded-md border border-line bg-input px-3 py-2 text-sm text-text ' +
  'placeholder-shown:text-text-muted outline-none focus-visible:border-accent ' +
  'focus-visible:ring-1 focus-visible:ring-[var(--color-focus)]';

const candidateClass =
  'flex h-9 w-9 items-center justify-center rounded-md text-xl leading-none text-text ' +
  'transition-colors duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:bg-surface-hover focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-40';

const chipControlClass =
  'flex h-4 w-4 items-center justify-center rounded text-[10px] leading-none ' +
  'text-text-muted transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
  'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent';

interface FavoritesBlockProps {
  testPrefix: string;
  title: string;
  hint: string;
  read(): string[];
  write(favorites: string[]): void;
}

function FavoritesBlock({ testPrefix, title, hint, read, write }: FavoritesBlockProps) {
  const [favorites, setFavorites] = useState<string[]>(() => read());
  const [query, setQuery] = useState('');

  const commit = (next: string[]): void => {
    write(next);
    setFavorites(next);
  };

  const remove = (emoji: string): void => commit(favorites.filter((e) => e !== emoji));

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= favorites.length) return;
    const next = [...favorites];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    commit(next);
  };

  const add = (emoji: string): void => {
    if (favorites.includes(emoji) || favorites.length >= FAVORITES_CAP) return;
    commit([...favorites, emoji]);
  };

  const candidates = useMemo(() => {
    const excluded = new Set(favorites);
    return searchEmojiCatalog(query)
      .filter((row) => !excluded.has(row.e))
      .slice(0, CANDIDATE_LIMIT);
  }, [query, favorites]);

  const full = favorites.length >= FAVORITES_CAP;

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">{title}</h2>
      <p className="text-sm text-text-muted">{hint}</p>
      <p className="text-xs text-text-muted" data-testid={`${testPrefix}-count`}>
        {favorites.length} / {FAVORITES_CAP}
      </p>

      {favorites.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid={`${testPrefix}-empty`}>
          No favorites yet — add some below.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid={`${testPrefix}-chips`}>
          {favorites.map((emoji, i) => (
            <li
              key={emoji}
              className="group flex items-center gap-1 rounded-md border border-line bg-surface-strong px-2 py-1.5"
              data-testid={`${testPrefix}-chip`}
              data-emoji={emoji}
            >
              <span className="text-xl leading-none" aria-hidden="true">
                {emoji}
              </span>
              <span className="sr-only">{emoji} favorite</span>
              {/* Hover/focus-revealed per the hover-controls doctrine —
                  keyboard tab reaches the buttons regardless. */}
              <span className="flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-[var(--duration-control)] group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                <button
                  type="button"
                  className={chipControlClass}
                  aria-label={`Move ${emoji} left`}
                  disabled={i === 0}
                  data-testid={`${testPrefix}-move-left`}
                  onClick={() => move(i, i - 1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className={chipControlClass}
                  aria-label={`Move ${emoji} right`}
                  disabled={i === favorites.length - 1}
                  data-testid={`${testPrefix}-move-right`}
                  onClick={() => move(i, i + 1)}
                >
                  ›
                </button>
                <button
                  type="button"
                  className={chipControlClass}
                  aria-label={`Remove ${emoji}`}
                  data-testid={`${testPrefix}-remove`}
                  onClick={() => remove(emoji)}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        <input
          type="text"
          className={searchInputClass}
          placeholder="Search emoji to add"
          aria-label={`Search emoji to add to ${title.toLowerCase()}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid={`${testPrefix}-search`}
        />
        {full ? (
          <p className="text-xs text-text-muted" data-testid={`${testPrefix}-full`}>
            Favorites are full — remove one to add another.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1" role="group" aria-label={`Add to ${title}`} data-testid={`${testPrefix}-candidates`}>
          {candidates.map((row) => (
            <button
              key={row.e}
              type="button"
              className={candidateClass}
              aria-label={`Add ${row.e} :${row.n}:`}
              title={`:${row.n}:`}
              disabled={full}
              data-testid={`${testPrefix}-add`}
              data-emoji={row.e}
              onClick={() => add(row.e)}
            >
              {row.e}
            </button>
          ))}
          {candidates.length === 0 ? (
            <p className="text-xs text-text-muted" data-testid={`${testPrefix}-no-matches`}>
              No matching emoji.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function ReactionEmojiSection() {
  return (
    <div className="flex flex-col gap-8" data-testid="settings-reaction-emoji">
      <p className="text-sm text-text-muted">
        Curate the quick sets both pickers open with — per browser, applied the next time a
        picker opens.
      </p>

      <FavoritesBlock
        testPrefix="reaction-favorites"
        title="Reaction favorites"
        hint="The quick grid the reaction picker opens with. Using a reaction bumps it to the front of this row."
        read={readReactionFavorites}
        write={writeReactionFavorites}
      />

      <FavoritesBlock
        testPrefix="emoji-favorites"
        title="Composer emoji favorites"
        hint="A favorites row at the top of the composer's emoji picker, above Frequently Used."
        read={readFavoriteEmoji}
        write={writeFavoriteEmoji}
      />

      <p className="text-xs text-text-muted" data-testid="uploads-placeholder">
        Personal emoji uploads arrive later — they depend on the custom-emoji substrate and
        will live here when they land.
      </p>
    </div>
  );
}
