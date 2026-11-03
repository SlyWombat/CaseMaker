/**
 * #898 part 2 — THE INTERFACE C NEEDS, built on #872's existing conversion rather than a new
 * shape (the design note posted to #945): the explicit affine BOTH WAYS (`setupAffine`), the
 * single Z offset `goalFlipPlan`'s reach-aware scoring uses instead of re-transforming a whole
 * mesh (`faceDepthOffsetMm`), which generated-program-list indexes belong to a setup
 * (`programIndexesFor`, read off the generator's OWN posted list rather than predicted), and the
 * one named exclusion the maintainer called out (`stockBottomExclusion`, #943 review §4.1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { orient } from '@/engine/cnc/setups/orient';
import type { MountSpec } from '@/engine/cnc/setups/types';
import {
  faceDepthOffsetMm,
  programIndexesFor,
  setupAffine,
  stockBottomExclusion,
  type Box3,
} from '@/engine/cnc/engrave/goalFlipSetups';
import { coverageTriangles, rotateCoverageMesh, sampleCoverageField, type CoverageMesh } from '@/engine/cnc/engrave/goalCoverage';
import type { Mat3 } from '@/engine/cnc/engrave/targetScale';
import { clearTargetObjectMeshCache, readTargetObjectFile, targetObjectMesh } from '@/engine/import/targetObject';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import type { EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

const VISE: MountSpec = { kind: 'vise', viseOpeningMm: 120 };
const STOCK: Box3 = { x: 36, y: 100, z: 36 };

const SAMPLE_POINTS: Box3[] = [
  { x: 0, y: 0, z: 0 },
  { x: STOCK.x, y: STOCK.y, z: -STOCK.z },
  { x: 18, y: 50, z: -27 },
  { x: 5, y: 95, z: -3.5 },
];

describe('#898 part 2 — setupAffine, both ways', () => {
  for (const face of ['top', 'bottom', 'left', 'right', 'front', 'back'] as const) {
    it(`${face}: toDocument(toSetup(p)) round-trips to p`, () => {
      const turned = orient(face, VISE, STOCK);
      if (!turned.ok) throw new Error(`${face} should be holdable on this stock: ${turned.reason}`);
      const R = turned.matrix.flat() as unknown as Mat3;
      const affine = setupAffine(R, STOCK);
      for (const p of SAMPLE_POINTS) {
        const w = affine.toSetup(p);
        const back = affine.toDocument(w);
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
        expect(back.z).toBeCloseTo(p.z, 6);
      }
    });

    it(`${face}: faceDepthOffsetMm matches the full affine's own z`, () => {
      const turned = orient(face, VISE, STOCK);
      if (!turned.ok) throw new Error(`${face} should be holdable on this stock: ${turned.reason}`);
      const R = turned.matrix.flat() as unknown as Mat3;
      const affine = setupAffine(R, STOCK);
      const kz = faceDepthOffsetMm(R, STOCK);
      for (const p of SAMPLE_POINTS) {
        // `goalFlipPlan`'s own shortcut: a PURE rotation of p (no shift), plus this one constant,
        // must equal the full chain's own z — the whole point of exporting the offset apart from
        // re-deriving the frame per triangle.
        const pureRotZ = R[6]! * p.x + R[7]! * p.y + R[8]! * p.z;
        expect(pureRotZ + kz).toBeCloseTo(affine.toSetup(p).z, 6);
      }
    });
  }

  it('top is the identity: toSetup is a no-op', () => {
    const turned = orient('top', VISE, STOCK);
    if (!turned.ok) throw new Error('top must be holdable');
    const R = turned.matrix.flat() as unknown as Mat3;
    const affine = setupAffine(R, STOCK);
    for (const p of SAMPLE_POINTS) {
      const w = affine.toSetup(p);
      expect(w.x).toBeCloseTo(p.x, 6);
      expect(w.y).toBeCloseTo(p.y, 6);
      expect(w.z).toBeCloseTo(p.z, 6);
    }
  });
});

describe('#898 part 2 — programIndexesFor reads the generator’s OWN posted list', () => {
  it('a plain two-setup run: each setup’s one program, in order', () => {
    const programs = [
      { setupId: 'setup-1' },
      { setupId: 'setup-2' },
    ];
    expect(programIndexesFor('setup-1', programs)).toEqual([0]);
    expect(programIndexesFor('setup-2', programs)).toEqual([1]);
  });

  it('a setup with a rest pass (two programs) and a dropped empty rest elsewhere', () => {
    // Setup 1 posts a rough + a measured rest (#472); setup 2's own rest found nothing to cut and
    // was dropped by the generator's settle pass — this is exactly why indexes are read off the
    // REAL list rather than predicted from `JobSetup.tools`.
    const programs = [
      { setupId: 'setup-1' }, // rough
      { setupId: 'setup-1' }, // rest
      { setupId: 'setup-2' }, // setup 2's rest never posted
    ];
    expect(programIndexesFor('setup-1', programs)).toEqual([0, 1]);
    expect(programIndexesFor('setup-2', programs)).toEqual([2]);
    expect(programIndexesFor('setup-3-does-not-exist', programs)).toEqual([]);
  });
});

describe('#898 part 2 — stockBottomExclusion: the elephant’s underside, a named first case', () => {
  // Built in the WORK-FRAME convention every real goal mesh uses (top flush at z = 0, the stock's
  // own floor at z = −h) — `stockBottomExclusion` anchors on that floor, not the mesh's own min.
  function box(w: number, d: number, h: number): CoverageMesh {
    const p: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d2: number[]): void => {
      p.push(...a, ...b, ...c, ...a, ...c, ...d2);
    };
    const [x0, x1, y0, y1, z0, z1] = [0, w, 0, d, -h, 0];
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // top
    quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]); // bottom (flat, facing down)
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    const positions = new Float32Array(p);
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    return { positions, indices };
  }

  it('a flat-bottomed box: the whole bottom face is the exclusion', () => {
    const mesh = box(40, 30, 20);
    const excluded = stockBottomExclusion(mesh, 20);
    expect(excluded).not.toBeNull();
    expect(excluded!.reason).toBe('stock-bottom');
    expect(excluded!.areaMm2).toBeCloseTo(40 * 30, 1);
  });

  it('a sphere: no flat face at its minimum — this named first case does not apply, and says so', () => {
    const p: number[] = [];
    const r = 15;
    const rings = 16, segs = 32;
    // Work-frame convention: top flush at z = 0, the stock's own floor at z = −2r.
    const at = (i: number, j: number): [number, number, number] => {
      const phi = (i / rings) * Math.PI;
      const theta = (j / segs) * 2 * Math.PI;
      return [r + r * Math.sin(phi) * Math.cos(theta), r + r * Math.sin(phi) * Math.sin(theta), -(r + r * Math.cos(phi))];
    };
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
        p.push(...a, ...c, ...b, ...a, ...d, ...c);
      }
    }
    const positions = new Float32Array(p);
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    const excluded = stockBottomExclusion({ positions, indices }, 2 * r);
    // Discretised at 16×32, no triangle near the pole is within 3° of straight down (the facets
    // are coarser than that), so the sphere's true curvature means this named first case does
    // not apply at all — distinguishing it from a box, whose whole bottom face qualifies.
    expect(excluded).toBeNull();
  });

  it('the committed figure.stl proxy, at goalCorpus873’s j29-adapted stick placement: reported, not asserted either way', async () => {
    // #914's report-back promise ("report what is untested on the proxy"): this fixture is NOT
    // claimed to reproduce the real elephant's underside — it only states what the function finds
    // on the shape this repo actually has, at `goalCorpus873.spec.ts`'s OWN j29-adapted placement
    // (scale 0.6533, chosen for THIS committed proxy mesh — the real j29 elephant job scales its
    // own local-only mesh by 0.8502, a different number for a different mesh), so a reader does
    // not have to guess. C's own wording is a percent of the surface, so that is reported too.
    const bytes = readFileSync(here('figure.stl'));
    const read = await readTargetObjectFile(new File([bytes], 'figure.stl'), 'goal-figure-898');
    if (!read.ok) throw new Error(read.error);
    const target: EngraveTargetObject = {
      id: read.id,
      name: read.name,
      format: read.format,
      sha256: read.sha256,
      data: read.data,
      size: read.size,
      position: { x: 18, y: 50, z: 0 },
      rotation: 90,
      enabled: true,
      role: 'goal',
      scale: { x: 0.6533, y: 0.6533, z: 0.6533 },
    };
    const mesh = targetObjectMesh(target);
    const { place } = placeTarget(target, mesh);
    const positions = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = place(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
      positions[i] = x;
      positions[i + 1] = y;
      positions[i + 2] = z;
    }
    const coverageMesh: CoverageMesh = { positions, indices: mesh.indices };
    // The real j29 stock is 36 mm thick — the plane this function anchors on, not the goal's own
    // lowest point (which sits a few mm clear of it; see this function's own doc for why that
    // distinction is the fix, not a style choice).
    const excluded = stockBottomExclusion(coverageMesh, 36);
    const facts = coverageTriangles(coverageMesh, sampleCoverageField(coverageMesh, 0.3), {});
    const totalMm2 = facts.reduce((a, f) => a + f.areaMm2, 0);
    // eslint-disable-next-line no-console
    console.log(
      `#898 figure.stl @ goalCorpus873's j29-adapted placement, stock-bottom exclusion: ${
        excluded === null ? 'none found' : `${excluded.areaMm2.toFixed(1)} mm², ${((excluded.areaMm2 / totalMm2) * 100).toFixed(2)}% of the surface`
      }`,
    );
    expect(excluded === null || excluded.areaMm2 > 0).toBe(true);
  });
});

describe('#898 part 2 — rotateCoverageMesh stays untouched by the new affine', () => {
  it('a pure rotation with no shift is still what goalFlipPlan uses for classification', () => {
    const mesh: CoverageMesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const same = rotateCoverageMesh(mesh, I);
    expect(Array.from(same.positions)).toEqual(Array.from(mesh.positions));
  });
});
