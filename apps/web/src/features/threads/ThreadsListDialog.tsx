/**
 * @cytale/web — ThreadsListDialog: a channel's thread roster, in a modal.
 *
 * Opened from the channel row's ⋯ menu. The second half of thread
 * discoverability (2026-09-10): the seed-message indicator covers threads
 * whose parent is in the loaded window; this list covers seeds that have
 * scrolled far out of it, and (with the toggle) archived threads, which the
 * default roster read excludes.
 *
 * Rows open the thread dock (the host closes this dialog on selection).
 * States-first: loading / error+retry / empty, per the house contract.
 *
 * The roster itself lives in `ThreadsListPanel` — the same component the
 * context rail's Threads tab renders, so the two listings cannot drift.
 */
import { useState } from 'react';

import { ThreadsListPanel } from './ThreadsListPanel.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

export interface ThreadsListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel whose threads are listed. */
  channelId: string | null;
  channelName?: string;
  /** Opens the thread dock (host also closes this dialog). */
  onOpenThread: (threadId: string) => void;
}

export function ThreadsListDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
  onOpenThread,
}: ThreadsListDialogProps) {
  const [includeArchived, setIncludeArchived] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setIncludeArchived(false);
        onOpenChange(o);
      }}
    >
      {/* showCloseButton={false}: the house ✕ below keeps its own styling;
          the wrapper's default close would duplicate it. */}
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby={undefined}
          data-testid="threads-list-dialog"
        >
          <DialogTitle className="modal-title">
            Threads{channelName ? ` · #${channelName}` : ''}
          </DialogTitle>
          <DialogClose className="modal-close" aria-label="Close">
            ✕
          </DialogClose>

          <ThreadsListPanel
            channelId={channelId}
            onOpenThread={onOpenThread}
            includeArchived={includeArchived}
            onIncludeArchivedChange={setIncludeArchived}
          />
      </DialogContent>
    </Dialog>
  );
}
