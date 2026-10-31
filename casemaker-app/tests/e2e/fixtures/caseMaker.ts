import { test as base, type Page } from '@playwright/test';
import type { CaseMakerTestApi } from '../../../src/testing/windowApi';

declare global {
  interface Window {
    __caseMaker?: CaseMakerTestApi;
  }
}

export interface CaseMakerHandle {
  page: Page;
  ready(): Promise<void>;
  api<T>(fn: (api: CaseMakerTestApi) => T | Promise<T>): Promise<T>;
}

export const test = base.extend<{ cm: CaseMakerHandle }>({
  cm: async ({ page }, use) => {
    const handle: CaseMakerHandle = {
      page,
      async ready() {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 30_000 });
        await page.waitForFunction(() => Boolean(window.__caseMaker?.apiVersion === 1), undefined, {
          timeout: 30_000,
        });
        await page.evaluate(async () => {
          await window.__caseMaker!.waitForIdle();
        });
      },
      async api<T>(fn: (api: CaseMakerTestApi) => T | Promise<T>) {
        return page.evaluate(fn as (api: CaseMakerTestApi) => T | Promise<T>, undefined as never);
      },
    };
    await use(handle);
  },
});

export { expect } from '@playwright/test';

/**
 * #798 — the Cutter group defaults CLOSED. Open it (its summary, or the Job card's `›`) before
 * touching the cutter select or reading the pick rows; the group's own summary carries the
 * one-line verdict while closed.
 */
export async function openCutterGroup(page: Page): Promise<void> {
  const group = page.getByTestId('engrave-group-cutter');
  const open = await group.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!open) await page.getByTestId('engrave-group-cutter-summary').click();
  await page.getByTestId('engrave-tool').waitFor({ state: 'visible' });
}
