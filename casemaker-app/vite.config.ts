import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Default port 5173 (Vite's standard). Port 8000 was the historical default
// but conflicts with kernel-reserved ports on some WSL2 / Hyper-V hosts;
// pick a port that's free everywhere and let CASEMAKER_PORT override.
const DEFAULT_PORT = Number(process.env.CASEMAKER_PORT ?? 5173);

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};
const APP_VERSION = pkg.version;

// Issue #82 — DEPLOY_BASE controls the public URL prefix the bundle uses for
// `<script src=...>` and `import()` chunk URLs. cPanel deploy script sets it
// to '/casemaker/' so the SPA can live at electricrv.ca/casemaker/. Default
// '/' for dev / Tauri / GitHub Pages root deploys.
const BASE = process.env.DEPLOY_BASE ?? '/';

// Issue #72 — DEPLOY_TARGET + DONATE_URL gate the in-app Donate button to the
// electricrv.ca production deploy. Empty in dev, Tauri, GitHub Pages, etc.
const DEPLOY_TARGET = process.env.DEPLOY_TARGET ?? '';
const DONATE_URL = process.env.DONATE_URL ?? '';

// #182 — the CNC simulation (sim worker, client and store). A compile-time switch: ON by
// default (dev, tests, Tauri, GitHub Pages), OFF for the electricrv.ca deploy, because `main`
// goes to the live public site and the UI is gated on a mockup that does not exist yet. With
// it off, the lazy `import()` behind it is dead code and the worker never enters the bundle.
const FEATURE_SIM = DEPLOY_TARGET !== 'electricrv';

// Issue #164 — electricrv.ca's shared, cookie-free page-view counter. Injected
// into <head> only for the cPanel production deploy, the same gate as the Donate
// button, so dev, tests, other static hosts and the Tauri desktop build never
// load it (Tauri's CSP would refuse the script anyway). SPA route changes are
// counted by the script itself, so nothing in src/ knows about it.
const ANALYTICS_SRC = 'https://electricrv.ca/api/analytics/a.js';
function analyticsTag(): Plugin {
  return {
    name: 'casemaker:analytics-tag',
    transformIndexHtml() {
      if (DEPLOY_TARGET !== 'electricrv') return;
      return [{ tag: 'script', attrs: { defer: true, src: ANALYTICS_SRC }, injectTo: 'head' }];
    },
  };
}

export default defineConfig(({ mode }) => {
  // Issue #181 — the platform seam's single build-time switch. 'web' unless the build explicitly
  // asks for the desktop target, so the default `npm run build` and the electricrv.ca `npm run
  // deploy` are unaffected. `BUILD_TARGET` in the environment wins when set; `--mode desktop` is
  // the cross-platform equivalent, used by the tauri:* npm scripts because a bare
  // `BUILD_TARGET=desktop npm …` never works in Windows cmd/PowerShell. Either way the value ends
  // up in `__BUILD_TARGET__`, which src/platform/capabilities.ts reads.
  const BUILD_TARGET = process.env.BUILD_TARGET ?? (mode === 'desktop' ? 'desktop' : 'web');

  return {
    base: BASE,
    plugins: [react(), wasm(), analyticsTag()],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __DEPLOY_TARGET__: JSON.stringify(DEPLOY_TARGET),
      __DONATE_URL__: JSON.stringify(DONATE_URL),
      __FEATURE_SIM__: JSON.stringify(FEATURE_SIM),
      __BUILD_TARGET__: JSON.stringify(BUILD_TARGET),
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
    // #226 — bind the dev server to IPv4 loopback explicitly. Left unset, Vite binds `localhost`,
    // which on this machine resolves to `::1` first, so Playwright's `http://127.0.0.1:5173`
    // webServer probe never gets an answer and its 120 s timeout expires before a test runs.
    // The e2e webServer and every manual run since #199 already use 127.0.0.1; this makes the
    // default agree with them (and lets `reuseExistingServer` see a hand-started server too).
    server: { host: '127.0.0.1', fs: { allow: ['..'] }, port: DEFAULT_PORT, strictPort: false },
    preview: { port: DEFAULT_PORT, strictPort: false },
  };
});
