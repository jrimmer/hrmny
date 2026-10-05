/**
 * @cytale/tui — test runner config.
 *
 * Node environment, not jsdom: this client talks to real file descriptors and
 * a real socket, and the two things its suite proves — the no-disk property
 * (R27) and the descriptor renewal path (KTD8) — only mean anything off a real
 * filesystem and a real `fs.read(2)`. The default `forks` pool is kept so a
 * blocking descriptor read cannot stall the runner's own workers.
 *
 * A vitest config exists here (the packages resolve their suites from the
 * defaults) only because `.tsx` needs the automatic JSX runtime named
 * explicitly for the Ink components.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
