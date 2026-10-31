/**
 * #743 P-8 — ALIGNMENT HOLES FOR A BOARD'S SECOND SIDE.
 *
 * A board's own holes are small — 0.8, 1.0, 3.2 mm — and the probe is as wide as its tip. #429
 * refuses a feature it cannot read, so on most real boards NO hole can be a reference: the second
 * side could only be placed by eye. The standard double-sided practice is to drill two alignment
 * holes of a readable size in the blank OUTSIDE the board, through, and register on those in the
 * second setup. They cost scrap metal and nothing else.
 *
 * WHERE THEY GO (the manager's rule, 2026-10-31): on the TURN'S AXIS LINE — the line of the flip
 * that does not move — so each hole appears at the same work coordinate with the other face up.
 * For a stock turned over about Y that is `x = length/2` (the tape flip); about X it is
 * `y = width/2` (the vise flip). Each hole sits in the scrap beside the board, its rim clear of
 * the blank's edge and of the board's edge by a labelled allowance.
 *
 * THE SIZE is the smallest one the fitted probe can read: #429 skips a feature narrower than the
 * tip plus twice the fine step, and one whose mid-line is not clear of its corners by the tip's
 * radius plus the corner clearance. So the minimum is `tip + 2·max(fineStep, cornerClearance)`,
 * and the offer takes an owned drill or flat of at least that size (the smallest), else the
 * minimum itself — the job's own `hole-no-cutter` then says no cutter makes it.
 *
 * THIS INFORMS. Nothing is added without the operator's press, and a board with no usable holes
 * still cuts: the second side is placed by eye, and how far that lands is unmeasured, which the
 * sentence says.
 */

import { orient } from '@/engine/cnc/setups/orient';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { MountSpec } from '@/engine/cnc/setups/types';
import { newEngraveDrillId } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { pcbCutterPlan, pcbHoleAssignment, withPcbCutters } from './pcbCutters';

/**
 * The rim's distance from the blank's edge and from the board's edge, mm — a labelled allowance,
 * not a measurement: enough scrap to drill into and enough gap that the alignment hole's own
 * break-out cannot reach the copper.
 */
export const ALIGNMENT_CLEARANCE_MM = 1;

export interface PcbAlignmentInput {
  blank: { length: number; width: number; thickness: number };
  /** The board's box on the blank, mm from its front-left corner (the import's own placement). */
  board: { left: number; top: number; width: number; height: number };
  /** The holding both setups use: it decides which way the stock is turned over. */
  mount: MountSpec;
  /**
   * The numbers #429 plans with, already resolved from the fitted probe and the shop. A hole is
   * probeable when it is wider than the tip plus twice the fine step AND its mid-line is clear of
   * its corners by the rim offset plus the corner clearance.
   */
  probe: {
    tipDiameterMm: number;
    tipRadiusMm: number;
    fineStepMm: number;
    cornerClearanceMm: number;
    edgeMarginMm: number;
    /** How far outside an opening a scan starts; a hole near the blank's edge must leave that much stock. */
    scanInsideMm: number;
  };
  /** The board's largest own drilled hole, mm (0 when none states a size). */
  largestBoardHoleMm: number;
}

export interface PcbAlignmentOffer {
  /** The smallest hole the fitted probe can read, mm. */
  minProbeableMm: number;
  /** The board's largest own hole, mm. */
  largestBoardHoleMm: number;
  /** The diameter the two alignment holes are drilled at, mm. */
  diameterMm: number;
  /**
   * The two holes in the FIRST setup's work frame, mm. Empty when no pair can be placed and read;
   * the sentence then says why.
   */
  holes: { x: number; y: number }[];
  /** The sentence the panel states — the numbers, the offer, and the by-eye alternative. */
  message: string;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The smallest hole #429's two width rules let the fitted probe read, mm. */
export function minProbeableHoleMm(probe: PcbAlignmentInput['probe']): number {
  // Wider than the tip plus a fine step each side, AND its mid-line far enough from its corners
  // (rim offset + corner clearance each side). Both are #429's own checks in `references.ts`.
  return r3(
    Math.max(
      probe.tipDiameterMm + 2 * probe.fineStepMm,
      2 * (probe.tipRadiusMm + probe.cornerClearanceMm),
    ),
  );
}

/** The standard alignment sizes, mm — 4 mm is the usual one, and larger when the probe needs it. */
const STANDARD_ALIGNMENT_MM = [4, 5, 6, 8, 10] as const;

/** The offered diameter: the smallest standard size the probe can read (4 mm by default), mm. */
function alignmentDiameter(minProbeableMm: number): number {
  const need = Math.max(minProbeableMm, STANDARD_ALIGNMENT_MM[0]);
  return r3(STANDARD_ALIGNMENT_MM.find((d) => d >= need - 1e-9) ?? Math.ceil(need));
}

/**
 * The two alignment holes for a board whose own holes the probe cannot read, or NULL when the
 * board already has a hole it can. The holes are the extreme positions of the turn's fixed line
 * that clear the board and the blank, so they are as far apart as the blank allows — which is what
 * #429's tape rule needs to read the turn.
 */
export function pcbAlignmentOffer(input: PcbAlignmentInput): PcbAlignmentOffer | null {
  const minProbeableMm = minProbeableHoleMm(input.probe);
  if (input.largestBoardHoleMm + 1e-9 >= minProbeableMm) return null;
  const diameterMm = alignmentDiameter(minProbeableMm);
  const r = diameterMm / 2;
  const { length, width } = input.blank;
  const { board } = input;
  // The BLANK's edge must leave the whole scan on stock: the start sits `scanInsideMm` out from
  // the wall, and #429 requires that start inside the region its own clearance keeps off the edge
  // (rim offset + corner clearance). The BOARD's edge must keep the scan start clear of the
  // openings inside the board too — #429 keeps a start out of every other opening GROWN by that
  // same clearance, and a board hole can sit at the board's edge. The offer is calibrated to
  // those checks, so the hole it promises really is read.
  const keep = input.probe.tipRadiusMm + input.probe.cornerClearanceMm;
  const boardClear = Math.max(r + ALIGNMENT_CLEARANCE_MM, input.probe.scanInsideMm + keep + ALIGNMENT_CLEARANCE_MM);
  const blankClear = r + input.probe.scanInsideMm + keep + ALIGNMENT_CLEARANCE_MM;

  const numbers =
    `The probe cannot read this board's holes: with its ${r3(input.probe.tipDiameterMm)} mm tip it ` +
    `needs holes of at least ${r3(minProbeableMm)} mm, and the board's largest is ${r3(input.largestBoardHoleMm)} mm.`;
  const byEye = ' The second side can still be cut by eye, but nothing then measures where the board landed.';

  const o = orient('bottom', input.mount, { x: length, y: width, z: input.blank.thickness });
  if (!o.ok) {
    return { minProbeableMm, largestBoardHoleMm: input.largestBoardHoleMm, diameterMm, holes: [], message: numbers + byEye };
  }
  // The flip's FIXED line: the axis the rotation does not mirror, through the stock's centre. A
  // hole on it reads the same with either face up.
  const mirrorsX = o.matrix[0][0] < 0;
  const mirrorsY = o.matrix[1][1] < 0;
  if (mirrorsX === mirrorsY) {
    return { minProbeableMm, largestBoardHoleMm: input.largestBoardHoleMm, diameterMm, holes: [], message: numbers + byEye };
  }
  const alongY = mirrorsX; // x is mirrored, so the line runs along Y at x = length / 2

  // The free spans on the line, outside the board and clear of both edges.
  const boardMin = alongY ? board.top : board.left;
  const boardMax = alongY ? board.top + board.height : board.left + board.width;
  const stockMax = alongY ? width : length;
  const lowStart = blankClear;
  const lowEnd = boardMin - boardClear;
  const highStart = boardMax + boardClear;
  const highEnd = stockMax - blankClear;
  if (!(lowEnd >= lowStart) || !(highEnd >= highStart)) {
    return {
      minProbeableMm,
      largestBoardHoleMm: input.largestBoardHoleMm,
      diameterMm,
      holes: [],
      message:
        numbers +
        ' There is no room beside the board on the flip line for two alignment holes.' +
        byEye,
    };
  }
  const at = (v: number): { x: number; y: number } => (alongY ? { x: r3(length / 2), y: r3(v) } : { x: r3(v), y: r3(width / 2) });
  const holes = [at(lowStart), at(highEnd)];
  const separation = highEnd - lowStart;

  // #429's tape rule: the turn is read between the two holes, and an unreadable turn means nothing
  // holds it on tape. The error is judged across the WORK the second side cuts (the board), which
  // is what `referenceRegistrationFor` passes the plan — `fineStep/2 · span / separation` must be
  // better than the margin. State the distance and what it must be rather than offer holes that
  // cannot carry the registration.
  if (input.mount.kind === 'tape') {
    const span = Math.max(board.width, board.height);
    const required = (input.probe.fineStepMm / 2) * (span / input.probe.edgeMarginMm);
    if (!(separation > required)) {
      return {
        minProbeableMm,
        largestBoardHoleMm: input.largestBoardHoleMm,
        diameterMm,
        holes: [],
        message:
          numbers +
          ` Two ${r3(diameterMm)} mm holes would sit ${r3(separation)} mm apart on the flip line, and the tape flip ` +
          `needs them more than ${r3(required)} mm apart to read its turn across the board.` +
          byEye,
      };
    }
  }
  if (input.mount.kind === 'bracket') {
    // #429's bracket plan refuses reference features outright (the bracket's datum fixes X and Y).
    return { minProbeableMm, largestBoardHoleMm: input.largestBoardHoleMm, diameterMm, holes: [], message: numbers + byEye };
  }

  return {
    minProbeableMm,
    largestBoardHoleMm: input.largestBoardHoleMm,
    diameterMm,
    holes,
    message:
      numbers +
      ` Add two ${r3(diameterMm)} mm alignment holes through the blank outside the board — one each side, ` +
      `on the flip line ${r3(separation)} mm apart — and register the second side on them.` +
      byEye,
  };
}

/**
 * The job with the two alignment holes added (#743 P-8): ordinary through drills of the offered
 * size, in the FIRST setup (where the board's through work is), assigned the way P-4b assigns a
 * hole — a drill of its size, or a flat that bores it. The job's own cutter is untouched: the
 * first program is still the board's isolation. A hole no owned cutter makes stays unassigned and
 * the job's own `hole-no-cutter` states it; the alignment hole is still worth drilling by hand.
 */
export function withAlignmentHoles(
  job: EngraveJob,
  holes: readonly { x: number; y: number }[],
  diameterMm: number,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[] = [],
): EngraveJob {
  if (holes.length === 0 || !(diameterMm > 0)) return job;
  const added = holes.map((at) => ({
    kind: 'drill' as const,
    id: newEngraveDrillId(),
    name: `⌀${Number(diameterMm.toFixed(3))} alignment hole`,
    position: { x: at.x, y: at.y },
    rotation: 0,
    depth: job.stock.thickness,
    enabled: true,
    through: true,
    mode: 'drill' as const,
    diameter: diameterMm,
  }));
  const assignment = pcbHoleAssignment(added, tools);
  const drills = added.map((d) => ({ ...d, mode: assignment.modes.get(d.id) ?? d.mode }));
  const cutter = pcbCutterPlan({ frames: [], drills, cutouts: [] }, tools, job.stock.thickness + job.breakthrough, catalogue);
  const setups = jobSetups(job);
  const first = setups[0];
  // A board's first setup is where its through work is; without one there is nothing to assign to,
  // and the press does nothing rather than invent a setup.
  if (first === undefined) return job;
  const written = withPcbCutters(first, cutter, drills.map((d) => d.id));
  return {
    ...job,
    drills: [...(job.drills ?? []), ...drills],
    setups: [written, ...setups.slice(1)],
  };
}
