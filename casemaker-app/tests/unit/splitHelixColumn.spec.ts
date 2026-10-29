// #753 — ACCEPTANCE: continuous 4th-axis carving, a mating split-helix column.
//
// Maintainer request 2026-10-29: a saved test for continuous A work, built on two rods split along
// a helicoid so the halves mate. Every fixture goes through the real pipeline — the program's IR →
// post → re-parse → timeline → verify → the column engine → an analytic oracle that owes nothing
// to the sweep — as `indexedRotary.spec.ts` does for the indexed faces.
//
// THE LINE-TO-LINE SPLIT IS SIMULATED, NOT RUNNABLE TODAY. The cut reaches the axis exactly (Z 0),
// and R8's verifier refuses any cutting move at or below the axis; the spec pins that sentence.
// A bounded below-axis allowance for a split operation is a DESIGN DECISION (the maintainer's, on
// #753), not something this fixture may work around.
//
// THE BOUNDARY THIS PROGRAM ACTUALLY CUTS is not an ideal diametral plane. With the tool over the
// axis (Y 0) and its tip on the axis plane, a flat end mill of radius r_t traversing X while A
// turns cuts, at each X, every column within 90° of the A swept over the cutter's own X width. For
// a helix of pitch p (degrees of A per mm of X) that removes a window of
//     180° + 2s,   s = p · r_t   (the tool-width band),
// not 180°. The half each rod keeps is therefore 180° − 2s wide, and the two pieces' material
// windows are separated by a 2s band at each of the two split edges (4s in all). The idealised
// line-to-line split is the p → 0 limit of that family; it is NAMED here as the limit, not asserted.
//
// WHY THE EXACT SPLIT IS NOT CUTTABLE TODAY — the spec lists every reason, each pinned in words:
//   R8's axis rule  — the boundary reaches the axis exactly, and a rotary cut keeps the tip above it;
//   the Y ≡ 0 rule  — a true helicoid boundary with a flat end mill needs the tool's SIDE on the
//                     split face (a Y offset of r_t), and a rotary program keeps every Y at 0.
// The spec states the boundary the program actually cuts rather than tuning it to a tidier one.
import { describe, expect, it } from 'vitest';
import { buildTimeline, parseGcode, stubSetup, Z1 } from '@/engine/cnc';
import { postZ1 } from '@/engine/cnc/post/z1';
import { verifyProgram } from '@/engine/cnc/verify';
import { flatEndMill } from '@/engine/cnc/tool';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import { columnSweep, ROTARY } from '@/workers/geometry/columnEngine';
import type { ColumnGrid } from '@/workers/geometry/columnEngine';
import { createSimSession } from '@/workers/sim/session';
import { tl } from './helpers/manifoldExec';
import { angleAtStep, rotaryAngleWords } from '@/components/viewport/rotarySimView';
import { L, PITCH, POST_CTX, R, RT, TOOL, TURNS, X0, splitIr } from './helpers/splitHelix';

const STOCK = { kind: 'cylinder' as const, diameter: 2 * R, length: L };
const HOLD = { kind: 'rotary-chuck' as const, jawDiameter: 25, stickout: L };
const setup = () => stubSetup(STOCK, HOLD, { startingTool: 1 }, Z1);
const RES = { dx: 0.25, dThetaDeg: 1 };

/** The whole named pipeline for one piece. Throws on a post/parse failure only; refusals are data. */
function run(ir: ToolpathIR, rotaryClass: 'wrapped' | 'indexed' = 'wrapped') {
  const posted = postZ1(ir, POST_CTX, Z1);
  if (!posted.ok) throw new Error(`the post refused ${ir.operations[0]?.name ?? 'a piece'}: ${posted.errors.join('; ')}`);
  const timeline = buildTimeline(parseGcode(posted.text), setup());
  expect(timeline.summary.rotary).toBe(true);
  expect(timeline.summary.rotaryClass).toBe(rotaryClass);
  const verified = verifyProgram(posted.text, {
    setup: setup(),
    machine: Z1,
    tool: TOOL,
    depthLimit: () => 0,
    minRapidZ: 1,
    rotary: { radius: R, stickout: L, tailstock: false },
  });
  const swept = columnSweep(timeline, TOOL, setup(), { resolution: RES });
  return { ir, posted, timeline, verified, swept };
}

const pipeline = (offset: number, z = 0) => run(splitIr(offset, z));

const removed = (grid: ColumnGrid, i: number, j: number): boolean =>
  (grid.h[j * grid.nu + i] as number) < grid.initial - 1e-6;
const kept = (grid: ColumnGrid, i: number, j: number): boolean =>
  (grid.h[j * grid.nu + i] as number) > 1e-6;

/** The X index nearest a work X. */
const indexAt = (grid: ColumnGrid, x: number): number => Math.round((x - grid.u0) / grid.du);

/**
 * The angular window the PROGRAM removes at X, from the moves and the cutter radius alone — the
 * analytic oracle for the column engine's material, owing nothing to the engine's code.
 *
 * Each cutting segment from (x0, A0) to (x1, A1) removes every column within r_t of its X span and
 * within 90° of its swept A interval — that is the flat end mill's disc at the axis plane. On the
 * circle the window is `[Amin − 90°, Amax + 90°]`, i.e. 180° plus the segment's own A span.
 */
function analyticRemovedDeg(moves: readonly CamMove[], x: number): number {
  let count = 0;
  for (let deg = 0; deg < 360; deg++) {
    let hit = false;
    for (let i = 1; i < moves.length && !hit; i++) {
      const m0 = moves[i - 1] as CamMove;
      const m1 = moves[i] as CamMove;
      if (m1.kind !== 'feed') continue;
      const lo = Math.min(m0.x, m1.x) - RT;
      const hi = Math.max(m0.x, m1.x) + RT;
      if (x < lo || x > hi) continue;
      const aLo = m0.a ?? 0;
      const aHi = m1.a ?? 0;
      const centre = (aLo + aHi) / 2;
      const half = 90 + Math.abs(aHi - aLo) / 2;
      const off = (((deg - centre) % 360) + 360) % 360;
      if (off <= half || off >= 360 - half) hit = true;
    }
    if (hit) count++;
  }
  return count;
}

/**
 * One column's facts across the two pieces at X, in degrees on the 1° grid. The two split edges
 * are the 180° window's sides: A = pitch·(x − X0) ± 90° (with the tool-width band they straddle
 * ±s). The both-cut cells are split between them, so the band at ONE edge (2s) is reported beside
 * the total (4s).
 */
function matingAt(
  gridA: ColumnGrid,
  gridB: ColumnGrid,
  x: number,
  pitch: number,
): { gap: number; edgeBands: [number, number]; bOutsideA: number; aOutsideB: number } {
  const i = indexAt(gridA, x);
  const centre = (((pitch * (x - X0) - 90) % 360) + 360) % 360;
  const other = (centre + 180) % 360;
  const arc = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  let gap = 0;
  let bOutsideA = 0;
  let aOutsideB = 0;
  const edgeBands: [number, number] = [0, 0];
  for (let j = 0; j < gridA.nv; j++) {
    const aRem = removed(gridA, i, j);
    const bRem = removed(gridB, i, j);
    if (aRem && bRem) {
      gap++;
      const ang = j * gridA.dv;
      if (arc(ang, centre) <= 45) edgeBands[0]++;
      else if (arc(ang, other) <= 45) edgeBands[1]++;
    }
    if (kept(gridB, i, j) && !aRem) bOutsideA++;
    if (kept(gridA, i, j) && !bRem) aOutsideB++;
  }
  return { gap, edgeBands, bOutsideA, aOutsideB };
}

const pieceMoves = (piece: { ir: ToolpathIR }): CamMove[] => piece.ir.operations[0]!.moves;

describe('#753 split-helix column, line-to-line (simulated; the verifier refuses the axis reach)', () => {
  it('cuts a continuous-A helicoid whose material matches the program geometry', () => {
    const a = pipeline(0);
    const b = pipeline(180);
    // The program is continuous A with X, over the axis: every cutting move states A and Y 0.
    for (const op of a.ir.operations) {
      for (const m of op.moves) {
        if (m.kind === 'feed') {
          expect(m.y).toBe(0);
          expect(typeof m.a).toBe('number');
        }
      }
    }
    // R8's verifier refuses the exact axis reach — pinned, not worked around (decision A, #753).
    const axis = a.verified.findings.filter((f) => f.code === 'axis-crossing');
    expect(axis.length).toBeGreaterThan(0);
    expect(axis[0]!.message).toBe(
      'cuts through the centre: the cutter tip reaches the axis exactly, and a rotary cut keeps the cutter above the axis, where the floor is a radius above it — use a shallower depth or a larger diameter',
    );

    // THE COLUMN ENGINE'S MATERIAL, against the program's own geometry (the tool-width band).
    for (const piece of [a, b]) {
      if (!piece.swept.ok) throw new Error(JSON.stringify(piece.swept.diagnostics));
      expect(piece.swept.stats.engine).toBe('column');
      const g = piece.swept.grid;
      for (const x of [10, 15, 20]) {
        const i = indexAt(g, x);
        const ideal = analyticRemovedDeg(piece.ir.operations[0]!.moves, x);
        const measured = Array.from({ length: g.nv }, (_, j) => (removed(g, i, j) ? 1 : 0)).reduce<number>((s, v) => s + v, 0);
        // The engine's per-column window is the program's own, within one angular cell.
        expect(Math.abs(measured - ideal), `x ${x}: measured ${measured}° against ${ideal}°`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('the removed volume is the closed form of the program’s own window', () => {
    for (const offset of [0, 180]) {
      const piece = pipeline(offset);
      if (!piece.swept.ok) throw new Error(JSON.stringify(piece.swept.diagnostics));
      const g = piece.swept.grid;
      // The analytic fraction: the program's window at every X column, integrated over the grid's
      // own X domain and divided by the stock — no sweep number in the oracle.
      const moves = piece.ir.operations[0]!.moves;
      let windowSum = 0;
      for (let i = 0; i < g.nu; i++) windowSum += analyticRemovedDeg(moves, g.u0 + i * g.du);
      const volume = ROTARY.volume(g);
      // The grid these fixtures sweep, as measured: 10579.313 mm³ of stock, 4660.993 mm³ removed
      // per piece at either offset (each holds half the stock's 360° and the tool removes the
      // other half plus the band). The band is the closed-form check's own 1 %.
      expect(volume.stock, `offset ${offset}: stock ${volume.stock}`).toBeCloseTo(10579.313, 1);
      expect(volume.removed, `offset ${offset}: removed ${volume.removed}`).toBeCloseTo(4660.993, 1);
      const predicted = (windowSum / g.nu / 360) * volume.stock;
      const got = volume.removed;
      const err = Math.abs(got - predicted) / predicted;
      expect(err, `offset ${offset}: removed ${got.toFixed(2)} against ${predicted.toFixed(2)} (${(err * 100).toFixed(2)} %)`).toBeLessThan(0.01);
    }
  });

  it('mates as complements, with the tool-width band stated as the measured gap', () => {
    // Two pitches, the two the acceptance measured. For each, s = p·r_t:
    //   p 18°/mm: s 28.58° (4.99 mm of surface arc at R); 2s 57.15° (9.98 mm); 4s 114.3° (19.95 mm)
    //   p  4°/mm: s  6.35° (1.11 mm);                  2s 12.70° (2.22 mm); 4s  25.4°  (4.43 mm)
    // 2s is the band one split edge cuts away; 4s is the band BOTH pieces cut (2s at each edge).
    const surfaceMm = (deg: number): number => (deg * Math.PI * R) / 180;
    for (const pitch of [PITCH, 4]) {
      const s = pitch * RT;
      expect(2 * s).toBeCloseTo(pitch === PITCH ? 57.15 : 12.7, 1);
      expect(surfaceMm(4 * s)).toBeCloseTo(pitch === PITCH ? 19.95 : 4.43, 1);
      const a = run(splitIr(0, 0, pitch));
      const b = run(splitIr(180, 0, pitch));
      if (!a.swept.ok || !b.swept.ok) throw new Error('a split sweep was refused');
      const gA = a.swept.grid;
      const gB = b.swept.grid;
      for (const x of [10, 15, 20]) {
        const m = matingAt(gA, gB, x, pitch);
        // B's material lies inside A's cut and A's inside B's — the complement, column by column.
        expect(m.bOutsideA, `p ${pitch} x ${x}: B material outside A's cut`).toBe(0);
        expect(m.aOutsideB, `p ${pitch} x ${x}: A material outside B's cut`).toBe(0);
        // At each split edge the band both pieces cut away is 2s, within the grid cell and chord.
        for (const [k, band] of m.edgeBands.entries()) {
          expect(
            Math.abs(band - 2 * s),
            `p ${pitch} x ${x} edge ${k + 1}: band ${band}° (${surfaceMm(band).toFixed(2)} mm) against 2s ${(2 * s).toFixed(2)}°`,
          ).toBeLessThanOrEqual(2);
        }
        // The two edges together: 4s.
        expect(m.gap).toBe(m.edgeBands[0] + m.edgeBands[1]);
        expect(Math.abs(m.gap - 4 * s), `p ${pitch} x ${x}: gap ${m.gap}° against 4s ${4 * s}°`).toBeLessThanOrEqual(4);
        // ...and it is the program's own window at this X: `2·W(x) − 360`, within a cell.
        const expectedGap = 2 * analyticRemovedDeg(pieceMoves(a), x) - 360;
        expect(Math.abs(m.gap - expectedGap), `p ${pitch} x ${x}: gap ${m.gap}° against ${expectedGap}°`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('the path carries the turn: the sim reads A 0° · 1 turn at the end', () => {
    const piece = pipeline(0);
    const session = createSimSession(tl);
    const loaded = session.load(piece.posted.text, setup(), TOOL, null);
    // The column engine represents this cut (the VERIFIER is the refusal above), so the session is
    // material-backed and the path's A is continuous.
    expect(loaded.ok).toBe(true);
    const path = session.simPath();
    expect(path.a).toBeDefined();
    const last = path.a![path.a!.length - 1] as number;
    expect(last).toBeCloseTo(360 * TURNS, 3);
    const atEnd = angleAtStep(path, Math.max(...Array.from(path.step)));
    expect(atEnd).not.toBeNull();
    expect(rotaryAngleWords(atEnd as number)).toBe('A 0° · 1 turn');
    session.dispose();
  });

  /**
   * #753 part 2 / #723 — THE PINS. Each expected-fail names the exact sentence the pipeline says
   * today and the issue that will turn it green. They are ordinary assertions on the words, not
   * `it.fails`: a sentence that changes should fail loudly here rather than silently pass.
   */
  it('PIN the clearance version: 0.05 mm past the axis is refused by the verifier (#753 part 2)', () => {
    const piece = pipeline(0, -0.05);
    const axis = piece.verified.findings.filter((f) => f.code === 'axis-crossing');
    expect(axis.length).toBeGreaterThan(0);
    expect(axis[0]!.message).toBe(
      'cuts through the centre: the cutter tip reaches 0.05 mm past the axis, and a rotary cut keeps the cutter above the axis, where the floor is a radius above it — use a shallower depth or a larger diameter',
    );
    // The column engine itself takes the shallow dip (clamped to the axis) — the refusal is the
    // VERIFIER's, and a bounded below-axis allowance for a split operation is a design decision.
    if (!piece.swept.ok) throw new Error('the clearance sweep was refused by the engine');
    expect(piece.swept.diagnostics.some((d) => d.code === 'axis-clamped')).toBe(true);
  });

  it('PIN the nested cage-and-core: undercuts behind the bars need a cut through the axis (#753 part 3)', () => {
    const piece = pipeline(0, -3);
    // The verifier's sentence for a cut 3 mm past the axis...
    const axis = piece.verified.findings.filter((f) => f.code === 'axis-crossing');
    expect(axis[0]!.message).toBe(
      'cuts through the centre: the cutter tip reaches 3 mm past the axis, and a rotary cut keeps the cutter above the axis, where the floor is a radius above it — use a shallower depth or a larger diameter',
    );
    // ...and the column engine refuses the crossing at its first crossing move, in the sim's words.
    if (piece.swept.ok) throw new Error('the cage sweep was not refused');
    const crossing = piece.swept.diagnostics.find((d) => d.code === 'axis-crossing');
    expect(crossing?.message).toMatch(
      /^Move \d+ cuts through the centre: the cutter tip reaches 3 mm past the axis\. The simulation stops there; the moves after it are drawn, not simulated\.$/,
    );
  });

  // #763 — the ball and V micro-finishes SWEEP on the rotary engine now: a ball is a sphere cap at
  // the tip and a V a cone, over the same columns as the flat's disc. (This was the R-UI-12 pin
  // that refused both.)
  it('the ball and V micro-finishes sweep on the rotary column engine (#763)', () => {
    const piece = pipeline(0, 5); // a pass above the axis
    const ball = flatEndMill(3.175, { name: 'Ball nose 3.175 mm', shape: 'ball' });
    const ballOut = columnSweep(piece.timeline, ball, setup(), { resolution: RES });
    expect(ballOut.ok, JSON.stringify(ballOut.ok ? [] : ballOut.diagnostics)).toBe(true);
    const v = flatEndMill(0.3, { name: '30° engraving bit', typeText: 'Engraving', shape: 'engraving', tipDiameter: 0.3, halfAngle: 15, angle: 30 });
    const vOut = columnSweep(piece.timeline, v, setup(), { resolution: RES });
    expect(vOut.ok, JSON.stringify(vOut.ok ? [] : vOut.diagnostics)).toBe(true);
  });

  it('PIN the Y ≡ 0 rule: a true helicoid boundary with a flat end mill needs the cutter off the axis', () => {
    // The tool's SIDE has to run on the split face: Y offset by r_t to one side of the axis line.
    // A rotary program cannot say that today; the post refuses the off-axis move in exact words...
    const base = splitIr(0, 0);
    const op = base.operations[0]!;
    const offAxis: ToolpathIR = {
      ...base,
      operations: [{ ...op, moves: op.moves.map((m) => ({ ...m, y: RT })) }],
    };
    const refused = postZ1(offAxis, POST_CTX, Z1);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors[0]).toBe('move 0: Y=1.5875 is not 0; a rotary job holds the tool over the axis, so every Y is 0');
    // ...and a hand-written program that leaves the line is refused by the verifier's own sentence.
    const good = pipeline(0);
    const lines = good.posted.text.split('\n');
    const cut = lines.findIndex((l) => l.startsWith('G1 '));
    expect(cut).toBeGreaterThan(0);
    lines[cut] = `${lines[cut]} Y1.588`;
    const verified = verifyProgram(lines.join('\n'), {
      setup: setup(),
      machine: Z1,
      tool: TOOL,
      depthLimit: () => 0,
      minRapidZ: 1,
      rotary: { radius: R, stickout: L, tailstock: false },
    });
    const off = verified.findings.filter((f) => f.code === 'rotary-y-off-axis');
    expect(off.length).toBeGreaterThan(0);
    expect(off[0]!.message).toBe(
      'leaves the line over the axis (Y 1.588 mm): a rotary program keeps the cutter over the axis, and every Y is 0',
    );
  });

  it('PIN the 3D relief on the rotary: the relief program is flat and the rod refuses it (#723)', () => {
    // A relief's ball-finished raster is a FLAT 3D program today (no rotary wrap exists — #723).
    const tool = flatEndMill(3.175, { name: 'Ball nose 3.175 mm', shape: 'ball' });
    const ir: ToolpathIR = {
      frame: 'flat',
      tool,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      safeZ: 3,
      hopZ: 1,
      operations: [
        {
          number: 1,
          name: 'relief raster',
          labelId: '',
          depth: 1,
          estimatedSeconds: 5,
          moves: [
            { kind: 'rapid', x: 10, y: 5, z: 3 },
            { kind: 'feed', x: 10, y: 5, z: -0.5, f: 200 },
            { kind: 'feed', x: 30, y: 5, z: -0.8, f: 400 },
            { kind: 'feed', x: 30, y: 15, z: -0.8, f: 400 },
            { kind: 'feed', x: 10, y: 15, z: -0.6, f: 400 },
            { kind: 'rapid', x: 10, y: 15, z: 3 },
          ],
        },
      ],
    };
    const posted = postZ1(ir, { ...POST_CTX, zDatum: 'probed-top-face' }, Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    const session = createSimSession(tl);
    const loaded = session.load(posted.text, setup(), tool, null);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    // The rod is not the prism a flat program sweeps: the column engine's own words name the gap.
    const flatStock = loaded.diagnostics.find((d) => d.code === 'flat-stock');
    expect(flatStock?.message).toBe("the flat column engine sweeps a prism stock; the setup's part is a cylinder");
    session.dispose();
  });
});
