/**
 * The end of a run (#414): what a FINISHED run does to the shelf and the cutters, worked out purely.
 *
 *   - CONSUME the stock the job reserved (#413's `consumeStock`, called by the run store).
 *   - ADD THE CUTTING TIME to the cutter's runtime (#381) — counted by Case Maker, from the PROGRAM's
 *     own cutting moves: Σ length / feed over the feed moves with the spindle on (the same closed form
 *     as the CAM's `estimateSeconds`, here on the file the machine played). Rapids, homing and the
 *     tool-length touch are not cutting and are not counted. When a cutting move has no feed the sum
 *     is not trustworthy, and the run's own elapsed time is used instead — labelled as that, because
 *     it includes everything the machine did.
 *   - OFFER AN OFFCUT only when the cuts DIVIDE THE STOCK INTO AT LEAST TWO DISTINCT PIECES (the
 *     maintainer, 2026-10-16: "it needs to cut the stock into at least two parts — not just remove
 *     material or cut thru as drilling a hole thru does not make two distinct parts"). A drilled or
 *     bored through-hole, a cleared through-pocket, or a slot that separates nothing leaves ONE piece
 *     with a hole in it, and offers nothing. Of the pieces, the part is the one holding the job's part
 *     (`partAt`), or — when the job does not say — the pieces that do not reach the stock's edge; the
 *     rest is the leftover, offered when its largest uncut rectangle has both sides at least
 *     `offcut.minSideMm` (seeded 20, chosen). `offcut.offer` false turns offers off, and the operator can
 *     ignore the scrap on any run.
 *   - WEIGHTED BY THE MATERIAL (the maintainer, 2026-10-16): metal wears a cutter faster than plastic,
 *     so the minutes added are the cutting minutes × the material's `tools.wearWeight.<class>` (shop
 *     defaults, seeded as chosen). The runtime on a copy is these weighted minutes.
 *
 * WHICH COPY GETS THE RUNTIME (#381's "decide first", answered here and on #414): the one copy the
 * inventory records as IN THIS MACHINE (#415's whereabouts). None, or the job's tool being a different
 * item, adds nothing and says so — runtime is never guessed onto a cutter.
 */

import { parseGcode } from './gcode';
import { StockItemSchema, formIsFlat, type StockForm, type StockItem } from '@/platform/stockClient';
import type { ToolCopy } from './toolCondition';
import type { STOCK_MATERIALS } from './materials';
import type { FilamentFibre } from '@/types/engraveJob';

/** A shelf material word (#413's vocabulary). */
type StockMaterial = (typeof STOCK_MATERIALS)[number];

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------
// The program: where it cut, and for how long.

export interface CutSegment {
  from: [number, number];
  to: [number, number];
}

export interface ProgramCuts {
  /** Every cutting move that goes below the stock's top (Z < 0), work XY, with its lowest Z. */
  segments: (CutSegment & { lowZ: number })[];
  /**
   * Cutting moves whose XY the program never placed (or whose depth it never placed): the footprint
   * is then unknown. Counted, never silently left out.
   */
  unplaced: number;
  /** Plunges from a Z the program never placed (after a `G53` retract): placed in XY, but not timed. */
  untimed: number;
  /** Cutting-feed minutes (spindle on), or null when a cutting move has no feed. */
  feedMinutes: number | null;
  /** The tool numbers the program changes to. One program per tool (Q15). */
  tools: number[];
}

/** Read the program the machine played: its cutting footprint and its cutting-feed time. */
export function programCuts(nc: string): ProgramCuts {
  const { events } = parseGcode(nc);
  const segments: ProgramCuts['segments'] = [];
  const tools = new Set<number>();
  let unplaced = 0;
  let untimed = 0;
  let seconds = 0;
  let feedKnown = true;
  let spindle = false;
  for (const ev of events) {
    if (ev.kind === 'spindle') spindle = ev.state !== 'off';
    if (ev.kind === 'tool-change') tools.add(ev.tool);
    if (ev.kind !== 'move' || ev.mode !== 'cut' || ev.frame !== 'work' || !spindle) continue;
    const [fx, fy, fz] = ev.from;
    const [tx, ty, tz] = ev.to;
    if (fx !== null && fy !== null && fz !== null && tx !== null && ty !== null && tz !== null) {
      if (ev.feed === null || !(ev.feed > 0)) feedKnown = false;
      else seconds += (Math.hypot(tx - fx, ty - fy, tz - fz) / ev.feed) * 60;
      if (Math.min(fz, tz) < 0) segments.push({ from: [fx, fy], to: [tx, ty], lowZ: Math.min(fz, tz) });
    } else if (fz === null && tx !== null && ty !== null && tz !== null && fx === tx && fy === ty) {
      // A straight plunge from a Z the program never placed (it followed a G53 retract): where it cut is
      // known — straight down at (x, y) — but not how far it travelled, so it is not timed.
      untimed++;
      if (tz < 0) segments.push({ from: [tx, ty], to: [tx, ty], lowZ: tz });
    } else {
      unplaced++;
    }
  }
  return { segments, unplaced, untimed, feedMinutes: feedKnown ? seconds / 60 : null, tools: [...tools] };
}

export interface RuntimeReading {
  minutes: number;
  source: 'program-feeds' | 'run-elapsed';
  /** In words, for the end-of-run line. */
  note: string;
}

/** The minutes to add, and from what. Null when neither the program nor the run can say. */
export function runtimeOf(cuts: ProgramCuts, elapsedS: number | null): RuntimeReading | null {
  if (cuts.feedMinutes !== null && cuts.unplaced === 0) {
    const cross = elapsedS === null ? '' : ` (the whole run took ${r2(elapsedS / 60)} min, rapids and homing included)`;
    const skipped = cuts.untimed > 0 ? `; ${cuts.untimed} plunge(s) from an unplaced height not timed` : '';
    return { minutes: cuts.feedMinutes, source: 'program-feeds', note: `${r2(cuts.feedMinutes)} min of cutting, from the program’s feed moves${skipped}${cross}` };
  }
  if (cuts.feedMinutes !== null && cuts.unplaced > 0 && (elapsedS === null || !(elapsedS > 0))) return null;
  if (elapsedS !== null && elapsedS > 0) {
    return {
      minutes: elapsedS / 60,
      source: 'run-elapsed',
      note: `${r2(elapsedS / 60)} min, the run’s elapsed time — ${cuts.feedMinutes === null ? 'a cutting move had no feed' : `${cuts.unplaced} cutting move(s) had no known position`}, so the program could not be timed; this includes rapids and homing`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The leftover: the largest rectangle the cuts did not reach.

/** A rectangle in work XY: from (x, y), `length` along X and `width` along Y. */
export interface Rect {
  x: number;
  y: number;
  length: number;
  width: number;
}

/** The squared distance from point (px, py) to the segment a–b. */
function dist2ToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  const qx = a[0] + t * dx - px;
  const qy = a[1] + t * dy - py;
  return qx * qx + qy * qy;
}

/** A grid over the stock: cells, and whether a cut reaches each. */
interface Grid {
  cell: number;
  nx: number;
  ny: number;
}

function gridFor(stock: { x: number; y: number }): Grid {
  const cell = Math.max(0.25, Math.max(stock.x, stock.y) / 400);
  return { cell, nx: Math.ceil(stock.x / cell), ny: Math.ceil(stock.y / cell) };
}

/**
 * Mark every cell any part of which a cut could reach — the segments grown by `radius`, rounded toward
 * the cuts (a cell is marked if its nearest corner could be inside), so what is left never touches one.
 */
function markCuts(g: Grid, segments: readonly CutSegment[], radius: number): Uint8Array {
  const { cell, nx, ny } = g;
  const out = new Uint8Array(nx * ny);
  const reach = radius + (cell * Math.SQRT2) / 2;
  for (const s of segments) {
    const x0 = Math.max(0, Math.floor((Math.min(s.from[0], s.to[0]) - reach) / cell));
    const x1 = Math.min(nx - 1, Math.floor((Math.max(s.from[0], s.to[0]) + reach) / cell));
    const y0 = Math.max(0, Math.floor((Math.min(s.from[1], s.to[1]) - reach) / cell));
    const y1 = Math.min(ny - 1, Math.floor((Math.max(s.from[1], s.to[1]) + reach) / cell));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        if (out[j * nx + i]) continue;
        if (dist2ToSegment((i + 0.5) * cell, (j + 0.5) * cell, s.from, s.to) <= reach * reach) out[j * nx + i] = 1;
      }
    }
  }
  return out;
}

/** The largest rectangle of cells where `free` holds, in mm, clipped to the stock. */
function largestFree(g: Grid, stock: { x: number; y: number }, free: (k: number) => boolean): Rect | null {
  const { cell, nx, ny } = g;
  const heights = new Int32Array(nx);
  let best: { area: number; i0: number; i1: number; j0: number; j1: number } | null = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) heights[i] = free(j * nx + i) ? (heights[i] as number) + 1 : 0;
    const stack: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const h = i === nx ? 0 : (heights[i] as number);
      while (stack.length > 0 && (heights[stack[stack.length - 1]!] as number) >= h) {
        const top = stack.pop()!;
        const height = heights[top] as number;
        const left = stack.length === 0 ? 0 : stack[stack.length - 1]! + 1;
        const w = Math.min(i * cell, stock.x) - left * cell;
        const d = Math.min((j + 1) * cell, stock.y) - (j + 1 - height) * cell;
        if (height > 0 && w > 0 && d > 0 && (best === null || w * d > best.area)) best = { area: w * d, i0: left, i1: i, j0: j + 1 - height, j1: j + 1 };
      }
      stack.push(i);
    }
  }
  if (best === null) return null;
  const x = best.i0 * cell;
  const y = best.j0 * cell;
  return { x: r2(x), y: r2(y), length: r2(Math.min(best.i1 * cell, stock.x) - x), width: r2(Math.min(best.j1 * cell, stock.y) - y) };
}

/**
 * The largest axis-aligned rectangle of the stock (work XY 0..x, 0..y) that no cut reaches — every cut
 * grown by the cutter's radius, rounded toward the cuts. Null when nothing is left.
 */
export function largestLeftover(stock: { x: number; y: number }, segments: readonly CutSegment[], radius: number): Rect | null {
  if (!(stock.x > 0 && stock.y > 0)) return null;
  const g = gridFor(stock);
  const blocked = markCuts(g, segments, radius);
  return largestFree(g, stock, (k) => !blocked[k]);
}

export type SeparatedLeftover = { ok: true; rect: Rect | null; pieces: number } | { ok: false; reason: string };

/**
 * The pieces the THROUGH-cuts (those reaching `throughZ`, = −thickness) divide the stock into, and the
 * leftover among them. A piece is a connected region of stock no through-cut reaches; a speck the size
 * of the grid's own rounding (under four cells) is not a piece. Fewer than two pieces: nothing was
 * separated — a through-hole, a through-pocket, a slot to nowhere — and nothing is offered.
 *
 * Which piece is the PART: the one containing `partAt` (work XY), when the job says; otherwise the
 * pieces that do not reach the stock's edge (a part cut out of the middle). When every piece reaches the
 * edge and the job does not say where its part is, which one is scrap is unknown, and nothing is offered.
 */
export function separatedLeftover(
  stock: { x: number; y: number },
  segments: readonly (CutSegment & { lowZ: number })[],
  radius: number,
  throughZ: number,
  partAt?: { x: number; y: number },
): SeparatedLeftover {
  if (!(stock.x > 0 && stock.y > 0)) return { ok: false, reason: 'the stock has no size' };
  const through = segments.filter((s) => s.lowZ <= throughZ + 1e-6);
  if (through.length === 0) return { ok: false, reason: 'nothing was cut through the stock, so it is still one piece' };
  const g = gridFor(stock);
  const wall = markCuts(g, through, radius);
  const blocked = markCuts(g, segments, radius);
  const { nx, ny } = g;
  const piece = new Int32Array(nx * ny).fill(-1);
  const pieces: { touchesEdge: boolean; cells: number }[] = [];
  for (let k0 = 0; k0 < nx * ny; k0++) {
    if (wall[k0] || piece[k0] !== -1) continue;
    const id = pieces.length;
    const p = { touchesEdge: false, cells: 0 };
    pieces.push(p);
    const queue = [k0];
    piece[k0] = id;
    while (queue.length > 0) {
      const k = queue.pop()!;
      p.cells++;
      const i = k % nx;
      const j = (k - i) / nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) p.touchesEdge = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const n = b * nx + a;
        if (!wall[n] && piece[n] === -1) {
          piece[n] = id;
          queue.push(n);
        }
      }
    }
  }
  const real = pieces.map((p) => p.cells >= 4);
  const count = real.filter(Boolean).length;
  if (count < 2) {
    return { ok: false, reason: 'the cuts went through the stock but did not divide it into two pieces (a through-hole, pocket or slot leaves one piece with a hole in it)' };
  }
  let isPart: (id: number) => boolean;
  if (partAt) {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(partAt.x / g.cell)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor(partAt.y / g.cell)));
    const id = piece[j * nx + i]!;
    if (id < 0) return { ok: false, reason: 'the job’s part is where a through-cut ran, so which piece is the part is unknown' };
    isPart = (k) => k === id;
  } else {
    if (pieces.every((p, k) => !real[k] || p.touchesEdge)) {
      return { ok: false, reason: `the cuts split the stock into ${count} pieces edge to edge, and the job does not say which one is its part` };
    }
    isPart = (k) => !pieces[k]!.touchesEdge;
  }
  const leftover = (k: number) => {
    const id = piece[k]!;
    return id >= 0 && real[id] === true && !isPart(id) && !blocked[k];
  };
  return { ok: true, rect: largestFree(g, stock, leftover), pieces: count };
}

/** Whether every cut lies on the stock as given (its centre within a cutter radius of it). */
export function cutsOnStock(stock: { x: number; y: number }, segments: readonly CutSegment[], radius: number): string | null {
  const tol = radius + 1e-6;
  for (const s of segments) {
    for (const [x, y] of [s.from, s.to]) {
      if (x < -tol || y < -tol || x > stock.x + tol || y > stock.y + tol) {
        return `the program cuts at (${r2(x)}, ${r2(y)}), outside the ${stock.x} × ${stock.y} mm stock it was given — the stock is not where the job says, so what is left is unknown`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The offcut question.

export type OffcutOffer =
  | { kind: 'offer'; item: StockItem; leftover: Rect; text: string }
  | { kind: 'none'; reason: string };

/**
 * The offcut a finished run proposes, or why none. The new entry is the parent's material, finish,
 * flatness, layers and conductivity, at its thickness, one of it, `source: 'offcut'`; its length is the
 * longer side.
 */
export function offcutOffer(input: {
  parent: StockItem;
  stockXY: { x: number; y: number };
  cuts: ProgramCuts;
  toolRadius: number;
  minSideMm: number;
  /** Where the job's part is, work XY — which piece is not scrap. Optional. */
  partAt?: { x: number; y: number };
  jobId: string;
  id: string;
  at: string;
}): OffcutOffer {
  const { parent, cuts } = input;
  const form = parent.form as StockForm;
  if (!formIsFlat(form) || form === 'disc' || parent.size.thickness == null) {
    return { kind: 'none', reason: `no offcut is worked out for a ${form}: only flat rectangular stock is` };
  }
  if (cuts.unplaced > 0) {
    return { kind: 'none', reason: `${cuts.unplaced} cutting move(s) had no known position, so what is left of the stock is unknown` };
  }
  const off = cutsOnStock(input.stockXY, cuts.segments, input.toolRadius);
  if (off !== null) return { kind: 'none', reason: off };
  const sep = separatedLeftover(input.stockXY, cuts.segments, input.toolRadius, -parent.size.thickness, input.partAt);
  if (!sep.ok) return { kind: 'none', reason: sep.reason };
  const left = sep.rect;
  if (left === null) return { kind: 'none', reason: 'the cuts reach every part of what is left — nothing usable remains' };
  const long = Math.max(left.length, left.width);
  const short = Math.min(left.length, left.width);
  if (short < input.minSideMm) {
    return {
      kind: 'none',
      reason: `the largest piece left is ${long} × ${short} mm, under the ${input.minSideMm} mm smallest offcut (offcut.minSideMm)`,
    };
  }
  const parsed = StockItemSchema.safeParse({
    id: input.id,
    material: parent.material,
    form,
    size: { length: long, width: short, thickness: parent.size.thickness },
    layers: parent.layers,
    finish: parent.finish,
    flatness: parent.flatness,
    domeHeight: parent.domeHeight,
    conductive: parent.conductive,
    quantity: 1,
    reservations: [],
    consumed: [],
    source: 'offcut',
    notes: `offcut from ${input.jobId}, cut from ${parent.id}`,
    addedAt: input.at,
  });
  if (!parsed.success) return { kind: 'none', reason: `the offcut would not be a valid shelf entry: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  return {
    kind: 'offer',
    item: parsed.data,
    leftover: left,
    text: `${long} × ${short} × ${parent.size.thickness} mm of ${parent.material} is left over from the cut-out — keep it on the shelf?`,
  };
}

// ---------------------------------------------------------------------------------------------------
// How much wear a minute of cutting is, by material.

export type WearClass = 'plastic' | 'wood' | 'aluminium' | 'brass' | 'copper' | 'abrasive';

/**
 * The wear classes the shop weights (`tools.wearWeight.<class>`), and which stock materials are
 * which. `abrasive` is the fibre-filled nylons' own class (#456): glass and carbon fibre wear a
 * cutting edge far faster than unfilled plastic, so they are weighted separately rather than
 * folded into `plastic`.
 *
 * This map is by MATERIAL, and a `PET-CF` blank's material is `pet` (#464) — so the flag is a
 * second input, not a row here. {@link wearClassFor} is the reader that takes both.
 */
export const WEAR_CLASS: Readonly<Record<StockMaterial, WearClass>> = {
  pla: 'plastic',
  petg: 'plastic',
  pet: 'plastic',
  abs: 'plastic',
  asa: 'plastic',
  hips: 'plastic',
  pa: 'plastic',
  'pa-cf': 'abrasive',
  'pa-gf': 'abrasive',
  pc: 'plastic',
  pp: 'plastic',
  tpu: 'plastic',
  pva: 'plastic',
  acrylic: 'plastic',
  // #492 — an unspecified bought plastic is weighted as plastic, not as a fibre-filled abrasive.
  plastic: 'plastic',
  softwood: 'wood',
  hardwood: 'wood',
  mdf: 'wood',
  'aluminium-6061': 'aluminium',
  'aluminium-7075': 'aluminium',
  brass: 'brass',
  copper: 'copper',
  // #743 P-1 — FR-4 is glass-fibre board: its wear belongs with the fibre-filled class, and
  // Makera's own PCB rows already state the numbers this weights.
  pcb: 'abrasive',
};

/** The shop's words for a fibre flag, for the runtime line. */
const FIBRE_LABELS: Readonly<Record<FilamentFibre, string>> = { cf: 'carbon fibre', gf: 'glass fibre' };

/**
 * The wear class a material cuts at, with a composite's fibre flag (#464).
 *
 * A PET-CF blank is `pet` — this app has no class per base+fibre pair — so the base alone would
 * weight it as an ordinary plastic. ANY fibre is abrasive whatever plastic carries it: that is the
 * whole content of the flag, and it is why one `abrasive` class serves the nylons, the PETs, the
 * polycarbonates and anything else a future class word fills.
 */
export function wearClassFor(material: StockMaterial, fibre: FilamentFibre | null = null): WearClass {
  return fibre === null ? WEAR_CLASS[material] : 'abrasive';
}

export function wearKey(material: StockMaterial, fibre: FilamentFibre | null = null): string {
  return `tools.wearWeight.${wearClassFor(material, fibre)}`;
}

export interface WeightedRuntime {
  /** The minutes added to the copy: cutting minutes × the weight. */
  minutes: number;
  weight: number;
  /** In words, for the runtime line. */
  note: string;
}

/**
 * The cutting minutes weighted by the material's wear weight, or unweighted (×1) when it is
 * unknown. `fibre` is the composite flag from the blank's filament class (#464): it selects the
 * abrasive weight, and the note names the fill so the heavier number reads as the reason it does.
 */
export function weighRuntime(
  reading: RuntimeReading,
  material: StockMaterial | null,
  weight: { value: number; source: string } | null,
  fibre: FilamentFibre | null = null,
): WeightedRuntime {
  if (material === null || weight === null) {
    return { minutes: reading.minutes, weight: 1, note: `${reading.note}; the material is not known, so it is counted unweighted (×1)` };
  }
  const wearClass = wearClassFor(material, fibre);
  const fill = fibre === null ? '' : `${FIBRE_LABELS[fibre]}, `;
  return {
    minutes: reading.minutes * weight.value,
    weight: weight.value,
    note: `${reading.note}; × ${weight.value} for ${material} (${fill}${wearClass}, ${weight.source} — ${wearKey(material, fibre)}) = ${r2(reading.minutes * weight.value)} wear-minutes`,
  };
}

// ---------------------------------------------------------------------------------------------------
// Which copy the runtime goes to.

export interface ItemCopies {
  id: string;
  copies: readonly ToolCopy[];
}

/**
 * The one copy the inventory records as in `machineId`. Refused — never guessed — when there is none,
 * more than one, or the job's own tool (`inv:<id>`, when known) is a different item.
 */
export function copyInMachine(
  items: readonly ItemCopies[],
  machineId: string,
  toolKey?: string | null,
): { ok: true; itemId: string; copyId: string } | { ok: false; reason: string } {
  const found = items.flatMap((it) => it.copies.filter((c) => c.whereabouts.kind === 'machine' && c.whereabouts.machineId === machineId).map((c) => ({ itemId: it.id, copyId: c.id })));
  if (found.length === 0) {
    return { ok: false, reason: 'no cutter copy is recorded as in this machine (Manage › Tools › Copies), so the runtime was not added to any' };
  }
  if (found.length > 1) return { ok: false, reason: 'more than one copy is recorded as in this machine, so which one cut is unknown' };
  const hit = found[0]!;
  if (toolKey && toolKey.startsWith('inv:') && toolKey.slice(4) !== hit.itemId) {
    return { ok: false, reason: `the copy recorded in this machine is ${hit.itemId}, but the job’s cutter is ${toolKey.slice(4)} — the runtime was not added` };
  }
  return { ok: true, ...hit };
}

/** The copy with `minutes` more runtime. */
export function withRuntime<T extends ItemCopies>(item: T, copyId: string, minutes: number): T {
  return {
    ...item,
    copies: item.copies.map((c) => (c.id === copyId ? { ...c, runtimeMinutes: Math.round(((c.runtimeMinutes ?? 0) + minutes) * 1000) / 1000 } : c)),
  };
}
