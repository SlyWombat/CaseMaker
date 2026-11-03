/**
 * #950 — a design item is graded by the program whose cutter cuts it. A drill-first split (the
 * drill bit's file, then the flat's) hands the pocket to the flat's program and nothing graded to
 * the drill's. The hole's allowance stays on the drill's own program: a later program is judged on
 * the removal it makes itself, so an earlier program's hole never reaches its design check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { applyCutterPlanToJob } from '@/engine/cnc/engrave/measuredPick';
import { candidatePlans } from '@/engine/cnc/engrave/smartPick';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { createSimSession } from '@/workers/sim/session';

const DRILL_KEY = 'inv:drill-3';
const DRILL: Tool = flatEndMill(3, {
  name: '3 mm drill',
  typeText: 'Drill',
  shape: 'drill',
  tipDiameter: 3,
  diameter: 3,
  cornerRadius: null,
  angle: 118,
  fluteLength: 20,
});
const FLAT_KEY = 'inv:flat-2';
const FLAT: Tool = flatEndMill(2, { name: '2 mm flat', fluteLength: 20 });
const ENTRIES: ToolLibraryEntry[] = [
  { key: DRILL_KEY, tool: DRILL, provenance: 'test' },
  { key: FLAT_KEY, tool: FLAT, provenance: 'test' },
];
const TOOLS: Record<string, Tool> = { [DRILL_KEY]: DRILL, [FLAT_KEY]: FLAT };

const SHOP: EngraveShopOpts = {
  drill: {
    settings: { peckDiameters: 1, peckClearanceMm: 0.5, pointAngleDeg: 118, plungeFeed: 120, spindleRpm: 9000 },
    sources: {
      peckDiameters: 'chosen for this test',
      peckClearanceMm: 'chosen for this test',
      pointAngleDeg: 'chosen for this test',
      plungeFeed: 'placeholder for this test',
      spindleRpm: 'placeholder for this test',
    },
  },
  tools: ENTRIES,
};

function drillFirstJob(): EngraveJob {
  const job: EngraveJob = {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [{ kind: 'circle', id: 'pocket', name: 'pocket', position: { x: 40, y: 25 }, rotation: 0, depth: 2, enabled: true, diameter: 10 }],
    // 1.5 mm from the pocket's edge: inside the pocket's local box, outside its own allowance.
    drills: [{ kind: 'drill', id: 'hole', position: { x: 32, y: 25 }, rotation: 0, depth: 2, enabled: true, through: false }],
    threads: [],
    toolKey: DRILL_KEY,
    tool: DRILL,
    sources: { tool: 'user' },
  };
  return applyCutterPlanToJob(job, candidatePlans(job, ENTRIES, [])[0]!);
}

const graded = (items: readonly { itemId?: string; allowOnly?: true }[] | undefined): (string | undefined)[] =>
  (items ?? []).filter((d) => d.allowOnly !== true).map((d) => d.itemId);
const allowed = (items: readonly { itemId?: string; allowOnly?: true }[] | undefined): (string | undefined)[] =>
  (items ?? []).filter((d) => d.allowOnly === true).map((d) => d.itemId);

describe('#950 — design items go to the program that cuts them', () => {
  beforeEach(() => setInventoryEntries(ENTRIES));
  afterEach(() => resetRegistry());

  it('a drill-first split: the flat grades the pocket, the drill grades nothing and carries its hole as allowance', async () => {
    const job = drillFirstJob();
    const g = await generate(tl, job, null, [], undefined, SHOP);
    expect(g.ok).toBe(true);
    expect(g.programs.map((p) => p.toolKey)).toEqual([DRILL_KEY, FLAT_KEY]);

    expect(graded(g.programs[0]!.designItems)).toEqual([]);
    expect(allowed(g.programs[0]!.designItems)).toEqual(['hole']);
    expect(graded(g.programs[1]!.designItems)).toEqual(['pocket']);
    expect(allowed(g.programs[1]!.designItems)).toEqual([]);
  }, 120_000);

  it('each program passes its own design check, swept on the stock the programs before it left', async () => {
    const job = drillFirstJob();
    const g = await generate(tl, job, null, [], undefined, SHOP);
    expect(g.ok).toBe(true);
    const session = createSimSession(tl);
    try {
      const setup = toSetup(job, Z1);
      const prior: NonNullable<Parameters<typeof session.load>[4]>['priorRemoval'][] = [];
      for (const program of g.programs) {
        const removal = prior.flat().filter((m) => m !== undefined);
        const loaded = session.load(program.nc, setup, TOOLS[program.toolKey]!, Z1.id, removal.length === 0 ? {} : { priorRemoval: removal as never });
        if (!loaded.ok) throw new Error(`${program.toolKey}: the sim refused the program: ${JSON.stringify(loaded.diagnostics)}`);
        const report = session.oracle(program.predicted ?? [], null, program.designItems);
        expect(report.designCheck?.ok ?? true, `${program.toolKey}: ${JSON.stringify(report.designCheck?.worst)}`).toBe(true);
        // The flat's slice holds the pocket alone, not the hole the drill already cut.
        if (program.toolKey === FLAT_KEY) expect(session.levelCut(-1.9)?.region?.area() ?? 0).toBeCloseTo(Math.PI * 25, 0);
        if (loaded.meshes.removal !== null) prior.push(loaded.meshes.removal);
      }
    } finally {
      session.dispose();
    }
  }, 120_000);
});
