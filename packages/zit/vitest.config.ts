import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'node',
      // The suite has tests; an empty glob match (e.g. a broken include
      // pattern after a refactor) must fail loudly, not silently pass.
      passWithNoTests: false,
      // Real environment split (issue #68): browser-module tests need DOM
      // (Canvas, ImageBitmap, document) and get jsdom; everything else is
      // server code and stays on plain `node`. This replaces the old
      // convention-only approach of a `// @vitest-environment jsdom` pragma
      // comment at the top of each browser test file. `environmentMatchGlobs`
      // was removed in Vitest 4 (this package pins ^4.1.4) in favour of
      // `projects` — see https://vitest.dev/guide/projects.
      projects: [
        {
          extends: true,
          test: {
            name: 'server',
            environment: 'node',
            include: ['src/**/*.test.ts'],
            exclude: ['src/browser/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'browser',
            environment: 'jsdom',
            include: ['src/browser/**/*.test.ts'],
          },
        },
      ],
    },
  }),
);
