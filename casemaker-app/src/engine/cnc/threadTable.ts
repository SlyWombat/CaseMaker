/**
 * THE THREAD TABLE (#841) — every size a milled thread can name, metric and imperial, internal and
 * external, from stated standards. The CAM (`cam/threadMill.ts`), the findings (`validateJob`), the
 * row, the run sheet and the cutter pick all read the numbers here, so a size means one thing.
 *
 * ## Sources
 *
 * - **Metric** sizes and coarse pitches: **ISO 261**. M2–M6 are read from `FASTENERS`
 *   (`engine/compiler/fasteners.ts`) unchanged, so an internal metric thread posts byte-for-byte what
 *   it did before #841; M8, M10 and M12 are added here with the same arithmetic and rounding.
 * - **Unified** (UNC/UNF) sizes, basic major diameters and threads per inch: **ASME B1.1-2003**
 *   (Unified Inch Screw Threads), Table 2 "Series and Selected Combinations": the numbered sizes are
 *   `0.060 + 0.013·n` in, the fractions are their own value. The pitch is `P = 25.4 / TPI` mm.
 * - **Depths.** Both systems share the ISO 68-1 / ASME B1.1 60° basic profile (`H = 0.866025P`), so
 *   one pair of coefficients serves both — the same source the internal thread has used since #445:
 *   - internal (the pilot): the basic minor `D1 = D − 1.082532·P` (`2 × 5H/8`), ISO 68-1;
 *   - external (the root the tooth tip lands on): `d3 = d − 1.226869·P`, ISO 965-1's external minor
 *     with the minimum root radius `H/6` (`d1 − H/6`). ASME B1.1's UNR external root is shallower
 *     (`d − 1.190785·P`); the ISO root is used for imperial too so the tool model has ONE tooth form,
 *     and it errs deep — the nut still runs on.
 *
 * Every diameter is rounded to 0.001 mm, as `FASTENERS` rounds its own; the pitch is kept exact.
 *
 * ## The fit class the item records
 *
 * The helix lands the BASIC profile with no allowance, so the class is the one whose zero line is
 * the basic size: 6H / 6h (fundamental deviation zero, ISO 965-1) for metric, 3B / 3A (no allowance,
 * ASME B1.1) for unified.
 */

import { FASTENERS, type FastenerSize } from '@/engine/compiler/fasteners';

/** ISO 68-1: `2 × 5H/8` with `H = 0.866025P` — the basic minor (internal) depth coefficient. */
export const INTERNAL_MINOR_COEFF = 1.082532;
/** ISO 965-1: `d3 = d − 1.226869P` — the external minor with the minimum `H/6` root radius. */
export const EXTERNAL_MINOR_COEFF = 1.226869;

export type MetricThreadSize = FastenerSize | 'M8' | 'M10' | 'M12';

export type UnifiedThreadSize =
  | '#4-40'
  | '#4-48'
  | '#5-40'
  | '#5-44'
  | '#6-32'
  | '#6-40'
  | '#8-32'
  | '#8-36'
  | '#10-24'
  | '#10-32'
  | '#12-24'
  | '#12-28'
  | '1/4-20'
  | '1/4-28'
  | '5/16-18'
  | '5/16-24'
  | '3/8-16'
  | '3/8-24'
  | '7/16-14'
  | '7/16-20'
  | '1/2-13'
  | '1/2-20';

export type ThreadSize = MetricThreadSize | UnifiedThreadSize;
export type ThreadStandard = 'metric' | 'imperial';
export type ThreadSide = 'internal' | 'external';
/** The zero-allowance class for each system and side (see the header). */
export type ThreadClassFit = '6H' | '6h' | '3B' | '3A';

export interface ThreadSpec {
  size: ThreadSize;
  standard: ThreadStandard;
  /** `'M'` for ISO metric coarse, `'UNC'`/`'UNF'` for unified. */
  series: 'M' | 'UNC' | 'UNF';
  /** Basic major diameter, mm. */
  major: number;
  /** Pitch, mm (exact: `25.4 / tpi` for unified). */
  pitch: number;
  /** Threads per inch for a unified size; null for metric. */
  tpi: number | null;
  /** Basic major, inches, for a unified size (ASME B1.1's own number); null for metric. */
  majorIn: number | null;
  /** Basic internal minor `D1`, mm — the pilot an internal thread needs. */
  minor: number;
  /** External minor `d3`, mm — the root an external thread's tooth tip lands on. */
  externalMinor: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** ISO 261 coarse, beyond `FASTENERS`' M6. */
const METRIC_EXTRA: Record<Exclude<MetricThreadSize, FastenerSize>, { major: number; pitch: number }> = {
  M8: { major: 8, pitch: 1.25 },
  M10: { major: 10, pitch: 1.5 },
  M12: { major: 12, pitch: 1.75 },
};

/** ASME B1.1-2003 Table 2: basic major (in) and threads per inch, #4 to 1/2". */
const UNIFIED: Record<UnifiedThreadSize, { majorIn: number; tpi: number; series: 'UNC' | 'UNF' }> = {
  '#4-40': { majorIn: 0.112, tpi: 40, series: 'UNC' },
  '#4-48': { majorIn: 0.112, tpi: 48, series: 'UNF' },
  '#5-40': { majorIn: 0.125, tpi: 40, series: 'UNC' },
  '#5-44': { majorIn: 0.125, tpi: 44, series: 'UNF' },
  '#6-32': { majorIn: 0.138, tpi: 32, series: 'UNC' },
  '#6-40': { majorIn: 0.138, tpi: 40, series: 'UNF' },
  '#8-32': { majorIn: 0.164, tpi: 32, series: 'UNC' },
  '#8-36': { majorIn: 0.164, tpi: 36, series: 'UNF' },
  '#10-24': { majorIn: 0.19, tpi: 24, series: 'UNC' },
  '#10-32': { majorIn: 0.19, tpi: 32, series: 'UNF' },
  '#12-24': { majorIn: 0.216, tpi: 24, series: 'UNC' },
  '#12-28': { majorIn: 0.216, tpi: 28, series: 'UNF' },
  '1/4-20': { majorIn: 0.25, tpi: 20, series: 'UNC' },
  '1/4-28': { majorIn: 0.25, tpi: 28, series: 'UNF' },
  '5/16-18': { majorIn: 0.3125, tpi: 18, series: 'UNC' },
  '5/16-24': { majorIn: 0.3125, tpi: 24, series: 'UNF' },
  '3/8-16': { majorIn: 0.375, tpi: 16, series: 'UNC' },
  '3/8-24': { majorIn: 0.375, tpi: 24, series: 'UNF' },
  '7/16-14': { majorIn: 0.4375, tpi: 14, series: 'UNC' },
  '7/16-20': { majorIn: 0.4375, tpi: 20, series: 'UNF' },
  '1/2-13': { majorIn: 0.5, tpi: 13, series: 'UNC' },
  '1/2-20': { majorIn: 0.5, tpi: 20, series: 'UNF' },
};

export const METRIC_THREAD_SIZES = [...(Object.keys(FASTENERS) as FastenerSize[]), ...(Object.keys(METRIC_EXTRA) as MetricThreadSize[])] as readonly MetricThreadSize[];
export const UNIFIED_THREAD_SIZES = Object.keys(UNIFIED) as readonly UnifiedThreadSize[];
export const THREAD_SIZES: readonly ThreadSize[] = [...METRIC_THREAD_SIZES, ...UNIFIED_THREAD_SIZES];

export function isUnifiedSize(size: string): size is UnifiedThreadSize {
  return Object.prototype.hasOwnProperty.call(UNIFIED, size);
}

export function isThreadSize(size: string): size is ThreadSize {
  return (THREAD_SIZES as readonly string[]).includes(size);
}

/** The table's row for `size`. Total over `ThreadSize`. */
export function threadSpec(size: ThreadSize): ThreadSpec {
  if (isUnifiedSize(size)) {
    const u = UNIFIED[size];
    const major = r3(u.majorIn * 25.4);
    const pitch = 25.4 / u.tpi;
    return {
      size,
      standard: 'imperial',
      series: u.series,
      major,
      pitch,
      tpi: u.tpi,
      majorIn: u.majorIn,
      minor: r3(u.majorIn * 25.4 - INTERNAL_MINOR_COEFF * pitch),
      externalMinor: r3(u.majorIn * 25.4 - EXTERNAL_MINOR_COEFF * pitch),
    };
  }
  const f = (FASTENERS as Partial<Record<string, { major: number; pitch: number; minor: number }>>)[size];
  const base = f ?? METRIC_EXTRA[size as Exclude<MetricThreadSize, FastenerSize>];
  return {
    size,
    standard: 'metric',
    series: 'M',
    major: base.major,
    pitch: base.pitch,
    tpi: null,
    majorIn: null,
    // M2–M6 keep FASTENERS' own minor, so nothing internal moves (#841's byte-identical rule).
    minor: f?.minor ?? r3(base.major - INTERNAL_MINOR_COEFF * base.pitch),
    externalMinor: r3(base.major - EXTERNAL_MINOR_COEFF * base.pitch),
  };
}

/** The three numbers a side cuts to: the major, the pitch, and the minor that side lands on. */
export function threadDims(size: ThreadSize, side: ThreadSide): { major: number; pitch: number; minor: number } {
  const s = threadSpec(size);
  return { major: s.major, pitch: s.pitch, minor: side === 'external' ? s.externalMinor : s.minor };
}

/** The class an item records for its system and side (see the header). */
export function threadClassFor(standard: ThreadStandard, side: ThreadSide): ThreadClassFit {
  if (standard === 'metric') return side === 'external' ? '6h' : '6H';
  return side === 'external' ? '3A' : '3B';
}

/** A pitch to four decimals, the way a person reads it: 1.27, 0.635, 1.9538. */
export function fmtPitch(p: number): string {
  return String(Number(p.toFixed(4)));
}

/**
 * The size as a person names it: `M5×0.8` for metric (the exact string the internal thread's
 * operation name has always carried) and `1/4-20 UNC` for unified.
 */
export function threadLabel(size: ThreadSize): string {
  const s = threadSpec(size);
  return s.standard === 'metric' ? `${size}×${s.pitch}` : `${size} ${s.series}`;
}

/**
 * The size with its pitch IN MILLIMETRES for the picker: `M8 × 1.25 mm`, `1/4-20 UNC (P 1.27 mm)`.
 */
export function threadOptionLabel(size: ThreadSize): string {
  const s = threadSpec(size);
  return s.standard === 'metric' ? `${size} × ${s.pitch} mm` : `${size} ${s.series} (${s.tpi} TPI, P ${fmtPitch(s.pitch)} mm)`;
}

/**
 * The pitch a THREAD MILL's record names, mm — or null when it names none (#841).
 *
 * The catalogue's own `pitch` column is stripped before the wire (`house.rs`, #445 D2), so the only
 * place a served cutter states its tooth's pitch is its NAME: Makera writes `M3(d2.4mm)`, a shop may
 * write `M8x1.25`, `1/4-20`, `#10-32` or `20 TPI`. A bare `M3` reads as ISO 261 coarse. Anything
 * else is null — unknown, never a guess.
 */
export function threadMillPitchOf(name: string): number | null {
  const tpi = /(\d+(?:\.\d+)?)\s*TPI\b/i.exec(name);
  if (tpi) return 25.4 / Number(tpi[1]);
  const unified = /(?:^|[^\w/])((?:#\d{1,2})|(?:\d+\/\d+))\s*-\s*(\d{2})(?!\d)/.exec(name);
  if (unified) return 25.4 / Number(unified[2]);
  const metric = /(?:^|[^A-Za-z])M(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?/.exec(name);
  if (metric) {
    if (metric[2] !== undefined) return Number(metric[2]);
    const size = `M${metric[1]}`;
    if (isThreadSize(size) && !isUnifiedSize(size)) return threadSpec(size).pitch;
  }
  return null;
}

/**
 * The size in `standard` whose major is nearest `majorMm`, coarse before fine on a tie — how a
 * system switch keeps the thread about the same size, and how a boss picks its starting size.
 */
export function nearestThreadSize(standard: ThreadStandard, majorMm: number): ThreadSize {
  const list: readonly ThreadSize[] = standard === 'metric' ? METRIC_THREAD_SIZES : UNIFIED_THREAD_SIZES;
  let best = list[0]!;
  let bestD = Infinity;
  for (const size of list) {
    const d = Math.abs(threadSpec(size).major - majorMm);
    if (d < bestD - 1e-9) {
      best = size;
      bestD = d;
    }
  }
  return best;
}
