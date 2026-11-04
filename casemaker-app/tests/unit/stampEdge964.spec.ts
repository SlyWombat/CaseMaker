// #964 — A CELL CENTRED ON THE STAMP'S FOOTPRINT EDGE IS NOT CUT.
//
// E's check on #959: the part's contour is posted with the tool centre offset by the cutter
// radius, so the disc's edge is tangent to the outline — and 134 goal cells whose centres lie ON
// the outline (distance 0.000 from it) were charged as cut-into, because the stamp counted
// `distance <= radius`. The physical removal at that boundary is zero-measure. The page and the
// app now share one rule: a cell is cut only where its centre lies STRICTLY inside the cutter's
// footprint (`distance < radius - 1e-6`), so a cell centred on a disc's edge is not charged.
//
// The fixture is exactly that geometry: a flat-bottom goal whose covered cells start at a row of
// cell CENTRES, and a flat cutter whose path runs R below that row, so the footprint edge passes
// through those centres exactly.

import { describe, expect, it } from 'vitest';

import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { exactSweptField } from '@/workers/sim/sweptPoint';

const PITCH = 0.25; // exact in binary: the edge distance is a computed 1.0, not a rounding
const NX = 33; // x 0 .. 8
const NY = 13; // y 0 .. 3
const R = 1.0;
const OUTLINE_Y = 0.5; // a row of cell CENTRES (j = 2)

function goal(): GoalHeightfield {
  const z = new Float32Array(NX * NY); // the part's top, z = 0
  const covered = new Uint8Array(NX * NY);
  let coveredCount = 0;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      if (j * PITCH >= OUTLINE_Y - 1e-12) {
        covered[j * NX + i] = 1;
        coveredCount++;
      }
    }
  }
  return {
    nx: NX,
    ny: NY,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    topZ: 0,
    minZ: 0,
    z,
    covered,
    coveredCount,
    resolutionNote: 'test',
  };
}

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [12, 6] as [number, number] }, thickness: 5 };
const SETUP = stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });
const FLAT = flatEndMill(2 * R, { name: '2 mm flat', fluteLength: 10 });

/** A straight cut along X at `TOOL_Y`, 1 mm below the part top, past both ends of the grid. */
function stampAt(toolY: number): Float32Array {
  const nc = ['G21 G90', 'S1000 M3', 'G0 X-2 Z5', `G0 Y${toolY}`, 'G1 Z-1 F200', 'G1 X10 F400', 'G0 Z5', 'M2'].join('\n');
  const field = exactSweptField(goal(), buildTimeline(parseGcode(nc), SETUP), FLAT);
  expect(field).not.toBeNull();
  return field as Float32Array;
}

const at = (f: Float32Array, i: number, j: number): number => f[j * NX + i]!;

describe('#964 the stamp’s footprint edge', () => {
  it('a cell centred exactly on the disc edge is NOT charged; one pitch inside the footprint IS', () => {
    // The tool centre runs at y = -0.5, so the disc edge is exactly on the outline row y = 0.5.
    const f = stampAt(OUTLINE_Y - R);
    for (let i = 0; i < NX; i++) {
      expect(at(f, i, 2)).toBe(0); // the outline row: distance exactly R — not cut
      expect(at(f, i, 1)).toBeLessThan(-0.99); // y = 0.25: 0.75 below the edge — cut
      expect(at(f, i, 0)).toBeLessThan(-0.99);
    }
    // And the part's own first cell row above the outline is untouched, at the top.
    for (let i = 0; i < NX; i++) expect(at(f, i, 3)).toBe(0);
  });

  it('the 1e-6 rule is the rule: a cell 0.1 µm inside the disc edge is still not charged', () => {
    // The path moved 1e-7 mm toward the part: the outline row is at distance R - 1e-7, inside the
    // disc to the last decimal but not by the 1e-6 the rule requires.
    const f = stampAt(OUTLINE_Y - R + 1e-7);
    for (let i = 0; i < NX; i++) expect(at(f, i, 2)).toBe(0);
  });
});
