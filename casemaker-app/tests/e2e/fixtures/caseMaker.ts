import { test as base, expect, type Page } from '@playwright/test';
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

/** #1098 — the engrave job as the app's store holds it right now (a copy; read-only). */
export async function readJob(page: Page): Promise<import('../../../src/types/engraveJob').EngraveJob> {
  return page.evaluate(() => window.__caseMaker!.getEngraveJob());
}


/**
 * #1100 — THE QUESTION STEP OPENS ON THE EIGHT PRESET CARDS. A flow that wants one of the sixteen
 * engine chips opens *Something else…* first; a text job starts on the sign card, whose text field
 * is `start-wizard-preset-text`. A ROTARY job keeps its rotary picker and needs neither.
 */
export async function openSomethingElse(page: Page): Promise<void> {
  await page.getByTestId('start-wizard-preset-something-else').click();
}

/**
 * #1263 — THE STOCK STEP'S ASK, ANSWERED THE WAY AN OPERATOR DOES. The app assumes no material, so a
 * walk that reaches Next on the Stock step with the ask still showing first answers it:
 *   - `row`      — the step lists several pieces that hold the work and the shelf has one of the walk's
 *                  material: the walk picks that row;
 *   - `material` — the walk chooses the material (an operator now does);
 *   - `size`     — ONLY when the walk says so (`typeSize`): it types that piece. A walk that did not ask
 *                  for it and still finds the step asking for a size has lost its proposal, and fails.
 * Returns which branch it took (`none` when the step was not asking), so the walks' choices are visible.
 */
export async function answerStockAsk(
  page: Page,
  opts: { material?: string; typeSize?: [number, number, number] } = {},
): Promise<'none' | 'row' | 'material' | 'size'> {
  const material = opts.material ?? 'hardwood';
  const ask = page.getByTestId('start-wizard-stock-ask');
  if ((await ask.count()) === 0) return 'none';
  const sentence = (await page.getByTestId('start-wizard-stock-ask-sentence').textContent()) ?? '';
  // A piece is picked only while NO size is entered: a walk that typed its own size keeps it.
  const sizeMissing = (await page.getByTestId('start-wizard-ask-chip-size').count()) > 0;
  if (sentence.startsWith('Several pieces') && sizeMissing) {
    const rows = page.locator('[data-testid^="start-wizard-shelf-item-"]:not([data-testid$="-reason"]):not([disabled])');
    const mine = rows.filter({ hasText: new RegExp(material, 'i') });
    if ((await mine.count()) > 0) {
      await mine.first().click();
      return 'row';
    }
  }
  const select = page.getByTestId('start-wizard-stock-material');
  if ((await select.inputValue()) === '') await select.selectOption(material);
  if ((await ask.count()) === 0) return 'material';
  if (opts.typeSize === undefined) {
    throw new Error('the Stock step still asks for a size: this walk lost its proposal (pass { typeSize } to type one)');
  }
  const [l, w, t] = opts.typeSize;
  await page.getByTestId('start-wizard-make-length').fill(String(l));
  await page.getByTestId('start-wizard-make-width').fill(String(w));
  await page.getByTestId('start-wizard-make-thickness').fill(String(t));
  return 'size';
}

/** Next on the Stock step, after answering the ask if it is showing; the branch taken is on the test's annotations. */
export async function stockNext(
  page: Page,
  opts: { material?: string; typeSize?: [number, number, number] } = {},
): Promise<void> {
  const branch = await answerStockAsk(page, opts);
  test.info().annotations.push({ type: 'stock-ask', description: branch });
  console.log(`STOCKASK ${test.info().file.split(/[\\/]/).pop()} :: ${test.info().title.slice(0, 60)} :: ${branch}`);
  await page.getByTestId('start-wizard-stock-next').click();
}

/**
 * #1273 — THE ONE WAY A WALK CHOOSES A MOUNT FOR THE OPERATOR WHEN NOTHING IS RECORDED. With no machine
 * recorded the Holding step asks and selects nothing; Create waits. A walk that needs a job anyway
 * chooses a vise seat as its own assumption, here, and this helper REFUSES TO DO IT SILENTLY: the ask
 * must be on the page, the seat one the ask allows and unselected, and Create waiting before the pick;
 * after it the step must say the hold is the operator's assumption. A walk on a recorded machine (a
 * preselected seat) fails here and names the cause, so nothing picks a mount behind the step's back.
 */
export async function pickAssumedMount(page: Page, seat: 'ledge' | 'board' | 'block'): Promise<void> {
  await expect(page.getByTestId('engrave-setup-holding-ask'), 'the Holding step must be asking (nothing recorded)').toBeVisible();
  const radio = page.getByTestId(`engrave-setup-mount-${seat}`);
  await expect(radio, `the ${seat} seat is not one the ask allows for this blank`).toBeEnabled();
  await expect(radio, 'nothing may be selected before the operator chooses').not.toBeChecked();
  await expect(page.getByTestId('engrave-setup-next'), 'Create waits for the choice').toBeDisabled();
  await radio.check();
  await expect(page.getByTestId('engrave-setup-holding-assumed'), 'the choice is carried as the operator’s assumption').toBeVisible();
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
