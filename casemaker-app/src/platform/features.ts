// #343 — the CNC UI on the public site, behind a URL switch.
//
// `__FEATURE_SIM__` (vite.config.ts, #182) is a compile-time constant: true for dev, tests, the
// Tauri build and GitHub Pages, false for the electricrv.ca deploy. It used to be read directly,
// which let the bundler delete every CNC branch out of the public bundle (#193). The maintainer
// asked for the public site to show the CNC UI to beta users on request, and the request is the
// page address: `https://electricrv.ca/casemaker/?BETA=yes`.
//
// So the switch is a runtime value, computed ONCE at module load from the build flag OR the URL.
// The bundler can no longer delete the branches, but the CNC code still reaches the public bundle
// only as lazy chunks behind `await import()` (simStore, engravePreviewStore, engraveRunStore,
// SimPanel), so a visit without the switch downloads none of it. `scripts/check-sim-gate.mjs`
// holds that line: the entry chunk carries no simulation code, and the lazy chunk exists.
//
// `canDriveMachine` (capabilities.ts) is NOT part of this: a browser cannot open a socket to the
// controller whatever the address says, and that gate stays compile-time.

/** The query key, matched case-insensitively (`BETA`, `beta`). The value must be `yes`. */
export const BETA_PARAM = 'BETA';

/** True when `search` (a `location.search`) carries `BETA=yes`. Pure; the page reads it once below. */
export function betaRequested(search: string): boolean {
  for (const [key, value] of new URLSearchParams(search)) {
    if (key.toUpperCase() === BETA_PARAM && value.trim().toLowerCase() === 'yes') return true;
  }
  return false;
}

function pageSearch(): string {
  return typeof location !== 'undefined' && typeof location.search === 'string' ? location.search : '';
}

/**
 * Whether this page shows the CNC UI: the Engrave and Simulate sidebar sections, the Start wizard's
 * door on the welcome screen, 🧰 Manage, the CNC guide, and the stores that load the sim client.
 */
export const featureSim: boolean = __FEATURE_SIM__ || betaRequested(pageSearch());
