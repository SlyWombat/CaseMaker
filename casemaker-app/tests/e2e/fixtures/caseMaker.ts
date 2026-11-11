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
        // #1181 — NO `networkidle`. It waits on every connection, and a cold Vite transform graph
        // under four workers can keep them open past its 30 s timeout: three bedDefects725 tests
        // failed exactly this way on a first parallel run and passed on the immediate rerun. The
        // app's own ready signal is the next line (the test API exists), and `waitForIdle` below
        // drains its work; neither needs the network to fall silent.
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
 * #1100 — THE QUESTION STEP OPENS ON THE EIGHT PRESET CARDS. A flow that wants one of the sixteen
 * engine chips opens *Something else…* first; a text job starts on the sign card, whose text field
 * is `start-wizard-preset-text`. A ROTARY job keeps its rotary picker and needs neither.
 */
export async function openSomethingElse(page: Page): Promise<void> {
  await page.getByTestId('start-wizard-preset-something-else').click();
}

/** #1100 — the sign card, for a flow that types a line of text. */
export async function openSignCard(page: Page): Promise<void> {
  await page.getByTestId('start-wizard-preset-sign').click();
}

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

/**
 * #1123-59 — ENTER THE CNC WORKSPACE (the Job panel) the way the door does. A board case's design
 * rail has no Job entry any more, and a walk that loads the placeholder board project to get a CNC
 * job open used to click it; it opens the section through the app's own setter instead.
 */
export async function enterCnc(page: Page, section: 'cnc-engrave' | 'cnc-sim' = 'cnc-engrave'): Promise<void> {
  await page.evaluate((id) => window.__caseMaker!.openSidebarSection(id), section);
}
