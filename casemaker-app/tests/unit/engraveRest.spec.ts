// The rest region, measured against a removal SOLID (#410).
//
// Every case here builds the first program's removal by hand and asserts against CLOSED FORM — a box
// covers exactly half of a square, an octagon of side `a` has a known area — rather than against
// another run of the same code, and the removal goes through `meshOutputOf`/`manifoldOfMesh` because
// that round trip is what the real route does: the sweep ships a mesh across a worker boundary and
// this module turns it back into a solid. `solidFromMesh` is tested on its own for the same reason —
// a mesh from the sweep has duplicated vertices at every face join, so the weld is load-bearing.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { restMachining, solidFromMesh, unionRemoval, REST_PLANE_EPS_MM } from '@/workers/sim/engraveRest';
import { meshOutputOf, type NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { RestCut } from '@/workers/sim/engraveRest';

/** A box spanning [x0,x1]×[y0,y1]×[z0,z1], as the mesh the sweep would have produced. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): NodeMeshOutput {
  const solid = tl.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]);
  const moved = solid.translate([x0, y0, z0]);
  solid.delete();
  const mesh = meshOutputOf(moved);
  moved.delete();
  return mesh;
}

/** A 10 × 10 mm cut at `depth`, in the stock frame — the item every case below is about. */
function square(depth: number, size = 10): RestCut {
  return {
    id: 'shp-1',
    name: 'the square',
    depth,
    polygons: [
      [
        [0, 0],
        [size, 0],
        [size, size],
        [0, size],
      ],
    ],
  };
}

/** The design area of `square`, mm² — the fixture's own fact, held here once. */
const SQUARE = 100;

describe('solidFromMesh (#410)', () => {
  it('round-trips a mesh the sweep produced, weld and all', () => {
    // The mesh vertices are duplicated at every face join (`getMesh` gives triangles, not a
    // manifold). If the weld were dropped the solid would come back with a nonzero volume anyway,
    // so this is measured as VOLUME against the box's own arithmetic, not as "it returned something".
    const mesh = box(0, 5, 0, 12, -1, 0);
    const solid = solidFromMesh(tl, mesh);
    expect(solid).not.toBeNull();
    expect(solid!.volume()).toBeCloseTo(5 * 12 * 1, 6);
    expect(solid!.status()).toBe('NoError');
    solid!.delete();
  });

  it('answers null — not a zero-volume solid — for a mesh that is not closed', () => {
    const open: NodeMeshOutput = {
      positions: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      triangleCount: 1,
      vertexCount: 3,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      componentCount: 1,
    };
    expect(solidFromMesh(tl, open)).toBeNull();
  });
});

describe('unionRemoval (#410)', () => {
  const areaAt = (mesh: NodeMeshOutput, z: number): number => {
    const solid = solidFromMesh(tl, mesh)!;
    const slice = solid.slice(z);
    const a = slice.area();
    slice.delete();
    solid.delete();
    return a;
  };

  it('unions overlapping removals into ONE solid rather than adding their areas', () => {
    // Two boxes that overlap over x ∈ [3,6]: 5×4 + 5×4 = 40 mm² of area, but the union is 8×4 = 32.
    const a = box(0, 5, 0, 4, -1, 0);
    const b = box(3, 8, 0, 4, -1, 0);
    const both = unionRemoval(tl, [a, b]);
    expect(both).not.toBeNull();
    expect(areaAt(both!, -0.5)).toBeCloseTo(32, 4);
    // And the union still reaches the floor the second program's regions are measured at.
    const solid = solidFromMesh(tl, both!)!;
    expect(solid.volume()).toBeCloseTo(8 * 4 * 1, 4);
    solid.delete();
  });

  it('is the identity on one mesh, and null when nothing is one', () => {
    const a = box(0, 5, 0, 4, -1, 0);
    expect(areaAt(unionRemoval(tl, [a])!, -0.5)).toBeCloseTo(20, 4);
    expect(unionRemoval(tl, [])).toBeNull();
    expect(unionRemoval(tl, [null])).toBeNull();
    // A mesh that is not a closed solid contributes nothing — the honest answer to "nothing was
    // removed", which every region then reads as rest in full.
    const open: NodeMeshOutput = {
      positions: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      triangleCount: 1,
      vertexCount: 3,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      componentCount: 1,
    };
    expect(unionRemoval(tl, [null, open])).toBeNull();
  });
});

describe('restMachining (#410)', () => {
  it('measures the rest AGAINST THE SOLID, not against the cut’s outline', () => {
    // The removal covers x ∈ [0,5] — half of the square — and reaches 1 mm down, so it is material
    // gone at the 0.5 mm floor. The rest is the other half, to the millimetre.
    const removal = box(0, 5, -1, 11, -1, 0);
    const rest = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 0 });
    expect(rest.cutArea).toBeCloseTo(SQUARE, 4);
    expect(rest.clearedArea).toBeCloseTo(50, 4);
    expect(rest.restArea).toBeCloseTo(50, 4);
    expect(rest.regions).toHaveLength(1);
    expect(rest.regions[0]!.id).toBe('shp-1');
    expect(rest.regions[0]!.depth).toBe(0.5);
    expect(rest.regions[0]!.area).toBeCloseTo(50, 4);
    // The region is returned as POLYGONS in the stock frame, ready to be an item of the second job.
    const cs = tl.CrossSection.ofPolygons(rest.regions[0]!.polygons, 'EvenOdd');
    expect(cs.area()).toBeCloseTo(50, 4);
    cs.delete();
  });

  it('slices PER DEPTH: a floor the removal does not reach is rest in full', () => {
    // The removal stops 0.2 mm below the surface, so a 0.5 mm floor was never cleared — while a
    // 0.1 mm floor was. One solid, two answers, which is the whole reason the slice is per depth.
    const removal = box(0, 5, -1, 11, -0.2, 0);
    const deep = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 0 });
    expect(deep.clearedArea).toBeCloseTo(0, 4);
    expect(deep.restArea).toBeCloseTo(SQUARE, 4);

    const shallow = restMachining(tl, { removal, cuts: [square(0.1)], overlap: 0 });
    // Sampled EPS ABOVE the floor, so a floor that IS the removal's own bottom face still reads as
    // cleared: the question is "is the material gone just above where the floor should be?".
    expect(shallow.clearedArea).toBeGreaterThan(0);
  });

  it('grows the rest into the first tool’s territory and CLIPS it to the design', () => {
    const removal = box(0, 5, -1, 11, -1, 0);
    const zero = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 0 });
    const grown = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 1 });
    // 1 mm back into the cleared half, and never outside the item: 4..10 mm of a 10 mm square.
    expect(grown.restArea).toBeCloseTo(60, 3);
    expect(grown.restArea).toBeGreaterThan(zero.restArea);
    expect(grown.regions[0]!.area).toBeCloseTo(60, 3);
    // The growth does not change what was cleared or what the item asks for.
    expect(grown.clearedArea).toBeCloseTo(zero.clearedArea, 4);
    expect(grown.cutArea).toBeCloseTo(zero.cutArea, 4);
  });

  it('DROPS a region with nothing left to cut — a zero-area item is a refusal, not an item', () => {
    const removal = box(-1, 11, -1, 11, -1, 0);
    const rest = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 0 });
    expect(rest.regions).toEqual([]);
    expect(rest.clearedArea).toBeCloseTo(SQUARE, 4);
    expect(rest.restArea).toBeCloseTo(0, 4);
    // Dropping it with an overlap is the same answer, not a whole-item region: there is nothing
    // standing, so there is nothing for the second program to cut even where it may reach back.
    const grown = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 1 });
    expect(grown.regions).toEqual([]);
  });

  it('reads an ABSENT removal as “the first program removed nothing”', () => {
    const rest = restMachining(tl, { removal: null, cuts: [square(0.5)], overlap: 0 });
    expect(rest.restArea).toBeCloseTo(SQUARE, 4);
    expect(rest.clearedArea).toBeCloseTo(0, 4);
    expect(rest.notes.join(' ')).toContain('the first program removed nothing');
  });

  it('says in numbers what it measured, and what the overlap buys', () => {
    const removal = box(0, 5, -1, 11, -1, 0);
    const withNote = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 0.6 });
    // The operator has to be able to check the measurement, so the note carries the two areas.
    expect(withNote.notes.join(' ')).toContain('50');
    expect(withNote.notes.join(' ')).toContain('100');
    expect(withNote.notes.join(' ')).toContain('overlaps the first tool by 0.6 mm');
    // #436 — the band is DERIVED per job now, so it arrives as a full-precision double
    // (0.49302855497458753 for the badge's pair). A note that interpolated it raw would print
    // all seventeen digits to the operator; the note rounds it the way the sheet does.
    const derived = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 0.49302855497458753 });
    const note = derived.notes.join(' ');
    expect(note).toContain('overlaps the first tool by 0.493 mm');
    expect(note).not.toContain('0.49302855497458753');
    // With no overlap there is no band, and a note claiming one would be a false statement on the
    // run sheet about how the part is cut.
    const noNote = restMachining(tl, { removal, cuts: [square(0.5)], overlap: 0 });
    expect(noNote.notes.join(' ')).not.toContain('overlaps the first tool');
  });

  it('measures each item at its own floor even when two share a depth', () => {
    // The slice is cached per depth and the CUTS are not: an implementation that cached the
    // cross-section per depth and then reused one cut's region for the other would still pass a
    // one-item fixture.
    const removal = box(0, 5, -1, 11, -1, 0);
    const second: RestCut = { id: 'shp-2', name: 'the second square', depth: 0.5, polygons: [[[20, 0], [30, 0], [30, 10], [20, 10]]] };
    const rest = restMachining(tl, { removal, cuts: [square(0.5), second], overlap: 0 });
    // The removal is nowhere near the second square, so it is whole and the first is half.
    expect(rest.regions.map((r) => [r.id, Math.round(r.area)])).toEqual([
      ['shp-1', 50],
      ['shp-2', 100],
    ]);
    expect(rest.clearedArea).toBeCloseTo(50, 4);
    expect(rest.restArea).toBeCloseTo(150, 4);
  });
});

describe('REST_PLANE_EPS_MM (#410)', () => {
  it('is small enough to be a tolerance and large enough to beat the sweep’s own', () => {
    // The constant is a claim about two other numbers in the pipeline: the sweep's chord (0.005 mm)
    // and simplify (0.002 mm) tolerances, and a layer height. Nothing here pins it to a value — it
    // pins it to the relationship the comment states, so a future edit can't quietly make it noise.
    expect(REST_PLANE_EPS_MM).toBeGreaterThan(0.005);
    expect(REST_PLANE_EPS_MM).toBeLessThan(0.05);
  });
});
