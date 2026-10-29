/**
 * The two-tool split of a design (#410, the issue's scope comment): which cutter takes the first
 * bite, and how the second program is written.
 *
 * PURE, and deliberately: it is handed the reachability table (`reachability.ts`) and the measured
 * rest regions (`workers/sim/engraveRest.ts`) and decides nothing about geometry. That is what lets
 * the RULE — the one thing here that is a judgement rather than a measurement — be read and tested
 * on its own, without wasm.
 *
 * The rule for tool 1 is a removal-rate proxy, not a taste: a cutter takes material out at a rate
 * proportional to its cutting diameter squared (one pass removes width × depth, and the width a
 * stepover covers is proportional to the diameter), and it can only do that over the share of the
 * design it actually reaches. So `⌀² × share` — "how much of this design this bit can take out, and
 * how fast" — and the largest value wins. On the badge blank's own numbers that picks the ⌀2 mm
 * O-flute (0.73 × 4 = 2.9) over the ⌀1 mm corn (0.99 × 1 = 1.0) and the ⌀0.6 mm (1.00 × 0.36 =
 * 0.36), which is the cutter the maintainer named first for the job. A ⌀3.175 mm bit scores zero,
 * because it reaches none of the strokes at all — a wide bit is not slow here, it is absent.
 *
 * Tool 2 needs no rule of its own: `reachability.ts`'s `finerThan` already answers "the smallest
 * cutter that reaches strictly more of the design than this one", which is exactly the second bit. A
 * second program is written only when a second bit EARNS it, and that is a question about the
 * measured rest regions, not about the table — see the route in `scripts/engrave-job.ts`.
 */

import {
  finerThan,
  shareOf,
  untouchedBy,
  V_BIT_REST_SENTENCE,
  type CutterReach,
  type Reachability,
  type ReachRow,
} from './reachability';
import type { EngraveJob, EngraveVectorShape } from '@/types/engraveJob';
import { blankDepthCeiling } from './depthBounds';
import { hasRegionItems } from './recommendTool';
import { isVTraceTool, type Tool } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import type { SeamFacts, ThirdToolAdvice } from './restSettings';

/** One candidate for the first bite, with the numbers the choice was made on. */
export interface RoughCandidate {
  key: string;
  name: string;
  /** Cutting diameter, mm. */
  diameter: number;
  /** Share of the whole design this cutter reaches, 0…1 — `shareOf`. */
  share: number;
  /** `diameter² × share` — the removal-rate proxy, largest wins. */
  score: number;
}

export interface RoughPick {
  /** The cutter to cut FIRST, or null when no measured cutter reaches anything. */
  chosen: RoughCandidate | null;
  /** Every measured cutter with a nonzero share, best first — so the choice can be checked. */
  ranked: RoughCandidate[];
  /** The rule, and this design's numbers under it: a sentence, for the operator. */
  reason: string;
}

/** `⌀2 mm`, as a sentence writes a cutter. */
function dia(v: number): string {
  return `⌀${Number(v.toFixed(3))} mm`;
}

/** `73 %` at the width a sentence can take; never a rounded-to-nothing `<1 %` reading. */
function pct(v: number): string {
  if (v > 0 && v < 0.005) return '<1 %';
  return `${Math.round(v * 100)} %`;
}

/**
 * Which cutter cuts first.
 *
 * Only MEASURED cutters (`excluded === null`) are candidates: a ball nose, or a cutter with no feed
 * row for this material, is not a slower roughing tool — it is not one at all. A zero diameter is
 * dropped too: `diameter²` would rank it last anyway, but a zero is a MISSING number, not a small
 * one, and a rule that quietly treats "unknown" as "tiny" is the bug this filter exists to avoid.
 *
 * TIES ARE STRUCTURAL, not a rarity: the share is a function of the cutter's diameter, so every
 * cutter of one diameter has the same share and the same score, and a bench with two 2 mm bits has a
 * tie by construction. The last key in the sort is therefore the KEY, and the sentence says when it
 * was the key that decided — a rule whose answer depends on the order a catalogue happened to list
 * its rows in is not a rule. (A person who prefers the other one of a tie names it: `--tool`.)
 */
export function roughPick(reach: Reachability): RoughPick {
  const ranked: RoughCandidate[] = reach.cutters
    // #221 — a V-carve is offered by the model but has no flat-disc share; it is not a roughing
    // candidate for a rest pair, and its own strategy is one program with one bit.
    .filter((c) => c.excluded === null && !c.vCarve && c.diameter > 0)
    .map((c) => {
      const share = shareOf(reach, c.key);
      return { key: c.key, name: c.name, diameter: c.diameter, share, score: c.diameter * c.diameter * share };
    })
    .filter((c) => c.share > 0)
    .sort((a, b) => b.score - a.score || a.diameter - b.diameter || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const chosen = ranked[0] ?? null;
  if (chosen === null) {
    return {
      chosen: null,
      ranked,
      reason: 'no measured cutter reaches any part of this design, so there is no first pass to run',
    };
  }
  const runnersUp = ranked
    .slice(1, 3)
    .map((c) => `${dia(c.diameter)} at ${pct(c.share)} (${c.score.toFixed(2)})`)
    .join(', ');
  const tied = ranked.filter((c) => c.score === chosen.score);
  return {
    chosen,
    ranked,
    reason:
      `${chosen.key} cuts first: it reaches ${pct(chosen.share)} of the design, and across a ` +
      `${dia(chosen.diameter)} cutter that is the most material any bit on the bench takes out per ` +
      `pass (⌀² × share = ${chosen.score.toFixed(2)})` +
      (runnersUp === '' ? '' : `; the next best are ${runnersUp}`) +
      (tied.length < 2
        ? ''
        : `. ${tied.length} cutters score that same number (⌀² × share cannot tell two bits of one ` +
          `diameter apart), and ${chosen.key} is the first of them by key — name another with --tool ` +
          'if you would rather clear with it'),
  };
}

/** An item the first cutter cannot enter at all, and so is entirely the second cutter's job. */
export interface UnroughedItem {
  id: string;
  name: string;
  /** Ideal area of the item, mm². */
  area: number;
  /** The depth it is cut to, mm — kept so the sentence can name the floor. */
  depth: number;
}

/**
 * The items the FIRST cutter must be taken off, because it cannot enter them at all.
 *
 * A cutter that reaches none of an item is `item-empty`, a hard refusal from the generator — so
 * leaving the item enabled in the first program does not cut a little of it, it stops the program.
 * The item is disabled for that program and named: it is not dropped from the design (the second
 * cutter reaches it), and the run sheet says which cutter is going to cut it.
 *
 * The caller disables them; this only says which. Disabling is a WRITE to the job document, and
 * where that write goes is the route's business, not this module's.
 */
export function unroughedItems(reach: Reachability, roughKey: string): UnroughedItem[] {
  const rows: ReachRow[] = untouchedBy(reach, roughKey);
  return rows.map((r) => ({ id: r.itemId, name: r.name, area: r.glyphArea, depth: r.depth }));
}

/** The second tool, or an explanation of why there is not one — never a bare `null`. */
export interface RestToolPick {
  cutter: CutterReach | null;
  reason: string;
}

/**
 * #486 — why `rest` cannot be the second cutter on this job, or null when it can.
 *
 * The rest pass is area-based: it asks what a narrower FLAT disc can open that the first program
 * left. A V-bit's cutting width grows with depth, so since #221 a V-bit on a region job IS the
 * cutter (a V-carve) and never the second one; only `--rest <key>` can still name it, and that
 * route says THIS sentence up front rather than measuring "0 mm² of the 0 mm²" and reporting
 * "nothing to clean up". The maintainer's answer (#486, 2026-10-17) is #221's V-carve.
 *
 * A trace-only job has no regions and takes a V-bit as a normal trace tool, so it is not refused.
 */
export function vBitRestRefusal(job: EngraveJob, rest: Tool): string | null {
  if (!isVTraceTool(rest)) return null;
  // The same question `recommendTool` asks, so a primitive pocket counts as a region here too.
  return hasRegionItems(job) ? V_BIT_REST_SENTENCE : null;
}

/**
 * Which cutter cleans up after `roughKey`.
 *
 * `finerThan` answers it — the smallest cutter that reaches strictly more of the design — and for a
 * design every cutter qualifies on, that is null, because there is nothing a second program would
 * add. The distinction is stated rather than left to a bare null: "no finer cutter exists on the
 * bench" and "the first cutter already reaches everything" are different answers for the operator.
 */
export function restToolPick(reach: Reachability, roughKey: string): RestToolPick {
  const base = reach.cutters.find((c) => c.key === roughKey);
  // #221 — a V-carve is the WHOLE job: the cone pockets the design at the colour plane with one
  // bit. There is no flat rest programme to add, so the row says that rather than measuring a
  // second cutter against a job that does not have a second pass.
  if (base?.vCarve === true) {
    return {
      cutter: null,
      reason:
        'the first cutter is a V-bit on a region job: the V-carve is the whole job at the colour ' +
        'plane, so there is no flat rest pass to add',
    };
  }
  const cutter = finerThan(reach, roughKey);
  if (cutter !== null) {
    return {
      cutter,
      reason:
        `${cutter.key} cleans up: at ${dia(cutter.diameter)} it is the smallest cutter on the bench ` +
        `that reaches more of this design than the first one (${pct(shareOf(reach, roughKey))} → ` +
        `${pct(shareOf(reach, cutter.key))} of the design's area)`,
    };
  }
  const measured = reach.cutters.filter((c) => c.excluded === null && !c.vCarve).length;
  return {
    cutter: null,
    reason:
      measured <= 1
        ? 'no second cutter was measured for this material, so there is nothing to clean up with'
        : `no measured cutter reaches more of this design than ${base === undefined ? roughKey : dia(base.diameter)} ` +
          `(${pct(shareOf(reach, roughKey))} of the design's area) — one program is the whole job`,
  };
}

/** Everything the rest program needs from one measured rest region. */export interface RestRegionInput {
  id: string;
  name?: string;
  depth: number;
  polygons: [number, number][][];
}

/** The bounding size of a set of rings, mm — the panel's `width`/`height` for an imported outline. */
function size(polygons: readonly [number, number][][]): { width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polygons) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { width: 0, height: 0 };
  return { width: maxX - minX, height: maxY - minY };
}

/** A measurement as the job writes every number: mm to the micron, like `fromDesign.ts`'s `um`. */
function um(v: number): number {
  return Number(v.toFixed(3));
}

/**
 * An item name out of the region's operation descriptor (#437).
 *
 * `engraveRegions` names a region with `itemOperationName`: `Pocket outline "(Like the Whiskey)"
 * (2 contours, 41.593…×5.171…mm)`. Carried verbatim into an item name, the rest program's own
 * header re-quotes it — `rest of …` is written as `Pocket outline "rest of …"` — so the operator
 * read nested quotes and the descriptor's unrounded sizes were repeated there too. The item's name
 * is the quoted part when the descriptor carries one; otherwise its trailing parameter clause is
 * dropped. Quotes are removed either way, because the header adds its own pair downstream.
 */
function restItemName(name: string | undefined, id: string): string {
  if (name === undefined || name.trim() === '') return id;
  const quoted = /"([^"]*)"/.exec(name)?.[1]?.trim();
  if (quoted) return quoted;
  return name.replace(/\s+\([^)]*\)\s*$/, '').trim() || id;
}

/**
 * The rest program's job document: the SAME blank, the same voids and the same material as the
 * design job, with the rest regions in place of every design item and the second cutter named.
 *
 * The polygons arrive in the STOCK frame — that is the frame `engraveRegions` measures in, and the
 * frame a job's items are placed by — so each item sits at the origin with no rotation and carries
 * them untouched. That is the same invariant the design route holds when it puts a file's rings
 * under an item's `position`/`rotation` (`fromDesign.ts` turns its rings by 90° about the item
 * centre); here there is nothing to turn, because the measurement was already made in the bench's
 * frame. `fromDesign`'s `sourceName` discipline carries over: an operator reading the program back
 * has to be able to tell a region the FILE asked for from a region the FIRST PROGRAM left.
 *
 * What is REPLACED matters as much as what is carried. EVERY cutting item list is emptied —
 * `labels`, `shapes`, `combined`, `traces`, `drills`, and also `cutouts`, `chamfers`, `threads` and
 * `primitives`: this program cuts the rest and nothing else, and a design item left in it would
 * re-cut the whole design at the fine bit's pace — an hour of air-cutting in the middle of the
 * part. The cut-outs are the sharpest case (#746): a rest pass owns NO items, so a cut-out carried
 * here is cut by a cutter that does not own it, and since the cut-out's owner posts it in its own
 * final program the same profile would be cut twice — and the earlier cut would release the part
 * before its owner reached it. `keepOuts` is NOT touched: a void in the blank's underside is a
 * property of the BLANK, which this program shares, and a rest pass that could cut into the magnet
 * pocket would be a worse mistake than the one it fixed.
 */
export function restJobFor(
  job: EngraveJob,
  regions: readonly RestRegionInput[],
  toolKey: string,
): EngraveJob {
  // #762 — A REST REGION CANNOT BE DEEPER THAN THE BLANK. The regions are measured off the first
  // program's simulation, and a through feature's left-over region carries the through depth
  // (`thickness + breakthrough`); copied verbatim it became a rest vector cutting 3.3 mm into a
  // 3 mm blank — `depth-exceeds-stock`'s "−0.3 mm floor" on j17. The rest pass removes what the
  // first cutter left ABOVE the blank's floor, so the depth is clamped to that floor: over a
  // through feature the first program has already cleared the region and this cuts air, and over
  // anything else the clamp can only stop the finer cutter at the material it can leave.
  const floorAllowed = blankDepthCeiling(job);
  const vectors: EngraveVectorShape[] = regions.map((r, i) => {
    const { width, height } = size(r.polygons);
    // The descriptor's own item name, not the operation sentence wrapped around it, and sizes at
    // the micron so the header the panel reads back matches every other number in the job (#437).
    const name = restItemName(r.name, r.id);
    return {
      kind: 'vector',
      id: `rest-${i + 1}`,
      name: `rest of ${name}`,
      sourceName: `rest of ${name}`,
      contours: r.polygons,
      fillRule: 'EvenOdd',
      width: um(width),
      height: um(height),
      position: { x: 0, y: 0 },
      rotation: 0,
      depth: Math.min(r.depth, floorAllowed),
      enabled: true,
    };
  });
  return {
    ...job,
    name: `${job.name} rest`,
    labels: [],
    shapes: [],
    combined: [],
    traces: [],
    vectors,
    drills: [],
    // #746 — the rest pass owns NO items. Every other cutting list belongs to a cutter that cuts
    // (or posts) it in its own program: a cut-out left here would be cut by this rest cutter and
    // then again by its owner's cut-out-last program, releasing the part early.
    cutouts: [],
    chamfers: [],
    threads: [],
    primitives: [],
    toolKey,
    // #472 — the rest job is ONE program for ONE cutter. A saved `setups[]` would make anything
    // that re-read the document inside the generator walk the whole job again from one of its own
    // programs, so it is removed exactly as `jobForSetup` removes it.
    setups: undefined,
    // The materialised cutter belonged to the FIRST program. Left in place it would be read back
    // ahead of `toolKey` (`jobTool`) and the rest program would be generated, verified and simulated
    // for the wrong bit — so it is cleared, and the route materialises the second cutter's.
    tool: null,
    // `cutOverride` is a hand-typed feed for ONE cutter. Tool 2 has its own feed table row, so
    // carrying the first bit's numbers across would be a claim about a cutter nobody measured.
    cutOverride: undefined,
    // The route derived this key from the reachability numbers rather than a person choosing it,
    // which is exactly the `computed` stamp the badge route uses for a blank it copies in (#254).
    sources: { ...job.sources, tool: 'computed' },
  };
}

/** One program, as the operator has to run it: the file, and how big it is. */
export interface RestProgram {
  key: string;
  /** Cutting diameter, mm. */
  diameter: number;
  /** The `.nc` this program is. */
  nc: string;
  /** Its dry-run frame file, or null when the generator produced none. */
  frame: string | null;
  /**
   * #747 — the work Z its frame traces at, as the worker computed it. Optional: a caller that
   * predates #747 does not fill it, and the sheet then reads the design's `FRAME_Z`.
   */
  frameZ?: number | null;
  /**
   * #747 — why the frame was withheld although the program itself verified, or null/absent. The
   * sheet must not call a withheld frame a failed program.
   */
  frameError?: string | null;
  /**
   * The cutting parameters this program was generated with, or null when its feeds did not resolve
   * (#437 item 8). The sheet states each program's own numbers: the two programs are different
   * cutters in the same material, so program 1's RPM and step-over are not program 2's, and a sheet
   * that printed one line for the pair would be handing the operator the wrong numbers for half the
   * job. Type-only here — the route reads it off the generated program.
   */
  params: CutParams | null;
  /** Passes the generator made at `params.stepDown` — the count the sheet prints, never a guess. */
  passes: number;
  /**
   * Whether this program is trace-only (#437 item 8): a trace puts the cutter ON the line, so
   * nothing is ever stepped over and a step-over printed beside it would be a number for a cut the
   * program never makes. A fact the route derives from the program's own job, not an assumption the
   * sheet makes about the kind of program a rest pass writes today.
   */
  traceOnly: boolean;
  /** Cutting moves in the program, and the generator's own estimate. */
  moves: number;
  seconds: number;
  /**
   * #487 — the program's XY travel, and what the same cut would have spent before the loop
   * ordering changed. Optional: a caller that predates the report still fills a `RestProgram`.
   */
  travel?: {
    rapidMm: number;
    cutMm: number;
    baselineRapidMm: number;
  };
  /**
   * mm³ this program's own sweep removed. For the rest program that number is ON TOP of the first
   * one's — its sweep started from program 1's result (`SimLoadOpts.priorRemoval`) — so the two
   * together are what the pair takes out of the blank, and the second program's share of that is the
   * one honest measure of how much of the job is clean-up.
   */
  removedVolume: number;
}

/** One rest region, as measured — the second program's items. */
export interface RestRegionRow {
  name: string;
  /** The floor it is cut to, mm below the top face. */
  depth: number;
  /** mm² the second tool has to traverse, the overlap band included. */
  area: number;
  /** mm² the item asks for, opened by the second tool. */
  cutArea: number;
  /** mm² of `cutArea` the FIRST program already removed. */
  clearedArea: number;
}

/**
 * The whole two-tool story, as the run sheet prints it (#410's scope comment).
 *
 * It is assembled by the CALLER — the route that ran both programs — because every number in it
 * comes from a measurement that route already made, and re-deriving any of it in the renderer would
 * be a second answer to a question that has one. The renderer's job is the one thing the caller
 * cannot do: say what the operator physically does about it, in order, at the machine.
 *
 * `restRemovedVolume` and `leftover` are the two halves of the chained simulation, and they are
 * separate fields on purpose: the first is what program 2 removed ON TOP of program 1 (`SimLoadOk`'s
 * own number for program 2, whose sweep started from program 1's removal), and the second is what
 * neither program touched, measured on the union of both removals. Presenting them as one number
 * would hide the only fact the operator is checking — that the second program's cut is small.
 */
export interface RestPassFacts {
  rough: RestProgram & {
    /** Share of the whole design tool 1 reaches, 0…1. */
    share: number;
    /** `⌀² × share`, the proxy it was chosen on. */
    score: number;
    reason: string;
  };
  rest: RestProgram & { reason: string };
  /**
   * The items program 1 leaves off entirely, because it cannot enter them at all. They are cut by
   * program 2 — this is the list the sheet prints so nothing looks silently absent.
   */
  unroughed: UnroughedItem[];
  regions: RestRegionRow[];
  /** Totals over every region, mm². */
  cutArea: number;
  clearedArea: number;
  restArea: number;
  /**
   * How far the rest pass reaches back into tool 1's territory, mm — the band the rest program was
   * actually generated with, which is the job's own derivation floored by the shop's number (or an
   * operator's typed override), never the stored number as such (#436). It is `seam.overlap`.
   */
  overlap: number;
  /**
   * The band, where it came from, and what THIS pair of cutters says about it (#436). The sheet
   * needs all three together: the number means one thing when the job's own geometry produced it
   * and another when somebody chose it, and on a chosen default the second half is the whole
   * reason the operator can act — "0.1 mm is below the 0.49 mm this pair's residues need" is a
   * sentence; "0.1 mm" alone is a number nobody can judge.
   */
  seam: SeamFacts;
  /**
   * Whether what neither program removed is worth a third cutter, and the threshold it was judged
   * against (#436). Null when the job states no removable area to take a share of.
   */
  thirdTool: ThirdToolAdvice | null;
  /** mm³ the SECOND program removed, from its own sweep run on the first program's result. */
  restRemovedVolume: number;
  /** What neither program removed: the design material still standing after both. */
  leftover: {
    /** mm², summed over every region. */
    area: number;
    /** Per region, largest first, so the sheet can name the worst in one line. */
    byItem: { name: string; depth: number; area: number }[];
  };
}

