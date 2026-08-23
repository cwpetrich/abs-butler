import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose: that one sets `root: 'web'` for the
 * frontend build, which would make Vitest look for tests inside web/ and miss
 * every server test in src/.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    environment: 'node',
  },
});
