// Issue #358 — the print table's declared `rotation` reaches the bed.
//
// Every part's print orientation is one id-keyed table entry (`@/engine/exporters/parts`): Euler
// `rotation` degrees plus a `flipForPrint` flag. Until #358 only the flip was applied. `rotation`
// was declared, reported by the UI and described by the notes sidecar, and read by no code at all —
// so a rack side panel whose own note says "Lay FLAT" exported standing on its 15 mm edge.
//
// These tests hold the table's declaration and the exporter's output against each other, on the
// REAL geometry: each op is evaluated through Manifold and its actual vertex buffer is run through
// the same `applyLayoutToMeshes` the export path calls. The assembly box is the mesh's own
// bounding box, so nothing here is inferred from the op tree.

import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import type { BuildOp } from '@/engine/compiler/buildPlan';
import { findTemplate } from '@/library/templates';
import { buildDividerPegOp } from '@/engine/compiler/dividerPegs';
import { applyLayoutToMeshes } from '@/engine/exportLayout';
import { printMetaForId } from '@/engine/exporters/parts';
import { SIDE_T } from '@/engine/compiler/rack';
import type { MeshNode } from '@/types';
import { exec } from './helpers/manifoldExec';

type Vec3 = [number, number, number];

interface Measured {
  /** The real mesh's bounding box, as modelled. */
  assembly: { min: Vec3; max: Vec3 };
  /** The real vertex buffer. */
  positions: Float32Array;
  /** The same vertices after the real print-ready layout. */
  laid: Float32Array;
  /** Extents of the laid buffer. */
  laidSize: Vec3;
  laidMin: Vec3;
}

function meshExtent(positions: Float32Array): { min: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  return { min, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as Vec3 };
}

/** Evaluate the part, then lay the real mesh out exactly as the export does. */
function measure(id: string, op: BuildOp): Measured {
  const m = exec(op);
  let positions: Float32Array;
  let indices: Uint32Array;
  let assembly: { min: Vec3; max: Vec3 };
  try {
    const mesh = m.getMesh();
    positions = new Float32Array(mesh.vertProperties);
    indices = new Uint32Array(mesh.triVerts);
    const bb = m.boundingBox();
    assembly = {
      min: [bb.min[0], bb.min[1], bb.min[2]] as Vec3,
      max: [bb.max[0], bb.max[1], bb.max[2]] as Vec3,
    };
  } finally {
    m.delete();
  }
  const node: MeshNode = {
    id,
    buffer: { positions, indices },
    stats: { vertexCount: positions.length / 3, triangleCount: indices.length / 3, bbox: assembly },
  };
  const [laid] = applyLayoutToMeshes([node]);
  if (!laid) throw new Error(`${id}: no laid mesh`);
  const after = meshExtent(laid.positions);
  return { assembly, positions, laid: laid.positions, laidSize: after.size, laidMin: after.min };
}

describe('declared print orientation reaches the export (#358)', () => {
  it('lays each rack side panel flat, inner face down', () => {
    const tpl = findTemplate('mini-rack-10in');
    if (!tpl) throw new Error('mini-rack-10in template not found');
    const plan = compileProject(tpl.build());
    const sides = (['rack-side-left', 'rack-side-right'] as const).map((id) => {
      const node = plan.nodes.find((n) => n.id === id);
      if (!node) throw new Error(`${id} not in the plan`);
      return { id, ...measure(id, node.op) };
    });

    // The rack's centreline, from the panels themselves rather than a parameter: whichever of a
    // panel's two x-faces is nearer it is the INNER face — the one the note wants on the bed.
    const all = sides.flatMap((s) => [s.assembly.min[0], s.assembly.max[0]]);
    const centre = (Math.min(...all) + Math.max(...all)) / 2;

    for (const s of sides) {
      const asm = meshExtent(s.positions);

      // Stands on edge as modelled: its thinnest axis is x. This is the state the issue reports.
      expect(asm.size[0], `${s.id} assembly is a thin panel in x`).toBeCloseTo(SIDE_T, 6);

      // Laid down: the same panel thickness is now the print height, and the panel's height and
      // depth are the bed footprint.
      expect(s.laidSize[2], `${s.id} print height is the panel thickness`).toBeCloseTo(SIDE_T, 6);
      expect(s.laidSize[0], `${s.id} footprint x is the panel height`).toBeCloseTo(asm.size[2], 6);
      expect(s.laidSize[1], `${s.id} footprint y is the panel depth`).toBeCloseTo(asm.size[1], 6);
      expect(s.laidMin[2], `${s.id} sits on the bed`).toBeCloseTo(0, 6);

      // Inner face DOWN: every vertex on the inner-face plane ends at the panel's lowest z.
      const innerX =
        Math.abs(s.assembly.min[0] - centre) < Math.abs(s.assembly.max[0] - centre)
          ? s.assembly.min[0]
          : s.assembly.max[0];
      let onInner = 0;
      let highest = -Infinity;
      for (let i = 0; i < s.positions.length; i += 3) {
        if (Math.abs(s.positions[i]! - innerX) > 1e-4) continue;
        onInner++;
        const z = s.laid[i + 2]!;
        if (z > highest) highest = z;
      }
      expect(onInner, `${s.id} has vertices on the inner face`).toBeGreaterThan(100);
      // The inner face is a whole plane of the panel, so if it is the bed face then its HIGHEST
      // vertex is also the part's lowest — every one of them is down, not merely most of them.
      expect(highest, `${s.id} inner face is the bottom face`).toBeCloseTo(s.laidMin[2], 6);
    }

    // The two panels are chiral, so one shared sign cannot lay both flat; each turns its own way.
    // (The table's [0, 90, 0] / [0, −90, 0] is exactly that pair, and the boxes above prove each
    // sign lays its own panel down — swap them and one panel stands on edge.)
    expect(printMetaForId('rack-side-left').rotation[1]).toBeGreaterThan(0);
    expect(printMetaForId('rack-side-right').rotation[1]).toBeLessThan(0);
  }, 60_000);

  it('lays a divider peg on its side, tenons sideways — what its note says', () => {
    // The peg is the other part whose table entry declares a rotation, so #358 switching the
    // rotation on changes it too. Same fixture `dividerPegs.spec.ts` pins.
    const height = 20;
    const op = buildDividerPegOp(
      { id: 'p3', spans: 3, height, thickness: 3, enabled: true },
      { grid: { pitch: 12, socket: 5 }, socketDepth: 5 },
    );
    if (!op) throw new Error('peg did not build');

    const m = measure('divider-peg-p3', op);
    const asm = meshExtent(m.positions);

    // As modelled the peg stands upright: the wall's thickness is its y extent and that is the
    // smallest of the three, with the tenons hanging below z = 0.
    expect(asm.size[1], 'assembly: the wall is thin in y').toBeLessThan(height);
    expect(asm.min[2], 'assembly: the tenons hang below z = 0').toBeLessThan(0);

    // Laid on its side, the thin axis becomes the print height and the wall's height (plus the
    // tenons, which run sideways now) becomes the footprint's y. Under the quarter turn about X
    // those are exactly the assembly extents, exchanged: [x, z, y].
    //
    // 4 places, not 6: the laid buffer is `Float32Array` and these extents are differences of
    // values that are not exact in single precision — this is float noise, not a tolerance on the
    // geometry (the rack panels above are axis-aligned, so they compare at 6).
    expect(m.laidSize[2], 'print height is the wall thickness').toBeCloseTo(asm.size[1], 4);
    expect(m.laidSize[1], 'tenons point sideways, so height becomes footprint y').toBeCloseTo(
      asm.size[2],
      4,
    );
    expect(m.laidSize[0], 'length is unchanged').toBeCloseTo(asm.size[0], 4);
    expect(m.laidMin[2], 'sits on the bed').toBeCloseTo(0, 4);
  }, 60_000);
});
