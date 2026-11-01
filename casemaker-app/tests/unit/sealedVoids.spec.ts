// Issue #850 — SEALED VOIDS: an accidental one is stated, a deliberate magnet
// pocket stays quiet.
//
// The geometry layer reports every closed cavity (Manifold decompose: negative
// volume, with its size and bbox centre). The compiler tags the cavities it
// makes on purpose — captured magnet pockets — and the scheduler states only
// the rest. These specs pin both halves against the real evaluator, plus the
// banner that says it.

import { describe, it, expect } from 'vitest';

import { sealedVoidsOf } from '@/workers/geometry/meshOutput';
import { classifySealedVoids, VOID_MATCH_MM, type DeliberateVoid } from '@/engine/compiler/sealedVoids';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { cube, difference, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import type { CaseParameters, Project } from '@/types';
import { exec } from './helpers/manifoldExec';

const BOARD_ID = 'rpi-4b';

function magnetProject(pockets: NonNullable<CaseParameters['magnetPockets']>): Project {
  const base = createDefaultProject(BOARD_ID);
  return { ...base, case: { ...base.case, magnetPockets: pockets } };
}

function boxWithSealedCavity(): BuildOp {
  const outer = cube([20, 20, 20]);
  const inner = translate([7, 7, 7], cube([6, 6, 6]));
  return difference([outer, inner]);
}

describe('#850 — the geometry layer reports sealed voids', () => {
  it('finds an enclosed cavity with its volume and centre', () => {
    const m = exec(boxWithSealedCavity());
    const voids = sealedVoidsOf(m);
    m.delete();
    expect(voids).toHaveLength(1);
    expect(voids[0]!.volumeMm3).toBeCloseTo(216, 1);
    expect(voids[0]!.centreMm[0]).toBeCloseTo(10, 1);
    expect(voids[0]!.centreMm[1]).toBeCloseTo(10, 1);
    expect(voids[0]!.centreMm[2]).toBeCloseTo(10, 1);
  });

  it('reports nothing for a solid with no cavity', () => {
    const m = exec(cube([20, 20, 20]));
    expect(sealedVoidsOf(m)).toEqual([]);
    m.delete();
  });
});

describe('#850 — a deliberate magnet pocket is quiet, an accident is stated', () => {
  it('tags a captured pocket at the cavity it cuts, on the shell', () => {
    const plan = compileProject(
      magnetProject([
        { id: 'm', face: '-z', u: 30, v: 30, size: '6x2', retention: 'captured', enabled: true },
      ]),
    );
    expect(plan.deliberateVoids?.length).toBeGreaterThan(0);
    expect(plan.deliberateVoids![0]!.node).toBe('shell');
    // The floor's underside is z = 0 and its material goes UP, so a pocket
    // cut into it from below puts the cavity above the plane.
    expect(plan.deliberateVoids![0]!.centreMm[2]).toBeGreaterThan(0);
  });

  it('tags nothing when the pocket is open (it cuts through to the face)', () => {
    const plan = compileProject(
      magnetProject([
        { id: 'm', face: '-y', u: 40, v: 15, size: '6x2', retention: 'glue', enabled: true },
      ]),
    );
    expect(plan.deliberateVoids ?? []).toEqual([]);
  });

  it('matches a reported void to its tag, and notes any other', () => {
    const deliberate: DeliberateVoid[] = [{ node: 'shell', centreMm: [20, 30, -4] }];
    // Within the tolerance of the tag — the same cavity, quiet.
    const atTag = { node: 'shell', volumeMm3: 200, centreMm: [19.5, 29.7, -3.8] as [number, number, number] };
    // Nowhere near it — an accident, stated.
    const away = { node: 'shell', volumeMm3: 2.1, centreMm: [60, 10, -20] as [number, number, number] };
    const notes = classifySealedVoids(new Map([['shell', [atTag, away]]]), deliberate);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.volumeMm3).toBeCloseTo(2.1, 6);
    expect(notes[0]!.centreMm).toEqual([60, 10, -20]);
  });

  it('a tag on a DIFFERENT node does not quiet the void', () => {
    const notes = classifySealedVoids(
      new Map([['lid', [{ node: 'lid', volumeMm3: 5, centreMm: [10, 10, 10] as [number, number, number] }]]]),
      [{ node: 'shell', centreMm: [10, 10, 10] }],
    );
    expect(notes).toHaveLength(1);
  });

  it('the match tolerance is the documented one', () => {
    expect(VOID_MATCH_MM).toBe(2);
  });
});
