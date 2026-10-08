/**
 * The SIMULATOR-side assertions #215's test list still owed after its engine half landed
 * (`25e8286`): a cut-away with an island, raised text, and two overlapping pockets at different
 * depths — each through the REAL pipeline (generate → verify → simulate → oracle), with the
 * swept geometry SLICED at the depth under test.
 *
 * Real Manifold, real sweep, plain Node — the same harness `engraveOracle.spec.ts` uses. The
 * point of the slice is that the oracle checks areas LEVEL BY LEVEL; these tests check the
 * geometry at a Z the oracle never visits (half the pocket depth), which is where "the island is
 * left standing" and "the deeper pocket wins the overlap" are actually falsifiable.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession, type SimLoadOk, type SimSession } from '@/workers/sim/session';
import { type EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type {
  EngraveCircleShape,
  EngraveCutawayShape,
  EngraveJob,
  EngraveLabel,
  EngraveRectShape,
} from '@/types/engraveJob';

type ManifoldInstance = InstanceType<(typeof tl)['Manifold']>;
type CrossSectionInstance = InstanceType<(typeof tl)['CrossSection']>;

/** A ⌀3 circle island in a 10 × 6 panel, both reference-only; the cut-away is the one cut. */
function islandJob(): EngraveJob {
  const base = defaultEngraveJob();
  const panel: EngraveRectShape = {
    id: 'panel',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    width: 10,
    height: 6,
    cornerRadius: 0,
    construction: true,
  };
  const island: EngraveCircleShape = {
    id: 'island',
    kind: 'circle',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    diameter: 3,
    construction: true,
  };
  const cut: EngraveCutawayShape = {
    id: 'cut',
    kind: 'cutaway',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    outer: 'panel',
    islands: ['island'],
  };
  return { ...base, labels: [], shapes: [panel, island], combined: [cut] };
}

/** Raised text: a construction label "HI" left standing inside a cleared 18 × 11 panel (#215). */
function raisedTextJob(): EngraveJob {
  const base = defaultEngraveJob();
  const text: EngraveLabel = {
    id: 'txt',
    text: 'HI',
    font: DEFAULT_FONT_ID,
    weight: 'bold',
    size: 8,
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    construction: true,
  };
  const panel: EngraveRectShape = {
    id: 'panel',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    width: 18,
    height: 11,
    cornerRadius: 0,
    construction: true,
  };
  const cut: EngraveCutawayShape = {
    id: 'raised',
    kind: 'cutaway',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    outer: 'panel',
    islands: ['txt'],
  };
  return { ...base, labels: [text], shapes: [panel], combined: [cut] };
}

/**
 * Two 30 × 20 rects overlapping by 20 × 20, at depths 1 and 2. `A` spans x∈[35,65], `B`
 * x∈[45,75], both y∈[20,40]; the overlap is x∈[45,65].
 */
function overlapJob(): EngraveJob {
  const base = defaultEngraveJob();
  const a: EngraveRectShape = {
    id: 'a',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    width: 30,
    height: 20,
    cornerRadius: 0,
  };
  const b: EngraveRectShape = {
    id: 'b',
    kind: 'rect',
    position: { x: 60, y: 30 },
    rotation: 0,
    depth: 2,
    enabled: true,
    width: 30,
    height: 20,
    cornerRadius: 0,
  };
  return { ...base, labels: [], shapes: [a, b] };
}

/** Generate, verify and load a job through the real session; every error gate must be clean. */
function run(job: EngraveJob): { g: EngraveGenerated; session: SimSession; load: SimLoadOk } {
  const g = generate(tl, job);
  expect(g.errors).toEqual([]);
  expect(g.ok).toBe(true);
  expect(g.nc).not.toBeNull();
  expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
  const tool = jobTool(job);
  if (tool === null) throw new Error('flat-1.0 is not in the tool library');
  const session = createSimSession(tl);
  const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
  if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
  return { g, session, load };
}

/** Rebuild a solid from a meshed sweep result so it can be sliced (the session keeps its own). */
function meshSolid(mesh: NodeMeshOutput): ManifoldInstance {
  // `Mesh` is a plain JS holder — there is nothing to `delete()`; the bytes are copied in.
  return new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

/** Area of the solid's cross-section at work-frame Z `z`, mm². */
function sliceArea(mesh: NodeMeshOutput, z: number): number {
  const m = meshSolid(mesh);
  const cs = m.slice(z);
  const area = cs.area();
  cs.delete();
  m.delete();
  return area;
}

/** Area of the solid's cross-section at Z `z`, inside `region`, mm². */
function sliceAreaIn(mesh: NodeMeshOutput, z: number, region: CrossSectionInstance): number {
  const m = meshSolid(mesh);
  const cs = m.slice(z);
  const inside = cs.intersect(region);
  const area = inside.area();
  inside.delete();
  cs.delete();
  m.delete();
  return area;
}

/** A CCW rectangle as a CrossSection, for intersecting a slice with a named region. */
function rectRegion(minX: number, minY: number, maxX: number, maxY: number): CrossSectionInstance {
  return tl.CrossSection.ofPolygons([
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
  ]);
}

describe('combined shapes, simulated (#215)', () => {
  // The cut-away path is much heavier than a plain pocket (a hole makes the pocket loops ~24×
  // the moves of an equal-area rect), so these two fixtures are kept small and carry a longer
  // timeout than vitest's 5 s default — the point is a REAL slice, not a small one.
  it(
    'leaves the island of a cut-away standing, at full height (#215)',
    () => {
      const { g, session, load } = run(islandJob());
      try {
        // The plan is one cut-away: a 10 × 6 panel with a ⌀3 island removed.
        expect(g.predicted).toHaveLength(1);
        expect(load.meshes.removal).not.toBeNull();

        // SLICE THE REMOVAL at half the pocket depth — a Z the oracle's per-level check never
        // visits. What was swept away is exactly the planned region, island excluded.
        const plannedArea = tl.CrossSection.ofPolygons(g.predicted[0]!.polygons).area();
        const removed = sliceArea(load.meshes.removal as NodeMeshOutput, -0.5);
        expect(removed).toBeCloseTo(plannedArea, 1);

        // The island is untouched and STANDS at full height: a disc just inside its ⌀3 wall has no
        // removal in it, and the swept result is solid there.
        const island = tl.CrossSection.circle(1.3, 128).translate(50, 30);
        const cutInside = sliceAreaIn(load.meshes.removal as NodeMeshOutput, -0.5, island);
        const solidInside = sliceAreaIn(load.meshes.result, -0.5, island);
        island.delete();
        expect(cutInside).toBeLessThan(0.05);
        expect(solidInside).toBeCloseTo(Math.PI * 1.3 * 1.3, 1);

        // The oracle agrees level by level, so the slice above is not a lone approximation.
        expect(session.oracle(g.predicted).ok).toBe(true);
      } finally {
        session.dispose();
      }
    },
    30_000,
  );

  it(
    'generates, verifies, simulates and passes the oracle for raised text (#215)',
    () => {
      const { g, session, load } = run(raisedTextJob());
      try {
        // One cut-away region; its opened outline is the cleared panel with the glyphs as holes.
        expect(g.predicted).toHaveLength(1);
        expect(g.predicted[0]!.polygons.length).toBeGreaterThan(1); // outer + at least one letter hole

        // At half depth the removal equals the planned region — which, with the letters as holes,
        // is SMALLER than the panel they sit in: the text stands.
        const plannedArea = tl.CrossSection.ofPolygons(g.predicted[0]!.polygons).area();
        const removed = sliceArea(load.meshes.removal as NodeMeshOutput, -0.5);
        expect(removed).toBeCloseTo(plannedArea, 1);
        expect(removed).toBeLessThan(18 * 11);

        // Generate → verify → simulate → oracle, all the way.
        const report = session.oracle(g.predicted);
        expect(report.ok).toBe(true);
      } finally {
        session.dispose();
      }
    },
    30_000,
  );

  it('puts the overlap of two pockets at the deeper floor (#215)', () => {
    const { g, session, load } = run(overlapJob());
    try {
      // At Z = −1.5 the depth-1 pocket (`a`) is not yet cut, but the depth-2 pocket (`b`) is, so
      // the overlap the two share is VOID...
      const overlap = rectRegion(46, 21, 64, 39); // inset from `b`'s edges to avoid boundary slivers
      const overlapSolid = sliceAreaIn(load.meshes.result, -1.5, overlap);
      overlap.delete();
      expect(overlapSolid).toBeCloseTo(0, 2);

      // ...while the part of `a` the deeper pocket never reaches is still SOLID at that Z.
      const shallowOnly = rectRegion(36, 21, 44, 39);
      const shallowSolid = sliceAreaIn(load.meshes.result, -1.5, shallowOnly);
      shallowOnly.delete();
      expect(shallowSolid).toBeCloseTo(8 * 18, 0);

      // The oracle's per-level comparison carries the same rule.
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  });
});
