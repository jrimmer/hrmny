/**
 * Metro NodeNext resolver shim test (plan 004 review, finding #1).
 *
 * The @cytale/* packages are authored as NodeNext ESM: relative imports carry
 * an explicit `.js` specifier that maps to a `.ts` file on disk. Metro does not
 * rewrite that, so `metro.config.js` installs a `resolveRequest` shim that
 * retries the specifier extension-less.
 *
 * jest's `moduleNameMapper` implements the same rule independently, so a green
 * jest suite says nothing about whether the app still bundles. This test drives
 * the shim itself, which is the only automated exercise of the Metro mapping.
 *
 * `expo/metro-config` is mocked: it pulls ESM-only deps (yaml) that
 * jest-expo's transform does not cover, and the shim under test never uses it.
 */
jest.mock('expo/metro-config', () => ({
  getDefaultConfig: () => ({ resolver: {}, watchFolders: [] }),
}));

interface StubContext {
  resolveRequest: (context: StubContext, moduleName: string, platform: string | null) => unknown;
}

type ResolveRequest = (
  context: StubContext,
  moduleName: string,
  platform: string | null,
) => unknown;

function loadResolveRequest(): ResolveRequest {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require('../../metro.config.js') as { resolver: { resolveRequest: ResolveRequest } };
  return config.resolver.resolveRequest;
}

/** Context stub that records every specifier handed to the underlying resolver. */
function stubContext(resolve: (moduleName: string) => unknown) {
  const calls: string[] = [];
  const seenContexts: unknown[] = [];
  const context: StubContext = {
    resolveRequest: (ctx, moduleName) => {
      seenContexts.push(ctx);
      calls.push(moduleName);
      return resolve(moduleName);
    },
  };
  return { calls, context, seenContexts };
}

describe('metro NodeNext resolver shim', () => {
  it('retries a relative .js specifier extension-less, then falls back to the literal path', () => {
    const resolveRequest = loadResolveRequest();
    expect(typeof resolveRequest).toBe('function');

    const { calls, context, seenContexts } = stubContext((moduleName) => {
      if (moduleName === './store') throw new Error('Unable to resolve ./store');
      return { type: 'sourceFile', filePath: `/app/node_modules/@cytale/state/${moduleName}` };
    });

    const result = resolveRequest(context, './store.js', 'ios');

    expect(calls).toEqual(['./store', './store.js']);
    expect(seenContexts).toEqual([context, context]);
    expect(result).toEqual({
      type: 'sourceFile',
      filePath: '/app/node_modules/@cytale/state/./store.js',
    });
  });

  it('keeps the extension-less hit when it resolves', () => {
    const resolveRequest = loadResolveRequest();
    const { calls, context } = stubContext(() => ({
      type: 'sourceFile',
      filePath: '/app/node_modules/@cytale/state/src/store.ts',
    }));

    const result = resolveRequest(context, './store.js', 'android');

    expect(calls).toEqual(['./store']);
    expect(result).toEqual({
      type: 'sourceFile',
      filePath: '/app/node_modules/@cytale/state/src/store.ts',
    });
  });

  it('passes non-relative and non-.js specifiers straight through', () => {
    const resolveRequest = loadResolveRequest();
    const { calls, context } = stubContext((moduleName) => ({
      type: 'sourceFile',
      filePath: `/app/${moduleName}`,
    }));

    resolveRequest(context, 'react-native', 'ios');
    resolveRequest(context, './store.ts', 'ios');
    resolveRequest(context, './store', 'ios');

    expect(calls).toEqual(['react-native', './store.ts', './store']);
  });
});
