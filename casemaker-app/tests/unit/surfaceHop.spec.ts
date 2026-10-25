// #649 — THE HOP CLEARS A LIFTED TOP.
//
// `applySurfaceLift` shifts FEED moves only, so an inter-loop rapid that ends at the CAM's fixed
// `HOP_Z` (1 mm) sits INSIDE a blank the fitted tilt lifts more than that: the next "plunge" starts
// cutting from inside the material. The generator raises the hop by the plane's highest lift over
// the stock — one number for the whole program — so every rapid keeps the nominal 1 mm clearance;
// above 1 mm of lift it also raises a warning that names G32 as the operator's alternative.
//
// Three cases, one blank: no frame (the flat program's own Z1 hop), a gentle tilt whose lift stays
// under the hop (raised, no warning — the clearance is maintained rather than the program changed),
// and a steep tilt whose lift crosses it (warning).

import { describe, expect, it } from 'vitest';

import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { surfaceLift, type SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import type { EngraveJob, EngraveTraceItem } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

const bit30 = (): Tool => ({
  number: 1,
  id: 'C1-BIT-ENGRAVE-30-0.3',
  name: 'Single Flute Engraving Bit 30 x 0.3',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.3,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
});

/** A 100 × 60 blank with one V trace — the stock the hop is measured over. */
function job(): EngraveJob {
  const base = defaultEngraveJob();
  const trace: EngraveTraceItem = {
    kind: 'line',
    id: 'tr',
    position: { x: 0, y: 0 },
    rotation: 0,
    points: [
      [10, 20],
      [90, 40],
    ],
    closed: false,
    depth: 0.3,
    enabled: true,
  };
  return {
    ...base,
    name: 'surface hop',
    stock: { length: 100, width: 60, thickness: 12, material: 'pla' },
    labels: [],
    shapes: [],
    toolKey: 'inv:kz-engrave-30-0-3',
    tool: bit30(),
    minFloor: 1,
    edgeMargin: 1,
    traces: [trace],
  };
}

/** 0.84 mm at (100, 60) — under the 1 mm hop. */
const GENTLE: SurfaceFrame = { plane: { offset: 0, slopeX: 0.006, slopeY: 0.004 }, z0: 0 };
/** 2 mm at x = 100 — over the hop. */
const STEEP: SurfaceFrame = { plane: { offset: 0, slopeX: 0.02, slopeY: 0 }, z0: 0 };

/** Every rapid's Z in the posted text (`G0 Z…`), as numbers. */
function rapidZ(nc: string): number[] {
  return [...nc.matchAll(/^G0 Z(-?[\d.]+)$/gm)].map((m) => Number(m[1]));
}

function hopOf(nc: string): number {
  // The hop is the lowest rapid height in the program: the SAFE_Z retract and the final retract
  // are both above it.
  return Math.min(...rapidZ(nc));
}

describe('#649 the hop clears the fitted surface', () => {
  it('keeps the flat program’s Z1 hop when there is no fitted frame', () => {
    const g = generate(tl, job());
    if (g.nc === null) throw new Error(`generate refused at ${g.stage}`);
    expect(hopOf(g.nc)).toBe(1);
    expect(g.findings.some((f) => f.code === 'surface-hop-raised')).toBe(false);
  });

  it('raises the hop by the higher of Z0 and the plane’s lift over the stock', () => {
    expect(Math.max(0, surfaceLift(GENTLE.plane, GENTLE.z0, 100, 60))).toBeCloseTo(0.84, 9);
    const g = generate(tl, job(), null, [], undefined, { surface: GENTLE });
    if (g.nc === null) throw new Error(`generate refused at ${g.stage}`);
    // Every rapid sits at 1 + 0.84: the same 1 mm clearance over the LOCAL top.
    expect(hopOf(g.nc)).toBe(1.84);
    // Under the hop the program is safe without a word: no warning, the clearance did its job.
    expect(g.findings.some((f) => f.code === 'surface-hop-raised')).toBe(false);
  });

  it('warns, naming G32, when the tilt lifts the blank more than the hop', () => {
    expect(surfaceLift(STEEP.plane, STEEP.z0, 100, 0)).toBeCloseTo(2, 9);
    const g = generate(tl, job(), null, [], undefined, { surface: STEEP });
    if (g.nc === null) throw new Error(`generate refused at ${g.stage}`);
    expect(hopOf(g.nc)).toBe(3);
    // No rapid is left at the old hop: every one of them was raised with the program.
    expect(rapidZ(g.nc)).not.toContain(1);
    const finding = g.findings.find((f) => f.code === 'surface-hop-raised');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('lifts the blank 2 mm at its highest corner');
    expect(finding?.message).toContain('every rapid in this program runs at 3 mm');
    expect(finding?.message).toContain('Run G32 from the console');
  });
});
