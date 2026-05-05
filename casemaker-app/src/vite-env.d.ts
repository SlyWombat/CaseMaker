/// <reference types="vite/client" />

// Injected by vite.config.ts via `define:` — bare semver from package.json.
declare const __APP_VERSION__: string;

// Issue #72 — production-only Donate button.
//   __DEPLOY_TARGET__ = "electricrv" on the cPanel deploy, "" elsewhere.
//   __DONATE_URL__    = Stripe Payment Link URL on production, "" elsewhere.
declare const __DEPLOY_TARGET__: string;
declare const __DONATE_URL__: string;
