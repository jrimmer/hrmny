/**
 * jest-expo is the preset React Native Testing Library requires; the spike's
 * temporary vitest entry is retired here (RNTL does not run under vitest).
 */
// decode-uri-component 0.5.0 (pinned by the #125 CVE override in
// pnpm-workspace.yaml) ships ESM only, and expo-router's testing library
// reaches it through query-string. The preset's pattern leaves it
// untranspiled, so seven route suites failed to load with "Unexpected token
// 'export'". Add it to the preset's allow-list rather than restating the list.
const [presetFirst, ...presetRest] = require('jest-expo/jest-preset').transformIgnorePatterns;
const ESM_ONLY = ['decode-uri-component'];

module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [presetFirst.replace('(?!(', `(?!(${ESM_ONLY.join('|')}|`), ...presetRest],
  // The route suites mount the REAL app tree (expo-router + drawer +
  // scene adoption); under parallel workers that mount brushes the 5s
  // default and flakes — the web gate's --testTimeout lesson (mobile.yml).
  testTimeout: 20000,
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  moduleNameMapper: {
    // The @cytale/* packages are authored as NodeNext ESM: relative imports
    // carry an explicit `.js` specifier that maps to a `.ts` file on disk.
    // Metro gets a resolver shim (metro.config.js); jest gets this mapping.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // The markdown parity test executes the web renderer, whose import graph
    // reaches the PWA registration module — a Vite virtual module with no
    // on-disk implementation for jest to resolve. The stub is inert: nothing
    // under test calls it (see src/test/virtual-pwa-register.stub.js).
    '^virtual:pwa-register$': '<rootDir>/src/test/virtual-pwa-register.stub.js',
  },
  testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
};
