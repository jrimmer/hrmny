/**
 * @cytale/web — the shadcn/ui Command component (cmdk), house-skinned (#150).
 *
 * The FIRST migrated surface per ticket #150's migration order. Copy of the
 * upstream shadcn `command.tsx` (new-york style) with exactly two deviations,
 * both required by our stack pins:
 *
 * 1. Class names resolve through OUR `cn` seam (src/lib/shadcn) — no import
 *    path changes upstream, one place to audit class merging.
 * 2. The bare utility classes the upstream file uses (bg-popover, text-muted-
 *    foreground, ...) are unchanged — they resolve through the tokens.css
 *    `@theme` bridge onto `--tk-*` primitives, so this component wears the
 *    house theme with zero per-component styling. The dialog-variant wrapper
 *    composes our existing Radix Dialog primitives rather than duplicating
 *    them, so focus trapping and overlay behaviour stay identical to the
 *    surfaces already shipped.
 *
 * Rollback contract (#150): the replaced surfaces (the four palettes) are
 * deleted only after their migration passes its gates; reverting this file
 * plus the palette commits restores the hand-rolled implementations.
 */
import * as React from 'react';
import { type DialogProps } from '@radix-ui/react-dialog';
import { Command as CommandPrimitive } from 'cmdk';

import { cn } from '../../lib/shadcn/utils.js';

/** The shared dialog chrome the dialog-variant Command composes. */
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog.js';

const Command = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) => (
  <CommandPrimitive
    data-slot="command"
    // Filtering is the HOST's decision: our surfaces search server-side
    // (#150's omnisearch fetches; the composer palettes rank their own
    // candidates), so the default `shouldFilter` re-filtering fetched rows
    // against the raw input would hide valid results. Hosts that want
    // client-side filtering pass `shouldFilter` explicitly.
    shouldFilter={false}
    className={cn(
      'bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md',
      className,
    )}
    {...props}
  />
);
Command.displayName = 'Command';

const CommandDialog = ({
  children,
  className,
  showCloseButton = true,
  ...props
}: DialogProps & { className?: string; showCloseButton?: boolean }) => {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn('overflow-hidden p-0 shadow-modal', className)}
        showCloseButton={showCloseButton}
        data-testid="shadcn-command-dialog"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search and run commands</DialogDescription>
        <Command className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:size-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:size-5">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
};

const CommandInput = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) => (
  <CommandPrimitive.Input
    data-slot="command-input"
    className={cn(
      'placeholder:text-muted-foreground flex h-9 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
);
CommandInput.displayName = 'CommandInput';

const CommandList = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) => (
  <CommandPrimitive.List
    data-slot="command-list"
    className={cn('max-h-[min(400px,calc(100dvh-200px))] scroll-py-1 overflow-y-auto overflow-x-hidden', className)}
    {...props}
  />
);
CommandList.displayName = 'CommandList';

const CommandEmpty = (props: React.ComponentProps<typeof CommandPrimitive.Empty>) => {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  );
};

const CommandGroup = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) => (
  <CommandPrimitive.Group
    data-slot="command-group"
    className={cn(
      'text-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
      className,
    )}
    {...props}
  />
);
CommandGroup.displayName = 'CommandGroup';

const CommandSeparator = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) => (
  <CommandPrimitive.Separator
    data-slot="command-separator"
    className={cn('bg-border -mx-1 h-px', className)}
    {...props}
  />
);
CommandSeparator.displayName = 'CommandSeparator';

const CommandItem = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) => (
  <CommandPrimitive.Item
    data-slot="command-item"
    className={cn(
      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg:not([class*=text-])]:text-muted-foreground relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
      className,
    )}
    {...props}
  />
);
CommandItem.displayName = 'CommandItem';

const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    data-slot="command-shortcut"
    className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
    {...props}
  />
);
CommandShortcut.displayName = 'CommandShortcut';

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
