/**
 * #1202 field 4 — A FIRST RUN IS NOT A REMOTE ACT.
 *
 * The 2026-11-10 seat press was "headless" in the sense that matters: the analyst ran the real
 * published app under headless Chromium, with nobody at the machine, and a motion routine that had
 * never moved that controller started and bent the probe. The Manager's ruling (2026-11-11): an app
 * instance UNDER AUTOMATION (`navigator.webdriver`) whose target is a REAL controller may not start
 * a first-run routine — it is refused with that reason. The FAKE console (the e2e's own machine) is
 * allowed, so the acceptance's first press still shows the mark and takes the statement.
 *
 * The fake/test instance is recognised by the app's own test surface (`__caseMaker.isTestMode()`),
 * which only a harness installs; a published build driven by automation has it absent and therefore
 * refuses. This is a REFUSAL helper: callers ask it before starting; nothing here talks to a machine.
 */

/** Whether this page is driven by automation (headless Chromium/WebDriver sets `navigator.webdriver`). */
export function underAutomation(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}

/** Whether a harness installed the app's test surface (the fake console lives only there). */
export function appUnderTest(): boolean {
  const api = (globalThis as { __caseMaker?: { isTestMode?: () => boolean } }).__caseMaker;
  try {
    return api?.isTestMode?.() === true;
  } catch {
    return false;
  }
}

/**
 * The refusal for starting a FIRST-RUN routine from an automated instance against a real
 * controller, in the words the card shows; null when the press may proceed (not a first run, not
 * automated, or the app is a test harness with the fake machine).
 */
export function firstRunAutomationRefusal(input: { firstRun: boolean; testMode?: boolean }): string | null {
  if (!input.firstRun) return null;
  if (!underAutomation()) return null;
  if (input.testMode ?? appUnderTest()) return null;
  return (
    'This measurement has not run on this machine before, and this app is being driven automatically ' +
    '— a routine’s first run has to be started by a person at the machine.'
  );
}
