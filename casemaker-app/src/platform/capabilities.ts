// Issue #181 — the platform seam.
//
// ONE place answers "what can this build do?". Every capability is derived from the build-time
// constant `__BUILD_TARGET__` (injected by vite.config.ts), never from a runtime `window` sniff:
// a build-time constant is what lets the bundler delete the dead branch — and, with it, any
// `await import()` of desktop-only code — out of the web bundle. A runtime `window.__TAURI__`
// check cannot be eliminated that way, so it is deliberately not used here.
//
// DYNAMIC-IMPORT BOUNDARY (the pattern #255's machine bridge and #131's filesystem library follow):
//
//   if (canX) {
//     const mod = await import('./desktop/whatever');   // never in the web module graph
//     ...
//   }
//
// Desktop-only modules live under `src/platform/desktop/` and are reached ONLY through an
// `await import()` inside a `canX` guard. When `canX` folds to `false`, the guard is dead code and
// the bundler drops the import, so the module never enters the web bundle. `tools/check-platform-gate.mjs`
// builds the default web target and fails if a desktop-only marker string is present in it. A module
// that is imported at the top level instead of through this boundary will leak — that is the whole
// rule.
//
// A note on `isTauri()`: WHERE the machine lives — the Tauri shell's own socket or the local
// instance's HTTP relay — is a RUNTIME question (`machineBridge.ts`'s `defaultTransport` asks
// `globalThis.isTauri`), and that is deliberately separate from this file. What this file answers
// is the compile-time one: whether the bundle CARRIES the machine bridge at all. The relay-less
// static deploy must not, so the import boundary above is what keeps its bundle clean.

/**
 * #821 — the three bundles.
 *
 *  - `web`: the static deploy (electricrv.ca, CI's e2e build). No relay, no machine bridge.
 *  - `desktop`: the Tauri app. Its own socket, and the same bundle served to a LAN browser talks
 *    to the app's embedded relay (`httpTransport`).
 *  - `house`: what a local instance serves to LAN browsers (k3, `npm run build:house`). No Tauri
 *    runtime, so the machine is reached through that instance's relay, `/api/v1/machine/*`.
 *
 * `house` is new in #821 precisely because "can this page drive a machine?" is not "is this the
 * Tauri shell?": it is "does the bundle carry the bridge, and is a relay or socket under it?".
 */
export type BuildTarget = 'web' | 'desktop' | 'house';

/** What a build can do, straight from the line between "browsers can" and "only a desktop shell can". */
export interface Capabilities {
  buildTarget: BuildTarget;
  /**
   * The bundle carries the machine bridge (desktop and house): the Tauri shell's own socket, or
   * the HTTP relay a local instance serves. The relay-less web deploy compiles it out.
   */
  canReachMachine: boolean;
  /** Local filesystem dialogs and Makera's feeds/speeds SQLite (#131) — the Tauri shell only. */
  canReadLocalFiles: boolean;
  /** The embedded HTTP server controls (port, LAN bind) that SettingsMenu shows — Tauri only. */
  canRunLocalServer: boolean;
}

/**
 * Pure target → capabilities mapping. Kept separate from the exported constants so the whole
 * matrix is unit-testable for every target in a single run.
 */
export function capabilitiesFor(target: BuildTarget): Capabilities {
  const desktop = target === 'desktop';
  return {
    buildTarget: target,
    canReachMachine: target !== 'web',
    canReadLocalFiles: desktop,
    canRunLocalServer: desktop,
  };
}

// The exported constants reference `__BUILD_TARGET__` directly rather than going through
// `capabilitiesFor`, because Vite's `define` substitutes the literal before any analysis and each
// comparison then folds to a constant. Computing them indirectly would defeat the dead-code
// elimination the dynamic-import boundary depends on.
export const BUILD_TARGET: BuildTarget = __BUILD_TARGET__;
export const canReachMachine: boolean = __BUILD_TARGET__ !== 'web';
export const canReadLocalFiles: boolean = __BUILD_TARGET__ === 'desktop';
export const canRunLocalServer: boolean = __BUILD_TARGET__ === 'desktop';

/**
 * #821 — THE RELAY-LESS BUILD'S ONE SENTENCE. The web deploy has no machine relay, so its machine
 * surfaces say why instead of offering a check that could only ever answer "unavailable". The
 * house and desktop bundles never render this.
 */
export const NO_MACHINE_RELAY_SENTENCE =
  'This page was served without the machine relay, so it cannot drive a machine — open Case Maker from the house server or the desktop app.';

/**
 * The dynamic-import boundary, carried by the one desktop-only module that exists ahead of its real
 * consumer. #255 replaces the stub's body with the real bridge; the *shape* — the `canReachMachine`
 * guard around the `await import()` — is the part that must not change, or the module leaks into the
 * web bundle. `tools/check-platform-gate.mjs` is the check that fails if it does.
 */
export async function loadMachineBridge(): Promise<typeof import('./desktop/machineBridge')> {
  if (canReachMachine) {
    return import('./desktop/machineBridge');
  }
  throw new Error('Driving the machine requires a build that carries the machine bridge (BUILD_TARGET=desktop or house).');
}
