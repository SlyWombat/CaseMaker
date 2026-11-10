/**
 * #1123-48 — "IS THERE WORK TO CONTINUE?", remembered per browser.
 *
 * Going Home must never discard anything: the open project and CNC job stay in their stores, and
 * the main page gains a Continue row back to exactly where the operator was. This module is the one
 * marker of "something has been worked on" that survives the trip to the main page AND a reload
 * (the project and job stores persist across both, but neither carries a session marker).
 *
 * It is display state, like the sidebar's collapse: localStorage only, never the job, the fingerprint
 * or a package. Starting a NEW project clears it; Home never does.
 */
const KEY = 'casemaker.workedOn';

export function markWorkedOn(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Private mode or a full quota: Continue simply does not appear after a reload.
  }
}

export function hasWorkedOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function clearWorkedOn(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
