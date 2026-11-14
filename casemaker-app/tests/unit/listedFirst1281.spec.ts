/**
 * #1281 step 2 — THE PICK FOLLOWS THE CATALOGUE FIRST, AND SAYS WHEN IT CANNOT.
 *
 * The maintainer's two rules together ("follow the database for recommendations", 2026-10-16;
 * "plan with the owned inventory to the best of its ability and state the tradeoff", 2026-11-05):
 * within the fidelity tier every cutter the catalogue LISTS for the job's material (on a catalogue
 * or measured feed) ranks ahead of one it does not; an unlisted owned cutter is chosen only when no
 * listed one can do the job, and then a warning says so. An operator's own cutter is left alone,
 * with the same sentence.
 *
 * The S2 rehearsal's candidate facts, as a committed fixture (not the live house): an owned ⌀0.9
 * PCB corn bit the catalogue does not carry, beside two owned cutters on catalogue hardwood rows.
 * Fidelity is stubbed UNIFORM, so the only thing that can order them is the standing.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { cutterStanding, isUnlisted, unlistedSentence, type CutterStanding } from '@/engine/cnc/engrave/cutterStanding';
import { smartPick, type Evaluate } from '@/engine/cnc/engrave/smartPick';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import type { CandidatePlan, PlanEvaluation } from '@/workers/sim/planEvaluate';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';
import { picked } from './helpers/picked';

function entry(key: string, shape: ToolShape, over: Partial<Tool> = {}): ToolLibraryEntry {
  return {
    key,
    provenance: 'test',
    tool: {
      number: null, id: null, name: key, typeText: '', shape, handleDiameter: 3.175, tipDiameter: null, diameter: null,
      cornerRadius: null, angle: null, halfAngle: null, fluteLength: 12, shoulderLength: null, stickout: null, centreCutting: null,
      ...over,
    },
  };
}

/** Owned and catalogue-listed for hardwood: Makera's own row for each (hand-built, in the service's shape). */
const LISTED_A = entry('inv:kz-flat-a', 'flat', { id: '122111013890', tipDiameter: 3.175, diameter: 3.175, fluteLength: 12 });
const LISTED_B = entry('inv:kz-flat-b', 'flat', { id: '122111013860', tipDiameter: 2, diameter: 2, fluteLength: 10 });
/** Owned, no vendor id: the catalogue does not carry it (the Haocher PCB corn bit). */
const CORN = entry('inv:haocher-corn-0.9', 'flat', { id: null, tipDiameter: 0.9, diameter: 0.9, fluteLength: 3 });
/** Listed for ANOTHER material only. */
const LISTED_FOR_PCB = entry('inv:kz-corn-3', 'flat', { id: '122111099999', tipDiameter: 3, diameter: 3, fluteLength: 12 });

const CATALOGUE: readonly FeedCatalogueRow[] = [
  { cutterId: '122111013890', material: 'Hardwood', rpm: 12000, feed: 1000, plungeFeed: 500, stepDown: 1 },
  { cutterId: '122111013860', material: 'Hardwood', rpm: 12000, feed: 1000, plungeFeed: 500, stepDown: 1 },
  { cutterId: '122111099999', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.3 },
];

function job(): EngraveJob {
  const j = defaultEngraveJob();
  j.stock = { ...j.stock, material: 'hardwood' };
  // S2's work: engraved text 0.5 mm deep (a drawn, non-construction label) on a hardwood blank.
  j.labels = [
    { id: 'zoomba', text: 'Zoomba', font: 'sans-default', weight: 'regular', size: 6, position: { x: 20, y: 20 }, rotation: 0, depth: 0.5, enabled: true, construction: false },
  ];
  j.shapes = [];
  j.combined = [];
  j.traces = [];
  j.vectors = [];
  j.drills = [];
  j.threads = [];
  j.cutouts = [];
  j.chamfers = [];
  j.primitives = [];
  j.targetObject = undefined;
  j.toolKey = '';
  return j;
}

/** Every plan scores the SAME and posts: only the standing (and owned-first) can order them. */
const uniform: Evaluate = (_plan: CandidatePlan): PlanEvaluation => ({
  ok: true,
  refusal: null,
  items: [{ id: 'item', name: 'text', kind: 'flat', fidelity: 1, charsLost: 0, areaMismatchMm2: null, pinches: [] }],
  seconds: 100,
  toolChanges: 0,
  risk: { reachMarginMm: 5, holderClearanceMm: 5, chipLoadRatio: null },
});

const keys = (plan: { plan: CandidatePlan }): string => plan.plan.cutters.map((c) => c.key).join('+');

describe('#1281 a cutter’s standing', () => {
  it('Listed: the catalogue lists it for the material on its own row', () => {
    const s = cutterStanding(job(), LISTED_A, CATALOGUE, null);
    expect(s).toMatchObject({ rated: true, listed: true, notInCatalogue: false, listedFor: null });
    expect(isUnlisted(s)).toBe(false);
  });

  it('Unlisted: the catalogue does not carry the cutter', () => {
    const s = cutterStanding(job(), CORN, CATALOGUE, null);
    expect(s).toMatchObject({ rated: true, listed: false, notInCatalogue: true });
    expect(isUnlisted(s)).toBe(true);
  });

  it('Unlisted: the catalogue lists it for other materials, not this one', () => {
    const s = cutterStanding(job(), LISTED_FOR_PCB, CATALOGUE, null);
    expect(s.listed).toBe(false);
    expect(s.listedFor).toEqual(['PCB']);
    expect(unlistedSentence(job(), [s])).toContain('the catalogue lists it for PCB, not hardwood');
  });

  it('NOT RATED with no catalogue synced: never unlisted, so an offline job ranks and reads as before', () => {
    const s = cutterStanding(job(), CORN, [], null);
    expect(s.rated).toBe(false);
    expect(isUnlisted(s)).toBe(false);
  });

  it('the sentence: the clauses come from the facts, and a feed-only case gets only the feed clause', () => {
    const base: CutterStanding = { key: 'k', name: 'Bit', rated: true, listed: false, notInCatalogue: false, listedFor: null, seededFeed: true };
    expect(unlistedSentence(job(), [base])).toBe(
      'No cutter the catalogue lists for hardwood can cut this. Chosen: Bit — its feed is the shop’s starting value, not a measured one.',
    );
    expect(unlistedSentence(job(), [{ ...base, notInCatalogue: true, seededFeed: true }])).toBe(
      'No cutter the catalogue lists for hardwood can cut this. Chosen: Bit — the catalogue does not carry it; its feed is the shop’s starting value, not a measured one.',
    );
  });
});

describe('#1281 the pick ranks Listed ahead of Unlisted, inside the fidelity tier', () => {
  it('the S2 fixture: with a listed cutter available the pick is a listed one, with no unlisted cutter in it', async () => {
    const pick = picked(await smartPick(job(), [CORN, LISTED_A, LISTED_B], CATALOGUE, null, uniform));
    expect(pick.runnable).not.toBeNull();
    expect(pick.chosen.plan.cutters.map((c) => c.key)).not.toContain(CORN.key);
    expect(pick.chosen.unlisted ?? []).toHaveLength(0);
  });

  it('the same job with the listed cutters removed: the corn bit, marked Unlisted, and it posts', async () => {
    const pick = picked(await smartPick(job(), [CORN], CATALOGUE, null, uniform));
    expect(pick.runnable).not.toBeNull();
    expect(keys(pick.chosen)).toBe(CORN.key);
    expect(pick.chosen.unlisted?.map((s) => s.key)).toEqual([CORN.key]);
    expect(pick.chosen.unlisted?.[0]?.notInCatalogue).toBe(true);
  });

  it('never a refusal where an owned cutter can do the job: a cutter listed only for another material is still chosen', async () => {
    const pick = picked(await smartPick(job(), [LISTED_FOR_PCB], CATALOGUE, null, uniform));
    expect(pick.runnable).not.toBeNull();
    expect(pick.chosen.unlisted?.[0]?.listedFor).toEqual(['PCB']);
  });

  it('standing never outranks fidelity: a clearly better unlisted plan beats a worse listed one', async () => {
    const better: Evaluate = (plan) => {
      const base = uniform(plan, 'coarse') as PlanEvaluation;
      const only = plan.cutters.map((c) => c.key).join('+');
      return { ...base, items: [{ ...base.items[0]!, fidelity: only === CORN.key ? 1 : 0.5 }] };
    };
    const pick = picked(await smartPick(job(), [CORN, LISTED_A], CATALOGUE, null, better));
    expect(keys(pick.chosen)).toBe(CORN.key);
  });

  it('the last tie-break is the LIBRARY order, not the key’s spelling', async () => {
    // Two listed owned cutters with the same everything: whichever the shop lists first wins, in
    // either order (the keys sort `…-a` before `…-b` in both runs).
    const twin = (key: string, id: string) => entry(key, 'flat', { id, tipDiameter: 3.175, diameter: 3.175, fluteLength: 12 });
    const a = twin('inv:twin-a', '122111013890');
    const b = twin('inv:twin-b', '122111013890');
    const first = picked(await smartPick(job(), [a, b], CATALOGUE, null, uniform));
    const second = picked(await smartPick(job(), [b, a], CATALOGUE, null, uniform));
    expect(keys(first.chosen)).toBe('inv:twin-a');
    expect(keys(second.chosen)).toBe('inv:twin-b');
  });

  it('owned before catalogue-only at equal standing: a cat: key spelled first no longer takes the slot', async () => {
    const cat = entry('cat:aaa-flat', 'flat', { id: '122111013890', tipDiameter: 3.175, diameter: 3.175, fluteLength: 12 });
    const own = entry('inv:zzz-flat', 'flat', { id: '122111013890', tipDiameter: 3.175, diameter: 3.175, fluteLength: 12 });
    const pick = picked(await smartPick(job(), [cat, own], CATALOGUE, null, uniform));
    expect(keys(pick.chosen)).toBe('inv:zzz-flat');
  });

  it('no catalogue: nothing is rated, and the pick is the one it was (the key order decides the tie)', async () => {
    const withCat = picked(await smartPick(job(), [CORN, LISTED_A], [], null, uniform));
    expect(withCat.chosen.unlisted ?? []).toHaveLength(0);
  });
});

describe('#1281 the finding on the posted cutter (the operator’s own choice is left alone, with the same sentence)', () => {
  const findings = (tool: Tool, catalogue: readonly FeedCatalogueRow[]) =>
    engraveRegions(tl, job(), tool, effectiveMargins(job(), MARGIN_DEFAULTS), {}, Z1, catalogue).findings.filter((f) => f.code === 'tool-unlisted');

  it('an unlisted cutter the operator chose: a warning with the sentence, and the job still runs', () => {
    const f = findings(CORN.tool, CATALOGUE);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toContain('No cutter the catalogue lists for hardwood can cut this. Chosen: inv:haocher-corn-0.9 — the catalogue does not carry it');
  });

  it('a listed cutter, or no catalogue at all: no finding', () => {
    expect(findings(LISTED_A.tool, CATALOGUE)).toHaveLength(0);
    expect(findings(CORN.tool, [])).toHaveLength(0);
  });
});
