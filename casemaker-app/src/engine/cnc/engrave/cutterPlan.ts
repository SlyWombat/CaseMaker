/**
 * #762 — WHAT EACH ITEM IS — and, since #766, the KIND-CHECK and reach rules the measured search
 * uses to generate candidate plans.
 *
 * #766 made the CHOICE a simulation (`smartPick` + slice A): a plan is judged by what it would cut,
 * not by a proxy. This module's `kindedWork` and `materialRefusal` still answer the question a
 * candidate must pass before it is worth simulating, and `planCutters` remains the kind-shaped
 * baseline candidate and the panel/legacy path where no evaluator is bound. The auto-pick surfaces
 * (the CLI's no-cutter path and the Design panel) call the search.
 *
 * `roughPick`/`restToolPick` rank cutters by the AREA of the 2D design each one reaches. That is
 * the right rule for the flat work they were written for, and the wrong question for everything
 * else: a 3D relief has no 2D share, a thread is cut by a mill that never opens a region, a
 * chamfer is a cone's flank, and a cut-out is a through profile that needs FLUTE LENGTH rather
 * than area. Re-running the demo set with the app choosing got 21 of 41 runs refused by the
 * generator — correctly, because the pick offered cutters those operations cannot use (#762).
 *
 * This module answers the per-item question first, then the picker's:
 *
 *   - a GOAL object is surfaced by a BALL (the finishing pass is a ball drop, `cam/surface3d`);
 *   - a THREAD is cut by a THREAD MILL that fits its pilot and reaches it;
 *   - a CHAMFER is a CONE that reaches its width; a variable V-CARVE and an INLAY half are a cone
 *     that reaches its depth;
 *   - a BORE is a flat end mill narrower than the hole, a DRILL any cutter that reaches;
 *   - a CUT-OUT is a flat end mill whose flute reaches THROUGH the stock;
 *   - text, regions and traces are the reach table's own detail bar (#201) over the cutters that
 *     also reach the deepest cut.
 *
 * EVERY CANDIDATE PASSES ONE REACH FILTER: its flute (or shoulder, when stated) must cover the
 * deepest cut it is asked to make, cut-outs included — the 12 mm-flute cutter that left the
 * holder rubbing through a 19 mm tray is this filter's absence. The material/broken/catalogue/
 * feeds gate is the same one `recommendTool` applies, so a pick here is one the generator accepts.
 *
 * A FLAT PLAN KEEPS ITS REST CUTTER (#410). The clearance flat clears the bulk, and a finer flat
 * that reaches more of the design — `finerThan`'s rule, over the candidates that pass the reach
 * filter — is added as a REST PASS (no items: the generator measures what the first program left).
 * #760's raised text is the case that most needs it: the letters are kept apart by the rest
 * cutter's width, so the raised-gap measurement decides whether the pair is enough, whether a
 * V-carve takes the cut-away instead, or whether the plan says plainly that nothing fits.
 *
 * The result is a PLAN — one cutter per kind of work, with the item ids each owns (#472
 * `toolItems`), not a single key and a rest pass. The CLI turns it into the job's setup; the
 * panel's single recommendation uses `kindForJob` to ask the same question.
 *
 * Pure: the caller hands in the reach table, the candidate entries and the catalogue.
 */
import { readDefault } from '@/platform/defaultsClient';

import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { jobMachine } from '@/engine/cnc/calibration';
import { cuttingDiameter, statedCuttingSize, type Tool } from '@/engine/cnc/tool';
import { catalogueCoverageFor, catalogueStandingFor, feedsFor, feedsToolForSurface, type FeedCatalogueRow, type FeedsEntry } from '@/engine/cnc/feeds';
import { vCone, vFluteLength } from '@/engine/cnc/vProfile';
import { inlayPairConeTan } from './inlay';
import { threadGeometry } from '@/engine/cnc/cam/threadMill';
import { threadMillFit } from './threadFit';
import { DEFAULT_GRID_PITCH_MM, sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { cutterRefusedOnMaterial } from './cutterMaterial';
import { primitiveLabel, primitiveReducesToRegion } from './partPlan';
import { jobHasItems, pureGoalObject } from './jobSetup';
import { goalSideNeedMm } from './goalReach';
import { NO_TOOL_KEY } from '@/engine/cnc/toolRegistry';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { faceChordMm } from '@/engine/cnc/rotary/faceOps';
import { fmtMm } from '@/workers/sim/engraveGeometry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { CutterReach, Reachability } from './reachability';
import type { ShopDefaults } from '@/platform/defaultsClient';

/** What an item asks of its cutter. One class per shape of work, not one per document list. */
export type WorkKind = 'flat' | 'cone' | 'thread' | 'ball';

/**
 * #760 — the plain sentence the pick says when no cutter keeps a raised label's gaps: the measured
 * gap itself, and the two measured ways out. One constant so the panel's reason, the CLI's plan
 * note and the unassigned row all say the same thing about the same measurement.
 */
export function raisedGapSentence(gapMm: number): string {
  return `no cutter fits the ${fmtMm(gapMm)} mm gaps; make the text larger or V-carve it`;
}

/** One item and the cutter class its own operation demands. Exported for the panel's kind test. */
export interface KindedItem {
  id: string;
  name: string;
  kind: WorkKind;
  /** The cutter's reach this item needs, mm below the top face — through cuts included. */
  reachMm: number;
  /** Why it needs that class, in the operator's words. */
  why: string;
}

/** One cutter the plan gives work to. */
export interface PlannedCutter {
  key: string;
  name: string;
  shape: string;
  /** Cutting diameter the record states, mm (0 when it states none). */
  diameter: number;
  /** The item ids this cutter owns, in the plan's item order. */
  items: string[];
  /** The deepest cut it is asked to reach, mm. */
  reachMm: number;
  /** The rule that chose it, for the CLI's sentence. */
  reason: string;
}

export interface CutterPlan {
  cutters: PlannedCutter[];
  /** Items no candidate could take, with the reason — the job refuses, and the pick says why. */
  unassigned: { id: string; name: string; reason: string }[];
  notes: string[];
  /**
   * #842 — a MIXED job's face-program cutter (the setup's `faceToolKey`), chosen by the face
   * rule beside the item cutters. Absent when the job has no faces, or when the first item
   * cutter serves them too.
   */
  faceToolKey?: string;
  /**
   * #869 — the FLAT that roughs a goal as its own program, before the ball finishes it. Owns no
   * items (there are none): it is a program of the plan, not an item's cutter. Absent when the
   * goal is cut by one cutter.
   */
  goalRoughKey?: string;
}

/**
 * #869 — THE FLATS THAT CAN ROUGH A GOAL, and the order the rule tries them in.
 *
 * A goal's rough is a flat end mill: it takes a deeper step-down and a wider step-over than the
 * ball, so the bulk comes off faster, and the adaptive clearing engine — flat end mills only —
 * becomes available to the goal. The finishing ball still owns the surface, so the rough's size is
 * not a fidelity question: the flat nearest the ball's diameter leaves the least extra stock for
 * the finish to lift, and a wider one trades finer finish work for a faster bulk cut. That trade
 * is exactly what the measured search decides; this list is its candidates, nearest the ball's
 * size first, and the rule answers with the first.
 *
 * A flat must REACH the goal's depth (the ball's own reach rule) and pass the material gate. Null
 * when the job has no goal, or no flat in the shop qualifies — the goal is then cut by one cutter,
 * as it always was.
 */
export interface GoalRoughOptions {
  /** The flats that can rough this goal, nearest the ball's diameter first. */
  candidates: ToolLibraryEntry[];
  /** The ball diameter the order is sized against, mm (0 when the caller gave none). */
  ballDiameter: number;
}

export function goalRoughOptions(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[],
  ballDiameter = 0,
): GoalRoughOptions | null {
  const ballWork = kindedWork(job).filter((w) => w.kind === 'ball');
  if (ballWork.length === 0) return null;
  const needed = ballWork.reduce((m, w) => Math.max(m, w.reachMm), 0);
  const sizeOf = (entry: ToolLibraryEntry): number => statedCuttingSize(entry.tool) ?? cuttingDiameter(entry.tool) ?? 0;
  const flats = tools.filter((entry) => {
    if (entry.tool.shape !== 'flat') return false;
    if (!(sizeOf(entry) > 0)) return false;
    const reach = reachOf(entry);
    if (reach !== null && needed > reach + 1e-9) return false;
    return materialRefusal(job, entry, catalogue, conditions, table) === null;
  });
  if (flats.length === 0) return null;
  const nearBall = (a: ToolLibraryEntry, b: ToolLibraryEntry): number => {
    const da = Math.abs(sizeOf(a) - ballDiameter);
    const db = Math.abs(sizeOf(b) - ballDiameter);
    if (da !== db) return da - db;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  return { candidates: [...flats].sort(nearBall), ballDiameter };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const usable = (item: { enabled: boolean; construction?: boolean }): boolean => item.enabled && item.construction !== true;

/** The body that must clear the stock: the shoulder when the record states one, else the flute. */
export function reachOf(entry: ToolLibraryEntry): number | null {
  return entry.tool.shoulderLength ?? entry.tool.fluteLength;
}

/** `⌀2 mm` — a sentence's diameter, as `recommendTool` writes it. */
function dia(v: number): string {
  return `⌀${Number(v.toFixed(3))} mm`;
}

/**
 * #1051 — THE MESH GOAL'S BALL SENTENCE. No whole-goal reach claim: the engine (#1037) measures
 * the finisher against the surfaces it actually cuts, so the panel names the balls it advised
 * among and says how the engine judges them. `registryStandsIn` is the #1041 fallback — a shop
 * with no inventory or user records is advised from the registry, and the sentence says so.
 */
function meshGoalBallReason(balls: readonly Candidate[], registryStandsIn: boolean): string {
  const sorted = [...balls].sort((a, b) => b.diameter - a.diameter || (b.reach ?? 0) - (a.reach ?? 0));
  const named = sorted.slice(0, 3).map((c) => {
    const flute = c.tool.fluteLength !== null && c.tool.fluteLength > 0 ? ` × ${r3(c.tool.fluteLength)} mm flute` : '';
    return `${dia(c.diameter)}${flute}`;
  });
  const list = sorted.length > 3 ? `${named.join(', ')}, …` : named.join(', ');
  return (
    'a mesh goal is surfaced by a ball — ' +
    (registryStandsIn ? 'no inventory recorded, so the registry stands in; ' : '') +
    `the engine measures the finishing ball among ${registryStandsIn ? "the registry's" : "the shop's"} balls (${list}) against the surfaces it cuts`
  );
}

/** How close a cutter's diameter must be to a cross-hole's to be the one that drills it, mm. */
const HOLE_MATCH_MM = 0.1;

/**
 * #834 — WHAT THE JOB'S FACE OPERATIONS ASK OF A CUTTER. A Flat or a ring is a face pocket as wide
 * as its chord; a Cross-hole comes out at the cutter's own diameter. Read from the job alone, so
 * the rule pick, the search and the CLI cannot disagree about the faces.
 */
export interface FaceWorkFacts {
  /** The NARROWEST face chord across the job's faces, mm — `Infinity` when it has none. */
  chordMm: number;
  /** The deepest face below the surface, mm. */
  deepestMm: number;
  /** The distinct cross-hole diameters asked for, mm, ascending. */
  holesMm: number[];
  /** How many face cuts the list expands to (a ring counts its faces). */
  faceCount: number;
}

/** The face work the job states, or null when it has none (or is not round stock in the chuck). */
export function faceWorkOf(job: EngraveJob, defaults: ShopDefaults | null = null): FaceWorkFacts | null {
  const ops = job.faces ?? [];
  if (ops.length === 0) return null;
  // #1244 — the map is the caller's; the read is a PREDICATE (is this a chuck job?), which the
  // job's own holding and section decide — the limits never enter it.
  const map = rotaryMapOf(job, defaults);
  if (map === null) return null;
  let chordMm = Number.POSITIVE_INFINITY;
  let deepestMm = 0;
  let faceCount = 0;
  const holes = new Set<number>();
  for (const op of ops) {
    if (op.kind === 'cross-hole') {
      const d = op.diameter ?? 0;
      if (d > 0) holes.add(r3(d));
      continue;
    }
    const depth = op.kind === 'flat' ? (op.depth ?? 0) : map.radius - (op.acrossFlats ?? 0) / 2;
    if (!(depth > 0) || depth >= map.radius) continue;
    chordMm = Math.min(chordMm, faceChordMm(map.radius, depth));
    deepestMm = Math.max(deepestMm, depth);
    faceCount += op.kind === 'flat' ? 1 : Math.max(0, op.count ?? 0);
  }
  if (faceCount === 0 && holes.size === 0) return null;
  return { chordMm, deepestMm, holesMm: [...holes].sort((a, b) => a - b), faceCount };
}

/** Does this entry cut the job's faces? A flat end, stated size, no wider than the chord, matching the holes. */
function faceCutterFits(entry: ToolLibraryEntry, facts: FaceWorkFacts, matchHoles: boolean): boolean {
  if (entry.tool.shape !== 'flat') return false;
  const d = statedCuttingSize(entry.tool) ?? 0;
  if (!(d > 0)) return false;
  if (facts.faceCount > 0 && d > facts.chordMm + 1e-9) return false;
  if (matchHoles && facts.holesMm.length > 0 && !facts.holesMm.every((h) => Math.abs(d - h) <= HOLE_MATCH_MM)) return false;
  return true;
}

/** Largest stated diameter first; the key breaks a tie, so the pick is deterministic. */
const widestFirst = (a: ToolLibraryEntry, b: ToolLibraryEntry): number => {
  const da = statedCuttingSize(a.tool) ?? 0;
  const db = statedCuttingSize(b.tool) ?? 0;
  if (db !== da) return db - da;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

/**
 * #834 — THE CUTTER FOR A JOB WHOSE WORK IS ITS FACES. A hex face on ⌀20 is 10 mm wide; the largest
 * flat end that fits cuts it in the fewest passes, and every fitting flat end leaves the SAME face
 * at the same depth — width changes the time, not the result. So the pick is the widest owned flat
 * end that fits, with the cross-holes deciding when the job has them: a hole is the cutter's own
 * diameter, so a cutter matching them is tried first, and when none matches the pick still names a
 * cutter for the faces and the generator's `cross-hole-cutter` warning says what the hole comes
 * out at.
 */
export interface FaceCutterPick {
  entry: ToolLibraryEntry;
  facts: FaceWorkFacts;
  /** True when the pick's diameter matches every cross-hole (or the job has none). */
  matchedHoles: boolean;
  reason: string;
}

export interface FaceCutterOptions {
  facts: FaceWorkFacts;
  /** The flat ends that can cut every face and (when any matches) every cross-hole, widest first. */
  candidates: ToolLibraryEntry[];
  /** True when `candidates` match every cross-hole's diameter (or the job has none). */
  matchedHoles: boolean;
}

/** Every cutter that can take the job's faces, widest first — the pick and the search share this. */
export function faceCutterOptions(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[],
  /** Owned cutters vouch for themselves (#766's rule), as the search does. */
  ownedVouches = true,
  /**
   * #842 — a MIXED job (map items AND faces) has a face program of its own (#836), so the face
   * cutter is still this rule's to pick. False keeps the face-only subject, where the item pick
   * answers for the whole job.
   */
  allowMixed = false,
): FaceCutterOptions | null {
  const facts = faceWorkOf(job);
  if (facts === null) return null;
  if (jobHasItems(job) && !allowMixed) return null;
  const eligible = tools.filter(
    (entry) => materialRefusal(job, entry, catalogue, conditions, table, { ownedVouches }) === null,
  );
  const matched = eligible.filter((e) => faceCutterFits(e, facts, true)).sort(widestFirst);
  if (matched.length > 0) return { facts, candidates: matched, matchedHoles: true };
  const chordOnly = eligible.filter((e) => faceCutterFits(e, facts, false)).sort(widestFirst);
  return chordOnly.length === 0 ? null : { facts, candidates: chordOnly, matchedHoles: facts.holesMm.length === 0 };
}

export function faceCutterPick(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[],
  ownedVouches = true,
  allowMixed = false,
): FaceCutterPick | null {
  const options = faceCutterOptions(job, tools, catalogue, conditions, table, ownedVouches, allowMixed);
  if (options === null) return null;
  const { facts, matchedHoles } = options;
  const pick = options.candidates[0];
  if (pick === undefined) return null;
  const d = statedCuttingSize(pick.tool) ?? 0;
  // The chord is derived (17.321 mm across a hex is 9.999… wide): two decimals is the width a
  // person reads, and it keeps the sentence from naming float dust.
  const chordWords = fmtMm(Math.round(facts.chordMm * 100) / 100);
  const faces =
    facts.faceCount === 0 || facts.chordMm === Number.POSITIVE_INFINITY
      ? ''
      : `The largest flat end that fits the ${chordWords} mm faces — a wider cutter rubs the face’s shoulders, and a smaller one cuts the same face in more passes.`;
  const holes =
    facts.holesMm.length === 0
      ? ''
      : matchedHoles
        ? `It drills the ${facts.holesMm.map(dia).join(' and ')} cross-hole${facts.holesMm.length === 1 ? '' : 's'} at its own diameter.`
        : `No cutter in the shop matches ${facts.holesMm.map(dia).join(' or ')}, so the hole comes out at ${dia(d)}.`;
  return {
    entry: pick,
    facts,
    matchedHoles,
    reason: [faces, holes].filter((w) => w !== '').join(' '),
  };
}

/**
 * #910 — ONE SIDE OF A GOAL CUT FROM SEVERAL SIDES: the job `setupWorkJob` builds for a single
 * setup, holding that side's goal and no item work. `pureGoalObject` answers null for it (it states
 * a setup), so without this the search saw no work at all on a flip's side.
 */
function sideGoalObject(job: EngraveJob): EngraveTargetObject | null {
  const t = job.targetObject;
  if (t === undefined || job.targetObjects !== undefined || job.setups?.length !== 1) return null;
  if ((t.role ?? 'reference') !== 'goal' || !t.enabled) return null;
  return jobHasItems(job) ? null : t;
}

/**
 * Every enabled piece of work and the class of cutter it needs, in the setup's own item order.
 * The depth each needs is the cutter's REACH, not the document's `depth` field: a through cut
 * reaches the stock's underside plus the breakthrough, a thread adds its run-out, and a chamfer is
 * as deep as its width.
 *
 * #940 — TWO CORRECTIONS FOR A V-CARVED ITEM ON A FLOOR:
 *   - any EXPLICIT `vCarveDepth` is cone work. It used to be only `'variable'` (and an inlay), so
 *     a constant-floor V-carve — `vCarveDepth: 'plane'`, the sample-4 initials 0.8 deep in a
 *     6 mm pocket — could only ever be planned as a flat pocket. A document with no
 *     `vCarveDepth` is unchanged: its text stays flat work.
 *   - a CONE's reach is measured from the item's supporting FLOOR (#748), not from the stock top.
 *     The initials sit on the pocket's 6 mm floor and cut 0.8; reading 6.8 refused every 0.3 mm
 *     V-bit for a depth it never travels. `floors` is the document's own map
 *     (`supportingFloors`); a caller that cannot compute it reads the old stock-top depth, and
 *     every app path passes it.
 */
export function kindedWork(
  job: EngraveJob,
  floors?: ReadonlyMap<string, number> | null,
  // #1244 — the map from the caller's edge; the read is a job-decided predicate (see faceWorkOf).
  defaults: ShopDefaults | null = null,
): KindedItem[] {
  const through = r3(job.stock.thickness + job.breakthrough);
  const out: KindedItem[] = [];
  const push = (id: string, name: string, kind: WorkKind, reachMm: number, why: string) =>
    out.push({ id, name, kind, reachMm: r3(reachMm), why });
  const isCone = (item: { inlay?: unknown; vCarveDepth?: string }): boolean =>
    item.inlay !== undefined || item.vCarveDepth !== undefined;
  /** The cut a cone makes into its item's floor — the reach it must have, mm. */
  const coneReach = (id: string, depth: number): number => Math.max(0, depth - (floors?.get(id) ?? 0));

  const goal = pureGoalObject(job) ?? sideGoalObject(job);
  if (goal !== null) {
    // #910 — the ball must reach the GOAL's depth from this side, not the blank's thickness: a
    // 32 mm figure in 33 mm stock asked for a 33 mm reach and refused every 32 mm ball. One side
    // of a flip (`setupWorkJob`'s one-setup job) needs only that side's depth — its band, when the
    // goal is split over two mountings. A rotary relief's local Z is radial, so it keeps the
    // stock's number (the reach check skips it too).
    const need = goal.format === 'png' || rotaryMapOf(job, defaults) !== null ? job.stock.thickness : goalSideNeedMm(goal);
    push(goal.id, goal.name, 'ball', need, 'a 3D goal is surfaced by a ball');
    return out;
  }

  for (const label of job.labels) {
    if (!usable(label)) continue;
    const cone = isCone(label);
    push(
      label.id,
      `"${label.text}"`,
      cone ? 'cone' : 'flat',
      cone ? coneReach(label.id, label.depth) : label.depth,
      cone ? 'a V-carve / inlay is a cone' : 'text is a flat region',
    );
  }
  for (const shape of job.shapes) {
    if (!usable(shape)) continue;
    const cone = isCone(shape);
    push(
      shape.id,
      shape.id,
      cone ? 'cone' : 'flat',
      cone ? coneReach(shape.id, shape.depth) : shape.depth,
      cone ? 'a V-carve / inlay is a cone' : 'a region is a flat pocket',
    );
  }
  for (const item of job.combined ?? []) {
    if (!usable(item)) continue;
    // #743 — AN ISOLATION BAND IS A CONE'S WORK. A frame flagged `isolation` exists to open the
    // copper between two pieces the board keeps: its design is correct at the COLOUR PLANE, where
    // the engraving bit's flank touches the copper's underside, so a flat end mill is the wrong
    // cutter by construction (and a flat wider than the band opens nothing at all).
    const isolation = item.kind === 'frame' && item.isolation === true;
    const cone = isCone(item) || isolation;
    push(
      item.id,
      item.id,
      cone ? 'cone' : 'flat',
      cone ? coneReach(item.id, item.depth) : item.depth,
      isolation
        ? 'an isolation band is a cone’s flank'
        : cone
          ? 'a V-carve / inlay is a cone'
          : 'a region is a flat pocket',
    );
  }
  for (const vector of job.vectors ?? []) {
    if (!usable(vector)) continue;
    // #766 fix — an imported outline follows the SAME depth rule as a shape: a
    // `vCarveDepth: 'variable'` (or inlay) vector's depth follows the cutter's flank at every
    // point, so it is CONE work. It used to be classified flat, and the search handed the V-carve
    // a flat end mill the generator then refused — j21-b's coaster inlay, and the same class in
    // j14's text. `EngraveVectorShape` extends `EngraveShapeBase`, so the marker is the shape's.
    const cone = isCone(vector);
    push(
      vector.id,
      vector.name ?? vector.id,
      cone ? 'cone' : 'flat',
      cone ? coneReach(vector.id, vector.depth) : vector.depth,
      cone ? 'a V-carve / inlay is a cone' : 'an imported outline is a flat region',
    );
  }
  for (const trace of job.traces ?? []) {
    if (!usable(trace)) continue;
    const slot = trace.kind === 'line' && trace.slotWidth !== undefined && trace.flute === undefined;
    push(trace.id, trace.id, 'flat', trace.depth, slot ? 'a slot along a path is a flat pocket' : 'a trace follows a line with a flat cutter');
  }
  for (const primitive of (job.primitives ?? []).filter(primitiveReducesToRegion)) {
    if (!usable(primitive)) continue;
    push(primitive.id, primitiveLabel(primitive), 'flat', primitive.depth, 'a vertical pocket is a flat region');
  }
  for (const drill of job.drills ?? []) {
    if (!usable(drill)) continue;
    push(drill.id, drill.id, 'flat', drill.through ? through : drill.depth, 'a bore is helixed by a flat end mill');
  }
  for (const thread of job.threads ?? []) {
    if (!usable(thread)) continue;
    // The thread mill's own run-out (two pitches, the shipped clearance) below the thread.
    push(thread.id, thread.id, 'thread', thread.depth + 2 * threadGeometry(thread.size).pitch, 'a thread needs a thread mill');
  }
  for (const cutout of job.cutouts ?? []) {
    if (!usable(cutout)) continue;
    push(cutout.id, cutout.name ?? cutout.id, 'flat', through, 'a cut-out profiles THROUGH the stock');
  }
  for (const chamfer of job.chamfers ?? []) {
    if (!usable(chamfer)) continue;
    // A 45° bevel of width w is w deep; the cone's flank must reach it.
    push(chamfer.id, chamfer.name ?? chamfer.id, 'cone', chamfer.width, 'a chamfer is a cone’s flank');
  }
  return out;
}

/**
 * The kind of work a job is made of, for a caller that only needs the shape of cutter to name:
 * `'ball'` for a pure goal, `'thread'` when the job has threads (the only class a thread mill
 * serves), `'cone'` when its regions need a cone's flank, else `'flat'`. Null when there is no
 * work at all.
 */
export function kindForJob(job: EngraveJob): WorkKind | null {
  const work = kindedWork(job);
  if (work.length === 0) return null;
  if (work.some((w) => w.kind === 'ball')) return 'ball';
  if (work.some((w) => w.kind === 'thread')) return 'thread';
  if (work.some((w) => w.kind === 'cone')) return 'cone';
  return 'flat';
}

/**
 * The material/broken/catalogue/feeds gate every computed pick passes — the same rules, in the
 * same order, as `recommendTool`'s candidate map (#442 broken, #699b metal line, #455 catalogue
 * standing, #347 feeds). Reproduced here rather than imported because the recommendation's copy
 * runs inside that map; `cutterChoice762.spec.ts` pins the two answers to agree.
 */
export function materialRefusal(
  job: EngraveJob,
  entry: ToolLibraryEntry,
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[],
  /**
   * #766 — OWNED CUTTERS ARE THE OPERATOR'S OWN. The catalogue's material list is advice for a
   * shop's own bit, not a veto: Makera lists the 0.6 mm corn for PCB and carbon fibre, and the
   * maintainer cuts PLA with it every day. With this set, an owned (`inv:`) cutter the catalogue
   * would refuse by material is still a candidate — the simulatio decides — while a CATALOGUE
   * cutter keeps the catalogue's own rule, and a broken or metal-line cutter is still refused.
   */
  opts?: { ownedVouches?: boolean },
): string | null {
  const tool = entry.tool;
  const condition = conditions?.get(entry.key) ?? null;
  // #1149 — no usable copy at all: every piece is marked broken or lost (a copy nobody described
  // is NOT this case — it is unknown, and the summary says so without excluding the cutter).
  if (condition !== null && condition.usable === 0) return `${entry.key} is marked broken or lost`;
  const coverage = catalogueCoverageFor(catalogue, job.stock.material, tool);
  if (cutterRefusedOnMaterial(tool, job.stock.material, job.metalLineOverride, coverage.kind === 'covered')) {
    return `${entry.key} is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}`;
  }
  const standing = catalogueStandingFor(coverage, job.stock.material, tool.name);
  const ownedVouches = opts?.ownedVouches === true && !entry.key.startsWith('cat:');
  if (!standing.recommend && !ownedVouches) {
    return standing.note ?? `${entry.key} is not listed for ${MATERIAL_LABELS[job.stock.material]}`;
  }
  // #762 — A BALL AND A THREAD ARE NOT RESOLVED BY `feedsFor`, and that is not a refusal of them:
  // a goal's feeds come through a FLAT PROXY of the ball's cutting size exactly as the goal
  // program does it (`generateGoalProgram`), and a thread-only program resolves the catalogue's
  // thread row through `threadSettings`, never through `feedsFor` (which refuses a thread mill by
  // design). The gate asks the same question for the same cutter, so a ball or a thread that
  // passes the catalogue's own check is eligible here too.
  if (tool.shape === 'thread') return null;
  // #910 — the generator's own proxy (`feedsToolForSurface`), which keeps the ball's Makera id, so
  // the gate reads the same row the goal program will: a ⌀6 ball's own hardwood row, not nothing.
  const feeds = feedsFor(catalogue, job.stock.material, feedsToolForSurface(tool), jobMachine(job), undefined, table);
  if (!feeds.ok) {
    return `no cutting parameters for ${entry.key} in ${MATERIAL_LABELS[job.stock.material]}: ${feeds.reason}`;
  }
  return null;
}

/** One candidate that passed the gate, with the reach it can make. */
interface Candidate {
  entry: ToolLibraryEntry;
  tool: Tool;
  diameter: number;
  reach: number | null;
}

/**
 * The plan. `reach` is the job's reachability table (the same one the CLI prints); `tools` the
 * library the pick may draw from; `catalogue`/`conditions`/`table` the seams `recommendTool` takes.
 */
export function planCutters(
  job: EngraveJob,
  reach: Reachability | null,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[],
  /** The shop's `sim.columnFlatPitchYMm` (the goal finish's grid), for the ball's budget check. */
  gridPitchMm?: number | null,
  /**
   * #940 — the document's SUPPORTING FLOORS (#748, `supportingFloors`), so a cone's reach is the
   * cut it makes below its item's floor rather than the stock-top depth. Absent: the old reading.
   */
  floors?: ReadonlyMap<string, number> | null,
  // #1244 — the map from the caller's edge (a job-decided predicate; see faceWorkOf).
  defaults: ShopDefaults | null = null,
): CutterPlan {
  // #834 — A JOB WHOSE WORK IS ON ITS FACES. The face pick is one flat end, and the plan's one
  // cutter owns no ITEMS (there are none): the indexed program cuts the face list the job states.
  // It is answered here so the rule plan, the CLI and the search's baseline are the same cutter.
  const face = faceCutterPick(job, tools, catalogue, conditions, table);
  if (face !== null) {
    return {
      cutters: [
        {
          key: face.entry.key,
          name: face.entry.tool.name,
          shape: face.entry.tool.shape,
          diameter: statedCuttingSize(face.entry.tool) ?? 0,
          items: [],
          reachMm: face.facts.deepestMm,
          reason: face.reason,
        },
      ],
      unassigned: [],
      notes: [],
    };
  }
  // #842 — a MIXED job's face program has its own cutter, chosen by the same face rule.
  const mixedFace = jobHasItems(job) ? faceCutterPick(job, tools, catalogue, conditions, table, true, true) : null;
  const faceToolKey = mixedFace === null ? undefined : mixedFace.entry.key;

  // #1051 — THE PANEL'S ADVISORY FOLLOWS THE ENGINE'S TWO RULES.
  // (1) OWNED FIRST (#1041): a shop with inventory or user records is advised from THOSE records
  // (plus the job's own chosen cutter); the catalogue's `cat:` rows are the ideal's, not the
  // shop's, and the built-ins are the registry's stand-in. Only a shop with neither falls back to
  // the whole registry — and the sentence says the registry stands in, never a silent catalogue
  // cutter the bench does not hold.
  // (2) A MESH GOAL'S BALL IS NOT JUDGED BY THE GOAL'S WHOLE DEPTH (#1037): the engine measures
  // the finisher per surface, so the advisory drops the "reaches N mm" claim for the depth the
  // ball never cuts. PNG reliefs and rotary maps keep the reach rule (their engines have no
  // per-feature judge).
  const cutterLineGoal = pureGoalObject(job);
  const meshGoal = cutterLineGoal !== null && cutterLineGoal.format !== 'png' && rotaryMapOf(job, defaults) === null;
  const chosenCutterKey = job.toolKey === NO_TOOL_KEY ? null : job.toolKey;
  // The SHOP's records decide the fallback — the chosen tool is an exception that joins a shop's
  // own list, never a record that makes the registry fall back off (#1041's seam rule exactly).
  const ownedRecords = meshGoal ? tools.filter((e) => e.key.startsWith('inv:') || e.key.startsWith('user:')) : [];
  const candidateTools =
    meshGoal && ownedRecords.length > 0
      ? tools.filter((e) => e.key.startsWith('inv:') || e.key.startsWith('user:') || (chosenCutterKey !== null && e.key === chosenCutterKey))
      : tools;
  const registryStandsIn = meshGoal && ownedRecords.length === 0;

  const work = kindedWork(job, floors, defaults);
  const unassigned: CutterPlan['unassigned'] = [];
  const notes: string[] = [];
  const reachByKey = new Map(reach === null ? [] : reach.cutters.map((c) => [c.key, c]));

  const candidates: Candidate[] = [];
  const refusals = new Map<string, string>();
  for (const entry of candidateTools) {
    const refusal = materialRefusal(job, entry, catalogue, conditions, table);
    if (refusal !== null) {
      refusals.set(entry.key, refusal);
      continue;
    }
    candidates.push({
      entry,
      tool: entry.tool,
      diameter: statedCuttingSize(entry.tool) ?? cuttingDiameter(entry.tool) ?? 0,
      reach: reachOf(entry),
    });
  }
  /** The first material refusal among the entries of a shape, for a kind that had no pick. */
  const whyNoShape = (shapes: readonly string[]): string => {
    const first = candidateTools.find((t) => shapes.includes(t.tool.shape) && refusals.has(t.key));
    return first === undefined ? '' : ` — ${refusals.get(first.key)}`;
  };

  const reaches = (c: Candidate, reachMm: number): boolean => c.reach === null || reachMm <= c.reach + 1e-9;
  const deeperFirst = (a: Candidate, b: Candidate): number =>
    b.diameter !== a.diameter ? b.diameter - a.diameter : (b.reach ?? 0) - (a.reach ?? 0);
  const smallerFirst = (a: Candidate, b: Candidate): number =>
    a.diameter !== b.diameter ? a.diameter - b.diameter : (b.reach ?? 0) - (a.reach ?? 0);
  const bestOf = (list: Candidate[], better: (a: Candidate, b: Candidate) => number): Candidate | null =>
    list.length === 0
      ? null
      : [...list].sort((a, b) => better(a, b) || (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0))[0]!;

  const byKind = (kind: WorkKind) => work.filter((w) => w.kind === kind);
  const ids = (list: KindedItem[]) => list.map((w) => w.id);
  const deepest = (list: KindedItem[]) => list.reduce((m, w) => Math.max(m, w.reachMm), 0);
  const label = (list: KindedItem[]) => (list.length === 1 ? list[0]!.name : `${list.length} items`);
  const cutters: PlannedCutter[] = [];
  /** #869 — the flat that roughs the goal before its ball, when one qualifies. */
  let goalRoughKey: string | undefined;
  const add = (c: Candidate, list: KindedItem[], reason: string) =>
    cutters.push({
      key: c.entry.key,
      name: c.entry.tool.name,
      shape: c.entry.tool.shape,
      diameter: c.diameter,
      items: ids(list),
      reachMm: deepest(list),
      reason,
    });

  // ---- the goal: one ball, the smallest that reaches -----------------------------------------
  const ballWork = byKind('ball');
  if (ballWork.length > 0) {
    const needed = deepest(ballWork);
    // #762 — THE BALL IS JUDGED BY THE FINISHING BUDGET (#540): the tip field costs covered cells ×
    // the ball's own disc stencil, so the choice is the LARGEST ball whose stencil at this job's
    // grid stays under the budget — the biggest ball that fits finishes fastest, and one past the
    // budget is refused by the generator. The grid is sampled here exactly as the finishing pass
    // will sample it; when the goal's bytes are not in hand (a reloaded job whose blob is still in
    // the mesh store) the check is skipped and the smallest ball stands.
    const goal = pureGoalObject(job);
    const pitch = job.targetObject?.surface?.gridPitchMm ?? (gridPitchMm !== null && gridPitchMm !== undefined && gridPitchMm > 0 ? gridPitchMm : DEFAULT_GRID_PITCH_MM);
    let coveredCount: number | null = null;
    if (goal !== null) {
      try {
        coveredCount = sampleGoalHeightfield(goal, { pitchMm: pitch, maxCells: readDefault(defaults, 'goal.maxCells').value }).coveredCount;
      } catch {
        coveredCount = null;
      }
    }
    const stencilCells = (diameter: number): number => {
      const radius = diameter / 2;
      const span = Math.max(0, Math.floor(radius / pitch));
      let n = 0;
      for (let dj = -span; dj <= span; dj++) for (let di = -span; di <= span; di++) if (Math.hypot(di * pitch, dj * pitch) <= radius) n++;
      return Math.max(1, n);
    };
    const budgetOk = (c: Candidate): boolean =>
      coveredCount === null || coveredCount * stencilCells(c.diameter) <= readDefault(null, 'finish.maxTipOps').value;
    // #1037 — THE GOAL'S DEPTH IS NOT THE BALL'S. The model engine assigns cutters per feature
    // (`cam/model/sequence.ts depthRefusal`): the ball finishes the curved remainders, and the
    // goal's whole depth belongs to its flat/contour. A ball that reaches is still preferred, but
    // when none reaches the goal's depth the largest is still the goal's ball — the engine judges
    // it against the floors it actually cuts, and refuses it there if it cannot.
    const balls = candidates.filter((c) => (c.tool.shape === 'ball' || c.tool.shape === 'bull') && c.diameter > 0);
    const reaching = balls.filter((c) => reaches(c, needed));
    // #1051 — A MESH GOAL HAS NO WHOLE-GOAL REACH PICK. The engine (#1037) measures the finisher
    // against the surfaces it actually cuts, so the advisory takes the largest ball that fits the
    // finishing budget and never claims "reaches N mm" for a depth the ball does not cut. PNG
    // reliefs and rotary maps keep the reach rule (their engines have no per-feature judge).
    const pick = meshGoal
      ? (bestOf(balls.filter(budgetOk), deeperFirst) ?? bestOf(balls, deeperFirst))
      : (bestOf(reaching.filter(budgetOk), deeperFirst) ??
        bestOf(reaching, smallerFirst) ??
        bestOf(balls.filter(budgetOk), deeperFirst) ??
        bestOf(balls, deeperFirst));
    if (pick !== null) {
      add(
        pick,
        ballWork,
        meshGoal
          ? meshGoalBallReason(balls, registryStandsIn)
          : reaching.length > 0
            ? `a 3D goal is surfaced by a ball — ${dia(pick.diameter)} is the largest that reaches ${r3(needed)} mm and fits the finishing budget`
            : `a 3D goal is surfaced by a ball — ${dia(pick.diameter)}; no ball in the set reaches the goal's ${r3(needed)} mm, so the engine judges its reach per feature (the ball cuts the curved remainder, the flat the freeing contour)`,
      );
      // #869 — THE ROUGH IS A FLAT, AND ITS OWN PROGRAM. The rule names the flat nearest the
      // ball's size: the finish must lift whatever the rough leaves, and the flat closest to the
      // ball leaves the least extra stock for it. The search measures the alternatives.
      const rough = goalRoughOptions(job, candidateTools, catalogue, conditions, table, pick.diameter);
      const roughPick = rough?.candidates[0];
      if (roughPick !== undefined) {
        goalRoughKey = roughPick.key;
        notes.push(
          `the goal’s rough is its own program — ${roughPick.key} clears the stock before the ball finishes`,
        );
      }
    } else {
      const balls = candidates.filter((c) => c.tool.shape === 'ball' || c.tool.shape === 'bull').length;
      const all = candidateTools.filter((t) => t.tool.shape === 'ball' || t.tool.shape === 'bull').length;
      // #1051 — THE MESH GOAL'S NO-BALL SENTENCE MAKES NO REACH CLAIM EITHER (6b's words): the
      // fact is that no ball the shop holds can cut this material, so the engine finishes the
      // curved surfaces with a flat (#982). The old "the goal needs N mm of reach" was the
      // whole-goal depth the ball never cuts.
      const where = registryStandsIn ? 'the registry' : "the shop's records";
      const gate = all === 0 ? '' : ` (${balls} of ${all} passed the material gate)`;
      const meshReason =
        `no ball end mill in ${where}${gate} — the engine finishes the curved surfaces with a flat (#982) ` +
        'unless a ball is added to the inventory';
      for (const w of ballWork) {
        unassigned.push({
          id: w.id,
          name: w.name,
          reason: meshGoal
            ? meshReason
            : `no ball end mill reaches this goal — ${balls} of ${all} passed the material gate, and the goal needs ${r3(needed)} mm of reach${whyNoShape(['ball', 'bull'])}`,
        });
      }
    }
  }

  // ---- threads: one thread mill that fits every thread it must cut ---------------------------
  const threadWork = byKind('thread');
  if (threadWork.length > 0) {
    const threadItems = (job.threads ?? []).filter((t) => usable(t) && threadWork.some((w) => w.id === t.id));
    // #841 — one fit rule (`threadFit.ts`): internal or external, metric or unified. The two-pitch
    // run-out reach stays this module's own, stricter, rule.
    const fits = (c: Candidate): string | null => {
      for (const t of threadItems) {
        const fit = threadMillFit(c.tool, t);
        if (fit.refusal !== null) return fit.refusal;
        const { pitch } = threadGeometry(t.size);
        if (c.tool.fluteLength !== null && t.depth + 2 * pitch > c.tool.fluteLength) return `flute does not reach ${t.size}`;
      }
      return null;
    };
    // A cutter NAMED for every thread's own pitch is preferred when one fits (the pitch finding's
    // own rule); otherwise any fitting thread mill, and the finding informs.
    const fitting = candidates.filter((c) => fits(c) === null);
    const pitched = fitting.filter((c) => threadItems.every((t) => threadMillFit(c.tool, t).pitchMatches === true));
    const pick = bestOf(pitched.length > 0 ? pitched : fitting, deeperFirst);
    if (pick !== null) add(pick, threadWork, `a thread is cut by a thread mill — ${dia(cuttingDiameter(pick.tool) ?? 0)} fits the ${threadItems.every((t) => t.side === 'external') ? 'boss' : 'pilot'} and reaches`);
    else
      for (const w of threadWork) {
        unassigned.push({ id: w.id, name: w.name, reason: `no thread mill in the list fits this thread and its material${whyNoShape(['thread'])}` });
      }
  }

  // ---- cones: chamfers and V-carves ----------------------------------------------------------
  const coneWork = byKind('cone');
  if (coneWork.length > 0) {
    // #912 — THE PAIR'S CONE. A male inlay half was built for the female's V angle; a cone of
    // another angle cannot close the pair, so it is never the cone pick (the recommendation's
    // own copy of this gate excludes it by name too).
    const pairConeTan = inlayPairConeTan(job);
    const pairDeg =
      pairConeTan === null ? null : Number(((2 * Math.atan(pairConeTan) * 180) / Math.PI).toFixed(1));
    const chamfers = (job.chamfers ?? []).filter((c) => usable(c) && coneWork.some((w) => w.id === c.id));
    const named = (id: string) =>
      [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])].find((i) => i.id === id);
    const covered = (c: Candidate): string | null => {
      const cone = vCone(c.tool);
      const flute = vFluteLength(c.tool);
      if (cone === null || flute === null) return 'states no usable cone';
      if (pairConeTan !== null && Math.abs(cone.tanHalf - pairConeTan) > 1e-6) {
        return `its ${r3(cone.halfAngleDeg * 2)}° cone is not the ${String(pairDeg)}° V the inlay pair was built for`;
      }
      const flank = flute * cone.tanHalf;
      for (const ch of chamfers) {
        if (ch.width > flank + 1e-9) return `its cone reaches ${r3(flank)} mm, not the ${ch.width} mm chamfer`;
        // #762 — THE TIP PLANE IS THE BEVEL'S BOTTOM (`width / tan(halfAngle)`): a shallow cone
        // makes a DEEP bevel. A 10° half-angle on a 2.5 mm bevel reaches 14.2 mm down, past a
        // 10 mm pocket floor — `chamfer-too-deep` (j21's coaster). A part's edge is bounded by the
        // blank's underside; a pocket's rim by the pocket's own floor.
        const target = ch.of === undefined ? undefined : named(ch.of);
        const through = target === undefined || !('kind' in target) || ('through' in target && target.through === true);
        const floor =
          ch.side === 'outside' || through
            ? job.stock.thickness
            : target !== undefined && 'depth' in target && typeof target.depth === 'number'
              ? target.depth
              : null;
        const bevelDepth = ch.width / cone.tanHalf;
        if (floor !== null && bevelDepth >= floor - 1e-9) {
          return `its ${r3(cone.halfAngleDeg * 2)}° flank makes a ${r3(bevelDepth)} mm bevel, past the ${r3(floor)} mm floor`;
        }
      }
      const vCarve = coneWork.filter((w) => !chamfers.some((ch) => ch.id === w.id));
      if (flute + 1e-9 < deepest(vCarve)) return `its cone reaches ${r3(flute)} mm, not the V-carve’s depth`;
      return null;
    };
    // A chamfer wants the chamfer bit when the list has one (its 90° flank is the bevel's own);
    // a V-carve wants the engraver. Then the larger cone, then the key.
    const prefer = (a: Candidate, b: Candidate): number => {
      if (chamfers.length > 0) {
        const aCh = a.tool.shape === 'chamfer' ? 0 : 1;
        const bCh = b.tool.shape === 'chamfer' ? 0 : 1;
        if (aCh !== bCh) return aCh - bCh;
      }
      return deeperFirst(a, b);
    };
    const pick = bestOf(candidates.filter((c) => covered(c) === null), prefer);
    if (pick !== null) {
      const why = [chamfers.length > 0 ? 'a chamfer is a cone’s flank' : '', coneWork.length > chamfers.length ? 'a V-carve is a cone’s flank' : ''].filter(Boolean).join('; ');
      add(pick, coneWork, `${why} — ${pick.tool.shape} ${dia(pick.diameter)} reaches them`);
    } else {
      // #912 — say the pair's cone when that is what excludes every candidate, rather than
      // "no cone reaches this cut" (which would be untrue: cones reach it, the wrong ones).
      const anyPairCone = (c: Candidate): boolean => {
        const cone = vCone(c.tool);
        return cone !== null && (pairConeTan === null || Math.abs(cone.tanHalf - pairConeTan) <= 1e-6);
      };
      const reason =
        pairConeTan !== null && !candidates.some(anyPairCone)
          ? `the inlay pair was built for a ${String(pairDeg)}° V, and the list holds no ${String(pairDeg)}° cone for this cut${whyNoShape(['engraving', 'chamfer'])}`
          : `no cone in the list reaches this cut for this material${whyNoShape(['engraving', 'chamfer'])}`;
      for (const w of coneWork) unassigned.push({ id: w.id, name: w.name, reason });
    }
  }

  // ---- flats: drills, bores, cut-outs, regions, text and traces ------------------------------
  const flatWork = byKind('flat');
  if (flatWork.length > 0) {
    const flats = candidates.filter((c) => c.tool.shape === 'flat' && c.diameter > 0);
    const bores = (job.drills ?? []).filter((d) => usable(d) && d.mode === 'bore' && flatWork.some((w) => w.id === d.id));
    const smallestBore = bores.reduce<number | null>((m, d) => {
      const h = d.diameter !== undefined && d.diameter > 0 ? d.diameter : null;
      return h === null ? m : m === null ? h : Math.min(m, h);
    }, null);
    const cutouts = (job.cutouts ?? []).filter((c) => usable(c) && flatWork.some((w) => w.id === c.id));
    const throughDepth = r3(job.stock.thickness + job.breakthrough);
    // The detail bar (#201) is the reach table's own `detailQualifies` — the AREA detail, since
    // #760: the raised-text rule is separate, because a raised label is kept by a FINER cutter
    // cutting the same cut-away afterwards, not by shrinking the clearance cutter.
    // This module adds the reaches the table does not measure (cut-outs, drills, bores).
    const detail = (c: Candidate): boolean => reach === null || (reachByKey.get(c.entry.key)?.detailQualifies ?? true);
    const drillIds = new Set((job.drills ?? []).filter(usable).map((d) => d.id));
    const cutoutIds = new Set(cutouts.map((k) => k.id));
    const boreIds = new Set(bores.map((b) => b.id));
    const reachesAll = (c: Candidate) => reaches(c, deepest(flatWork)) && (smallestBore === null || c.diameter < smallestBore - 1e-9);
    const profiles = (c: Candidate) => cutouts.length === 0 || reaches(c, throughDepth);

    // #760 — THE RAISED TEXT IS A GAP, MEASURED THE WAY `raised-text-fused` MEASURES IT. A cutter
    // whose opening joins a label's letters is not a cutter that keeps that cut-away; the reach
    // table says which candidates fuse which cut-away, at that cutter's own width.
    const raisedRows = (c: Candidate) => reachByKey.get(c.entry.key)?.raised ?? [];
    const raisedCutaways = new Map<string, CutterReach['raised'][number]>();
    for (const cutter of reach?.cutters ?? []) {
      for (const row of cutter.raised) {
        const cur = raisedCutaways.get(row.cutawayId);
        if (cur === undefined || row.gap < cur.gap) raisedCutaways.set(row.cutawayId, row);
      }
    }
    const keepsRaised = (c: Candidate, cutawayId: string): boolean =>
      !raisedRows(c).some((row) => row.cutawayId === cutawayId);
    // #221/#762 — the cones the reach table qualifies as V-carves. Since #760 their `qualifies`
    // includes the raised rule, so a V that joins the letters is not on this list.
    const vConeCandidates =
      reach === null
        ? []
        : candidates.filter(
            (c) => vCone(c.tool) !== null && reachByKey.get(c.entry.key)?.vCarve === true && reachByKey.get(c.entry.key)?.qualifies !== false,
          );

    /** The finer cutter that cleans up after `main` (#410's rest pair), on the `finerThan` rule. */
    const finerRest = (main: Candidate, work: KindedItem[]): Candidate | null => {
      if (reach === null) return null;
      const base = reach.totalShare.get(main.entry.key) ?? 0;
      const better = flats.filter(
        (c) =>
          c.entry.key !== main.entry.key &&
          c.diameter < main.diameter - 1e-9 &&
          reaches(c, deepest(work)) &&
          profiles(c) &&
          (reach.totalShare.get(c.entry.key) ?? 0) > base + 1e-9,
      );
      return bestOf(better, smallerFirst);
    };

    /**
     * Give `work` to `main`, and #760's two raised-text answers: a cut-away whose letters the
     * finest flat (the rest cutter, when one is added) still joins goes to a V-carve when a cone
     * keeps its gaps, and otherwise stays where it is with the plain sentence.
     */
    const placeFlatWork = (main: Candidate, work: KindedItem[], reason: string): void => {
      const rest = finerRest(main, work);
      // The rest pass re-cuts the main cutter's leftovers, so it is the LAST width the raised
      // letters see — the one the finding must be judged at.
      const finest = rest ?? main;
      let remaining = work;
      const movedToV = new Map<Candidate, KindedItem[]>();
      for (const [cutawayId, row] of raisedCutaways) {
        const item = work.find((w) => w.id === cutawayId);
        if (item === undefined || keepsRaised(finest, cutawayId)) continue;
        const cone = bestOf(
          vConeCandidates.filter((c) => keepsRaised(c, cutawayId) && reaches(c, item.reachMm)),
          deeperFirst,
        );
        if (cone !== null) {
          movedToV.set(cone, [...(movedToV.get(cone) ?? []), item]);
          remaining = remaining.filter((w) => w.id !== cutawayId);
        } else {
          // No flat and no cone keeps the letters. The cut still happens — the sentence says what
          // the operator will see, and the two measured ways out.
          notes.push(`${item.name}: raised text "${row.text}" — ${raisedGapSentence(row.gap)}`);
        }
      }
      if (remaining.length > 0) {
        add(main, remaining, reason);
        if (rest !== null) {
          const share = reach === null ? 0 : Math.round((reach.totalShare.get(rest.entry.key) ?? 0) * 100);
          add(
            rest,
            [],
            `rest — ${dia(rest.diameter)} reaches ${share} % of the design after ${main.entry.key}, so what it can open is worth a second program`,
          );
        }
      }
      for (const [cone, items] of movedToV) {
        add(cone, items, `raised text is cut at the colour plane — the ${dia(cone.diameter)} cone keeps its letter gaps`);
      }
    };

    // 1 · ONE FLAT FOR EVERYTHING, when a flat keeps the AREA detail; the raised text is placed
    // by `placeFlatWork` on top of that.
    const all = bestOf(flats.filter((c) => reachesAll(c) && profiles(c) && detail(c)), deeperFirst);
    if (all !== null) {
      placeFlatWork(
        all,
        flatWork,
        `flat work (${label(flatWork)}) — ${dia(all.diameter)} with ${all.reach === null ? 'an unstated' : `${r3(all.reach)} mm`} reach`,
      );
    } else {
      // 2 · TEXT AND REGIONS TAKE A CONE WHEN NO FLAT KEEPS THEM. The reach table's V-carve rows
      // are the engine's own statement that the design is correct at the colour plane with a
      // cone; a V-bit traces the lines too. Without this the pick fell back to the LARGEST flat,
      // which lost whole characters of the text (#762's j10, j14).
      const regionWork = flatWork.filter((w) => !drillIds.has(w.id) && !cutoutIds.has(w.id));
      let restWork = flatWork;
      const vCarve = regionWork.length > 0 ? bestOf(vConeCandidates, deeperFirst) : null;
      if (vCarve !== null) {
        add(vCarve, regionWork, `text and regions are cut at the colour plane — the ${dia(vCarve.diameter)} cone is the V-carve the design needs`);
        restWork = flatWork.filter((w) => !regionWork.includes(w));
      }
      // 3 · THE REST (drills, bores, cut-outs) ON FLATS. A flat that reaches everything may not fit
      // a small bore, and vice versa: the bores get their own fitting cutter, the rest the largest
      // that reaches through.
      const boreWork = restWork.filter((w) => boreIds.has(w.id));
      if (boreWork.length > 0) {
        const borePick = bestOf(
          flats.filter((c) => reaches(c, deepest(boreWork)) && (smallestBore === null || c.diameter < smallestBore - 1e-9)),
          deeperFirst,
        );
        if (borePick !== null) add(borePick, boreWork, `bores — ${dia(borePick.diameter)} is narrower than the ⌀${smallestBore} mm hole`);
        else for (const w of boreWork) unassigned.push({ id: w.id, name: w.name, reason: `no flat end mill narrower than the ⌀${smallestBore} mm bore reaches it${whyNoShape(['flat'])}` });
      }
      const otherWork = restWork.filter((w) => !boreIds.has(w.id));
      if (otherWork.length > 0) {
        // No flat kept the detail and no cone qualifies: the compromise is the SMALLEST flat that
        // reaches, exactly as `recommendTool` chooses a compromise — the largest would lose the
        // most (a 6 mm mill cannot enter a 7.5 mm slot, let alone open it).
        const otherPick = bestOf(flats.filter((c) => reaches(c, deepest(otherWork)) && profiles(c)), smallerFirst);
        if (otherPick !== null) {
          placeFlatWork(
            otherPick,
            otherWork,
            `flat work (${label(otherWork)}) — ${dia(otherPick.diameter)} with ${otherPick.reach === null ? 'an unstated' : `${r3(otherPick.reach)} mm`} reach`,
          );
        } else {
          for (const w of otherWork) unassigned.push({ id: w.id, name: w.name, reason: `no flat end mill reaches this cut for this material${whyNoShape(['flat'])}` });
        }
      }
    }
  }

  // ---- one program per cutter, in cutting order ---------------------------------------------
  // A pocket is cut before the bevel on its rim, and a part's edge before its cut-out frees it
  // (`validateJob`'s chamfer-order): flats lead, a cone follows, a thread is independent, and a
  // goal's ball is its own job. Same-key cutters merge into one program.
  const rank = (shape: string): number =>
    shape === 'flat' ? 0 : shape === 'engraving' || shape === 'chamfer' ? 1 : shape === 'thread' ? 2 : 3;
  const merged: PlannedCutter[] = [];
  for (const c of [...cutters].sort((a, b) => rank(a.shape) - rank(b.shape))) {
    const same = merged.find((m) => m.key === c.key);
    if (same === undefined) merged.push({ ...c, items: [...c.items] });
    else {
      same.items.push(...c.items);
      same.reachMm = Math.max(same.reachMm, c.reachMm);
      same.reason = `${same.reason}; ${c.reason}`;
    }
  }
  notes.push(
    merged.length <= 1
      ? 'one cutter takes all the work'
      : `${merged.length} cutters, one program each: ${merged.map((m) => `${m.key} (${m.items.length})`).join(', ')}`,
  );
  // #842 — the mixed job's face program keeps its own cutter when the face rule names one that
  // the item cutters do not already serve.
  return {
    cutters: merged,
    unassigned,
    notes,
    ...(faceToolKey === undefined ? {} : { faceToolKey }),
    ...(goalRoughKey === undefined ? {} : { goalRoughKey }),
  };
}

/**
 * The cutter for a job whose work is ALL ONE KIND the area-share rule cannot see — a pure GOAL
 * (a ball's job) or a THREAD-ONLY job (a thread mill's). The panel's single recommendation and
 * `reachabilityFor` call this before the region candidate map, because a ball and a thread mill
 * are `not-flat` to that map by construction and could never be its answer.
 *
 * Null for every other job: a mixed job's one cutter is the flat pick's question, and the CLI's
 * multi-cutter split is `planCutters`'. Null too when no cutter of that kind passes the gate.
 */
export function kindOnlyPick(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[],
): { key: string; reason: string; kind: WorkKind } | null {
  const work = kindedWork(job);
  const kind = work[0]?.kind;
  if (kind !== 'ball' && kind !== 'thread') return null;
  if (!work.every((w) => w.kind === kind)) return null;
  const plan = planCutters(job, null, tools, catalogue, conditions, table);
  const pick = plan.cutters[0];
  return pick === undefined ? null : { key: pick.key, reason: pick.reason, kind };
}
