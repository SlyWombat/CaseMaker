/**
 * #1073 — SIDE 2'S Z0 IS CARRIED, IN MACHINE TERMS (6b's amendment A).
 *
 * The rough underside is never touched: side 2's top sits at
 *
 *     seat + T_measured − facing₁     (machine Z)
 *
 * where the seat is the bed datum the seat press measures, T_measured is side 1's top touch less
 * the seat, and facing₁ is side 1's facing depth (0 by default). The corner Z touches on side 2
 * are the CHECK of that value — a reading outside the surface tolerance stops with the number.
 *
 * RED at m1-land8: no such derivation exists, and a flip's sheet never prints a carried Z0.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flipOrientation, flipZ0 } from '@/engine/cnc/engrave/flipChoice';
import { buildRunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

const NOW = new Date('2026-11-08T12:00:00Z');

describe('#1073 side 2’s Z0 in machine terms', () => {
  it('seat + measured thickness − facing, with the three numbers and the sum', () => {
    const z0 = flipZ0({ seatMm: -12, thicknessMm: 25, facingMm: 0, toleranceMm: 0.05 });
    expect(z0.topMachineZ).toBeCloseTo(13, 9);
    expect(z0.checkBand).toEqual({ minMm: 12.95, maxMm: 13.05 });
    const words = z0.words.join(' ');
    // The acceptance's own line, verbatim.
    expect(words).toContain('carried from side 1: Z0₁ − 25.00 mm');
    // The three numbers and the sum.
    expect(words).toContain('seat −12.00 + measured thickness 25.00 − side 1’s facing 0.00 = 13.00 mm');
    // The check, not the source; the rough face is never touched.
    expect(words).toContain('must read 13.00 ± 0.05 mm (12.95 to 13.05)');
    expect(words).toContain('never re-derived from the rough face');
  });

  it('a faced side 1 removes its facing from the sum', () => {
    const z0 = flipZ0({ seatMm: -12, thicknessMm: 25, facingMm: 0.4 });
    expect(z0.topMachineZ).toBeCloseTo(12.6, 9);
    expect(z0.checkBand).toBeNull();
    expect(z0.words.join(' ')).toContain('stops with the number');
  });
});

function setup(over: Partial<JobSetup> = {}): JobSetup {
  const base = defaultEngraveJob();
  return {
    id: 'setup-1',
    orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
    mount: { kind: 'bracket' },
    itemIds: [],
    tools: [base.toolKey],
    ...over,
  };
}

function twoSidedJob(withFlip: boolean): EngraveJob {
  const base = defaultEngraveJob();
  const second = setup({
    id: 'setup-2',
    orientation: flipOrientation('left-right'),
    pins: { at: [{ x: 30, y: 56 }, { x: 70, y: 56 }] },
    ...(withFlip ? { flip: { method: 'tabs-in-blank' as const, axis: 'left-right' as const } } : {}),
  });
  // The maintainer’s one-right-angle blank: the fenced corner on side 2 is NOT square.
  return { ...base, stock: { ...base.stock, squareCorners: ['FL'] }, setups: [setup(), second] };
}

function generated(job: EngraveJob): RunSheetGenerated {
  const program = (setupIndex: number, nc: string) => ({
    kind: 'engrave' as const,
    setupIndex,
    toolKey: job.toolKey,
    nc,
    frameNc: null,
    cam: null,
  });
  return {
    findings: [],
    feeds: null,
    cam: null,
    nc: 'side-1.nc',
    verify: null,
    frameNc: null,
    programs: [program(1, 'side-1.nc'), program(2, 'side-2.nc')],
  };
}

function cutTwo(job: EngraveJob, options: Parameters<typeof buildRunSheet>[5] = {}) {
  const sheet = buildRunSheet(job, generated(job), { diagnostics: [] }, NOW, undefined, options);
  const cut2 = sheet.sections.find((s) => s.id === 'cut-2');
  expect(cut2, 'the second program has its own section').toBeTruthy();
  return cut2!;
}
function cutTwoText(job: EngraveJob, options: Parameters<typeof buildRunSheet>[5] = {}): string {
  return cutTwo(job, options).steps.map((s) => s.text).join('\n');
}

describe('#1073 the sheet carries side 2’s Z0', () => {
  it('a flip’s setup-2 page prints the three numbers and the sum', () => {
    const text = cutTwoText(twoSidedJob(true), { flipZ0: { seatMm: -12, thicknessMm: 25, facingMm: 0, toleranceMm: 0.05 } });
    expect(text).toContain('Z0 on side 2 is carried from side 1');
    // #1073 — the sheet's edge words: which former edge meets which arm, and the fenced corner.
    expect(text).toContain('The corner in the fence is FR');
    expect(text).toContain('NOT one of the blank’s square corners');
    expect(text).toContain('its right edge comes round to the fence side');
    // #1073 — the front arm holds an edge that is NOT square: STATED, not refused.
    expect(text).toContain('that edge is NOT one of the blank’s square edges');
    expect(text).toContain('carried from side 1: Z0₁ − 25.00 mm');
    expect(text).toContain('= 13.00 mm');
    expect(text).toContain('12.95 to 13.05');
    const step = cutTwo(twoSidedJob(true), { flipZ0: { seatMm: -12, thicknessMm: 25, facingMm: 0, toleranceMm: 0.05 } }).steps.find(
      (x) => x.text.includes('carried from side 1'),
    );
    expect(step!.value).toBe('side 2 top · machine Z 13');
  });

  it('without the numbers the sheet still states the carried rule and its check', () => {
    const text = cutTwoText(twoSidedJob(true));
    expect(text).toContain('Z0 on side 2 is CARRIED from side 1');
    expect(text).toContain('never touched on the rough underside');
    expect(text).toContain('are the CHECK of it');
  });

  it('a job with no flip prints no carried Z0 at all', () => {
    const text = cutTwoText(twoSidedJob(false), { flipZ0: { seatMm: -12, thicknessMm: 25 } });
    expect(text).not.toContain('Z0 on side 2');
  });
});
