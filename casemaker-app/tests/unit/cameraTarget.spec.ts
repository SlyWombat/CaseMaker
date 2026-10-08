// The camera calibration target (#189), the machine-free half: the layout, the printable art, and
// the job that mills the fiducials. The geometry tests are pure; the last one runs the real
// generator, because "the job builder returns a plausible object" is not the same claim as "the
// app accepts the job", and only the second one matters.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { Z1 } from '@/engine/cnc/machine';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import {
  CAMERA_TARGET_MARGIN,
  cameraFiducialCutCount,
  cameraFiducialJob,
  cameraTargetCheckerSquares,
  cameraTargetFiducialZones,
  cameraTargetFiducials,
  cameraTargetFor,
  cameraTargetPage,
  cameraTargetProblem,
  cameraTargetSvg,
} from '@/engine/cnc/camera';
import { CAMERA_CAPTION_STRIP, CAMERA_FRONT_STRIP } from '@/engine/cnc/camera/targetArt';
import type { CameraTargetSpec } from '@/engine/cnc/camera';

/** A spec with a field replaced, without repeating the whole derived default. */
function tweak(patch: (s: CameraTargetSpec) => CameraTargetSpec): CameraTargetSpec {
  return patch(cameraTargetFor());
}

/** The same spec with its fiducials out of the pattern's way, so a pattern test sees the pattern. */
function fiducialFree(s: CameraTargetSpec): CameraTargetSpec {
  return { ...s, fiducials: { ...s.fiducials, count: { x: 1, y: 1 }, origin: { x: -50, y: -50 } } };
}

/** Do two sheet-coordinate boxes meet? Half-open, so touching edges do not count. */
function meets(
  a: { at: readonly [number, number]; w: number; d: number },
  b: { at: readonly [number, number]; w: number; d: number },
): boolean {
  return a.at[0] < b.at[0] + b.w && a.at[0] + a.w > b.at[0] && a.at[1] < b.at[1] + b.d && a.at[1] + a.d > b.at[1];
}

describe('cameraTargetFor (#189)', () => {
  it('derives a sheet inside the machine envelope, with the margin on every side', () => {
    const spec = cameraTargetFor(Z1);
    const span = Z1.envelope.x.max - Z1.envelope.x.min;
    const spanY = Z1.envelope.y.max - Z1.envelope.y.min;
    expect(spec.sheet.width).toBe(span - 2 * CAMERA_TARGET_MARGIN);
    expect(spec.sheet.depth).toBe(spanY - 2 * CAMERA_TARGET_MARGIN);
  });

  it('centres the grid, so the four margins are equal', () => {
    const spec = cameraTargetFor();
    const { count, pitch, origin, arm } = spec.fiducials;
    const half = arm / 2;
    const left = origin.x - half;
    const right = spec.sheet.width - (origin.x + (count.x - 1) * pitch.x) - half;
    const front = origin.y - half;
    const back = spec.sheet.depth - (origin.y + (count.y - 1) * pitch.y) - half;
    expect(left).toBeCloseTo(right, 9);
    expect(front).toBeCloseTo(back, 9);
  });

  it('derives a spec that passes its own check', () => {
    expect(cameraTargetProblem(cameraTargetFor())).toBeNull();
  });
});

describe('cameraTargetFiducials (#189)', () => {
  it('lays the grid out row-major from the lower-left', () => {
    const spec = tweak((s) => ({ ...s, fiducials: { ...s.fiducials, count: { x: 3, y: 2 }, pitch: { x: 10, y: 20 }, origin: { x: 5, y: 7 } } }));
    expect(cameraTargetFiducials(spec)).toEqual([
      [5, 7],
      [15, 7],
      [25, 7],
      [5, 27],
      [15, 27],
      [25, 27],
    ]);
  });

  it('mills two arms per cross', () => {
    const spec = cameraTargetFor();
    expect(cameraFiducialCutCount(spec)).toBe(cameraTargetFiducials(spec).length * 2);
  });
});

describe('cameraTargetCheckerSquares (#189)', () => {
  it('draws a checkerboard, not a solid block: exactly the (col + row) odd squares', () => {
    const spec = tweak((s) => fiducialFree({ ...s, sheet: { width: 40, depth: 30 }, checker: { ...s.checker, square: 10, margin: 0 } }));
    const squares = cameraTargetCheckerSquares(spec).map((s) => [s.at[0] / 10, s.at[1] / 10]);
    expect(squares).toEqual([
      [1, 0],
      [3, 0],
      [0, 1],
      [2, 1],
      [1, 2],
      [3, 2],
    ]);
  });

  it('keeps the whole pattern inside the sheet', () => {
    const spec = cameraTargetFor();
    for (const s of cameraTargetCheckerSquares(spec)) {
      expect(s.at[0]).toBeGreaterThanOrEqual(0);
      expect(s.at[1]).toBeGreaterThanOrEqual(0);
      expect(s.at[0] + s.size).toBeLessThanOrEqual(spec.sheet.width);
      expect(s.at[1] + s.size).toBeLessThanOrEqual(spec.sheet.depth);
    }
  });
});

describe('cameraTargetFiducialZones (#189)', () => {
  it('gives every fiducial a pocket that holds its whole clear zone, snapped to the grid', () => {
    const spec = cameraTargetFor();
    const { clear, square } = spec.checker;
    const zones = cameraTargetFiducialZones(spec);
    expect(zones.map((z) => z.fiducial)).toEqual(cameraTargetFiducials(spec).map((_, i) => i));
    cameraTargetFiducials(spec).forEach(([x, y], i) => {
      const z = zones[i]!;
      // Snapped outward, never inward: the pocket is at least the clear box, on every side.
      expect(z.at[0]).toBeLessThanOrEqual(x - clear);
      expect(z.at[0] + z.width).toBeGreaterThanOrEqual(x + clear);
      expect(z.at[1]).toBeLessThanOrEqual(y - clear);
      expect(z.at[1] + z.depth).toBeGreaterThanOrEqual(y + clear);
      // Whole squares: its extent is a whole number of them.
      expect(z.width % square).toBeCloseTo(0, 9);
      expect(z.depth % square).toBeCloseTo(0, 9);
      // And the cross, with the label's pad, fits inside.
      expect(z.width).toBeGreaterThanOrEqual(spec.fiducials.arm);
      expect(z.depth).toBeGreaterThanOrEqual(spec.fiducials.arm);
    });
  });

  it('omits the pattern squares that fall in a pocket, and nothing else', () => {
    const spec = cameraTargetFor();
    const zones = cameraTargetFiducialZones(spec);
    const withZones = cameraTargetCheckerSquares(spec);
    const without = cameraTargetCheckerSquares(fiducialFree(spec));
    for (const s of withZones) {
      for (const z of zones) {
        expect(meets({ at: s.at, w: s.size, d: s.size }, { at: z.at, w: z.width, d: z.depth })).toBe(false);
      }
    }
    // Every square is a whole square of the pattern, so the only difference is what the pockets ate.
    expect(withZones.length).toBeLessThan(without.length);
    expect(without.length - withZones.length).toBeLessThan(without.length / 2);
    const key = (s: { at: readonly number[] }) => `${s.at[0]},${s.at[1]}`;
    const all = new Set(without.map(key));
    expect(withZones.every((s) => all.has(key(s)))).toBe(true);
  });
});

describe('cameraTargetProblem (#189)', () => {
  it('accepts the derived default and rejects a grid that runs off the sheet', () => {
    expect(cameraTargetProblem(cameraTargetFor())).toBeNull();
    const off = tweak((s) => ({
      ...s,
      sheet: { width: 40, depth: 40 },
      fiducials: { ...s.fiducials, origin: { x: 2, y: 2 } },
    }));
    expect(cameraTargetProblem(off)).toMatch(/reaches past the sheet/);
  });

  it('rejects a stroke wider than the arm, and a checker square that does not fit', () => {
    const fat = tweak((s) => ({ ...s, fiducials: { ...s.fiducials, stroke: 20 } }));
    expect(cameraTargetProblem(fat)).toMatch(/wider than its arm/);
    // A small sheet whose single cross fits, but whose checker square cannot: the two checks are
    // independent, so the fiducial one must not be what fires.
    const coarse = tweak((s) => ({
      ...s,
      sheet: { width: 8, depth: 8 },
      fiducials: { ...s.fiducials, count: { x: 1, y: 1 }, arm: 2, origin: { x: 4, y: 4 } },
      checker: { ...s.checker, square: 12, margin: 4 },
    }));
    expect(cameraTargetProblem(coarse)).toMatch(/does not fit/);
  });

  it('rejects a fractional fiducial count', () => {
    const broken = tweak((s) => ({ ...s, fiducials: { ...s.fiducials, count: { x: 2.5, y: 3 } } }));
    expect(cameraTargetProblem(broken)).toMatch(/whole numbers/);
  });

  it('rejects a clear zone too tight for the cross and its label', () => {
    const tight = tweak((s) => ({ ...s, checker: { ...s.checker, clear: 5 } }));
    expect(cameraTargetProblem(tight)).toMatch(/widen the clear zone or shorten the arm/);
  });

  it('rejects a fiducial the printed pattern does not reach, and a pocket clipped by its edge', () => {
    // A pattern shrunk away from the grid: the crosses fall outside it and the camera can never see
    // them, which is a grid position silently missing from the calibration rather than a tight fit.
    const unreached = tweak((s) => ({ ...s, checker: { ...s.checker, margin: 40 } }));
    expect(cameraTargetProblem(unreached)).toMatch(/outside the printed pattern/);

    // A cross inside the pattern but close enough to its edge that the pocket snaps smaller than the
    // clear zone: the cut would cross printed squares on that side.
    const clipped = tweak((s) => ({ ...s, fiducials: { ...s.fiducials, count: { x: 1, y: 1 }, origin: { x: 10, y: 10 } } }));
    expect(cameraTargetProblem(clipped)).toMatch(/too close to the pattern's edge/);
  });
});

describe('cameraTargetSvg (#189)', () => {
  it('is deterministic, and dimensioned in millimetres at the page size', () => {
    const spec = cameraTargetFor();
    const a = cameraTargetSvg(spec);
    const b = cameraTargetSvg(spec);
    expect(a).toBe(b);
    const page = cameraTargetPage(spec);
    expect(a).toContain(`width="${page.width}mm"`);
    expect(a).toContain(`height="${page.height}mm"`);
    expect(page.height).toBe(CAMERA_CAPTION_STRIP + spec.sheet.depth + CAMERA_FRONT_STRIP);
    expect(a).not.toContain('NaN');
    expect(a).not.toContain('undefined');
  });

  it('paints nothing past the page: every label sits inside the viewBox', () => {
    // The first version of this file drew FRONT EDGE at page height + 5, which the viewBox clipped
    // away silently — a page claiming a front edge it did not show. Every length here is a
    // coordinate from the top of the page, so the whole check is "inside 0..height".
    const spec = cameraTargetFor();
    const page = cameraTargetPage(spec);
    const svg = cameraTargetSvg(spec);
    const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(spec.fiducials.count.x * spec.fiducials.count.y);
    for (const y of ys) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(page.height);
    }
  });

  it('prints no mark for the cut: the pockets are bare paper', () => {
    const spec = cameraTargetFor();
    const svg = cameraTargetSvg(spec);
    const zones = cameraTargetFiducialZones(spec);
    // The drawn rects as the pattern rects really are, in the second group's own coordinates: the
    // page's y is the sheet's y flipped about the caption strip, so undoing it gives the sheet box.
    const rects = [...svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"\/>/g)].map((m) => {
      const [x, y, w, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      return { at: [x, CAMERA_CAPTION_STRIP + spec.sheet.depth - y - d] as const, w, d };
    });
    expect(rects.length).toBeGreaterThan(0);
    for (const z of zones) {
      for (const r of rects) expect(meets(r, { at: z.at, w: z.width, d: z.depth })).toBe(false);
    }
  });

  it('puts sheet +Y UP the page: the lowest sheet row is drawn nearest the page bottom', () => {
    // The one orientation claim the art makes, and the one a mirrored sheet would silently break.
    // Fiducial labels carry their index, so the drawn y of index 0 (sheet row 0, lowest) must be
    // GREATER than index (count - 1) * count.x (the top row).
    const spec = cameraTargetFor();
    const drawn = new Map<number, number>();
    for (const m of cameraTargetSvg(spec).matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*>(\d+)<\/text>/g)) {
      drawn.set(Number(m[2]), Number(m[1]));
    }
    const bottom = drawn.get(0);
    const top = drawn.get((spec.fiducials.count.y - 1) * spec.fiducials.count.x);
    expect(bottom).toBeDefined();
    expect(top).toBeDefined();
    expect(bottom!).toBeGreaterThan(top!);
  });

  it('states the numbers it was built from, so a printed sheet is self-describing', () => {
    const spec = cameraTargetFor();
    const svg = cameraTargetSvg(spec);
    expect(svg).toContain(spec.id);
    expect(svg).toContain('FRONT EDGE');
    expect(svg).toContain('NOT trusted');
    expect(svg).toMatch(/160 x 160 mm/);
  });
});

describe('cameraFiducialJob (#189)', () => {
  it('resizes the stock to the sheet and discards the base job’s items', () => {
    const spec = cameraTargetFor();
    const base = defaultEngraveJob();
    const job = cameraFiducialJob(spec, base);
    expect(job.stock.length).toBe(spec.sheet.width);
    expect(job.stock.width).toBe(spec.sheet.depth);
    expect(job.stock.thickness).toBe(base.stock.thickness);
    expect(job.labels).toEqual([]);
    expect(job.shapes).toHaveLength(cameraFiducialCutCount(spec));
  });

  it('builds each cross from two sharp rectangles at one depth', () => {
    const spec = cameraTargetFor();
    const job = cameraFiducialJob(spec, defaultEngraveJob());
    const { arm, stroke, depth } = spec.fiducials;
    const first = job.shapes[0]!;
    expect(first.kind).toBe('rect');
    if (first.kind !== 'rect') throw new Error('unreachable');
    expect([first.width, first.height]).toEqual([arm, stroke]);
    expect(first.depth).toBe(depth);
    expect(first.cornerRadius).toBe(0);
    // The two arms cross at the fiducial's centre, so they share a position.
    expect(job.shapes[1]!.position).toEqual(first.position);
    expect(job.shapes[1]!.kind).toBe('rect');
  });

  it('generates: the app accepts the job and writes a clean .nc', () => {
    const job = cameraFiducialJob(cameraTargetFor(), defaultEngraveJob());
    const g = engraveGenerate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
