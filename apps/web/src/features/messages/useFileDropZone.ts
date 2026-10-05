/**
 * @cytale/web — useFileDropZone: drag-and-drop file intake for the message
 * surfaces (channel pane, thread side-panel, call-log replies).
 *
 * Depth-counted dragenter/dragleave so nested elements can't flicker the
 * overlay: the counter rises on every enter and falls on every leave, and
 * the overlay clears only at zero (the classic dnd bug — a child's
 * dragleave used to tear the overlay down mid-drag). dragOver MUST
 * preventDefault or the browser navigates to the dropped file.
 *
 * The hook only REPORTS files — gating (offline/unverified) and the
 * allowlist prefilter live in the composer's startUploads, the same seam
 * the picker uses, so every intake path behaves identically.
 */

import { useCallback, useRef, useState } from 'react';

export interface FileDropZone {
  /** True while a file drag hovers the zone (render the overlay). */
  isDragging: boolean;
  /** Spread onto the zone element. */
  dropHandlers: {
    onDragEnter(e: React.DragEvent): void;
    onDragOver(e: React.DragEvent): void;
    onDragLeave(e: React.DragEvent): void;
    onDrop(e: React.DragEvent): void;
  };
}

function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function useFileDropZone(onFiles: (files: File[]) => void): FileDropZone {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setIsDragging(false);
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    // Without this the browser replaces the page with the dropped file.
    e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      reset();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [onFiles, reset],
  );

  return { isDragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
