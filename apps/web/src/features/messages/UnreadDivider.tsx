/**
 * The unread rule: a red hairline with a "NEW" pill, drawn at the first message
 * newer than the read watermark captured when the surface was OPENED.
 *
 * Extracted from MessageList (#104) because the thread panel needs the same
 * mark and the corpus doctrine is that a thread is *"the same message-panel
 * component rendered narrower"* — a second definition of "new" would drift.
 *
 * The capture is the host's job, not this component's: opening marks the
 * surface read, so the position has to be taken before the ack and then held.
 */
export function UnreadDivider() {
  return (
    <div
      className="mx-4 flex items-center gap-2 pt-3"
      role="separator"
      aria-label="New messages"
      data-testid="unread-divider"
    >
      <span
        className="rounded bg-danger px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none text-text-onaccent"
        aria-hidden
      >
        New
      </span>
      <span className="h-px flex-1 bg-danger" aria-hidden />
    </div>
  );
}
