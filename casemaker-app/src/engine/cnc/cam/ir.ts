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
   * The operation's CYCLE estimate in seconds — cutting PLUS rapids, every move through the
   * trapezoid (#242, #281), from `estimateCycleSeconds`. This is the one estimate the panel, the
   * run sheet and the post's `TIME` record all read, so they cannot disagree.
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
  /** Tool number, 1 for V1's single-tool jobs. Chosen by {@link toolNumberFor}. */
  toolNumber: number;
  spindleRpm: number;
  /**
   * The job wants its accessory output on: clear the chips while cutting. The post decides the
   * word, and on a Z1 that word is the VACUUM — bare `M331`/`M332` — because `M7`/`M9` are
   * answered `ok` and blow nothing on this controller (#283). The field keeps its name because it
   * is what the feeds table, the job schema and a saved job all call it.
   */
  air: boolean;
  /** Z the tool retracts to between operations and at the end, mm above the stock top (positive). */
  safeZ: number;
  /** Z for hops between loops inside one operation, mm above the stock top. */
  hopZ: number;
  operations: CamOperation[];
}

/**
 * The tool number a job's file carries, from the cutter's own — or a refusal (#191 review).
 *
 * `Tool.number` is a CUTTER number and a catalogue row can state `0`: the importer copies
 * `cutterNumber` as it stands, and `ToolSchema.number` is `int().nullable()`, so nothing on the
 * way in says no. `??` passed that 0 straight through, and the post would have written `T0 M6` —
 * and T0 is the Z1's PROBE slot. Our own file would then be one our own sweep reads as a
 * `probe-fitted-cut`, i.e. "foreign or broken", which is the right reading of that file and the
 * wrong file to have written.
 *
 * So the refusal is HERE, where the number is chosen, and not in the sweep: the sweep's job is to
 * report what a file says, and a file that cuts with a probe really is broken. A number that is
 * not a positive whole one cannot be posted either — `T1.5 M6` is not a station — so both are
 * refused together, by name, at generate.
 *
 * `null` is "the cutter states no number", which V1's single-tool jobs post as `T1`.
 */
export function toolNumberFor(tool: Tool): number {
  const n = tool.number;
  if (n === null) return 1;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `a tool number of ${n} is not usable: T0 is the Z1's probe slot, so the cutter's station has to be T1 or higher, and a station is a whole number`,
    );
  }
  return n;
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
 * Estimated CUTTING time in seconds for one operation's moves, as the closed-form sum:
 * FEED moves only, `Σ distance / f × 60`, with no acceleration term. This is the cutting
 * COMPONENT of the cycle estimate (`estimateCycleSeconds`); #242's single number is the cycle
 * estimate, not this one, and since #281 the two are no longer in fixed ratio — the cycle
 * estimate times the same feeds through the trapezoid, so it exceeds this sum by the feed RUNS'
 * accelerate/decelerate terms and by the rapids this one excludes.
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
 * The rapid model a cycle estimate times rapids with, and the acceleration it times every move
 * through (#281).
 *
 * ESTIMATE ONLY. Nothing here is ever commanded: a rapid carries no `F` in the file (#184) and the
 * post must never put one on a `G0` (`/Makera-Parity.md` §11.2), so this is NOT a `maxRapid` and no
 * reader may take it as a ceiling to clamp to — {@link MillProfile.maxCutFeed} is the one field
 * that limits the program, and it limits CUTTING moves alone.
 *
 * The three numbers are the controller's own configuration, read over `config-get sd` on
 * 2026-10-07 (X/Y `alpha_max_rate` 1200, Z `gamma_max_rate` 600, `acceleration` 150 mm/s²),
 * bracketed by one stopwatch sample of an 88.4 mm X-only rapid on 2026-10-08 that came in at
 * 1060–1360 mm/min — consistent with the config and NOT a measurement of the machine. `#208 D3`, a
 * timed air run, is the end-to-end check that closes it. It does not compare one total against one
 * number: feeds are timed per run and rapids per move ({@link estimateCycleSeconds}), so D3 times
 * the two PORTIONS separately — an air run for the rapids, a cutting run for the feeds — and each
 * one's error is visible on its own (#281).
 */
export interface RapidEstimate {
  /** A rapid moving in X and/or Y, mm/min: the controller's own X/Y ceiling. */
  xyMmPerMin: number;
  /** A rapid moving in Z ALONE, mm/min: the controller's Z ceiling, half the X/Y one. */
  zMmPerMin: number;
  /** Acceleration, mm/s², applied to every timed move — rapid and feed alike. */
  accelMmPerS2: number;
  /** Where those numbers came from, in words, for the panel and the run sheet to quote. */
  source: string;
}

/**
 * The rate a rapid moving `(dx, dy, dz)` is timed at: Z's own ceiling when it moves in Z alone,
 * otherwise the X/Y one. The ONE place that choice is made, so the estimate and the drawn clock
 * cannot disagree about which ceiling a given rapid is under.
 *
 * A rapid that moves in Z AS WELL AS in X/Y is timed at the X/Y rate over its whole 3D length, so
 * its Z leg is charged at twice the rate the controller gives a Z-only move. The estimate never
 * presents one: a stroke hops in TWO moves — a Z-only retract to `HOP_Z` at the end of one stroke,
 * then an XY-only traverse to the next stroke's start — and `engraveJob` and `drill` hop the same
 * way, so the only rapid that leaves any generator with all three axes moving is an operation's
 * ENTRY move, the previous operation's `safeZ` down to this operation's first start at `HOP_Z`.
 * That is the FIRST move of its operation, which `estimateCycleSeconds` skips (the IR carries no
 * start point), so the estimate times no combined rapid at all and the inter-operation travel is
 * left UNPRICED — the error is a move missing, not a leg over-charged. The drawn clock walks every
 * move whose endpoints it knows and does time that rapid; the rule below is what the two share
 * (#281).
 */
export function rapidRate(rapid: RapidEstimate, dx: number, dy: number, dz: number): number {
  return dx === 0 && dy === 0 && dz !== 0 ? rapid.zMmPerMin : rapid.xyMmPerMin;
}

/**
 * Seconds `distance` mm takes at `rate` mm/min through the trapezoid: the move accelerates to the
 * rate and decelerates back to a stop, so it is `d/v + v/a` when it is long enough to reach `v`
 * and `2·√(d/a)` when it is not (#281). `accel` is mm/s².
 *
 * ONE function for every timed move — the estimate here and the simulation's drawn clock
 * (`workers/sim/session.ts`) both call it, so the printed figure and the transport cannot time the
 * same move two ways. A non-positive rate, acceleration or distance times nothing (0 s): that is
 * the same rule a move with an unknown start or end already gets, and it is what the transport's
 * no-machine session falls back to rather than inventing a rate (#367).
 */
export function moveSeconds(distance: number, rate: number, accel: number): number {
  if (!(rate > 0) || !(accel > 0) || !(distance > 0)) return 0;
  const v = rate / 60; // mm/s
  return distance >= (v * v) / accel ? distance / v + v / accel : 2 * Math.sqrt(distance / accel);
}

/**
 * Estimated CYCLE time in seconds for one operation's moves — cutting PLUS rapids, timed through
 * the trapezoid (#242, #281). This is THE one estimate: the Engrave panel's row and the run sheet
 * read the `estimatedSeconds` this populates, and `postZ1` writes its program-wide sum into
 * `;@MKR|TIME`, so all three come from this function and cannot disagree.
 *
 * CUTTING IS TIMED PER RUN, rapids per move (#281, the review of 62fa025). A run is a maximal
 * stretch of consecutive feed moves at the same `f` with no rapid between them, and its trapezoid
 * is charged once, on the sum of its segments. The controller does not stop at every junction —
 * Smoothieware's planner carries speed across one, which is what `junction_deviation` in its config
 * is for — and this app cuts a pocket in 0.05 mm chords, so a triangle on each chord times the
 * machine as if it had no look-ahead at all: it read the default job's 14 318 chords as 973 s of
 * cutting, against the 539 s this run model gives and the 527 s the same feeds sum to with no
 * acceleration at all. Those three numbers are the argument — the run model's 12 s over the closed
 * form is the 304 runs' ramps, which is what a machine with look-ahead actually pays, where the
 * extra 446 s was an artefact of charging every chord for a stop it never makes. The model holds
 * only for GENTLE junctions: the speed the planner carries across one is `junction_deviation`'s,
 * set by the ANGLE between the two cuts — near the run's rate on near-straight chords, less at a
 * corner, zero at a full reversal — so a run that turns sharply is charged optimistically, since
 * one trapezoid per run has no corner in it. A rapid is a stop at each end by construction, so each
 * gets its own trapezoid.
 *
 * A feed is timed at its own `f`; a rapid at `rapidRate` of the machine the job is for. `rapid` is
 * REQUIRED and there is no default: the machine is the caller's to name (#347), a second mill
 * brings its own numbers, and a default would be a second source for a number this file exists to
 * keep single. As in `estimateSeconds`, the first move contributes nothing — the IR does not carry
 * the start point, and a run begins with a rapid in practice.
 */
export function estimateCycleSeconds(moves: readonly CamMove[], rapid: RapidEstimate): number {
  let seconds = 0;
  let previous: CamMove | null = null;
  /** The feed run being accumulated — its `f` and the running length of its segments. */
  let run: { f: number; length: number } | null = null;
  const endRun = (): void => {
    if (run !== null) {
      seconds += moveSeconds(run.length, run.f, rapid.accelMmPerS2);
      run = null;
    }
  };
  for (const move of moves) {
    if (previous === null) {
      previous = move;
      continue;
    }
    const dx = move.x - previous.x;
    const dy = move.y - previous.y;
    const dz = move.z - previous.z;
    const distance = Math.hypot(dx, dy, dz);
    if (move.kind === 'feed') {
      if (run !== null && run.f === move.f) {
        run.length += distance;
      } else {
        endRun();
        run = { f: move.f, length: distance };
      }
    } else {
      endRun();
      seconds += moveSeconds(distance, rapidRate(rapid, dx, dy, dz), rapid.accelMmPerS2);
    }
    previous = move;
  }
  endRun();
  return seconds;
}

/**
 * The whole-program cycle estimate: every operation's `estimateCycleSeconds`, summed (#242).
 * The post writes `Math.round` of this into `TIME`, and `CamOperation.estimatedSeconds` for
 * each operation is the same function, so the panel, the sheet and the header agree.
 */
export function estimateIRCycleSeconds(ir: ToolpathIR, rapid: RapidEstimate): number {
  return ir.operations.reduce((s, op) => s + estimateCycleSeconds(op.moves, rapid), 0);
}

/** The machine state two IRs must share for their moves to belong to one program. */
const SHARED_HEADER = ['frame', 'toolNumber', 'spindleRpm', 'air', 'safeZ', 'hopZ'] as const;

/** Throw unless `a` and `b` describe the same machine state — see `concatToolpathIR`. */
function assertSameMachine(a: ToolpathIR, b: ToolpathIR): void {
  for (const key of SHARED_HEADER) {
    if (a[key] !== b[key]) {
      throw new Error(
        `concatToolpathIR: the two toolpaths disagree on ${key} (${String(a[key])} vs ${String(b[key])})`,
      );
    }
  }
  // The cutter is a flat record of scalars, so its JSON is a faithful identity; the reference
  // check first keeps the common case — the same `Tool` object passed to both CAM calls — cheap.
  if (a.tool !== b.tool && JSON.stringify(a.tool) !== JSON.stringify(b.tool)) {
    throw new Error('concatToolpathIR: the two toolpaths were cut with different tools');
  }
}

/**
 * Two IRs as ONE program, operations renumbered from 1 (#219/#287).
 *
 * The CAM is two modules with two entry points: `generateEngrave` builds the region operations
 * (pockets and drills) and `generateTrace` builds the single-line traces. Each numbers its
 * operations from 1 because each is usable alone (`cam/trace.ts` states that contract), but the
 * program the machine runs is ONE list, so the caller that runs both — the worker
 * `engraveGenerate` — joins them here rather than either module knowing the other exists. The
 * renumbering keeps the merge honest about `CamOperation.number`'s own "1-based, in cutting order"
 * contract; the post renumbers positionally regardless, so a naive concat would not change today's
 * `.nc`, it would just leave an IR that lies about itself.
 *
 * The two IRs must describe the same machine state, or the moves of one would be posted under the
 * other's spindle or safe height and the difference would be silent: the frame, tool, tool
 * number, spindle, air, safe height and hop height are asserted equal, and a mismatch THROWS
 * rather than picking a winner. Operations are joined in the order given — the CALLER decides
 * what runs first, because that is a scheduling decision (a drill before a cut-out, #220), not a
 * property of the move list.
 *
 * `b` with no operations (a job with no traces, #287) yields `a`'s operations unchanged: the
 * renumbering is then a no-op, so such a job's `.nc` stays byte-identical to the one-module one.
 */
export function concatToolpathIR(a: ToolpathIR, b: ToolpathIR): ToolpathIR {
  assertSameMachine(a, b);
  const operations = [...a.operations, ...b.operations].map((op, index) => ({ ...op, number: index + 1 }));
  return { ...a, operations };
}
