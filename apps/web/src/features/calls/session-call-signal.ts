/**
 * @cytale/web — re-export shim for the extracted CALL_SIGNAL seam.
 *
 * The emitter/route pair is host-neutral (a listener set plus a structural
 * frame check), so it moved to `@cytale/calls`; this shim is what `session.ts`
 * imports `routeCallSignalEvent` from, so the web dispatch chain and the
 * engine's default subscription remain the SAME module instance.
 */

export {
  emitCallSignal,
  onCallSignal,
  routeCallSignalEvent,
  type CallSignalFrame,
} from '@cytale/calls';
