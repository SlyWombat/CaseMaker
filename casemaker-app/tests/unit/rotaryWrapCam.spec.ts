/**
 * The rotary WRAP pipeline, end to end (#240 slice 2, design `rotary-flow.md` §3.7–§3.9, §4).
 *
 * The acceptance fixture is the design's own (§7 W): **Name on a dowel** — PLA rod ⌀20 × 100,
 * reverse jaws, grip 15, tailstock in, `Engrave text "Zoomba"` 0.5 mm, reads along, centred at
 * 180°, ⌀1 mm flat end, every default. It must generate, verify, simulate on the column engine
 * and match the design — with the design's golden numbers pinned: 15.708 mm of arc = A 90°,
 * the opening is 0.526 mm around (0.5 · 10/9.5's linear form; 0.52583 exact) against 0.5 mm
 * along X, and the facet term is 0.013 mm.
 *
 * The non-happy rows the design names sit beside it: an item into the jaws' band and into the
 * tailstock's band (each at the row, in the operator's words), a depth at and past the axis, a
 * band across the seam, a cut class the wrap does not cut, and a V-bit (refused by the column
 * engine, as today). The ⌀6 rod fixture is the coordinator's addition: it makes the FACET term
 * load-bearing — the oracle passes there only because the allowance is derived from the run's
 * own Z_t and r_t, never hand-set.
 *
 * CODES ARE DATA. Every refusal is asserted on the operator's sentence; the internal code is
 * read from the finding's `code` field and never appears in the message. The sim loads here
 * speak to a real Manifold toplevel: this is the geometry file, not a unit stub.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { defaultEngraveJob, newEngraveLabelId } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup } from '@/engine/cnc/setup';
import { ROTARY, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import { engraveGenerate, type EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';
import {
  angleToArc,
  arcToAngle,
  aroundOpeningRadius,
  facetTerm,
  rotaryMapOf,
  type RotaryMap,
} from '@/engine/cnc/rotary/wrap';
import type { EngraveJob, EngraveShape, RotaryChuck } from '@/types/engraveJob';

const CODE =
  /axis-crossing|rotary-y-off-axis|wrap-into-clamp|rotary-rapid-engaged|stock-exceeds-module|rotary-unsupported/;

const CHUCK: RotaryChuck = {
  stickout: 85,
  gripDiameter: null,
  jawMode: 'reverse-inner',
  tailstock: true,
  source: 'test',
};

/** The design's starter — every default but the name, the stock and the holding. */
function dowel(over: Partial<EngraveJob> = {}, label: Partial<EngraveJob['labels'][number]> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'Zoomba on a dowel',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: { kind: 'rotary-chuck', rotary: { ...CHUCK } },
    labels: [
      {
        id: newEngraveLabelId(),
        text: 'Zoomba',
        font: DEFAULT_FONT_ID,
        weight: 'bold',
        size: 5,
        position: { x: 42.5, y: Math.PI * 10 }, // centred at 180°
        rotation: 0,
        depth: 0.5,
        enabled: true,
        ...label,
      },
    ],
    shapes: [],
    toolKey: 'flat-1.0',
    ...over,
  };
}

/** The coordinator's facet fixture: a ⌀6 rod where the 3.175 mm flat's edge rise matters. */
const THIN_RECT: EngraveShape = {
  id: 'shp-1',
  kind: 'rect',
  position: { x: 25, y: Math.PI * 3 },
  rotation: 0,
  depth: 0.5,
  enabled: true,
  width: 10,
  height: 6,
  cornerRadius: 0,
};

function thinRod(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'facet on a thin rod',
    stock: { length: 60, width: 6, thickness: 6, material: 'pla', shape: 'cylinder', diameter: 6 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 50, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [{ ...THIN_RECT }],
    // The registry's only 3.175 mm flat; the cutter actually handed to the CAM is the plain one
    // below (its name does not say Metal, so the metal-line guard does not apply).
    toolKey: 'flat-3.175x12-metal',
  };
}

const THIN_TOOL = flatEndMill(3.175, { name: '3.175 mm flat end', handleDiameter: 3.175 });
const THIN_CUTTER: ColumnCutter = { radius: 1.5875, tanHalf: null };

// ---- Reading a rotary program's words -------------------------------------------

interface NcWords {
  /** Machine lines only: no `%`, no `;` comments. */
  lines: string[];
  allY: number[];
  allA: number[];
  /** A words on lines in G1 mode with the spindle on — the cut's own A. */
  cutA: number[];
  /** Z words on cutting lines: the floors the program actually cuts at. */
  cutZ: number[];
  /** F words on cutting lines. */
  cutF: number[];
  /** Distinct F words anywhere in the file. */
  feeds: number[];
  zWords: number[];
}

/**
 * A modal word walker: G0/G1 set the mode and M3/M5 the spindle, so a line with no G word is
 * still read as the mode it inherited — which is how the post writes (modal, #187).
 */
function readNc(text: string): NcWords {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== '%' && !l.startsWith(';'));
  const allY: number[] = [];
  const allA: number[] = [];
  const cutA: number[] = [];
  const cutZ: number[] = [];
  const cutF: number[] = [];
  const feeds: number[] = [];
  const zWords: number[] = [];
  let feed = false;
  let spindle = false;
  for (const line of lines) {
    const words = line.toUpperCase().match(/[A-Z][-+]?\d*\.?\d*/g) ?? [];
    for (const w of words) {
      if (w === 'G0' || w === 'G00') feed = false;
      else if (w === 'G1' || w === 'G01') feed = true;
      else if (w === 'M3') spindle = true;
      else if (w === 'M5') spindle = false;
    }
    const cutting = feed && spindle;
    for (const w of words) {
      const v = Number(w.slice(1));
      switch (w[0]) {
        case 'Y':
          allY.push(v);
          break;
        case 'A':
          allA.push(v);
          if (cutting) cutA.push(v);
          break;
        case 'Z':
          zWords.push(v);
          if (cutting) cutZ.push(v);
          break;
        case 'F':
          feeds.push(v);
          if (cutting) cutF.push(v);
          break;
      }
    }
  }
  return { lines, allY, allA, cutA, cutZ, cutF, feeds, zWords };
}

/** Load `g`'s program in a fresh session, through the setup the job itself builds. */
function loadAndOracle(job: EngraveJob, g: EngraveGenerated): { load: SimLoadOk; report: OracleReport } {
  const tool = jobTool(job) ?? THIN_TOOL;
  const session = createSimSession(tl);
  const r = session.load(g.nc ?? '', toSetup(job, Z1), tool, Z1.id);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`the program did not load: ${JSON.stringify(r.diagnostics)}`);
  const report = session.oracle(g.predicted);
  session.dispose();
  return { load: r, report };
}

// ---- The acceptance fixture -----------------------------------------------------

describe('Name on a dowel (#240 slice 2, design §7 W)', () => {
  const job = dowel();
  // One generation for the whole block: the pipeline is the thing under test, and its five
  // readings below are five questions about ONE result, not five runs.
  let cached: EngraveGenerated | null = null;
  const gen = (): EngraveGenerated => (cached ??= generate(tl, job));

  it('generates, verifies and posts one rotary program', () => {
    const g = gen();
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.frame).toBe('rotary');
    expect(g.verify?.ok).toBe(true);
    // The only non-info finding is the 1 mm cutter losing detail — a warning, not a refusal.
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.findings.filter((f) => f.severity === 'warning').map((f) => f.code)).toEqual(['item-detail-lost']);
    expect(g.nc).not.toBeNull();
  });

  it('is the map’s frame: radius in the header, Y always 0, A from the surface arc', () => {
    const g = gen();
    const nc = g.nc ?? '';
    expect(nc.startsWith('%\nG17 G21 G54 G90\n')).toBe(true);
    expect(nc).toContain(';@CM|ROTARY|radius=10');

    const w = readNc(nc);
    expect(w.allY.length).toBeGreaterThan(0);
    expect(w.allY.every((y) => y === 0)).toBe(true); // R1: over the axis, every Y is 0

    // The label is centred at π·R = 31.4159 mm, which is A 180°; its strokes run ±~12°.
    expect(w.cutA.length).toBeGreaterThan(0);
    const lo = Math.min(...w.cutA);
    const hi = Math.max(...w.cutA);
    expect(lo).toBeGreaterThan(165);
    expect(hi).toBeLessThan(195);
    expect((lo + hi) / 2).toBeCloseTo(180, 0);
    expect(Math.max(...w.cutA.map(Math.abs))).toBeLessThan(360); // unwound, one turn at most
  });

  it('cuts floors at R − d = 9.5 and keeps the CAM’s own feeds (R12)', () => {
    const g = gen();
    const w = readNc(g.nc ?? '');
    // Every cutting Z is at or above the floor a 0.5 mm engraving on a ⌀20 rod leaves (9.5);
    // the 9.7 entries are the entry ramps, and 9.5 is the floor the pocket cuts at.
    expect(Math.min(...w.cutZ)).toBeCloseTo(9.5, 9);
    expect(w.cutZ.every((z) => z >= 9.5 - 1e-9)).toBe(true);
    // F is the resolved plunge/cut pair, on X and A moves alike — the wrap never reprices.
    expect([...new Set(w.feeds)].sort((a, b) => a - b)).toEqual([200, 500]);
    expect(new Set(w.cutF)).toEqual(new Set([200, 500]));
  });

  it('ends the way the rotary dialect ends', () => {
    const g = gen();
    const tail = (g.nc ?? '').trimEnd().split('\n').slice(-5);
    expect(tail).toEqual(['G0 Z15', 'G92.4A0S0', 'M9', 'M5', 'M30']);
  });

  it('simulates on the column engine and matches the design, at the derived band', () => {
    const g = gen();
    const { load, report } = loadAndOracle(job, g);
    expect(load.summary.rotary).toBe(true);
    expect(load.stats.engine).toBe('column');
    const res = load.stats.resolution;
    expect(res).toBeDefined();
    expect(res?.dx).toBeCloseTo(0.1, 12);
    expect(res?.dThetaDeg).toBeCloseTo(0.25, 12);

    expect(report.frame).toBe('work');
    expect(report.ok).toBe(true);
    expect(report.levels).toHaveLength(1);
    expect(report.levels[0]!.z).toBeCloseTo(-0.5, 12);
    expect(report.levels[0]!.underCut).toBe(0);
    expect(report.levels[0]!.overCut).toBe(0);

    // The band is ONE GRID CELL (the map's pitch) plus the floor's facet term — derived, never
    // hand-set. At Z_t = 9.5 and r_t = 0.5 the facet is 0.0131488 mm; with this grid's 0.1 mm ×
    // 0.25° the band is 0.0677012 mm — the design's "within 0.1 mm × 0.25° and 0.013 mm".
    const du = res?.dx ?? 0;
    const dv = res?.dThetaDeg ?? 0;
    const cellBand = Math.hypot(du, angleToArc(dv, 10)) / 2;
    expect(report.band).toBeCloseTo(cellBand + facetTerm(9.5, 0.5), 12);
    expect(report.band).toBeCloseTo(0.0677012, 7);
  });

  it('pins the design’s golden numbers', () => {
    // Arc ↔ A: 15.708 mm of arc is 90° at R = 10 (π·R/2), and the label's centre is 180°.
    expect(angleToArc(90, 10)).toBeCloseTo(15.708, 3);
    expect(arcToAngle(Math.PI * 10, 10)).toBe(180);

    // The opening is anisotropic: 0.526 mm around against 0.5 mm along X.
    expect(aroundOpeningRadius(0.5, 10, 0.5)).toBeCloseTo(0.526, 3);
    expect(aroundOpeningRadius(0.5, 10, 0.5)).toBeGreaterThan(0.5);

    // The facet term: √(Z_t² + r_t²) − Z_t at the floor radius 9.5.
    expect(facetTerm(9.5, 0.5)).toBeCloseTo(0.013, 3);
  });
});

// ---- The seam -------------------------------------------------------------------

describe('a band across the seam is ONE continuous unwrapped A', () => {
  const job = dowel({}, { position: { x: 42.5, y: 0 } });
  let cached: EngraveGenerated | null = null;
  const gen = (): EngraveGenerated => (cached ??= generate(tl, job));

  it('generates a region on both sides of A = 0 and posts both signs', () => {
    const g = gen();
    expect(g.ok).toBe(true);
    expect(g.verify?.ok).toBe(true);

    const predicted = g.predicted[0];
    expect(predicted).toBeDefined();
    const ys = predicted!.polygons.flatMap((c) => c.map(([, y]) => y));
    expect(Math.min(...ys)).toBeLessThan(0);
    expect(Math.max(...ys)).toBeGreaterThan(0);

    const w = readNc(g.nc ?? '');
    expect(Math.min(...w.cutA)).toBeLessThan(-11);
    expect(Math.max(...w.cutA)).toBeGreaterThan(11);
    // UNWOUND, ONE SPAN: a wrap would put the negative strokes at ±180, not at −11.
    expect(Math.max(...w.cutA.map(Math.abs))).toBeLessThan(90);
    // And it is one continuous run of A, never a jump between the seam's two pictures.
    for (let i = 1; i < w.cutA.length; i++) {
      expect(Math.abs(w.cutA[i]! - w.cutA[i - 1]!)).toBeLessThan(180);
    }
  });

  it('matches the design across the seam — no column changed outside the region', () => {
    const g = gen();
    const { report } = loadAndOracle(job, g);
    expect(report.ok).toBe(true);
    expect(report.levels[0]!.underCut).toBe(0);
    expect(report.levels[0]!.overCut).toBe(0);
  });
});

// ---- The two end bands ----------------------------------------------------------

describe('an item that reaches a band is refused at its row', () => {
  it('runs into the jaws at the map’s left end', () => {
    // The label is 25.14 mm wide; at X = 14 its opening starts at X ≈ 1.43, inside the 3 mm
    // keep-out past the jaw face.
    const g = generate(tl, dowel({}, { position: { x: 14, y: 0 } }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.find((x) => x.code === 'wrap-into-clamp');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBeDefined();
    expect(f!.message).toContain('runs into the jaws');
    expect(f!.message).toContain('X 1.429 mm');
    expect(f!.message).toContain('first 3 mm of the stick-out');
    expect(f!.message).not.toMatch(CODE);
  });

  it('runs into the tailstock’s band only while the tailstock is in', () => {
    // At X = 63 the opening ends at X ≈ 75.57, past the tailstock's X 75–85 mm.
    const inBand = generate(tl, dowel({}, { position: { x: 63, y: 0 } }));
    const f = inBand.findings.find((x) => x.code === 'wrap-into-clamp');
    expect(f).toBeDefined();
    expect(f!.message).toContain("runs into the tailstock's band");
    expect(f!.message).toContain('X 75.571 mm');
    expect(f!.message).toContain('last 10 mm of the stick-out');
    expect(f!.message).toContain('X 75–85 mm');
    expect(f!.message).not.toMatch(CODE);

    // The same item with the tailstock out is inside the map: nothing to run into.
    const outJob = dowel({}, { position: { x: 63, y: 0 } });
    outJob.workholding = { kind: 'rotary-chuck', rotary: { ...CHUCK, tailstock: false } };
    const out = generate(tl, outJob);
    expect(out.findings.some((x) => x.code === 'wrap-into-clamp')).toBe(false);
    expect(out.ok).toBe(true);
  });
});

// ---- The axis -------------------------------------------------------------------

describe('a depth at or past the axis is refused before any toolpath', () => {
  it('says how far past the centre it reaches', () => {
    const g = generate(tl, dowel({}, { depth: 12 }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const f = g.findings.find((x) => x.code === 'axis-crossing');
    expect(f).toBeDefined();
    expect(f!.message).toContain('cuts through the centre');
    expect(f!.message).toContain('reaches 2 mm past the axis');
    expect(f!.message).toContain('use a shallower depth or a larger diameter');
    expect(f!.message).not.toMatch(CODE);
  });

  it('has its own sentence for the exact depth — the axis is not “0 mm past”', () => {
    const g = generate(tl, dowel({}, { depth: 10 }));
    const f = g.findings.find((x) => x.code === 'axis-crossing');
    expect(f).toBeDefined();
    expect(f!.message).toContain('reaches the axis exactly');
    expect(f!.message).not.toContain('0 mm past the axis');
    expect(f!.message).not.toMatch(CODE);
  });
});

// ---- Classes the wrap does not cut ----------------------------------------------

describe('a cut class the wrap does not cut is refused by name', () => {
  it('names the cut-out and gives the action', () => {
    const job = dowel();
    job.cutouts = [
      {
        kind: 'cutout',
        id: 'cut-1',
        enabled: true,
        of: 'stock-inset',
        side: 'outside',
        inset: 2,
        tabs: { count: 4, width: 4, height: 1 },
      },
    ];
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    const f = g.findings.find((x) => x.code === 'rotary-unsupported');
    expect(f).toBeDefined();
    expect(f!.message).toContain('a cut-out');
    expect(f!.message).toContain('remove that work for this job, or cut it on a flat blank');
    expect(f!.message).not.toMatch(CODE);
  });
});

// ---- The V-bit ------------------------------------------------------------------

describe('a non-flat tool on a rotary job stays refused (as today)', () => {
  it('posts, then the column engine refuses the cone by name', () => {
    const job = dowel();
    const vBit = flatEndMill(0.3, {
      name: '30° engraving bit',
      typeText: 'Engraving',
      shape: 'engraving',
      tipDiameter: 0.3,
      halfAngle: 15,
      angle: 30,
    });
    const g = engraveGenerate(tl, job, vBit, [], null);
    expect(g.frame).toBe('rotary');
    expect(g.nc).not.toBeNull();

    const session = createSimSession(tl);
    const r = session.load(g.nc ?? '', toSetup(job, Z1), vBit, Z1.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const refusal = r.diagnostics.find((d) => d.code === 'tool-refused');
    expect(refusal).toBeDefined();
    expect(refusal!.message).toContain('V-bit');
    expect(refusal!.message).toContain('30° engraving bit');
    session.dispose();
  });
});

// ---- The facet fixture ----------------------------------------------------------

describe('⌀6 rod under the 3.175 mm flat — the oracle passes because the facet is derived', () => {
  const job = thinRod();

  it('generates, verifies and cuts floors at R − d = 2.5', () => {
    const g = engraveGenerate(tl, job, THIN_TOOL, [], null);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.verify?.ok).toBe(true);
    const w = readNc(g.nc ?? '');
    expect(Math.min(...w.cutZ)).toBeCloseTo(2.5, 9);
    expect(w.allY.every((y) => y === 0)).toBe(true);
  });

  it('pins the fixture’s derived numbers', () => {
    // r_t 1.5875, Z_t = R − d = 2.5: the half-angle is atan(1.5875/2.5) ≈ 32.4°, and the floor
    // rises by the facet term at the footprint's edge.
    expect(facetTerm(2.5, 1.5875)).toBeCloseTo(0.461445, 6);
    expect(arcToAngle(aroundOpeningRadius(1.5875, 3, 0.5), 3)).toBeCloseTo(
      (Math.atan(1.5875 / 2.5) * 180) / Math.PI,
      9,
    );
    expect(aroundOpeningRadius(1.5875, 3, 0.5)).toBeCloseTo(1.697274, 6);
    // The design's linearised `r_t·R/(R − d)` would open 1.905 mm around — 12 % wider.
    expect((1.5875 * 3) / 2.5 / aroundOpeningRadius(1.5875, 3, 0.5)).toBeCloseTo(1.1224, 3);
  });

  it('the wedge’s floor past the pass is the facet term above the cut floor', () => {
    // The CAM’s outermost pass runs ALONG A at X = 28.413, ending at A 204.88. The tip’s BOTTOM is
    // flat and horizontal, so along the pass’s own A span the floor is the cut depth at any X
    // inside the tip’s radius. It is the straight bottom EDGE that lifts the floor, and only away
    // from the pass’s angle: `Z_t/cos φ` out to `φ_max = atan(r_t/Z_t)`, where it is the facet
    // term `√(Z_t² + r_t²) − Z_t` above Z_t. At Z_t = 2.5, r_t = 1.5875 that is 0.4614 mm — many
    // cell diagonals, so no cell-sized tolerance can explain the rise away.
    const setup = stubSetup(
      { kind: 'cylinder', diameter: 6, length: 60 },
      { kind: 'rotary-chuck', jawDiameter: 6, stickout: 50 },
    );
    const grid = ROTARY.buildGrid(setup, THIN_CUTTER, [], { dx: 0.05, dThetaDeg: 0.05 });
    const pass: CutMove = { step: 0, line: 1, u0: 28.413, u1: 28.413, v0: 155.12, v1: 204.88, z: 2.5 };
    ROTARY.applyMove(grid, pass, THIN_CUTTER);

    const DEG = Math.PI / 180;
    const columnAt = (x: number, aDeg: number): { a: number; rho: number } => {
      const i = Math.round((x - grid.u0) / grid.du);
      const j = Math.round((aDeg - grid.v0) / grid.dv);
      return { a: grid.v0 + j * grid.dv, rho: grid.h[j * grid.nu + i] as number };
    };

    // Under the pass — and 1.19 mm inside the region’s wall at the pass’s own angle — the flat
    // bottom leaves the cut floor: X distance inside the tip’s radius costs nothing.
    expect(columnAt(28.413, 180).rho).toBeCloseTo(2.5, 6);
    expect(columnAt(29.6, 180).rho).toBeCloseTo(2.5, 6);

    // 25° past the pass’s end, the bottom edge has lifted the floor to Z_t/cos φ.
    const off = columnAt(28.413, 204.88 + 25);
    expect(off.rho).toBeCloseTo(2.5 / Math.cos((off.a - 204.88) * DEG), 6);
    const cellBand = Math.hypot(grid.du, angleToArc(grid.dv, 3)) / 2;
    expect(off.rho - 2.5).toBeGreaterThan(5 * cellBand);

    // The last column the wedge reaches stands the facet term above the floor (within this grid’s
    // pitch — 0.05° is ~0.002 mm of rise here); past φ_max the stock is untouched.
    let highestCut = 0;
    for (let k = 0; k < grid.h.length; k++) {
      const rho = grid.h[k] as number;
      if (rho < 3 && rho > highestCut) highestCut = rho;
    }
    expect(highestCut - 2.5).toBeCloseTo(facetTerm(2.5, 1.5875), 2);
    expect(highestCut).toBeLessThan(3);
    expect(Math.atan2(1.5875, 2.5) * (180 / Math.PI)).toBeCloseTo(32.4155, 3); // φ_max
  });

  it('matches the design only because the oracle’s band carries that facet term', () => {
    const g = engraveGenerate(tl, job, THIN_TOOL, [], null);
    const tool = THIN_TOOL;
    const session = createSimSession(tl);
    const r = session.load(g.nc ?? '', toSetup(job, Z1), tool, Z1.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = session.oracle(g.predicted);
    session.dispose();

    expect(report.ok).toBe(true);
    expect(report.levels[0]!.underCut).toBe(0);
    expect(report.levels[0]!.overCut).toBe(0);

    const res = r.stats.resolution;
    expect(res).toBeDefined();
    const cellBand = Math.hypot(res?.dx ?? 0, angleToArc(res?.dThetaDeg ?? 0, 3)) / 2;
    expect(report.band).toBeCloseTo(cellBand + facetTerm(2.5, 1.5875), 12);
    // Without the facet the band would be the cell term alone (~0.050 mm) — nine times smaller
    // than the floor's own edge rise, so the fixture would report an under-cut along the wall.
    expect(report.band - cellBand).toBeCloseTo(0.461445, 6);
    expect(report.band).toBeCloseTo(0.511852, 6);
  });
});

// ---- The map the pipeline reads -------------------------------------------------

describe('the pipeline reads the same map the fixtures are written on', () => {
  it('finds a ⌀20 × 100 rod in the chuck, and the thin rod’s shorter stick-out', () => {
    const map = rotaryMapOf(dowel()) as RotaryMap;
    expect(map.radius).toBe(10);
    expect(map.circumference).toBeCloseTo(62.83185307179586, 10);
    expect(map.stickout).toBe(85);
    expect(map.grip).toBe(15);

    const thin = rotaryMapOf(thinRod()) as RotaryMap;
    expect(thin.radius).toBe(3);
    expect(thin.stickout).toBe(50);
    expect(thin.tailstock).toBe(false);
  });
});
