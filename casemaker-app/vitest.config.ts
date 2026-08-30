import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    // These are geometry tests: most of them build real solids through the
    // Manifold WASM kernel, and a full rack is seconds of CSG. Vitest's 5 s
    // default is simply the wrong scale for that — 15 rack tests were running
    // on it and failing whenever the machine was busy, which reads as a
    // regression and is not one. The tests that already pass an explicit
    // 180000 were doing one at a time what belongs in one place.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    include: ['tests/unit/**/*.spec.ts', 'tests/unit/**/*.spec.tsx'],
    globals: false,
    coverage: { reporter: ['text', 'html'] },
  },
});
