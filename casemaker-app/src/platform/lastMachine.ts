/**
 * #1106 — THE MACHINE LAST USED, remembered across sessions so step 1 opens with it first and
 * selected. App-local UI state, not a shop setting: it never feeds a plan, so it lives in the
 * window's own storage rather than the settings document (and its server writers).
 */
const KEY = 'casemaker.lastMachineId';

export function readLastMachineId(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeLastMachineId(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // A storage-less window simply has no memory; it is not an error the operator must see.
  }
}
