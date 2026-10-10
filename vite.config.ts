import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Tests that read the real files under Files/ at test time (read only; counts, booleans and hashes only). */
const REAL_FILE_TESTS = ['tests/epic-real-pdf.test.ts', 'tests/messages-import-real.test.ts', 'tests/lc-engine-real.test.ts', 'tests/lr-real.test.ts'];
/** Tests that time the API against a budget: run on their own, never measured beside the rest of the suite. */
const TIMING_TESTS = ['tests/folder-import.performance.test.ts', 'tests/labsplit3-words.test.ts'];

export default defineConfig({
  root: path.join(here, 'src/client'),
  publicDir: path.join(here, 'src/client/public'),
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: path.join(here, 'src/client/routes'),
      generatedRouteTree: path.join(here, 'src/client/routeTree.gen.ts'),
      routeFileIgnorePrefix: '-',
      quoteStyle: 'single',
    }),
    react(),
  ],
  resolve: {
    alias: {
      '@shared': path.join(here, 'src/shared'),
      '@client': path.join(here, 'src/client'),
    },
  },
  server: {
    host: '127.0.0.1',
    // CASEFILE_WEB_PORT / CASEFILE_API let a private test copy run beside the real app.
    port: Number(process.env.CASEFILE_WEB_PORT ?? 4811),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.CASEFILE_API ?? 'http://127.0.0.1:4810',
        changeOrigin: false,
        // src/client/api/*.ts is served by Vite at /api/*.ts in dev; those are
        // source modules, not backend calls. Backend paths never carry a file extension.
        bypass(req) {
          if (req.url && /^\/api\/[^?]+\.(ts|tsx|js|mjs|css|json)(\?.*)?$/.test(req.url)) return req.url;
          return undefined;
        },
      },
    },
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    root: here,
    environment: 'node',
    // Tests never touch the real case: data, file store and backups go to a scratch folder. A key set in the shell is
    // blanked, so no test can reach the API by accident (getApiKey trims it and falls through to settings); the tests
    // that need a key set one of their own and put it back.
    env: {
      CASEFILE_DATA_DIR: path.join(here, '.tmp', 'test-data'),
      CASEFILE_BACKUPS_DIR: path.join(here, '.tmp', 'test-backups'),
      ANTHROPIC_API_KEY: '',
    },
    // The tests that read a real long export (counts only, skipped when the file is absent) take a minute of
    // CPU; they run after everything else. The timing tests run in a group of their own between the two, so they are
    // never measured beside other tests (2026-10-07: the budget of 150 ms held alone at about 75 ms, not under load).
    projects: [
      { extends: true, test: { name: 'casefile', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...REAL_FILE_TESTS, ...TIMING_TESTS], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'timing', include: TIMING_TESTS, sequence: { groupOrder: 1 } } },
      { extends: true, test: { name: 'real-files', include: REAL_FILE_TESTS, sequence: { groupOrder: 2 } } },
    ],
  },
});
