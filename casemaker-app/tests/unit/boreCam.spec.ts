/**
 * #668 — BORE TO SIZE: a hole wider than the cutter, helixed down its wall by a flat end mill.
 *
 * The path is three parts (`cam/drill.ts`'s `boreMoves`): the helical ramp at the wall, the
 * full-depth cleanup lap, and a floor spiral inward until the cutter's disc covers the centre.
 * The correction to this issue's first design lives here as an assertion: a helix at the wall
 * alone sweeps only an ANNULUS, so the oracle test below is the acceptance — the predicted disc at
 * the floor against the removal the helix + lap + spiral really make, in the same simulation
 * session the app runs, on a MIXED job (a pocket, a pocked drill, a trace and the bore).
 *
 * Real Manifold, real sweep, plain Node — the harness `camDrill.spec.ts` uses.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate, regions as cutRegions } from './helpers/engravePipeline';
import { createSimSession, type SimLoadOk, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { generateEngrave } from '@/engine/cnc/cam/engraveJob';
import {
  BORE_RAMP_ANGLE_FALLBACK_DEG,
  boreLevels,
  boreMoves,
  borePitchMm,
  boreRampAngleFrom,
} from '@/engine/cnc/cam/drill';
import { HOP_Z, SAFE_Z } from '@/engine/cnc/cam/ir';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { sweptCuts } from '@/engine/cnc/engrave/partPlan';
import type { EngraveDrill, EngraveJob } from '@/types/engraveJob';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

const TOOL_KEY = 'flat-3.175x12-metal';
const DRILL_TOOL = flatEndMill(3.175, {
  id: '112111313812',
  name: '3.175*12mm Flat End',
  fluteLength: 12,
  shoulderLength: 12,
});
const CUTTER_RADIUS = 3.175 / 2;

/** The feeds row a bore runs with: the softwood flat-end numbers, with the step-over set by hand. */
const PARAMS = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.5, stepOver: 1.4, peck: 1, air: false };

/** A job whose only work is the given drills, on the default 100 × 60 × 12 softwood blank. */
function boreJob(drills: EngraveDrill[], cutOverride?: EngraveJob['cutOverride']): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, labels: [], shapes: [], traces: [], toolKey: TOOL_KEY, tool: DRILL_TOOL, drills, cutOverride };
}

/** A bore at (50, 30): a ⌀`diameter` hole, `depth` deep, cut by the 3.175 mm cutter. */
function bore(diameter: number, depth = 4): EngraveDrill {
  return {
    id: 'hole',
    kind: 'drill',
    name: 'hole',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth,
    enabled: true,
    through: false,
    mode: 'bore',
    diameter,
  };
}

/** A plain plunge drill, for the mixed fixtures. */
function peckDrill(): EngraveDrill {
  return {
    id: 'port',
    kind: 'drill',
    name: 'port',
    position: { x: 25, y: 20 },
    rotation: 0,
    depth: 3,
    enabled: true,
    through: false,
  };
}

/** Rebuild a solid from a meshed sweep result so its volume can be read. */
function meshSolid(mesh: NodeMeshOutput) {
  return new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

/** Every feed move's distance from a hole's centre, in the order the moves run. */
function radii(moves: readonly { kind: string; x: number; y: number }[], cx = 50, cy = 30): number[] {
  return moves.map((m) => Math.hypot(m.x - cx, m.y - cy));
}

describe('bore CAM (#668)', () => {
  it('takes the tighter of the step-down and the ramp angle for its pitch', () => {
    // 2π·Rc·tan(2°) is the lead one revolution takes at a 3.4 mm centre radius: ~0.75 mm, so a
    // 0.5 mm step-down is the cap. At a 1 mm centre radius the ramp is ~0.22 mm and caps it.
    expect(borePitchMm(0.5, 3.4, 2)).toBe(0.5);
    expect(borePitchMm(0.5, 1, 2)).toBeCloseTo(2 * Math.PI * Math.tan((2 * Math.PI) / 180), 12);
    expect(borePitchMm(0.5, 1, 10)).toBeCloseTo(Math.min(0.5, 2 * Math.PI * Math.tan((10 * Math.PI) / 180)), 12);
    // A nonsense angle keeps the labelled fallback rather than inventing one.
    for (const bad of [null, undefined, 0, -2, Number.NaN, 90, 120]) {
      expect(boreRampAngleFrom(bad)).toBe(BORE_RAMP_ANGLE_FALLBACK_DEG);
    }
    expect(boreRampAngleFrom(5)).toBe(5);
  });

  it('clears the core at every level, laps the wall once at the floor, and never rapids below the hop', () => {
    const holeRadius = 5; // ⌀10 — wider than twice the cutter, so the core is cleared level by level
    const depth = 4;
    const moves = boreMoves([[50, 30]], depth, holeRadius, CUTTER_RADIUS, PARAMS, 2);
    const centreRadius = holeRadius - CUTTER_RADIUS;
    const pitch = borePitchMm(PARAMS.stepDown, centreRadius, 2);
    const segments = segmentsForRadius(centreRadius);
    const levels = boreLevels(depth, pitch);
    expect(levels.length).toBeGreaterThan(1);

    // Down at the helix's start point — the hole's edge along +X — in air, then cutting.
    expect(moves[0]).toEqual({ kind: 'rapid', x: 50 + centreRadius, y: 30, z: HOP_Z });
    expect(moves[1]).toEqual({ kind: 'rapid', x: 50 + centreRadius, y: 30, z: 0 });
    // The last move retracts at the hole's centre, as a drill's does.
    expect(moves[moves.length - 1]).toEqual({ kind: 'rapid', x: 50, y: 30, z: SAFE_Z });

    const feeds = moves.filter((m) => m.kind === 'feed');
    const hubFeed = (level: number): number =>
      feeds.findIndex(
        (m) => Math.abs(m.z + level) < 1e-9 && Math.hypot(m.x - 50, m.y - 30) <= CUTTER_RADIUS + 1e-9,
      );
    // (a) THE CORE IS CLEARED BEFORE THE NEXT DESCENT: at every level the path reaches the hub,
    // and no feed goes deeper than that level until it has. This is the order the material comes
    // out in — the oracle judges only the end state, so this is what pins the fix.
    for (const level of levels) {
      const hub = hubFeed(level);
      expect(hub, `a hub feed at ${level} mm`).toBeGreaterThanOrEqual(0);
      const deeper = feeds.findIndex((m) => m.z < -level - 1e-9);
      if (deeper >= 0) expect(hub, `level ${level} cleared before the descent below it`).toBeLessThan(deeper);
    }
    // Each level's ramp lands on its Z at the wall — one full turn of descent per level, so no
    // revolution takes a deeper bite than the pitch.
    for (const level of levels) {
      const landing = feeds.find((m) => Math.abs(m.z + level) < 1e-9);
      expect(landing).toBeDefined();
      expect(Math.hypot(landing!.x - 50, landing!.y - 30)).toBeCloseTo(centreRadius, 9);
    }

    // The final level keeps the issue's step: one full circle at the floor at the wall (its first
    // point is the ramp's landing), then the spiral and the hub lap that clear the floor.
    const atFloor = feeds.findIndex((m) => Math.abs(m.z + depth) < 1e-9);
    for (const r of radii(feeds.slice(atFloor, atFloor + segments + 1))) expect(r).toBeCloseTo(centreRadius, 9);
    const afterLap = feeds.slice(atFloor + segments + 1);
    expect(Math.min(...radii(afterLap))).toBeLessThanOrEqual(CUTTER_RADIUS + 1e-9);
    // The hub lap: a full circle at the spiral's final radius. A single inward spiral leaves a
    // small post beside the centre where its last arc did not reach at every angle — the oracle
    // caught exactly that before this lap existed.
    for (const r of radii(afterLap).slice(-segments)) expect(r).toBeCloseTo(CUTTER_RADIUS, 9);

    // Every cutting move is at the floor or above it, and nothing rapid happens below the hop.
    for (const m of moves) {
      if (m.kind === 'feed') expect(m.z).toBeLessThanOrEqual(0);
      else expect(m.z === HOP_Z || m.z === SAFE_Z || m.z === 0).toBe(true);
    }
  });

  it('(b) no feed crosses the blank’s underside before the core there is cleared (wide through bore)', () => {
    const thickness = 6; // the blank's bottom is at −6; a through bore cuts to −6.3
    const depth = thickness + 0.3;
    const holeRadius = 5;
    const centreRadius = holeRadius - CUTTER_RADIUS;
    const pitch = borePitchMm(PARAMS.stepDown, centreRadius, 2);
    const moves = boreMoves([[50, 30]], depth, holeRadius, CUTTER_RADIUS, PARAMS, 2, thickness);
    // The level list lands on the blank's bottom exactly — the level that frees the core is the
    // one that clears it.
    expect(boreLevels(depth, pitch, thickness)).toContain(thickness);

    const feeds = moves.filter((m) => m.kind === 'feed');
    const firstBelow = feeds.findIndex((m) => m.z < -thickness - 1e-9);
    expect(firstBelow, 'the bore does cut below the blank').toBeGreaterThan(0);
    const hubAtBottom = feeds.findIndex(
      (m) => Math.abs(m.z + thickness) < 1e-9 && Math.hypot(m.x - 50, m.y - 30) <= CUTTER_RADIUS + 1e-9,
    );
    expect(hubAtBottom, 'a hub feed at the blank’s underside').toBeGreaterThanOrEqual(0);
    expect(hubAtBottom, 'the core is cleared to the underside before the cutter crosses it').toBeLessThan(firstBelow);
    // And a blind bore's levels never include a bottom it does not cross.
    expect(boreLevels(4, pitch, thickness)).toEqual(boreLevels(4, pitch));
  });

  it('needs no spiral when the hole is no wider than twice the cutter', () => {
    const holeRadius = 3; // ⌀6 against a 3.175 cutter: the lap already reaches the centre
    const moves = boreMoves([[50, 30]], 3, holeRadius, CUTTER_RADIUS, PARAMS, 2);
    const feeds = moves.filter((m) => m.kind === 'feed');
    const centreRadius = holeRadius - CUTTER_RADIUS;
    // Every cutting move runs on the wall ring; the floor spiral is empty.
    for (const r of radii(feeds)) expect(r).toBeCloseTo(centreRadius, 9);
  });

  it('refuses a hole that is not wider than the cutter', () => {
    expect(() => boreMoves([[50, 30]], 4, 1.5, CUTTER_RADIUS, PARAMS, 2)).toThrow(/not wider than the/);
    expect(() => boreMoves([[50, 30]], 4, CUTTER_RADIUS, CUTTER_RADIUS, PARAMS, 2)).toThrow(/not wider than the/);
  });

  it('gives the region the HOLE’s disc, and the CAM the helix at the shop’s ramp angle', () => {
    const job = boreJob([bore(10)]);
    const { regions } = cutRegions(tl, job);
    const region = regions.find((r) => r.id === 'hole');
    expect(region?.drill?.bore?.radius).toBe(5);
    // The predicted disc is the ⌀10 hole, not the cutter's ⌀3.175 disc.
    expect(region?.name).toBe('Bore "hole" ⌀10');

    const tool = jobTool(job)!;
    const feeds = feedsFor([], job.stock.material, tool, Z1, job.cutOverride);
    if (!feeds.ok) throw new Error(feeds.reason);
    const ir = generateEngrave(tl, regions, tool, feeds.params, Z1.rapidEstimate, 'nearest', null, null, 2);
    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]!.name).toContain('Bore');
    // The operation IS the bore path, built from the same feeds row and the shop's reading.
    expect(ir.operations[0]!.moves).toEqual(boreMoves([[50, 30]], 4, 5, CUTTER_RADIUS, feeds.params, 2));
    // The pitch moves with the angle, so the angle really is the number the path is built from.
    // (A deep step-down keeps the ramp — rather than the row — the binding source in both calls.)
    const deep = { ...PARAMS, stepDown: 5 };
    expect(boreMoves([[50, 30]], 4, 5, CUTTER_RADIUS, deep, 2).length).not.toBe(
      boreMoves([[50, 30]], 4, 5, CUTTER_RADIUS, deep, 10).length,
    );
  });

  it('cuts the same hole blind and through', () => {
    const blind = boreJob([bore(10)]);
    const gBlind = generate(tl, blind);
    expect(gBlind.errors).toEqual([]);
    expect(gBlind.ok).toBe(true);
    // A 6 mm blank keeps the through cut inside the tool's 12 mm flute: throughDepth = 6 + 0.3.
    const through: EngraveJob = {
      ...blind,
      stock: { ...blind.stock, thickness: 6 },
      drills: [{ ...bore(10), through: true }],
      sacrificial: {
        ...blind.sacrificial,
        under: { thickness: blind.breakthrough + 1, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
      },
    };
    const gThrough = generate(tl, through);
    expect(gThrough.errors).toEqual([]);
    expect(gThrough.ok).toBe(true);
    expect(gThrough.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('states the pitch and both its sources on the run sheet, naming the one that binds', () => {
    const sheetFor = (diameter: number) => {
      const job = boreJob([bore(diameter, 4)]);
      const g = generate(tl, job);
      expect(g.ok).toBe(true);
      expect(g.bore?.items).toHaveLength(1);
      const texts = buildRunSheet(job, g, null)
        .sections.flatMap((s) => s.steps.map((st) => st.text));
      const step = texts.find((t) => t.includes('is a bore to size'));
      expect(step).toBeDefined();
      return step as string;
    };
    // ⌀10 at a 3.4 mm centre radius: the 2° ramp allows ~0.75 mm a turn, so the RAMP is tighter.
    const narrow = sheetFor(10);
    expect(narrow).toContain('⌀10 mm hole');
    expect(narrow).toContain('mm per turn');
    expect(narrow).toContain('bore.rampAngleDeg');
    expect(narrow).toMatch(/ramp angle \(the shop’s bore\.rampAngleDeg, [a-z]+\) is the tighter/);
    // ⌀20: the ramp allows ~1.85 mm a turn on a 3.4 mm radius, so the feeds row's 1 mm step-down is.
    const wide = sheetFor(20);
    expect(wide).toMatch(/step-down is the tighter/);
  });

  it('passes the oracle on a hole narrow enough to need no floor spiral', () => {
    // ⌀5 against a 3.175 cutter: the wall lap already sweeps the whole disc, so the path is the
    // ramp and the lap only — and the predicted cylinder must still be true at the floor.
    const job = boreJob([bore(5, 3)]);
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the tool library`);
    const session: SimSession = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 60_000);

  it('removes the cylinder it promises: π r² × depth, blind', () => {
    const job = boreJob([bore(10, 4)]);
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the tool library`);
    const session: SimSession = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      const removed = meshSolid(load.meshes.removal as NodeMeshOutput);
      const volume = removed.volume();
      removed.delete();
      // The wall band (helix + lap) and the core (floor spiral) together make the hole's own
      // cylinder — not the annulus a helix alone would leave.
      const expected = Math.PI * 5 * 5 * 4;
      expect(Math.abs(volume - expected) / expected).toBeLessThan(0.02);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 60_000);
});

describe('bore findings (#668)', () => {
  const codes = (job: EngraveJob) => validateJob(job).map((f) => f.code);

  it('refuses a bore with no stated diameter, by name', () => {
    const job = boreJob([{ ...bore(10), diameter: undefined }]);
    const f = validateJob(job).find((x) => x.code === 'bore-no-diameter');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('hole diameter');
  });

  it('refuses a hole that is not wider than the cutter', () => {
    const f = validateJob(boreJob([bore(3)])).find((x) => x.code === 'bore-narrow');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('not wider than');
  });

  it('refuses a cutter that cannot ramp, naming it', () => {
    const job: EngraveJob = { ...boreJob([bore(10)]), tool: flatEndMill(3.175, { shape: 'ball', typeText: 'Ball End' }) };
    const f = validateJob(job).find((x) => x.code === 'bore-needs-end-mill');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('flat end mill');
  });

  it('sweeps the HOLE’s radius, not the cutter’s, for the collision checks', () => {
    const job = boreJob([bore(10)]);
    const cut = sweptCuts(job).find((c) => c.id === 'hole');
    expect(cut).toBeDefined();
    // A ⌀10 hole at (50, 30) reaches x = 45..55; the ⌀3.175 cutter would only reach 48.41..51.59.
    expect(cut!.box.maxX - cut!.box.minX).toBeCloseTo(10, 9);
    expect(cut!.box.maxY - cut!.box.minY).toBeCloseTo(10, 9);
  });

  it('judges the hole’s rim, not the cutter’s, against the stock edge', () => {
    // ⌀10 at x = 4: the cutter (r 1.59) is on the blank; the hole (r 5) is not.
    const job = boreJob([{ ...bore(10), position: { x: 4, y: 30 } }]);
    expect(codes(job)).toContain('drill-outside-stock');
  });
});

describe('bore document (#668)', () => {
  it('round-trips a MIXED job: a peck drill, a bore, a drill array and a region', () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      toolKey: TOOL_KEY,
      tool: DRILL_TOOL,
      shapes: [
        {
          id: 'pocket',
          name: 'pocket',
          kind: 'rect',
          position: { x: 30, y: 30 },
          rotation: 0,
          depth: 1,
          enabled: true,
          width: 10,
          height: 8,
          cornerRadius: 0,
        },
      ],
      drills: [
        peckDrill(),
        bore(10),
        {
          id: 'grid',
          kind: 'drill-array',
          position: { x: 20, y: 45 },
          rotation: 15,
          depth: 2,
          enabled: true,
          through: false,
          mode: 'bore',
          diameter: 6,
          count: { x: 2, y: 2 },
          pitch: { x: 10, y: 8 },
        },
      ],
    };
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // An old drill keeps NO mode key — absent reads as a drill, byte for byte.
    expect('mode' in parsed.job.drills![0]!).toBe(false);
    expect(parsed.job.drills![1]!.mode).toBe('bore');
    expect(parsed.job.drills![1]!.diameter).toBe(10);
    expect(parsed.job.drills![2]!.kind).toBe('drill-array');
    expect(parsed.job.drills![2]!.diameter).toBe(6);
    // A bore with no diameter PARSES — the finding refuses it, not the reader.
    const noDiameter = parseEngraveJob({ ...job, drills: [{ ...bore(10), diameter: undefined }] });
    expect(noDiameter.ok).toBe(true);
    // A diameter the schema cannot carry is refused rather than floored: 0 and negative are not holes.
    expect(parseEngraveJob({ ...job, drills: [{ ...bore(10), diameter: 0 }] }).ok).toBe(false);
    expect(parseEngraveJob({ ...job, drills: [{ ...bore(10), diameter: -5 }] }).ok).toBe(false);
  });
});

describe('bore oracle in-process (#668)', () => {
  it('passes on a MIXED job: a pocket, a peck drill, a trace and a bore, swept together', () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      labels: [],
      toolKey: TOOL_KEY,
      tool: DRILL_TOOL,
      shapes: [
        {
          id: 'pocket',
          name: 'pocket',
          kind: 'rect',
          position: { x: 30, y: 40 },
          rotation: 0,
          depth: 1,
          enabled: true,
          width: 12,
          height: 8,
          cornerRadius: 0,
        },
      ],
      traces: [
        {
          id: 'tr',
          kind: 'line',
          position: { x: 20, y: 10 },
          rotation: 0,
          points: [
            [0, 0],
            [30, 0],
          ],
          closed: false,
          depth: 0.8,
          enabled: true,
        },
      ],
      drills: [peckDrill(), bore(10, 4)],
    };
    const g = generate(tl, job);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the tool library`);
    const session: SimSession = createSimSession(tl);
    try {
      const load: SimLoadOk = (() => {
        const l = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
        if (!l.ok) throw new Error(`simulation refused: ${JSON.stringify(l.diagnostics)}`);
        return l;
      })();
      expect(load.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 90_000);
});
