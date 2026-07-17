import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'node',
      include: ['src/**/*.test.ts'],
      // The suite has tests; an empty glob match (e.g. a broken include
      // pattern after a refactor) must fail loudly, not silently pass.
      passWithNoTests: false,
    },
  }),
);
