/**
 * Test-only reader for the web token source (plan 004 M3).
 *
 * `apps/web/src/app/theme/tokens.css` is the single source of truth for both
 * renderers, so the parity test reads the file at run time instead of
 * restating its values. This package's tsconfig pins `types: ["jest"]` and
 * `@types/node` is not resolvable from `apps/mobile`; package.json is frozen
 * for this unit, so the two Node globals this helper needs are declared
 * locally rather than adding a dependency.
 */
declare const __dirname: string;
declare function require(id: string): {
  readFileSync(path: string, encoding: string): string;
};

/** Absolute path to the web app's token source. */
export const WEB_TOKENS_CSS_PATH = [
  __dirname,
  '..', // theme
  '..', // src
  '..', // mobile
  '..', // apps
  'web',
  'src',
  'app',
  'theme',
  'tokens.css',
].join('/');

export function readWebTokensCss(): string {
  return require('node:fs').readFileSync(WEB_TOKENS_CSS_PATH, 'utf8');
}
