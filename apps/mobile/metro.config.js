// Metro is the React Native bundler; this config exists for the pnpm
// workspace. The @cytale/* packages are consumed as TypeScript *source*
// (`exports: ./src/index.ts`), so Metro has to watch the monorepo root and
// resolve modules from both node_modules trees.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// NOTE: hierarchical lookup must stay ENABLED. Expo's monorepo guide suggests
// disabling it for hoisted node_modules, but pnpm's isolated linker keeps a
// package's own deps inside node_modules/.pnpm/<pkg>@<ver>/node_modules — with
// lookup disabled Metro cannot find `expo-modules-core` from `expo/src/Expo.ts`.

// The @cytale/* packages are authored as NodeNext ESM: relative imports carry
// an explicit `.js` specifier that maps to a `.ts` file on disk. Vite rewrites
// this for the web app; Metro does not, so retry such specifiers without the
// extension and let sourceExts find the TypeScript source.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through: the specifier may genuinely point at a real .js file.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
