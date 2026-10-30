/**
 * Gerber (RS-274X) import (#743 P-2) — the parser and the layer merge.
 *
 * `tiny-F_Cu.gbr` is a small board drawn for this test and generated in mm and in inches from the
 * same description. It holds every feature the design's slice names:
 *
 *   - two ⌀0.5 round pads at (5,5) and (15,5), joined by a ⌀0.25 trace;
 *   - a macro pad (`RoundRect` stadium, 1.2 × 0.8, r 0.2) at (10,10), drawn by three primitives
 *     whose sizes are macro ARITHMETIC (`$1-2x$3`, `($1/2-$3)`);
 *   - a 4 × 4 pour at (20,5) with a 1 × 1 `%LPC%` cut-out;
 *   - a ⌀0.25 half-circle arc (G03) from (30,5) to (30,9), centre (30,7).
 *
 * The analytic union area is
 *   capsule      2.5 mm × 0.25 + π·0.125²                       = 2.549087
 *   one pad      π·0.25²                                        = 0.196350
 *   pad∩capsule  the strip's half 0.059783 + the end half-disc   = 0.084327
 *   pads+trace   2.549087 + 2·(0.196350 − 0.084327)             = 2.773133
 *   macro pad    (1.2−0.4)·0.8 + π·0.2²                          = 0.765664
 *   pour         16 − 1                                          = 15
 *   arc          π·2·0.25 + π·0.125²                             = 1.619883
 *                                                                = 20.158680 mm²
 * and it is four connected pieces (pads+trace, macro pad, pour, arc). A sampled circle is a
 * polygon inscribed in the true one, so the merged area is a few hundredths of a percent under
 * this — the 0.5 % window is the design's own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tl } from './helpers/manifoldExec';
import { mergeGerberShapes, readGerber } from '@/engine/import/gerber';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const CAPSULE = 10 * 0.25 + Math.PI * 0.125 * 0.125;
const PAD = Math.PI * 0.25 * 0.25;
/** Area of a ⌀0.5 pad centred on a capsule's end: the strip's half, plus the end half-disc. */
const PAD_CAPSULE_OVERLAP = 0.059783 + (Math.PI * 0.125 * 0.125) / 2;
const ANALYTIC_AREA_MM2 =
  CAPSULE + 2 * (PAD - PAD_CAPSULE_OVERLAP) + // pads + trace
  ((1.2 - 2 * 0.2) * 0.8 + Math.PI * 0.2 * 0.2) + // macro stadium
  (16 - 1) + // pour minus its clear square
  (Math.PI * 2 * 0.25 + Math.PI * 0.125 * 0.125); // arc band

describe('Gerber copper (#743 P-2)', () => {
  it('reads every feature of the board, and states the layer function', () => {
    const parsed = readGerber(read('tiny-F_Cu.gbr'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fileFunction).toBe('Copper,L1,Top');
    // Two pad flashes, the trace, the macro flash, the pour, the clear region, the arc band (as
    // chorded strokes).
    expect(parsed.shapes.length).toBeGreaterThan(6);
    expect(parsed.shapes.filter((s) => s.polarity === 'clear')).toHaveLength(1);
    // The pour is one even-odd region; the clear cut-out is the only even-odd clear shape.
    const clear = parsed.shapes.find((s) => s.polarity === 'clear');
    expect(clear?.fillRule).toBe('EvenOdd');
    // The board's own extent: pad edge 4.75 … the arc's outer edge 32.125.
    expect(parsed.bounds?.min[0]).toBeCloseTo(4.75, 6);
    expect(parsed.bounds?.max[0]).toBeCloseTo(32.125, 6);
    expect(parsed.bounds?.max[1]).toBeCloseTo(10.4, 6); // the macro pad's top
  });

  it('merges to the analytic union area, with the clear cut-out taken out', () => {
    const parsed = readGerber(read('tiny-F_Cu.gbr'));
    if (!parsed.ok) throw new Error(parsed.error);
    const copper = mergeGerberShapes(tl, parsed.shapes);
    expect(copper.areaMm2).toBeGreaterThan(ANALYTIC_AREA_MM2 * 0.995);
    expect(copper.areaMm2).toBeLessThan(ANALYTIC_AREA_MM2 * 1.005);
    expect(copper.pieces).toBe(4);
    // The copper's own bounding box, from the merged rings.
    expect(copper.bounds?.min[0]).toBeCloseTo(4.75, 3);
    expect(copper.bounds?.max[0]).toBeCloseTo(32.125, 3);
  });

  it('reads the same board written in inches to the same geometry', () => {
    const mm = readGerber(read('tiny-F_Cu.gbr'));
    const inch = readGerber(read('tiny-F_Cu-inch.gbr'));
    if (!mm.ok) throw new Error(mm.error);
    if (!inch.ok) throw new Error(inch.error);
    const a = mergeGerberShapes(tl, mm.shapes);
    const b = mergeGerberShapes(tl, inch.shapes);
    expect(b.areaMm2).toBeCloseTo(a.areaMm2, 1);
    expect(Math.abs(b.areaMm2 - a.areaMm2) / a.areaMm2).toBeLessThan(0.005);
    expect(b.bounds?.min[0]).toBeCloseTo(a.bounds?.min[0] as number, 1);
    expect(b.bounds?.max[0]).toBeCloseTo(a.bounds?.max[0] as number, 1);
    expect(b.pieces).toBe(a.pieces);
  });

  it('refuses step-and-repeat by name, at its line', () => {
    const parsed = readGerber(read('sr.gbr'));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/line 5/i);
    expect(parsed.error).toMatch(/step-and-repeat/i);
  });

  it('refuses an unread macro primitive and a single-quadrant arc by name', () => {
    const macro = readGerber(
      [
        '%FSLAX46Y46*%',
        '%MOMM*%',
        '%AMThermal*',
        '6,0,0,1,1,0.5,0.1,0.1*',
        '%',
        '%ADD10Thermal,1.0*%',
        'D10*',
        'X0Y0D03*',
        'M02*',
      ].join('\n'),
    );
    expect(macro.ok).toBe(false);
    if (macro.ok) return;
    expect(macro.error).toMatch(/primitive 6/);

    const g74 = readGerber(
      ['%FSLAX46Y46*%', '%MOMM*%', '%ADD10C,0.5*%', 'D10*', 'X0Y0D02*', 'G74*', 'G03X1000000Y0I500000D01*', 'M02*'].join('\n'),
    );
    expect(g74.ok).toBe(false);
    if (g74.ok) return;
    expect(g74.error).toMatch(/single-quadrant/i);
  });

  it('refuses a file with no format, no unit, or no copper, rather than guessing', () => {
    const noFormat = readGerber(['%MOMM*%', '%ADD10C,0.5*%', 'D10*', 'X0Y0D03*'].join('\n'));
    expect(noFormat.ok).toBe(false);
    if (!noFormat.ok) expect(noFormat.error).toMatch(/format/i);

    const noUnit = readGerber(['%FSLAX46Y46*%', '%ADD10C,0.5*%', 'D10*', 'X0Y0D03*'].join('\n'));
    expect(noUnit.ok).toBe(false);
    if (!noUnit.ok) expect(noUnit.error).toMatch(/unit/i);

    const noCopper = readGerber(['%FSLAX46Y46*%', '%MOMM*%', 'M02*'].join('\n'));
    expect(noCopper.ok).toBe(false);
    if (!noCopper.ok) expect(noCopper.error).toMatch(/draws no copper/i);
  });
});
