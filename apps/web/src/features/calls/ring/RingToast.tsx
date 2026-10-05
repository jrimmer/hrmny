/**
 * @cytale/web — the ring toast surface (calls plan U11, R7/AM6).
 *
 * The GLOBAL toast region (`RingToasts`): fixed top-right, one level above
 * the shell's drawers/menus (surface-strong card language), an
 * aria-live=polite region so the ring is announced exactly as it is seen —
 * the audio ring's visual equivalent is MANDATORY (WCAG: never sound-only;
 * a blocked/absent sound never degrades this surface).
 *
 * Each `RingToast` card shows the channel name + the caller and offers
 * Join (navigate + join intent through the `useCall` seam) and Dismiss
 * (clearCallRing). Simultaneous rings in different channels stack as
 * distinct cards (keyed by call_id). Subtle toasts (the in-call courtesy)
 * carry an explicit note instead of sound.
 *
 * States-first DoD on this surface:
 *   loading  — n/a (the toast IS the event; no fetch happens here)
 *   empty    — the region renders nothing while no ring is live (the app's
 *              other surfaces own their empty states)
 *   error    — the mute-toggle surface owns its errors (context menu); the
 *              toast itself performs no fallible work
 *   offline  — rings arrive over the gateway; a disconnected client simply
 *              receives none (the shell's offline banner owns that state app-wide)
 *   view-only / permission-denied — a delivered CALL_RING already passed the
 *              server's VIEW_CHANNEL + mute filters (U4); nothing to gate
 */


import {
  clearCallRing,
  defaultStore,
  nicknamesForChannel,
  type StateStore,
} from '@cytale/state';

import {
  ToastProvider,
  ToastRoot,
  ToastViewport,
} from '../../../components/shadcn/toast.js';

import { useStoreSlices } from '../../../app/useStoreSelector.js';
import { resolveAuthor } from '../../messages/authorIdentity.js';
import { useCall } from '../useCall.js';
import { useRingToasts, type RingDriverDeps, type RingToastState } from './ringReducer.js';

// ---------------------------------------------------------------------------
// One toast card
// ---------------------------------------------------------------------------

export interface RingToastProps {
  toast: RingToastState;
  /** Channel display name (resolved by the region from the store). */
  channelName: string;
  /** Caller display name (resolved by the region from the member roster). */
  callerName: string;
  /** Navigate to the ringing channel + join the call. */
  onJoin: () => void;
  /** Dismiss this ring (clearCallRing). */
  onDismiss: () => void;
}

const TOAST_ACTION =
  'flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm ' +
  'font-medium transition-colors duration-[var(--duration-control)] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

export function RingToast({ toast, channelName, callerName, onJoin, onDismiss }: RingToastProps) {
  return (
    // #150: Radix Toast Root with the house card painted over it. The ring
    // slice owns the lifetime (mount/expiry), so Radix's auto-close timer
    // is off (Infinity); swipe-to-dismiss rides onOpenChange → Dismiss.
    <ToastRoot
      className="ring-toast"
      open
      duration={Infinity}
      tabIndex={-1}
      onOpenChange={(open: boolean) => {
        if (!open) onDismiss();
      }}
      data-testid="ring-toast"
      data-call-id={toast.callId}
      data-channel-id={toast.channelId}
      data-subtle={toast.subtle || undefined}
    >
      <p className="ring-toast-title" data-testid="ring-toast-title">
        <span aria-hidden className="ring-toast-pulse" data-testid="ring-toast-pulse" />
        <span>
          Incoming call in <strong>{channelName}</strong> from <strong>{callerName}</strong>
        </span>
      </p>
      {toast.subtle ? (
        <p className="ring-toast-note" data-testid="ring-toast-subtle-note">
          Ringing without sound — you&apos;re in another call.
        </p>
      ) : null}
      <div className="ring-toast-actions">
        <button
          type="button"
          className={TOAST_ACTION + ' bg-accent text-text-onaccent hover:bg-accent-hover'}
          aria-label={`Join call in ${channelName}`}
          data-testid="ring-toast-join"
          onClick={onJoin}
        >
          Join
        </button>
        <button
          type="button"
          className={TOAST_ACTION + ' bg-surface-hover text-text-primary'}
          aria-label={`Dismiss call from ${channelName}`}
          data-testid="ring-toast-dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </ToastRoot>
  );
}

// ---------------------------------------------------------------------------
// The global region (mount point — AuthenticatedApp hosts one instance)
// ---------------------------------------------------------------------------

export interface RingToastsProps {
  /** U6 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Navigate the app to the ringing channel on Join. */
  onJoinChannel?: (channelId: string) => void;
  /** Driver overrides (tests); defaults wire the engine/mute/clock seams. */
  deps?: RingDriverDeps;
}

/** What the toast labels read (channel name, caller name). */
const TOAST_LABEL_SLICES = ['channels', 'membersById', 'nicknamesByWorkspace'] as const;

export function RingToasts({ store: storeProp, onJoinChannel, deps }: RingToastsProps) {
  const store = storeProp ?? defaultStore;
  const toasts = useRingToasts(store, deps);
  const call = useCall(store);
  // Only the two slices the toast labels read (lane D #17; was whole-store).
  const state = useStoreSlices(store, TOAST_LABEL_SLICES);

  if (toasts.length === 0) return null;

  // swipeDirection rides the Provider (Radix's model): a right-swipe equals
  // the Dismiss action — the store clears the ring either way. The cards
  // are the viewport's SIBLINGS: Radix portals each ToastRoot into the
  // registered viewport itself (a toast without a viewport renders null).
  return (
    <ToastProvider swipeDirection="right">
      <ToastViewport
        className="ring-toast-region"
        role="region"
        aria-label="Incoming call notifications"
        data-testid="ring-toast-region"
      />
      {toasts.map((toast) => {
        const channel = state.channels[toast.channelId];
        const channelName = channel?.name ?? `channel ${toast.channelId.slice(-4)}`;
        // The shared author resolver (authorIdentity.ts) names the caller.
        const caller = resolveAuthor(state.membersById, toast.fromUser, {
          nicknames: nicknamesForChannel(state, toast.channelId),
        });
        const callerName = caller.known ? caller.name : 'a member';
        return (
          <RingToast
            key={toast.callId}
            toast={toast}
            channelName={channelName}
            callerName={callerName}
            onJoin={() => {
              clearCallRing(store, toast.channelId); // answered — consumed
              onJoinChannel?.(toast.channelId);
              call.joinCall(toast.channelId);
            }}
            onDismiss={() => {
              clearCallRing(store, toast.channelId); // dismissed ≠ missed
            }}
          />
        );
      })}
    </ToastProvider>
  );
}
