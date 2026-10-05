/**
 * @cytale/state — the synthetic sequence space has ONE owner (hardening 6.8).
 *
 * The replay gate keys off `SYNTHETIC_SEQ_FLOOR`, and every local-reconcile
 * stamp comes from `nextSyntheticSeq()`. Those two used to live in different
 * packages (the floor here, a mirrored floor + counter in
 * apps/web/src/features/syntheticSeq.ts), so the counter and the gate it feeds
 * could be changed independently — the exact drift this test forbids.
 *
 * The assertions pin the single ownership four ways: the module that allocates
 * a stamp is the module that exports the floor; the public barrel hands out
 * those same bindings (not copies); a fresh allocator's first stamp is derived
 * from that floor (FLOOR + 1); and a stamp minted by the allocator is
 * classified as synthetic by the reconcile gate that reads the same floor.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { GatewayEvent, PresenceUpdate } from '@cytale/protocol';

import * as allocator from '../syntheticSeq.js';
import { nextSyntheticSeq, SYNTHETIC_SEQ_FLOOR } from '../syntheticSeq.js';
import * as barrel from '../index.js';
import { applyGatewayEvent } from '../reconcile.js';
import { createStateStore } from '../store.js';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Production sources only — this test file names the patterns it hunts. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.parentPath.includes('__tests__'),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('the synthetic sequence space (hardening 6.8)', () => {
  it('keeps the floor and the allocator in ONE module, re-exported unchanged', () => {
    // Both live beside each other in the allocator module: the floor is a
    // number and the only mutator of the space is the allocator...
    expect(allocator.SYNTHETIC_SEQ_FLOOR).toBeTypeOf('number');
    expect(typeof allocator.nextSyntheticSeq).toBe('function');
    // ...the module exposes nothing else that could write the space...
    expect(Object.keys(allocator).sort()).toEqual(['SYNTHETIC_SEQ_FLOOR', 'nextSyntheticSeq']);
    // ...and the public barrel hands out those same bindings, so no consumer
    // can hold a second copy of either.
    expect(barrel.SYNTHETIC_SEQ_FLOOR).toBe(allocator.SYNTHETIC_SEQ_FLOOR);
    expect(barrel.nextSyntheticSeq).toBe(allocator.nextSyntheticSeq);
  });

  it('stamps strictly inside the synthetic space, starting at floor + 1', async () => {
    vi.resetModules();
    const fresh = await import('../syntheticSeq.js');

    const first = fresh.nextSyntheticSeq();
    expect(first).toBe(fresh.SYNTHETIC_SEQ_FLOOR + 1);
    expect(first).toBeGreaterThan(fresh.SYNTHETIC_SEQ_FLOOR);
  });

  it('hands out strictly increasing stamps from the one counter', () => {
    const first = nextSyntheticSeq();
    const second = nextSyntheticSeq();

    expect(first).toBeGreaterThan(SYNTHETIC_SEQ_FLOOR);
    expect(second).toBeGreaterThan(first);
  });

  it('is the ONLY writer of the floor literal in the package source', () => {
    // A mirrored constant (the apps/web copy this hardening removed) would add
    // a second declaration of the floor somewhere under src/. The patterns are
    // assembled at runtime so this test never matches itself.
    const floorLiteral = ['1', '000', '000'].join('_');
    const counterDeclaration = new RegExp(['\\blet ', 'localSeq\\b'].join(''));
    const files = sourceFiles(SRC_DIR);
    const owners = files.filter((file) => readFileSync(file, 'utf8').includes(floorLiteral));
    const counterOwners = files.filter((file) =>
      counterDeclaration.test(readFileSync(file, 'utf8')),
    );

    expect(owners.map((file) => relative(SRC_DIR, file))).toEqual(['syntheticSeq.ts']);
    expect(counterOwners.map((file) => relative(SRC_DIR, file))).toEqual(['syntheticSeq.ts']);
  });

  it('classifies an allocator stamp as synthetic at the reconcile gate', () => {
    // The gate and the allocator read ONE floor: a stamp the allocator mints
    // must land above it, so the dispatch applies WITHOUT advancing `lastSeq`
    // (which is what keeps the real stream, counting from 1, alive — #143).
    const store = createStateStore();
    const presence: PresenceUpdate = {
      user_id: '200000000000000001',
      status: 'online',
      last_seen_at: '2026-09-06T12:00:00.000Z',
    };
    const event = {
      op: 0,
      t: 'PresenceUpdate',
      s: nextSyntheticSeq(),
      d: presence,
    } as unknown as GatewayEvent;

    applyGatewayEvent(store, event);

    const state = store.getState();
    expect(state.presenceByUser[presence.user_id]?.status).toBe('online');
    expect(state.lastSeq).toBe(0);
  });
});
