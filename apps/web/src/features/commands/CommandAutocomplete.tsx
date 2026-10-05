/**
 * @cytale/web — slash-command autocomplete popover (bots plan U9).
 *
 * Hand-rolled ARIA combobox/listbox (the Integrations-panel precedent: Radix
 * ships only the dialog primitive here, so interactive ARIA is authored
 * directly and skinned purely with tokens). Focus never leaves the composer's
 * contenteditable — the combobox (the composer input, in MessageCompose)
 * carries `aria-activedescendant` and this listbox renders the options; keys
 * are intercepted by the composer's Lexical plugin, clicks select directly.
 *
 * The filter itself lives in the composer (filterCommands) so keyboard
 * navigation, aria ids, and rendering share one match list; this component
 * receives the already-filtered `matches`.
 *
 * States-first per UX_SPEC §9: loading (announced), empty (named empty-state
 * distinct from error — "no commands registered" vs "no commands match"),
 * error (role=alert + retry; forbidden copy when member-gated 403), offline
 * (status note; loads are suppressed upstream while offline).
 */

import type { ApplicationCommand } from '@cytale/api-client';

import type { CommandsState } from './useCommands.js';
import { Command, CommandItem } from '../../components/shadcn/command.js';

export interface CommandAutocompleteProps {
  /** Commands load state from useCommands. */
  state: CommandsState;
  /** Parent-filtered match list for the current query. */
  matches: ApplicationCommand[];
  /** Typed filter text after the leading "/" (no-match copy). */
  query: string;
  /** Index of the keyboard-active option within `matches`. */
  activeIndex: number;
  /** DOM id of the listbox element (aria-controls / aria-activedescendant). */
  listboxId: string;
  /** Builds each option's DOM id (aria-activedescendant wiring). */
  optionId: (index: number) => string;
  onActiveIndexChange: (index: number) => void;
  onSelect: (command: ApplicationCommand) => void;
  onRetry: () => void;
  /** Offline suppresses loads upstream; the popover states it. */
  online: boolean;
}

const optionRow =
  'flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 ' +
  'text-left transition-colors duration-[var(--duration-control)] focus-visible:outline-none';

export function CommandAutocomplete({
  state,
  matches,
  query,
  activeIndex,
  listboxId,
  optionId,
  onActiveIndexChange,
  onSelect,
  onRetry,
  online,
}: CommandAutocompleteProps) {
  return (
    <div
      className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden popover"
      data-testid="command-autocomplete"
    >
      {!online ? (
        <div
          role="status"
          className="px-3 py-3 text-sm text-text-muted"
          data-testid="command-offline"
        >
          You're offline — commands are unavailable until the connection returns.
        </div>
      ) : state.status === 'idle' || state.status === 'loading' ? (
        <div
          role="progressbar"
          aria-busy="true"
          aria-label="Loading commands"
          className="px-3 py-3 text-sm text-text-muted"
          data-testid="command-loading"
        >
          <span className="animate-pulse motion-reduce:animate-none">Loading commands…</span>
        </div>
      ) : state.status === 'error' ? (
        <div className="px-3 py-2.5" data-testid="command-error-load">
          <p role="alert" className="text-sm text-danger">
            {state.forbidden
              ? "You don't have access to commands in this workspace."
              : `Couldn't load commands. ${state.error}`}
          </p>
          {!state.forbidden && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-md px-2 py-1 text-sm font-medium text-accent transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              data-testid="command-retry-load"
            >
              Retry
            </button>
          )}
        </div>
      ) : matches.length === 0 ? (
        state.commands.length === 0 ? (
          <div className="px-3 py-3" data-testid="command-empty">
            <p className="text-sm font-medium text-text-primary">No commands yet</p>
            <p className="text-sm text-text-muted">
              Bots in this workspace can register slash commands — none have yet.
            </p>
          </div>
        ) : (
          <div className="px-3 py-3" data-testid="command-no-matches">
            <p className="text-sm text-text-muted">
              No commands matching “/{query}”.
            </p>
          </div>
        )
      ) : (
        <div id={listboxId} className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
          <Command
            shouldFilter={false}
            value={matches[activeIndex]?.id ?? ''}
            role="listbox"
            aria-label="Slash commands"
          >
          {matches.map((command, i) => {
            const active = i === activeIndex;
            return (
              <CommandItem
                key={command.id}
                value={command.id}
                data-testid="command-option"
                data-command-name={command.name}
                className={
                  optionRow + (active ? ' bg-surface-hover' : ' hover:bg-surface-hover')
                }
                onMouseEnter={() => onActiveIndexChange(i)}
                // mousedown, not click (cmdk overrides onClick; and the
                // composer must keep its selection for the fill phase):
                // commit on press, focus never leaves the editor.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(command);
                }}
              >
                <span id={optionId(i)} className="command-option-content">
                  <span className="font-mono text-sm font-semibold text-text-primary">
                    /{command.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                    {command.description}
                  </span>
                </span>
              </CommandItem>
            );
          })}
          </Command>
        </div>
      )}
    </div>
  );
}
