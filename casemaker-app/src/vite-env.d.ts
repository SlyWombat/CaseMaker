/// <reference types="vite/client" />

// Issue #80 — injected by vite.config.ts via `define:`. Format:
//   __APP_VERSION__ = "0.10.0+abc1234" (or "0.10.0+abc1234-dirty" / "0.10.0+nogit")
//   __BUILD_DATE__  = "2026-04-28"
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

// Issue #72 — production-only Donate button.
//   __DEPLOY_TARGET__ = "electricrv" on the cPanel deploy, "" elsewhere.
//   __DONATE_URL__    = Stripe Payment Link URL on production, "" elsewhere.
declare const __DEPLOY_TARGET__: string;
declare const __DONATE_URL__: string;
