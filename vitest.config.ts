import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    // The client render test opts into jsdom via a `// @vitest-environment jsdom` pragma.
  },
});
