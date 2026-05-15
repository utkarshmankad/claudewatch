import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Measure coverage only over testable business-logic modules.
      // Interactive CLI wizard (config/index.ts), web components, and
      // the install command (shell-heavy) are excluded as they require
      // integration-level setup beyond unit tests.
      include: [
        'src/api/**/*.ts',
        'src/alerts/**/*.ts',
        'src/config/manager.ts',
        'src/config/schema.ts',
        'src/daemon/costCache.ts',
        'src/store/**/*.ts',
        'src/version.ts',
      ],
      exclude: [
        'src/**/__tests__/**',
      ],
    },
  },
});
