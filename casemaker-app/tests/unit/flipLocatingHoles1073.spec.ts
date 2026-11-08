/**
 * #1073 line 2 — THE LOCATING HOLES, POSTED ON SETUP 1 ONLY.
 *
 * A frame flip (`flip: { method: 'tabs-in-blank', axis: 'left-right' }`) has side 2 register by
 * probing the walls of two ⌀6 bores, so setup 1 leaves them in the blank's margin. They are a program of their own on
 * the hold's cutter, appended after setup 1's last program — built as a drills-only sub-job through
 * the ordinary per-program generator, so setup 2 cannot receive them BY CONSTRUCTION.
 *
 * The part is a closed FRUSTUM on a 40 × 30 × 20 blank: its widest cross-section sits strictly
 * inside the part (a plain box's widest is its own top face, where `flipTabBands` refuses to place
 * a band), and its widest outline is a 30 × 20 rectangle, so the flip's registration has straight
 * edges ≥ 15 mm to anchor on. The mount is a bracket — the one that turns the stock over about Y
 * (left↔right, #1073 step 0's RY180 map). `planFlipSetups` authors the two-sided job the way the
 * app's flip offer does: side 1, the flipped side 2 carrying the stated flip, both goals banded,
 * and the hold's two bores.
 *
 * RED at 68b086bce: no program carries the hold's bores at all (nothing posts them).
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import { goalFlipFindings } from '@/engine/cnc/engrave/goalFlipFindings';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { entry, FLAT3, stl } from './helpers/twoSetupBox966';

const FLAT_ENTRY: ToolLibraryEntry = entry('inv:flat-3', FLAT3);

/** A 60 × 40 × 20 part on an 80 × 50 × 20 blank: X margin for the hold's bores, and room for
 *  the tab release's 4 bridges (≥ 15 mm from the corners, ≥ 10 mm from the bores). */
const STOCK = { length: 80, width: 50, thickness: 20 };

type V = [number, number, number];
type Tri = [V, V, V];

/**
 * A closed frustum: bottom 40 × 24 at z −20, WIDEST 60 × 40 at z −10, top 32 × 20 at z 0.
 *
 * The shape a flip's tab band needs: the widest cross-section sits strictly INSIDE the part (a
 * plain box's is its own top face, where `flipTabBands` refuses a band). Its widest outline is a
 * 30 × 20 rectangle, so the registration has straight edges ≥ 15 mm to anchor on — the two things
 * the locating-hole path needs in one fixture, without a bench sample.
 */
function frustumTris(): Tri[] {
  const ring = (x: number, y: number, z: number): V[] => [
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ];
  const B = ring(20, 12, -20);
  const M = ring(30, 20, -10);
  const T = ring(16, 10, 0);
  const quad = (out: Tri[], a: V, b: V, c: V, d: V): void => {
    out.push([a, b, c], [a, c, d]);
  };
  const tris: Tri[] = [];
  // Bottom (wound to face −Z) and top (+Z).
  quad(tris, B[3]!, B[2]!, B[1]!, B[0]!);
  quad(tris, T[0]!, T[1]!, T[2]!, T[3]!);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(tris, B[i]!, B[j]!, M[j]!, M[i]!);
    quad(tris, M[i]!, M[j]!, T[j]!, T[i]!);
  }
  return tris;
}

function frustumGoal(): EngraveTargetObject {
  return {
    id: 'frustum-locating-holes-1073',
    name: 'frustum.stl',
    format: 'stl',
    sha256: 'd'.repeat(64),
    data: stl(frustumTris()),
    size: { x: 60, y: 40, z: 20 },
    position: { x: 40, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function jobForFrustum(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...STOCK },
    // The bores stop at the job's breakthrough into the board: a flip job always has one under the blank.
    sacrificial: presetPartOnBoard(),
    targetObject: frustumGoal(),
    // A bracket mount turns the stock over about Y: the frame's own RY180 map (#1073 step 0).
    workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [], source: 'default' } },
  };
}

describe('#1073 — the locating holes ride setup 1', () => {
  it('posts one bore program on setup 1 and none on setup 2', async () => {
    const job = jobForFrustum();
    const goal = job.targetObject!;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [FLAT_ENTRY], {
      method: 'tabs-in-blank',
      axis: 'left-right',
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.hold).not.toBeNull();
    const hold = plan.hold!;
    expect(hold.at).toHaveLength(2);

    // THE SENTENCE AND THE PROGRAM CARRY THE SAME DEPTH (0f's 2026-11-08 ruling): the bore goes
    // through the blank and the job's breakthrough, nothing more.
    const drop = Math.round(job.breakthrough * 100) / 100;
    const depth = Math.round((job.stock.thickness + job.breakthrough) * 100) / 100;
    const [offer] = goalFlipFindings(job, goal, [FLAT_ENTRY]);
    expect(offer?.goalFlipDetail ?? '').toContain(`bores two ⌀6 mm locating holes ${depth} mm deep`);
    expect(offer?.goalFlipDetail ?? '').toContain(`${drop} mm into the board`);

    const sided: EngraveJob = { ...job, setups: plan.setups, targetObjects: plan.goals };
    const tl = await getToplevel();
    const result = await engraveGenerate(tl, sided, FLAT3, [], null, undefined, { tools: [FLAT_ENTRY] });
    expect(result.ok, result.errors.map((e) => e.message).join('; ')).toBe(true);

    // The post writes one `;@MKR TOOLPATH … name=` line per operation, so the bore item's own
    // name is how a program says it cut the hold — not a guessed coordinate or a tool key, which
    // the goal programs share (the hold's cutter is the same owned flat).
    const locating = result.programs.filter((program) => program.nc.includes('Locating hole'));
    expect(locating).toHaveLength(1);
    expect(locating[0]!.setupIndex).toBe(1);
    expect(locating[0]!.setupId).toBe(sided.setups![0]!.id);
    expect(locating[0]!.toolKey).toBe(FLAT_ENTRY.key);
    // BOTH holes, in the one program, bored ⌀6 through the blank (thickness + breakthrough).
    expect(locating[0]!.nc).toContain('Locating hole 1');
    expect(locating[0]!.nc).toContain('Locating hole 2');
    expect(locating[0]!.nc).toContain(`⌀6 ${depth}mm`);

    // Setup 2 cannot receive it: no bore op sits on the flipped side's programs.
    const onSideTwo = result.programs.filter(
      (program) => program.setupIndex === 2 && program.nc.includes('Locating hole'),
    );
    expect(onSideTwo).toHaveLength(0);
    // And the file is APPENDED after setup 1's last program, as the run order says.
    const lastSideOne = result.programs.filter((program) => program.setupIndex === 1).at(-1)!;
    expect(lastSideOne).toBe(locating[0]);
    expect(result.programs.at(-1)!.setupIndex).toBe(2);

    // THE SHEET'S OWN LINE, ON SETUP 1'S PAGE (step 3): the operator running setup 1 reads that a
    // second file follows on the same mounting, the file's name, and the cutter — the PROGRAM's own
    // key (#1079), not the job's assumed one.
    const sheet = buildRunSheet(sided, result, { diagnostics: [] }, new Date('2026-11-08T00:00:00Z'));
    const cutText = (sheet.sections.find((section) => section.id === 'cut')?.steps ?? []).map((step) => step.text).join('\n');
    expect(cutText).toContain('also bores the two ⌀6 locating holes');
    expect(cutText).toContain(locating[0]!.nc);
    expect(cutText).toContain('touches its wall');
  }, 240_000);

  it('refuses by name when the job’s stored pins and the recomputed hold disagree', async () => {
    const job = jobForFrustum();
    const goal = job.targetObject!;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [FLAT_ENTRY], {
      method: 'tabs-in-blank',
      axis: 'left-right',
    });
    if (!plan.ok) throw new Error(plan.reason);
    const pins = plan.setups[1]!.pins;
    if (pins === undefined) throw new Error('the flip plan states no pins to nudge');
    // A stored pin the executor will read that no longer matches the hold's own geometry: an
    // edited or stale job. The program refuses rather than posting holes D will not look for.
    const nudgedPins = { at: [{ x: pins.at[0].x + 0.5, y: pins.at[0].y }, pins.at[1]] as typeof pins.at };
    const nudged: EngraveJob = {
      ...job,
      setups: plan.setups.map((setup, i) => (i === 1 ? { ...setup, pins: nudgedPins } : setup)),
      targetObjects: plan.goals,
    };
    const tl = await getToplevel();
    const result = await engraveGenerate(tl, nudged, FLAT3, [], null, undefined, { tools: [FLAT_ENTRY] });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('cam');
    const message = result.errors.map((e) => e.message).join('; ');
    expect(message).toContain('locating holes (#1073):');
    expect(message).toContain('stored pins and the hold disagree');
  }, 240_000);

  it('stops the run by name when no owned flat can bore the holes', async () => {
    const job = jobForFrustum();
    const goal = job.targetObject!;
    // A shop with no flat at all: the hold cannot be made, and the run must NOT carry on without
    // it — side 2 could never register, and the operator would only find out at the bench.
    const ball = flatEndMill(2, { number: 2, id: 'ball-2', name: 'ball-2', shape: 'ball' });
    const ballEntry = entry('inv:ball-2', ball);
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [ballEntry], {
      method: 'tabs-in-blank',
      axis: 'left-right',
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.hold).toBeNull();

    const sided: EngraveJob = { ...job, setups: plan.setups, targetObjects: plan.goals };
    const tl = await getToplevel();
    const result = await engraveGenerate(tl, sided, FLAT3, [], null, undefined, { tools: [ballEntry] });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('cam');
    const message = result.errors.map((e) => e.message).join('; ');
    expect(message).toContain('locating holes (#1073):');
    expect(message).toContain('no owned flat end mill');
  }, 240_000);

  it('refuses a frame flip whose goals carry no band — the saved m1trayF shape', async () => {
    const job = jobForFrustum();
    const goal = job.targetObject!;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [FLAT_ENTRY], {
      method: 'tabs-in-blank',
      axis: 'left-right',
    });
    if (!plan.ok) throw new Error(plan.reason);
    // The saved-job shape: the flip is stated but WIP 1's band was never written on the goals
    // (any job saved before it, or a hand-edit). Side 2 would post with no release and no
    // instruction, so the run stops before anything posts.
    const unbanded = plan.goals.map((g) => ({ ...g, bandMm: undefined, underside: { ...(g.underside ?? {}), kind: 'flat' as const } }));
    const sided: EngraveJob = { ...job, setups: plan.setups, targetObjects: unbanded };
    const tl = await getToplevel();
    const result = await engraveGenerate(tl, sided, FLAT3, [], null, undefined, { tools: [FLAT_ENTRY] });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('findings');
    expect(result.errors.map((e) => e.message).join('; ')).toContain(
      'flip (#1073): the job states a frame flip but its goals carry no tab band — re-plan the flip',
    );
    expect(result.programs).toHaveLength(0);
  }, 240_000);

  it('the banded twin posts', async () => {
    const job = jobForFrustum();
    const goal = job.targetObject!;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [FLAT_ENTRY], {
      method: 'tabs-in-blank',
      axis: 'left-right',
    });
    if (!plan.ok) throw new Error(plan.reason);
    const sided: EngraveJob = { ...job, setups: plan.setups, targetObjects: plan.goals };
    const tl = await getToplevel();
    const result = await engraveGenerate(tl, sided, FLAT3, [], null, undefined, { tools: [FLAT_ENTRY] });
    expect(result.ok, result.errors.map((e) => e.message).join('; ')).toBe(true);
  }, 240_000);
});
