import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // #181 — the unit tests run the web target, matching the default build. Without this the
  // `__BUILD_TARGET__` reference in src/platform/capabilities.ts would be an undeclared global.
  define: { __FEATURE_SIM__: 'true', __BUILD_TARGET__: JSON.stringify('web') },
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
    // Seeds the bundled-font cache from the TTFs on disk (issue #180) — specs typeset labels
    // synchronously and have no `fetch` seam, so the six faces must be pre-parsed.
    setupFiles: ['./tests/setup/fonts.ts'],
    globals: false,
    coverage: { reporter: ['text', 'html'] },
  },
});
