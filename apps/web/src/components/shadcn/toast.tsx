/**
 * @cytale/web — the shadcn/ui Toast wrapper (#150).
 *
 * Radix Toast in the shadcn convention; house tokens paint it. NOTE the
 * adoption boundary (decided on the ring surface, 2026-09-24): callers
 * whose lifetimes are OWNED elsewhere (the call ring's store slice) run
 * with duration={Infinity} and a controlled mount — Radix's auto-close
 * timer (and its hover-pause) stays off so the toast dies exactly when
 * its source does. Radix still buys the ordering viewport, focus
 * management, and swipe-to-dismiss.
 *
 * Only the parts the ring toast renders are wrapped: the stock
 * Title/Description/Close had no caller (the ring card draws its own title,
 * body and house ✕), so they were removed rather than left to drift.
 */
import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';

import { cn } from '../../lib/shadcn/utils.js';

const ToastProvider = ToastPrimitive.Provider;

const ToastViewport = ({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) => (
  <ToastPrimitive.Viewport
    data-slot="toast-viewport"
    className={cn(
      'bg-popover text-popover-foreground fixed top-0 right-0 z-[60] flex w-full max-w-[calc(100%-2rem)] flex-col gap-2 outline-none sm:max-w-[360px]',
      className,
    )}
    {...props}
  />
);
ToastViewport.displayName = 'ToastViewport';

const ToastRoot = ({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root>) => (
  <ToastPrimitive.Root
    data-slot="toast"
    className={cn(
      'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=open]:slide-in-from-top-full data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] grid gap-1 rounded-md border p-4 shadow-popover',
      className,
    )}
    {...props}
  />
);
ToastRoot.displayName = 'ToastRoot';

export { ToastProvider, ToastViewport, ToastRoot };
