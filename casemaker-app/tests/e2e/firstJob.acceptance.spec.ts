// #692 — THE ACCEPTANCE WALK (§6 of docs/design/first-job-flow.md), end to end.
//
// From the door to a generated, verified, simulated engraving of the operator's own text, with no
// default changed: Start a cutting job → Continue without a machine → type the stock → Holding →
// Engrave text "Zoomba" → Create → Generate (the four ticks) → Cut (the four lines). The spec
// counts its own operator clicks (line 1: eight or fewer) and writes every screen's innerText and
// a screenshot under test-results/firstJob-acceptance for the mockup comparison (line 4).
//
// Lines 2–3 are asserted FROM THE TRANSCRIPTS and the live DOM: one step counter per screen; no
// issue numbers, code tokens, internal ids or preflight owner tags; cutter names in the display
// form only; a unit beside every numeric field; no decimal past three places; every disabled
// control carries a reason sentence.
//
// The checks #690 owned — Cut step 1's scope keys ("Setup 1 · cat:…") and owner tags ("job" /
// "vise" / "run gate"), and the panel's stock fields that print no unit — pass now that #690 has
// landed: the marks were removed in that commit, and these are ordinary assertions.

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(300_000);

const OUT = path.join(process.cwd(), 'test-results', 'firstJob-acceptance');

interface DisabledFact {
  testid: string | null;
  text: string;
  title: string | null;
  reason: string | null;
}

interface FieldFact {
  testid: string | null;
  value: string;
  near: string;
}

interface Screen {
  name: string;
  text: string;
  disabled: DisabledFact[];
  fields: FieldFact[];
  /** The Cut findings' owner tags (#690) — counted from the DOM, not the transcript. */
  ownerTags: number;
  /** The four Cut step lines (`engrave-cut-step-N-summary`), the Cut screen's own counter. */
  cutLines: number;
}

let screens: Screen[] = [];
let clicks = 0;

/** Capture one screen's transcript, its live DOM facts, and a full-page screenshot. */
async function capture(page: Page, name: string): Promise<void> {
  const text = await page.locator('body').innerText();
  const facts = await page.evaluate(() => {
    // Only what a person can see: a closed fold's inputs are in the DOM but not on the screen.
    const visible = (el: Element): boolean => (el as HTMLElement).getClientRects().length > 0;
    const scopeOf = (el: Element): Element =>
      el.closest('section, [role="dialog"], details, form') ?? document.body;
    const disabled = [
      ...document.querySelectorAll<HTMLElement>('button:disabled, input:disabled, select:disabled, textarea:disabled'),
    ]
      .filter(visible)
      .map((el) => {
        const scope = scopeOf(el);
        const reason = [...scope.querySelectorAll<HTMLElement>('[data-testid]')]
          .filter((n) => /-(blocked|unblock|why|reason|error)$/.test(n.dataset.testid ?? ''))
          .find((n) => (n.textContent ?? '').trim().length > 0);
        return {
          testid: el.dataset.testid ?? null,
          text: (el.textContent ?? '').trim(),
          title: el.getAttribute('title'),
          reason: reason === undefined ? null : (reason.textContent ?? '').trim(),
        };
      });
    const fields = [...document.querySelectorAll<HTMLInputElement>('input')]
      .filter(visible)
      // The numeric FIELDS; a range input is a scrubber, not a quantity with a unit.
      .filter((input) => input.type === 'number')
      .map((input) => {
        const label = input.closest('label');
        const near = [
          label?.textContent ?? '',
          input.getAttribute('aria-label') ?? '',
          input.getAttribute('title') ?? '',
        ]
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        return { testid: input.dataset.testid ?? null, value: input.value, near };
      });
    return {
      disabled,
      fields,
      ownerTags: [...document.querySelectorAll('[data-testid^="engrave-preflight-owner-"]')].filter(visible).length,
      cutLines: [...document.querySelectorAll('[data-testid^="engrave-cut-step-"][data-testid$="-summary"]')].filter(visible).length,
    };
  });
  screens.push({ name, text, ...facts });
  fs.mkdirSync(OUT, { recursive: true });
  const stem = `${String(screens.length).padStart(2, '0')}-${name}`;
  fs.writeFileSync(path.join(OUT, `${stem}.txt`), `${text}\n`, 'utf8');
  await page.screenshot({ path: path.join(OUT, `${stem}.png`), fullPage: true });
}

/** One counted operator click. Typing into a field is not a click. */
async function tap(page: Page, testid: string): Promise<void> {
  clicks += 1;
  await page.getByTestId(testid).click();
}

test.describe('first job acceptance (§6)', () => {
  test.describe.configure({ mode: 'serial' });

  test('the walk: door → typed stock → Zoomba → Generate → Cut, in eight clicks or fewer', async ({ cm, page }) => {
    screens = [];
    clicks = 0;
    await cm.ready();
    await expect(page.getByTestId('welcome-overlay')).toBeVisible();
    await capture(page, 'door');

    // The door. "Start a cutting job" is the operator's own stock route; the starters are the
    // shortcut tested by startWizard.spec.ts, and this walk is the full four-step one.
    await tap(page, 'welcome-start-cnc');
    await expect(page.getByTestId('start-wizard')).toBeVisible();
    await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 1 of 4 · Machine');
    // The web build cannot drive a machine; the button says so and does not gate the job.
    await expect(page.getByTestId('start-wizard-next')).toHaveText('Continue without a machine');
    await capture(page, 'wizard-1-machine');
    await tap(page, 'start-wizard-next');

    // The operator's own stock, typed. No default is changed; the three size fields are the answer.
    await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · Stock');
    await page.getByTestId('start-wizard-make-length').fill('76.2');
    await page.getByTestId('start-wizard-make-width').fill('38.1');
    await page.getByTestId('start-wizard-make-thickness').fill('3.81');
    await expect(page.getByTestId('start-wizard-stock-next')).toBeEnabled();
    await capture(page, 'wizard-2-stock');
    await tap(page, 'start-wizard-stock-next');

    await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Holding');
    await capture(page, 'wizard-3-holding');
    await tap(page, 'engrave-setup-next');

    await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · What are you cutting?');
    await tap(page, 'engrave-setup-what-engrave');
    await page.getByTestId('start-wizard-op-text').fill('Zoomba');
    await capture(page, 'wizard-4-operation');
    await expect(page.getByTestId('start-wizard-create')).toBeEnabled();
    await tap(page, 'start-wizard-create');
    await expect(page.getByTestId('start-wizard')).toHaveCount(0);
    await expect(page.getByTestId('engrave-panel')).toBeVisible();
    await capture(page, 'engrave-panel');

    // Generate: four ticks, each its own state. The oracle is the last to land.
    await tap(page, 'engrave-generate');
    for (const id of ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle']) {
      await expect(page.getByTestId(id), id).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
    }
    await capture(page, 'engrave-panel-generated');

    // Cut: the four lines, with the plan's facts.
    await tap(page, 'cnc-mode-cut');
    await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
    await capture(page, 'cut');

    // Line 1: eight operator clicks or fewer from the door to the Cut surface, and the count is
    // this test's own — no setup click is hidden from it.
    fs.writeFileSync(
      path.join(OUT, 'summary.txt'),
      `clicks: ${clicks}\nscreens: ${screens.map((s) => s.name).join(', ')}\n`,
      'utf8',
    );
    // The field/control facts behind the §6 line 3 checks, for the hand-off and the mockup compare.
    fs.writeFileSync(
      path.join(OUT, 'facts.json'),
      JSON.stringify(
        screens.map((s) => ({ name: s.name, fields: s.fields, disabled: s.disabled, ownerTags: s.ownerTags, cutLines: s.cutLines })),
        null,
        2,
      ),
      'utf8',
    );
    expect(clicks, 'operator clicks from the door to the Cut surface').toBeLessThanOrEqual(8);
  });

  test('one step counter on every screen', () => {
    for (const screen of screens) {
      const wizardCounters = screen.text.match(/Step \d of 4/g) ?? [];
      if (screen.name.startsWith('wizard-')) {
        expect(wizardCounters.length, `${screen.name}: the one wizard counter`).toBe(1);
      } else {
        expect(wizardCounters.length, `${screen.name}: no wizard counter`).toBe(0);
      }
      if (screen.name === 'cut') {
        expect(screen.cutLines, 'the four Cut lines are the Cut counter').toBe(4);
      } else {
        expect(screen.cutLines, `${screen.name}: no Cut lines`).toBe(0);
      }
    }
  });

  test('no issue numbers, code tokens, internal ids or preflight owner tags', () => {
    // #690b — the developer words the issue names are not operator text either: the app's own
    // implementation nouns ("the engine", "the package", "the release flow") describe how it is
    // built, not what the person at the machine is doing. Whole words, case-insensitive.
    const DEV = /\b(?:the engine|the package|the release flow|manual upload|reference unit)\b/gi;
    const CODE =
      /#\d+|\b(?:cat|inv|bp|fx):|\blbl-|\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:default|refused)\b|\b(?:flat|ball|bull|chamfer|engraver|drill|thread)-\d[\w.]*/g;
    const problems: string[] = [];
    for (const screen of screens) {
      for (const match of screen.text.matchAll(CODE)) problems.push(`${screen.name}: ${match[0]}`);
      for (const match of screen.text.matchAll(DEV)) problems.push(`${screen.name}: “${match[0]}” is a developer word`);
      if (screen.ownerTags > 0) problems.push(`${screen.name}: ${screen.ownerTags} preflight owner tag(s)`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('cutter names use the display form, never a vendor label', () => {
    const VENDOR = /\bC\d+-BIT\b|\b\d+(?:\.\d+)?(?:\*\d+(?:\.\d+)?){1,3}\s*mm\b|\bFlat End\s*\(|\bMetal\)/;
    for (const screen of screens) {
      const hit = screen.text.match(VENDOR);
      expect(hit?.[0] ?? null, `${screen.name}: ${hit?.[0] ?? ''}`).toBeNull();
    }
  });

  test('a unit sits beside every numeric field', () => {
    // `s` alone is not a unit token: it would match the possessive in "the blank’s". A seconds
    // field says "sec"/"second(s)", or a number beside an `s`.
    const UNIT = /mm|°|degrees?\b|rpm|%|\bmin\b|\bsec(?:ond)?s?\b|\d\s*s\b/i;
    const problems: string[] = [];
    for (const screen of screens) {
      for (const field of screen.fields) {
        if (!UNIT.test(field.near)) problems.push(`${screen.name}: ${field.testid ?? field.value} — “${field.near}”`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('no number is written past three decimal places', () => {
    const OVER = /\d+\.\d{4,}/;
    for (const screen of screens) {
      const hit = screen.text.match(OVER);
      expect(hit?.[0] ?? null, `${screen.name}: ${hit?.[0] ?? ''}`).toBeNull();
    }
  });

  test('every disabled control carries its reason sentence', () => {
    for (const screen of screens) {
      for (const control of screen.disabled) {
        const reason = (control.reason ?? control.title ?? '').trim();
        expect(reason.length, `${screen.name}: disabled ${control.testid ?? control.text}`).toBeGreaterThan(0);
      }
    }
  });
});
