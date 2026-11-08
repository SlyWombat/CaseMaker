/**
 * #1073 line 2 — THE FRAME FLIP'S BORES AND ITS TAB BAND, IN THE PLAN AND THE POSTED NC.
 *
 * A job whose later setup states `flip = { method: 'tabs-in-blank', axis: 'left-right' }` must:
 *   - band BOTH sides' goals — side 1 stops the band above the part's silhouette plane, side 2 at
 *     the same band below it — and write `underside: {kind:'flipped-tabs', tabs:{thicknessMm:1}}`
 *     on them, so C's release op reads one record (bandMm + tab thickness) and side 1 never frees
 *     the part under a running cutter;
 *   - post side 1's two locating bores as BORED ops: ⌀6 helical with the hold's own cutter (the
 *     3.175 × 42 by the longest reach), through the blank and its breakthrough into the board, at the
 *     hold's positions — which ride the setup's pins for C's ≥10 mm clearance check.
 *
 * RED at 22d77f195: planFlipSetups writes full-depth goals with no band and the job's own
 * underside; toPartPlan has no flip bores at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import { silhouettePlane, UNDERSIDE_TAB_THICKNESS_MM } from '@/engine/cnc/engrave/goalUnderside';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { resetRegistry } from '@/engine/cnc/toolRegistry';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => {
  clearTargetObjectMeshCache();
  resetRegistry();
});

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

const STOCK = { length: 40, width: 40, thickness: 30 };
const BORE_MILL: { key: string; tool: Tool } = {
  key: 'user:o-flute-3.175-42',
  tool: flatEndMill(3.175, { name: '1/8 in O-flute, 42 mm flute', fluteLength: 42 }),
};

async function sphereJob(): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
  const bytes = readFileSync(here('near-sphere.stl'));
  const read = await readTargetObjectFile(new File([bytes], 'near-sphere.stl'), 'g-sphere-flip-posts');
  if (!read.ok) throw new Error(read.error);
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: 22, y: 18, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const base = defaultEngraveJob();
  const job: EngraveJob = { ...base, labels: [], shapes: [], drills: [], stock: { ...STOCK, material: 'pla' }, targetObject: goal };
  return { job, goal };
}

describe('#1073 the flip bands both sides and writes the tab record', () => {
  it('side 1 stops the band above the silhouette plane; side 2 at the same band below it', async () => {
    const { job, goal } = await sphereJob();
    const plane = silhouettePlane(goal);
    expect(plane).not.toBeNull();
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [BORE_MILL], { method: 'tabs-in-blank', axis: 'left-right' });
    expect(plan.ok, plan.ok ? '' : plan.reason).toBe(true);
    if (!plan.ok) return;
    const [first, second] = plan.goals;
    expect(first!.bandMm).toBeDefined();
    expect(second!.bandMm).toBeDefined();
    // The band is the tab thickness on each side of the plane, in each side's own top-down depth.
    expect(first!.bandMm!).toBeCloseTo(Number((goal.position.z - (plane! + UNDERSIDE_TAB_THICKNESS_MM)).toFixed(3)), 3);
    const minZ = goal.position.z - 30; // the sphere is 30 mm across, placed with its top at position.z
    expect(second!.bandMm!).toBeCloseTo(Number((plane! - UNDERSIDE_TAB_THICKNESS_MM - minZ).toFixed(3)), 3);
    // ONE RECORD: both goals carry the flipped-tabs underside C's release op reads. The fixture
    // states no tabs block, so none is invented — C's op's own default (1 mm) is the number used.
    for (const g of [first!, second!]) {
      expect(g.underside?.kind).toBe('flipped-tabs');
      expect(g.underside?.tabs).toBeUndefined();
    }
    // C's clearance check reads the pins, in side 2's frame; the hold's own positions ride the plan.
    expect(plan.setups[1]!.pins).toBeDefined();
    expect(plan.hold).not.toBeNull();
  });

  it('a plan with no flip keeps the job’s own underside and no bands (set B’s shape)', async () => {
    const { job, goal } = await sphereJob();
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [BORE_MILL]);
    if (!plan.ok) throw new Error(plan.reason);
    for (const g of plan.goals) {
      expect(g.bandMm).toBeUndefined();
      expect(g.underside).toBeUndefined();
    }
  });
});
