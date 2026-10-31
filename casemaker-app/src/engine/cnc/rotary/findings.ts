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
 *     the emitted moves, and both read the same two sentences. `wrap-off-free-end` is the
 *     tailstock-out twin: the map ends at the stick-out, and past it there is no stock (#724).
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
  ROTARY_NECK_ID,
  ROTARY_NECK_MIN_LENGTH_MM,
  neckCutsItemSentence,
  neckIntoBandSentence,
  neckJawClearanceSentence,
  neckThinnerSentence,
  neckTooShortSentence,
  neckWiderSentence,
  rotaryNeckFacts,
  rotaryNeckMinDiameterMm,
} from './neck';
import {
  freeEndSentence,
  jawsSentence,
  rotaryFreeSpan,
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
  // The span the placement centres on too (`rotaryFreeSpan`): one definition, so moving the
  // default layout into the free span cannot drift from the sentence that refuses a band.
  const span = rotaryFreeSpan(map);
  // One X extent per OPENED region, shared by the band checks and the neck's overlap check: both
  // judge the cut's own edge, and both must read the same numbers.
  const extents: { region: RotaryOpenedRegion; xMin: number; xMax: number }[] = [];
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
    extents.push({ region, xMin, xMax });
  }
  for (const { region, xMin, xMax } of extents) {
    const item = findItem(job, region.labelId);
    if (item === undefined) continue;
    const who = itemLabel(item);
    if (xMin < span.from) {
      findings.push({
        severity: 'error',
        code: 'wrap-into-clamp',
        labelId: region.labelId,
        message: `${who} ${jawsSentence(xMin)}.`,
      });
    }
    if (map.tailstock && xMax > span.to) {
      findings.push({
        severity: 'error',
        code: 'wrap-into-clamp',
        labelId: region.labelId,
        message: `${who} ${tailstockSentence(xMax, map.stickout)}.`,
      });
    } else if (xMax > map.stickout) {
      // #724 B3 review — with the tailstock OUT there is no band to name, but the map still ends
      // at the stick-out: past it there is no stock, so the cut would carve air. Its own sentence
      // and code, because "runs into the tailstock's band" would name a tailstock that is absent.
      // #786 slice 1 part 2 — cutting that air is INFORMED, not refused: the sentence states the
      // reach against the stick-out, Generate cuts what is on the rod, and the sweep's checks
      // judge anything the cutter would touch. The tailstock case above stays an error.
      findings.push({
        severity: 'warning',
        code: 'wrap-off-free-end',
        labelId: region.labelId,
        message: `${who} ${freeEndSentence(xMax, map.stickout)}.`,
      });
    }
  }

  // 4. THE NECK FOR PARTING (#737). Placed on the SAME free span the two bands above are judged
  // on, and refused with the same sentences: the neck is the operator's chosen cut, so a neck that
  // cannot sit clear of the jaws or the tailstock is refused before any toolpath exists. The safe
  // minimum is a labelled default (neck.ts), refused in words with every number and its unit.
  const neck = rotaryNeckFacts(job);
  if (neck !== null) {
    // Every neck carries this, whatever else is wrong with it: the clearance beside the cut is NOT
    // checked. The keep-out is Case Maker's guess and the sweep models no body for the fixture that
    // sits there — the jaws beside a chuck-side neck, the tailstock beside a tailstock-side one — so
    // the operator air-cuts the neck first and keeps checking by eye until the rotary is measured.
    findings.push({
      severity: 'warning',
      code: 'neck-jaw-clearance',
      labelId: ROTARY_NECK_ID,
      message: neckJawClearanceSentence(neck.end),
    });
    const stockDiameter = map.radius * 2;
    if (neck.diameterMm >= stockDiameter) {
      findings.push({
        severity: 'error',
        code: 'neck-wider-than-part',
        labelId: ROTARY_NECK_ID,
        message: `The neck for parting is wrong: ${neckWiderSentence(neck.diameterMm, stockDiameter)}.`,
      });
    } else if (neck.lengthMm < ROTARY_NECK_MIN_LENGTH_MM) {
      findings.push({
        severity: 'error',
        code: 'neck-too-short',
        labelId: ROTARY_NECK_ID,
        message: `The neck for parting is too short: ${neckTooShortSentence(neck.lengthMm)}.`,
      });
    } else {
      const band = neckIntoBandSentence(map, neck);
      if (band !== '') {
        findings.push({
          severity: 'error',
          code: 'neck-in-band',
          labelId: ROTARY_NECK_ID,
          message: `The neck for parting ${band}.`,
        });
      } else {
        // The neck and a design item cannot occupy the same X: the neck is cut after the engrave,
        // so any item whose OPENED region overlaps [from, to] is erased by the cut. This is the
        // item's own edge against the neck's, and the sentence names both extents.
        const overlap = extents.find(
          ({ region, xMin, xMax }) =>
            xMin < neck.toMm && xMax > neck.fromMm && findItem(job, region.labelId) !== undefined,
        );
        if (overlap !== undefined) {
          const item = findItem(job, overlap.region.labelId)!;
          findings.push({
            severity: 'error',
            code: 'neck-cuts-item',
            labelId: ROTARY_NECK_ID,
            message:
              `The neck for parting is wrong: ${neckCutsItemSentence(itemLabel(item), overlap.xMin, overlap.xMax, neck)}. ` +
              'Move the item clear of the neck, or shorten or move the neck.',
          });
        } else {
          const min = rotaryNeckMinDiameterMm(job.stock.material, neck.effectiveMm);
          if (neck.diameterMm < min.diameterMm) {
            findings.push({
              severity: 'error',
              code: 'neck-thin',
              labelId: ROTARY_NECK_ID,
              message: `The neck for parting is too thin: ${neckThinnerSentence(job.stock.material, neck.diameterMm, { ...neck, tailstock: map.tailstock }, min.diameterMm)}.`,
            });
          }
        }
      }
    }
  }

  return findings;
}
