/**
 * #723 R-4 — ACCEPTANCE: a goal on a rod is cut to its CLOSED FORM.
 *
 * The design's acceptance row asks for an analytic solid of revolution swept on the rotary column
 * engine against the closed form. This runs two, through the JOB path (the generator's rotary
 * dispatch, the relief CAM, the rotary post — not the CAM module alone, which R-2 pinned):
 *
 *   1. a BARREL, r(x) = 7 + 2·sin(π·t) over 30 mm — the along-the-rod axis, every angle equal;
 *   2. a LOBED SHAFT, r(θ) = 8 + 1.2·cos(3θ) over 20 mm — the around-the-rod axis, equal along X;
 *   3. half a shaft — the covered/uncovered rule: where the goal says nothing, the stock stands.
 *
 * The swept radius is compared with the closed form at a grid of (x, θ): neither side may be off
 * by more than the ball's scallop plus the sweep's own grid sliver. That is the design's "cuts
 * what it says", measured by the same column engine the Preview and the run gate use.
 *
 * THE CORPUS PART IS NOT HERE. The design also names "the corpus relief", and no rotary relief
 * mesh is committed: the corpus' reliefs (wolf, photo) are flat jobs and its rotary jobs are
 * indexed text. It joins this suite when such a part is committed; nothing here stands in for it
 * with a fixture pretending to be one.
 *
 * The Simulate screenshots are the QA half of R-4 and are not a unit test; this suite is the
 * numeric half.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import { buildTimeline, parseGcode, stubSetup, Z1, type Setup } from '@/engine/cnc';
import { verifyProgram } from '@/engine/cnc/verify';
import { columnSweep } from '@/workers/geometry/columnEngine';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type V = [number, number, number];
type Tri = [V, V, V];

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

const TAU = Math.PI * 2;
const R = 10; // ⌀20 rod
const STICKOUT = 60;
let serial = 0;

/**
 * The side of a surface of revolution about local X, as RINGS: radius as a function of the
 * section angle and X, sampled at `rings` stations along the axis.
 *
 * RINGS MATTER. A side built from its two end rings alone is the straight taper between them —
 * exact for a cone, and a CYLINDER for any curved profile, which is how the barrel first swept as
 * a constant radius. The stations are what make a curved closed form real in the fixture.
 */
function ringedSide(radiusAt: (theta: number, x: number) => number, length: number, rings: number, seg: number): Tri[] {
  const tris: Tri[] = [];
  const at = (i: number, s: number): V => {
    const x = -length / 2 + (i / rings) * length;
    const a = (s / seg) * TAU;
    const r = radiusAt(a, x);
    return [x, r * Math.sin(a), r * Math.cos(a)];
  };
  for (let i = 0; i < rings; i++) {
    for (let s = 0; s < seg; s++) {
      tris.push([at(i, s), at(i + 1, s), at(i + 1, s + 1)], [at(i, s), at(i + 1, s + 1), at(i, s + 1)]);
    }
  }
  return tris;
}

function goal(tris: Tri[], length: number, maxRadius: number): EngraveTargetObject {
  return {
    id: 'part',
    name: 'acceptance.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'e'),
    data: stl(tris),
    size: { x: length, y: 2 * maxRadius, z: 2 * maxRadius },
    position: { x: 30, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

const BALL = flatEndMill(2, { shape: 'ball', name: '2 mm ball', fluteLength: 12, shoulderLength: 20 });

function rotaryJob(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    name: 'rotary acceptance',
    stock: { length: 100, width: 2 * R, thickness: 2 * R, material: 'pla', shape: 'cylinder', diameter: 2 * R },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: STICKOUT, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    targetObject: target,
    toolKey: 'ball-2',
  };
}

const setup = (): Setup =>
  stubSetup(
    { kind: 'cylinder', diameter: 2 * R, length: 100 },
    { kind: 'rotary-chuck', jawDiameter: 40, stickout: STICKOUT },
    { startingTool: 1 },
    Z1,
  );

interface Cut {
  /** The swept radius at a map point (mm along the rod, degrees round it). */
  at: (x: number, thetaDeg: number) => number;
  verifyErrors: string[];
  /** Grid cells whose swept radius is below the stock's own — the cut really removed material. */
  sweptCount: number;
}

/** Generate, verify and sweep one rotary relief job. */
function cutAndSweep(job: EngraveJob): Cut {
  const out = engraveGenerate(tl, job, BALL, [], null, undefined, {});
  if (!out.ok) throw new Error(out.errors.join('; '));
  const program = out.programs[0]!;
  expect(program.frame).toBe('rotary');

  // The generator posts its own text; the verifier and the sweep read exactly those bytes.
  const verified = verifyProgram(program.nc, {
    setup: setup(),
    machine: Z1,
    tool: BALL,
    depthLimit: () => 0,
    minRapidZ: 1,
    rotary: { radius: R, stickout: STICKOUT, tailstock: false },
  });
  const timeline = buildTimeline(parseGcode(program.nc), setup());
  const swept = columnSweep(timeline, BALL, setup(), { resolution: { dx: 0.5, dThetaDeg: 1 } });
  if (!swept.ok) throw new Error(JSON.stringify(swept.diagnostics));
  const g = swept.grid;
  const at = (x: number, thetaDeg: number): number => {
    const i = Math.round((x - g.u0) / g.du);
    const j = ((Math.round(thetaDeg / g.dv) % g.nv) + g.nv) % g.nv;
    return g.h[j * g.nu + i] as number;
  };
  let sweptCount = 0;
  for (let k = 0; k < g.h.length; k++) if ((g.h[k] as number) < R - 0.2) sweptCount++;
  return {
    at,
    verifyErrors: verified.findings.filter((f) => f.severity === 'error').map((f) => `${f.line} ${f.message}`),
    sweptCount,
  };
}

/** The worst cut below the goal and the worst material left above it, over a sample grid. */
function worstOff(
  at: (x: number, thetaDeg: number) => number,
  truth: (x: number, thetaDeg: number) => number,
  xFrom: number,
  xTo: number,
  step = 0.5,
  thetaStep = 5,
  thetaFrom = 0,
  thetaTo = 360,
): { gouge: number; excess: number } {
  let gouge = 0;
  let excess = 0;
  for (let x = xFrom; x <= xTo + 1e-9; x += step) {
    for (let t = thetaFrom; t < thetaTo; t += thetaStep) {
      const got = at(x, t);
      const want = truth(x, t);
      gouge = Math.max(gouge, want - got);
      excess = Math.max(excess, got - want);
    }
  }
  return { gouge, excess };
}

describe('#723 R-4 acceptance — the relief is cut to its closed form', () => {
  it('a barrel of revolution: swept radius follows r(x) along the rod', () => {
    // r(x) = 7 + 2·sin(π·t), t = (x − x0)/L, over 30 mm centred at map X 30.
    const LENGTH = 30;
    const X0 = 30;
    const rOf = (x: number): number => 7 + 2 * Math.sin(((x - (X0 - LENGTH / 2)) / LENGTH) * Math.PI);
    const job = rotaryJob(goal(ringedSide((_a, x) => rOf(X0 + x), LENGTH, 60, 144), LENGTH, 9));
    const cut = cutAndSweep(job);
    expect(cut.verifyErrors).toEqual([]);
    expect(cut.sweptCount, 'the relief actually removed material').toBeGreaterThan(1000);
    // The ball's scallop at the finishing step-over is ~0.02 mm; the 0.5 mm sweep grid adds a
    // sliver. Both sides of the closed form must be within it.
    const { gouge, excess } = worstOff(cut.at, (x) => rOf(x), X0 - LENGTH / 2 + 2, X0 + LENGTH / 2 - 2);
    expect(gouge, 'no cut below the part').toBeLessThan(0.15);
    expect(excess, 'no material left above the part').toBeLessThan(0.15);
  });

  it('a lobed shaft: swept radius follows r(θ) around the rod', () => {
    // r(θ) = 8 + 1.2·cos(3θ), equal along 20 mm of X — the around-the-rod axis and its seam.
    const LENGTH = 20;
    const X0 = 30;
    const rOf = (theta: number): number => 8 + 1.2 * Math.cos(3 * theta);
    const job = rotaryJob(goal(ringedSide((a) => rOf(a), LENGTH, 20, 144), LENGTH, 9.2));
    const cut = cutAndSweep(job);
    expect(cut.verifyErrors).toEqual([]);
    expect(cut.sweptCount).toBeGreaterThan(1000);
    const { gouge, excess } = worstOff(
      cut.at,
      (_x, t) => rOf((t * Math.PI) / 180),
      X0 - LENGTH / 2 + 2,
      X0 + LENGTH / 2 - 2,
      1,
      2,
    );
    expect(gouge, 'no cut below the part').toBeLessThan(0.15);
    expect(excess, 'no material left above the part').toBeLessThan(0.15);
  });

  it('a part that only occupies one side is left standing where the goal says nothing', () => {
    // The design's sentinel on a rod: an uncovered cell keeps the stock at r = R, and the CAM does
    // not cut there. A quarter shaft (θ ∈ [0°, 90°]) is the case that shows it.
    const LENGTH = 20;
    const X0 = 30;
    // `ringedSide` sweeps the full turn; the quarter is built directly.
    const half: Tri[] = [];
    const rings = 20;
    const seg = 36;
    const at = (i: number, s: number): V => {
      const x = -LENGTH / 2 + (i / rings) * LENGTH;
      const a = (s / seg) * (Math.PI / 2);
      const r = 8;
      return [x, r * Math.sin(a), r * Math.cos(a)];
    };
    for (let i = 0; i < rings; i++) {
      for (let s = 0; s < seg; s++) {
        half.push([at(i, s), at(i + 1, s), at(i + 1, s + 1)], [at(i, s), at(i + 1, s + 1), at(i, s + 1)]);
      }
    }
    const job = rotaryJob(goal(half, LENGTH, 8));
    const cut = cutAndSweep(job);
    expect(cut.verifyErrors).toEqual([]);
    // Cut side: the quarter at θ ∈ [0°, 90°] is at 8 mm.
    const cutSide = worstOff(cut.at, () => 8, X0 - LENGTH / 2 + 2, X0 + LENGTH / 2 - 2, 1, 5, 0, 85);
    expect(cutSide.gouge).toBeLessThan(0.15);
    // Opposite side: nothing says to cut there, so the stock is the stock.
    let untouched = true;
    for (let t = 180; t <= 270; t += 5) {
      for (let x = X0 - LENGTH / 2 + 2; x <= X0 + LENGTH / 2 - 2; x += 1) {
        if (cut.at(x, t) < R - 0.2) untouched = false;
      }
    }
    expect(untouched, 'the uncovered half of the rod is left standing').toBe(true);
  });
});
