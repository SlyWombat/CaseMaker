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

import type { CutParams, FeedsMeasurement } from '@/engine/cnc/feeds';
import type { EngraveJob, EngraveLabel, StockMaterial } from '@/types/engraveJob';
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

// ---------------------------------------------------------------------------------------------
// #248 item 3 — the coupon record and its readback into `feeds.ts`
// ---------------------------------------------------------------------------------------------

/** What the operator saw at the bench. `broke` covers a broken cutter or a burnt/ruined cell. */
export type CouponVerdict = 'ok' | 'poor' | 'broke';

/**
 * One program's row in a coupon record. The first five fields are written by
 * `scripts/engrave-job.ts`; the last three are what the operator fills after the cut.
 */
export interface CouponRecordRow {
  program: string;
  /** The parameter value(s) this program tested. One value unless it is a depth/multi-cell program. */
  values: number[];
  ncFile: string;
  sheetFile: string;
  hash: string;
  /** The operator's verdict. `null` = not run yet. */
  verdict: CouponVerdict | null;
  /** Mark the ONE program whose value should be adopted into `feeds.ts`. */
  chosen: boolean;
  note: string;
}

/**
 * The machine-readable verdict file `scripts/engrave-job.ts --coupon` writes and the operator
 * fills in (#248 item 3). `scripts/feeds-readback.ts` turns a completed one into a
 * `FeedsMeasurement` and folds it into `feeds.ts` — the round trip, with no hand-editing.
 */
export interface CouponRecord {
  /** The coupon spec id (`<id>-coupon-record.json`). */
  coupon: string;
  title: string;
  parameter: CouponParam;
  material: StockMaterial;
  toolKey: string;
  /** The coupon tool's cutting diameter, mm — selects the feeds row. */
  cuttingDiameter: number;
  /** ISO date the coupon files were generated. */
  generatedOn: string;
  /** ISO date the coupon was CUT: the measurement's date. Required for a readback. */
  cutOn: string | null;
  /**
   * Any `cutOverride` the BASE job carried. A non-empty one for a field other than the swept
   * parameter means the coupon did not test the feeds row's own value, so the readback refuses.
   */
  baseOverride: Partial<CutParams>;
  note: string;
  programs: CouponRecordRow[];
}

export type MeasurementResult =
  | { ok: true; measurement: FeedsMeasurement }
  | { ok: false; reason: string };

/** The coupon parameters that are a column of the feeds table. `depth` is not (see `feeds.ts`). */
const MEASURABLE: FeedsMeasurement['parameter'][] = ['feed', 'rpm', 'stepDown', 'stepOver'];

/**
 * Turn a completed coupon record into the measurement that flips a feeds row (#248 item 3).
 * Pure, and strict: it refuses rather than guessing. The value adopted is the marked program's
 * single value — or the only program that cut `ok` — and every refusal names what to fix.
 */
export function measurementFromRecord(record: CouponRecord, recordPath?: string): MeasurementResult {
  if (!MEASURABLE.includes(record.parameter as FeedsMeasurement['parameter'])) {
    const reason =
      record.parameter === 'depth'
        ? 'a depth coupon measures the job’s achievable depth, not a feeds-table field (#165 records that in /Fabrication.md §7.2); there is nothing to write into feeds.ts'
        : `coupon parameter "${String(record.parameter)}" is not a feeds-table field`;
    return { ok: false, reason };
  }
  const parameter = record.parameter as FeedsMeasurement['parameter'];

  if (typeof record.cuttingDiameter !== 'number' || !(record.cuttingDiameter > 0)) {
    return { ok: false, reason: 'the record has no positive cuttingDiameter, so no feeds row can be selected' };
  }
  if (typeof record.cutOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.cutOn)) {
    return { ok: false, reason: 'the record has no cutOn date (YYYY-MM-DD) — a measured row must carry its date' };
  }
  if (!Array.isArray(record.programs)) {
    return { ok: false, reason: 'the record has no programs array' };
  }

  const extra = Object.keys(record.baseOverride ?? {}).filter((k) => k !== parameter);
  if (extra.length > 0) {
    return {
      ok: false,
      reason:
        `the base job overrode ${extra.join(', ')}, so this coupon did not test the feeds row’s own ` +
        `${extra.length > 1 ? 'values' : 'value'}; adopt the override and re-cut from the row instead`,
    };
  }

  const badlyChosen = record.programs.filter((p) => p.chosen && p.verdict !== 'ok');
  if (badlyChosen.length > 0) {
    return {
      ok: false,
      reason: `program(s) ${badlyChosen.map((p) => p.program).join(', ')} are marked chosen but did not cut ok`,
    };
  }

  const ok = record.programs.filter((p) => p.verdict === 'ok');
  if (ok.length === 0) return { ok: false, reason: 'no program has verdict "ok" — nothing has been measured' };
  const marked = ok.filter((p) => p.chosen);
  if (marked.length > 1) {
    return { ok: false, reason: `${marked.length} programs are marked chosen; mark exactly one` };
  }
  const winner = marked.length === 1 ? marked[0]! : ok.length === 1 ? ok[0]! : null;
  if (winner === null) {
    return { ok: false, reason: `${ok.length} programs cut ok; mark the one to adopt with "chosen": true` };
  }
  if (winner.values.length !== 1) {
    return {
      ok: false,
      reason: `program "${winner.program}" tested ${winner.values.length} values; a feeds row takes one — this is a multi-cell (depth-ladder style) record`,
    };
  }

  const value = winner.values[0]!;
  if (!(value > 0)) return { ok: false, reason: `the chosen value ${value} must be positive` };
  if (parameter === 'stepOver' && value > record.cuttingDiameter / 2 + 1e-9) {
    return {
      ok: false,
      reason: `step-over ${value} mm exceeds the ${record.cuttingDiameter / 2} mm radius of the ${record.cuttingDiameter} mm cutter (#191)`,
    };
  }

  return {
    ok: true,
    measurement: {
      material: record.material,
      diameter: record.cuttingDiameter,
      parameter,
      value,
      on: record.cutOn,
      coupon: record.coupon,
      ...(recordPath !== undefined ? { record: recordPath } : {}),
    },
  };
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
