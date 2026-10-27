/**
 * #704 — THE DEV-SERVER PORT BELONGS TO THE CHECKOUT, not to one shared number.
 *
 * `playwright.config.ts` reuses an existing dev server outside CI. With a fixed port, two Playwright
 * runs from different worktrees on this machine shared :5173: the second run attached to the FIRST
 * checkout's server and tested that tree's code — a green run could say nothing about the tree under
 * test (observed 2026-10-26; see #704).
 *
 * So each checkout gets a stable port derived from its own path, in a band clear of Vite's 5173 and
 * the kernel-reserved ports this host has shown (8000–8002). The derivation is used by BOTH
 * `playwright.config.ts` (the runner's base URL and webServer) and `vite.config.ts` (a hand-started
 * `npm run dev`), so the two agree without an environment variable.
 *
 * Precedence, in order:
 *   1. an explicit `CASEMAKER_PORT` — it always wins (and a bad value fails loudly);
 *   2. CI — the standard 5173, unchanged: one job, one checkout, nothing to share;
 *   3. the checkout path's derived port.
 *
 * Desktop mode is deliberately NOT derived: `vite --mode desktop` must bind exactly the `devUrl` in
 * `src-tauri/tauri.conf.json` (127.0.0.1:5173), so `vite.config.ts` keeps 5173 there (see #292).
 */
import path from 'node:path';

/** The derived band: 100 ports, clear of 5173 and the kernel-reserved 8000s on WSL2/Hyper-V. */
export const E2E_PORT_FIRST = 5300;
export const E2E_PORT_LAST = 5399;

/** The one port CI and desktop mode keep. */
export const DEFAULT_DEV_PORT = 5173;

/**
 * FNV-1a, 32-bit. A deliberate hash, not `String.prototype.hashCode` or an object key: it is
 * deterministic across platforms and Node versions, so a checkout keeps its port between sessions.
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The port one checkout gets. The path is resolved and its separators and case normalized first, so
 * the same checkout keeps one port between sessions on the platform it runs on; a worktree that
 * moves lands on a new one rather than silently reusing its old server.
 */
export function portForCheckout(checkoutPath: string): number {
  const normalized = path.resolve(checkoutPath).replace(/\\/g, '/').toLowerCase();
  return E2E_PORT_FIRST + (fnv1a(normalized) % (E2E_PORT_LAST - E2E_PORT_FIRST + 1));
}

/**
 * The dev-server port for this process. `env` and `cwd` are parameters so the rule is testable
 * without mutating the real environment.
 */
export function devServerPort(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  const explicit = env.CASEMAKER_PORT;
  if (explicit !== undefined && explicit.trim() !== '') {
    const port = Number(explicit);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    throw new Error(`CASEMAKER_PORT must be a TCP port number between 1 and 65535; got "${explicit}".`);
  }
  // CI is one job on one checkout: the standard port is what its tooling expects, and nothing can
  // attach from another tree. Desktop mode is handled by the caller (vite.config.ts).
  if (env.CI !== undefined && env.CI !== '') return DEFAULT_DEV_PORT;
  return portForCheckout(cwd);
}
