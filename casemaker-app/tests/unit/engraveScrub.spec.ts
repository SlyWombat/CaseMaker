// §5.7 — the design ↔ as-cut slider's mapping. It is deliberately pure: the worker's stages are
// positions, and resolving a stored position (which can outlive the preview it was chosen on) is
// arithmetic that must not need a canvas, a renderer or a second preview build.

import { describe, it, expect } from 'vitest';

import {
  floorsForScrub,
  scrubStateAt,
  scrubWords,
  type EngraveScrubState,
} from '@/components/viewport/engraveScrub';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

/** A body with an identity but no triangles: the mapping never reads them. */
function body(id: number): NodeMeshOutput {
  return { id } as unknown as NodeMeshOutput;
}

const design = body(0);
const atHalf = body(1);
const atOne = body(2);
const finished = body(3);

/** The fields the mapping is allowed to read, with a real preview's shape around them. */
function preview(): EngravePreview {
  return {
    stock: finished,
    stages: [
      { depth: 0, mesh: design },
      { depth: 0.5, mesh: atHalf },
      { depth: 1, mesh: atOne },
    ],
    floors: [{ labelId: 'a', depth: 0.5, mesh: body(4) }, { labelId: 'b', depth: 1, mesh: body(5) }, { labelId: 'c', depth: 2, mesh: body(6) }],
  } as unknown as EngravePreview;
}

describe('the design ↔ as-cut slider (§5.7)', () => {
  it('puts a null position at the as-cut end, drawing the finished stock', () => {
    const s = scrubStateAt(preview(), null);
    expect(s).toMatchObject({ index: 3, max: 3, depth: 2, atCut: true });
    expect(s.mesh).toBe(finished);
    expect(scrubWords(s)).toBe('as cut');
  });

  it('puts position 0 at the uncut design and steps through one cut depth per position', () => {
    const p = preview();
    const first = scrubStateAt(p, 0);
    expect(first).toMatchObject({ index: 0, max: 3, depth: 0, atCut: false });
    expect(first.mesh).toBe(design);
    expect(scrubWords(first)).toBe('design (uncut)');

    const half = scrubStateAt(p, 1);
    expect(half).toMatchObject({ index: 1, depth: 0.5, atCut: false });
    expect(half.mesh).toBe(atHalf);
    expect(scrubWords(half)).toBe('cut to 0.5 mm');

    // The deepest cut is the finished stock, not a fourth stage.
    const last = scrubStateAt(p, 3);
    expect(last.mesh).toBe(finished);
    expect(last.atCut).toBe(true);
  });

  it('clamps a position that outlived its preview, so an edit cannot index a missing stage', () => {
    const p = preview();
    expect(scrubStateAt(p, 99).index).toBe(3);
    expect(scrubStateAt(p, -2).index).toBe(0);
    // The range's step is 1, so a fractional value can only arrive from a caller; it resolves to
    // the stage below rather than throwing.
    expect(scrubStateAt(p, 1.9)).toMatchObject({ index: 1, depth: 0.5 });
    expect(scrubStateAt(p, Number.NaN).index).toBe(3);
  });

  it('is as cut, with no control, when the preview has nothing to scrub', () => {
    const p = { ...preview(), stages: [] } as EngravePreview;
    const s = scrubStateAt(p, 0);
    expect(s).toMatchObject({ index: 0, max: 0, atCut: true });
    expect(s.mesh).toBe(finished);
    expect(scrubWords(s)).toBe('as cut');
  });
});

describe('floors follow the slider (§5.7)', () => {
  const floors = [
    { labelId: 'a', depth: 0.5 },
    { labelId: 'b', depth: 1 },
    { labelId: 'c', depth: 2 },
  ];

  it('hides a floor until its cut has happened', () => {
    const designState: EngraveScrubState = scrubStateAt(preview(), 0);
    expect(floorsForScrub(floors, designState)).toEqual([]);

    const half = scrubStateAt(preview(), 1);
    expect(floorsForScrub(floors, half).map((f) => f.labelId)).toEqual(['a']);

    const one = scrubStateAt(preview(), 2);
    expect(floorsForScrub(floors, one).map((f) => f.labelId)).toEqual(['a', 'b']);
  });

  it('shows every floor at the as-cut end', () => {
    expect(floorsForScrub(floors, scrubStateAt(preview(), null))).toBe(floors);
  });
});
