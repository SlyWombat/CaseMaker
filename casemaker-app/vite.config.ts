import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Default port 5173 (Vite's standard). Port 8000 was the historical default
// but conflicts with kernel-reserved ports on some WSL2 / Hyper-V hosts;
// pick a port that's free everywhere and let CASEMAKER_PORT override.
const DEFAULT_PORT = Number(process.env.CASEMAKER_PORT ?? 5173);

// Issue #80 — inject the package version + a short git sha into the bundle so
// the StatusBar can show "v0.10.0+abc1234". The git lookup tolerates a
// non-git build environment (Tauri / static deploy outside the repo) by
// falling back to "nogit".
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};
let gitSha = 'nogit';
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
    .slice(0, 7);
  // Mark dirty when there are uncommitted changes so production builds with
  // local modifications don't masquerade as the clean tag.
  const dirty = execSync('git status --porcelain', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim().length > 0;
  if (dirty) gitSha += '-dirty';
} catch {
  /* not a git checkout */
}
const APP_VERSION = `${pkg.version}+${gitSha}`;
const BUILD_DATE = new Date().toISOString().slice(0, 10);

// Issue #82 — DEPLOY_BASE controls the public URL prefix the bundle uses for
// `<script src=...>` and `import()` chunk URLs. cPanel deploy script sets it
// to '/casemaker/' so the SPA can live at electricrv.ca/casemaker/. Default
// '/' for dev / Tauri / GitHub Pages root deploys.
const BASE = process.env.DEPLOY_BASE ?? '/';

// Issue #72 — DEPLOY_TARGET + DONATE_URL gate the in-app Donate button to the
// electricrv.ca production deploy. Empty in dev, Tauri, GitHub Pages, etc.
const DEPLOY_TARGET = process.env.DEPLOY_TARGET ?? '';
const DONATE_URL = process.env.DONATE_URL ?? '';

export default defineConfig({
  base: BASE,
  plugins: [react(), wasm()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
    __DEPLOY_TARGET__: JSON.stringify(DEPLOY_TARGET),
    __DONATE_URL__: JSON.stringify(DONATE_URL),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('three')) return 'vendor-three';
            if (id.includes('manifold-3d')) return 'vendor-manifold';
            if (id.includes('@react-three/drei')) return 'vendor-drei';
            if (id.includes('@react-three/fiber')) return 'vendor-r3f';
            if (id.includes('react-dom')) return 'vendor-react';
            if (id.includes('react/')) return 'vendor-react';
            if (id.includes('zustand') || id.includes('zundo') || id.includes('immer')) return 'vendor-state';
            if (id.includes('zod')) return 'vendor-zod';
          }
        },
      },
    },
  },
  server: { fs: { allow: ['..'] }, port: DEFAULT_PORT, strictPort: false },
  preview: { port: DEFAULT_PORT, strictPort: false },
});
