/**
 * A RED ON THE ENGRAVE RUN ROWS MUST DIAGNOSE ITSELF (the Manager's ask, 2026-11-07).
 *
 * eb's flipMouldShell cross on 72fd1e329 arrived with only the row's state ("cross") and its
 * sentence ("the simulation did not pass"): the run's findings, the state behind them and the
 * flight-recorder crumbs were gone by the time anyone looked — the failing assertion ran before
 * the spec read them, and Playwright's own artifacts do not include app state. The focused re-run
 * would have needed `--trace on`, a scarce slot and a manual read.
 *
 * This hook attaches, on ANY failure (the helper no-ops on a pass): the engrave run state
 * (`getEngraveRunState` — sim status, programs, findings-bearing fields), every
 * `engrave-finding-*` line, every `engrave-run-*` row with its state and label, and the last 150
 * flight-recorder crumbs from the same IndexedDB store the crash report reads.
 *
 * TEST-ONLY: it reads the page and writes a test attachment; it never touches the app.
 */
import { writeFileSync } from 'node:fs';

import type { Page, TestInfo } from '@playwright/test';

/**
 * Attach the run diagnostics to the test when it failed. Call from an `afterEach` (the page is
 * still alive there); a passing case attaches nothing.
 */
export async function attachEngraveRunDiagnostics(page: Page, testInfo: TestInfo): Promise<void> {
  // Only a RED earns the appendix: a pass met its expectation, and a skip is not a failure.
  if (testInfo.status === testInfo.expectedStatus) return;
  if (testInfo.status !== 'failed' && testInfo.status !== 'timedOut') return;
  if (page.isClosed()) return;
  let capture: unknown;
  try {
    capture = await page.evaluate(async () => {
      const api = (globalThis as { __caseMaker?: { getEngraveRunState?: () => unknown } }).__caseMaker;
      let runState: unknown = null;
      try {
        runState = api?.getEngraveRunState?.() ?? null;
      } catch (error) {
        runState = { error: String(error) };
      }
      const findings = [...document.querySelectorAll<HTMLElement>('[data-testid^="engrave-finding-"]')].map((el) => ({
        testId: el.dataset['testid'] ?? null,
        code: el.dataset['code'] ?? null,
        text: el.textContent,
      }));
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="engrave-run-"]')].map((el) => ({
        testId: el.dataset['testid'] ?? null,
        state: el.dataset['state'] ?? null,
        text: el.textContent,
      }));
      let crumbs: unknown;
      try {
        // Literals inlined: `page.evaluate` serialises this callback — module scope is not in the page.
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('casemaker-flight-recorder', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stored = await new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction('recorder', 'readonly');
          const get = tx.objectStore('recorder').get('crumbs');
          get.onsuccess = () => resolve(get.result ?? []);
          get.onerror = () => reject(get.error);
        });
        db.close();
        crumbs = Array.isArray(stored) ? (stored as unknown[]).slice(-150) : stored;
      } catch (error) {
        crumbs = { error: String(error) };
      }
      return { url: location.href, runState, findings, rows, crumbs };
    });
  } catch (error) {
    capture = { captureError: String(error) };
  }
  try {
    const text = JSON.stringify(capture, null, 1);
    // Both halves: a readable file in the test's own output directory (a line-reporter run leaves
    // it on disk) and the report attachment (the JSON report embeds it, which is what eb archives).
    writeFileSync(testInfo.outputPath('engrave-run-diagnostics.json'), text);
    await testInfo.attach('engrave-run-diagnostics', { body: text, contentType: 'application/json' });
  } catch {
    // A closed context or a torn-down page: nothing to attach, and a failing case keeps its own
    // failure rather than a second one from the appendix.
  }
}
