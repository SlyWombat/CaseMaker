/**
 * The rotary job's own findings (#240 slice 2, `rotary-flow.md` §4, §6.4).
 *
 * Three checks live here, all about the DOCUMENT's shape rather than a toolpath:
 *
 *  1. `axis-crossing` — an engrave whose floor reaches or passes the stock's radius. A rotary
 *     cut's floor is a RADIUS above the axis, so a depth of R leaves nothing under the cutter:
 *     the design's operator sentence is "cuts through the centre" (§4). Exactly R is its own
 *     case — "reaches the axis exactly" — because "0 mm past" reads like nothing happened.
 *  2. `rotary-unsupported` — the job carries a cut class the surface wrap does not cut yet:
 *     cut-outs, traces, drills, threads, chamfers, through regions, inlays, raised prisms,
 *     under-surface voids, facing passes. The wrap turns a FLAT region pocket into A moves, so
 *     anything that is not that pocket has no honest wrapped program in this slice: a cut-out's
 *     through depth has no floor radius to scale, a thread or a drill ignores the map entirely.
 *     The refusal names the work in the operation list's own words and gives the action — remove
 *     it, or cut this job on a flat blank.
 *
 *  3. `wrap-into-clamp` — an item whose OPENED region reaches into the jaws' keep-out band at the
 *     map's left end, or into the tailstock's band at the free end while the tailstock is in
 *     (design §3.7: "an item that enters a band is refused at its row"). The opening IS the cut's
 *     edge, so its X extent is the edge the sentence names. The verifier checks the same bands on
 *     the emitted moves, and both read the same two sentences.
 *
 * The other §6.4 refusals are NOT here: "leaves the line over the axis", "turns the stock while
 * the cutter is in it" and "does not fit the rotary's ⌀80 × 150 mm" are read off the PROGRAM by
 * the verifier (`verify.ts`), and "cuts through the centre" is checked a second time there on the
 * moves themselves. The two layers share the sentences (`rotary/wrap.ts`), so the finding and the
 * file cannot word one fault two ways.
 *
 * Codes are data: every sentence below is operator wording with units, and none of them says an
 * internal code.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { PartPlan } from '@/engine/cnc/engrave/partPlan';
import { itemLabel, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { findItem } from '@/engine/cnc/engrave/recommendTool';
import {
  ROTARY_JAW_KEEP_OUT_MM,
  ROTARY_TAILSTOCK_BAND_MM,
  jawsSentence,
  rotaryMapOf,
  tailstockSentence,
  throughCentreSentence,
} from './wrap';

/**
 * One item's OPENED region, in map millimetres — the shape `engraveRegions` measured and the CAM
 * will pocket. Structurally the `measured` rows the worker hands over; declared here so the
 * engine module does not import a worker module for three numbers of a polygon.
 */
export interface RotaryOpenedRegion {
  /** The document item the opening belongs to. */
  labelId: string;
  /** The opened region as plain polygons — X along the axis, Y the surface arc at R. */
  polygons: readonly (readonly (readonly [number, number])[])[];
}

/** `a cut-out ("Base")` — a class phrase with the plan's operation name when it has one. */
function named(phrase: string, name: string): string {
  return name === '' ? phrase : `${phrase} (${name})`;
}

/** "a, b and c" — the list in an operator sentence. */
function listText(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The findings a rotary job's plan raises before any toolpath is posted. Empty for a flat job —
 * `rotaryMapOf` is the same predicate every stage branches on — so this call is free there.
 */
export function rotaryJobFindings(
  job: EngraveJob,
  plan: PartPlan,
  opened: readonly RotaryOpenedRegion[] = [],
): JobFinding[] {
  const map = rotaryMapOf(job);
  if (map === null) return [];
  const findings: JobFinding[] = [];

  // 1. A floor at or below the axis. A THROUGH engrave is refused by class below; its depth is
  // the blank's, not a floor, so it is not judged twice here.
  for (const engrave of plan.engraves) {
    if (engrave.through === true) continue;
    if (engrave.depth < map.radius) continue;
    const item = findItem(job, engrave.id);
    const who = item === undefined ? engrave.name : itemLabel(item);
    findings.push({
      severity: 'error',
      code: 'axis-crossing',
      labelId: engrave.id,
      message: `${who} ${throughCentreSentence(map.radius - engrave.depth)}.`,
    });
  }

  // 2. Work the surface wrap cannot cut yet, by class, in the operation list's own names.
  const unsupported: string[] = [];
  for (const engrave of plan.engraves) {
    if (engrave.through === true) unsupported.push(named('a through-cut', engrave.name));
    if (engrave.inlay !== undefined) unsupported.push(named('an inlay', engrave.name));
    if (engrave.prism !== undefined) unsupported.push(named('a raised prism', engrave.name));
  }
  for (const cutout of plan.cutouts) unsupported.push(named('a cut-out', cutout.name));
  for (const chamfer of plan.chamfers) unsupported.push(named('a chamfer', chamfer.name));
  for (const trace of plan.traces) unsupported.push(named('a trace', trace.name));
  for (const drill of plan.drills) unsupported.push(named('a drilled hole', drill.name));
  for (const thread of plan.threads) unsupported.push(named('a milled thread', thread.name));
  for (const keepOut of plan.stock.keepOuts) unsupported.push(named('an under-surface void', keepOut.name));
  if (plan.facing !== null) unsupported.push('a facing pass');
  if (unsupported.length > 0) {
    findings.push({
      severity: 'error',
      code: 'rotary-unsupported',
      message:
        `This job asks for more than a rotary engrave: it also has ${listText(unsupported)}. ` +
        `The rotary wrap cuts engraves only — remove that work for this job, or cut it on a flat blank.`,
    });
  }

  // 3. The two end bands, judged on each item's OPENED region — the cut's own edge. A region that
  // reaches into a band is refused AT ITS ROW, with the same sentence the verifier would raise
  // against the moves (design §3.7, §6.4).
  const tailEnd = map.stickout - ROTARY_TAILSTOCK_BAND_MM;
  for (const region of opened) {
    if (region.polygons.length === 0) continue;
    let xMin = Infinity;
    let xMax = -Infinity;
    for (const contour of region.polygons) {
      for (const [x] of contour) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
    if (!Number.isFinite(xMin)) continue;
    const item = findItem(job, region.labelId);
    if (item === undefined) continue;
    const who = itemLabel(item);
    if (xMin < ROTARY_JAW_KEEP_OUT_MM) {
      findings.push({
        severity: 'error',
        code: 'wrap-into-clamp',
        labelId: region.labelId,
        message: `${who} ${jawsSentence(xMin)}.`,
      });
    }
    if (map.tailstock && xMax > tailEnd) {
      findings.push({
        severity: 'error',
        code: 'wrap-into-clamp',
        labelId: region.labelId,
        message: `${who} ${tailstockSentence(xMax, map.stickout)}.`,
      });
    }
  }

  return findings;
}
