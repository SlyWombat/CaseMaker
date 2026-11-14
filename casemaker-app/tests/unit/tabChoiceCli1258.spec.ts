/**
 * #1258 — THE REAL PATH, END TO END: `casemaker cut` on a goal job whose freeing contour cannot meet
 * both tab rules, through the measured pick and `engraveGenerate`.
 *
 *   - no flag    → the run STOPS with `tab-choice-needed` and the question's sentence — never
 *                  `invalid-job` ("no plan the search tried can post"), which is what the pick used
 *                  to turn the question into;
 *   - each flag  → programs are posted and the run sheet carries the tab sentences.
 *
 * The block is a 27 × 10 × 10 body (walls drafted 1 mm) on a 60 × 40 blank with the shop's span limit at 10 mm: its four
 * edges each hold one tab and the stretches between them stay over the limit (no tab fits in them).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import type { Receipt } from '../../src/platform/headless/receipt';
import { blockJob, blockLocation, SETB } from './helpers/tabChoiceBlock1258';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-tab-choice-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Run {
  code: number;
  receipt: Receipt;
  outDir: string;
  progress: string[];
  /** The `--generated` document (the house path), or null when none was written. */
  generated: Record<string, unknown> | null;
}

async function cut(name: string, flag: string[]): Promise<Run> {
  const outDir = join(SCRATCH, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  const generatedPath = join(outDir, 'generated.json');
  writeFileSync(jobPath, JSON.stringify(blockJob(), null, 2) + '\n');
  let receipt: Receipt | null = null;
  const progress: string[] = [];
  const options: CommandOptions = { json: true, now: NOW, sink: { progress: (line) => progress.push(line), receipt: (r) => { receipt = r; } } };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', blockLocation(SCRATCH), '--catalogue', join(SETB, 'catalogue.json'), '--generated', generatedPath, ...flag], options);
  const generated = existsSync(generatedPath) ? (JSON.parse(readFileSync(generatedPath, 'utf8')) as Record<string, unknown>) : null;
  return { code, receipt: receipt!, outDir, progress, generated };
}

const sheetText = (outDir: string): string =>
  readdirSync(outDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(join(outDir, f), 'utf8'))
    .join('\n');

describe('#1258 casemaker cut, flag to planner', () => {
  it('no flag: stops with tab-choice-needed and the question — not invalid-job', async () => {
    const run = await cut('ask', []);
    expect(run.code).not.toBe(0);
    const codes = run.receipt.refusals.map((r) => r.code);
    expect(codes).toContain('tab-choice-needed');
    expect(codes).not.toContain('invalid-job');
    const reason = run.receipt.refusals.find((r) => r.code === 'tab-choice-needed')!.reason;
    expect(reason).toContain("This part can't be held within both of the shop's tab rules");
    expect(reason).toContain('--tab-choice inside-margin');
    expect(reason).toContain('--tab-choice longer-stretch');
    // CONDITION 1: the pick measured under a provisional answer — and its plan was NOT handed to the cut.
    const said = run.progress.join('\n');
    expect(said).toContain('the pick ranked the cutters under a provisional tab answer');
    expect(said).not.toContain("the pick's plan reused");
    // THE HOUSE PATH: on a stop the failed generate result is written to `--generated` WITH the
    // structured question, so a house-backed run can draw the card.
    expect(run.generated).not.toBeNull();
    const asked = run.generated as { ok: boolean; stage: string; programs?: unknown[]; tabChoiceNeeded?: { fingerprint: string; stretches: unknown[]; setups: unknown[] } };
    expect(asked.ok).toBe(false);
    expect(asked.tabChoiceNeeded?.stretches.length).toBeGreaterThan(0);
    expect(asked.tabChoiceNeeded?.setups.length).toBeGreaterThan(0);
    expect(asked.tabChoiceNeeded?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // #1126 — the SAME trimmed document a finished run writes: v2, no files (none were written), and
    // the plan is the allowlisted summary — the question rides it through `tabChoiceNeeded`, and no
    // plan internals (setups' IR, sampled surfaces) are on disk.
    const doc = run.generated as { resultVersion?: number; files?: unknown[]; plan?: { tabChoiceNeeded?: unknown; perSetup: Record<string, unknown>[] } };
    expect(doc.resultVersion).toBe(2);
    expect(doc.files).toEqual([]);
    expect(doc.plan?.tabChoiceNeeded).toBeDefined();
    for (const setup of doc.plan?.perSetup ?? []) expect(Object.keys(setup).sort()).toEqual(['notes', 'ops', 'setupIndex']);
  }, 300_000);

  for (const [flag, sentence] of [
    ['inside-margin', /of the outline has no tab and no tab fits there; the shop's limit is 10 mm\./],
    ['longer-stretch', /of the outline has no tab; the shop's limit is 10 mm — the operator's choice\./],
  ] as const) {
    it(`--tab-choice ${flag}: programs are posted and the sheet says what was done`, async () => {
      const run = await cut(flag, ['--tab-choice', flag]);
      expect(run.receipt.refusals.map((r) => r.code), JSON.stringify(run.receipt.refusals)).toEqual([]);
      expect(run.code).toBe(0);
      expect((run.receipt.details as { programs: unknown[] }).programs.length).toBeGreaterThan(0);
      expect(sheetText(run.outDir)).toMatch(sentence);
      // CONDITION 1, the other half: under a real answer the pick's measured plan IS the cut's plan
      // (reused), and nothing was ranked under an assumed one.
      const said = run.progress.join('\n');
      expect(said).toContain("the pick's plan reused");
      expect(said).not.toContain('provisional tab answer');
      // THE HOUSE PATH, answered: the generated document carries the programs and the question the
      // answer was given for (`plan.tabChoiceApplied`), so an answered summary survives a reopen.
      const gen = run.generated as { ok: boolean; programs: unknown[]; plan: { tabChoiceApplied?: { choice: string; stretches: unknown[] } } };
      expect(gen.ok).toBe(true);
      expect(gen.programs.length).toBeGreaterThan(0);
      // #1126 — every posted program carries the re-check's context beside it, computed where the IR exists.
      expect((gen.programs as { verifyContext?: unknown }[]).every((p) => p.verifyContext !== undefined)).toBe(true);
      expect(gen.plan.tabChoiceApplied?.choice).toBe(flag === 'inside-margin' ? 'insideMargin' : 'longerStretch');
      expect(gen.plan.tabChoiceApplied?.stretches.length).toBeGreaterThan(0);
    }, 300_000);
  }
});
