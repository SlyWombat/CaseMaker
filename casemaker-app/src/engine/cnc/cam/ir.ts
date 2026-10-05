/**
 * The machine-independent toolpath IR (#172).
 *
 * This is the seam between CAM and the post-processor: it carries geometry and cutting
 * intent, and NOTHING about the machine's dialect. The post (#173) turns it into `.nc`; the
 * simulator (#182) sweeps it. Deliberately no G-code string appears in this directory —
 * every motion word is the post's to write, from these fully-resolved moves.
 *
 * Frame (the job frame IS the work frame, #200 decision 3):
 *   - `ToolpathIR.frame` names the frame explicitly (#237). It is `'flat'` for today's 3-axis
 *     jobs — Z = 0 is the stock's TOP face, so every cut is at negative Z and every retract at
 *     positive Z. `depth` on an operation is a POSITIVE mm, as its document stores it.
 *   - X/Y are the work-frame stock coordinates (front-left at the origin).
 *
 * Shape of a move: EVERY axis is resolved in the IR, including the ones a given move does
 * not change, so the post only ever omits words (#187 item 3). A rapid carries no `f`; a
 * feed carries its feedrate on every record.
 *
 * Assumptions recorded here so they can be revisited (see the file header of
 * `engraveJob.ts` for how the moves are produced):
 *   - No arcs. The IR is linear; only straight moves exist to post (#172 "Do not add arcs").
 *   - No `A` axis. Adding one to a move record later is one line, and adding it now is a
 *     field nobody tests (/Fabrication.md §9.1, decisions 3/11).
 */

import type { Tool } from '../tool';

export type CamMove =
  | { kind: 'rapid'; x: number; y: number; z: number }
  | { kind: 'feed'; x: number; y: number; z: number; f: number };

export interface CamOperation {
  /** 1-based, in cutting order. Becomes the `;@MKR|TOOLPATH|number=` line. */
  number: number;
  /** `[T1]Engrave "CASE" 2.0mm` — becomes the `TOOLPATH` name. */
  name: string;
  /** The label this operation cuts (#200). */
  labelId: string;
  /** Positive mm. */
  depth: number;
  moves: CamMove[];
  /**
   * The operation's CYCLE estimate in seconds — cutting PLUS rapids at `ASSUMED_RAPID_MM_MIN`
   * (#242), from `estimateCycleSeconds`. This is the one estimate the panel, the run sheet and
   * the post's `TIME` record all read, so they cannot disagree.
   */
  estimatedSeconds: number;
}

export interface ToolpathIR {
  /**
   * The work frame this IR's moves are written in (#237, `/Rotary.md` §3.3, §3.8).
   *
   * `'flat'` is the frame this file's header documents: Z = 0 on the stock's top face, cuts
   * negative, X/Y the work-frame stock coordinates. `'rotary'` is the 4th axis's own frame —
   * origin on the rotary axis, Z = radial distance above it, Y ≡ 0, X along the axis
   * (`/Rotary.md` R6). Nothing emits a rotary IR yet: R-0 is a type reservation, so a later
   * rotary IR cannot flow through the flat post unnoticed (#237). There is deliberately no
   * `a` on the moves — that is R-3 (decision R5).
   */
  frame: 'flat' | 'rotary';
  /** The cutter, as the `.nc` header describes it (#182, `/Simulation.md` §6). */
  tool: Tool;
  /** Tool number, 1 for V1's single-tool jobs. */
  toolNumber: number;
  spindleRpm: number;
  /** Airflow (the machine's air output; the post decides the word). */
  air: boolean;
  /** Z the tool retracts to between operations and at the end, mm above the stock top (positive). */
  safeZ: number;
  /** Z for hops between loops inside one operation, mm above the stock top. */
  hopZ: number;
  operations: CamOperation[];
}

/**
 * SAFE_Z is the inter-operation retract height, HOP_Z the intra-operation hop height, both
 * measured above the stock top (positive, work Z).
 *
 * OURS, not Makera's: `Z1/TopClamp.nc` hops at `Z3` and ends at `Z15`. We pick 1 mm for the
 * hop (clear of the stock and any clamp we know about) and 5 mm for the safe retract (clear
 * of the vise jaws by a comfortable margin on the 12 mm default stock). Named constants so
 * the choice is in one place; `/Fabrication.md` §7.6 owns the collision geometry that would
 * justify changing them.
 */
export const SAFE_Z = 5;
export const HOP_Z = 1;

/**
 * Estimated CUTTING time in seconds for one operation's moves: FEED moves only,
 * `Σ distance / f × 60`. Rapids are excluded — a rapid's rate is the controller's own seek
 * rate, which we do not know and the header does not carry (/Makera-Parity.md §11.2). This is
 * the cutting COMPONENT of the cycle estimate (`estimateCycleSeconds`); #242's single number is
 * the cycle estimate, not this one.
 *
 * Distance is the full 3D length to the move's endpoint, so a plunge counts its Z travel.
 * The first move contributes nothing if it is a feed (no prior point); runs of moves always
 * begin with a rapid in practice.
 */
export function estimateSeconds(moves: readonly CamMove[]): number {
  let seconds = 0;
  let previous: CamMove | null = null;
  for (const move of moves) {
    if (move.kind === 'feed' && previous !== null) {
      const dx = move.x - previous.x;
      const dy = move.y - previous.y;
      const dz = move.z - previous.z;
      seconds += (Math.hypot(dx, dy, dz) / move.f) * 60;
    }
    previous = move;
  }
  return seconds;
}

/**
 * The assumed RAPID rate for the cycle estimate, mm/min (#242).
 *
 * A rapid carries no `f` in the file (#184) and the controller's real seek rate is not ours to
 * state, so this is a labelled ESTIMATE assumption — NOT a `maxRapid` the post would ever
 * command (/Makera-Parity.md §11.2 refuses an `F` on a `G0`). It is the same number the
 * transport draws rapids at (`DISPLAY_RAPID_MM_MIN` in `workers/sim/session.ts`, which now
 * imports this constant), so the drawn clock and the printed estimate assume one rate.
 *
 * PROVISIONAL — this is the display constant, not a measurement of the machine. `#208 D3`
 * times an air run and replaces it; source: /Makera-Parity.md §14.2 A1.
 */
export const ASSUMED_RAPID_MM_MIN = 3000;

/**
 * Estimated CYCLE time in seconds for one operation's moves — cutting PLUS rapids at one named
 * rate (#242). This is THE one estimate: the Engrave panel's row and the run sheet read the
 * `estimatedSeconds` this populates, and `postZ1` writes its program-wide sum into
 * `;@MKR|TIME`, so all three come from this function and cannot disagree.
 *
 * A feed is timed at its own `f`; a rapid at `rapidMmPerMin` (the assumption, stated where the
 * number is shown). As in `estimateSeconds`, the first move contributes nothing — the IR does
 * not carry the start point, and a run begins with a rapid in practice.
 */
export function estimateCycleSeconds(moves: readonly CamMove[], rapidMmPerMin: number = ASSUMED_RAPID_MM_MIN): number {
  let seconds = 0;
  let previous: CamMove | null = null;
  for (const move of moves) {
    if (previous !== null) {
      const dx = move.x - previous.x;
      const dy = move.y - previous.y;
      const dz = move.z - previous.z;
      const rate = move.kind === 'feed' ? move.f : rapidMmPerMin;
      if (rate > 0) seconds += (Math.hypot(dx, dy, dz) / rate) * 60;
    }
    previous = move;
  }
  return seconds;
}

/**
 * The whole-program cycle estimate: every operation's `estimateCycleSeconds`, summed (#242).
 * The post writes `Math.round` of this into `TIME`, and `CamOperation.estimatedSeconds` for
 * each operation is the same function, so the panel, the sheet and the header agree.
 */
export function estimateIRCycleSeconds(ir: ToolpathIR, rapidMmPerMin: number = ASSUMED_RAPID_MM_MIN): number {
  return ir.operations.reduce((s, op) => s + estimateCycleSeconds(op.moves, rapidMmPerMin), 0);
}
