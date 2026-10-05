/**
 * @cytale/web — DropOverlay: the "Drop to upload" scrim shared by the
 * drop-zone hosts (channel pane, thread side-panel). Pointer-inert — the
 * zone's handlers keep working underneath; the scrim is presentational.
 */
export function DropOverlay({ testId, className = '' }: { testId: string; className?: string }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-accent bg-background/85 ${className}`}
      data-testid={testId}
      role="status"
    >
      <p className="text-sm font-semibold text-text-primary">Drop to upload</p>
    </div>
  );
}
