/**
 * #847 — A 3D FINISH THAT COULD NOT REACH THE GOAL IS FOLLOWED BY A REST PASS.
 *
 * #1008 — RE-PINNED AGAINST THE MODEL ENGINE. The rest is no longer a hand-built second program
 * with its own `goal-rest-pass` finding: `planModelCam` ranks the owned balls by OUTCOME (#986)
 * and the winner posts its own finish + pencil program. These pins assert that outcome — the
 * residual over the notch drops when the ⌀2 is owned, and the rank names the ⌀2 — rather than
 * the old program layout.
 *
 * Still OPEN on the missing statement (#1023): with no smaller ball owned, the run must STATE
 * what the finish left and the ball that would reach it, and must state it as information when
 * the shop's visibility thresholds hide it. The model engine emits no such statement today (the
 * rank note is gated on more than one candidate, `cam/model/plan.ts:902`, and `goal-rest-uncut`
 * is type-only in `engrave/jobSetup.ts`), so those two pins are `it.fails` until #1023 lands.
 */
import { describe, expect, it } from 'vitest';

import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type P = [number, number, number];
type Tri2 = [[number, number], [number, number], [number, number]];

function stlBase64(tris: readonly (readonly [P, P, P])[]): string {
  const bytes = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, 0, true);
    off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, p[0], true);
      dv.setFloat32(off + 4, p[1], true);
      dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return Buffer.from(bytes).toString('base64');
}

/**
 * A 20 × 10 × 5 plate with a 6 mm-wide V notch along Y, 4.5 mm deep, its mouth flush with the
 * plate's top face. A ⌀6 ball cannot enter the V: it rides on the walls and on the shoulders, so
 * the notch's floor stands above the goal — material only a smaller ball takes.
 *
 * #1008 — THE MESH IS CONSISTENTLY WOUND. The first version fanned the concave (X, Z) section
 * from vertex 0: two of those triangles cross the notch with negative area, and the side walls
 * were wound opposite the caps. The old heightfield engine never read winding; `planModelCam`'s
 * door refuses that mesh ("Not manifold") before planning starts. The caps below are the section
 * ear-clipped from its reflex vertex E (every triangle CCW in X/Z, every cap boundary edge the
 * section's own), and each side wall runs `[a0, a1, b1]`, `[a0, b1, b0]` so its edge on the
 * shared cap edge is traversed the opposite way. Same outer dimensions, same notch, same grid.
 */
function notchedPlate(): string {
  const A: [number, number] = [0, 0];
  const B: [number, number] = [20, 0];
  const C: [number, number] = [20, 5];
  const D: [number, number] = [13, 5];
  const E: [number, number] = [10, 0.5];
  const F: [number, number] = [7, 5];
  const G: [number, number] = [0, 5];
  const section = [A, B, C, D, E, F, G];
  const depth = 10;
  const capTris: Tri2[] = [
    [C, D, E],
    [B, C, E],
    [A, B, E],
    [G, A, E],
    [E, F, G],
  ];
  const cap = (y: number): readonly (readonly [P, P, P])[] =>
    capTris.map(([a, b, c]) => (y === 0
      ? [[a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]]]
      : [[a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]])) as readonly (readonly [P, P, P])[];
  const sideTris: (readonly [P, P, P])[] = [];
  for (let i = 0; i < section.length; i++) {
    const a = section[i]!;
    const b = section[(i + 1) % section.length]!;
    const a0: P = [a[0], 0, a[1]];
    const b0: P = [b[0], 0, b[1]];
    const a1: P = [a[0], depth, a[1]];
    const b1: P = [b[0], depth, b[1]];
    sideTris.push([a0, a1, b1], [a0, b1, b0]);
  }
  return stlBase64([...cap(0), ...cap(depth), ...sideTris]);
}

const BALL6: Tool = { ...flatEndMill(6), name: '6 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 6, cornerRadius: 3 };
const BALL2: Tool = { ...flatEndMill(2), name: '2 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 2, cornerRadius: 1 };
const REST_KEY = 'user:ball-2-847';
const REST_ENTRY: ToolLibraryEntry = { key: REST_KEY, tool: BALL2, provenance: 'test' };
// The shop's own feeds table covering both balls: the compiled starting rows stop at 3.2 mm, and
// this job finishes with a ⌀6. The row is deliberately the compiled PLA starting values.
const SHOP_FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 1,
    maxDiameter: 8,
    params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true },
    status: 'unmeasured' as const,
    provenance: 'test row',
  },
];

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-847',
    name: 'notched plate',
    role: 'goal',
    enabled: true,
    format: 'stl',
    sha256: 'r'.repeat(64),
    data: notchedPlate(),
    position: { x: 30, y: 20, z: 0 },
    rotation: 0,
    size: { x: 20, y: 10, z: 5 },
    // A 0.5 mm grid keeps the ⌀6 ball's tip field inside its evaluation budget in a unit test;
    // the notch is 6 mm wide, so the concavity is still many cells across.
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function goalJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    targetObject: target,
    toolKey: '',
    tool: BALL6,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

/** Every CUTTING move's (X, Z) in a posted file, X held modally as the controller reads it. */
function feedCuts(nc: string): { x: number; z: number }[] {
  const cuts: { x: number; z: number }[] = [];
  let x: number | null = null;
  for (const line of nc.split('\n')) {
    const t = line.trim();
    if (!/^G[01]\b/.test(t)) continue;
    const mx = t.match(/X(-?\d+(?:\.\d+)?)/);
    if (mx) x = Number(mx[1]);
    const mz = t.match(/Z(-?\d+(?:\.\d+)?)/);
    if (t.startsWith('G1') && mx && mz && x !== null) cuts.push({ x, z: Number(mz[1]) });
  }
  return cuts;
}

/** Every sentence the run states to the operator: findings, the plan's notes and its statements. */
function runStatements(out: Awaited<ReturnType<typeof generateGoalProgram>>): string[] {
  return [
    ...out.findings.map((f) => f.message),
    ...(out.plan?.perSetup.flatMap((s) => [
      ...s.notes,
      ...s.statements.map((st) => st.text),
    ]) ?? []),
  ];
}

describe('#847 the goal follows its finish with a rest pass', () => {
  it('cuts a ⌀2 rest program over the notch, and the residual drops', async () => {
    const target = goalTarget();
    const out = await generateGoalProgram(goalJob(target), target, BALL6, null, { shop: { tools: [REST_ENTRY], feeds: SHOP_FEEDS } });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    // The ⌀6 rough, then the ⌀2's own run (its finish and pencil): one program per cutter run.
    expect(out.programs).toHaveLength(2);
    expect(out.programs[1]!.toolKey).toBe(BALL2.name);
    expect(out.programs[1]!.nc).toContain('M02');

    // The coverage rank chose the ⌀2 on outcome, and the plan states the comparison: measured
    // 2026-11-06, ⌀2 leftover 6.50 % against the ⌀6's 21.39 %.
    const rank = out.plan!.perSetup[0]!.notes.find((n) => n.startsWith('ball rank:'));
    expect(rank).toContain('⌀2.00 mm');
    expect(rank).toContain('Chosen: 2 mm ball nose');

    // The residual over the notch drops. The plan's own stamp leaves 0.896 mm above the goal
    // with the ⌀2 owned, against 2.424 mm for the ⌀6-alone plan (measured 2026-11-06).
    const outcome = out.plan!.outcome;
    expect(outcome).toBeDefined();
    expect(outcome!.leftoverAboveMm).toBeLessThan(1.5);
    expect(outcome!.coverage).toBeGreaterThan(0.9);

    // And the posted rest ball reaches material the ⌀6 cannot: at the notch's centre (work X 30)
    // a cut below −3.5 is the ⌀2's alone (it cuts to −3.606 there; the ⌀6 alone stops at −2.076).
    const restCuts = feedCuts(out.programs[1]!.nc);
    expect(restCuts.filter((m) => Math.abs(m.x - 30) <= 1.5 && m.z < -3.5).length).toBeGreaterThan(0);
  }, 180_000);

  it('with no smaller ball owned, the finish still posts', async () => {
    const target = goalTarget();
    const out = await generateGoalProgram(goalJob(target), target, BALL6, null, { shop: { tools: [], feeds: SHOP_FEEDS } });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    // One ⌀6 program — rough, finish and pencil — and no invented rest.
    expect(out.programs).toHaveLength(1);
    expect(out.programs[0]!.toolKey).toBe(BALL6.name);
    // Its outcome is the comparison the missing statement must name: 78.61 % of the goal,
    // 2.424 mm left standing at the worst cell (measured 2026-11-06).
    const outcome = out.plan!.outcome;
    expect(outcome).toBeDefined();
    expect(outcome!.coverage).toBeGreaterThan(0.7);
    expect(outcome!.leftoverAboveMm).toBeGreaterThan(2.3);
  }, 180_000);

  // #1023 — the missing rest statement. Flip this pin to `it` when #1023 lands.
  it.fails('with no smaller ball owned, a statement names what the finish left', async () => {
    const target = goalTarget();
    const out = await generateGoalProgram(goalJob(target), target, BALL6, null, { shop: { tools: [], feeds: SHOP_FEEDS } });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    const stated = runStatements(out);
    expect(
      stated.some((m) => /leaves .*over/i.test(m) || /would reach it/i.test(m)),
      `no statement names the leftover; the run stated: ${stated.join(' | ')}`,
    ).toBe(true);
  }, 180_000);

  // #1023 — the same issue; the shop's visibility thresholds decide warning against info.
  it.fails('states the leftover as information when the shop sets high visibility thresholds', async () => {
    const target = goalTarget();
    // The same part with the whole blank cleared: the leftover (the notch and the fillet where
    // the ball meets the part's wall) is then a small share of the far more material the goal
    // removes. Against a shop whose thresholds sit at the tops of their own rules (a 5 mm depth,
    // a 50 % share), the leftover holds under both, so the run states it and its depth as
    // information rather than a warning.
    target.surface = { gridPitchMm: 0.5, clearAround: 'whole' };
    const quiet = {
      tools: [] as ToolLibraryEntry[],
      feeds: SHOP_FEEDS,
      rest: {
        overlap: { value: 0.5, source: 'chosen' as const },
        thirdToolPct: { value: 50, source: 'chosen' as const },
        visibleDepth: { value: 5, source: 'chosen' as const },
      },
    };
    const out = await generateGoalProgram(goalJob(target), target, BALL6, null, { shop: quiet });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    const note = out.findings.find((f) => /leaves/i.test(f.message));
    expect(note?.severity).toBe('info');
    expect(note?.message).toContain('under the 5 mm');
  }, 180_000);
});
