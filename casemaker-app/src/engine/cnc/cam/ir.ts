/**
 * The machine-independent toolpath IR (#172).
 *
 * This is the seam between CAM and the post-processor: it carries geometry and cutting
 * intent, and NOTHING about the machine's dialect. The post (#173) turns it into `.nc`; the
 * simulator (#182) sweeps it. Deliberately no G-code string appears in this directory —
 * every motion word is the post's to write, from these fully-resolved moves.
 *
 * Frame (the job frame IS the work frame, #200 decision 3):
 *   - Z = 0 is the stock's TOP face, so every cut is at negative Z and every retract at
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
  /** Feed moves only: Σ distance / f × 60, seconds. (See `estimateSeconds`.) */
  estimatedSeconds: number;
}

export interface ToolpathIR {
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
 * Estimated cutting time in seconds for one operation's moves: FEED moves only,
 * `Σ distance / f × 60`. Rapids are excluded — a rapid's rate is the controller's own seek
 * rate, which we do not know and the header does not carry (/Makera-Parity.md §11.2).
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
