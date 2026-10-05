/**
 * @cytale/web — ChannelSettingsDialog: per-channel settings.
 *
 * Opened from a channel row's gear (ChannelContextMenu). Mirrors the house
 * settings pattern (a focused panel of labelled fields with Save/Cancel):
 * rename, edit the topic, and file the channel under a category after
 * creation — the post-creation half of category organization. Categories
 * themselves are not editable here (a category row's gear offers the same
 * dialog minus the parent select).
 *
 * Authorization is the server's: PATCH /channels/{id} requires
 * MANAGE_CHANNELS, and a 403 surfaces as the dialog's inline error rather
 * than a hidden affordance (the client does not resolve channel permissions
 * for the menu — the same honesty rule as the composer's error path).
 */
import { useEffect, useState } from 'react';

import type { Channel } from '@cytale/domain';

import { dialogErrorMessage } from './dialogError.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

export interface ChannelSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel being edited (category rows get the same fields minus parent). */
  channel: Channel | null;
  /** The workspace's categories (for the parent select). */
  categories: Array<{ id: string; name: string }>;
  /** Persists the patch; rejects with ApiError. */
  onSave: (patch: { name?: string; topic?: string | null; parent_id?: string | null }) => Promise<void>;
}

export function ChannelSettingsDialog({
  open,
  onOpenChange,
  channel,
  categories,
  onSave,
}: ChannelSettingsDialogProps) {
  const isCategory = channel?.type === 'category';
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [parentId, setParentId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed from the channel on every open / target change.
  useEffect(() => {
    if (!open || channel === null) return;
    setName(channel.name);
    setTopic(channel.topic ?? '');
    setParentId(channel.parent_id ?? '');
    setPending(false);
    setError(null);
  }, [open, channel]);

  const submit = async () => {
    if (channel === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSave({
        name: trimmed,
        topic: isCategory ? undefined : topic.trim() || null,
        // parent_id only applies to text channels (categories do not nest).
        parent_id: isCategory ? undefined : parentId !== '' ? parentId : null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(
        dialogErrorMessage(
          err,
          "You don't have permission to manage this channel.",
          'Could not save the channel. Try again.',
        ),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
    >
      {/* showCloseButton={false}: the house ✕ below keeps its own styling
          and pending-disable; the wrapper's default close would duplicate. */}
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby={undefined}
          data-testid="channel-settings-dialog"
        >
          <DialogTitle className="modal-title">
            {isCategory ? 'Category Settings' : 'Channel Settings'}
          </DialogTitle>
          <DialogClose className="modal-close" aria-label="Close" disabled={pending}>
            ✕
          </DialogClose>

          <label className="modal-label" htmlFor="channel-settings-name">
            Name
          </label>
          <input
            id="channel-settings-name"
            data-testid="channel-settings-name"
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            autoFocus
          />

          {!isCategory ? (
            <>
              <label className="modal-label" htmlFor="channel-settings-topic">
                Topic <span className="modal-label-optional">(optional)</span>
              </label>
              <input
                id="channel-settings-topic"
                data-testid="channel-settings-topic"
                className="modal-input"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={500}
              />

              <label className="modal-label" htmlFor="channel-settings-parent">
                Category <span className="modal-label-optional">(optional)</span>
              </label>
              <select
                id="channel-settings-parent"
                data-testid="channel-settings-parent"
                className="modal-input"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">No category</option>
                {categories
                  .filter((cat) => cat.id !== channel?.id)
                  .map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
              </select>
            </>
          ) : null}

          {error !== null ? (
            <p role="alert" className="modal-error" data-testid="channel-settings-error">
              {error}
            </p>
          ) : null}

          <div className="modal-actions">
            <DialogClose asChild>
              <button
                type="button"
                className="modal-btn-secondary"
                data-testid="channel-settings-cancel"
                disabled={pending}
              >
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              className="modal-btn-primary"
              data-testid="channel-settings-save"
              disabled={pending}
              onClick={() => void submit()}
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
          </div>
      </DialogContent>
    </Dialog>
  );
}
