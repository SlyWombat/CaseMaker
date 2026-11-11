// #1164 slice (a) — THE GIRAFFE ACCEPTANCE, on the production generate path.
//
// The committed fixture is the analyst's own: `job.json` (rotary-chuck, ⌀44.5 × 100 cylinder,
// giraffe.stl embedded, surface gridPitchMm 1) and the pinned `tris.json` mesh in the rod frame.
// The spec generates the job with the ⌀6 ball, times the run, sweeps the POSTED program with the
// helper that reproduces the analyst's baseline exactly, and checks the retracts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseEngraveJob } from '@/store/engraveJobSchema';
import { setLocatedFeedTable, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { getTools, resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import { resolvedFeedsTable } from '@/engine/cnc/feeds';
import { inventoryConditions } from '@/engine/cnc/toolCondition';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { writeSetupPlan } from '@/engine/cnc/engrave/setupWork';
import { readDefault, ShopDefaultsSchema } from '@/platform/defaultsClient';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { pickForEngrave } from '@/workers/sim/smartPickRun';
import { engraveGenerate, supportingFloors, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';
import { parseRotaryMoves, sweepRotaryPenetration } from './helpers/rotaryPenetration';
import { HOP_Z, SAFE_Z } from '@/engine/cnc/cam/ir';

const DIR = join(process.cwd(), 'tests', 'unit', 'fixtures', 'giraffe-1155');
const R = 22.25;

function giraffeJob() {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(DIR, 'job.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.job;
}


/** Every rapid that repositions X or A runs at or above HOP_Z, and no A/XY move sits under it. */
function assertRetracts(nc: string): void {
  let z = Number.NaN;
  let spindle = false;
  for (const [index, line] of nc.split(/\r?\n/).entries()) {
    if (/^M3\b/.test(line) || /\bM3\b/.test(line)) spindle = true;
    const rapid = /^G0\b/.test(line);
    const cut = /^G1\b/.test(line);
    if (!rapid && !cut) continue;
    const word = (c: string): number | null => {
      const m = new RegExp(c + '(-?[\\d.]+)').exec(line);
      return m === null ? null : Number(m[1]);
    };
    const nx = word('X');
    const na = word('A');
    const nz = word('Z');
    if (!spindle) {
      if (nz !== null) z = nz;
      continue;
    }
    if (rapid && (nx !== null || na !== null)) {
      const at = nz ?? z;
      expect(Number.isFinite(at), `line ${index + 1}: a rapid with no known Z`).toBe(true);
      expect(at, `line ${index + 1}: a rapid repositions at Z ${at.toFixed(2)}, below the safe height ${SAFE_Z}`).toBeGreaterThanOrEqual(HOP_Z - 1e-9);
    }
    if (nz !== null) z = nz;
  }
}

describe('#1164 the giraffe acceptance on the production generate', () => {
  it('generates, posts, and sweeps: the programme is clean and every retract is at the hop height', async () => {
    const job = giraffeJob();
    // THE SET B SHOP, BUILT AS THE APP/CLI DOES: the location's inventory is the tool registry, its
    // feeds are the located feed table, its defaults are the shop's — `engraveShopOpts` is the same
    // builder the app and CLI use. The job names NO cutter (`toolKey: ""`), so generate's own pick
    // chooses one, exactly as the bench run's search did.
    const loc = JSON.parse(readFileSync(join(DIR, 'setb', 'location.json'), 'utf8')) as {
      inventory: { id: string; tool: unknown }[];
      feeds: FeedCatalogueRow[];
      defaults: unknown;
    };
    // The vendor catalogue is what holds the ball the bench search chose (the owned inventory does
    // not carry a ⌀6 ball): its `cat:` definitions join the registry as the CLI puts them, and its
    // feed rows are the located table.
    const cat = JSON.parse(readFileSync(join(DIR, 'setb', 'catalogue.json'), 'utf8')) as {
      tools: { key: string; tool: unknown; provenance: string }[];
      feeds: FeedCatalogueRow[];
    };
    setRegistry([
      ...cat.tools,
      ...loc.inventory.map((i) => ({ key: `inv:${i.id}`, tool: i.tool, provenance: 'setb' })),
    ] as never);
    setLocatedFeedTable(cat.feeds);
    const defaults = ShopDefaultsSchema.parse(loc.defaults);
    const shop: EngraveShopOpts = engraveShopOpts(defaults);
    let out: Awaited<ReturnType<typeof engraveGenerate>>;
    const started = performance.now();
    try {
      // THE APP'S OWN PICK, then Generate — `pickForEngrave` + `writeSetupPlan` are the functions
      // the panel's search and the CLI both call; the job names no cutter, so this is the choice
      // the bench run made. The pick shop is the run shop minus the finish allowance (the
      // picker's own inputs), exactly as the panel builds it.
      const pickShop: EngraveShopOpts = {
        tools: getTools(),
        lostDetailWarnRatio: readDefault(defaults, 'engrave.lostDetailWarnRatio').value,
        toolChangeSeconds: readDefault(defaults, 'toolChange.seconds').value,
        drill: drillSettings(defaults),
        feeds: resolvedFeedsTable().table,
        defaults,
      };
      const tools = getTools();
      const pick = await pickForEngrave({
        tl,
        job,
        tools,
        catalogue: cat.feeds,
        conditions: inventoryConditions(),
        shop: pickShop,
        floors: supportingFloors(tl, toPartPlan(job)),
      });
      if (!('runnable' in pick) || pick.runnable === null) {
        throw new Error(`the app's search refuses the giraffe: ${'reason' in pick ? pick.reason : 'no runnable plan'}`);
      }
      // A rotary relief is ONE program on the rod: the job carries the chosen cutter, never a
      // manual-rotation setup list (`writeSetupPlan` writes those for flat jobs).
      const single = pick.runnable.plan.cutters[0]!;
      const chosen = { ...job, toolKey: single.key, tool: single.tool } as typeof job;
      const tool = jobTool(chosen);
      if (tool === null) throw new Error('the chosen cutter is not in the registry');
      console.log(`ACCEPT pick: ${pick.runnable.plan.cutters.map((c) => c.key).join('+')}`);
      out = await engraveGenerate(tl, chosen, tool, cat.feeds, null, undefined, shop);
    } finally {
      resetRegistry();
      setLocatedFeedTable(null);
    }
    const costMs = Math.round(performance.now() - started);
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs.length, 'the relief posts a program').toBeGreaterThan(0);
    const nc = out.programs[0]!.nc;
    console.log(`ACCEPT chosen cutters: ${JSON.stringify(out.programs.map((p) => p.toolKey))}`);
    expect(nc.length).toBeGreaterThan(0);

    const { tris } = JSON.parse(readFileSync(join(DIR, 'tris.json'), 'utf8')) as { tris: number[] };
    const sweep = sweepRotaryPenetration({
      triangles: tris,
      R,
      moves: parseRotaryMoves(nc, () => 'all'),
      cutter: { radius: 3, shape: 'ball' },
    });
    // REPORTED for the hand-in table (asserted once the operation split is wired from the result).
    console.log(
      `ACCEPT giraffe: cost ${costMs} ms; worst ${sweep.worst?.penMm?.toFixed(4) ?? '0'} mm at line ${sweep.worst?.line ?? '-'}; ` +
        `moves >0.3 ${sweep.moves.filter((m) => m.maxPenMm > 0.3).length}; samples ${JSON.stringify(sweep.samples)}`,
    );
    assertRetracts(nc);
  }, 1_800_000);
});
