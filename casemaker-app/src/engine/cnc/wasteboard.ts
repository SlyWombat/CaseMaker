/**
 * The machine's own wasteboard as a tracked sacrificial board (#417, decision Q7), and the warning
 * logic a run plan calls. The record lives on the machine in `location.json` (`wasteboard.rs`).
 *
 * FRAMES. Scars are rectangles in MACHINE XY (mm): the work origin moves with every job, so a scar in
 * one job's frame would be in the wrong place for the next. The caller converts a cut's footprint to
 * machine XY before checking or recording it.
 *
 * THE LIMIT IS A PARAMETER. How deep a cut may go into the board before it is warned about is a shop
 * default (`wasteboard.depthLimitMm`, `platform/defaultsClient.ts`), passed in — never a constant in
 * here (the "thresholds = setting + per-job recommendation" rule).
 */

import { z } from 'zod';

const filled = z.string().refine((v) => v.trim().length > 0, 'is empty');
const positive = z.number().finite().positive();

export const ScarSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: positive,
    height: positive,
    at: filled,
    jobId: z.string().nullable().default(null),
  })
  .strict();

export const WasteboardSchema = z
  .object({
    thickness: positive,
    thicknessSource: z.enum(['measured', 'chosen']),
    measuredAt: filled.nullable().default(null),
    lastResurfacedAt: z.string().nullable().default(null),
    // Capped, as `wasteboard.rs` caps it: a board this scarred wants resurfacing.
    scars: z.array(ScarSchema).max(500).default([]),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.thicknessSource === 'measured' && b.measuredAt === null) {
      ctx.addIssue({ code: 'custom', path: ['measuredAt'], message: 'a measured thickness says when it was measured' });
    }
  });

export type Scar = z.infer<typeof ScarSchema>;
export type Wasteboard = z.infer<typeof WasteboardSchema>;

/** An axis-aligned rectangle in machine XY, mm. */
export interface MachineRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WasteboardFinding =
  | { kind: 'no-board'; text: string }
  | { kind: 'beyond-limit'; depth: number; limit: number; text: string }
  | { kind: 'through-board'; depth: number; thickness: number; text: string }
  | { kind: 'crosses-scar'; scars: Scar[]; text: string };

function overlaps(a: MachineRect, b: MachineRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * What a job over `footprint` that goes `depthIntoBoard` mm into the wasteboard should be warned
 * about. The depth findings need the cut to reach the board; a scar under the footprint is reported
 * at any depth. Empty when there is nothing to say.
 */
export function wasteboardFindings(args: {
  board: Wasteboard | null;
  footprint: MachineRect;
  depthIntoBoard: number;
  limit: number;
}): WasteboardFinding[] {
  const { board, footprint, depthIntoBoard, limit } = args;
  const out: WasteboardFinding[] = [];
  const intoBoard = depthIntoBoard > 0;
  if (board === null) {
    if (intoBoard) {
      out.push({
        kind: 'no-board',
        text: `this cut goes ${fmt(depthIntoBoard)} mm into the wasteboard, and no wasteboard is recorded for this machine — record its thickness first`,
      });
    }
    return out;
  }
  if (intoBoard && depthIntoBoard >= board.thickness) {
    out.push({
      kind: 'through-board',
      depth: depthIntoBoard,
      thickness: board.thickness,
      text: `this cut goes ${fmt(depthIntoBoard)} mm down, through the ${fmt(board.thickness)} mm wasteboard into the bed`,
    });
  } else if (intoBoard && depthIntoBoard > limit) {
    out.push({
      kind: 'beyond-limit',
      depth: depthIntoBoard,
      limit,
      text: `this cut goes ${fmt(depthIntoBoard)} mm into the wasteboard, deeper than the ${fmt(limit)} mm limit`,
    });
  }
  // A scar under the job matters at ANY depth (#417 review): the stock may not sit flat on it, so
  // this is checked whether or not the cut reaches the board.
  const crossed = board.scars.filter((s) => overlaps(footprint, s));
  if (crossed.length > 0) {
    const from = crossed.map((s) => s.jobId ?? 'an earlier run');
    out.push({
      kind: 'crosses-scar',
      scars: crossed,
      text: `this job sits over ${crossed.length === 1 ? 'a scar' : `${crossed.length} scars`} on the wasteboard (from ${[...new Set(from)].join(', ')}) — the stock may not sit flat there`,
    });
  }
  return out;
}

/** A finished through-cut's footprint, recorded as a scar. */
export function recordScar(board: Wasteboard, rect: MachineRect, at: string, jobId: string | null): Wasteboard {
  return { ...board, scars: [...board.scars, { ...rect, at, jobId }] };
}

/** The board was resurfaced: the scars are gone, and the thickness is the new one. */
export function markResurfaced(
  board: Wasteboard,
  thickness: number,
  source: Wasteboard['thicknessSource'],
  at: string,
): Wasteboard {
  return {
    ...board,
    thickness,
    thicknessSource: source,
    measuredAt: source === 'measured' ? at : null,
    lastResurfacedAt: at,
    scars: [],
  };
}
