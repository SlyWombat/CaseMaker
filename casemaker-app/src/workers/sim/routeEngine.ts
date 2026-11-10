/**
 * #928 — THE ONE PLACE the simulator decides which of the two sweep engines a load takes: the
 * COLUMN (dexel) engine or the EXACT (2.5D) sweeper. Extracted out of `session.ts:888`'s inline
 * condition so a thread/GRBL/rest-pass change cannot move a V badge off the column engine, or a
 * flat badge onto it, silently — the table below is the frozen contract, and a row has to change
 * for the routing to.
 *
 * The four axes a caller's `RouteEngineInput` carries are exactly the ones `session.ts`'s inline
 * condition read: the tool's shape, the timeline's rotary class, whether the exact sweeper would
 * call the job too dense (`isDenseForExactSweep`), and the seed kind a rest pass arrives with
 * (whether a prior removal is carried in). `flatCuttingRadiusOk` is folded in alongside density
 * because `denseFlatRoutesToColumn` only sends a GENUINE flat end mill to the column engine for a
 * dense job — a bull/ball nose is already caught by `toolShape` and never reaches that branch.
 *
 * This mirrors `sweepsOnColumn`/`denseFlatRoutesToColumn` (both still exported from `session.ts`
 * for `programSweep.ts` and the cutter-shape specs, which call them directly on a real `Tool` and
 * `Timeline`). A semantic change to either one has to land here too, in the same commit, with a
 * new or changed table row — that is the whole point of the fixture in `routeEngine.spec.ts`.
 */

/** `TimelineSummary.rotaryClass` (`@/engine/cnc/emulator/timeline`), read verbatim off the load. */
export type RouteRotaryClass = 'none' | 'indexed' | 'wrapped';

/** `Tool['shape']` (`@/engine/cnc/tool`), read verbatim off the tool. */
// #1053 — 'probe' is an instrument that never reaches the router (a probe is never a candidate);
// the member exists so a Tool's shape passes through without a cast.
export type RouteToolShape = 'flat' | 'ball' | 'tapered-ball' | 'engraving' | 'chamfer' | 'drill' | 'thread' | 'bull' | 'probe' | 'unknown';

export interface RouteEngineInput {
  /** The tool's `shape`. A cone (`'engraving'` or `'chamfer'`), a `'drill'`, a `'thread'` mill, a
   *  `'ball'` or a `'bull'` nose always sweeps on the column engine — none of them has the one
   *  flat cutting radius the exact sweeper's contract requires. */
  toolShape: RouteToolShape;
  /** `timeline.summary.rotaryClass`. `'wrapped'` always routes to the column engine: the tool
   *  follows a helix the exact 2.5D sweeper cannot represent. `'indexed'` and `'none'` do not,
   *  by themselves, route here — an indexed rotary job with a flat tool is an ordinary 2.5D cut
   *  per run on the exact sweeper. */
  rotaryClass: RouteRotaryClass;
  /** `isDenseForExactSweep(timeline)` — the timeline's checkpoint count crossed `MAX_CHECKPOINTS`,
   *  the point at which the exact sweeper would refuse the job `dense-3d-refused`. */
  isDenseForExactSweep: boolean;
  /** `cuttingRadiusForSweep(tool).ok` — true only for a genuine flat end mill (not a bull nose, not
   *  missing a usable cutting diameter). Only meaningful when `isDenseForExactSweep` is true; a
   *  non-flat tool has already routed on `toolShape` by the time this would matter. */
  flatCuttingRadiusOk: boolean;
  /** Whether this load carries a seed from a prior program's removal (`opts?.priorRemoval`). A
   *  dense flat job WITH a seed is a rest pass, and a rest pass cannot route to the column engine
   *  (it has no way to start from material a previous program left) — it stays on the exact
   *  sweeper and is refused there by name (`prior-removal-column`) rather than silently routed. */
  hasPriorRemoval: boolean;
}

/**
 * `routeEngine(input) === 'column'` is exactly `session.ts:888`'s old inline condition, read off
 * the four axes above instead of a live `Tool`/`Timeline`. `'exact'` is everything else.
 */
export function routeEngine(input: RouteEngineInput): 'column' | 'exact' {
  const isConeOrNoFlatRadius =
    input.toolShape === 'engraving' ||
    input.toolShape === 'chamfer' ||
    input.toolShape === 'drill' ||
    input.toolShape === 'thread' ||
    input.toolShape === 'ball' ||
    input.toolShape === 'bull';
  const denseFlatRoutesToColumn = input.isDenseForExactSweep && !input.hasPriorRemoval && input.flatCuttingRadiusOk;
  return input.rotaryClass === 'wrapped' || isConeOrNoFlatRadius || denseFlatRoutesToColumn ? 'column' : 'exact';
}
