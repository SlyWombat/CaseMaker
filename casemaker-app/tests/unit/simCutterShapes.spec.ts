// #382 — the simulator sweeps every cutter shape the house owns that it has a model for: the
// chamfer's cone (#405's branch), the drill's BOUNDED point, and the thread mill's cylinder ENVELOPE.
// The volume assertions are against the analytic solids, not against the engine's own output:
//
//   drill plunged to tip depth T, radius R, half angle α, point length L = R / tan α:
//     V = π R² (T − L) + π R² L / 3                       (a cylinder on a cone)
//   chamfer (tip radius r₀, half angle α) plunged d deep, top radius r₁ = r₀ + d·tan α:
//     V = π d (r₀² + r₀ r₁ + r₁²) / 3                     (a frustum)
//   thread mill envelope (cutting radius R) plunged d deep:
//     V = π R² d                                          (a cylinder)
//
// And end to end: a #434 peck-drilling program, posted, loaded through the session, lands on the
// column engine, is not called a gouge by its own peck re-entries, and matches the oracle.

import { describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { FLAT, columnCutterFor, columnSweep, cutterReach, surfaceAboveTip, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { createSimSession, sweepsOnColumn } from '@/workers/sim/session';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { drillPointAngle, flatEndMill, type Tool } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';
import { drillBitIR, drillSettings, planDrillBit } from '@/engine/cnc/cam/drillBit';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1 } from '@/engine/cnc/post/z1';
import type { Timeline } from '@/engine/cnc/emulator/timeline';
import type { OraclePolygon } from '@/engine/cnc/engrave/oracle';

const DEG = Math.PI / 180;

const DRILL: Tool = { ...flatEndMill(2), name: '2 mm drill', typeText: 'Drill', shape: 'drill', angle: null, halfAngle: null, tipDiameter: 2, diameter: 2, cornerRadius: null };
/** The catalogue's 90° chamfer as `catalogue.rs` maps it: tip 0.1, INCLUDED angle 90, no half angle. */
const CHAMFER: Tool = { ...flatEndMill(3.175), name: '3.175mm*90º Chamfer', typeText: 'Chamfer', shape: 'chamfer', tipDiameter: 0.1, diameter: 3.175, angle: 90, halfAngle: null, cornerRadius: null };
/** The catalogue's M1 thread mill: the max cutting diameter in `diameter`, no tip (`catalogue.rs`). */
const THREAD: Tool = { ...flatEndMill(0.73), name: '3.175*M1*3mm Thread', typeText: 'Thread', shape: 'thread', tipDiameter: null, diameter: 0.73, angle: null, halfAngle: null, cornerRadius: null };

function prism(w: number, d: number, t: number): Setup {
  return stubSetup({ kind: 'prism', outline: rectProfile(w, d), thickness: t }, { kind: 'tape-down', contact: rectProfile(w, d) });
}
const plunge = (x: number, y: number, z: number): CutMove => ({ step: 0, line: 1, u0: x, u1: x, v0: y, v1: y, z });

const SHOP = { deg: 118, source: 'fallback' };

function resolve(tool: Tool, d: { deg: number; source: string } = SHOP): ColumnCutter {
  const r = columnCutterFor(tool, d);
  if (!r.ok) throw new Error(r.reason);
  return r.cutter;
}

/** Sweep ONE plunge on the flat engine at a fine grid and return the removed volume. */
function plungeVolume(cutter: ColumnCutter, z: number, dx = 0.02): number {
  const setup = prism(10, 10, 8);
  const m = plunge(5, 5, z);
  const grid = FLAT.buildGrid(setup, cutter, [m], { dx, dThetaDeg: dx });
  FLAT.applyMove(grid, m, cutter);
  return FLAT.volume(grid).removed;
}

describe('#382 the shared drill-point rule', () => {
  it('takes the drill\'s own angle, else the shop default with its source; refuses a non-drill angle', () => {
    expect(drillPointAngle({ ...DRILL, angle: 135 }, { deg: 118, source: 'chosen' })).toMatchObject({ ok: true, deg: 135, stated: true });
    const d = drillPointAngle(DRILL, { deg: 118, source: 'chosen' });
    expect(d).toMatchObject({ ok: true, deg: 118, stated: false });
    expect(d.ok && d.from).toContain('drill.pointAngleDeg (chosen');
    expect(drillPointAngle({ ...DRILL, angle: 30 }, { deg: 118, source: 'chosen' }).ok).toBe(false);
  });

  it('the CAM plans the point the simulator sweeps: one rule, the same point length', () => {
    const { settings, sources } = drillSettings(null);
    const plan = planDrillBit({ tool: DRILL, holes: [[5, 5]], depth: { kind: 'blind', fullDiameterDepth: 3 }, settings, pointAngleSource: sources.pointAngleDeg });
    if (!plan.ok) throw new Error(plan.reason);
    // No location: the CAM labels its angle `fallback`, exactly as the sim's info will.
    expect(plan.plan.angle.from).toContain('(fallback');
    expect(plan.plan.simDrillPoint).toEqual({ deg: 118, source: 'fallback' });
    const c = resolve(DRILL, plan.plan.simDrillPoint);
    // The sim's cone reaches the full diameter exactly a point length above the tip.
    expect(cutterReach(c, plan.plan.pointLength)).toBeCloseTo(1, 2);
    expect(plan.plan.angle.deg).toBe(118);
  });
});

describe('#382 columnCutterFor — the simulator\'s resolver, not the CAM\'s', () => {
  it('a drill is a SHARP cone bounded at its radius; the info names the angle and where it came from', () => {
    const r = columnCutterFor(DRILL, { deg: 118, source: 'chosen' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.kind).toBe('drill');
    expect(r.cutter.radius).toBe(0);
    expect(r.cutter.outerRadius).toBe(1);
    expect(r.cutter.tanHalf).toBeCloseTo(Math.tan(59 * DEG), 12);
    expect(r.diagnostics).toEqual([expect.objectContaining({ severity: 'info', code: 'drill-point-angle' })]);
    expect(r.diagnostics[0]!.message).toMatch(/118° point from the shop default drill\.pointAngleDeg \(chosen/);
    // No default handed in and none stated: refused by name — the worker reads no settings itself.
    const f = columnCutterFor(DRILL);
    expect(f.ok).toBe(false);
    expect(!f.ok && f.reason).toMatch(/no point angle.*drill\.pointAngleDeg/);
    // A stated angle needs no default.
    expect(columnCutterFor({ ...DRILL, angle: 118 }).ok).toBe(true);
    // The drill's own angle wins.
    const own = columnCutterFor({ ...DRILL, angle: 140 }, { deg: 118, source: 'chosen' });
    expect(own.ok && own.cutter.tanHalf).toBeCloseTo(Math.tan(70 * DEG), 12);
  });

  it('the drill\'s body stops the cone: nothing past its radius is ever cut, and the reach is capped there', () => {
    const c = resolve(DRILL);
    expect(surfaceAboveTip(c, 0)).toBe(0);
    expect(surfaceAboveTip(c, 0.5)).toBeCloseTo(0.5 / Math.tan(59 * DEG), 12);
    expect(surfaceAboveTip(c, 1.0001)).toBe(Infinity);
    expect(cutterReach(c, 50)).toBe(1); // an unbounded cone would reach 83 mm
  });

  it('a thread mill is its cutting-diameter cylinder, with a warning that it is an envelope', () => {
    const r = columnCutterFor(THREAD);
    if (!r.ok) throw new Error(r.reason);
    expect(r.kind).toBe('thread-envelope');
    expect(r.cutter).toEqual({ radius: 0.365, tanHalf: null });
    expect(r.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', code: 'thread-envelope' })]);
    expect(r.diagnostics[0]!.message).toMatch(/shank above the neck is not modelled/);
    expect(r.diagnostics[0]!.message).not.toMatch(/at least/);
  });

  it('refuses by name what it has no geometry for — and never invents it', () => {
    // A box-code thread mill (`C1-BIT-THREAD-M5-15`) states its thread, not its cutting diameter.
    const box = columnCutterFor({ ...THREAD, name: 'C1-BIT-THREAD-M5-15', diameter: null });
    expect(box.ok).toBe(false);
    expect(!box.ok && box.reason).toMatch(/no cutting diameter.*thread size/);
    // A box-code chamfer (`C1-BIT-CHAMFER-90`) states no tip: refused as #405 refuses it, not a guessed point.
    expect(columnCutterFor({ ...CHAMFER, tipDiameter: null }).ok).toBe(false);
    expect(columnCutterFor({ ...DRILL, tipDiameter: null, diameter: null }).ok).toBe(false);
    expect(columnCutterFor({ ...DRILL, angle: 200 }, SHOP).ok).toBe(false);
    // A ball nose now simulates on the dexel (#532, #222 slice A) — its admission is covered in
    // simBallBullDexel.spec. A flat end mill that merely carries a corner radius is NOT a declared
    // bull nose (shape 'bull'), so it stays refused by cuttingForTrace's capsule rule.
    expect(columnCutterFor({ ...flatEndMill(2), shape: 'ball', typeText: 'Ball' }).ok).toBe(true);
    expect(columnCutterFor(flatEndMill(2, { cornerRadius: 0.2 })).ok).toBe(false);
  });

  it('routes drills and thread mills to the column engine; a flat end mill still goes to the exact sweeper', () => {
    expect(sweepsOnColumn(DRILL)).toBe(true);
    expect(sweepsOnColumn(THREAD)).toBe(true);
    expect(sweepsOnColumn(CHAMFER)).toBe(true);
    expect(sweepsOnColumn(flatEndMill(2))).toBe(false);
  });
});

describe('#382 known volumes on the flat column engine', () => {
  it('a drill plunge removes the cylinder plus its point cone — π R² (T − L) + π R² L / 3', () => {
    for (const deg of [118, 90, 140]) {
      const c = resolve(DRILL, { deg, source: 'chosen' });
      const R = 1;
      const L = R / Math.tan((deg / 2) * DEG);
      const T = 3;
      const analytic = Math.PI * R * R * (T - L) + (Math.PI * R * R * L) / 3;
      const v = plungeVolume(c, -T);
      expect(v / analytic).toBeGreaterThan(0.98);
      expect(v / analytic).toBeLessThan(1.02);
      // NOT the flat stand-in: a flat end mill at the tip would take the whole cylinder π R² T.
      expect(v).toBeLessThan(Math.PI * R * R * T * 0.98);
    }
  });

  it('a drill whose tip is still inside its point removes only the cone — π r² h / 3', () => {
    const c = resolve(DRILL, { deg: 90, source: 'chosen' });
    // 90°: the point is 1 mm long. Half of it into the stock: a cone of radius 0.5, height 0.5.
    const v = plungeVolume(c, -0.5, 0.01);
    const analytic = (Math.PI * 0.25 * 0.5) / 3;
    expect(v / analytic).toBeGreaterThan(0.97);
    expect(v / analytic).toBeLessThan(1.03);
  });

  it('a chamfer plunge removes the frustum — π d (r₀² + r₀ r₁ + r₁²) / 3', () => {
    const c = resolve(CHAMFER);
    expect(c.tanHalf).toBeCloseTo(1, 12); // 90° INCLUDED, so 45° from the axis
    const d = 1;
    const r0 = 0.05;
    const r1 = r0 + d * 1;
    const analytic = (Math.PI * d * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
    const v = plungeVolume(c, -d);
    expect(v / analytic).toBeGreaterThan(0.98);
    expect(v / analytic).toBeLessThan(1.02);
  });

  it('a thread-mill envelope plunge removes the cylinder — π R² d', () => {
    const c = resolve(THREAD);
    const d = 3;
    const analytic = Math.PI * 0.365 * 0.365 * d;
    const v = plungeVolume(c, -d, 0.01);
    expect(v / analytic).toBeGreaterThan(0.97);
    expect(v / analytic).toBeLessThan(1.03);
  });
});

/** The rotary refusal needs only a timeline's shape (`columnEngine.spec.ts`'s minimal fake). */
function rotaryTimeline(): Timeline {
  const m: CutMove = { step: 0, line: 1, u0: 0, u1: 0, v0: 0, v1: 360, z: 5 };
  return {
    events: [{ kind: 'move', mode: 'cut', line: 1 }] as unknown as Timeline['events'],
    airMoves: [],
    segments: [],
    pauses: [],
    checkpoints: [{ segment: 0, tool: 1, zKey: 5000, z: 5, run: 0, zs: [5, 5], steps: [0], xy: [0, 0, 0, 0], nonConstantZ: false }],
    diagnostics: [],
    stateAt: () => ({ a: m.v1 }) as ReturnType<Timeline['stateAt']>,
    summary: { steps: 1, segments: 1, pauses: 0, checkpoints: 1, cuttingMoves: 1, unsweptMoves: 0, airMoves: 0, laser: false, rotary: true, diagnosticCounts: {} },
  };
}

describe('#382 the rotary engine stays flat-end only', () => {
  it('refuses a drill and a thread mill on a rotary job by name', () => {
    const cyl = stubSetup({ kind: 'cylinder', diameter: 20, length: 30 }, { kind: 'rotary-chuck', jawDiameter: 25, stickout: 30 });
    for (const [tool, word] of [
      [DRILL, /a drill/],
      [THREAD, /a thread mill/],
    ] as const) {
      const out = columnSweep(rotaryTimeline(), tool, cyl, { drillPointDefault: SHOP });
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.diagnostics[0]?.code).toBe('tool-refused');
      expect(out.diagnostics[0]?.message).toMatch(word);
    }
  });
});

describe('#382 end to end: a #434 peck-drilling program through the session', () => {
  const STOCK = { length: 40, width: 30, thickness: 6 };
  const HOLES: [number, number][] = [
    [30, 20],
    [10, 10],
    [30, 10],
  ];
  const setup = stubSetup({ kind: 'prism', outline: rectProfile(40, 30), thickness: 6 }, { kind: 'tape-down', contact: rectProfile(40, 30) }, { startingTool: 1 }, Z1);
  const { settings, sources } = drillSettings(null);
  const program = (tool: Tool): { text: string; tipDepth: number; point: { deg: number; source: string } } => {
    const r = drillBitIR({ tool, holes: HOLES, depth: { kind: 'blind', fullDiameterDepth: 3 }, settings, pointAngleSource: sources.pointAngleDeg, stock: STOCK, name: '[T1]Holes', labelId: 'holes', air: true, rapid: Z1.rapidEstimate });
    if (!r.ok) throw new Error(r.reason);
    const p = postZ1(r.ir, { jobName: 'holes', stock: STOCK, materialName: 'PLA', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:kz-drill-2' }, Z1);
    if (!p.ok) throw new Error(p.errors.join('; '));
    return { text: p.text, tipDepth: r.plan.tipDepth, point: r.plan.simDrillPoint };
  };
  const disc = (cx: number, cy: number, r: number): OraclePolygon => Array.from({ length: 256 }, (_, i) => [cx + r * Math.cos((i / 256) * 2 * Math.PI), cy + r * Math.sin((i / 256) * 2 * Math.PI)] as [number, number]);

  it('lands on the column engine, the peck re-entries are not gouges, the volume is three drilled holes, and the oracle agrees', () => {
    const { text, tipDepth, point } = program(DRILL);
    const session = createSimSession(tl);
    try {
      // The CAM's planned point is carried into the simulation, not re-read (#382 review).
      const r = session.load(text, setup, DRILL, 'Z1', { drillPointDefault: point });
      if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
      expect(r.stats.engine).toBe('column');
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain('drill-point-angle');
      expect(codes).not.toContain('rapid-through-stock');
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

      // Three holes, each a cylinder to the full-diameter depth on its 118° point.
      const L = 1 / Math.tan(59 * DEG);
      const each = Math.PI * (tipDepth - L) + (Math.PI * L) / 3;
      expect(r.stats.removedVolume / (3 * each)).toBeGreaterThan(0.97);
      expect(r.stats.removedVolume / (3 * each)).toBeLessThan(1.03);

      // The oracle, as for a V-bit: the CAM's prediction is a full-diameter disc per hole at the
      // full-diameter depth, which is where the point has opened out to the drill's radius.
      const report = session.oracle([{ depth: 3, polygons: HOLES.map(([x, y]) => disc(x, y, 1)) }]);
      expect(report.levels.length).toBe(1);
      expect(report.ok).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('the oracle catches a hole the program did not drill', () => {
    const { text, point } = program(DRILL);
    const session = createSimSession(tl);
    try {
      const r = session.load(text, setup, DRILL, 'Z1', { drillPointDefault: point });
      if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
      const report = session.oracle([{ depth: 3, polygons: [...HOLES, [20, 20] as [number, number]].map(([x, y]) => disc(x, y, 1)) }]);
      expect(report.ok).toBe(false);
      expect(report.worst.underCut).toBeGreaterThan(2); // most of a π mm² hole
    } finally {
      session.dispose();
    }
  });

  it('a box-code chamfer (no tip) is refused through the session with a message that names the tip', () => {
    const { text } = program(DRILL);
    const session = createSimSession(tl);
    const r = session.load(text, setup, { ...CHAMFER, name: 'C1-BIT-CHAMFER-90', tipDiameter: null }, 'Z1');
    expect(r.ok).toBe(false);
    const refused = r.diagnostics.find((d) => d.code === 'tool-refused');
    expect(refused?.message).toMatch(/tip/);
    session.dispose();
  });

  it('a rest pass with a drill is refused by name, and the message says drill', () => {
    const { text } = program(DRILL);
    const session = createSimSession(tl);
    const r = session.load(text, setup, DRILL, 'Z1', { drillPointDefault: SHOP, priorRemoval: { positions: new Float32Array(), indices: new Uint32Array(), vertexCount: 0, triangleCount: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] } } as never });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'prior-removal-column')?.message).toMatch(/is a drill/);
    session.dispose();
  });
});

/** A one-checkpoint flat timeline of plunges, for `columnSweep` at its own default grid. */
function flatTimeline(moves: CutMove[]): Timeline {
  const events: unknown[] = [];
  moves.forEach((_, i) => (events[i] = { kind: 'move', mode: 'cut', line: i + 1 }));
  return {
    events: events as unknown as Timeline['events'],
    airMoves: [],
    segments: [],
    pauses: [],
    checkpoints: [
      {
        segment: 0,
        tool: 1,
        zKey: Math.round((moves[0]?.z ?? 0) * 1000),
        z: moves[0]?.z ?? 0,
        run: 0,
        zs: moves.flatMap((m) => [m.z, m.z]),
        steps: moves.map((_, i) => i),
        xy: moves.flatMap((m) => [m.u0, m.v0, m.u1, m.v1]),
        nonConstantZ: false,
      },
    ],
    diagnostics: [],
    stateAt: () => ({ a: null }) as unknown as ReturnType<Timeline['stateAt']>,
    summary: { steps: moves.length, segments: 1, pauses: 0, checkpoints: 1, cuttingMoves: moves.length, unsweptMoves: 0, airMoves: 0, laser: false, rotary: false, diagnosticCounts: {} },
  };
}

describe('#382 review: at the DEFAULT 0.1 mm grid', () => {
  // Off-grid centres, so no column happens to sit on the axis of every plunge.
  const CENTRES: [number, number][] = [
    [3.037, 3.081],
    [5.0123, 6.913],
    [7.55, 4.4321],
  ];

  it('a thread-mill envelope is never smaller than the cylinder — every true-cylinder cell is cut', () => {
    const d = 2;
    const out = columnSweep(flatTimeline(CENTRES.map(([x, y]) => plunge(x, y, -d))), { ...THREAD, fluteLength: 3 }, prism(10, 10, 8));
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.stats.resolution).toEqual({ dx: expect.any(Number), dThetaDeg: expect.any(Number) });
    const g = out.grid;
    const R = 0.365;
    // Every column whose CELL the true cylinder touches is at the floor: the envelope covers it.
    for (const [cx, cy] of CENTRES) {
      for (let j = 0; j < g.nv; j++)
        for (let i = 0; i < g.nu; i++) {
          const x = g.u0 + i * g.du;
          const y = g.v0 + j * g.dv;
          // Nearest point of the cell to the axis.
          const nx = Math.max(x - g.du / 2, Math.min(cx, x + g.du / 2));
          const ny = Math.max(y - g.dv / 2, Math.min(cy, y + g.dv / 2));
          if (Math.hypot(nx - cx, ny - cy) < R) expect(g.h[j * g.nu + i]).toBeCloseTo(-d, 5);
        }
    }
    const analytic = CENTRES.length * Math.PI * R * R * d;
    expect(out.stats.removedVolume).toBeGreaterThanOrEqual(analytic);
    expect(out.stats.removedVolume / analytic).toBeLessThan(3); // widened by half a cell, not unbounded
  });

  it('a drill at the default grid: within the grid\'s own error of the analytic volume, and the deepest column within a cell\'s cone rise of the tip', () => {
    const T = 3;
    const out = columnSweep(flatTimeline(CENTRES.map(([x, y]) => plunge(x, y, -T))), DRILL, prism(10, 10, 8), { drillPointDefault: SHOP });
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    const L = 1 / Math.tan(59 * DEG);
    const analytic = CENTRES.length * (Math.PI * (T - L) + (Math.PI * L) / 3);
    // A ⌀2 hole on a 0.1 × 0.25 grid: the cells along the rim are in or out by their centre.
    expect(out.stats.removedVolume / analytic).toBeGreaterThan(0.93);
    expect(out.stats.removedVolume / analytic).toBeLessThan(1.07);
    // The sharp tip reads shallow at a column off the axis: by at most the cone's rise over half a cell diagonal.
    const g = out.grid;
    const halfDiag = Math.hypot(g.du, g.dv) / 2;
    let deepest = Infinity;
    for (let k = 0; k < g.h.length; k++) deepest = Math.min(deepest, g.h[k] as number);
    expect(deepest).toBeGreaterThanOrEqual(-T - 1e-6);
    expect(deepest).toBeLessThan(-T + halfDiag / Math.tan(59 * DEG) + 1e-6);
  });
});

describe('#382 review: the thread mill\'s neck', () => {
  const sweep = (tool: Tool, depth: number) => {
    const out = columnSweep(flatTimeline([plunge(5, 5, -depth)]), tool, prism(10, 10, 8));
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    return out.diagnostics.map((d) => `${d.severity}:${d.code}`);
  };

  it('within the neck: only the envelope warning', () => {
    expect(sweep({ ...THREAD, fluteLength: 3 }, 2.5)).toEqual(['warning:thread-envelope']);
  });

  it('past the neck: the shank would rub, an error by the exact sweeper\'s own holder gate', () => {
    expect(sweep({ ...THREAD, fluteLength: 3 }, 4)).toContain('error:holder-collision');
    expect(sweep({ ...THREAD, fluteLength: 3, shoulderLength: 5 }, 4)).not.toContain('error:holder-collision');
  });

  it('no neck stated: a warning that the depth cannot be proven', () => {
    expect(sweep({ ...THREAD, fluteLength: null, shoulderLength: null }, 2)).toContain('warning:holder-unproven');
  });
});
