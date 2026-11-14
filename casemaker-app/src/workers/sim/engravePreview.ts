/**
 * The engrave preview (#205): the stock with EVERY cut the program will make removed to its own
 * depth — a label's or shape's opened region, a drill's holes (#220), a trace's swept groove
 * (#219/#287) — the floor of each cut, the vise jaws and the sacrificial material (#213) —
 * evaluated in the sim worker. A V-bit trace's groove is the CONE swept along its path, not its
 * mouth extruded straight down (#420 slice 4): the body comes from `engraveGroove`, which reads
 * the same `vProfile.ts` the CAM and the simulator do.
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
import {
  toPartPlan,
  keepOutLimit,
  keepOutMembrane,
  labelProfile,
  traceSweptProfile,
} from '@/engine/cnc/engrave/partPlan';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { clampPlacementsFor, dedupeFindings, fixtureMountOf, jobSetups, setupTools, toolItemsFor } from '@/engine/cnc/engrave/jobSetup';
import { setupPrograms } from '@/engine/cnc/engrave/programs';
import { restDepthShortfallFindings } from '@/engine/cnc/engrave/restPass';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { jobVise } from '@/engine/cnc/fixture';
import { viseBody } from '@/engine/cnc/drawnVise';
import { bracketMount } from '@/engine/cnc/mounts/bracket';
import type { ObstacleBox } from '@/engine/cnc/setup';
import { sacrificialBoxes, type SacrificialBox } from '@/engine/cnc/sacrificial';
import { cuttingRadiusForSweep } from '@/engine/cnc/tool';
import { toolForJob } from '@/engine/cnc/toolRegistry';
import { withCatalogueEntries, withCatalogueValues } from '@/engine/cnc/engrave/catalogueTool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { recommendTool, type ToolRecommendation } from '@/engine/cnc/engrave/recommendTool';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { boxSolid, OVERSHOOT_MM } from '@/workers/geometry/sweep';
import { manifoldOfTriangles, meshOutputOf, type NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { primitiveCavityProfile, surfacePrimitivesOf } from '@/engine/cnc/engrave/primitiveSurface';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { rotationMatrix, targetPlacement } from '@/engine/cnc/engrave/targetScale';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { type ProbeResiduals } from '@/engine/cnc/probePlan';
import { grooveRadiusAt, vCone } from '@/engine/cnc/vProfile';
import { chamferBandFor, type ChamferBand } from '@/engine/cnc/engrave/targetRim';
import { vGrooveSolid } from './engraveGroove';
import {
  registrationBandsFor,
  type EngravePreviewRegistrationBand,
} from './engraveRegistration';
import {
  measureLabels,
  suggestCapHeight,
  type LabelEngravability,
  type LabelRatioAt,
  type PerCharGlyph,
} from './engraveGeometry';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { engraveRegions, raisedTextMeasure, type EngraveShopOpts } from './engraveGenerate';

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

/**
 * One of a V-carve's three outlines (#221), in the work frame. The SURFACE is the opening at the
 * top face (depth 0), the PLANE is the design at the colour plane (or the floor when the blank has
 * no film), and the FLOOR is the pocket bottom at the item's depth. Drawn as lines only — the
 * cutting solid is the surface opening, and the floor is already a mesh.
 */
export interface EngravePreviewOutline {
  labelId: string;
  level: 'surface' | 'plane' | 'floor';
  /** Depth below the top face at which the outline is drawn, mm. Positive. */
  depth: number;
  /** Contours, outer CCW and holes CW, one entry per ring. */
  rings: [number, number][][];
}

/**
 * #829 — THE 3D CHAMFER'S BAND, drawn on the rim it will be cut along: for every rim chain, the
 * edge itself and the line the bevel's inner mouth reaches (`width` toward the part), both at the
 * rim's own height. Two rings per chain, in the work frame, so the operator sees what the V
 * program will cut before Generate.
 */
export type EngravePreviewChamferBand = ChamferBand;

/**
 * One drawn vise piece — a jaw or the body — from `viseBody` (#508). It sits where the user SAID
 * it is (un-inflated) and does NOT grow with the stock: the collision model is `viseEnvelope`,
 * which is a different thing.
 */
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
 * #811 — WHAT THE GOAL MAKES, DRAWN. A stated goal is not a hole in the preview's stock mesh: its
 * drawing is a separate volume built from the same parsed mesh and the same placed frame the CAM
 * samples, so the picture and the cut describe one part.
 *
 * `item` draws the part standing proud in the material colour, with the rest of the blank — the
 * volume the program clears — as the translucent removed overlay. `mold` draws the cavity: the
 * part's volume clipped to the blank, in the removed colour, inside the ghosted stock.
 */
export interface EngravePreviewGoal {
  /** Which drawing this is: the part itself, or the mold cavity. */
  mode: 'item' | 'mold';
  /** item: the part as placed, in the material colour. Null when it is not a closed solid (and always for a mold). */
  part: NodeMeshOutput | null;
  /** The volume the program removes: item = the blank minus the part; mold = the cavity. */
  removed: NodeMeshOutput | null;
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
  /**
   * The surface, colour-plane and floor outlines of every V-carve region (#221). Empty for a flat
   * cutter, whose three outlines are one and the same polygon set and are already the cut body.
   */
  outlines: EngravePreviewOutline[];
  /** #829 — the 3D chamfer's band on the goal's rim, or empty when the goal asks for none. */
  chamferBands: EngravePreviewChamferBand[];
  /** The drawn vise — two jaw bars and the body — from `viseBody` (#508). */
  fixture: EngravePreviewFixture[];
  /** The sacrificial material (#213), from `sacrificialBoxes`; empty when the job has none. */
  sacrificial: EngravePreviewSacrificial[];
  /** The declared under-surface voids (#271), enabled ones only; empty when the job has none. */
  voids: EngravePreviewVoid[];
  /**
   * §5.4/§5.7 — the registration band: one translucent strip per edge or earlier-cut feature the
   * first setup's approved registration references, or the datum edges a single setup's mount
   * already holds. Empty when the mount holds no datum and nothing was planned.
   */
  registration: EngravePreviewRegistrationBand[];
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
  /**
   * #748 — the floor each item sits on, mm below the top face: the pocket a label is written into
   * is here at its depth. Missing ids are on the stock's top face (0). Read off the same
   * `engraveRegions` call as the cuts, so the V-carve row's plane arithmetic, the sheet and the
   * merge findings all describe one floor. (Not to be confused with `floors` above, the drawn
   * mesh per cut.)
   */
  supportingFloors: Record<string, number>;
  /**
   * #811 — the goal's drawn volume, in the work frame, or null when the job states no mesh goal
   * (a reference object is not cut), the goal is a picture relief, the bytes are not loaded, the
   * job is on a rod (the rotary view draws its own relief), or the triangles are not a closed
   * solid. Absent means the viewport keeps its pre-#811 drawing.
   */
  goal: EngravePreviewGoal | null;
  /**
   * #822 — the cone/sphere primitives whose cavity the preview draws: the same analytic field the
   * surface program cuts, revolved into a solid and subtracted from the blank at its own depth.
   * Empty when the job has none (and then the picture is exactly the pre-#822 one).
   */
  surfaces: EngravePreviewSurface[];
  /** #211's cutter recommendation, with the compromise message completed here (see below). */
  recommendation: ToolRecommendation;
}

/** #822 — one drawn cavity, in the primitive's own words for the legend. */
export interface EngravePreviewSurface {
  id: string;
  name: string;
  kind: 'cone' | 'sphere';
  /** How far below the top face the cavity reaches, mm. */
  depthMm: number;
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
   *
   * `residuals` is the shop's five registration residuals (#451), handed in for the same reason:
   * the registration band must draw the tolerance the location would use, and this realm can only
   * read the labelled no-service fallbacks. #1241 — REQUIRED: the caller names the map it read
   * (`probeResiduals(shop.defaults)` on the main thread), so a realm that forgets fails to compile.
   */
  engravePreview(
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    margins: EngraveMargins,
    conditions: ReadonlyMap<string, ConditionSummary>,
    shop: EngraveShopOpts | undefined,
    residuals: ProbeResiduals,
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
  // #1244 — the map from the caller's edge; null: no location, the recommendations.
  defaults: ShopDefaults | null,
): LabelRatioAt {
  return (labelId, size) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return 0;
    // `shapes: []` — the probe re-typesets ONE label at a candidate cap height; carrying the
    // job's shapes would make every probe re-measure every shape too. The answer is unchanged
    // (`[0]` is the label) but the work is not (#205 review).
    const probe: EngraveJob = { ...job, shapes: [], labels: [{ ...label, size }] };
    return (
      measureLabels(tl, toPartPlan(probe, { defaults }), radius, job.edgeMargin, perCharFor(probe))[0]?.ratio ?? 0
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
  lostDetailWarnRatio: number | null,
  defaults: ShopDefaults | null,
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
  const ratioAt = ratioAtFor(tl, job, r.radius, defaults);
  const suggested = suggestCapHeight((size) => ratioAt(worst.labelId, size), label.size, lostDetailWarnRatio);
  const hint = suggested === null ? 'Choose a smaller cutter.' : `Try ${suggested} mm or more.`;
  return `${rec.reason} ${hint}`;
}

/**
 * #811 — THE GOAL'S DRAWN VOLUMES, from the mesh the CAM samples and the frame the viewport draws
 * with (`targetPlacement`, shared). Null when there is nothing honest to build: no mesh goal, a
 * picture or missing bytes (both have no triangles), or triangles Manifold will not close.
 *
 * The bodies are materialised into leaves by a mesh round-trip before the caller keeps them: a
 * Manifold boolean is LAZY and shares its inputs' children (ONE MANIFOLD TRAP, playback.ts), and
 * the blank it was subtracted from is deleted before the next preview asks for this drawing.
 */
function goalDrawingBody(
  tl: ManifoldToplevel,
  target: EngraveTargetObject,
  blank: ManifoldInstance,
): { mode: 'item' | 'mold'; part: NodeMeshOutput | null; removed: NodeMeshOutput | null } | null {
  const mode: 'item' | 'mold' = target.goalMode === 'mold' ? 'mold' : 'item';
  let parsed: ReturnType<typeof targetObjectMesh>;
  try {
    parsed = targetObjectMesh(target);
  } catch {
    return null;
  }
  const placement = targetPlacement(target, mode);
  const m = rotationMatrix(placement.turns);
  const { x: sx, y: sy, z: sz } = placement.scale;
  // The parser's local origin is the bbox centre in X/Y and the TOP in Z (the placement contract
  // in `EngraveTargetObject`); `targetPlacement` says where that origin lands after the turn.
  const cx = (parsed.bbox.min[0] + parsed.bbox.max[0]) / 2;
  const cy = (parsed.bbox.min[1] + parsed.bbox.max[1]) / 2;
  const top = parsed.bbox.max[2];
  const src = parsed.positions;
  const moved = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = (src[i]! - cx) * sx;
    const y = (src[i + 1]! - cy) * sy;
    const z = (src[i + 2]! - top) * sz;
    moved[i] = m[0]! * x + m[1]! * y + m[2]! * z + placement.at.x;
    moved[i + 1] = m[3]! * x + m[4]! * y + m[5]! * z + placement.at.y;
    moved[i + 2] = m[6]! * x + m[7]! * y + m[8]! * z + placement.at.z;
  }
  const body = manifoldOfTriangles(tl, moved, parsed.indices);
  if (body === null) return null;

  // Both volumes are MESHED before anything is deleted: each boolean is lazy and shares the body
  // as a child, so forcing its mesh must happen while every input handle still exists.
  let part: NodeMeshOutput | null = null;
  // No initialiser: both branches assign it and the catch re-nulls it, so one here is a dead store
  // (#919). `part` keeps its `null` — a throw before its branch leaves it unset.
  let removed: NodeMeshOutput | null;
  try {
    if (mode === 'mold') {
      // The cavity is drawn where the cut is: the turned part clipped to the blank (#784 clips the
      // sampler to the same rectangle), so an oversized goal shows exactly the walls it leaves.
      const cavity = tl.Manifold.intersection([body, blank]);
      removed = cavity.status() === 'NoError' ? meshOutputOf(cavity) : null;
      cavity.delete();
    } else {
      part = meshOutputOf(body);
      const rest = tl.Manifold.difference([blank, body]);
      removed = rest.status() === 'NoError' ? meshOutputOf(rest) : null;
      rest.delete();
    }
  } catch {
    removed = null;
  } finally {
    body.delete();
  }
  if (part === null && removed === null) return null;
  return { mode, part, removed };
}

/**
 * #811 — the drawing's cache key: everything the two volumes depend on. Edits elsewhere in the
 * job (a label's text, the cutter) rebuild the preview but must not re-run the boolean, and the
 * goal's own row is what changes this string.
 */
function goalDrawingKey(job: EngraveJob, facingDepth: number, defaults: ShopDefaults | null): string | null {
  const target = job.targetObject;
  if (target === undefined || !target.enabled) return null;
  if ((target.role ?? 'reference') !== 'goal') return null;
  if (target.format === 'png' || target.data === undefined) return null;
  // The rotary view draws its own radial relief (#723 R-3); a flat goal drawing here would be a
  // volume the rod's CAM never removes.
  if (rotaryMapOf(job, defaults) !== null) return null;
  const s = target.scale;
  return [
    target.sha256,
    target.goalMode === 'mold' ? 'mold' : 'item',
    target.position.x,
    target.position.y,
    target.position.z,
    s?.x ?? 1,
    s?.y ?? 1,
    s?.z ?? 1,
    target.rotation,
    target.rotationX ?? 0,
    target.rotationY ?? 0,
    target.size.x,
    target.size.y,
    target.size.z,
    job.stock.length,
    job.stock.width,
    job.stock.thickness,
    facingDepth,
  ].join('|');
}

/**
 * A copy of one cached drawing mesh: the worker transfers the buffers it returns, so the cache
 * keeps its own copy and hands out a fresh one per preview.
 */
function copyMesh(m: NodeMeshOutput | null): NodeMeshOutput | null {
  return m === null
    ? null
    : { ...m, positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) };
}

export function createEngravePreviewer(tl: ManifoldToplevel): EngravePreviewer {
  let latestGen = Number.NEGATIVE_INFINITY;
  /** #811 — the compiled goal drawing, keyed by {@link goalDrawingKey}. */
  let goalCache: { key: string; drawing: EngravePreviewGoal } | null = null;

  const engravePreview = (
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    margins: EngraveMargins,
    conditions: ReadonlyMap<string, ConditionSummary>,
    shop: EngraveShopOpts = {},
    residuals: ProbeResiduals,
  ): EngravePreview | null => {
    if (gen < latestGen) return null;
    latestGen = gen;

    // §5.4 — the registration band is derived from the job's first setup and is independent of
    // the geometry pass: plain rectangles, no Manifold, so it costs nothing beside the cuts.
    const registration = registrationBandsFor(job, residuals);

    // #288 — the measurement, the findings and the cuts ALL come from `engraveRegions`, the same
    // call `engraveGenerate` makes, so the picture is drawn from the polygons the CAM is handed and
    // a second, drifting measurement cannot exist. That includes the #171 void warning the panel
    // shows while the label is being placed (#270's trace sweep included) — it is the run's own
    // list, not a copy of it. `perChar` stays local: `recommendTool` re-measures at each candidate
    // cutter's own radius below, which is the preview's own question and no other module's.
    const perChar = perCharFor(job);
    // The job's own snapshot wins over its key's entry (design point 2, #305), resolved against
    // the list the main thread sent — the worker has no registry of its own to read.
    //
    // #786 slice 4c-2 — THE PREVIEW CUTS WITH THE SAME FILLED TOOL THE RUN WILL. A blank tip or
    // flute filled from the catalogue row for the same g_ID is part of the tool here, not only in
    // `engraveGenerate`: the preview's cone, its predictions and the regions all read the same
    // values, so the picture cannot disagree with the program. The entries are enriched too, so a
    // candidate cutter the recommendation measures carries its catalogue values as well.
    const catalogueEntries = withCatalogueEntries(tools);
    const resolvedTool = toolForJob(job, catalogueEntries);
    const tool = resolvedTool === null ? null : withCatalogueValues(resolvedTool, catalogueEntries).tool;
    // #786 slice 6 — the job's OWN SNAPSHOT is enriched too, exactly as `engraveGenerate` does
    // (there at the top of `engraveRegions`' caller): `validateJob` reads `jobTool(job)`, and the
    // snapshot wins over the list, so a blank base diameter that the catalogue states would
    // otherwise still refuse the chamfer here while the run cuts it.
    const judgedJob =
      job.tool === undefined || job.tool === null
        ? job
        : { ...job, tool: withCatalogueValues(job.tool, catalogueEntries).tool };
    const { plan, measured, cuts, findings: regionFindings, colourBoundaryDepth, floors: supportingFloors } = engraveRegions(
      tl,
      judgedJob,
      tool,
      margins,
      { ...shop, tools: catalogueEntries },
      null,
      catalogue,
    );

    // #865 — A REST PROGRAM'S OWN SHORTFALL, on the panel too. The preview judges the document
    // with the job's own cutter (program 1); a rest pass planned at a V's cone height leaves the
    // design's floor standing, and the engine's finding for it is raised inside that program's own
    // generation. The preview does not generate the rest file, so the same sentence is built here
    // from the plan's design depths and the rest cutter, tagged with the program it belongs to.
    const restFindings: JobFinding[] = [];
    {
      const refs = setupPrograms(job);
      // A facing file is the run's first program when it exists, so the numbering shifts by one.
      const offset = job.facing !== undefined && job.facing.enabled && job.facing.depth > 0 ? 1 : 0;
      refs.forEach((ref, i) => {
        if (ref.itemIds.length > 0) return; // a rest cutter owns no items
        const restTool =
          ref.toolKey === job.toolKey ? tool : (catalogueEntries.find((e) => e.key === ref.toolKey)?.tool ?? null);
        if (restTool === null) return;
        const tag = `program ${i + 1 + offset} (${toolDisplayName(restTool).split(' · ')[0]!})`;
        for (const f of restDepthShortfallFindings(plan, restTool)) {
          restFindings.push({ ...f, message: `${tag}: ${f.message}` });
        }
      });
    }
    const findings = dedupeFindings([...regionFindings, ...restFindings]);

    // #743 P-6 review — AN ITEM NO SETUP ASSIGNS IS NOT MEASURED AGAINST A CUTTER THAT WILL NEVER CUT
    // IT. The preview judges the whole document with the job's own cutter; an item the setups leave
    // unassigned (its kind of cutter is not in the library) belongs to no program, so its "nothing
    // reachable" is not a fault of the design — the unassigned warning states it and Generate posts
    // the rest. A job with no assignment at all (no cutter yet) keeps every finding it had.
    //
    // #743 P-8 — AND THE SAME IS TRUE OF AN ITEM ANOTHER CUTTER OWNS. A board arrives as several
    // programs (an engraver isolates, drills make the holes, a flat frees the board); the preview
    // holds ONE cutter, so measuring the cut-out against the engraver reports "it needs a flat end
    // mill", and measuring the isolation against the flat reports "nothing this cutter can reach".
    // Both are true of a program that will never cut that item and false of the run: each item's
    // OWN program is measured when Generate posts it. Only the five sentences that say "this item
    // and THIS cutter do not fit" are withheld — a geometry fault stays, whatever cutter is held.
    const FIT_CODES = new Set(['item-empty', 'item-chars-lost', 'item-detail-lost', 'cutout-needs-flat', 'raised-text-fused']);
    const ownerByItem = new Map<string, string>();
    for (const setup of jobSetups(job)) {
      const keys = setupTools(setup, job);
      keys.forEach((key, i) => {
        for (const id of toolItemsFor(setup, key, i)) ownerByItem.set(id, key);
      });
    }
    const foreign = (id: string | undefined): boolean => {
      if (id === undefined) return false;
      const owner = ownerByItem.get(id);
      return owner !== undefined && owner !== job.toolKey;
    };
    const unowned = (id: string | undefined): boolean =>
      id !== undefined && ownerByItem.size > 0 && !ownerByItem.has(id);
    const liveFindings = findings.filter((f) => !((unowned(f.labelId) || foreign(f.labelId)) && FIT_CODES.has(f.code)));

    // #420 slice 4 — a V-bit trace's cut is the cone dragged along its path, not its mouth
    // extruded straight down. The cone comes from the same `vCone` the oracle and the column
    // engine resolve, and the trace's own geometry comes from the plan those cuts were built
    // from, so the tapered body and the swept prediction describe one cutter and one path.
    const cone = tool === null ? null : vCone(tool);
    const traceById = new Map(plan.traces.map((t) => [t.id, t] as const));

    // A label whose findings include an error is left out of the cut — the stock is drawn
    // uncut there — but its row and findings are still reported (the issue's rule). #786 slice 5:
    // an `item-empty` finding is a warning now, and an item that opens nothing is still not a
    // LOST layer — the finding states it cuts nothing; amber would read as a cutter limitation.
    const errored = new Set(
      liveFindings
        .filter((f) => f.labelId !== undefined && (f.severity === 'error' || f.code === 'item-empty'))
        .map((f) => f.labelId as string),
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

    // #811 — THE GOAL'S DRAWN VOLUMES, built while the blank is alive and cached across the
    // previews its own row did not change. `placedStock` is the faced blank, the same body the
    // cuts below are subtracted from; the drawing never consumes it (the boolean is lazy but its
    // result is materialised inside `goalDrawingBody`).
    const goalKey = goalDrawingKey(job, facingDepth, shop.defaults ?? null);
    const goalTarget = job.targetObject;
    if (goalKey === null || goalTarget === undefined) {
      goalCache = null;
    } else if (goalCache?.key !== goalKey) {
      goalCache = null;
      const built = goalDrawingBody(tl, goalTarget, placedStock);
      if (built !== null) goalCache = { key: goalKey, drawing: built };
    }

    // Each body keeps its depth: the cumulative states below are built by subtracting one depth
    // group at a time, so the slider can stop between cut depths without a second geometry pass.
    const cutBodies: { body: ManifoldInstance; depth: number }[] = [];
    const floors: EngravePreviewFloor[] = [];
    const outlines: EngravePreviewOutline[] = [];

    // One pass over `cuts` — labels, shapes (#214), drills (#220) and traces (#219) alike. Each
    // carries its own polygons and its own depth already, so this loop is about Manifold, not about
    // item kinds: a class added to `cuts` is drawn without anything here changing (#288). The one
    // exception is a V-bit trace, whose polygons are only its MOUTH; its body is the cone swept
    // along the path (#420 slice 4), built above from the same trace the cut came from.
    //
    // A cut whose item has an ERROR finding is left out — the "drawn uncut, still reported" rule
    // below — and every class reports with `labelId` set to the item's own id, drills and traces
    // included (`jobSetup.ts`), so one `errored` set covers them all.
    // #674 — a FLUTE is drawn per SEGMENT: one cone solid for each step of the plan's own depth
    // profile, unioned into one body at the trace's deepest point. The ordinary V branch below
    // sweeps the WHOLE path at one tip depth, which is exactly what a flute is not; a flat flute
    // goes through `cuts` like any flat trace (each segment is its own swept region).
    for (const trace of plan.traces) {
      if (trace.depths === undefined || cone === null || errored.has(trace.id)) continue;
      const pieces: ManifoldInstance[] = [];
      for (let pi = 0; pi < trace.paths.length; pi++) {
        const path = trace.paths[pi]!;
        const depths = trace.depths[pi];
        if (depths === undefined || path.length === 0) continue;
        const last = (trace.closed[pi] ?? false) ? path.length : path.length - 1;
        for (let j = 0; j < last; j++) {
          // The move's DEEP end — the same reduction the sweep makes (#629).
          const depth = Math.max(depths[j] ?? 0, depths[(j + 1) % path.length] ?? 0);
          if (!(depth > 0)) continue;
          const a = path[j]!;
          const b = path[(j + 1) % path.length]!;
          const piece = vGrooveSolid(tl, [[[a[0], a[1]], [b[0], b[1]]]], [false], cone, depth, OVERSHOOT_MM);
          if (piece !== null) pieces.push(piece);
        }
      }
      if (pieces.length === 0) continue;
      if (pieces.length === 1) {
        cutBodies.push({ body: pieces[0]!, depth: trace.depth });
      } else {
        const body = tl.Manifold.union(pieces);
        for (const piece of pieces) piece.delete();
        cutBodies.push({ body, depth: trace.depth });
      }
    }

    for (const cut of cuts) {
      if (cut.polygons.length === 0) continue;
      if (errored.has(cut.id)) continue;

      // #420 slice 4 — a V-bit TRACE is drawn as the cone swept along its path: the mouth at the
      // top face and the tip's own flat at the floor. Its floor is the tip reach, not the mouth
      // footprint the straight cuts use, so the picture and the oracle agree at both levels.
      // #674 — a fluted trace was drawn per segment above; its cut entries are skipped here.
      const trace = traceById.get(cut.id);
      if (trace !== undefined && trace.depths !== undefined) continue;
      if (trace !== undefined && cone !== null) {
        const groove = vGrooveSolid(tl, trace.paths, trace.closed, cone, cut.depth, OVERSHOOT_MM);
        if (groove !== null) {
          cutBodies.push({ body: groove, depth: cut.depth });
          // A sharp tip closes the floor to a line: there is nothing with area to draw.
          const floorRadius = grooveRadiusAt(cone, 0);
          if (floorRadius > 0) {
            const floorCS = executeProfile(tl, traceSweptProfile(trace.paths, trace.closed, floorRadius));
            const floorBody = tl.Manifold.extrude(floorCS, FLOOR_THICKNESS_MM);
            floorCS.delete();
            const floorSolid = floorBody.translate([0, 0, -cut.depth]);
            floorBody.delete();
            floors.push({ labelId: cut.id, depth: cut.depth, mesh: meshOutputOf(floorSolid) });
            floorSolid.delete();
          }
        }
        // A V trace is never fallen back to a cylinder: if its cone cannot be swept there is no
        // honest body to draw, and a straight slot would be the very disagreement this fixes.
        continue;
      }

      // A V-carve's stock removal is its SURFACE opening at the top face, and its floor is the
      // floor polygon set — narrower than the design by `e·tanHalf` per side (#221). A flat cut
      // has one polygon set for all three, exactly as before.
      const carve = cut.vCarve;
      const bodyPolygons = carve?.surface ?? cut.polygons;
      const floorPolygons = carve?.floor ?? cut.polygons;

      if (bodyPolygons.length > 0) {
        const openedCS = executeProfile(tl, { kind: 'p-poly', contours: bodyPolygons });
        // The cut: the opening from −depth up PAST the top face (OVERSHOOT_MM, `sweep.ts`), so the
        // subtraction never has a coplanar face at Z = 0 to fight with.
        const cutBody = tl.Manifold.extrude(openedCS, cut.depth + OVERSHOOT_MM);
        cutBodies.push({ body: cutBody.translate([0, 0, -cut.depth]), depth: cut.depth });
        cutBody.delete();
        openedCS.delete();
      }

      // The floor: a sliver at the cut's bottom. A drill and a trace have one too — a plunge and a
      // swept flat end mill both leave a FLAT bottom at `depth` — so `floors` stays "the bottom of
      // every cut" and the viewport's depth ramp gives a groove the same treatment a pocket gets.
      if (floorPolygons.length > 0) {
        const floorCS = executeProfile(tl, { kind: 'p-poly', contours: floorPolygons });
        const floorBody = tl.Manifold.extrude(floorCS, FLOOR_THICKNESS_MM);
        const floorSolid = floorBody.translate([0, 0, -cut.depth]);
        floorBody.delete();
        floors.push({ labelId: cut.id, depth: cut.depth, mesh: meshOutputOf(floorSolid) });
        floorSolid.delete();
        floorCS.delete();
      }

      if (carve !== undefined) {
        const outline = (level: EngravePreviewOutline['level'], depth: number, rings: [number, number][][]) => {
          if (rings.length > 0) outlines.push({ labelId: cut.id, level, depth, rings });
        };
        // #748 — the surface opening is drawn at the surface the item sits on: the stock's top
        // face, or the pocket floor a label is written into.
        outline('surface', carve.floorDepth ?? 0, carve.surface);
        outline('plane', carve.planeDepth, carve.plane);
        outline('floor', cut.depth, carve.floor);
      }
    }

    // #822 — THE SURFACE PRIMITIVES' CAVITIES JOIN THE CUTS. Each is the analytic field the
    // surface program cuts, revolved into a closed solid and subtracted at the primitive's own
    // depth, so the stock shows the hole where the program makes it and the slider steps through
    // it with the other cuts. A mesh Manifold will not close is left out (the picture is honest
    // about what it cannot draw; the program still cuts it).
    const surfaceCavities: { preview: EngravePreviewSurface; body: ManifoldInstance }[] = [];
    for (const primitive of surfacePrimitivesOf(job)) {
      const profile = primitiveCavityProfile(primitive);
      if (profile === null) continue;
      const crossSection = tl.CrossSection.ofPolygons([profile]);
      // The revolve turns (radius, depth) about the axis into a solid rising in +Z; the turn puts
      // the cavity's opening on the stock's top face, where the program cuts it.
      const body = crossSection.revolve(96).rotate([180, 0, 0]).translate([primitive.position.x, primitive.position.y, 0]);
      crossSection.delete();
      if (body.status() !== 'NoError') {
        body.delete();
        continue;
      }
      surfaceCavities.push({
        preview: {
          id: primitive.id,
          name: primitive.name ?? primitive.id,
          kind: primitive.kind,
          depthMm: primitive.depth,
        },
        body,
      });
    }
    for (const cavity of surfaceCavities) cutBodies.push({ body: cavity.body, depth: cavity.preview.depthMm });

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
      if (errored.has(engrave.id) || unowned(engrave.id)) continue;
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

    // #725 W2 — the fixture is the JOB's mount, the same boxes the verifier checks: the vise's
    // jaws for a vise job, the bracket's arms and the job's own clamps for a bracket job, and
    // nothing above the part for tape (the tape is under the stock). A bed job used to be drawn
    // with the vise's jaws, a fixture that is not on the machine at all.
    const mountKind = fixtureMountOf(job);
    const fixtureBoxes: ObstacleBox[] =
      mountKind === 'bracket'
        ? (bracketMount(
            { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
            'bracket',
            shop.defaults ?? null,
            job.sacrificial.under?.thickness ?? 0,
            clampPlacementsFor(job),
          )?.fixture.boxes ?? [])
        : mountKind === 'vise'
          ? viseBody(job.stock, jobVise(job), job.sacrificial).boxes
          : [];
    const fixture: EngravePreviewFixture[] = fixtureBoxes.map((box) => {
      const solid = boxSolid(tl, box);
      const mesh = meshOutputOf(solid);
      solid.delete();
      return { id: box.id, label: box.label, mesh };
    });

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
    // #760 — one raised-text measurement, shared by every candidate the recommendation asks about.
    const raisedText = raisedTextMeasure(tl, job, shop.defaults ?? null, plan);
    const recommendation = recommendTool(
      job,
      // #786 slice 4c-2 — the candidates carry their catalogue values too: a cutter whose tip the
      // catalogue states must qualify for a V job the run would cut with that same tip.
      catalogueEntries,
      catalogue,
      shop.defaults ?? null,
      (key) => {
        const entry = catalogueEntries.find((e) => e.key === key);
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
      // #760 — and the same raised measurement `raised-text-fused` makes, so the recommendation
      // never calls a cutter that joins the letters one that "keeps every item intact".
      (key) => {
        const entry = catalogueEntries.find((e) => e.key === key);
        return entry ? raisedText(entry.tool) : [];
      },
    );

    // #766 — THE MEASURED SEARCH IS DELIBERATELY NOT RUN HERE. Its per-candidate measures cost
    // seconds in a cold process (the coin's search was 21.3 s of a 39.6 s CLI run), and this
    // function runs on the panel's debounce and must draw immediately. The rule recommendation
    // below is the quick answer; the measured pick is the CLI's no-cutter path and Generate's
    // question today, and an explicit panel action when one is added (the same `smartPick`,
    // `evaluatePlan` seam, called once and cached).
    // #829 — THE CHAMFER'S BAND, on the rim the V program will follow: the part's top edge and
    // the line its bevel's inner mouth reaches, drawn from the mesh itself so the picture and
    // the CAM cannot disagree. A mesh whose bytes are not here draws nothing; its own finding
    // says so.
    const chamferBands: EngravePreviewChamferBand[] = [];
    const chamferGoal = job.targetObject;
    if (
      chamferGoal !== undefined &&
      (chamferGoal.role ?? 'reference') === 'goal' &&
      chamferGoal.enabled &&
      chamferGoal.format !== 'png' &&
      chamferGoal.chamfer !== undefined &&
      chamferGoal.chamfer.widthMm > 0
    ) {
      try {
        const band = chamferBandFor(chamferGoal);
        if (band !== null) chamferBands.push(band);
      } catch {
        // No bytes here: the goal's own `target-mesh-missing` finding is the sentence.
      }
    }

    return {
      stock: stockMesh,
      stages,
      floors,
      outlines,
      chamferBands,
      fixture,
      sacrificial,
      voids,
      registration,
      lost,
      engravability: measured.map(({ polygons: _polygons, ...rest }) => rest),
      findings: liveFindings,
      colourBoundaryDepth,
      supportingFloors,
      goal:
        goalCache === null
          ? null
          : {
              mode: goalCache.drawing.mode,
              part: copyMesh(goalCache.drawing.part),
              removed: copyMesh(goalCache.drawing.removed),
            },
      // #822 — the cavities the stock above was cut by, for the legend's caption.
      surfaces: surfaceCavities.map((c) => c.preview),
      recommendation: {
        ...recommendation,
        reason: completeCompromiseReason(tl, job, recommendation, catalogueEntries, shop.lostDetailWarnRatio ?? null, shop.defaults ?? null),
      },
    };
  };

  return { engravePreview };
}
