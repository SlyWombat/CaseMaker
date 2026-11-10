/**
 * #1180 S2 — ONE `rememberMachine`. Seven e2e specs copied the same
 * `window.__caseMaker.setMachine` call with their own status line beside it.
 *
 * The STATUS line stays the CALLER's: the panels read different fields from it (monitor values,
 * `P:`, `S:`), so a shared default would quietly change what a test sees. `busy` is the one
 * argument a caller actually varies.
 */

import type { Page } from '@playwright/test';

export async function rememberMachine(page: Page, status: string, busy = false): Promise<void> {
  await page.evaluate(
    ({ text, isBusy }) => {
      window.__caseMaker!.setMachine(
        {
          name: 'QA Z1',
          host: '192.0.2.10',
          port: 2222,
          busy: isBusy,
          ip: null,
          mac: null,
          status: text,
          profileId: 'Z1',
          observedAt: '2026-10-25T00:00:00.000Z',
          notes: [],
        },
        text,
      );
    },
    { text: status, isBusy: busy },
  );
}
