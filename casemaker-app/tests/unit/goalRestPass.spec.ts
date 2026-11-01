/**
 * #847 — A 3D FINISH THAT COULD NOT REACH THE GOAL IS FOLLOWED BY A REST PASS.
 *
 * The finish's own gouge-safe tip field says what is left: in the notch, a ⌀6 ball rides up the
 * walls and the material below it stays. A smaller OWNED ball is then cut over just that region as
 * its own program, after the finish; when no smaller ball is owned, the finish still posts and the
 * run states the volume left and the ball that would reach it.
 */
import { describe, expect, it } from 'vitest';

import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type P = [number, number, number];

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
 * the notch's floor stands 1.5 mm above the goal — material only a smaller ball takes.
 */
function notchedPlate(): string {
  const section: [number, number][] = [
    [0, 0],
    [20, 0],
    [20, 5],
    [13, 5],
    [10, 0.5],
    [7, 5],
    [0, 5],
  ];
  const depth = 10;
  const cap = (y: number): readonly (readonly [P, P, P])[] => {
    // A fan from the section's first vertex triangulates this concave profile.
    const tris: (readonly [P, P, P])[] = [];
    for (let i = 1; i < section.length - 1; i++) {
      const a = section[0]!;
      const b = section[i]!;
      const c = section[i + 1]!;
      tris.push(y === 0
        ? [[a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]]]
        : [[a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]]);
    }
    return tris;
  };
  const sides: (readonly [P, P, P])[] = [];
  for (let i = 0; i < section.length; i++) {
    const a = section[i]!;
    const b = section[(i + 1) % section.length]!;
    const a0: P = [a[0], 0, a[1]];
    const b0: P = [b[0], 0, b[1]];
    const a1: P = [a[0], depth, a[1]];
    const b1: P = [b[0], depth, b[1]];
    sides.push([a0, b0, b1], [a0, b1, a1]);
  }
  return stlBase64([...cap(0), ...cap(depth), ...sides]);
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

describe('#847 the goal follows its finish with a rest pass', () => {
  it('cuts a ⌀2 rest program over the notch only, and the residual drops', () => {
    const target = goalTarget();
    const out = generateGoalProgram(goalJob(target), target, BALL6, [], null, { tools: [REST_ENTRY], feeds: SHOP_FEEDS });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    // The finish, then the rest cutter's own program — a real posted file.
    expect(out.programs).toHaveLength(2);
    expect(out.programs[1]!.toolKey).toBe(REST_KEY);
    expect(out.programs[1]!.nc).toContain('M02');

    const info = out.findings.find((f) => f.code === 'goal-rest-pass');
    expect(info?.severity).toBe('info');
    expect(info?.message).toContain('2 mm ball nose');
    expect(info?.message).toContain('leaves');

    const rest = out.surface3d?.rest;
    expect(rest).not.toBeNull();
    expect(rest?.toolKey).toBe(REST_KEY);
    expect(rest?.finishResidualMm3 ?? 0).toBeGreaterThan(0);
    // The simulated outcome drops: the rest ball leaves less above the goal than the finish did.
    expect(rest?.residualMm3 ?? 0).toBeLessThan(rest?.finishResidualMm3 ?? 0);

    // The rest ball reaches material the finish's did not: the notch's floor stands at work
    // Z −4.5, and the ⌀6 ball's tip stops around −3.0, so a cut below −3.5 at the notch's centre
    // (work X 30) is the ⌀2 ball's alone.
    const restCuts = feedCuts(out.programs[1]!.nc);
    expect(restCuts.filter((m) => Math.abs(m.x - 30) <= 1.5 && m.z < -3.5).length).toBeGreaterThan(0);
    // A partial pass: the rest ball cuts the concavities (the notch, and the fillet the ⌀6 ball
    // leaves around the part's base), not the whole surface again.
    expect(restCuts.length).toBeLessThan(feedCuts(out.programs[0]!.nc).length);
  }, 180_000);

  it('with no smaller ball owned, the finish still posts and the run states what it left', () => {
    const target = goalTarget();
    const out = generateGoalProgram(goalJob(target), target, BALL6, [], null, { tools: [], feeds: SHOP_FEEDS });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs).toHaveLength(1);
    const warning = out.findings.find((f) => f.code === 'goal-rest-uncut');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('no owned ball cuts it');
    // The ball that would reach it, from the grid alone — no inventory, no simulation.
    expect(warning?.message).toMatch(/a ball of about ⌀\d+(?:\.\d+)? mm would reach it/);
    expect(out.surface3d?.rest).toBeNull();
  }, 180_000);

  it('is information when the leftover would not show: a shallow ridge under the shop’s depth', () => {
    // The same part, judged against a shop whose visibility thresholds sit at the tops of their
    // own rules (a 5 mm depth, a 50 % share): the leftover — the ring's fillet, 4.96 mm deep and
    // just under half of what the goal removes — holds under both, so the run still states it, its
    // depth and the ball that would reach it, but as information rather than a warning.
    const target = goalTarget();
    // Clear the WHOLE blank: the leftover (the fillet where the ball meets the part's wall) is then
    // a small share of the far more material the goal removes.
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
    const out = generateGoalProgram(goalJob(target), target, BALL6, [], null, quiet);
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    const note = out.findings.find((f) => f.code === 'goal-rest-uncut');
    expect(note?.severity).toBe('info');
    expect(note?.message).toContain('under the 5 mm');
    expect(note?.message).toContain('marks a leftover visible');
    expect(note?.message).toMatch(/a ball of about ⌀\d+(?:\.\d+)? mm would reach it/);
  }, 180_000);
});
