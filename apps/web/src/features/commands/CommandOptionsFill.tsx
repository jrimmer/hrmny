/**
 * @cytale/web — command options-fill phase (bots plan U9).
 *
 * Shown when the selected command registers options (CHAT_INPUT semantics):
 * one text input per registered option (name, description, required flag)
 * rendered inline beneath the composer's slash row. Required options gate
 * invocation — an empty required field disables Run. Escape cancels back to
 * normal compose; Enter submits when armed. Purely presentational: values
 * and the invoke action are owned by MessageCompose.
 */

import { useEffect, useRef } from 'react';

import type { ApplicationCommand } from '@cytale/api-client';

export interface CommandOptionsFillProps {
  /** The selected command whose registered options drive the inputs. */
  command: ApplicationCommand;
  /** Filled values keyed by option name. */
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  /** Invoke with the current values (gated upstream by `disabled`). */
  onSubmit: () => void;
  /** Escape — cancel back to normal compose. */
  onCancel: () => void;
  /** True while an invocation is pending or offline (disables Run). */
  disabled?: boolean;
}

export function requiredMissing(
  command: ApplicationCommand,
  values: Record<string, string>,
): boolean {
  return (command.options ?? []).some(
    (o) => o.required === true && !values[o.name]?.trim(),
  );
}

export function CommandOptionsFill({
  command,
  values,
  onChange,
  onSubmit,
  onCancel,
  disabled = false,
}: CommandOptionsFillProps) {
  const options = command.options ?? [];
  const blocked = requiredMissing(command, values) || disabled;
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  // Focus lands on the first option input when the phase opens — the
  // keyboard path flows straight into fill→Enter.
  useEffect(() => {
    firstInputRef.current?.focus();
  }, [command.id]);

  return (
    <div
      className="relative rounded-lg border border-input-line bg-input px-3 py-2 transition-colors duration-[var(--duration-control)] focus-within:border-accent focus-within:ring-1 focus-within:ring-[var(--color-focus)]"
      role="group"
      aria-label={`Options for /${command.name}`}
      data-testid="command-options-fill"
      data-command-name={command.name}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
        // Enter submits from any option input (jsdom has no implicit form
        // submission; real browsers get the same explicit handling).
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          if (!blocked) onSubmit();
        }
      }}
    >
      <p className="mb-2 flex items-baseline gap-2 text-sm">
        <span className="font-mono font-semibold text-text-primary" data-testid="command-options-name">
          /{command.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-text-muted">{command.description}</span>
      </p>
      {options.map((option, i) => {
        const id = `command-option-input-${command.id}-${option.name}`;
        return (
          <div key={option.name} className="mb-2 flex flex-col gap-1">
            <label htmlFor={id} className="text-sm text-text-primary">
              {option.name}
              {option.required ? (
                <span className="ml-1 font-medium text-warning" data-testid="command-option-required">
                  {' (required)'}
                </span>
              ) : (
                <span className="ml-1 text-text-muted">{' (optional)'}</span>
              )}
            </label>
            <input
              ref={i === 0 ? firstInputRef : undefined}
              id={id}
              type="text"
              className="min-h-9 rounded-md border border-input-line bg-surface px-2 py-1.5 text-base text-text outline-none placeholder:text-text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              placeholder={option.description}
              aria-required={option.required === true || undefined}
              data-testid={`command-option-input-${option.name}`}
              value={values[option.name] ?? ''}
              onChange={(e) => onChange(option.name, e.target.value)}
            />
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          data-testid="command-options-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (!blocked) onSubmit();
          }}
          disabled={blocked}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-text-onaccent transition-colors duration-[var(--duration-control)] hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="command-invoke"
        >
          Run /{command.name}
        </button>
      </div>
    </div>
  );
}
