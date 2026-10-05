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
// A note on `isTauri()`: the desktop build running in a browser during dev is a case some other
// projects distinguish with a runtime probe. Nothing here needs that distinction — dev, tests and
// production all care only about the target the bundler was given — so no `isTauri()` is provided.
// Add one only alongside a real consumer that needs it.

export type BuildTarget = 'web' | 'desktop';

/** What a build can do, straight from the line between "browsers can" and "only a desktop shell can". */
export interface Capabilities {
  buildTarget: BuildTarget;
  /** Raw TCP/UDP to a controller (the WiFi machine bridge, #255) — impossible in a browser. */
  canDriveMachine: boolean;
  /** Local filesystem: Makera's feeds/speeds SQLite, a filesystem-backed board library (#131). */
  canReadLocalFiles: boolean;
  /** The embedded HTTP server controls (port, LAN bind) that SettingsMenu shows. */
  canRunLocalServer: boolean;
}

/**
 * Pure target → capabilities mapping. Kept separate from the exported constants so the whole
 * matrix is unit-testable for both targets in a single run.
 */
export function capabilitiesFor(target: BuildTarget): Capabilities {
  const desktop = target === 'desktop';
  return {
    buildTarget: target,
    canDriveMachine: desktop,
    canReadLocalFiles: desktop,
    canRunLocalServer: desktop,
  };
}

// The exported constants reference `__BUILD_TARGET__` directly rather than going through
// `capabilitiesFor`, because Vite's `define` substitutes the literal before any analysis and each
// comparison then folds to a constant. Computing them indirectly would defeat the dead-code
// elimination the dynamic-import boundary depends on.
export const BUILD_TARGET: BuildTarget = __BUILD_TARGET__;
export const canDriveMachine: boolean = __BUILD_TARGET__ === 'desktop';
export const canReadLocalFiles: boolean = __BUILD_TARGET__ === 'desktop';
export const canRunLocalServer: boolean = __BUILD_TARGET__ === 'desktop';

/**
 * The dynamic-import boundary, carried by the one desktop-only module that exists ahead of its real
 * consumer. #255 replaces the stub's body with the real bridge; the *shape* — the `canDriveMachine`
 * guard around the `await import()` — is the part that must not change, or the module leaks into the
 * web bundle. `tools/check-platform-gate.mjs` is the check that fails if it does.
 */
export async function loadMachineBridge(): Promise<typeof import('./desktop/machineBridge')> {
  if (canDriveMachine) {
    return import('./desktop/machineBridge');
  }
  throw new Error('Driving the machine requires the desktop build (BUILD_TARGET=desktop).');
}
