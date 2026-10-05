// The first desktop-only module (#181's dynamic-import boundary sample; #255 fills in the body).
//
// This file must NEVER appear in the web bundle. It is reached only through
// `loadMachineBridge()` in ../capabilities.ts, whose `await import()` sits behind the
// `canDriveMachine` guard. `tools/check-platform-gate.mjs` greps the default web build for
// DESKTOP_ONLY_MARKER and fails if it is found. When #255 implements the real bridge it keeps the
// marker and the boundary; only the exported surface below is expected to change.
//
// `@tauri-apps/api` belongs here, not at the top of a component: importing it at this boundary is
// what keeps the whole dependency out of the web build.

export const DESKTOP_ONLY_MARKER = 'casemaker-desktop-bridge-v1';

/**
 * Placeholder until #255. Connecting to a Makera controller needs raw sockets, which a browser
 * cannot open — hence the desktop-only module and the build switch that gates it.
 */
export async function connectMachineBridge(): Promise<never> {
  throw new Error('The machine bridge is not implemented yet (see #255).');
}
