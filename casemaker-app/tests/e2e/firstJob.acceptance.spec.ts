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
//
// #726's audit forms are asserted from the same captures, as rules rather than one-off sentences:
// the rail and the panel title name the JOB (the Design · Cut switch inside keeps the mode word);
// a row's measurements state mm / ° in their own labels; the time is never also called
// "estimated"; no sentence ends with two full stops; Close and Cancel never share a screen; a row
// never shows the exported "Pocket rect"; a unit is never glued to its number ("inset 0mm"); a Cut
// step title never wraps; a PLA blank offers no Facing line. A second walk creates a ROD job on
// the same real renders and proves the Voids and Target object rows are not offered for it.

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

interface RowFieldFact {
  testid: string | null;
  value: string;
  /** The visible `<label>`'s own text: "capmm", "rot°" — the row's word and its unit. */
  labelText: string;
}

interface StepTitleFact {
  text: string;
  whiteSpace: string;
  /** Line boxes the title's text occupies; 2 or more means it wrapped (#726 P16). */
  lines: number;
  height: number;
  lineHeight: number;
}

interface Screen {
  name: string;
  text: string;
  disabled: DisabledFact[];
  fields: FieldFact[];
  /** The rail's own entries and the context panel's section title (#726 P1). */
  railLabels: string[];
  panelTitles: string[];
  /** Every visible button's accessible name — the Close/Cancel pair is read from these. */
  controls: string[];
  /** Number inputs inside an engrave row, with the text of their own label (#726 P6). */
  rowFields: RowFieldFact[];
  /** The Cut step titles as rendered (#726 P16). */
  stepTitles: StepTitleFact[];
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
    // #726 P1 — the rail entries and the context panel's title are their own facts: the Design ·
    // Cut switch inside the panel may keep the mode word, these two may only name the job.
    const railLabels = [...document.querySelectorAll<HTMLElement>('[data-testid^="sidebar-button-"]')]
      .filter(visible)
      .map((el) => (el.textContent ?? '').trim())
      .filter((label) => label.length > 0);
    // The section header's own h3 — not every group heading inside the panel ("Cutting" is a
    // group, not a title).
    const panelTitles = [...document.querySelectorAll<HTMLElement>('[data-testid^="context-section-"] > div > h3')]
      .filter(visible)
      .map((el) => (el.textContent ?? '').trim())
      .filter((title) => title.length > 0);
    // The Close/Cancel pair is read from the controls themselves, by their accessible name.
    const controls = [...document.querySelectorAll<HTMLElement>('button')]
      .filter(visible)
      .map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim())
      .filter((name) => name.length > 0);
    // #726 P6 — a row's number field states its unit in the row's OWN label ("capmm", "rot°"),
    // not only in the hint: the audit found the label bare beside the input.
    const rowOf = (el: Element): Element | null => {
      for (let n = el.parentElement; n !== null; n = n.parentElement) {
        if (/-row-\d+$/.test((n as HTMLElement).dataset.testid ?? '')) return n;
      }
      return null;
    };
    const rowFields = [...document.querySelectorAll<HTMLInputElement>('input')]
      .filter(visible)
      .filter((input) => input.type === 'number' && rowOf(input) !== null)
      .map((input) => ({
        testid: input.dataset.testid ?? null,
        value: input.value,
        labelText: (input.closest('label')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }));
    // #726 P16 — a step's number and title stay on one line. Measured, not read from the source:
    // the title's text is put in a Range and its line boxes are counted.
    const stepTitles = [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="engrave-cut-step-"][data-testid$="-title"]'),
    ]
      .filter(visible)
      .map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        const style = getComputedStyle(el);
        return {
          text: (el.textContent ?? '').trim(),
          whiteSpace: style.whiteSpace,
          lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
          height: el.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      });
    return {
      disabled,
      fields,
      railLabels,
      panelTitles,
      controls,
      rowFields,
      stepTitles,
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
    // #745 — typing is the operation here; its terminal state is Create being offered. The capture
    // waits for that state, never scanning the beat between the field's commit and the footer's.
    await expect(page.getByTestId('start-wizard-create')).toBeEnabled();
    await capture(page, 'wizard-4-operation');
    await tap(page, 'start-wizard-create');
    await expect(page.getByTestId('start-wizard')).toHaveCount(0);
    await expect(page.getByTestId('engrave-panel')).toBeVisible();
    // #745 — the panel settles before the screen is scanned: Generate is the next action, so the
    // capture waits for it to be offered rather than reading a panel still being built.
    await expect(page.getByTestId('engrave-generate')).toBeEnabled();
    await capture(page, 'engrave-panel');

    // Generate: four ticks, each its own state. The oracle is the last to land.
    await tap(page, 'engrave-generate');
    for (const id of ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle']) {
      await expect(page.getByTestId(id), id).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
    }
    // #745 — the run's terminal state, in the button's own word: "Working…" is a run still in
    // flight, and a capture must never scan that. #794 — the terminal word is now the NEXT step:
    // "Cut…" replacing Generate once the program is ready and still matches the job.
    await expect(page.getByTestId('engrave-generate')).toHaveText('Cut…');
    await capture(page, 'engrave-panel-generated');

    // Cut: the four lines, with the plan's facts.
    await tap(page, 'cnc-mode-cut');
    await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
    // #745 — the surface freezes the package on mount; wait for the freeze to land before scanning.
    await expect(page.getByTestId('engrave-package')).toHaveAttribute('data-state', 'current');
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
        screens.map((s) => ({
          name: s.name,
          fields: s.fields,
          disabled: s.disabled,
          ownerTags: s.ownerTags,
          cutLines: s.cutLines,
          railLabels: s.railLabels,
          panelTitles: s.panelTitles,
          controls: s.controls,
          rowFields: s.rowFields,
          stepTitles: s.stepTitles,
        })),
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

  test('the rail entry and the panel title name the job, never the mode', () => {
    // #726 P1 — "Cut" is the mode (the Design · Cut switch inside the panel keeps the word); the
    // rail entry and the panel title are the JOB. Read from the rendered entries, not the copy.
    expect(screens.some((screen) => screen.railLabels.length > 0), 'the rail was captured').toBe(true);
    expect(screens.some((screen) => screen.panelTitles.length > 0), 'a panel title was captured').toBe(true);
    const problems: string[] = [];
    for (const screen of screens) {
      for (const label of [...screen.railLabels, ...screen.panelTitles]) {
        if (/\bCut\b/.test(label)) problems.push(`${screen.name}: “${label}”`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('a row measurement says mm or ° in its own label', () => {
    // #726 P6 — the defect was a bare number beside its row label ("cap [6]", "rot [0]"). The
    // general rule, over whatever rows the walk has open: every number input inside a row panel
    // ends its visible label with mm or °. Counts are not lengths and no count row is open here.
    expect(
      screens.reduce((count, screen) => count + screen.rowFields.length, 0),
      'a row’s number field was captured',
    ).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const screen of screens) {
      for (const field of screen.rowFields) {
        if (!/(?:mm|°)$/.test(field.labelText)) {
          problems.push(`${screen.name}: ${field.testid ?? field.value} — “${field.labelText}”`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('a time is not also called estimated, and a sentence gets one full stop', () => {
    // #726 P7 — the time says "about …" once; "(estimated)" was the second stop. The doubled
    // full stop is the same class: a helper adding a stop to a sentence that already had one.
    for (const screen of screens) {
      expect(screen.text, `${screen.name}: “estimated”`).not.toMatch(/estimated/i);
      const doubleStop = screen.text.match(/\.\s*\./);
      expect(doubleStop?.[0] ?? null, `${screen.name}: “${doubleStop?.[0] ?? ''}”`).toBeNull();
    }
  });

  test('Close and Cancel never share a screen', () => {
    // #726 P10 — step 1 offered both the header's Close and a footer Cancel: two controls, one
    // action. Read from the visible buttons' accessible names.
    expect(screens.some((screen) => screen.controls.length > 0), 'a control was captured').toBe(true);
    for (const screen of screens) {
      const close = screen.controls.filter((name) => /^close\b/i.test(name));
      const cancel = screen.controls.filter((name) => /^cancel\b/i.test(name));
      expect(
        close.length === 0 || cancel.length === 0,
        `${screen.name}: ${close.join(' / ')} beside ${cancel.join(' / ')}`,
      ).toBe(true);
    }
  });

  test('a row never shows the exported operation name “Pocket rect”', () => {
    // #726 P13 — the exported name is frozen (the verified bench programs carry it); the row's
    // display name is the plain one. No row on this walk may print the exported form.
    for (const screen of screens) {
      expect(screen.text, `${screen.name}: Pocket rect`).not.toContain('Pocket rect');
    }
  });

  test('a unit is never glued to its number', () => {
    // #726 P13 — "stock inset 0mm" was the defect; "0 mm" is the form. The welcome door quotes
    // vendor copy (“3.5mm terminal block”) from the sample cards, which is not the job's wording,
    // so the scan is the job's own screens: the panel before and after Generate, and Cut.
    const JOB = new Set(['engrave-panel', 'engrave-panel-generated', 'cut']);
    expect(
      screens.filter((screen) => JOB.has(screen.name)).length,
      'the job’s three screens were captured',
    ).toBe(3);
    const problems: string[] = [];
    for (const screen of screens) {
      if (!JOB.has(screen.name)) continue;
      for (const match of screen.text.matchAll(/\d(?:mm|°)/g)) problems.push(`${screen.name}: ${match[0]}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('a Cut step title stays on one line', () => {
    // #726 P16 — the step's number and title are nowrap and cannot be shrunk by the summary. This
    // is measured on the rendered title: its text's line boxes, and the style the rule sets.
    const cut = screens.find((screen) => screen.name === 'cut');
    expect(cut, 'the Cut screen was captured').toBeDefined();
    expect(cut!.stepTitles.length, 'the four Cut step titles').toBe(4);
    for (const title of cut!.stepTitles) {
      expect(title.whiteSpace, `${title.text}: white-space`).toBe('nowrap');
      expect(title.lines, `${title.text}: line boxes`).toBe(1);
      if (Number.isFinite(title.lineHeight)) {
        expect(title.height, `${title.text}: one line tall`).toBeLessThanOrEqual(title.lineHeight * 1.5);
      }
    }
  });

  test('a PLA blank offers no Facing line', () => {
    // #726 P2 — Facing is "one line only on wood/metal". The walk's stock line names PLA, so on
    // every screen that shows THIS job's stock the Facing section must not be offered at all.
    // (A job that somehow already had facing on keeps its line to turn it off; this one has none.)
    expect(
      screens.some((screen) => screen.text.includes('· PLA')),
      'a screen shows the PLA stock line',
    ).toBe(true);
    const problems: string[] = [];
    for (const screen of screens) {
      if (!screen.text.includes('· PLA')) continue;
      for (const match of screen.text.matchAll(/\bFacing\b/g)) problems.push(`${screen.name}: “${match[0]}” on PLA`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('a rod job draws no Voids and no Target object (#726 P3)', async ({ cm, page }) => {
    // The walk above is a plate. A ROUND job (a rod in the chuck's box) has no flat bottom face to
    // pocket and no bed to surface a mesh on, so neither row is offered. This second walk reaches
    // that state on the same real renders: a short rod stands in the vise (the web build cannot
    // describe a machine, so the rotary is not on offer), and the panel's stock line proves the
    // job is the round one before the two absences are asserted.
    screens = [];
    clicks = 0;
    await cm.ready();
    await expect(page.getByTestId('welcome-overlay')).toBeVisible();
    await page.getByTestId('welcome-start-cnc').click();
    await expect(page.getByTestId('start-wizard')).toBeVisible();
    await page.getByTestId('start-wizard-next').click();
    await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · Stock');
    await page.getByTestId('start-wizard-form-rod').click();
    await page.getByTestId('start-wizard-make-diameter').fill('10');
    await page.getByTestId('start-wizard-make-length').fill('15');
    await expect(page.getByTestId('start-wizard-stock-next')).toBeEnabled();
    await page.getByTestId('start-wizard-stock-next').click();
    await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Holding');
    await expect(page.getByTestId('engrave-setup-next')).toBeEnabled();
    await page.getByTestId('engrave-setup-next').click();
    await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · What are you cutting?');
    await page.getByTestId('engrave-setup-what-engrave').click();
    await page.getByTestId('start-wizard-op-text').fill('Zoomba');
    await expect(page.getByTestId('start-wizard-create')).toBeEnabled();
    await page.getByTestId('start-wizard-create').click();
    await expect(page.getByTestId('start-wizard')).toHaveCount(0);
    await expect(page.getByTestId('engrave-panel')).toBeVisible();
    await expect(page.getByTestId('engrave-stock-line')).toContainText('Stock · rod');
    await expect(page.getByTestId('engrave-voids-line'), 'no Voids on a rod').toHaveCount(0);
    await expect(page.getByTestId('engrave-target-import'), 'no Reference object on a rod').toHaveCount(0);
  });
});
