/**
 * The engrave preview (#205): the stock with EVERY cut the program will make removed to its own
 * depth — a label's or shape's opened region, a drill's holes (#220), a trace's swept groove
 * (#219/#287) — the floor of each cut, the vise jaws and the sacrificial material (#213) —
 * evaluated in the sim worker.
 *
 * Why the sim worker and not the geometry worker (`/Simulation.md`, #205): the preview needs
 * Manifold (profile evaluation, extrusion) and it is driven on a 150 ms debounce by the panel,
 * but the geometry worker's `currentGeneration` guard is the CASE rebuild's own — a preview
 * build queued there would either block a case rebuild or be cancelled by it. The sim worker
 * is per-CNC-work and disposable, so it is the right home. This module is HEADLESS — no
 * Comlink, no worker globals — so it is tested in plain Node like `session.ts`, and
 * `sim.worker.ts` is a thin shell over it.
 *
 * The preview is the OPENED region, never the ideal glyph: with a flat end mill of radius r
 * the cutter reaches `offset(offset(G, -r), +r)`, which rounds every inside corner and drops
 * any stroke thinner than 2r (#201, `/Fabrication.md` §7.5). `measureLabels` already computes
 * that region and its polygons; the preview reuses those polygons so the drawn cut and the
 * findings can never disagree about which cutter was measured. §5.7's LOST LAYER is the other
 * side of the same subtraction: the ideal design minus that opening, per region item, delivered
 * as contours and a thin sliver so the viewport can paint what the cutter could not reach.
 *
 * #288 — the cuts are not re-derived here at all: `engraveRegions` is called and the picture is
 * built from ITS `cuts`, the same list the oracle's prediction is a projection of. The preview used
 * to walk `plan.engraves` on its own, which is why a drilled hole and a traced groove were cut by
 * the program and absent from the picture. Now the classes are enumerated in exactly one place, and
 * a class that reaches the program reaches the picture with it.
 *
 * Ownership: every `CrossSection` and `Manifold` created here is `.delete()`d exactly once,
 * following `sweep.ts`. The only things that leave are `NodeMeshOutput` buffers and plain data.
 */

import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { toPartPlan, keepOutLimit, keepOutMembrane, labelProfile } from '@/engine/cnc/engrave/partPlan';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { viseEnvelope } from '@/engine/cnc/fixture';
import { sacrificialBoxes, type SacrificialBox } from '@/engine/cnc/sacrificial';
import { cuttingRadiusForSweep } from '@/engine/cnc/tool';
import { toolForJob } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { recommendTool, type ToolRecommendation } from '@/engine/cnc/engrave/recommendTool';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { boxSolid, OVERSHOOT_MM } from '@/workers/geometry/sweep';
import { meshOutputOf, type NodeMeshOutput } from '@/workers/geometry/meshOutput';
import {
  measureLabels,
  suggestCapHeight,
  type LabelEngravability,
  type LabelRatioAt,
  type PerCharGlyph,
} from './engraveGeometry';
import { engraveRegions, type EngraveShopOpts } from './engraveGenerate';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;

/**
 * How tall each floor mesh is, mm (the issue's 0.02). A floor is the pocket floor made
 * visible: the opened region extruded by a sliver and sat at Z = `−depth`, so the viewport can
 * colour it by depth without the sliver ever reading as a solid.
 */
export const FLOOR_THICKNESS_MM = 0.02;

/**
 * How thick the lost-layer sliver stands, mm (§5.7). It sits ON the top face rather than in the
 * cut: a lost region is material the cutter did NOT remove, so a body at the face would z-fight the
 * stock it annotates, and one below the face would read as a floor. The floor sliver's own 20 µm is
 * thick enough to draw and thin enough never to read as stock — and it keeps the two meshes on one
 * unit.
 */
export const LOST_THICKNESS_MM = FLOOR_THICKNESS_MM;

/**
 * Below this, a "lost" region is floating-point dust from the difference, not a detail the cutter
 * missed, mm². The same 1e-6 the oracle's `MIN_AREA_MM2` uses to discard a thin ring.
 */
export const LOST_MIN_AREA_MM2 = 1e-6;

/** Words for each sacrificial piece (#213), so the viewport can name what it draws. */
const SACRIFICIAL_LABEL: Record<SacrificialBox['id'], string> = {
  under: 'Sacrificial board under the part',
  left: 'Sacrificial strip (left)',
  right: 'Sacrificial strip (right)',
  front: 'Sacrificial strip (front)',
  back: 'Sacrificial strip (back)',
};

/** One label's pocket floor, for colouring by depth. Work frame. */
export interface EngravePreviewFloor {
  labelId: string;
  /** Depth of the floor below the top face, mm. Positive. */
  depth: number;
  mesh: NodeMeshOutput;
}

/** One vise jaw, drawn where the user SAID it is (un-inflated), from `viseEnvelope`. */
export interface EngravePreviewFixture {
  id: string;
  label: string;
  mesh: NodeMeshOutput;
}

/**
 * One piece of sacrificial material (#213), drawn where the user SAID it is: the board under the
 * part or a strip beside it, from `sacrificialBoxes`. The `id` is the box id prefixed
 * `sacrificial-` so it can never collide with a jaw id, and `label` names the piece in words.
 */
export interface EngravePreviewSacrificial {
  id: string;
  label: string;
  mesh: NodeMeshOutput;
}

/**
 * One region item's LOST LAYER (§5.7): the ideal design the cutter's opening does not reach.
 *
 * The design is the item's own profile in the stock frame (the glyph or the shape the user placed);
 * the as-cut region is the same opening `measureLabels` already measured and `cuts` already draws.
 * Their difference is the detail the cutter cannot reach — thin strokes dropped whole, corners
 * rounded away, a counter closed up — and it is a property of the geometry, not of a rendering:
 * the viewport paints the contours it is handed and the legend adds the same areas.
 *
 * A DRILL has no lost layer (its design is the cutter's own disc, which is exactly what it cuts) and
 * a TRACE has none either (the design is a centre line, not an area). Only `plan.engraves` carries
 * a design area, so only those items appear here.
 */
export interface EngravePreviewLost {
  /** The job item the design belongs to — the panel's row id. */
  labelId: string;
  /** Area of design − as-cut, mm². */
  area: number;
  /** Lost contours in the work frame, one ring per entry (a hole is its own ring). */
  polygons: [number, number][][];
  /** A thin sliver standing on the top face, z = 0 … +{@link LOST_THICKNESS_MM}, for the viewport. */
  mesh: NodeMeshOutput;
}

/**
 * §5.7 — one step of the design ↔ as-cut slider: the stock after every cut at or SHALLOWER than
 * this depth has been removed, cumulative.
 *
 * The steps are CUT DEPTHS, not animation frames. A cutter that plunges to 1.0 mm leaves exactly
 * that floor in one move, so there is no stock state between 0.5 and 1.0 mm to show; a continuous
 * scrub would be inventing depths the program never cuts. Stage 0 is always the uncut design (the
 * faced blank) and the final state is the preview's own `stock` — this list stops short of it so
 * the deepest body is not meshed (and transferred) twice.
 */
export interface EngravePreviewStage {
  /** The deepest cut applied in this stage, mm below the face. 0 is the uncut design. */
  depth: number;
  /** The cumulative stock at this depth. Work frame. */
  mesh: NodeMeshOutput;
}

/**
 * One declared under-surface void (#271): its footprint as plain rings, plus the two numbers the
 * panel and the viewport state about it.
 *
 * The rings are traced ON THE TOP FACE, not at the void's ceiling: the ceiling is interior to
 * solid material, so a contour drawn there would be inside the stock mesh and invisible. What the
 * user needs to see is where on the face the void lies — the thing a label must be placed clear
 * of — and the label says how deep a cut may go there. The rings ARE the footprint, so a body
 * drawn at the ceiling and this outline can never disagree about where the void is.
 */
export interface EngravePreviewVoid {
  id: string;
  name: string;
  /** The void's ceiling, mm from the blank's BOTTOM face (the `EngraveKeepOut` datum). */
  zCeiling: Mm;
  /** `keepOutMembrane(job, zCeiling)`: solid left above it, mm. */
  membrane: Mm;
  /**
   * `keepOutLimit(job, membrane, boundaryMargin)`: the deepest cut over it, mm — the number the
   * verifier ENFORCES there, not the design's arithmetic (#345, #351). Its ceiling is snapped to
   * the printer's layer grid when the blank states a print, and it is never deeper than the
   * blank's own `thickness − minFloor`; both of those are `keepOutLimitParts`' work in
   * `partPlan.ts`, so this label and the panel's void row and the run sheet's §1 step state one
   * number rather than three.
   */
  limit: Mm;
  /** Footprint contours in the work frame, one entry per ring (a hole is its own ring). */
  rings: [number, number][][];
}

/** Everything the panel and the viewport need for one job, as plain data + mesh buffers. */
export interface EngravePreview {
  /** The stock with every enabled, error-free cut removed to its own depth (#288). Work frame. */
  stock: NodeMeshOutput;
  /**
   * §5.7 — the stock part-way through the program, one entry per distinct cut depth BELOW the
   * deepest: `stages[0]` is the uncut design, and each later entry has cut one more depth. The
   * finished state is `stock`. Empty when the job has no cut to scrub (the slider is then hidden,
   * because every position would draw the same body).
   */
  stages: EngravePreviewStage[];
  /** One mesh per cut — label, shape, drill or trace: the bottom it leaves at its depth. */
  floors: EngravePreviewFloor[];
  /** The vise jaws (un-inflated), from `viseEnvelope`. */
  fixture: EngravePreviewFixture[];
  /** The sacrificial material (#213), from `sacrificialBoxes`; empty when the job has none. */
  sacrificial: EngravePreviewSacrificial[];
  /** The declared under-surface voids (#271), enabled ones only; empty when the job has none. */
  voids: EngravePreviewVoid[];
  /**
   * §5.7 — each region item's lost layer (design − as-cut), in item order. Empty when every design
   * is reached, when the job has no region items, or when no cutter opening was measured at all.
   */
  lost: EngravePreviewLost[];
  /** Per-label measurements, without the (large) polygons: the findings carry the rest. */
  engravability: Omit<LabelEngravability, 'polygons'>[];
  /** `engraveRegions`' findings — `validateJob` + `validateVise` + engravability + the #171 void warning (#288). */
  findings: JobFinding[];
  /**
   * The blank's colour split, mm below the engraved face and ON a real layer line (#285), or null
   * when the job states no print. Read off the same `engraveRegions` call the cuts come from, so
   * the line the panel draws and the `item-depth-bound` finding agree by construction.
   */
  colourBoundaryDepth: Mm | null;
  /** #211's cutter recommendation, with the compromise message completed here (see below). */
  recommendation: ToolRecommendation;
}

/** The preview worker, one per worker. Mirrors `SimSession`'s shape. */
export interface EngravePreviewer {
  /**
   * Build the preview for `job`, or `null` when `gen` is older than one already seen
   * (the same stale-generation rule as `frameAt` in `session.ts`).
   *
   * `tools` is the resolved tool REGISTRY snapshot, handed in because this runs inside the sim
   * worker, where no store and no module state of the app's is visible (#305). It answers two
   * questions at once: which cutter the job names (`toolForJob`, the job's own snapshot first)
   * and what the recommendation (#211) may rank — one list, so the panel's picker and the
   * recommendation it reads beside can never be listing two different sets of cutters.
   *
   * `catalogue` is Makera's feed rows, handed in for the same reason (#324): the recommendation's
   * feeds pre-filter resolves with them, and this worker's own copy of that snapshot is empty.
   *
   * `margins` is the job's depth thresholds as the main thread resolved them (#345), handed in for
   * the same reason again: reading them here would need `useSettingsStore`, and a preview drawn to
   * a different margin than the run uses would show a void floor the verifier does not enforce.
   *
   * `conditions` is the inventory's condition summaries by registry key (#442), handed in for the
   * same reason a fourth time: `toolCondition`'s map lives on the main thread, so the recommendation
   * below would see a bench with no cutter marked worn or broken at all.
   *
   * `shop` is the engrave shop defaults this realm cannot read (#451) — here only
   * `engrave.lostDetailWarnRatio`, which sets both the `item-detail-lost` bar the findings use and
   * the `qualifies` bar the recommendation ranks against. See {@link EngraveShopOpts}.
   */
  engravePreview(
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    margins: EngraveMargins,
    conditions: ReadonlyMap<string, ConditionSummary>,
    shop?: EngraveShopOpts,
  ): EngravePreview | null;
}

/** `perChar` for a job: one single-character glyph profile per character, in text order. */
function perCharFor(job: EngraveJob): (labelId: string) => PerCharGlyph[] {
  return (labelId) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return [];
    return [...label.text].map((char) => ({
      char,
      profile: labelProfile({ ...label, text: char }, job.customFonts),
    }));
  };
}

/**
 * `ratioAt` for a job at a given cutter radius: re-typeset one label at a candidate cap height
 * and re-measure only that label. Injected into `engravabilityFindings` so a finding's
 * measurement and its message name the same cutter (#201 review, #211).
 */
function ratioAtFor(
  tl: ManifoldToplevel,
  job: EngraveJob,
  radius: number,
): LabelRatioAt {
  return (labelId, size) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return 0;
    // `shapes: []` — the probe re-typesets ONE label at a candidate cap height; carrying the
    // job's shapes would make every probe re-measure every shape too. The answer is unchanged
    // (`[0]` is the label) but the work is not (#205 review).
    const probe: EngraveJob = { ...job, shapes: [], labels: [{ ...label, size }] };
    return (
      measureLabels(tl, toPartPlan(probe), radius, job.edgeMargin, perCharFor(probe))[0]?.ratio ?? 0
    );
  };
}

/**
 * #211's `recommendTool` deliberately left the size suggestion out of its compromise message
 * (it has no way to re-measure at a larger cap height). The worker can: compose #201's
 * `suggestCapHeight` for the worst label with the recommended cutter's radius and append
 * "Try N mm or more" — or "Choose a smaller cutter." when no tried size reaches the ratio.
 * No other path computes a size (#211 review).
 */
function completeCompromiseReason(
  tl: ManifoldToplevel,
  job: EngraveJob,
  rec: ToolRecommendation,
  tools: readonly ToolLibraryEntry[],
  lostDetailWarnRatio: number | null = null,
): string {
  if (!rec.compromise || rec.key === null) return rec.reason;
  const pick = rec.candidates.find((c) => c.key === rec.key);
  const worst = pick?.worst;
  if (!worst) return rec.reason;
  const label = job.labels.find((l) => l.id === worst.labelId);
  const entry = tools.find((e) => e.key === rec.key);
  if (!label || !entry) return rec.reason;
  const r = cuttingRadiusForSweep(entry.tool);
  if (!r.ok) return rec.reason;
  const ratioAt = ratioAtFor(tl, job, r.radius);
  const suggested = suggestCapHeight((size) => ratioAt(worst.labelId, size), label.size, lostDetailWarnRatio);
  const hint = suggested === null ? 'Choose a smaller cutter.' : `Try ${suggested} mm or more.`;
  return `${rec.reason} ${hint}`;
}

export function createEngravePreviewer(tl: ManifoldToplevel): EngravePreviewer {
  let latestGen = Number.NEGATIVE_INFINITY;

  const engravePreview = (
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    margins: EngraveMargins,
    conditions: ReadonlyMap<string, ConditionSummary>,
    shop: EngraveShopOpts = {},
  ): EngravePreview | null => {
    if (gen < latestGen) return null;
    latestGen = gen;

    // #288 — the measurement, the findings and the cuts ALL come from `engraveRegions`, the same
    // call `engraveGenerate` makes, so the picture is drawn from the polygons the CAM is handed and
    // a second, drifting measurement cannot exist. That includes the #171 void warning the panel
    // shows while the label is being placed (#270's trace sweep included) — it is the run's own
    // list, not a copy of it. `perChar` stays local: `recommendTool` re-measures at each candidate
    // cutter's own radius below, which is the preview's own question and no other module's.
    const perChar = perCharFor(job);
    // The job's own snapshot wins over its key's entry (design point 2, #305), resolved against
    // the list the main thread sent — the worker has no registry of its own to read.
    const tool = toolForJob(job, tools);
    const { plan, measured, cuts, findings, colourBoundaryDepth } = engraveRegions(tl, job, tool, margins, shop);

    // A label whose findings include an error is left out of the cut — the stock is drawn
    // uncut there — but its row and findings are still reported (the issue's rule).
    const errored = new Set(
      findings.filter((f) => f.severity === 'error' && f.labelId !== undefined).map((f) => f.labelId as string),
    );

    // #432 — a faced job is drawn as the blank that REMAINS after the skim. The document's cuts
    // are all written from the faced top, which is this preview's Z = 0, so the extrusion is the
    // blank's thickness less the facing depth and it is still translated to put that face at 0.
    // Nothing else moves: the cuts, the floors and the fixture keep the frame they were built in,
    // and a job that does not face is drawn exactly as before.
    const facingDepth = plan.facing?.depth ?? 0;
    // A facing depth past the blank is a `facing-too-deep` error; there is no body to draw, so the
    // preview falls back to the blank as it arrived rather than extruding a negative height.
    const facedThickness = job.stock.thickness - facingDepth > 0 ? job.stock.thickness - facingDepth : job.stock.thickness;
    const stockCS = executeProfile(tl, plan.stock.outline);
    const stockBody = tl.Manifold.extrude(stockCS, facedThickness);
    stockCS.delete();
    // The prism extrudes from z = 0 up; translate so the TOP face is at Z = 0 (cuts at −Z).
    const placedStock = stockBody.translate([0, 0, -facedThickness]);
    stockBody.delete();

    // Each body keeps its depth: the cumulative states below are built by subtracting one depth
    // group at a time, so the slider can stop between cut depths without a second geometry pass.
    const cutBodies: { body: ManifoldInstance; depth: number }[] = [];
    const floors: EngravePreviewFloor[] = [];

    // One pass over `cuts` — labels, shapes (#214), drills (#220) and traces (#219) alike. Each
    // carries its own polygons and its own depth already, so this loop is about Manifold, not about
    // item kinds: a class added to `cuts` is drawn without anything here changing (#288).
    //
    // A cut whose item has an ERROR finding is left out — the "drawn uncut, still reported" rule
    // below — and every class reports with `labelId` set to the item's own id, drills and traces
    // included (`jobSetup.ts`), so one `errored` set covers them all.
    for (const cut of cuts) {
      if (cut.polygons.length === 0) continue;
      if (errored.has(cut.id)) continue;

      const openedCS = executeProfile(tl, { kind: 'p-poly', contours: cut.polygons });

      // The cut: the opened region from −depth up PAST the top face (OVERSHOOT_MM, `sweep.ts`),
      // so the subtraction never has a coplanar face at Z = 0 to fight with.
      const cutBody = tl.Manifold.extrude(openedCS, cut.depth + OVERSHOOT_MM);
      cutBodies.push({ body: cutBody.translate([0, 0, -cut.depth]), depth: cut.depth });
      cutBody.delete();

      // The floor: the same opened region as a sliver at the cut's bottom. A drill and a trace have
      // one too — a plunge and a swept flat end mill both leave a FLAT bottom at `depth`, which is
      // exactly what a pocketed region leaves — so `floors` stays "the bottom of every cut" and the
      // viewport's depth ramp gives a groove the same colour treatment a pocket gets.
      const floorBody = tl.Manifold.extrude(openedCS, FLOOR_THICKNESS_MM);
      const floorSolid = floorBody.translate([0, 0, -cut.depth]);
      floorBody.delete();
      floors.push({ labelId: cut.id, depth: cut.depth, mesh: meshOutputOf(floorSolid) });
      floorSolid.delete();

      openedCS.delete();
    }

    // §5.7 — the cumulative states the design ↔ as-cut slider steps through, built in the same
    // pass as the finished stock. Subtracting one depth group at a time is exactly as correct as
    // the one-shot difference (`(blank − A) − B = blank − (A ∪ B)`) and costs one difference per
    // distinct depth, with each body deleted as soon as the group it belongs to is applied. The
    // first stage is the uncut design; the finished state stays `stock`, so the deepest body is
    // meshed and transferred once.
    const stages: EngravePreviewStage[] = [];
    // With no cuts the faced blank IS the final state; the slider then has nothing to scrub.
    let stock: ManifoldInstance = placedStock;
    if (cutBodies.length > 0) {
      stages.push({ depth: 0, mesh: meshOutputOf(placedStock) });
      const byDepth = new Map<number, ManifoldInstance[]>();
      for (const { body, depth } of cutBodies) {
        const group = byDepth.get(depth);
        if (group) group.push(body);
        else byDepth.set(depth, [body]);
      }
      const depths = [...byDepth.keys()].sort((a, b) => a - b);
      let running = placedStock;
      for (let i = 0; i < depths.length; i++) {
        const depth = depths[i]!;
        const group = byDepth.get(depth)!;
        const next = tl.Manifold.difference([running, ...group]);
        // The state just consumed, and every body it applied, are no longer needed. `next` becomes
        // the base for the following depth, and the last one becomes `stock`.
        running.delete();
        for (const body of group) body.delete();
        if (i < depths.length - 1) {
          stages.push({ depth, mesh: meshOutputOf(next) });
          running = next;
        } else {
          stock = next;
        }
      }
    }
    const stockMesh = meshOutputOf(stock);
    stock.delete();

    // §5.7 — the LOST LAYER: for every region item, the ideal design MINUS the opening the cutter
    // actually leaves. `measureLabels` has already evaluated that opening (and its area, which the
    // panel's ratio is built on); this is the same subtraction materialised once for the picture, so
    // the amber region and the row's "N % kept" can never describe different cutters.
    //
    // The design area exists only for `plan.engraves`: a drill's design is the cutter's own disc and
    // a trace's is a centre line, so neither class loses anything here. An item with an ERROR
    // finding is left uncut by the loop above and is deliberately NOT painted as lost too — the
    // finding already says it is not cut, and a blanket of amber over the whole glyph would read as
    // a cutter limitation rather than the refusal it is. An item with no measurement (the cutter
    // cannot open a region at all) makes no lost claim either, the same "nothing measured, nothing
    // claimed" rule `measureEngraving` follows.
    const measuredById = new Map(measured.map((m) => [m.labelId, m] as const));
    const lost: EngravePreviewLost[] = [];
    for (const engrave of plan.engraves) {
      if (errored.has(engrave.id)) continue;
      const opening = measuredById.get(engrave.id);
      if (!opening || opening.glyphArea <= 0) continue;

      const designCS = executeProfile(tl, engrave.profile);
      // An entirely-dropped glyph has an empty opening, and `ofPolygons([])` throws — so the whole
      // design is the lost region in that case, without an empty as-cut side to subtract.
      let lossCS: ReturnType<typeof executeProfile>;
      if (opening.polygons.length === 0) {
        lossCS = designCS;
      } else {
        const openedCS = executeProfile(tl, { kind: 'p-poly', contours: opening.polygons });
        lossCS = tl.CrossSection.difference([designCS, openedCS]);
        designCS.delete();
        openedCS.delete();
      }

      const area = lossCS.area();
      if (area <= LOST_MIN_AREA_MM2) {
        lossCS.delete();
        continue;
      }
      const polygons = lossCS.toPolygons() as [number, number][][];
      // The sliver sits on the face (z = 0 … +thickness), not at the cut's floor: this is material
      // the cut did not remove, so the face it annotates is the one it belongs against.
      const sliver = tl.Manifold.extrude(lossCS, LOST_THICKNESS_MM);
      const mesh = meshOutputOf(sliver);
      sliver.delete();
      lossCS.delete();
      lost.push({ labelId: engrave.id, area, polygons, mesh });
    }

    const fixture: EngravePreviewFixture[] = viseEnvelope(job.stock, job.workholding.vise, job.sacrificial).boxes.map(
      (box) => {
        const solid = boxSolid(tl, box);
        const mesh = meshOutputOf(solid);
        solid.delete();
        return { id: box.id, label: box.label, mesh };
      },
    );

    // The sacrificial material (#213), one mesh per box, from the same `sacrificialBoxes` the
    // sweep and the verifier consume — never hand-computed here. Each box is an axis-aligned
    // solid, so `boxSolid` (the sweep's own builder) is the right constructor and there is no
    // union to materialise (no ONE MANIFOLD TRAP path).
    const sacrificial: EngravePreviewSacrificial[] = sacrificialBoxes(job.stock, job.sacrificial).map(
      (box) => {
        const solid = boxSolid(tl, { id: box.id, label: SACRIFICIAL_LABEL[box.id], min: box.min, max: box.max });
        const mesh = meshOutputOf(solid);
        solid.delete();
        return { id: `sacrificial-${box.id}`, label: SACRIFICIAL_LABEL[box.id], mesh };
      },
    );

    // The declared under-surface voids (#271). `plan.stock.keepOuts` already drops the disabled
    // ones, so what is drawn is exactly what the verifier reserves — a void the user switched
    // off is not in this list and not in the limit either. Each footprint is evaluated once here;
    // `keepOutFindings` evaluates its own copy for the warning, and both come from the same
    // `keepOutProfile`, so the outline and the warning name the same region.
    const voids: EngravePreviewVoid[] = plan.stock.keepOuts.map((ko) => {
      const footprintCS = executeProfile(tl, ko.footprint);
      const rings = footprintCS.toPolygons() as [number, number][][];
      footprintCS.delete();
      const membrane = keepOutMembrane(job, ko.zCeiling);
      return {
        id: ko.id,
        name: ko.name,
        zCeiling: ko.zCeiling,
        membrane,
        limit: keepOutLimit(job, membrane, margins.boundaryMargin),
        rings,
      };
    });

    // #211's rule, measured with each candidate's OWN radius, over the list the caller sent —
    // the same list the picker offers (#305), so a recommendation can never point at a cutter
    // the user cannot choose. With the built-ins alone that is two cutters, so the "early stop
    // for long lists" rule (measure in ascending diameter, stop after the first failure that
    // follows a pass) does not apply yet: until the list is long, measure them all.
    const recommendation = recommendTool(
      job,
      tools,
      catalogue,
      (key) => {
        const entry = tools.find((e) => e.key === key);
        if (!entry) return [];
        const r = cuttingRadiusForSweep(entry.tool);
        return r.ok ? measureLabels(tl, plan, r.radius, job.edgeMargin, perChar) : [];
      },
      // #442 — the bench's own condition summaries, sent with the job because this realm has none.
      conditions,
      // #451 — the same warn ratio the findings above were built with, so the recommendation's
      // "qualifies" bar and `item-detail-lost` cannot disagree about which cutters keep detail.
      shop.lostDetailWarnRatio ?? null,
      // #450 slice 3 — the same feeds table the run's `feedsFor` resolves against, so a cutter the
      // location's table covers is not excluded here for want of a compiled row (or the reverse).
      shop.feeds ?? undefined,
    );

    return {
      stock: stockMesh,
      stages,
      floors,
      fixture,
      sacrificial,
      voids,
      lost,
      engravability: measured.map(({ polygons: _polygons, ...rest }) => rest),
      findings,
      colourBoundaryDepth,
      recommendation: {
        ...recommendation,
        reason: completeCompromiseReason(tl, job, recommendation, tools, shop.lostDetailWarnRatio ?? null),
      },
    };
  };

  return { engravePreview };
}
