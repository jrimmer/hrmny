/**
 * @cytale/web — change a workspace nickname (#169).
 *
 * One dialog for both cases: your own nickname (the workspace menu's "Change
 * Nickname", CHANGE_NICKNAME — everyone's by default) and someone else's (a
 * member's profile, MANAGE_NICKNAMES). Self-contained like the media-settings
 * dialog: it reads the current nickname from the store and saves through the
 * api seam; the server's `MemberUpdate` is what updates every surface,
 * this client's included. A nickname belongs to ONE workspace.
 */
import { useEffect, useState } from 'react';

import { defaultStore, type StateStore } from '@cytale/state';

import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../components/shadcn/dialog.js';
import { useStoreSelector } from '../../app/useStoreSelector.js';
import { api } from '../auth/session.js';
import { dialogErrorMessage } from './dialogError.js';

/** Discord's limit, and the server's. */
export const NICKNAME_MAX = 32;

export interface NicknameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  /** Whose nickname: '@me' (or your own id) for yourself, else another member's id. */
  userId: string | '@me';
  /** The member's name without a nickname (their display name or username): the placeholder. */
  baseName?: string;
  /** Seam for tests; defaults to the session api. */
  setNickname?: (workspaceId: string, userId: string, nickname: string | null) => Promise<unknown>;
  store?: StateStore;
}

export function NicknameDialog({
  open,
  onOpenChange,
  workspaceId,
  userId,
  baseName,
  setNickname = (ws, uid, nick) => api.setNickname(ws, uid, nick),
  store = defaultStore,
}: NicknameDialogProps) {
  const selfId = useStoreSelector(store, (s) => s.currentUser?.id ?? null);
  const targetId = userId === '@me' ? selfId : userId;
  const self = userId === '@me' || (selfId !== null && userId === selfId);
  const selfName = useStoreSelector(store, (s) => s.currentUser?.display_name || s.currentUser?.username || '');
  const placeholder = baseName ?? (self ? selfName : '');
  const current = useStoreSelector(store, (s) =>
    workspaceId && targetId ? (s.nicknamesByWorkspace?.[workspaceId]?.[targetId] ?? null) : null,
  );

  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form, seeded with the current nickname, every time it opens.
  useEffect(() => {
    if (open) {
      setValue(current ?? '');
      setPending(false);
      setError(null);
    }
    // Only on open: a live MemberUpdate must not overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async (nickname: string | null) => {
    if (!workspaceId) return;
    setPending(true);
    setError(null);
    try {
      await setNickname(workspaceId, self ? '@me' : userId, nickname);
      onOpenChange(false);
    } catch (err) {
      setError(
        dialogErrorMessage(
          err,
          self
            ? "You don't have permission to change your nickname in this workspace."
            : "You can't change this member's nickname.",
          'Could not save the nickname. Try again.',
        ),
      );
    } finally {
      setPending(false);
    }
  };

  const trimmed = value.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
    >
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby="nickname-dialog-help"
        data-testid="nickname-dialog"
      >
        <DialogTitle className="modal-title">
          {self ? 'Change Nickname' : `Change Nickname${baseName ? ` for ${baseName}` : ''}`}
        </DialogTitle>
        <DialogClose className="modal-close" aria-label="Close" disabled={pending}>
          ✕
        </DialogClose>

        <p id="nickname-dialog-help" className="modal-explainer">
          {self
            ? 'Your nickname shows instead of your name in this workspace only.'
            : 'This nickname shows instead of their name in this workspace only.'}
        </p>

        <label className="modal-label" htmlFor="nickname-input">
          Nickname
        </label>
        <input
          id="nickname-input"
          data-testid="nickname-input"
          className="modal-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          maxLength={NICKNAME_MAX}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save(trimmed === '' ? null : trimmed);
            }
          }}
        />

        {current !== null ? (
          <button
            type="button"
            className="modal-link"
            data-testid="nickname-reset"
            disabled={pending}
            onClick={() => void save(null)}
          >
            Reset nickname
          </button>
        ) : null}

        {error ? (
          <p role="alert" data-testid="nickname-error" className="modal-error">
            {error}
          </p>
        ) : null}

        <div className="modal-actions">
          <DialogClose asChild>
            <button type="button" className="modal-btn-secondary" data-testid="nickname-cancel" disabled={pending}>
              Cancel
            </button>
          </DialogClose>
          <button
            type="button"
            className="modal-btn-primary"
            data-testid="nickname-save"
            disabled={pending || trimmed === (current ?? '')}
            onClick={() => void save(trimmed === '' ? null : trimmed)}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
