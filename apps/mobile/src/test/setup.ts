// The safe-area mock: components call useSafeAreaInsets directly (the
// drawer does for its notch/curve gutters) and jest has no provider —
// the official mock supplies zero-valued insets for every test.
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);

// Per-file test environment. Global runtime shims are installed by the app
// entrypoint (src/shims), never here — tests import them explicitly, so a
// missing shim is a visible failure rather than hidden global state.
//
// The build-time origin is the exception: this runtime is native-shaped (no
// `location`) and `@cytale/session` refuses to guess a gateway host, so the
// suites that mount the REAL app tree need the same origin a development build
// runs against. Suites that test origin handling itself set and restore their
// own values.
process.env.EXPO_PUBLIC_CYTALE_ORIGIN ??= 'http://127.0.0.1:4001';
// The sign-in form's suggested server (src/auth/serverOrigin.ts), which a
// release build takes from its deployment's configuration.
process.env.EXPO_PUBLIC_CYTALE_HOSTED_ORIGIN ??= 'https://chat.example.com';

export {};
