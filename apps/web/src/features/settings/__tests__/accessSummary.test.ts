/**
 * @cytale/web — accessIsEmpty / describeAccess, the one-word summary a list row
 * shows for an agent's whole tree.
 *
 * Guard for the 2026-09-14 owner report: every branch must answer the SAME
 * question. The `mode: 'all'` branch answered the opposite of its siblings, so
 * an agent holding "All workspaces · Read-write" read as "No access yet" in the
 * user-settings rollup while the integrations panel — which renders the raw
 * document — showed the correct level. No test covered `mode: 'all'` at all,
 * which is exactly how an inverted predicate survives: every fixture was
 * `none` or `custom`.
 */
import { describe, expect, it } from 'vitest';

import type { AccessDocument } from '@cytale/api-client';

import { accessIsEmpty, describeAccess, emptyAccessDocument } from '../AccessTree.js';

const WS = '9007199254740993';

/** The never-granted document every machine principal starts at (R6). */
const NONE: AccessDocument = emptyAccessDocument();

function withWorkspaces(workspaces: AccessDocument['workspaces']): AccessDocument {
  return { ...NONE, workspaces };
}

describe('accessIsEmpty', () => {
  it('reads a null or never-granted document as empty', () => {
    expect(accessIsEmpty(null)).toBe(true);
    expect(accessIsEmpty(undefined)).toBe(true);
    expect(accessIsEmpty(NONE)).toBe(true);
  });

  it('an "all workspaces" root is empty only at level none', () => {
    // The reported defect, both directions.
    expect(accessIsEmpty(withWorkspaces({ mode: 'all', level: 'read_write', grants: {} }))).toBe(
      false,
    );
    expect(accessIsEmpty(withWorkspaces({ mode: 'all', level: 'read', grants: {} }))).toBe(false);
    expect(accessIsEmpty(withWorkspaces({ mode: 'all', level: 'none', grants: {} }))).toBe(true);
    // A missing level means the same as an explicit none.
    expect(accessIsEmpty(withWorkspaces({ mode: 'all', level: null, grants: {} }))).toBe(true);
  });

  it('a custom root is empty when no grant and no channel level grants anything', () => {
    expect(
      accessIsEmpty(
        withWorkspaces({
          mode: 'custom',
          level: null,
          grants: { [WS]: { level: 'read_write', channels: {} } },
        }),
      ),
    ).toBe(false);
    // A workspace held at none whose only reach is one channel still counts.
    expect(
      accessIsEmpty(
        withWorkspaces({
          mode: 'custom',
          level: null,
          grants: { [WS]: { level: 'none', channels: { '910000000000000001': 'read' } } },
        }),
      ),
    ).toBe(false);
    expect(
      accessIsEmpty(
        withWorkspaces({
          mode: 'custom',
          level: null,
          grants: { [WS]: { level: 'none', channels: { '910000000000000001': 'none' } } },
        }),
      ),
    ).toBe(true);
    expect(accessIsEmpty(withWorkspaces({ mode: 'custom', level: null, grants: {} }))).toBe(true);
  });

  it('DM reach alone is not empty', () => {
    expect(accessIsEmpty({ ...NONE, dms: 'read' })).toBe(false);
  });
});

describe('describeAccess', () => {
  it('names the no-access state outright', () => {
    expect(describeAccess(null)).toBe('No access yet');
    expect(describeAccess(NONE)).toBe('No access yet');
  });

  it('summarises an "all workspaces" root with its level', () => {
    expect(describeAccess(withWorkspaces({ mode: 'all', level: 'read_write', grants: {} }))).toBe(
      'All workspaces · Read-write',
    );
    expect(describeAccess(withWorkspaces({ mode: 'all', level: 'read', grants: {} }))).toBe(
      'All workspaces · Read',
    );
  });

  it('counts the granting workspaces of a custom root, and falls back to DMs', () => {
    expect(
      describeAccess(
        withWorkspaces({
          mode: 'custom',
          level: null,
          grants: {
            [WS]: { level: 'read_write', channels: {} },
            '9007199254740994': { level: 'none', channels: {} },
          },
        }),
      ),
    ).toBe('1 workspace');
    expect(describeAccess({ ...NONE, dms: 'read' })).toBe('DMs only');
  });
});
