/**
 * #1073 — THE LOCATING BORE IS THROUGH THE BLANK AND THE JOB'S BREAKTHROUGH, BORED WITH AN OWNED FLAT.
 *
 * The maintainer asked on 11-07: "why 6 mm into the wasteboard?", and 0f's 2026-11-08 ruling
 * settled it: 0.3 mm into the board is enough. The holes exist so the probe can enter them from
 * side 2 and touch their WALLS; they need only be THROUGH by the job's own breakthrough rule, so
 * nothing sits in them and no extra chip clearance is cut.
 *
 * THE BORE IS ⌀6, HELICAL INTERPOLATION, not a drill's own size: the shop is 1/8 in only (#977),
 * so the hole is opened by an owned FLAT NARROWER than the bore, and the flat that wins is the
 * one with the LONGEST REACH — the flute must stand the whole bore (the M1 tray's 25.5 mm is why
 * the 3.175 × 42 exists). A 3 mm drill cannot interpolate ⌀6 and cannot reach 25.5 mm.
 *
 * RED against the previous rule: `ownedBoreCutter` looked for a ⌀5–6 cutter the shop does not
 * own and fell through to the largest 2.5–6 DRILL — on the real k3 house, `inv:kz-drill-3-12`
 * (3 mm, 12 mm flute) for a 25.5 mm bore.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { FLIP_BORE_DIAMETER_MM } from '@/engine/cnc/engrave/flipChoice';
import { dowelHold, ownedBoreCutter, planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import { goalFlipFindings } from '@/engine/cnc/engrave/goalFlipFindings';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { boxTarget } from './helpers/twoSetupBox966';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

const STOCK = { length: 100, width: 60, thickness: 12 };

async function sphereJob(): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
  const bytes = readFileSync(here('near-sphere.stl'));
  const read = await readTargetObjectFile(new File([bytes], 'near-sphere.stl'), 'g-sphere-bore');
  if (!read.ok) throw new Error(read.error);
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const base = defaultEngraveJob();
  const job: EngraveJob = { ...base, labels: [], shapes: [], drills: [], stock: { ...STOCK, material: 'pla' }, targetObject: goal };
  return { job, goal };
}

const entry = (key: string, tool: Tool) => ({ key, tool });
const FLAT3 = entry('user:flat-3', flatEndMill(3));
const FLAT25 = entry('user:o-flute-3.175-25', flatEndMill(3.175, { name: '1/8 in O-flute, 25 mm flute', fluteLength: 25 }));
const FLAT42 = entry('user:o-flute-3.175-42', flatEndMill(3.175, { name: '1/8 in O-flute, 42 mm flute', fluteLength: 42 }));
const FLAT6 = entry('user:flat-6', flatEndMill(6, { fluteLength: 30 }));
const DRILL3 = entry('user:drill-3', flatEndMill(3, { name: '3 mm drill', shape: 'drill', typeText: 'Drill', fluteLength: 12 }));
const BALL = entry('user:ball-3.175', flatEndMill(3.175, { shape: 'ball', typeText: 'Ball Nose', fluteLength: 22 }));

/** A shop shaped like the real house: 1/8 in shanks, no ⌀5–6 cutter, a short and a long O-flute. */
const K3_SHAPED = [FLAT3, FLAT25, FLAT42, DRILL3, BALL, FLAT6];

describe('#1073 the bore’s cutter is an interpolating flat with the longest reach', () => {
  it('the 25.3 mm tray bore picks the 42 mm flute; the 25 mm one is 0.3 mm short', () => {
    const pick = ownedBoreCutter(K3_SHAPED, 25.0 + 0.3);
    expect(pick).toEqual(FLAT42);
    // The same shop, a bore the 25 mm flute could reach: the longer one still wins.
    expect(ownedBoreCutter([FLAT25, FLAT42], 12.5)).toEqual(FLAT42);
  });

  it('a drill or a ball nose is never the bore’s cutter, and a flat at the bore’s size cannot interpolate it', () => {
    expect(ownedBoreCutter([DRILL3], 12.5)).toBeNull();
    expect(ownedBoreCutter([BALL], 12.5)).toBeNull();
    expect(ownedBoreCutter([FLAT6], 12.5)).toBeNull();
  });

  it('a stated reach that reaches the depth beats a record with no reach stated', () => {
    expect(ownedBoreCutter([FLAT3, FLAT25], 12.5)).toEqual(FLAT25);
    // With no stated reach anywhere, the fallback is the widest flat the bore can take.
    expect(ownedBoreCutter([FLAT3], 12.5)).toEqual(FLAT3);
  });

  it('a bore deeper than every owned flute finds no cutter', () => {
    expect(ownedBoreCutter([FLAT42], 50)).toBeNull();
  });
});

describe('#1073 the bore goes the blank and the job’s breakthrough into the board', () => {
  it('the hold states the BORE (⌀6), its cutter, and the blank + breakthrough depth', async () => {
    const { job, goal } = await sphereJob();
    expect(FLIP_BORE_DIAMETER_MM).toBe(6);
    expect(job.breakthrough).toBeCloseTo(0.3, 6);
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], K3_SHAPED);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.hold).not.toBeNull();
    // 12 mm blank + 0.3 breakthrough = 12.3 mm, not 14 — and no chip clearance on top.
    expect(plan.hold!.depthMm).toBeCloseTo(12.3, 6);
    // The hole is the ⌀6 bore; the cutter is the 3.175 mm O-flute that interpolates it.
    expect(plan.hold!.diameterMm).toBeCloseTo(6, 6);
    expect(plan.hold!.cutter).toBe('user:o-flute-3.175-42');
  });

  it('a job that states its own breakthrough moves the depth with it', async () => {
    const { job, goal } = await sphereJob();
    const shallow: EngraveJob = { ...job, breakthrough: 0.05 };
    const plan = planFlipSetups(shallow, goal, ['top', 'bottom'], K3_SHAPED);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.hold!.depthMm).toBeCloseTo(12.05, 6);
  });

  it('the offer’s sentence states the bore, the half millimetre and the flat', async () => {
    const { job, goal } = await sphereJob();
    const withBoard: EngraveJob = {
      ...job,
      sacrificial: { ...job.sacrificial, under: { thickness: 6, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' } },
    };
    const [finding] = goalFlipFindings(withBoard, goal, K3_SHAPED);
    expect(finding!.goalFlipAction).toBeDefined();
    expect(finding!.goalFlipDetail).toContain('bores two ⌀6 mm locating holes 12.3 mm deep');
    expect(finding!.goalFlipDetail).toContain('0.3 mm into the board');
  });

  it('a board thinner than the bore’s drop is the need; one that can take it is the action', async () => {
    const { job, goal } = await sphereJob();
    const withUnder = (thickness: number | null): EngraveJob => ({
      ...job,
      sacrificial: {
        ...job.sacrificial,
        under: thickness === null ? null : { thickness, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
      },
    });
    const [thin] = goalFlipFindings(withUnder(0.2), goal, K3_SHAPED);
    expect(thin!.goalFlipNeed).toBe('needs a sacrificial board under the blank');
    const [enough] = goalFlipFindings(withUnder(0.3), goal, K3_SHAPED);
    expect(enough!.goalFlipAction).toBeDefined();
  });
});

describe('#1073 the hold refuses when the part leaves no margin', () => {
  it('m1trayF’s real numbers: part X 22..158 on a 160 mm blank — the line at 156 would be on the part', () => {
    // The tray's own goal: a 106 × 136 part at (90, 63), rotated 90° — its placed bbox is X
    // 22..158, Y 10..116 on the 160 × 126 blank. The left-right hold line sits at L − 4 = 156,
    // which is INSIDE the part; before the fix it was clamped there silently.
    const goal: EngraveTargetObject = { ...boxTarget('tray-margin-1073', 106, 136, 25), position: { x: 90, y: 63, z: 0 }, rotation: 90 };
    const base = defaultEngraveJob();
    const job: EngraveJob = { ...base, labels: [], shapes: [], stock: { ...base.stock, length: 160, width: 126, thickness: 25, material: 'hardwood' }, targetObject: goal };
    const hold = dowelHold(job, goal, 'y', K3_SHAPED);
    expect(hold.ok).toBe(false);
    if (!hold.ok) {
      expect(hold.reason).toContain('the part reaches X 158 on a 160 mm long blank');
      expect(hold.reason).toContain('need 4 mm clear of it');
      expect(hold.reason).toContain('the hold line at X 156 would be on the part');
    }
  });

  it('a part that fits keeps its hold, in the margin', async () => {
    const { job, goal } = await sphereJob();
    const hold = dowelHold(job, goal, 'x', K3_SHAPED);
    expect(hold.ok).toBe(true);
    if (hold.ok) {
      // The sphere sits at Y 15..45 on a 60 mm wide blank: the line is at W − 4 = 56, clear of it.
      expect(hold.hold.at.map((p) => p.y)).toEqual([56, 56]);
    }
  });
});
