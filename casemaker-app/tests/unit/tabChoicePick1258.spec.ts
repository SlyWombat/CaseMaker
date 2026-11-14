/**
 * #1258 — THE MEASURED PICK AND THE TAB ANSWER (the analyst's amendment).
 *
 * The pick ranks cutters through `evaluateFull`, which plans each candidate. A candidate's plan
 * raises the tab question; what it is measured under, and whether its plan may become the cut's, is
 * pinned here on the asking block (`helpers/tabChoiceBlock1258.ts`), through `pickForEngrave` and the
 * real `engraveGenerate`:
 *
 *   - NO ANSWER   → ranked under a provisional `insideMargin`; the evaluation is flagged `tabQuestion`
 *                   and its plan WITHHELD; the cut asks (tabChoiceNeeded), never `invalid-job`;
 *   - MATCHING    → the job's saved `longerStretch`, given for this question's fingerprint: measured
 *                   under it, NOT flagged, the plan reused, no step-2 tab anywhere;
 *   - STALE       → a saved answer whose fingerprint is not this question's: the pick still ranks
 *                   (the fingerprint never reaches a candidate), the plan is withheld, and the cut
 *                   answers with the STALE question and no programs — not `invalid-job`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterAll, describe, expect, it } from 'vitest';

import { resolvedFeedsTable, setLocatedFeedTable, type FeedCatalogueRow, type StoredFeedRow } from '@/engine/cnc/feeds';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { getTools, resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import { inventoryConditions } from '@/engine/cnc/toolCondition';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { readDefault, ShopDefaultsSchema } from '@/platform/defaultsClient';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { pickForEngrave } from '@/workers/sim/smartPickRun';
import { engraveGenerate, supportingFloors, type EngraveGenerated, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { EngraveJob } from '@/types/engraveJob';
import { rmSync } from 'node:fs';
import { tl } from './helpers/manifoldExec';
import { blockJob, blockLocation, SETB } from './helpers/tabChoiceBlock1258';

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-tab-pick-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Outcome {
  evaluation: { ok: boolean; tabQuestion?: true; ownedPlan?: { perSetup: { statements: { text: string }[] }[]; tabChoiceApplied?: { choice: string; fingerprint: string } } | null };
  generated: EngraveGenerated;
}

/** The pick (no explicit answer — the app's case), then the cut for the chosen cutter with the job's own answer. */
async function pickThenCut(job: EngraveJob): Promise<Outcome> {
  const loc = JSON.parse(readFileSync(blockLocation(SCRATCH), 'utf8')) as { inventory: { id: string; tool: unknown }[]; feeds: StoredFeedRow[]; defaults: unknown };
  const cat = JSON.parse(readFileSync(join(SETB, 'catalogue.json'), 'utf8')) as { tools: { key: string; tool: unknown; provenance: string }[]; feeds: FeedCatalogueRow[] };
  setRegistry([...cat.tools, ...loc.inventory.map((i) => ({ key: `inv:${i.id}`, tool: i.tool, provenance: 'setb' }))] as never);
  setLocatedFeedTable(loc.feeds);
  try {
    const defaults = ShopDefaultsSchema.parse(loc.defaults);
    const shop: EngraveShopOpts = engraveShopOpts(defaults);
    const pickShop: EngraveShopOpts = {
      tools: getTools(),
      lostDetailWarnRatio: readDefault(defaults, 'engrave.lostDetailWarnRatio').value,
      toolChangeSeconds: readDefault(defaults, 'toolChange.seconds').value,
      drill: drillSettings(defaults),
      feeds: resolvedFeedsTable().table,
      defaults,
    };
    const pick = await pickForEngrave({
      tl,
      job,
      tools: getTools(),
      catalogue: cat.feeds,
      conditions: inventoryConditions(),
      shop: pickShop,
      runShop: shop,
      floors: supportingFloors(tl, toPartPlan(job)),
    });
    if (!('runnable' in pick) || pick.runnable === null) {
      throw new Error(`the pick found nothing that posts — the very failure this pins (${'reason' in pick ? pick.reason : pick.notes.join(' ')})`);
    }
    const chosen = { ...job, toolKey: pick.runnable.plan.cutters[0]!.key } as EngraveJob;
    const tool = jobTool(chosen);
    if (tool === null) throw new Error('the chosen cutter is not in the registry');
    // The app passes the job's saved answer as the generate option (it skips the pick on answering).
    const generated = await engraveGenerate(tl, chosen, tool, cat.feeds, null, undefined, shop, undefined, undefined, {
      ...(job.tabChoice === undefined ? {} : { tabChoice: job.tabChoice }),
    });
    return { evaluation: pick.runnable.evaluation as never, generated };
  } finally {
    resetRegistry();
    setLocatedFeedTable(null);
  }
}

describe('#1258 the pick and the tab answer, through engraveGenerate', () => {
  let fingerprint = '';

  it('no answer: ranked under a provisional answer, its plan withheld, the cut asks — never invalid-job', async () => {
    const out = await pickThenCut(blockJob());
    expect(out.evaluation.ok).toBe(true);
    expect(out.evaluation.tabQuestion).toBe(true);
    expect(out.evaluation.ownedPlan ?? null).toBeNull();
    expect(out.generated.ok).toBe(false);
    expect(out.generated.tabChoiceNeeded).toBeDefined();
    expect(out.generated.tabChoiceStale).toBeUndefined();
    expect(out.generated.errors.map((e) => e.message).join('\n')).not.toMatch(/no plan the search tried|names no cutter/);
    fingerprint = out.generated.tabChoiceNeeded!.fingerprint;
  }, 600_000);

  it('a matching saved longerStretch: measured under it, not flagged, the plan reused, no step-2 tab', async () => {
    expect(fingerprint).not.toBe('');
    const job: EngraveJob = { ...blockJob(), tabChoice: { choice: 'longerStretch', answeredFor: fingerprint } };
    const out = await pickThenCut(job);
    expect(out.evaluation.ok).toBe(true);
    expect(out.evaluation.tabQuestion).toBeUndefined();
    expect(out.evaluation.ownedPlan).not.toBeNull();
    expect(out.evaluation.ownedPlan!.tabChoiceApplied?.choice).toBe('longerStretch');
    expect(out.evaluation.ownedPlan!.tabChoiceApplied?.fingerprint).toBe(fingerprint);
    const said = out.evaluation.ownedPlan!.perSetup.flatMap((s) => s.statements.map((st) => st.text)).join('\n');
    expect(said).not.toMatch(/Tab \d+ sits/);
    expect(out.generated.ok).toBe(true);
    expect(out.generated.programs.length).toBeGreaterThan(0);
    expect(out.generated.plan?.tabChoiceApplied?.choice).toBe('longerStretch');
  }, 600_000);

  it('a stale saved answer: the pick still ranks, the plan is withheld, the cut answers with the STALE question and no programs', async () => {
    const job: EngraveJob = { ...blockJob(), tabChoice: { choice: 'insideMargin', answeredFor: 'deadbeef' } };
    const out = await pickThenCut(job);
    expect(out.evaluation.ok).toBe(true); // not "no plan the search tried can post"
    expect(out.evaluation.tabQuestion).toBe(true);
    expect(out.evaluation.ownedPlan ?? null).toBeNull();
    expect(out.generated.ok).toBe(false);
    expect(out.generated.programs.length).toBe(0);
    expect(out.generated.tabChoiceNeeded).toBeDefined();
    expect(out.generated.tabChoiceStale).toBe(true);
    expect(out.generated.errors.map((e) => e.message).join('\n')).not.toMatch(/no plan the search tried|names no cutter/);
  }, 600_000);
});
