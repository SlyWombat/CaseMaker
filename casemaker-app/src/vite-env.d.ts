/// <reference types="vite/client" />

// Injected by vite.config.ts via `define:` — bare semver from package.json.
declare const __APP_VERSION__: string;

// Issue #72 — production-only Donate button.
//   __DEPLOY_TARGET__ = "electricrv" on the cPanel deploy, "" elsewhere.
//   __DONATE_URL__    = Stripe Payment Link URL on production, "" elsewhere.
declare const __DEPLOY_TARGET__: string;
declare const __DONATE_URL__: string;

// #182 — the CNC simulation. true everywhere except the electricrv.ca deploy
// (DEPLOY_TARGET === 'electricrv'); see vite.config.ts.
declare const __FEATURE_SIM__: boolean;

// #181 — the platform seam's build-time switch. 'web' by default; 'desktop' when the build sets
// BUILD_TARGET=desktop or uses `--mode desktop` (the tauri:* scripts). Read it through
// src/platform/capabilities.ts, never directly from a component.
declare const __BUILD_TARGET__: 'web' | 'desktop';
