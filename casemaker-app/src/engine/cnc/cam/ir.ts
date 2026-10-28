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
 *   - No `A` axis on a FLAT IR. A rotary IR (#240, `/Rotary.md` R5) carries `a` on every move;
 *     the flat post refuses a move that has one, and the rotary post refuses one that has not.
 */

import type { Tool } from '../tool';

/**
 * One straight move, every axis resolved (#240 for `a`).
 *
 * `a` is the rotary axis in DEGREES, unwound — it may run past ±360 across a job, and the post
 * writes it as a Float64 with no modulo (`/Rotary.md` R5, R8). It is `undefined` on every flat
 * IR, and REQUIRED on every move of a rotary IR: the rotary post refuses a rotary move without
 * one rather than inventing a position. The `?` is what keeps existing flat IR construction
 * sites — and the round trip of every pre-#240 document — byte-compatible.
 */
export type CamMove =
  | {
      kind: 'rapid';
      x: number;
      y: number;
      z: number;
      a?: number;
      /**
       * #727 F4 — a DRILL's chip-clear retract, at the hole it is already cutting. It is a full
       * retract only in the drill's own sense (out to the hop to clear chips), never travel: the
       * raise over a mount leaves it where the drill put it, or every peck would climb to the
       * clamp height and back (time on a hole the clamps never reach).
       */
      peck?: boolean;
    }
  | { kind: 'feed'; x: number; y: number; z: number; f: number; a?: number };

/**
 * #250 — which pass of an item's cut this operation is. `rough` leaves the finish allowance
 * behind; `finish` cuts the ideal region at full depth. `through` is #218's full-depth profile /
 * cut-out pass (J31's semantics, kept in the shared union so both issues land on one definition);
 * it is not emitted by the pocket/engrave CAM and is not a pass of a rough/finish pair.
 *
 * OPTIONAL on the operation, because every pre-#250 operation — a drill, a trace, a thread, a
 * one-pass pocket — is neither: absence means "the document did not split this cut into passes",
 * and the post, the sheet and the sweep keep their old reading.
 */
export type CamPassKind = 'rough' | 'finish' | 'through';

export interface CamOperation {
  /** 1-based, in cutting order. Becomes the `;@MKR|TOOLPATH|number=` line. */
  number: number;
  /** `[T1]Engrave "CASE" 2.0mm` — becomes the `TOOLPATH` name. */
  name: string;
  /** The label this operation cuts (#200). */
  labelId: string;
  /** Positive mm. */
  depth: number;
  /**
   * #250 — `rough` or `finish` when the item was split into a roughing and a finishing pass;
   * absent on every operation that is not part of such a pair (see {@link CamPassKind}).
   */
  passKind?: CamPassKind;
  /**
   * #735 — how many DEPTH PASSES this operation makes: one per descent to a new cutting depth. A
   * level's cleanup laps are part of its pass; the chords of a helix are NOT passes. Declared by
   * every CAM that can be read wrongly by counting distinct feed Z values — a bore or a thread
   * helix changes Z on every chord, and a helical climb repeats a depth at each radial pass.
   *
   * Absent on an operation whose depth levels are its feed Z values (a pocket, a profile, a
   * chamfer, the surface relief), where the summary counts those levels; absent and
   * {@link passStepMm} absent together, always.
   */
  depthPasses?: number;
  /**
   * #735 — the descent one of this operation's depth passes took, mm (positive): a bore's helix
   * pitch, a drill's peck, a profile's (possibly halved) step-down, a thread's pitch. Present
   * exactly when {@link depthPasses} is.
   */
  passStepMm?: number;
  moves: CamMove[];
  /**
   * The operation's CYCLE estimate in seconds — cutting PLUS rapids, every move through the
   * trapezoid (#242, #281), from `estimateCycleSeconds`. This is the one estimate the panel, the
   * run sheet and the post's `TIME` record all read, so they cannot disagree.
   */
  estimatedSeconds: number;
}

/**
 * #735 — one step-down and the depth passes a program ran at it, mm. The run sheet prints a single
 * "N × s mm passes" when there is one entry and names each step when there is more than one: a
 * program's cut-out slot runs at the profile row's halved step-down, and printing the feeds row's
 * number beside the combined count was true for only some of the passes (j01's "33 × 0.5 mm").
 */
export interface CamPassStep {
  /** The descent one pass took, mm. */
  stepMm: number;
  /** How many of the program's depth passes descended by `stepMm`. */
  passes: number;
}

/** #735 — what an operation declares about its depth passes (see `CamOperation.depthPasses`). */
export interface CamDepthPasses {
  depthPasses: number;
  passStepMm: number;
}

export interface ToolpathIR {
  /**
   * The work frame this IR's moves are written in (#237, `/Rotary.md` §3.3, §3.8).
   *
   * `'flat'` is the frame this file's header documents: Z = 0 on the stock's top face, cuts
   * negative, X/Y the work-frame stock coordinates. `'rotary'` is the 4th axis's own frame —
   * origin on the rotary axis, Z = radial distance above it, Y ≡ 0, X along the axis
   * (`/Rotary.md` R6). A rotary IR needs {@link rotary} and an `a` on every move; the post
   * refuses one that is missing either, and refuses a rotary IR at the flat post entirely.
   */
  frame: 'flat' | 'rotary';
  /**
   * #240 — the round stock a rotary IR cuts, mm. Present exactly when `frame === 'rotary'`;
   * absent on every flat IR, so flat construction is unchanged. `radius` is the stock's own
   * radius (`diameter / 2`), which is the Z of the stock's surface on the axis frame: it is
   * what the sweep and the run sheet need to read a Z back as a radial depth.
   */
  rotary?: { radius: number };
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
  /**
   * #487 — how the region operations' loops were ordered, and what the ordering bought. Present
   * only on an IR whose region CAM actually placed loops; absent on a trace- or drill-only IR
   * (nothing to order) and on a rotary IR. `concatToolpathIR` keeps the FIRST IR's report, which
   * is the region one — the traces appended after it are unchanged by the ordering.
   */
  ordering?: OrderingReport;
}

/**
 * The CAM's own account of its loop ordering (#487).
 *
 * `rapidMm` and `baselineRapidMm` are the same program under the two orders, both measured as the
 * XY distance the tool travels in rapid moves across the region operations — so the difference is
 * the air the ordering saved, and the run sheet prints it rather than asking the operator to
 * trust that "optimised" means faster.
 */
export interface OrderingReport {
  /**
   * `'proximity'`: rings innermost first, with the contours of each ring visited in a
   * nearest-neighbour tour refined by 2-opt, and each contour taken to its full depth before the
   * next is entered. `'document'`: a level at a time across the region, contours in the order the
   * offset emitted them — the pre-#487 order, kept for the before/after number.
   */
  order: 'proximity' | 'document';
  /** XY rapid travel of the REGION operations under this order, mm. */
  rapidMm: number;
  /** The same travel under the pre-#487 order, on the same job, mm. */
  baselineRapidMm: number;
  /** XY cutting travel of the region operations, mm — the same under either order. */
  cutMm: number;
}

/** XY travel of a move list, split into rapid and cutting, mm (#487's own measure). */
export interface TravelStats {
  rapidMm: number;
  cutMm: number;
}

/**
 * The XY distance a move list spends in the air and in the cut, mm.
 *
 * Only XY is counted: a retract is the same height whichever loop follows it, so the figure the
 * ordering can move is the horizontal one. The FIRST move is not charged — the IR does not carry
 * the position the program starts from (the same reason `estimateCycleSeconds` skips it), and
 * the ledger the issue prints was measured from the G-code the same way.
 */
export function travelStats(moves: readonly CamMove[]): TravelStats {
  let rapidMm = 0;
  let cutMm = 0;
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]!;
    const b = moves[i]!;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    if (b.kind === 'rapid') rapidMm += distance;
    else cutMm += distance;
  }
  return { rapidMm, cutMm };
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
 * #710 — the travel height a program on a mount needs, mm above the stock's top: the tallest
 * clamp or arm that stands above it, plus the mount's FIT and the fixture clearance. `null` when
 * nothing stands above the stock (a vise, tape, or a bracket whose arms sit below a taller blank's
 * top) — and then the CAM's own `HOP_Z`/`SAFE_Z` stand.
 *
 * #727 F3 — THE FIT IS PART OF THE CLEARANCE. The verifier compares a move with the obstacle's top
 * grown by the mount's fit (`mounts/inPath.ts`, `topZ + uncertainty`: where the clamp MAY be), so a
 * raise that stopped at `topZ + clearance` came out BELOW the verifier's own top whenever the fit
 * was wider than the clearance (the schema allows a 0 clearance and a 2 mm fit) — every raised
 * rapid was then refused by the check it was raised for. The height now clears the top it may be.
 *
 * The design makes this the PROGRAM's height rather than a per-move clearance
 * (`docs/design/bed-mounts-flow.md` §3.7): a bracket job's hops and retracts run above the clamps,
 * so a clamp cannot be hit by ordinary travel at all, and a rapid that still passes below a
 * clamp's top is refused as a cutting move is.
 */
export function travelHeightOver(
  obstacles: readonly { topZ: number }[],
  clearanceMm: number,
  uncertaintyMm = 0,
): number | null {
  if (obstacles.length === 0) return null;
  const tallest = Math.max(...obstacles.map((o) => o.topZ));
  if (!(tallest > 0)) return null;
  const clearance = Number.isFinite(clearanceMm) ? Math.max(0, clearanceMm) : 0;
  const uncertainty = Number.isFinite(uncertaintyMm) ? Math.max(0, uncertaintyMm) : 0;
  return Math.round((tallest + uncertainty + clearance) * 1000) / 1000;
}

/**
 * #710 — the same IR with every TRAVEL rapid raised to `travelZ` when that is higher than the
 * CAM's own floors, and its `safeZ`/`hopZ` carried with them so the post and the verifier judge
 * one height.
 *
 * "Travel rapid" is exact, not a guess: the CAM's own `HOP_Z` hops, its `SAFE_Z` retracts, and the
 * hop a fitted surface already lifted to (`ir.hopZ`). A drill's PECK retract stands at its own
 * depth-plus-clearance and is NOT travel — raising it would turn every peck into a full retract —
 * so it is left exactly where the drill put it.
 */
export function raiseTravelOver(ir: ToolpathIR, travelZ: number | null, rapid?: RapidEstimate): ToolpathIR {
  if (travelZ === null) return ir;
  const travel = Math.round(travelZ * 1000) / 1000;
  const hopNow = Math.round(ir.hopZ * 1000) / 1000;
  if (travel <= Math.max(hopNow, ir.safeZ)) return ir;
  const at = (z: number): number => Math.round(z * 1000) / 1000;
  const travelHeights = new Set([HOP_Z, SAFE_Z, hopNow]);
  const raise = (m: CamMove): CamMove =>
    m.kind === 'rapid' && m.peck !== true && at(m.z) < travel && travelHeights.has(at(m.z))
      ? { ...m, z: travel }
      : m;
  return {
    ...ir,
    safeZ: Math.max(ir.safeZ, travel),
    hopZ: Math.max(hopNow, travel),
    // The Z travel a raised rapid adds is real time: a caller with the machine's rapid model gets
    // the operation's estimate recomputed, so the panel's cycle figure counts the climb.
    operations: ir.operations.map((op) => {
      const moves = op.moves.map(raise);
      return rapid === undefined ? { ...op, moves } : { ...op, moves, estimatedSeconds: estimateCycleSeconds(moves, rapid) };
    }),
  };
}

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
 * The corner angle, in degrees, past which the planner (near-)stops instead of carrying the run's
 * speed across a junction (#657). Below it two feed segments read as one straight stretch — the
 * pocket's collinear chords, which #281 protects, carry their speed across — and at or past it the
 * run ends and the next segment pays its own trapezoid.
 *
 * Tuned against the 2026-10-25 badge cut: at the catalogue's F1000 the per-run model printed 165 s
 * and the machine ran ~255 s (its short V-carve strokes never reach 1000 mm/min); carrying speed
 * across corners up to this angle and stopping past it reads 249 s on that same program. The value
 * is a planning constant, not a measurement — it stands in for the `junction_deviation` the
 * controller's config would state and that the estimate has no read of.
 */
export const JUNCTION_CORNER_DEG = 10;
const JUNCTION_COS = Math.cos((JUNCTION_CORNER_DEG * Math.PI) / 180);

/**
 * Estimated CYCLE time in seconds for one operation's moves — cutting PLUS rapids, timed through
 * the trapezoid (#242, #281). This is THE one estimate: the Engrave panel's row and the run sheet
 * read the `estimatedSeconds` this populates, and `postZ1` writes its program-wide sum into
 * `;@MKR|TIME`, so all three come from this function and cannot disagree.
 *
 * WHAT IT IS NOT. It times the MOVES of the program at the commanded feeds and the machine's rapid
 * model, and nothing else: no spindle spin-up, no tool change, no probing or operator time, and the
 * junctions are the constant below rather than the controller's real `junction_deviation`. A
 * wall-clock figure quoted for "the same job" is comparable only when its path and machine
 * constants are known — the bench set's j02 is the recorded example (2.0 min here against a 7-10
 * min source; the source's band at F500 implies 4.4-6.3x this program's 792 mm of cutting, #735
 * item 4), not like-for-like.
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
 * corner, zero at a full reversal. #657 — so a run now ENDS at a corner past {@link
 * JUNCTION_CORNER_DEG} and the next segment pays its own trapezoid, because an engraving's short
 * strokes never reach the commanded feed: the badge's first cut ran ~255 s against the 165 s this
 * per-run model printed at the catalogue's F1000, and charging the corners is what closes that
 * gap. A rapid is a stop at each end by construction, so each gets its own trapezoid.
 *
 * A feed is timed at its own `f`; a rapid at `rapidRate` of the machine the job is for. `rapid` is
 * REQUIRED and there is no default: the machine is the caller's to name (#347), a second mill
 * brings its own numbers, and a default would be a second source for a number this file exists to
 * keep single. As in `estimateSeconds`, the first move contributes nothing — the IR does not carry
 * the start point, and a run begins with a rapid in practice.
 *
 * ROTARY (#240): pass the stock radius and the A axis joins the in-plane travel — `dy` becomes the
 * ARC `Δa·π/180·R`, so a feed that turns the stock a full turn is timed as the 62.8 mm it travels
 * at the surface rather than as a stationary move, and the junction direction reads the same
 * (X, arc) plane the flat model reads as (X, Y). Omitting it keeps the flat path byte-identical.
 */
export function estimateCycleSeconds(
  moves: readonly CamMove[],
  rapid: RapidEstimate,
  rotaryRadius?: number,
): number {
  let seconds = 0;
  let previous: CamMove | null = null;
  /** The feed run being accumulated — its `f`, the running length, and the direction of its last XY segment. */
  let run: { f: number; length: number; ux: number; uy: number } | null = null;
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
    const dy =
      rotaryRadius === undefined
        ? move.y - previous.y
        : (((move.a ?? 0) - (previous.a ?? 0)) * Math.PI * rotaryRadius) / 180;
    const dz = move.z - previous.z;
    const distance = Math.hypot(dx, dy, dz);
    if (move.kind === 'feed') {
      const xy = Math.hypot(dx, dy);
      // A pure-Z feed (a plunge) carries no XY direction: it accumulates at its own `f` (the feed
      // change already split it) and the next XY segment starts the direction afresh.
      const carriesDirection = xy > 1e-9;
      if (run !== null && run.f === move.f) {
        if (carriesDirection) {
          const ux = dx / xy;
          const uy = dy / xy;
          const hasDirection = run.ux !== 0 || run.uy !== 0;
          if (!hasDirection || ux * run.ux + uy * run.uy >= JUNCTION_COS) {
            run.length += distance;
            run.ux = ux;
            run.uy = uy;
          } else {
            endRun();
            run = { f: move.f, length: distance, ux, uy };
          }
        } else {
          run.length += distance;
        }
      } else {
        endRun();
        run = { f: move.f, length: distance, ux: carriesDirection ? dx / xy : 0, uy: carriesDirection ? dy / xy : 0 };
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
  return ir.operations.reduce(
    (s, op) => s + estimateCycleSeconds(op.moves, rapid, ir.rotary?.radius),
    0,
  );
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
  // #240 — the round stock belongs to the frame: two rotary IRs may only be joined when they cut
  // the same diameter, or the radius one of them carries would be wrong for the other's moves.
  if (a.rotary?.radius !== b.rotary?.radius) {
    throw new Error(
      `concatToolpathIR: the two toolpaths disagree on the rotary stock radius (${String(a.rotary?.radius)} vs ${String(b.rotary?.radius)})`,
    );
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
