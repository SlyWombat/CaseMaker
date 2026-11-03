/**
 * #940 — A V-CARVED ITEM ON A POCKET FLOOR.
 *
 * The sample-4 job asks for a 24 × 24 × 6 pocket and "CM" 0.8 deep in its floor with a V-bit. Two
 * facts kept the app from planning it, both in `cutterPlan.ts`:
 *
 *   1. `kindedWork` read a plane V-carve (`vCarveDepth: 'plane'`, the constant-floor cut the
 *      sample wants) as FLAT work — only `'variable'` or an inlay counted as cone work — so the
 *      item on the floor could only ever be pocketed with a flat.
 *   2. A cone's reach was measured as the item's depth from the STOCK TOP (6.8 mm), though the
 *      item sits on the 6 mm pocket floor and cuts only 0.8. A V-bit that can cut that floor was
 *      refused for not reaching a depth it never travels.
 *
 * The job here is the real sample-4 document with its initials (a text LABEL) stating the
 * constant-floor V-carve. Before this change the label is flat work, no cone owns it, and the run
 * posts one cutter; after it, a flat takes the pocket and a V takes the text, in that order, and
 * the run GENERATES two programs — one tool change, the initials cut on the floor.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { kindedWork, planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { applyCutterPlanToJob } from '@/engine/cnc/engrave/measuredPick';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { EngraveJob } from '@/types/engraveJob';
import { supportingFloors } from '@/workers/sim/engraveGenerate';

const JOB = fileURLToPath(new URL('../../../docs/bench/940-two-cutter.job.json', import.meta.url));

/** The real sample-4 job, with the sample's constant-floor V-carve stated on the initials. */
function sampleJob(): EngraveJob {
  const raw = JSON.parse(readFileSync(JOB, 'utf8')) as { labels: Record<string, unknown>[] };
  const labels = raw.labels.map((label) =>
    label.id === 'initials' ? { ...label, vCarveDepth: 'plane' } : label,
  );
  const parsed = parseEngraveJob({ ...raw, labels });
  if (!parsed.ok) throw new Error(`sample 4 should parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

/** The shop's 3.175 o-flute for the pocket. */
const FLAT: Tool = flatEndMill(3.175, { name: '3.175 mm o-flute', fluteLength: 25 });
/** A 30° × 0.3 mm engraving bit, the V the sample's initials want. */
const ENGRAVER: Tool = {
  ...flatEndMill(3.175, { name: '30° × 0.3 mm engraver', fluteLength: 5 }),
  id: 'test-engraver-30-03',
  shape: 'engraving',
  typeText: 'Engraving',
  tipDiameter: 0.3,
  angle: null,
  halfAngle: 15,
};

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool, provenance: 'test' };
}

const FLAT_KEY = 'inv:o-flute-3.175';
const V_KEY = 'inv:engraver-30-03';
const TOOLS = [entry(FLAT_KEY, FLAT), entry(V_KEY, ENGRAVER)];
/**
 * The vendor's own rows: the ⌀3.175 engraver is listed for hardwood, so the V can be fed on the
 * blank's material (Route A — the starting table carries no hardwood V row).
 */
const ROWS: FeedCatalogueRow[] = [
  { cutterId: 'test-engraver-30-03', material: 'Hardwood', rpm: 12000, feed: 1000, plungeFeed: 500, stepDown: 1 },
];

describe('#940 a V-carved item on a pocket floor', () => {
  it('a plane V-carve is cone work, and its reach is measured from the floor under it', () => {
    const job = sampleJob();
    const floors = supportingFloors(tl, toPartPlan(job));
    // The initials stand on the pocket's 6 mm floor (#748).
    expect(floors.get('initials')).toBeCloseTo(6, 6);
    const work = kindedWork(job, floors);
    const initials = work.find((w) => w.id === 'initials');
    const pocket = work.find((w) => w.id === 'pocket');
    expect(initials?.kind).toBe('cone');
    // `vCarveDepth: 'plane'` is the constant-floor V-carve the sample asks for; without the
    // floor the reach reads the stock-top depth, 6.8, and no 0.3 mm V-bit is planned for it.
    expect(initials?.reachMm).toBeCloseTo(0.8, 6);
    // The pocket is unchanged: a flat region at its own depth.
    expect(pocket?.kind).toBe('flat');
    expect(pocket?.reachMm).toBeCloseTo(6, 6);
  });

  it('the plan gives the pocket the flat and the initials the V, in that order', () => {
    const job = sampleJob();
    const floors = supportingFloors(tl, toPartPlan(job));
    const plan = planCutters(job, null, TOOLS, ROWS, undefined, undefined, undefined, floors);
    expect(plan.cutters).toHaveLength(2);
    const flat = plan.cutters[0]!;
    const cone = plan.cutters[1]!;
    expect(flat.key).toBe(FLAT_KEY);
    expect(flat.items).toEqual(['pocket']);
    expect(cone.key).toBe(V_KEY);
    expect(cone.shape).toBe('engraving');
    expect(cone.items).toEqual(['initials']);
    expect(plan.unassigned).toEqual([]);
  });

  it('the real job posts two programs: the pocket, then the V-carved initials on its floor', async () => {
    const job = sampleJob();
    const floors = supportingFloors(tl, toPartPlan(job));
    const plan = planCutters(job, null, TOOLS, ROWS, undefined, undefined, undefined, floors);
    const applied = applyCutterPlanToJob(job, {
      cutters: plan.cutters.map((c) => ({ key: c.key, items: [...c.items] })),
    });
    expect(applied.setups?.[0]?.tools).toEqual([FLAT_KEY, V_KEY]);
    // The job carries its first program's cutter; the later one resolves from the shop's list.
    const g = await generate(tl, { ...applied, tool: FLAT }, null, ROWS, undefined, { tools: TOOLS });
    if (!g.ok) console.log('GENFAIL', g.stage, JSON.stringify(g.errors), JSON.stringify(g.findings.filter((f) => f.severity === 'error').map((f) => f.code + ': ' + f.message)));
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(g.programs).toHaveLength(2);
    expect(g.programs[0]!.toolKey).toBe(FLAT_KEY);
    expect(g.programs[1]!.toolKey).toBe(V_KEY);
    // The second file is the initials' own program on the pocket floor.
    expect(g.programs[1]!.nc).toContain('CM');
    // One tool change across the run: the post writes M6 for the V on program 2 only.
    expect(g.programs[1]!.nc).toMatch(/M6/);
  }, 240_000);
});
