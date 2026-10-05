/**
 * Coupon jobs (#248): a parameter sweep laid out as a labelled grid, built in the engrave job's
 * OWN vocabulary so a coupon generates, verifies and simulates like any other job.
 *
 * A coupon is the cutting twin of #157's fit coupons — cut the interface ALONE before trusting
 * it on a part. Every row in `feeds.ts` is `unmeasured`; a coupon is how one stops being a
 * guess, and #248 item 3 reads the recorded result back into the table.
 *
 * WHY A FAMILY OF JOBS, NOT ONE FILE WITH PER-CELL FEEDS. The CAM has ONE feed, ONE spindle
 * speed and ONE step-over per program (#172): those are whole-job `cutOverride` fields, not per
 * item. DEPTH is the one swept parameter the document carries per item (`EngraveShape.depth` /
 * `EngraveLabel.depth`). So:
 *
 *   - a `depth` sweep is ONE program with one labelled cell per depth (the #165 depth ladder,
 *     generalised);
 *   - every other parameter is N programs, one per value, each a labelled cell cut under that
 *     `cutOverride`.
 *
 * That is the machine's limit, not a shortcut: a mill cannot change its feed between two cells
 * of one file without re-posting, and a coupon must be the file the machine actually runs.
 *
 * The cells are TEXT (`EngraveLabel`) so each carries the value it is testing, as #248 asks.
 * The builder is PURE — it returns plain `EngraveJob`s — so it is unit-tested without wasm and
 * fed straight into `engraveGenerate` by `scripts/engrave-job.ts`.
 */

import type { CutParams } from '@/engine/cnc/feeds';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';
import type { TextFont, TextWeight } from '@/types/textLabel';
import type { Mm } from '@/types/units';

/** The parameter a coupon sweeps. `depth` is per item; the rest are per program. */
export type CouponParam = 'depth' | 'feed' | 'rpm' | 'stepDown' | 'stepOver';

export interface CouponSpec {
  /** File-stem id for the programs this spec produces, e.g. `feed-sweep`. */
  id: string;
  /** Human title, used in each program's job name. */
  title: string;
  parameter: CouponParam;
  /** The values to sweep, in coupon order (left to right). */
  values: number[];
  /**
   * The job the coupon is carved from: supplies the stock, cutter, workholding, vise,
   * sacrificial material, `minFloor` and `edgeMargin`. Its own items are DISCARDED — a coupon
   * contains only its cells.
   */
  base: EngraveJob;
  /** Cell text: cap height and centre-to-centre pitch along +X, mm. */
  text: { size: Mm; pitch: Mm };
  /** Centre of the FIRST cell, mm from the stock's front-left corner. Cells run in +X. */
  origin: { x: Mm; y: Mm };
  /** Pocket depth for a non-`depth` sweep, mm. Ignored when `parameter === 'depth'`. */
  depth: Mm;
  /** Cap-height font and weight for the cell text. Defaults to the base job's first label. */
  font?: TextFont;
  weight?: TextWeight;
}

/** One program a coupon produces: a normal `EngraveJob` plus how to name and read it. */
export interface CouponProgram {
  /** File stem for `.nc` / run sheet, e.g. `feed-sweep-f500`. */
  id: string;
  /** The cell texts this program engraves, left to right. */
  labels: string[];
  /** The parameter values this program tests — all of them for a `depth` sweep, one otherwise. */
  values: number[];
  /** A one-line description for the run sheet / console receipt. */
  description: string;
  job: EngraveJob;
}

/** `2` for 2.0, `0.45` for 0.45 — trailing zeros trimmed, three decimals at most. */
function fmt(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** The value as it is engraved and named, with its unit. */
export function couponValueLabel(parameter: CouponParam, value: number): string {
  switch (parameter) {
    case 'depth':
    case 'stepDown':
    case 'stepOver':
      return `${fmt(value)}mm`;
    case 'feed':
      return `F${fmt(value)}`;
    case 'rpm':
      return `S${fmt(value)}`;
  }
}

/** A cell label: the value's text at the cell's centre and depth, with a deterministic id. */
function cellLabel(id: string, text: string, x: Mm, y: Mm, depth: Mm, font: TextFont, weight: TextWeight, size: Mm): EngraveLabel {
  return {
    id,
    text,
    font,
    weight,
    size,
    position: { x, y },
    rotation: 0,
    depth,
    enabled: true,
  };
}

/** The value's `cutOverride` fragment, or an empty object when the sweep is a depth ladder. */
function overrideFor(parameter: CouponParam, value: number): Partial<CutParams> {
  if (parameter === 'depth') return {};
  return { [parameter]: value } as Partial<CutParams>;
}

/**
 * Build the programs a coupon spec produces. Pure. A `depth` sweep yields ONE program whose
 * cells each carry their own depth; every other parameter yields one program per value, each a
 * single labelled cell cut under that override. Throws on an empty value list or non-positive
 * text/pitch — a coupon with no cells is a mis-typed spec, not a job.
 */
export function buildCouponPrograms(spec: CouponSpec): CouponProgram[] {
  if (spec.values.length === 0) throw new Error(`coupon "${spec.id}" has no values to sweep`);
  if (spec.text.size <= 0 || spec.text.pitch <= 0) {
    throw new Error(`coupon "${spec.id}" needs a positive text size and pitch`);
  }
  const font = spec.font ?? spec.base.labels[0]?.font ?? DEFAULT_COUPON_FONT;
  const weight = spec.weight ?? spec.base.labels[0]?.weight ?? 'bold';
  const stock: EngraveJob['stock'] = { ...spec.base.stock };

  /** A job with the coupon's own cells and nothing else, at a fixed depth. */
  const couponJob = (name: string, cells: { text: string; x: Mm; depth: Mm }[], override: Partial<CutParams>): EngraveJob => ({
    ...spec.base,
    name,
    stock,
    labels: cells.map((c, i) => cellLabel(`${spec.id}-lbl-${i}`, c.text, c.x, spec.origin.y, c.depth, font, weight, spec.text.size)),
    shapes: [],
    combined: [],
    traces: [],
    // The sweep's own override wins over whatever the base carried for that field.
    ...(Object.keys(override).length > 0 ? { cutOverride: { ...spec.base.cutOverride, ...override } } : {}),
  });

  if (spec.parameter === 'depth') {
    const cells = spec.values.map((v, i) => ({
      text: couponValueLabel(spec.parameter, v),
      x: spec.origin.x + i * spec.text.pitch,
      depth: v,
    }));
    const id = spec.id;
    return [
      {
        id,
        labels: cells.map((c) => c.text),
        values: [...spec.values],
        description: `${spec.title}: one cell per depth, ${spec.values.map(fmt).join(' / ')} mm`,
        job: couponJob(spec.title, cells, {}),
      },
    ];
  }

  return spec.values.map((value) => {
    const text = couponValueLabel(spec.parameter, value);
    const id = `${spec.id}-${text.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
    return {
      id,
      labels: [text],
      values: [value],
      description: `${spec.title}: ${text} at ${fmt(spec.depth)} mm deep`,
      job: couponJob(`${spec.title} ${text}`, [{ text, x: spec.origin.x, depth: spec.depth }], overrideFor(spec.parameter, value)),
    };
  });
}

/** Fallback font when the base job has no label to borrow from — the same default `defaults.ts` uses. */
const DEFAULT_COUPON_FONT: TextFont = 'barlow';
