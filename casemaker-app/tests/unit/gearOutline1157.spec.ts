/**
 * #1157 — A GEAR SAMPLE IS STAGED AS AN OUTLINE OF ITS SILHOUETTE.
 *
 * `gears-outline` was a MESH purpose: heart-gear-a, a 40.754 mm bevel gear, was planned as a 3D
 * goal in a block and read 5.66 % coverage — no plan defect (53 % of its surface faces away from
 * one top setup; 4 regions are deeper than the shop's 22 mm ball), but a staging that cannot pass.
 * The purpose is now an OUTLINE job on the mesh's widest horizontal cross-section, and a receipt
 * with `goal-unreached` / `goal-finish-unreachable` reads a feasibility verdict, not a bare fail.
 *
 * Red at the base: `gearOutline.ts` does not exist (the import fails) and `gears-outline` is in
 * the harness's MESH_PURPOSES; the behavioural witness is heart-gear-a's recorded 3D receipt.
 */
import { describe, expect, it } from 'vitest';

import {
  GEAR_OUTLINE_PURPOSE,
  MESH_PURPOSES,
  OUTLINE_PURPOSES,
  meshSilhouette,
} from '../../tools/samples/gearOutline';
import { feasibilityNote } from '../../tools/samples/sampleCheckRule';

/** A solid of revolution about Z, as triangles: a prism when the radii match, a cone otherwise. */
function frustumMesh(rBottom: number, rTop: number, height: number, sides = 24): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const verts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    verts.push(rBottom * Math.cos(a), rBottom * Math.sin(a), 0);
  }
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    verts.push(rTop * Math.cos(a), rTop * Math.sin(a), height);
  }
  const idx: number[] = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const b0 = i;
    const b1 = j;
    const t0 = sides + i;
    const t1 = sides + j;
    idx.push(b0, b1, t1, b0, t1, t0);
  }
  // Caps, wound outward (bottom faces −Z, top +Z).
  for (let i = 1; i + 1 < sides; i++) idx.push(0, i + 1, i);
  for (let i = 1; i + 1 < sides; i++) idx.push(sides, sides + i, sides + i + 1);
  return { positions: new Float32Array(verts), indices: new Uint32Array(idx) };
}

describe('#1157 the gear silhouette from a mesh', () => {
  it('a hexagonal prism gives one ring at its own size, centred on the origin', () => {
    const sil = meshSilhouette(frustumMesh(10, 10, 10, 6), 'hex.stl');
    expect(sil).not.toBeNull();
    expect(sil!.loops).toBe(1);
    expect(sil!.outline.width).toBeCloseTo(20, 1);
    expect(sil!.outline.height).toBeCloseTo(17.32, 1);
    expect(sil!.sectionZ).toBeGreaterThan(0);
    expect(sil!.sectionZ).toBeLessThan(10);
    // The rings are centred on their bounding box (OutlineImport's own frame).
    const xs = sil!.outline.contours[0]!.map(([x]) => x);
    const ys = sil!.outline.contours[0]!.map(([, y]) => y);
    expect(Math.max(...xs)).toBeCloseTo(-Math.min(...xs), 3);
    expect(Math.max(...ys)).toBeCloseTo(-Math.min(...ys), 3);
    expect(sil!.outline.format).toBe('3mf');
    expect(sil!.outline.notes.some((n) => n.includes('silhouette'))).toBe(true);
  });

  it('a cone is widest at its base: the section is taken near the bottom, not the middle', () => {
    const sil = meshSilhouette(frustumMesh(10, 2, 10), 'cone.stl');
    expect(sil!.sectionZ).toBeLessThan(2);
    expect(sil!.outline.width).toBeGreaterThan(19);
  });

  it('a mesh with no height has no silhouette', () => {
    expect(meshSilhouette(frustumMesh(10, 10, 0), 'flat.stl')).toBeNull();
  });
});

describe('#1157 the staging and the feasibility verdict', () => {
  it('gears-outline is an OUTLINE purpose, never a mesh one', () => {
    expect(GEAR_OUTLINE_PURPOSE).toBe('gears-outline');
    expect(MESH_PURPOSES.has('gears-outline')).toBe(false);
    expect(MESH_PURPOSES.has('relief-3axis')).toBe(true);
    expect(OUTLINE_PURPOSES.has('svg-coaster')).toBe(true);
  });

  it('a goal-unreached receipt leads with the planner’s own feasibility numbers', () => {
    const note = feasibilityNote([
      {
        code: 'goal-unreached',
        message:
          "The top setup reproduces 46 % of the goal's surface. 54 % of the goal faces away from this setup and is left as stock — 53 % of its surface is downward faces and undercuts, and 0.7 % lies in an overhang's shadow, so it is not cut from this side.",
      },
      { code: 'goal-finish-unreachable', message: '"curved-1": not finished — floor 34.7 mm below the stock top, …' },
      { code: 'goal-finish-unreachable', message: '"curved-5": not finished — floor 24.7 mm below the stock top, …' },
      { code: 'goal-finish-unreachable', message: '"curved-8": not finished — floor 24.1 mm below the stock top, …' },
      { code: 'goal-finish-unreachable', message: '"curved-11": not finished — floor 23.9 mm below the stock top, …' },
    ]);
    expect(note).not.toBeNull();
    expect(note!.startsWith('feasibility — ')).toBe(true);
    expect(note).toContain("The top setup reproduces 46 % of the goal's surface");
    expect(note).toContain('4 regions are deeper');
    expect(note).toContain('(34.7/24.7/24.1/23.9 mm below the stock top)');
  });

  it('an ordinary check (no goal-unreached) has no feasibility sentence', () => {
    expect(feasibilityNote([{ code: 'goal-region-uncut', message: 'x' }])).toBeNull();
  });

  it('one refused region reads singular', () => {
    const note = feasibilityNote([
      { code: 'goal-unreached', message: 'the goal faces away' },
      { code: 'goal-finish-unreachable', message: 'floor 30.0 mm below the stock top' },
    ]);
    expect(note).toContain('1 region is deeper');
  });
});
