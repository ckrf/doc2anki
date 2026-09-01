import { defineConfig } from 'vitest/config';

export default defineConfig({
  assetsInclude: ['**/*.wasm', '**/*.wasm?inline'],
  test: {
    clearMocks: true,
    environment: 'jsdom',
    fileParallelism: false,
    restoreMocks: true,
    setupFiles: ['./tests/setup.ts'],
  },
});
