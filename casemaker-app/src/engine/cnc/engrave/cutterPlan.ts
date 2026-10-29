/**
 * #762 — WHAT EACH ITEM IS, and which cutter the job gives it.
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
 * The result is a PLAN — one cutter per kind of work, with the item ids each owns (#472
 * `toolItems`), not a single key and a rest pass. The CLI turns it into the job's setup; the
 * panel's single recommendation uses `kindForJob` to ask the same question.
 *
 * Pure: the caller hands in the reach table, the candidate entries and the catalogue.
 */

import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { jobMachine } from '@/engine/cnc/calibration';
import { cuttingDiameter, flatEndMill, statedCuttingSize, type Tool } from '@/engine/cnc/tool';
import { catalogueCoverageFor, catalogueStandingFor, feedsFor, type FeedCatalogueRow, type FeedsEntry } from '@/engine/cnc/feeds';
import { vCone, vFluteLength } from '@/engine/cnc/vProfile';
import { threadGeometry } from '@/engine/cnc/cam/threadMill';
import { DEFAULT_GRID_PITCH_MM, DEFAULT_MAX_FINISH_TIP_OPS, sampleGoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { cutterRefusedOnMaterial } from './cutterMaterial';
import { primitiveLabel, primitiveReducesToRegion } from './partPlan';
import { pureGoalObject } from './jobSetup';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { EngraveJob } from '@/types/engraveJob';
import type { Reachability } from './reachability';

/** What an item asks of its cutter. One class per shape of work, not one per document list. */
export type WorkKind = 'flat' | 'cone' | 'thread' | 'ball';

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
 * Every enabled piece of work and the class of cutter it needs, in the setup's own item order.
 * The depth each needs is the cutter's REACH, not the document's `depth` field: a through cut
 * reaches the stock's underside plus the breakthrough, a thread adds its run-out, and a chamfer is
 * as deep as its width.
 */
export function kindedWork(job: EngraveJob): KindedItem[] {
  const through = r3(job.stock.thickness + job.breakthrough);
  const out: KindedItem[] = [];
  const push = (id: string, name: string, kind: WorkKind, reachMm: number, why: string) =>
    out.push({ id, name, kind, reachMm: r3(reachMm), why });
  const isCone = (item: { inlay?: unknown; vCarveDepth?: string }): boolean =>
    item.inlay !== undefined || item.vCarveDepth === 'variable';

  const goal = pureGoalObject(job);
  if (goal !== null) {
    push(goal.id, goal.name, 'ball', job.stock.thickness, 'a 3D goal is surfaced by a ball');
    return out;
  }

  for (const label of job.labels) {
    if (!usable(label)) continue;
    const cone = isCone(label);
    push(label.id, `"${label.text}"`, cone ? 'cone' : 'flat', label.depth, cone ? 'a V-carve / inlay is a cone' : 'text is a flat region');
  }
  for (const shape of job.shapes) {
    if (!usable(shape)) continue;
    const cone = isCone(shape);
    push(shape.id, shape.id, cone ? 'cone' : 'flat', shape.depth, cone ? 'a V-carve / inlay is a cone' : 'a region is a flat pocket');
  }
  for (const item of job.combined ?? []) {
    if (!usable(item)) continue;
    const cone = isCone(item);
    push(item.id, item.id, cone ? 'cone' : 'flat', item.depth, cone ? 'a V-carve / inlay is a cone' : 'a region is a flat pocket');
  }
  for (const vector of job.vectors ?? []) {
    if (!usable(vector)) continue;
    push(vector.id, vector.name ?? vector.id, 'flat', vector.depth, 'an imported outline is a flat region');
  }
  for (const trace of job.traces ?? []) {
    if (!usable(trace)) continue;
    push(trace.id, trace.id, 'flat', trace.depth, 'a trace follows a line with a flat cutter');
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
): string | null {
  const tool = entry.tool;
  const condition = conditions?.get(entry.key) ?? null;
  if (condition !== null && condition.usable === 0) return `${entry.key} is marked broken`;
  const coverage = catalogueCoverageFor(catalogue, job.stock.material, tool);
  if (cutterRefusedOnMaterial(tool, job.stock.material, job.metalLineOverride, coverage.kind === 'covered')) {
    return `${entry.key} is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}`;
  }
  const standing = catalogueStandingFor(coverage, job.stock.material, tool.name);
  if (!standing.recommend) {
    return standing.note ?? `${entry.key} is not listed for ${MATERIAL_LABELS[job.stock.material]}`;
  }
  // #762 — A BALL AND A THREAD ARE NOT RESOLVED BY `feedsFor`, and that is not a refusal of them:
  // a goal's feeds come through a FLAT PROXY of the ball's cutting size exactly as the goal
  // program does it (`generateGoalProgram`), and a thread-only program resolves the catalogue's
  // thread row through `threadSettings`, never through `feedsFor` (which refuses a thread mill by
  // design). The gate asks the same question for the same cutter, so a ball or a thread that
  // passes the catalogue's own check is eligible here too.
  if (tool.shape === 'thread') return null;
  const feedTool =
    tool.shape === 'ball' || tool.shape === 'bull'
      ? flatEndMill(cuttingDiameter(tool) ?? 0, { name: `${tool.name} (feeds via flat proxy)` })
      : tool;
  if (!feedsFor(catalogue, job.stock.material, feedTool, jobMachine(job), undefined, table).ok) {
    return `no cutting parameters for ${entry.key} in ${MATERIAL_LABELS[job.stock.material]}`;
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
): CutterPlan {
  const work = kindedWork(job);
  const unassigned: CutterPlan['unassigned'] = [];
  const notes: string[] = [];
  const reachByKey = new Map(reach === null ? [] : reach.cutters.map((c) => [c.key, c]));

  const candidates: Candidate[] = [];
  const refusals = new Map<string, string>();
  for (const entry of tools) {
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
    const first = tools.find((t) => shapes.includes(t.tool.shape) && refusals.has(t.key));
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
        coveredCount = sampleGoalHeightfield(goal, { pitchMm: pitch }).coveredCount;
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
      coveredCount === null || coveredCount * stencilCells(c.diameter) <= DEFAULT_MAX_FINISH_TIP_OPS;
    const balls = candidates.filter((c) => (c.tool.shape === 'ball' || c.tool.shape === 'bull') && c.diameter > 0 && reaches(c, needed));
    const pick = bestOf(balls.filter(budgetOk), deeperFirst) ?? bestOf(balls, smallerFirst);
    if (pick !== null) add(pick, ballWork, `a 3D goal is surfaced by a ball — ${dia(pick.diameter)} is the largest that reaches ${r3(needed)} mm and fits the finishing budget`);
    else {
      const balls = candidates.filter((c) => c.tool.shape === 'ball' || c.tool.shape === 'bull').length;
      const all = tools.filter((t) => t.tool.shape === 'ball' || t.tool.shape === 'bull').length;
      for (const w of ballWork) {
        unassigned.push({
          id: w.id,
          name: w.name,
          reason: `no ball end mill reaches this goal — ${balls} of ${all} passed the material gate, and the goal needs ${r3(needed)} mm of reach${whyNoShape(['ball', 'bull'])}`,
        });
      }
    }
  }

  // ---- threads: one thread mill that fits every thread it must cut ---------------------------
  const threadWork = byKind('thread');
  if (threadWork.length > 0) {
    const threadItems = (job.threads ?? []).filter((t) => usable(t) && threadWork.some((w) => w.id === t.id));
    const fits = (c: Candidate): string | null => {
      if (c.tool.shape !== 'thread') return 'not a thread mill';
      const d = cuttingDiameter(c.tool);
      if (d === null || !(d > 0)) return 'states no cutting diameter';
      for (const t of threadItems) {
        const { major, minor, pitch } = threadGeometry(t.size);
        if (d >= minor) return `too wide for the ⌀${minor} mm pilot of ${t.size}`;
        if (d < (major - minor) / 2) return `too narrow for the radial depth of ${t.size}`;
        if (c.tool.fluteLength !== null && t.depth + 2 * pitch > c.tool.fluteLength) return `flute does not reach ${t.size}`;
      }
      return null;
    };
    const pick = bestOf(candidates.filter((c) => fits(c) === null), deeperFirst);
    if (pick !== null) add(pick, threadWork, `a thread is cut by a thread mill — ${dia(cuttingDiameter(pick.tool) ?? 0)} fits the pilot and reaches`);
    else
      for (const w of threadWork) {
        unassigned.push({ id: w.id, name: w.name, reason: `no thread mill in the list fits this thread and its material${whyNoShape(['thread'])}` });
      }
  }

  // ---- cones: chamfers and V-carves ----------------------------------------------------------
  const coneWork = byKind('cone');
  if (coneWork.length > 0) {
    const chamfers = (job.chamfers ?? []).filter((c) => usable(c) && coneWork.some((w) => w.id === c.id));
    const named = (id: string) =>
      [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])].find((i) => i.id === id);
    const covered = (c: Candidate): string | null => {
      const cone = vCone(c.tool);
      const flute = vFluteLength(c.tool);
      if (cone === null || flute === null) return 'states no usable cone';
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
      for (const w of coneWork) unassigned.push({ id: w.id, name: w.name, reason: `no cone in the list reaches this cut for this material${whyNoShape(['engraving', 'chamfer'])}` });
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
    // The detail bar (#201) is the reach table's own `qualifies`; this module adds the reaches the
    // table does not measure (cut-outs, drills, bores). No reach table: detail is assumed OK.
    const detail = (c: Candidate): boolean => reach === null || (reachByKey.get(c.entry.key)?.qualifies ?? true);
    const drillIds = new Set((job.drills ?? []).filter(usable).map((d) => d.id));
    const cutoutIds = new Set(cutouts.map((k) => k.id));
    const boreIds = new Set(bores.map((b) => b.id));
    const reachesAll = (c: Candidate) => reaches(c, deepest(flatWork)) && (smallestBore === null || c.diameter < smallestBore - 1e-9);
    const profiles = (c: Candidate) => cutouts.length === 0 || reaches(c, throughDepth);

    // 1 · ONE FLAT FOR EVERYTHING, when a flat keeps the detail.
    const all = bestOf(flats.filter((c) => reachesAll(c) && profiles(c) && detail(c)), deeperFirst);
    if (all !== null) {
      add(all, flatWork, `flat work (${label(flatWork)}) — ${dia(all.diameter)} with ${all.reach === null ? 'an unstated' : `${r3(all.reach)} mm`} reach`);
    } else {
      // 2 · TEXT AND REGIONS TAKE A CONE WHEN NO FLAT KEEPS THEM. The reach table's V-carve rows
      // are the engine's own statement that the design is correct at the colour plane with a
      // cone; a V-bit traces the lines too. Without this the pick fell back to the LARGEST flat,
      // which lost whole characters of the text (#762's j10, j14).
      const regionWork = flatWork.filter((w) => !drillIds.has(w.id) && !cutoutIds.has(w.id));
      let restWork = flatWork;
      const vConeCandidates =
        reach === null
          ? []
          : candidates.filter(
              (c) => vCone(c.tool) !== null && reachByKey.get(c.entry.key)?.vCarve === true && reachByKey.get(c.entry.key)?.qualifies !== false,
            );
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
          add(otherPick, otherWork, `flat work (${label(otherWork)}) — ${dia(otherPick.diameter)} with ${otherPick.reach === null ? 'an unstated' : `${r3(otherPick.reach)} mm`} reach`);
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
  return { cutters: merged, unassigned, notes };
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
