/**
 * @cytale/web — self presence picker (U23 polish).
 *
 * Manual status control: Online / Idle / Do Not Disturb / Invisible.
 * Invisible is display-honest — the wire broadcasts "offline" to everyone
 * (own devices included) while the connection stays fully live.
 *
 * Keyboard: the trigger opens a role=menu; arrows move, Enter/Space select,
 * Escape closes, focus returns to the trigger. Outside click closes.
 */

import { useEffect, useRef, useState } from 'react';

export type SelfStatus = 'online' | 'idle' | 'dnd' | 'invisible';

const OPTIONS: Array<{ value: SelfStatus; label: string }> = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'dnd', label: 'Do Not Disturb' },
  { value: 'invisible', label: 'Invisible' },
];

const dotColor: Record<SelfStatus, string> = {
  online: 'var(--color-presence-online)',
  idle: 'var(--color-presence-idle)',
  dnd: 'var(--color-presence-dnd)',
  // Invisible shows the offline hollow dot for the self row too — display
  // honesty, not stealth.
  invisible: 'var(--color-presence-offline)',
};

export function presenceDotStyle(status: SelfStatus): { background: string } {
  return { background: dotColor[status] };
}

export interface PresenceMenuProps {
  status: SelfStatus;
  onSelect: (status: SelfStatus) => void;
  /**
   * Custom trigger (e.g. the user-panel avatar, Discord-style: clicking
   * your own avatar opens the status picker). Receives the wiring the
   * default trigger gets; must render a focusable <button>. The default
   * (absent renderTrigger) stays dot + status word.
   */
  renderTrigger?: (wiring: {
    ref: React.Ref<HTMLButtonElement>;
    open: boolean;
    toggle: () => void;
  }) => React.ReactNode;
}

export function PresenceMenu({ status, onSelect, renderTrigger }: PresenceMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(OPTIONS.findIndex((o) => o.value === status));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (value: SelfStatus) => {
    onSelect(value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => (i + 1) % OPTIONS.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(OPTIONS[focusIndex]!.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const current = OPTIONS.find((o) => o.value === status) ?? OPTIONS[0]!;

  return (
    <div className="presence-menu" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      {renderTrigger ? (
        renderTrigger({
          ref: triggerRef,
          open,
          toggle: () => {
            setFocusIndex(OPTIONS.findIndex((o) => o.value === status));
            setOpen((o) => !o);
          },
        })
      ) : (
        <button
          type="button"
          ref={triggerRef}
          className="presence-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Set status — currently ${current.label}`}
          data-testid="presence-menu-trigger"
          onClick={() => {
            setFocusIndex(OPTIONS.findIndex((o) => o.value === status));
            setOpen((o) => !o);
          }}
        >
          <span className="presence-dot" aria-hidden="true" style={presenceDotStyle(status)} />
          <span className="presence-menu-label">{current.label}</span>
        </button>
      )}

      {open ? (
        <div className="presence-menu-popover" role="menu" aria-label="Presence status" data-testid="presence-menu">
          {OPTIONS.map((option, i) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === status}
              className="presence-menu-item"
              data-testid={`presence-option-${option.value}`}
              ref={i === focusIndex ? (el) => el?.focus() : undefined}
              tabIndex={-1}
              onClick={() => choose(option.value)}
            >
              <span className="presence-dot" aria-hidden="true" style={presenceDotStyle(option.value)} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
