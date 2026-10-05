/**
 * @cytale/web — Create Channel dialog (Discord parity).
 *
 * Mirrors Discord's "Create Channel" modal: a #-prefixed name field that
 * auto-formats to the channel slug as you type (lowercase, spaces →
 * dashes, URL-safe — the server stores names verbatim), an optional topic,
 * and Cancel / Create actions. Submit failure renders an honest error —
 * a 403 becomes the permission-denied copy (states-first DoD), anything
 * else the server's own message.
 */

import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

import type { Channel } from '@cytale/domain';

import { dialogErrorMessage } from './dialogError.js';

export interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace's existing categories (type 'category' rows) — the new
   *  channel can be filed under one at creation time. */
  categories?: Array<{ id: string; name: string }>;
  /** Creates the channel (or category) in the active workspace; rejects
   *  with ApiError. */
  onCreateChannel: (input: {
    name: string;
    topic?: string;
    type?: 'text' | 'category';
    parent_id?: string | null;
  }) => Promise<Channel>;
}

/** Discord-style channel slug: lowercase, spaces → dashes, URL-safe. */
export function channelSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '')
    .slice(0, 100);
}

/**
 * Category names are LABELS, not URL slugs (owner report 2026-09-15: the
 * category form pre-filled the channel's # and rejected the '.' in
 * "example.com"). Case is preserved — a category renders uppercase by CSS, but
 * the stored name is what the owner typed — spaces collapse rather than
 * becoming dashes, and dots are allowed like any other word character.
 */
export function categoryName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 .\-_]/g, '')
    .trimStart()
    .slice(0, 100);
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  categories = [],
  onCreateChannel,
}: CreateChannelDialogProps) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState<'text' | 'category'>('text');
  const [parentId, setParentId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form every time the dialog opens.
  useEffect(() => {
    if (open) {
      setName('');
      setTopic('');
      setKind('text');
      setParentId('');
      setPending(false);
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    // The same kind-aware rule the input applies live, so a paste-then-submit
    // and a typed name cannot disagree.
    const slug =
      kind === 'category'
        ? categoryName(name.trim())
        : channelSlug(name.trim());
    if (!slug) {
      setError(kind === 'category' ? 'Category name is required.' : 'Channel name is required.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCreateChannel({
        name: slug,
        type: kind,
        topic: kind === 'text' ? topic.trim() || undefined : undefined,
        // Categories do not nest; the parent select only exists for text.
        parent_id: kind === 'text' && parentId !== '' ? parentId : null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(
        dialogErrorMessage(
          err,
          "You don't have permission to create channels in this workspace.",
          'Could not create the channel. Try again.',
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
        data-testid="create-channel-dialog"
      >
          <DialogTitle className="modal-title">
            {kind === 'category' ? 'Create Category' : 'Create Channel'}
          </DialogTitle>
          <DialogClose className="modal-close" aria-label="Close" disabled={pending}>
            ✕
          </DialogClose>

          <div
            className="flex gap-2 pb-1"
            role="radiogroup"
            aria-label="Channel type"
            data-testid="create-channel-kind"
          >
            {(['text', 'category'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={kind === option}
                className={
                  kind === option
                    ? 'modal-btn-primary flex-1'
                    : 'modal-btn-secondary flex-1'
                }
                data-testid={`create-channel-kind-${option}`}
                onClick={() => setKind(option)}
              >
                {option === 'text' ? 'Text channel' : 'Category'}
              </button>
            ))}
          </div>

          <label className="modal-label" htmlFor="create-channel-name-input">
            {kind === 'category' ? 'Category name' : 'Channel name'}
          </label>
          <div className="modal-input-wrap">
            {kind === 'text' ? (
              <span className="modal-input-prefix" aria-hidden="true">
                #
              </span>
            ) : null}
            <input
              id="create-channel-name-input"
              data-testid="create-channel-name"
              className={kind === 'text' ? 'modal-input has-prefix' : 'modal-input'}
              value={name}
              onChange={(e) =>
                setName(kind === 'category' ? categoryName(e.target.value) : channelSlug(e.target.value))
              }
              placeholder={kind === 'category' ? 'New Category' : 'new-channel'}
              maxLength={100}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </div>

          {kind === 'text' && categories.length > 0 ? (
            <>
              <label className="modal-label" htmlFor="create-channel-parent-input">
                Category <span className="modal-label-optional">(optional)</span>
              </label>
              <select
                id="create-channel-parent-input"
                data-testid="create-channel-parent"
                className="modal-input"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">No category</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          {kind === 'text' ? (
            <>
              <label className="modal-label" htmlFor="create-channel-topic-input">
                Topic <span className="modal-label-optional">(optional)</span>
              </label>
              <input
                id="create-channel-topic-input"
                data-testid="create-channel-topic"
                className="modal-input"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What's this channel about?"
                maxLength={500}
              />
            </>
          ) : null}

          {error ? (
            <p role="alert" data-testid="create-channel-error" className="modal-error">
              {error}
            </p>
          ) : null}

          <div className="modal-actions">
            <DialogClose asChild>
              <button
                type="button"
                className="modal-btn-secondary"
                data-testid="create-channel-cancel"
                disabled={pending}
              >
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              className="modal-btn-primary"
              data-testid="create-channel-submit"
              disabled={pending}
              onClick={() => void submit()}
            >
              {pending ? 'Creating…' : kind === 'category' ? 'Create Category' : 'Create Channel'}
            </button>
          </div>
      </DialogContent>
    </Dialog>
  );
}
