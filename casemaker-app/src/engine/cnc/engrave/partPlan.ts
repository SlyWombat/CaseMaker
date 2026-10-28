import { glyphProfile } from '@/engine/compiler/glyphs';
import { DEFAULT_INLAY_GLUE_GAP_MM } from './inlay';
import { textureCarries, textureNumbers, textureOperationName, textureStrokes } from './texture';
import { fluteNumbers, fluteOperationName, fluteProfile } from './flute';
import { prismNumbers, prismRingProfile } from './prism';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import {
  aabbOfProfile,
  circleProfile,
  pDifference,
  pHull,
  pOffset,
  pRotate,
  pTranslate,
  pUnion,
  poly,
  rectProfile,
  roundedRect,
  type Profile,
} from '@/engine/compiler/profile';
import { resolveFont } from '@/engine/fonts/registry';
import { strokeGlyphPaths, boldStrokePasses } from '@/engine/fonts/stroke/strokeFont';
import type {
  CutoutTabs,
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveCutout,
  EngraveDrill,
  EngraveJob,
  EngraveKeepOut,
  EngraveLabel,
  EngravePrimitive,
  EngraveShape,
  EngraveStrokeLabelItem,
  EngraveThread,
  EngraveTraceItem,
  EngraveVectorShape,
} from '@/types/engraveJob';
import type { CustomFont } from '@/types/textLabel';
import { FASTENERS } from '@/engine/compiler/fasteners';
import type { Mm } from '@/types/units';
import { jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import type { FixtureEnvelope } from '@/engine/cnc/setup';
import { supportedFootprint } from '@/engine/cnc/sacrificial';
import { getTools, sweepRadiusForJob, toolForJob } from '@/engine/cnc/toolRegistry';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveChamfer } from '@/types/engraveJob';
import { grooveWidthAt, vCone } from '@/engine/cnc/vProfile';
import { defaultBoundaryMargin, voidFloor, voidMargin } from '@/engine/cnc/engrave/depthBounds';
import { inkBoxOf, type InkBox, type InkMeasure } from '@/engine/cnc/engrave/inkBox';
import { printedLayerGridOf, voidCeilingFor } from '@/engine/cnc/layerStack';
import { rotaryMapOf, type RotaryMap } from '@/engine/cnc/rotary/wrap';
import type { DepthLimit, ThroughMask } from '@/engine/cnc/verify';
import { sacrificialDepthLimit } from '@/engine/cnc/verify';

/**
 * `PartPlan` is the seam #172 specified (`/Fabrication.md` §5.2): profiles and a target Z,
 * never a mesh. The compiler knows the region and the depth; a mesh discards both and forces
 * CAM to re-infer them.
 *
 * Two differences from the §5.2 sketch (#200):
 *  - `split` is OPTIONAL (#285): it is absent for every job but a two-colour blank — the part is
 *    printed PLA, and a blank that was not printed in two colours has no layer at which the colour
 *    changes. A badge job that states its print carries `split`/`layerHeight` here, and
 *    that is what lets the layer stack (#178) put the colour boundary on a real layer line; a job
 *    without them plans exactly as it did before and its depth limit stays analytic.
 *
 * `keepOuts` is NOT empty any more (#231 item 3): a job that declares an under-surface void
 * (#165's magnet pocket) carries it here, as the same `{ footprint, zCeiling }` #178's layer
 * stack reads. `id`/`name` are carried too — a structural superset of `LayerStackKeepOut` — so a
 * consumer (the run sheet) can name the void it is limiting around.
 */
export interface PartPlan {
  stock: {
    outline: Profile;
    /**
     * The PART OUTLINE ∪ every sacrificial footprint (#213 §3) — where the cutter has material
     * under it at all. With no sacrificial material this IS `outline`. The engravability check
     * measures an item's breach against THIS (inset by `edgeMargin`), so an item may run off the
     * part's edge exactly where there is strip or board beside it.
     */
    supported: Profile;
    thickness: Mm;
    /** Under-surface voids, in the stock XY frame; `zCeiling` is PART-frame z from the bottom. */
    keepOuts: { id: string; name: string; footprint: Profile; zCeiling: Mm }[];
    /**
     * The blank's colour change, PART-frame z from the bottom face — derived from
     * `EngraveJob.stock.colour.capMm` (#492, formerly `stock.print.split`, #285). ABSENT for a job
     * that states no two-colour facts, which is every single-colour blank: a part made in one colour
     * has no boundary for anything downstream to work from, and the depth limit stays analytic.
     *
     * The geometry is unchanged: the same child solids, the same solid model, the same colour
     * change height. Only WHERE the number comes from moved.
     */
    split?: Mm;
    /**
     * The slicer's layer height, mm (#285). Present exactly when `split` is AND the blank is
     * `kind: 'printed'` with a stated layer height — a purchased laminate has no printer grid, so
     * it carries `split` alone (#492).
     */
    layerHeight?: Mm;
    /** The first layer's own height, mm (#285); absent = the same as `layerHeight`. */
    firstLayerHeight?: Mm;
  };
  /**
   * #739 — RAISED TEXT: every enabled CUTAWAY that leaves construction labels standing. `field`
   * is the cutaway's own profile — its outer less every island, exactly the region the CAM
   * pockets — and `islands` are the construction labels' resolved profiles. Carried here so the
   * raised-text measurement opens the SAME profile the cutter does, rather than re-typesetting
   * the labels in the worker. Empty for a job with no such cutaway.
   */
  raisedTexts: {
    id: string;
    field: Profile;
    islands: { labelId: string; profile: Profile }[];
  }[];
  engraves: {
    id: string;
    name: string;
    profile: Profile;
    depth: Mm;
    through?: boolean;
    /**
     * #665 — the item asked for a MEDIAL-AXIS V-carve (`vCarveDepth: 'variable'`). Carried here so
     * the region builder, the CAM and the oracle get the flag from one funnel; read only when the
     * job's cutter is a cone.
     */
    variableDepth?: boolean;
    /**
     * #673 — the item is an INLAY half. Its design is the TOP BOUNDARY (the profile), not the
     * opening at a colour plane: the flank stands on the design at the top face and the floor is
     * the design eroded by the cut's whole depth. The glue gap travels with it because the CAM
     * bounds the floor's pass pitch by it (the ridges between passes must stay inside the gap).
     * Read only when the job's cutter is a cone.
     */
    inlay?: { role: 'female' | 'male'; glueGapMm: number };
    /**
     * #674 — the item is a RAISED PRISM. Its profile is the RING around the shape (the mouth), and
     * its design is the TOP BOUNDARY like an inlay's: the flank stands on the mouth at the top face
     * and the floor is the mouth eroded by the cut's whole depth. `baseMm` travels so the row, the
     * sheet and the finding quote one number. Read only when the job's cutter is a cone.
     */
    prism?: { baseMm: Mm };
  }[];
  /**
   * PROFILE CUT-OUTS (#218), a fifth sibling: the outline a `cam/profile.ts` path follows, plus
   * its side, inset, tab spec and the depth it cuts to. The OUTLINE is the referenced item's
   * profile in the stock frame, BEFORE the tool-radius offset — `cam/profile.ts` owns the
   * injected offset, exactly as `pocketLoops` does. `depth` is `thickness + breakthrough`, the
   * document's through depth, so the preview, the verifier and the CAM read one number.
   *
   * A cut-out whose `of` names an item that never resolved is absent here (the same rule as a
   * region item with a broken reference): `validateJob` reports the reference, and no path is
   * generated for it.
   */
  cutouts: {
    id: string;
    name: string;
    outline: Profile;
    side: 'outside' | 'inside';
    inset: Mm;
    depth: Mm;
    /** The blank's thickness, mm — the tab top is `-(thickness - tabs.height)`. */
    thickness: Mm;
    tabs: CutoutTabs;
  }[];
  /**
   * #669 — CHAMFERS along a rim, a seventh sibling. A chamfer is not a region: one closed bevel
   * follows an edge, cut by a cone's flank. The plan is tool-agnostic, so it carries the rim's
   * OUTLINE and the cut-out's own facts; the worker derives the edge, the tool offset (the tip
   * radius) and the depth (`width / tan(halfAngle)`) from the cutter it resolves.
   */
  chamfers: {
    id: string;
    name: string;
    /** The referenced rim's outline, stock frame — the item's own profile. */
    outline: Profile;
    /** The cutter's side of that outline: a part's edge (outside) or a pocket's rim (inside). */
    side: 'outside' | 'inside';
    /** The chamfer's width on the top face, mm. */
    width: Mm;
  }[];
  /**
   * SINGLE-LINE traces (#219), a SIBLING of `engraves` rather than more entries in it. A trace
   * is not a region — the cutter's centre follows the path, so the cut is one cutter wide and
   * the region pipeline (#201's opening, offsetting, pocketing) would erase it. CAM turns each
   * entry into a plunge/feed/retract operation; the preview and oracle read the swept region
   * `traceSweptProfile` derives from it.
   *
   * `paths` are in the STOCK frame, one polyline per path (a line item has one; a stroke label
   * one per pen stroke); `closed[i]` says whether `paths[i]` returns to its first point.
   */
  traces: {
    id: string;
    name: string;
    paths: [Mm, Mm][][];
    closed: boolean[];
    depth: Mm;
    /**
     * #674 — a FLUTE's Z profile: one DEPTH PER POINT (positive mm below the top face), parallel
     * to `paths`. Absent on an ordinary trace, which is cut at `depth` throughout. The CAM walks
     * the path with Z following it, and the prediction decomposes it per segment at each
     * segment's end depth — the same reduction both sweep engines make, so the file, the sim and
     * the oracle agree exactly.
     */
    depths?: Mm[][];
  }[];
  /**
   * PLUNGE DRILLS (#220), a third sibling of `engraves`/`traces`. A drill is not a region: the
   * cutter goes straight down at fixed XY and the hole is the cutter's own diameter, so there is
   * no profile to carry — just the hole centres. `name` is the tool-independent part of the
   * operation name (`Drill "port"`, `Drill 3×2 @10×10`); the region builder appends the diameter,
   * which only it knows, the way it already appends the depth.
   *
   * #668 — `mode` is `'drill'` (the plunge above) or `'bore'`, a HOLE TO SIZE helixed down by an
   * end mill; `diameter` is the HOLE's diameter in mm for a bore (`null` when the item states
   * none), and is not read for a drill. Both are carried so the region builder, the preview and
   * the oracle can put the hole's disc where the cut really removes material.
   */
  drills: {
    id: string;
    name: string;
    holes: [Mm, Mm][];
    depth: Mm;
    through: boolean;
    mode: 'drill' | 'bore';
    diameter: Mm | null;
    /** #675 — this item's own peck length, mm; absent = the program's own source binds. */
    peckMm?: Mm;
  }[];
  /**
   * MILLED THREADS (#445, #434 phase 2), a fourth sibling. A thread is not a region either: the
   * thread mill orbits inside a pilot that already exists, so there is no profile to carry — the
   * axis, the ISO size the geometry is derived from, and the threaded length. `name` is the
   * tool-independent operation name (`Thread "port" M5×0.8`); the CAM composes the rest.
   */
  threads: {
    id: string;
    name: string;
    position: [Mm, Mm];
    size: EngraveThread['size'];
    depth: Mm;
    through: boolean;
  }[];
  /**
   * FACING (#432), the job's own pass over the stock's top — `{ depth }` when it faces, `null`
   * otherwise. Not a sibling list: there is exactly one top, it is not an item, and nothing in
   * the panel selects it. It is carried here because CAM, the preview and the verifier must agree
   * on one number.
   *
   * `depth` is the TOTAL taken off, positive mm. The PASSES and the STEP-OVER are deliberately
   * absent: they come from the feeds row for the cutter and material, and `toPartPlan` takes the
   * job alone — resolving `feedsFor` here would need the tool and the catalogue, and would give a
   * second module an opinion about what a cutter may take. The CAM divides the two at generate
   * time. `stock.thickness` above stays the BLANK's thickness: every reader's frame is the blank,
   * and the faced surface is `facing.depth` below its top.
   */
  facing: { depth: Mm } | null;
}

/**
 * The text of one label as a `Profile` in the STOCK frame (front-left at the origin):
 * typeset with its cap height at the origin, centred on its bounding box, rotated about
 * that centre, then translated to `label.position`.
 *
 * `glyphProfile` returns the text with its baseline at the origin, so the placement is three
 * moves in this order (the order matters — rotating after centring keeps the rotation about
 * the text's own centre, not the stock origin).
 *
 * An empty or whitespace-only label yields an empty `p-poly`; it is kept in the plan so
 * #201 can report it rather than the job silently losing a row.
 */
export function labelProfile(label: EngraveLabel, customFonts: readonly CustomFont[]): Profile {
  const glyphs = glyphProfile(label.text, resolveFont(label.font, label.weight, customFonts), label.size);
  const box = aabbOfProfile(glyphs);
  if (!box) return glyphs; // whitespace-only: nothing to centre or place
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const centred = pTranslate([-cx, -cy], glyphs);
  const rotated = pRotate(label.rotation, centred);
  return pTranslate([label.position.x, label.position.y], rotated);
}

/**
 * The app's own typesetter as a measuring stick: the ink box of `text` at cap height `size`, or
 * `null` when that face has not been parsed yet (#180).
 *
 * The ONE implementation of `InkMeasure`, and it lives here rather than beside any caller because it
 * is built out of this module's `labelProfile`: that function typesets at the origin, centred on the
 * line's own ink box, so a probe at (0, 0) hands the box straight back. Its readers — the seed that
 * lays a line out (`blankLabelSeed`), the store's re-depth walk, the panel's row, and the jaw reach
 * behind the jaw reach and depth recommendation (`labelJawReach`, #394) and §3's stop line — must
 * measure the same box, or a line can be laid out clear of a void and then advised the void's depth
 * anyway (#365), or charged a stop it does not come near (#394).
 *
 * The call THROWS on an unparsed face (`resolveFont`), and the wizard's hand-off happens before any
 * panel or worker has called `ensureFontsLoaded`, so a miss is expected there: it answers `null`,
 * which is the caller's cue to fall back to `inkBoxOf`'s documented upper bound.
 */
export function labelGlyphMeasure(customFonts: readonly CustomFont[]): InkMeasure {
  return (text, font, weight, size) => {
    try {
      const box = aabbOfProfile(
        labelProfile(
          {
            id: 'measure-probe',
            text,
            font,
            weight,
            size,
            position: { x: 0, y: 0 },
            rotation: 0,
            depth: 1,
            enabled: true,
          },
          customFonts,
        ),
      );
      return box ? { width: box.max[0] - box.min[0], height: box.max[1] - box.min[1] } : null;
    } catch {
      return null;
    }
  };
}

/** The region item kinds: the simple shapes (#214), the combined kinds (#215) and vectors (#217). */
type EngraveRegionItem = EngraveShape | EngraveCombinedShape | EngraveVectorShape;

/** Is this item one of the shape kinds (#214/#215/#217) rather than a text label? */
function isShape(item: EngraveAnyItem): item is EngraveRegionItem {
  return 'kind' in item;
}

/**
 * The item ids an item references (#215). A `frame` names one outline to follow; a `cutaway`
 * names the outline to clear plus the islands to leave standing. Everything else references
 * nothing.
 */
export function itemReferences(item: EngraveAnyItem): string[] {
  if (!isShape(item)) return [];
  switch (item.kind) {
    case 'frame':
      return [item.around];
    case 'cutaway':
      return [item.outer, ...item.islands];
    default:
      return [];
  }
}

/** Why an `item-reference` error fired (#215). */
export type ItemReferenceIssue = 'missing' | 'disabled' | 'self' | 'cycle';

/** A bad reference from one item to another (#215) — the data behind an `item-reference` finding. */
export interface ItemReferenceError {
  /** The item doing the referencing. */
  itemId: string;
  /** The id it names. */
  referencedId: string;
  reason: ItemReferenceIssue;
}

export interface ResolvedItems {
  /** Enabled, resolvable items in dependency order: every referenced item precedes its referrer. */
  order: EngraveAnyItem[];
  /** One entry per bad reference. An item with any error is absent from `order`. */
  errors: ItemReferenceError[];
}

/**
 * Topologically order a job's items and report every broken reference (#215).
 *
 * The three combined kinds name other items, so an item must be resolved before the item that
 * follows it. A reference that does not exist, points at a DISABLED item, points at itself, or
 * closes a cycle cannot produce a region: the referencing item is dropped from `order` (so
 * nothing is ever generated for it) and an error is recorded instead of throwing.
 *
 * Items with no references keep their document order, so a pre-#215 job's plan is unchanged.
 */
export function resolveItems(job: EngraveJob): ResolvedItems {
  const all: EngraveAnyItem[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.vectors ?? []),
  ];
  const byId = new Map<string, EngraveAnyItem>();
  for (const item of all) if (!byId.has(item.id)) byId.set(item.id, item);

  const errors: ItemReferenceError[] = [];
  const order: EngraveAnyItem[] = [];
  // 0 = unvisited, 1 = on the stack, 2 = resolved, 3 = unresolvable.
  const state = new Map<string, number>();
  const cyclic = new Set<string>();
  const stack: string[] = [];

  const visit = (item: EngraveAnyItem): boolean => {
    const s = state.get(item.id) ?? 0;
    if (s === 2) return true;
    if (s === 3) return false;
    if (s === 1) {
      // A back edge: everything from `item` up the stack is part of a cycle, so none of it
      // can resolve. Mark them all and report.
      const from = stack.indexOf(item.id);
      for (let k = from; k < stack.length; k++) {
        cyclic.add(stack[k]!);
        state.set(stack[k]!, 3);
      }
      return false;
    }

    state.set(item.id, 1);
    stack.push(item.id);
    let ok = true;
    for (const ref of itemReferences(item)) {
      if (ref === item.id) {
        errors.push({ itemId: item.id, referencedId: ref, reason: 'self' });
        ok = false;
        continue;
      }
      const target = byId.get(ref);
      if (!target) {
        errors.push({ itemId: item.id, referencedId: ref, reason: 'missing' });
        ok = false;
        continue;
      }
      if (!target.enabled) {
        errors.push({ itemId: item.id, referencedId: ref, reason: 'disabled' });
        ok = false;
        continue;
      }
      if (!visit(target)) {
        // The target exists and is enabled but could not resolve: a cycle, or a chain that
        // runs into one (or into a missing/disabled item further along).
        errors.push({ itemId: item.id, referencedId: ref, reason: cyclic.has(ref) ? 'cycle' : 'missing' });
        ok = false;
      }
    }
    stack.pop();
    if (ok) {
      state.set(item.id, 2);
      order.push(item);
      return true;
    }
    state.set(item.id, 3);
    return false;
  };

  // Only ENABLED items can cut; a disabled item can never be a valid target (that is a
  // 'disabled' error above), and it produces no region of its own.
  for (const item of all) if (item.enabled) visit(item);

  return { order, errors };
}

/**
 * The operation's display name for an item (#214, work item 4) — the DESCRIPTOR only, without
 * the `[T#]` prefix or the depth suffix. `generateEngrave` composes those, so the name on the
 * `;@MKR|TOOLPATH` line reads `[T1]Pocket rect 20×10 1.0mm`, `[T1]Pocket circle ⌀6 2.0mm`, ….
 *
 * It lives HERE, next to `itemProfile`, because the kind and size it words live on the item;
 * the CAM layer receives the finished string on `EngraveRegion.name` and stays free of the
 * document's shape fields. It deliberately parallels `itemLabel` (`jobSetup.ts`) but does not
 * share its wording: a FINDING reads `Rectangle 20×10`, an OPERATION reads `Pocket rect 20×10`.
 */
export function itemOperationName(item: EngraveAnyItem, verb: 'Pocket' | 'Prism' = 'Pocket'): string {
  if (!isShape(item)) return `Engrave "${item.text}"`;
  const named = item.name ? ` "${item.name}"` : '';
  switch (item.kind) {
    case 'rect':
      return `${verb} rect${named} ${item.width}×${item.height}`;
    case 'circle':
      return `${verb} circle${named} ⌀${item.diameter}`;
    case 'slot':
      return `${verb} slot${named} ${item.length}×${item.width}`;
    case 'polygon':
      return `${verb} polygon${named} (${item.points.length} points)`;
    case 'border':
      return `${verb} border${named} ${item.width} wide, ${item.inset} in`;
    case 'frame':
      return `${verb} frame${named} ${item.width} wide, ${item.gap} gap`;
    case 'cutaway':
      return `${verb} cutaway${named} (${item.islands.length} island${item.islands.length === 1 ? '' : 's'})`;
    case 'vector': {
      const n = item.contours.length;
      return `${verb} outline${named} (${n} contour${n === 1 ? '' : 's'}, ${item.width}×${item.height}mm)`;
    }
  }
}

/**
 * Which 3D primitives (#435) reduce to a flat-floor REGION the existing CAM can cut: a box or a
 * cylinder opening straight down from the top face. Every other form — a cone's sloped wall, a
 * sphere's curved floor, any side-opening axis — is refused by name in `validateJob` and never
 * reaches `engraves`. The predicate lives HERE, beside the reduction it guards, so the plan and
 * the findings cannot disagree about what is cuttable.
 */
export function primitiveReducesToRegion(primitive: EngravePrimitive): boolean {
  if ((primitive.axis ?? 'z') !== 'z') return false;
  return primitive.kind === 'box' || primitive.kind === 'cylinder';
}

/**
 * The operation's display name for a primitive (#435) — the descriptor only, like
 * `itemOperationName`; the CAM appends the depth and the tool prefix.
 */
export function primitiveOperationName(primitive: EngravePrimitive): string {
  const named = primitive.name ? ` "${primitive.name}"` : '';
  switch (primitive.kind) {
    case 'box':
      return `Pocket box${named} ${primitive.width}×${primitive.height}`;
    case 'cylinder':
      return `Pocket cylinder${named} ⌀${primitive.diameter}`;
    case 'cone':
      return `Cone${named} ⌀${primitive.diameter}→⌀${primitive.tipDiameter}`;
    case 'sphere':
      return `Sphere${named} ⌀${primitive.diameter}`;
  }
}

/** A primitive in a finding's sentence: `Box "lid" 20×10`, `Sphere ⌀8`. */
export function primitiveLabel(primitive: EngravePrimitive): string {
  const named = primitive.name ? ` "${primitive.name}"` : '';
  switch (primitive.kind) {
    case 'box':
      return `Box${named} ${primitive.width}×${primitive.height}`;
    case 'cylinder':
      return `Cylinder${named} ⌀${primitive.diameter}`;
    case 'cone':
      return `Cone${named} ⌀${primitive.diameter}→⌀${primitive.tipDiameter}`;
    case 'sphere':
      return `Sphere${named} ⌀${primitive.diameter}`;
  }
}

/**
 * A cuttable primitive as a `Profile` centred on the ORIGIN and unrotated, exactly like
 * `shapeProfile`: a rectangle for a box, a circle for a cylinder, with the same explicit segment
 * count a round shape gets (#190). Only vertical box/cylinder forms reach here; a refused kind
 * yields the empty region rather than an invented one.
 */
function primitiveProfile(primitive: EngravePrimitive): Profile {
  if (primitive.kind === 'box') return rectProfile(primitive.width, primitive.height, true);
  if (primitive.kind === 'cylinder') {
    const radius = primitive.diameter / 2;
    return circleProfile(radius, segmentsForRadius(radius));
  }
  return poly([]);
}

/**
 * The operation name a profile cut-out reads (#218): `Cut out "badge" outside Pocket rect
 * 30×20`, or for the blank's own edge `Cut out stock inset 3 mm` (#726 P13 — the unit is a
 * separate word, as it is on every other length). It parallels `itemOperationName`, but the
 * referenced item's name is supplied by the caller because the cut-out itself holds only an id.
 */
/**
 * The operation's display name for a chamfer (#669) — the descriptor only, without the `[T#]`
 * prefix or the depth suffix. The rim is named where the caller knows it (the row, the findings,
 * the plan), because the chamfer records only its id.
 */
export function chamferOperationName(chamfer: EngraveChamfer, rimName: string | null): string {
  const named = chamfer.name ? ` "${chamfer.name}"` : '';
  return `Chamfer${named}${rimName === null ? '' : ` of ${rimName}`}`;
}

export function cutoutOperationName(cutout: EngraveCutout, targetName: string | null): string {
  const named = cutout.name ? ` "${cutout.name}"` : '';
  const target =
    cutout.of === 'stock-inset'
      ? `stock inset ${cutout.inset} mm`
      : (targetName ?? 'referenced item');
  return `Cut out${named} ${cutout.side} ${target}`;
}

/**
 * A shape pocket (#214) or imported outline (#217) as a `Profile`, centred on the ORIGIN and
 * unrotated: the caller places it. Every round primitive gets an EXPLICIT segment count from
 * `segmentsForRadius` (#190), because Manifold's default at a small radius is 4 segments and a
 * "round" shape would land as a square.
 *
 * - rect: `rectProfile` (already centred) or a shifted `roundedRect` (its bbox-min is at 0,0).
 * - circle: centred on the origin by construction.
 * - slot: the hull of two end discs at ±(L/2 − r) — straight sides, round ends.
 * - polygon: the points as given, relative to `position` (so the origin IS `position`).
 * - vector: the imported rings as given (already mm, already centred), with their own fill rule —
 *   `NonZero` keeps an SVG's oppositely-wound holes, `EvenOdd` makes every enclosed ring a hole.
 *
 * A keep-out footprint (#231) is one of the four simple kinds, so it lands here too — the void
 * profile and an engraved rect share one implementation.
 */
function shapeProfile(shape: EngraveShape | EngraveVectorShape | EngraveKeepOut): Profile {
  switch (shape.kind) {
    case 'rect': {
      const { width, height, cornerRadius } = shape;
      if (cornerRadius <= 0) return rectProfile(width, height, true);
      return pTranslate([-width / 2, -height / 2], roundedRect(width, height, cornerRadius));
    }
    case 'circle': {
      const radius = shape.diameter / 2;
      return circleProfile(radius, segmentsForRadius(radius));
    }
    case 'slot': {
      const radius = shape.width / 2;
      const segments = segmentsForRadius(radius);
      const halfCentre = shape.length / 2 - radius;
      return pHull([
        pTranslate([-halfCentre, 0], circleProfile(radius, segments)),
        pTranslate([halfCentre, 0], circleProfile(radius, segments)),
      ]);
    }
    case 'polygon':
      return poly(shape.points.map(([x, y]) => [x, y] as [number, number]));
    case 'vector':
      return { kind: 'p-poly', contours: shape.contours, fillRule: shape.fillRule };
  }
}

/**
 * What a reference-following kind (#215) needs to resolve: the stock outline a `border` offsets
 * in from, and the PLACED profile of any item a `frame` or `cutaway` names. `toPartPlan` builds
 * it while walking the topologically ordered items, so every target is already resolved.
 */
export interface ItemReferenceContext {
  /** The stock outline in the stock frame (front-left at the origin); `border` offsets in from it. */
  stockOutline: Profile;
  /** The placed stock-frame profile of item `id`, or null when it is absent from the plan. */
  profileOf(id: string): Profile | null;
}

/** The empty region an unresolved reference yields — never a crash, and no cut (#215). */
function emptyProfile(): Profile {
  return poly([]);
}

/** A ring between two offsets of one outline: `outer − inner` (#215). */
function ringProfile(outer: Profile, inner: Profile): Profile {
  return pDifference([outer, inner]);
}

/**
 * One engrave ITEM (#214/#215) as a `Profile` in the STOCK frame — the single entry point. A
 * text label keeps its own `labelProfile` placement; a simple shape is centred on the origin,
 * rotated about that point, then translated to `position`.
 *
 * The three combined kinds (#215) are DERIVED, so their inherited `position`/`rotation` are
 * ignored and `ctx` is required:
 *  - `border` = `offset(stock, −inset) − offset(stock, −inset − width)`.
 *  - `frame`  = `offset(target, gap + width) − offset(target, gap)`.
 *  - `cutaway` = `profile(outer) − ⋃ profile(islands)`.
 * A missing/disabled/cyclic reference yields an empty profile; `resolveItems` is what reports
 * it and `toPartPlan` never even calls `itemProfile` for such an item.
 */
export function itemProfile(
  item: EngraveAnyItem,
  customFonts: readonly CustomFont[],
  ctx?: ItemReferenceContext,
): Profile {
  if (!isShape(item)) return labelProfile(item, customFonts);
  switch (item.kind) {
    case 'border': {
      if (!ctx) return emptyProfile();
      const { stockOutline } = ctx;
      return ringProfile(
        pOffset(stockOutline, -item.inset, 'round'),
        pOffset(stockOutline, -(item.inset + item.width), 'round'),
      );
    }
    case 'frame': {
      const target = ctx?.profileOf(item.around) ?? null;
      if (!target) return emptyProfile();
      return ringProfile(
        pOffset(target, item.gap + item.width, 'round'),
        pOffset(target, item.gap, 'round'),
      );
    }
    case 'cutaway': {
      const outer = ctx?.profileOf(item.outer) ?? null;
      if (!outer) return emptyProfile();
      // #673 — a MALE inlay half cuts the complement AROUND the plug, and the plug must sit
      // inside the female's opening by the glue gap's slant (`g·tanθ`): the island is eroded by
      // the inset the male stored when it was built. A profile node, so the geometry worker
      // evaluates it — the preview, the CAM and the verifier all see the same edge.
      const inset = item.inlay?.role === 'male' ? (item.inlay.islandInsetMm ?? 0) : 0;
      const islands: Profile[] = [];
      for (const id of item.islands) {
        const island = ctx?.profileOf(id) ?? null;
        // A cutaway with a bad island reference does not resolve at all — `resolveItems` drops
        // it. Reaching here without a profile means an empty result rather than a half-cut panel.
        if (!island) return emptyProfile();
        islands.push(inset > 0 ? pOffset(island, -inset, 'round') : island);
      }
      return pDifference([outer, ...islands]);
    }
    default: {
      // A simple shape (#214): centred on the origin, rotated about that point, then placed.
      const placed = pRotate(item.rotation, shapeProfile(item));
      return pTranslate([item.position.x, item.position.y], placed);
    }
  }
}

/** Orientation sign of the turn p→q→r: +1 left, −1 right, 0 collinear. */
function orient(p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number {
  const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Is `r` within the bounding box of segment pq (collinear-touch test). */
function onSegment(
  p: readonly [number, number],
  q: readonly [number, number],
  r: readonly [number, number],
): boolean {
  return (
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1])
  );
}

function segmentsIntersect(
  a1: readonly [number, number],
  a2: readonly [number, number],
  b1: readonly [number, number],
  b2: readonly [number, number],
): boolean {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear touches: an endpoint lying on the other segment still self-intersects.
  if (o1 === 0 && onSegment(a1, a2, b1)) return true;
  if (o2 === 0 && onSegment(a1, a2, b2)) return true;
  if (o3 === 0 && onSegment(b1, b2, a1)) return true;
  if (o4 === 0 && onSegment(b1, b2, a2)) return true;
  return false;
}

/**
 * True when a closed point ring crosses itself, so it is not a simple region — the fill rule
 * would invent one from the crossing edges (#214). Adjacent edges share a vertex and are
 * ignored; any other pair touching (crossing, or a pinched vertex) counts.
 */
export function polygonSelfIntersects(points: readonly [number, number][]): boolean {
  const n = points.length;
  if (n < 3) return true;
  for (let i = 0; i < n; i++) {
    const a1 = points[i]!;
    const a2 = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Skip edge i's neighbours (they share a vertex by construction).
      if (j === (i + 1) % n) continue;
      if ((j + 1) % n === i) continue;
      const b1 = points[j]!;
      const b2 = points[(j + 1) % n]!;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------------------------------------------
 * Single-line traces (#219)
 *
 * A trace is NOT a region, so nothing here funnels through `itemProfile`, `engraves` or the
 * region-item switches: the cutter's centre rides the path, cutting a groove one cutter wide.
 * These three functions are the whole engine model — the CAM (`cam/trace.ts`) turns the paths
 * into moves, the preview and oracle read the swept region, and the validator reads the
 * self-overlap list. All pure and synchronous, like `toPartPlan`.
 * -------------------------------------------------------------------------------------------*/

/** Rotate `p` counter-clockwise by `deg` about the origin — the placement convention every item uses. */
function rotateAboutOrigin(p: readonly [number, number], deg: number): [number, number] {
  if (deg === 0) return [p[0], p[1]];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/** The bounding box of a set of polylines, or null when they hold no point at all. */
function pathsBounds(
  paths: readonly (readonly [Mm, Mm][])[],
): { min: [number, number]; max: [number, number] } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const [x, y] of path) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { min: [minX, minY], max: [maxX, maxY] };
}

/**
 * The open/closed polylines one trace item cuts, in the STOCK frame — the trace twin of
 * `itemProfile`.
 *
 * A `line`'s points are relative to `position`, so they are rotated about the origin and then
 * translated (the same order a simple shape uses). A `stroke-label` is typeset baseline-at-origin
 * (`strokeGlyphPaths`), centred on its bounding box, rotated about that centre and translated to
 * `position` — exactly `labelProfile`'s three moves, so the same text in a stroke font lands where
 * the outline-font label would.
 *
 * `tool` (#409) is the cutter the job names, and it is what the three new stroke-label fields are
 * about: the typeset layout needs the width a pass removes at the item's depth, so `spacing:
 * 'cut-width'` can open the gaps between glyphs to leave clear surface and a `weight` can widen
 * each stroke into parallel passes; `widthScale` condenses the line and needs no tool. The numbers
 * are computed HERE — the one place the job's tool is in scope — and handed to the pure typesetter;
 * with no tool, or a tool that is no cone (a flat end mill's cut width is its diameter, not a V's
 * depth-dependent opening), no numbers are computed and the layout is exactly the font's own, so a
 * tool-less job is unchanged. That `tool` is OPTIONAL so the pure callers (specs, the sim's own
 * region builder) need not have one.
 *
 * A blank stroke label yields no paths; `toPartPlan` then keeps it out of the plan rather than
 * emitting an empty operation.
 */
export function tracePaths(
  item: EngraveTraceItem,
  tool?: Tool | null,
): { paths: [Mm, Mm][][]; closed: boolean[]; groups: number[] } {
  if (item.kind === 'line') {
    const path = item.points.map(([x, y]): [Mm, Mm] => {
      const [rx, ry] = rotateAboutOrigin([x, y], item.rotation);
      return [rx + item.position.x, ry + item.position.y];
    });
    return { paths: [path], closed: [item.closed], groups: [0] };
  }

  // The cut width of ONE pass at this item's depth, from the job's tool, and the width it actually
  // reaches once a bold `weight` widens it. Null when the tool is absent or is not a cone.
  const width = strokeCutWidth(item, tool);

  // Spacing is OPT-IN (#409 review): `spacing: 'cut-width'` is the field that opens the glyph
  // gaps, so a job that states neither it nor `weight` lays out exactly as the font's own metrics
  // do — which is what keeps every stored V-bit job (the committed bench job included)
  // regenerating byte-for-byte. It needs the cone's cut width, so a tool-less or flat job is
  // unchanged either way.
  const gapWidth = item.spacing === 'cut-width' && width !== null ? width.cut : 0;
  let raw = strokeGlyphPaths(item.text, item.font, item.size, {
    widthScale: item.widthScale,
    minGapCutWidth: gapWidth,
  });
  if (raw.length === 0) return { paths: [], closed: [], groups: [] };
  // Bold: replace each stroke with the parallel passes that bring its cut up to `weight`. The
  // passes share the depth, so the floor is not re-cut below it; only a known, narrower single-pass
  // width can be widened, so a tool-less job (or a `weight` no wider than one pass) is untouched.
  const bold = width !== null && item.weight !== undefined && item.weight > width.natural;
  const sourceCount = raw.length;
  if (bold) raw = boldStrokePasses(raw, width.natural, item.weight!);
  // The passes of ONE source stroke are one group: they are meant to merge into a single wide
  // stroke, so the stroke-merge check must not report them against each other (only against other
  // strokes). A non-bold path is its own group, which restores the check's old behaviour exactly.
  const passes = bold ? raw.length / sourceCount : 1;
  const groups = raw.map((_, i) => Math.floor(i / passes));

  const box = pathsBounds(raw);
  const cx = box ? (box.min[0] + box.max[0]) / 2 : 0;
  const cy = box ? (box.min[1] + box.max[1]) / 2 : 0;
  const paths = raw.map((path) =>
    path.map(([x, y]): [Mm, Mm] => {
      const [rx, ry] = rotateAboutOrigin([x - cx, y - cy], item.rotation);
      return [rx + item.position.x, ry + item.position.y];
    }),
  );
  // `closed` stays false for stroke labels even where the font drew a RING: the data already
  // repeats the first point, so the CAM path is geometrically closed, and a true here would only
  // add a zero-length closing feed (and change every stored job's motion lines). The bold passes
  // join the seam themselves — `offsetPolyline` reads the repeated point (#409 low item).
  return { paths, closed: paths.map(() => false), groups };
}

/**
 * The width a `stroke-label`'s cut reaches on the blank, mm (#409): the width of ONE pass at the
 * item's depth for a V cone — `natural` — and the wider width a bold `weight` lifts it to — `cut`
 * (equal to `natural` when there is no bold, or the weight is no wider than one pass).
 *
 * `null` when the job's tool is absent, or is not a cone. A flat end mill's cut is its diameter at
 * every depth, and it never closes a letter, so both the layout (`tracePaths`) and the stroke-merge
 * check (`traceSelfOverlapFindings`) leave such a job exactly as it was — that is the "do not
 * regress a job with no tool" rule of #409, and the reason the two readers share this one number
 * rather than each guessing it.
 */
function strokeCutWidth(
  item: EngraveStrokeLabelItem,
  tool: Tool | null | undefined,
): { natural: number; cut: number } | null {
  const cone = tool ? vCone(tool) : null;
  if (cone === null) return null;
  const natural = grooveWidthAt(cone, item.depth);
  return { natural, cut: Math.max(natural, item.weight ?? 0) };
}

/**
 * The operation's display name for a trace — the DESCRIPTOR only, without the `[T#]` prefix or
 * the depth suffix, exactly as `itemOperationName` contracts: `generateTrace` composes the rest,
 * so the `;@MKR|TOOLPATH` line reads `[T1]Trace line (5 points, closed) 1.0mm`.
 */
export function traceOperationName(item: EngraveTraceItem): string {
  const named = item.name ? ` "${item.name}"` : '';
  if (item.kind === 'line') {
    const n = item.points.length;
    return `Trace line${named} (${n} point${n === 1 ? '' : 's'}${item.closed ? ', closed' : ''})`;
  }
  return `Trace text "${item.text}"${named}`;
}

/* ---------------------------------------------------------------------------------------------
 * Plunge drills (#220)
 * -------------------------------------------------------------------------------------------*/

/**
 * The hole centres of a drill item, in the job frame — one point for a `drill`, the whole lattice
 * for a `drill-array`. The lattice is laid out in the item's own frame (`i·pitch.x`, `j·pitch.y`)
 * and then rotated about `position` and translated, so the array's origin is its first hole and
 * `rotation` turns the grid without moving that first hole.
 *
 * The count is floored and clamped at 1: the schema rejects a fractional or zero count, but a
 * hand-edited file that slipped one through gets one hole rather than a NaN coordinate.
 */
export function drillHoles(drill: EngraveDrill): [Mm, Mm][] {
  if (drill.kind === 'drill') return [[drill.position.x, drill.position.y]];
  const nx = Math.max(1, Math.floor(drill.count.x));
  const ny = Math.max(1, Math.floor(drill.count.y));
  const holes: [Mm, Mm][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [rx, ry] = rotateAboutOrigin([i * drill.pitch.x, j * drill.pitch.y], drill.rotation);
      holes.push([rx + drill.position.x, ry + drill.position.y]);
    }
  }
  return holes;
}

/**
 * The operation's display name for a drill — the DESCRIPTOR only, without the `[T#]` prefix, the
 * diameter or the depth suffix, exactly as `itemOperationName` contracts. The diameter is not
 * known here (`toPartPlan` is tool-agnostic), so the region builder appends it: the `;@MKR|TOOLPATH`
 * line reads `[T1]Drill "port" ⌀3.175 2.0mm`. A BORE (#668) is the same item cut a different way,
 * so it names itself `Bore "port" ⌀4.5 3.0mm` — the same verb slot, the kind the operator picked.
 */
export function drillOperationName(drill: EngraveDrill): string {
  const verb = drill.mode === 'bore' ? 'Bore' : 'Drill';
  const named = drill.name ? ` "${drill.name}"` : '';
  if (drill.kind === 'drill') return `${verb}${named}`;
  return `${verb}${named} ${drill.count.x}×${drill.count.y} @${drill.pitch.x}×${drill.pitch.y}`;
}

/* ---------------------------------------------------------------------------------------------
 * Milled threads (#445)
 * -------------------------------------------------------------------------------------------*/

/**
 * The operation's display name for a thread — the DESCRIPTOR only, without the `[T#]` prefix and
 * the depth suffix, exactly as `itemOperationName` contracts. The THREAD is the item's own fact
 * (`M5×0.8`), so the size and its ISO 261 coarse pitch are named here; the cutter's diameter is
 * not, because D2 makes the item the authority and the cutter only supplies its own geometry.
 */
export function threadOperationName(thread: EngraveThread): string {
  const named = thread.name ? ` "${thread.name}"` : '';
  return `Thread${named} ${thread.size}×${FASTENERS[thread.size].pitch}`;
}

/**
 * The region a trace's cutter SWEEPS: the union of radius-`r` discs centred at every path point —
 * the capsules of its segments plus a cap at each free end. This is a trace's PREDICTED region for
 * the preview (#205) and the oracle (#206): a trace has no interior, so the usual region pipeline
 * (offset, pocket) would erase it, and the prediction has to be built from the path itself.
 *
 * Every disc carries an EXPLICIT segment count from `segmentsForRadius` (#190); Manifold's default
 * at a small radius is 4 segments and a "round" cap would land as a square. A one-point path (a
 * plunge dot) is a single disc.
 */
export function traceSweptProfile(
  paths: readonly (readonly [Mm, Mm][])[],
  closed: readonly boolean[],
  radius: Mm,
): Profile {
  if (radius <= 0) return poly([]);
  const segments = segmentsForRadius(radius);
  const disc = (p: readonly [Mm, Mm]): Profile =>
    pTranslate([p[0], p[1]], circleProfile(radius, segments));
  const parts: Profile[] = [];
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]!;
    const n = path.length;
    if (n === 0) continue;
    if (n === 1) {
      parts.push(disc(path[0]!));
      continue;
    }
    const isClosed = closed[pi] ?? false;
    const last = isClosed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = path[i]!;
      const b = path[(i + 1) % n]!;
      if (a[0] === b[0] && a[1] === b[1]) {
        parts.push(disc(a));
        continue;
      }
      // The hull of two equal discs is the capsule of the segment between them; its round ends
      // are the caps the cutter leaves at each vertex.
      parts.push(pHull([disc(a), disc(b)]));
    }
  }
  if (parts.length === 0) return poly([]);
  return parts.length === 1 ? parts[0]! : pUnion(parts);
}

/** One segment of one trace path, addressed for reporting. */
interface TraceSegment {
  path: number;
  segment: number;
  a: [Mm, Mm];
  b: [Mm, Mm];
}

/** Every segment of every path, in path order; a one-point path has none. */
function traceSegments(
  paths: readonly (readonly [Mm, Mm][])[],
  closed: readonly boolean[],
): TraceSegment[] {
  const out: TraceSegment[] = [];
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]!;
    const n = path.length;
    if (n < 2) continue;
    const last = (closed[pi] ?? false) ? n : n - 1;
    for (let i = 0; i < last; i++) {
      out.push({ path: pi, segment: i, a: path[i]!, b: path[(i + 1) % n]! });
    }
  }
  return out;
}

/** Shortest distance from `p` to segment `ab` (0 when `p` lies on it). */
function pointSegmentDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Shortest distance between two segments; 0 when they cross. */
function segmentDistance(
  a1: readonly [number, number],
  a2: readonly [number, number],
  b1: readonly [number, number],
  b2: readonly [number, number],
): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2),
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2),
  );
}

/** Do two segments' bounding boxes, each inflated by `pad`, overlap? A cheap pre-reject. */
function boxesNear(s: TraceSegment, t: TraceSegment, pad: number): boolean {
  const sMinX = Math.min(s.a[0], s.b[0]) - pad;
  const sMaxX = Math.max(s.a[0], s.b[0]) + pad;
  const sMinY = Math.min(s.a[1], s.b[1]) - pad;
  const sMaxY = Math.max(s.a[1], s.b[1]) + pad;
  const tMinX = Math.min(t.a[0], t.b[0]);
  const tMaxX = Math.max(t.a[0], t.b[0]);
  const tMinY = Math.min(t.a[1], t.b[1]);
  const tMaxY = Math.max(t.a[1], t.b[1]);
  return !(tMaxX < sMinX || tMinX > sMaxX || tMaxY < sMinY || tMinY > sMaxY);
}

/** One pair of a trace's segments whose cutter sweeps overlap (#219). */
export interface TraceSelfOverlap {
  /** The two segments, by path index and position within the path. */
  a: { path: number; segment: number };
  b: { path: number; segment: number };
  /** Closest distance between the two segment centrelines, mm. */
  distance: Mm;
  /** How far the two capsules overlap, `2r − distance`, mm. Positive by construction. */
  overlap: Mm;
}

/**
 * Every pair of a trace's segments whose cutter sweeps overlap — their centrelines closer than
 * `2r`, so the two strokes merge into one wider groove and small letters fill in. Adjacent
 * segments of the same path share a vertex by construction and are ignored; an empty result means
 * the trace engraves as distinct lines.
 *
 * The test is between CAPSULES, not the drawn path: two parallel strokes 0.8 mm apart with a 1 mm
 * cutter (r = 0.5) come closer than 1.0 mm and are reported. `overlap` is the amount they merge
 * by.
 *
 * `groups` (#409), when given, is a group index per path: two segments in the SAME group are
 * skipped, exactly as two segments of one path are. A bold stroke's parallel passes share a group
 * because they are SUPPOSED to merge into one wide stroke, and reporting them as merged would tell
 * the operator to "space the lines apart" on a bold label — the opposite of the intent. Undefined
 * (the default) groups nothing, so a caller predating #409 sees every pair.
 */
export function traceSelfOverlaps(
  paths: readonly (readonly [Mm, Mm][])[],
  closed: readonly boolean[],
  radius: Mm,
  groups?: readonly number[],
): TraceSelfOverlap[] {
  if (radius <= 0) return [];
  const threshold = 2 * radius;
  const segs = traceSegments(paths, closed);
  const countPerPath = paths.map((p, i) => (p.length < 2 ? 0 : (closed[i] ?? false) ? p.length : p.length - 1));
  const found: TraceSelfOverlap[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const sClosed = closed[s.path] ?? false;
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]!;
      if (t.path !== s.path && groups !== undefined && groups[s.path] === groups[t.path]) continue;
      if (t.path === s.path) {
        const count = countPerPath[s.path]!;
        const diff = (t.segment - s.segment + count) % count;
        // Same-path neighbours share a vertex, so their capsules always overlap by design.
        if (diff === 1 || (sClosed && diff === count - 1)) continue;
      }
      if (!boxesNear(s, t, threshold)) continue;
      const d = segmentDistance(s.a, s.b, t.a, t.b);
      if (d < threshold) {
        found.push({
          a: { path: s.path, segment: s.segment },
          b: { path: t.path, segment: t.segment },
          distance: d,
          overlap: threshold - d,
        });
      }
    }
  }
  return found;
}

/**
 * The finding codes a trace raises (#219). They are declared HERE, with the geometry that detects
 * them, because `JobFindingCode` (`jobSetup.ts`) is owned by another slot; when those two members
 * are added there, the objects below are already the right shape (`{ severity, code, labelId,
 * message }`).
 *
 * `trace-outside-stock` is NOT produced here: it needs the swept region intersected with the
 * stock, which is a CrossSection evaluation the worker does (#201), not this pure module.
 */
export type TraceFindingCode = 'trace-outside-stock' | 'trace-self-overlap';

/**
 * `trace-self-overlap` findings for every enabled, non-construction trace in the job. A warning,
 * not an error: the trace still cuts, it just fills in.
 *
 * `radiusAt` is the cutter's half-opening at a DEPTH, not a single radius (#405): a V-bit's groove
 * widens as it deepens, so each trace is judged at its own depth. A caller whose cutter cuts one
 * width passes a constant (`tool.traceRadiusAt` for a flat end mill, or the tool's own wrapper).
 * A trace the cutter cannot trace at all answers `null` and raises nothing — the job is refused
 * for the cutter elsewhere, and guessing a width here would invent a second opinion about it.
 */
export function traceSelfOverlapFindings(
  job: EngraveJob,
  radiusAt: (depth: Mm) => number | null,
): { severity: 'warning'; code: TraceFindingCode; labelId: string; message: string }[] {
  const out: { severity: 'warning'; code: TraceFindingCode; labelId: string; message: string }[] = [];
  for (const item of job.traces ?? []) {
    if (!item.enabled || item.construction) continue;
    const radius = radiusAt(item.depth);
    if (radius === null) continue;
    const { paths, closed, groups } = tracePaths(item, job.tool);
    // Judge the merge at the NATURAL half-width (#409 review). A bold stroke's `paths` are the
    // already-OFFSET passes, so they are checked as they are: applying the bold `weight / 2` to a
    // centreline that has already been moved out would report fusions the passes themselves do not
    // make. The passes of one stroke are one group and are not reported against each other.
    const overlaps = traceSelfOverlaps(paths, closed, radius, groups);
    if (overlaps.length === 0) continue;
    const worst = overlaps.reduce((m, o) => Math.max(m, o.overlap), 0);
    out.push({
      severity: 'warning',
      code: 'trace-self-overlap',
      labelId: item.id,
      message:
        `Strokes merge: ${overlaps.length} pair${overlaps.length === 1 ? '' : 's'} of this trace's ` +
        `lines come closer than the cutter width (up to ${worst.toFixed(2)} mm overlap). The cut ` +
        `will fill in — space the lines apart, or use a smaller cutter.`,
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------
 * Under-surface voids (#231 item 3)
 *
 * A keep-out is a declarative void (#165's magnet pocket), so its geometry is a fact the job
 * holds, not an inference from a mesh: the depth limit it implies can be computed analytically,
 * with no layer stack and no wasm. These helpers are the analytic twin of #178's `maxDepthAt`
 * (which does the same from the compiled solid, on the printer's layer grid) for the jobs that
 * state no print, where there is no layer grid to slice.
 * -------------------------------------------------------------------------------------------*/

/** The point at (x, y) expressed in a keep-out's own frame (origin at `position`, axes un-rotated). */
function keepOutLocalPoint(ko: EngraveKeepOut, x: Mm, y: Mm): [number, number] {
  const dx = x - ko.position.x;
  const dy = y - ko.position.y;
  if (ko.rotation === 0) return [dx, dy];
  const a = (-ko.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [dx * c - dy * s, dx * s + dy * c];
}

/** The void's footprint as a placed `Profile` in the stock frame — rotated about its centre, then translated. */
function keepOutProfile(ko: EngraveKeepOut): Profile {
  return pTranslate([ko.position.x, ko.position.y], pRotate(ko.rotation, shapeProfile(ko)));
}

/** Even-odd point-in-polygon, over one ring of points already in the keep-out's frame. */
function pointInRing(points: readonly [Mm, Mm][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Is the stock-frame point (x, y) over this void's footprint? The rect test uses the FULL
 * bounding rectangle and ignores the corner radius: calling a point in a rounded-off corner
 * "over the void" can only make the depth limit shallower, which is the safe direction.
 */
export function pointInKeepOut(ko: EngraveKeepOut, x: Mm, y: Mm): boolean {
  const [lx, ly] = keepOutLocalPoint(ko, x, y);
  switch (ko.kind) {
    case 'rect':
      return Math.abs(lx) <= ko.width / 2 && Math.abs(ly) <= ko.height / 2;
    case 'circle':
      return lx * lx + ly * ly <= (ko.diameter / 2) ** 2;
    case 'slot': {
      const r = ko.width / 2;
      const half = Math.max(0, ko.length / 2 - r);
      const nearestX = Math.max(-half, Math.min(half, lx));
      return (lx - nearestX) ** 2 + ly * ly <= r * r;
    }
    case 'polygon':
      return pointInRing(ko.points, lx, ly);
  }
}

/**
 * The solid material a void leaves above it, mm — `stock.thickness − zCeiling`, never below 0
 * (#231). A void whose ceiling pokes above the top face leaves none, and the sheet must not
 * print a negative thickness. One owner for the formula: the run sheet's diagram (whose
 * `solidThickness` field is this number), the analytic depth limit below and the worker's void
 * findings (#171) all read it.
 */
export function keepOutMembrane(job: EngraveJob, zCeiling: Mm): Mm {
  return Math.max(0, job.stock.thickness - zCeiling);
}

/**
 * The halves of a void's depth limit, kept apart (#351) so a surface can say WHICH number set the
 * limit as well as what it is — the run sheet names the blank's own floor when that is what binds,
 * and the panel's void row needs the same distinction to explain the number honestly.
 */
export interface VoidLimitParts {
  /** Solid material above the void as the DOCUMENT declares it, mm (`keepOutMembrane`). */
  membrane: Mm;
  /**
   * The plane the limit is measured from, mm below the engraved face: the roof quantised onto the
   * printer's layer grid where the blank states a print, the declared membrane where it states
   * none (`voidCeilingFor` is the one owner of that choice).
   */
  ceiling: Mm;
  /** `ceiling` less the margin its rule keeps (`voidMargin`) — the void's own answer. */
  overVoid: Mm;
  /** `thickness − minFloor` — the blank's own floor, the other candidate at this point. */
  stockFloor: Mm;
  /**
   * `max(0, min(overVoid, stockFloor))`: the deepest cut over this void that still keeps the floor.
   * Clamped like every other bound (`boundFloor`), so a `minFloor` larger than the blank — a job the
   * `depth-exceeds-stock` finding already refuses — reads "no cut here" rather than a negative depth.
   */
  limit: Mm;
}

/**
 * The deepest cut a void permits, mm — and the numbers it was chosen from (#351).
 *
 * `limit` is the number #174's verifier refuses against, and every surface that states it reads it
 * from here rather than working out its own: the panel's void row, the preview's viewport label,
 * the run sheet's §1 step and its per-cut note. It is the smaller of two numbers:
 *
 *   - `overVoid` — the void's ceiling less the margin its rule keeps (`voidMargin`). The ceiling is
 *     NOT the declared membrane on a blank that states its print: the roof was built on the
 *     printer's layer grid, so `voidCeilingFor` quantises it there, and the stack's own
 *     `maxDepthAt` reports the same plane (#285). #351 is the bug that came of skipping this: the
 *     panel read 1.31 mm over the default badge's pocket where the verifier refused above the
 *     layer-aligned 1.20.
 *   - `stockFloor` — `thickness − minFloor`, the blank's own floor. A void sits inside the part
 *     outline, so this is the base the verifier takes there; without the `min`, a SHALLOW void
 *     prints a number the verifier refuses (#285 review — a 3.81 mm badge with a 3.31 mm membrane
 *     reads 3.2 mm against the enforced `3.81 − 1.0`).
 *
 * The margin is `voidMargin`'s and not a bare `boundaryMargin` (#345 decision A): a blank that
 * STATES a print keeps the Z-error margin (its ceiling is on a real layer line, a distance the
 * printer can hold), while one that states none keeps `max(boundaryMargin, minFloor)` — with no
 * grid to align to, the structural floor is the only number with a basis. One owner for that
 * choice, shared with the per-item bound and the stack's own limit.
 *
 * `membrane` is the declared one and stays in the answer so a caller can print what the DOCUMENT
 * says beside what the printer's layers make of it: the two differ exactly when
 * `ceiling < membrane`, which is the layer grid at work rather than a mistake. A blank that states
 * no print has no grid — `voidCeilingFor` returns the membrane, so `ceiling` IS the membrane and
 * the whole answer is the arithmetic #213 always used.
 */
export function keepOutLimitParts(
  job: EngraveJob,
  membrane: Mm,
  margin: Mm = defaultBoundaryMargin(job),
): VoidLimitParts {
  const ceiling = voidCeilingFor(membrane, job.stock.thickness, printedLayerGridOf(job.stock));
  const overVoid = voidFloor(ceiling, voidMargin(job, margin));
  const stockFloor = job.stock.thickness - job.minFloor;
  return { membrane, ceiling, overVoid, stockFloor, limit: Math.max(0, Math.min(overVoid, stockFloor)) };
}

/** `keepOutLimitParts(...).limit` — the number itself, for a caller that needs only that. */
export function keepOutLimit(
  job: EngraveJob,
  membraneThickness: Mm,
  margin: Mm = defaultBoundaryMargin(job),
): Mm {
  return keepOutLimitParts(job, membraneThickness, margin).limit;
}

/**
 * The enabled void that binds at (x, y) — the one with the shallowest limit when two overlap —
 * or null when none covers the point. One walk, so `keepOutLimitAt` and `keepOutNameAt` can
 * never disagree about WHICH void is the answer there.
 */
function bindingKeepOutAt(job: EngraveJob, x: Mm, y: Mm, margin?: Mm): { ko: EngraveKeepOut; limit: Mm } | null {
  let found: { ko: EngraveKeepOut; limit: Mm } | null = null;
  const m = margin ?? defaultBoundaryMargin(job);
  for (const ko of job.keepOuts ?? []) {
    if (!ko.enabled || !pointInKeepOut(ko, x, y)) continue;
    const limit = keepOutLimit(job, keepOutMembrane(job, ko.zCeiling), m);
    if (found === null || limit < found.limit) found = { ko, limit };
  }
  return found;
}

/**
 * The deepest cut an enabled under-surface void permits at (x, y), or null when none covers it.
 * When two voids overlap, the shallowest limit wins.
 */
export function keepOutLimitAt(job: EngraveJob, x: Mm, y: Mm, margin?: Mm): Mm | null {
  return bindingKeepOutAt(job, x, y, margin)?.limit ?? null;
}

/**
 * The NAME of the void that binds at (x, y), or null. The verifier's `cut-too-deep` says which
 * membrane the cutter broke (#285); an unnamed void answers `''`, and the caller words the
 * sentence its own way rather than being handed an invented name.
 */
export function keepOutNameAt(job: EngraveJob, x: Mm, y: Mm): string | null {
  const binding = bindingKeepOutAt(job, x, y);
  return binding === null ? null : (binding.ko.name ?? '');
}

/** A line's own extent in the stock frame, as a box that CONTAINS the cut (#365). */
export interface ItemFootprint {
  /** The box's centre — a label's `position`, which is where `labelProfile` centres the ink on. */
  x: Mm;
  y: Mm;
  halfWidth: Mm;
  halfHeight: Mm;
  /** The box's own angle, degrees — a label's `rotation`. */
  rotation: number;
}

/**
 * A line's extent as a box: its ink box (`inkBoxOf`, measured where a face is up) centred on
 * `position` and turned by `rotation` — `labelProfile`'s own three moves, so the box contains every
 * point of the cut and the void test below is answered about something the job really holds.
 *
 * Takes the ink box rather than a measure so the caller can say WHICH box it used: the one reader
 * that needs to (`voidLimitForItem`) asks its measure once and reads the fallback off the same
 * answer, instead of measuring twice and hoping the two agree.
 */
export function labelFootprint(label: EngraveLabel, ink: InkBox): ItemFootprint {
  return {
    x: label.position.x,
    y: label.position.y,
    halfWidth: ink.width / 2,
    halfHeight: ink.height / 2,
    rotation: label.rotation,
  };
}

/**
 * A line's stand-in profile while its face is not parsed: `inkBoxOf`'s documented upper-bound box,
 * placed with `labelFootprint`'s own three moves — centred on `position`, turned by `rotation` — so
 * it sits where `labelProfile` would put the real glyphs. Only `toPartPlan`'s `'estimate'` option
 * builds one (#488 review); nothing that cuts a part ever sees it.
 */
function estimatedLabelProfile(label: EngraveLabel): Profile {
  const ink = inkBoxOf(label.text, label.font, label.weight, label.size);
  const box = labelFootprint(label, ink);
  return pTranslate(
    [box.x, box.y],
    pRotate(box.rotation, rectProfile(box.halfWidth * 2, box.halfHeight * 2, true)),
  );
}

/** The vector (x, y) turned by `deg` degrees, in `keepOutLocalPoint`'s handedness. */
function rotateVec(x: number, y: number, deg: number): [number, number] {  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Does the box (centre `cx`/`cy`, half extents, turned by `rot`) reach the axis-aligned rect centred
 * on the origin? The separating-axis test over the four axes of the two boxes — exact for two
 * rectangles, however either is turned.
 */
function boxReachesRect(
  cx: number,
  cy: number,
  rot: number,
  hw: number,
  hh: number,
  rw: number,
  rh: number,
): boolean {
  const [ux, uy] = rotateVec(1, 0, rot);
  const [vx, vy] = rotateVec(0, 1, rot);
  // The rect's own two axes: the box's extent along each is its half extents projected.
  if (Math.abs(cx) > rw + hw * Math.abs(ux) + hh * Math.abs(vx)) return false;
  if (Math.abs(cy) > rh + hw * Math.abs(uy) + hh * Math.abs(vy)) return false;
  // …and the box's two: the rect's extent along each, the same way round.
  if (Math.abs(cx * ux + cy * uy) > hw + rw * Math.abs(ux) + rh * Math.abs(uy)) return false;
  if (Math.abs(cx * vx + cy * vy) > hh + rw * Math.abs(vx) + rh * Math.abs(vy)) return false;
  return true;
}

/** Does the box reach the circle of radius `r` at `(px, py)`? Exact: the clamped point-to-box distance. */
function boxReachesCircle(
  cx: number,
  cy: number,
  rot: number,
  hw: number,
  hh: number,
  px: number,
  py: number,
  r: number,
): boolean {
  // The circle's centre in the box's OWN frame, where the box is axis-aligned again.
  const [lx, ly] = rotateVec(px - cx, py - cy, -rot);
  const qx = Math.max(-hw, Math.min(hw, lx));
  const qy = Math.max(-hh, Math.min(hh, ly));
  return (lx - qx) ** 2 + (ly - qy) ** 2 <= r * r;
}

/**
 * Does the line's box reach this void's footprint at all? (#365)
 *
 * Answered in the VOID's own frame — `keepOutLocalPoint`'s transform, the one `pointInKeepOut`
 * already uses — where the line is a box at its centre turned by `label.rotation − ko.rotation`:
 *
 *   - `rect` — the full bounding rect with the corner radius ignored, exactly as `pointInKeepOut`
 *     reads it, and for the same reason: calling a corner "over the void" can only cost depth.
 *   - `circle` — the exact point-to-box distance against the radius, so a line beside the disc is
 *     not charged for it.
 *   - `slot` — exact, as the rect plus its two end discs; the parts are tested one at a time, so a
 *     line in a corner the round end does not reach is clear of the void it looks near.
 *   - `polygon` — the ring's BOUNDING BOX, conservatively. An exact box-vs-ring test is a corner
 *     and edge-crossing walk this issue does not need: a bounding box can only over-report overlap,
 *     and over-reporting advises a shallower cut, which is the safe direction. The same reading
 *     `pointInKeepOut` takes of a rounded corner.
 */
function lineReachesKeepOut(box: ItemFootprint, ko: EngraveKeepOut): boolean {
  const [cx, cy] = keepOutLocalPoint(ko, box.x, box.y);
  const rot = box.rotation - ko.rotation;
  const { halfWidth: hw, halfHeight: hh } = box;
  switch (ko.kind) {
    case 'rect':
      return boxReachesRect(cx, cy, rot, hw, hh, ko.width / 2, ko.height / 2);
    case 'circle':
      return boxReachesCircle(cx, cy, rot, hw, hh, 0, 0, ko.diameter / 2);
    case 'slot': {
      const r = ko.width / 2;
      const half = Math.max(0, ko.length / 2 - r);
      return (
        boxReachesRect(cx, cy, rot, hw, hh, half, r) ||
        boxReachesCircle(cx, cy, rot, hw, hh, -half, 0, r) ||
        boxReachesCircle(cx, cy, rot, hw, hh, half, 0, r)
      );
    }
    case 'polygon': {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [px, py] of ko.points) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      if (minX > maxX) return false; // no ring at all
      return boxReachesRect(
        cx - (minX + maxX) / 2,
        cy - (minY + maxY) / 2,
        rot,
        hw,
        hh,
        (maxX - minX) / 2,
        (maxY - minY) / 2,
      );
    }
  }
}

/**
 * The shallowest limit among the voids THIS LINE's own extent reaches, and the void it belongs to —
 * or null when the line reaches none of them (#365).
 *
 * The per-item replacement for the blank-wide answer this function used to give. That older reading
 * collapsed every enabled void on the blank to one number because the store re-depths a blank with
 * no plan in hand, and it was right about being conservative and wrong about what it was
 * conservative WITH: a line that sits clear of the pocket was still advised the pocket's ceiling, so
 * the seeded badge line read 0.51 mm where the jaws allow 0.905 — half the depth the blank permits,
 * on a line the seed had deliberately placed in the free band BESIDE the pocket.
 *
 * The box test is the honest superset, not a shortcut. The verifier's `jobDepthLimit` is positional,
 * evaluated at the toolpath's own points, and those points lie inside the line's ink box: ink-box
 * overlap is therefore a superset of everything the checker can refuse, so the recommendation still
 * never permits a cut the checker would refuse. It only stops charging a line for a void its own
 * extent misses.
 *
 * A LABEL, and not any item, because a depth is recommended for a label alone: the store's walk, the
 * panel's row and the run sheet all ask about lines. A shape's own outline bbox would be this
 * function's answer for a shape, and no caller has one to ask with.
 *
 * `estimated` is true when the ink box was `inkBoxOf`'s documented ESTIMATE rather than a
 * measurement — a face that is not parsed yet. The estimate is an upper bound, so it reaches at
 * least as many voids as the real glyphs, and a number worked out that way can only move DEEPER
 * once the face is up: never into a refusal. It travels with the answer so the recommendation's
 * basis can say which box it was measured against.
 */
export function voidLimitForItem(
  job: EngraveJob,
  label: EngraveLabel,
  margin?: Mm,
  measure?: InkMeasure,
): { name: string; limit: Mm; estimated: boolean } | null {
  const measured = measure?.(label.text, label.font, label.weight, label.size) ?? null;
  const box = labelFootprint(
    label,
    measured ?? inkBoxOf(label.text, label.font, label.weight, label.size),
  );
  const found = voidLimitForFootprint(job, box, margin);
  return found === null ? null : { ...found, estimated: measured === null };
}

/**
 * The shallowest limit among the voids an arbitrary FOOTPRINT reaches, and the void it belongs to —
 * or null when the box reaches none (#475).
 *
 * `voidLimitForItem` is this function plus a label's ink box and the `estimated` flag. The split
 * exists because #475's bowed-blank band is worked out per CUT REGION, and a region is not always a
 * label: a shape's `aabbOfProfile` and a trace's path box are boxes too, and charging them the same
 * conservative superset is what keeps a region from being told a pocket is clear when its own
 * extent crosses one.
 */
export function voidLimitForFootprint(
  job: EngraveJob,
  box: ItemFootprint,
  margin?: Mm,
): { name: string; limit: Mm } | null {
  const m = margin ?? defaultBoundaryMargin(job);
  let found: { name: string; limit: Mm } | null = null;
  for (const ko of job.keepOuts ?? []) {
    if (!ko.enabled || !lineReachesKeepOut(box, ko)) continue;
    const limit = keepOutLimit(job, keepOutMembrane(job, ko.zCeiling), m);
    // `<` and not `<=`: at equal limits the first void keeps the answer, so the name a job shows is
    // the one its document declares first — stable, and never a silent re-pick.
    if (found === null || limit < found.limit) found = { name: ko.name ?? '', limit };
  }
  return found;
}

/**
 * How near an item's own extent comes to the vise's jaws, in XY (#369, #394).
 *
 * The jaw floor is a Z rule — a floor must stay `clearance` mm above the jaw TOPS — but whether it
 * applies at all is an XY fact: a line engraved in the middle of the blank has tens of millimetres
 * of material between it and either jaw face, so nothing about the jaws can reach it. Charging it
 * the jaw clearance anyway is the same blank-wide shortcut #365 removed for voids.
 *
 * TWO readings, because two readers ask two questions, and #394 is why they are separate:
 *
 *   - `reaches` — the WARNING's and the depth recommendation's: the swept cut could come over this
 *     jaw once the vise's own band is allowed for. Decision 28's band is the point of the term: an
 *     vise's faces may be anywhere in it, so a cut inside the band still warns;
 *   - `overJaw` — the run sheet's STOP line: the cutter's own disc does reach the jaw footprint
 *     with no band assumed. A stop is an instruction to the operator standing at the machine, so it
 *     is the reading that asks whether the cutter really gets there.
 */
export interface JawReach {
  /** The jaw the item's extent comes nearest — the one whose clearance the floor must keep. */
  jaw: 'fixed' | 'moving';
  /**
   * The clear XY distance from the item's extent to that jaw's footprint, mm — 0 where they touch
   * or overlap. It is the CHEBYSHEV distance (the larger of the two axis gaps), which is never more
   * than the true corner-to-corner distance, so the number reported and both tests below are the
   * conservative reading.
   */
  gap: Mm;
  /**
   * The swept cut can come over this jaw, the vise's own band allowed for:
   * `gap ≤ radius + uncertainty`. The reading the jaw FLOOR applies over (#369) — the depth
   * recommendation (`recommendLabelDepth`).
   */
  reaches: boolean;
  /**
   * The swept cut does come over it, with no band assumed: `gap ≤ radius`. The run sheet's stop
   * reading (#394): the cutter's own disc, the only thing that works below the jaw tops.
   */
  overJaw: boolean;
}

/**
 * The whole `JawReach`, by ID — for a caller holding an item rather than a label: the run sheet's
 * stop line (#394) and the depth recommendation (#369). Each reads the same funnel every other
 * reader does and must not answer this question a second way.
 *
 * The whole rule lives here, once. A LABEL is the one kind with an extent this module can measure
 * (`labelJawReach`); every other id belongs to a shape, a trace or a drill, and for those the
 * STRICT reading stands — they are charged the jaw floor wherever they sit. That over-warns rather
 * than under-warns, it is what every one of them did before #369, and the geometric sweep
 * (`sweptCuts`/`vise-jaw-collision`, #488) is the real collision check for all of them. Measuring a
 * shape's own outline would be this function's answer for a shape, and no caller has one to ask
 * with. A label id is never a shape's: ids are minted per list and unique.
 */
export function idJawReach(job: EngraveJob, id: string): JawReach {
  const label = job.labels.find((l) => l.id === id);
  return label === undefined ? JAW_REACH_UNKNOWN : labelJawReach(job, label);
}

/**
 * The strict reading (#369) for an item whose extent this module cannot measure. `gap` is 0 because
 * the item's own extent is unknown, not because it is known to touch the jaw: only `reaches` and
 * `overJaw` mean anything here, and both are the strict yes.
 */
const JAW_REACH_UNKNOWN: JawReach = { jaw: 'fixed', gap: 0, reaches: true, overJaw: true };

/**
 * How close two jaw gaps must be to count as a tie (`labelJawReach`). Absolute, in mm, and far
 * below any distance this rule is asked to weigh — it exists so that two float paths to the same
 * geometric fact do not disagree about which jaw is nearer.
 */
const JAW_TIE_EPSILON: Mm = 1e-6;

/**
 * The reach for a LINE's own ink box (`labelFootprint`), in the part frame — the per-item
 * replacement for the blank-wide jaw bound the recommendation and the warning used to hold.
 *
 * The box is the MEASURED one wherever the face is up — `labelGlyphMeasure` over `job.customFonts`,
 * the same measurement `voidLimitForItem` takes — and `inkBoxOf`'s documented estimate only where
 * it is not, which is a decision rather than an omission (#394). One box, in every reader, is what
 * stops the app recommending a depth that its own warning then refuses (#362); and measuring it is
 * what stops the estimate's own size deciding the answer. The estimate is an UPPER bound, so it is
 * the wider box, the smaller gap and the larger reach: on the #284 coupons' 38.1 mm blank it was
 * 85.8 mm wide, which made every cell "reach" a jaw it in fact sits 2.31 mm clear of. Where no face
 * is up — a node script that registered none, the wizard's hand-off before #180's fetch — the
 * estimate still answers, and errs in that same direction rather than under-reaching.
 *
 * The reach is `uncertainty + radius`, and the absence of a `clearance` term is #394's decision, not
 * an oversight. The clearance is a Z rule (a floor must stay that far above the jaw tops); this
 * function answers which XY region that floor applies OVER, and only two terms can put a cut over a
 * jaw the item's own box misses:
 *
 *   - the vise's OWN `uncertainty`: a default vise's jaws may be anywhere in that band (decision
 *     28), so the jaw that matters may be that much nearer than the box says;
 *   - the cutter's radius: the cutter is a DISC, and the material it removes reaches that far
 *     outside the toolpath, which reaches no further than the line's own box.
 *
 * Each reader charges the clearance to the DEPTH it is weighing — `deepest + clearance` in
 * `validateJob`, `stockProud − clearance` in the recommendation — which is where it belongs.
 */
export function labelJawReach(job: EngraveJob, label: EngraveLabel): JawReach {
  // #707 BM-1 — A BED JOB HAS NO JAWS. The reach is the vise's: the floor it recommends ("the line
  // comes within … mm of the fixed jaw") is a clearance over a jaw that a taped or bracket job does
  // not have, and the neutral vise `jobVise` answers with would invent one around the part. No
  // reach, so no jaw floor is recommended from it — the mount's own obstacles are BM-6's checks.
  if (job.workholding.kind === 'tape' || job.workholding.kind === 'bracket') {
    return { jaw: 'fixed', gap: Infinity, reaches: false, overJaw: false };
  }
  const measure = labelGlyphMeasure(job.customFonts ?? []);
  const box = labelFootprint(label, inkBoxOf(label.text, label.font, label.weight, label.size, measure));
  // The box's own bounds, as an axis-aligned box that CONTAINS it: a label's rotation turns the
  // box, and the projection of a turned box onto the stock's axes contains it, so the gap below is
  // never larger than the real one. Conservative in the direction that matters — a smaller gap
  // costs depth advice, and never buys it.
  const [ux, uy] = rotateVec(1, 0, box.rotation);
  const [vx, vy] = rotateVec(0, 1, box.rotation);
  const halfX = box.halfWidth * Math.abs(ux) + box.halfHeight * Math.abs(vx);
  const halfY = box.halfWidth * Math.abs(uy) + box.halfHeight * Math.abs(vy);
  const nearest = jawGapFor(job, {
    minX: box.x - halfX,
    maxX: box.x + halfX,
    minY: box.y - halfY,
    maxY: box.y + halfY,
  });

  // The cutter's footprint at THIS item's depth (#405): a V-bit's groove is wider the deeper the
  // label goes, and the toolpath here is the label's own, so its own depth is the one to read.
  const radius = sweepRadiusForJob(job, label.depth);
  return {
    jaw: nearest.jaw,
    gap: nearest.gap,
    reaches: nearest.gap <= nearest.uncertainty + radius,
    overJaw: nearest.gap <= radius,
  };
}

/**
 * The clear XY distance from a stock-frame box to the NEAREST jaw's footprint, and which jaw that
 * is (#488). Chebyshev, exactly like the reach above: the larger of the two axis gaps, never more
 * than the true corner-to-corner distance, so the number and the tests built on it are the
 * conservative reading.
 *
 * The gap is measured to the jaw's face as `viseEnvelope` places it, so sacrificial material
 * that pushes the faces outward (#213) moves this answer with it — the same envelope every other
 * jaw reader uses, because two functions disagreeing about where a jaw face is would be a
 * collision check that disagrees with the run sheet.
 *
 * `viseEnvelope` always declares both jaws. The impossible empty case answers `fixed`/0 rather
 * than throwing; the strict `JAW_REACH_UNKNOWN` reading is `labelJawReach`'s own.
 */
export function jawGapFor(job: EngraveJob, box: SweptBox): {
  jaw: 'fixed' | 'moving';
  gap: Mm;
  /** The vise's own band, carried with the envelope's provenance — the reach's third term. */
  uncertainty: Mm;
} {
  const envelope = viseEnvelope(job.stock, jobVise(job), job.sacrificial);
  const nearest = nearestJaw(envelope, box);
  return { ...nearest, uncertainty: envelope.uncertainty };
}

/** The jaw loop itself, so `jawGapFor` and any future reader share one tie rule. */
function nearestJaw(
  envelope: FixtureEnvelope,
  box: SweptBox,
): { jaw: 'fixed' | 'moving'; gap: Mm } {
  let nearest: { jaw: 'fixed' | 'moving'; gap: Mm } | null = null;
  for (const jaw of envelope.boxes) {
    const gap = Math.max(
      jaw.min[0] - box.maxX,
      box.minX - jaw.max[0],
      jaw.min[1] - box.maxY,
      box.minY - jaw.max[1],
      0,
    );
    // An exact tie keeps the FIRST jaw `viseEnvelope` declares — the fixed one — so the jaw a
    // recommendation names never depends on float noise. "Exact" cannot be `===` here: the two
    // gaps are computed from different arithmetic (`0 − minX` against `length − maxX`), and a line
    // centred on the blank lands at 38.099999999999994 against 38.10000000000001 — a hair, not a
    // tie, which would hand a centred label to the MOVING jaw on nothing but rounding. The epsilon
    // is absolute and far below any real distance this rule weighs.
    if (nearest === null || gap < nearest.gap - JAW_TIE_EPSILON) {
      nearest = { jaw: jaw.id === 'vise-moving-jaw' ? 'moving' : 'fixed', gap };
    }
  }
  return nearest ?? { jaw: 'fixed', gap: 0 };
}

/** An axis-aligned box in the stock frame, mm — a cut's extent in XY (#488). */
export interface SweptBox {
  minX: Mm;
  maxX: Mm;
  minY: Mm;
  maxY: Mm;
}

/** One enabled cut, and the box its cutter really sweeps in XY (#488). */
export interface SweptCut {
  id: string;
  name: string;
  depth: Mm;
  box: SweptBox;
}

/** The box grown by `by` mm on every side. */
function grownBox(box: SweptBox, by: Mm): SweptBox {
  return {
    minX: box.minX - by,
    maxX: box.maxX + by,
    minY: box.minY - by,
    maxY: box.maxY + by,
  };
}

/** The box widened to contain the point; the point itself when there is no box yet. */
function coverPoint(box: SweptBox | null, x: Mm, y: Mm): SweptBox {
  if (box === null) return { minX: x, maxX: x, minY: y, maxY: y };
  return {
    minX: Math.min(box.minX, x),
    maxX: Math.max(box.maxX, x),
    minY: Math.min(box.minY, y),
    maxY: Math.max(box.maxY, y),
  };
}

/**
 * Every enabled cut on the job as the box its cutter sweeps in XY, in the stock frame (#488) —
 * the geometric reading the jaw-collision rule asks, and the run sheet's clearance sentence.
 *
 * What the box is depends on how the item is cut, and the difference is real:
 *
 *   - an ENGRAVE — a shape pocket, an imported outline, a combined ring, or a LABEL's glyph
 *     outline — is cut by a toolpath held INSIDE the outline (the offset of the region by the
 *     cutter's radius), so the outline IS the swept extent. Growing it by the radius again would
 *     refuse a pocket the cutter fits exactly, and would refuse the #488 spec's own thin-film
 *     job whose items sit 1 mm inside the blank's edges with a 2 mm cutter;
 *   - a TRACE is the line reading: its cutter's CENTRE follows the path, and the material reaches
 *     one radius beyond it, so the stroke's bounding box is grown by the sweep radius at its own
 *     depth (a V-bit opens as it deepens, #405);
 *   - a DRILL is a disc of the cutter's radius at each hole centre (the array's lattice included);
 *   - a THREAD is a disc of the thread's MAJOR radius — the widest its orbit reaches.
 *
 * The air frame and the helix/ramp entries are deliberately not part of this: the frame is traced
 * at its own height above the stock and every lead-in is inside the pocket it enters, so neither
 * can put material anywhere its item's box does not already cover.
 *
 * `plan` is accepted so a caller that already built one (the run sheet) reads the same profiles
 * without a second walk of the job. When it is not given, the plan is built with
 * `unparsedFace: 'estimate'` (#488 review): this function's callers are the jaw check and the run
 * sheet's clearance sentence, and the jaw check's first call is a panel render, which can run
 * before the text faces are parsed. The estimate is `inkBoxOf`'s upper bound, so it can only make
 * the collision check stricter — never miss a cut.
 */
export function sweptCuts(job: EngraveJob, plan: PartPlan = toPartPlan(job, { unparsedFace: 'estimate' })): SweptCut[] {
  const cuts: SweptCut[] = [];
  const add = (id: string, name: string, depth: Mm, box: SweptBox, growBy: Mm) =>
    cuts.push({ id, name, depth, box: grownBox(box, growBy) });

  for (const item of plan.engraves) {
    const aabb = aabbOfProfile(item.profile);
    if (!aabb) continue;
    const box = { minX: aabb.min[0], maxX: aabb.max[0], minY: aabb.min[1], maxY: aabb.max[1] };
    add(item.id, item.name, item.depth, box, 0);
  }
  for (const trace of plan.traces) {
    let box: SweptBox | null = null;
    for (const path of trace.paths) for (const [x, y] of path) box = coverPoint(box, x, y);
    if (box !== null) add(trace.id, trace.name, trace.depth, box, sweepRadiusForJob(job, trace.depth));
  }
  for (const drill of plan.drills) {
    let box: SweptBox | null = null;
    for (const [x, y] of drill.holes) box = coverPoint(box, x, y);
    // A drill's hole is the cutter's own diameter, so the sweep is its flat radius; the depth
    // argument is 0 because only a V-bit's radius varies with depth and a V-bit cannot drill.
    // #668 — a BORE's hole is the job's own diameter, so the sweep is the HOLE's radius (a bore
    // is always wider than its cutter, and the finding refuses one that is not).
    const radius =
      drill.mode === 'bore' && drill.diameter !== null && drill.diameter > 0
        ? drill.diameter / 2
        : sweepRadiusForJob(job, 0);
    if (box !== null) add(drill.id, drill.name, drill.depth, box, radius);
  }
  for (const thread of plan.threads) {
    const [x, y] = thread.position;
    const r = FASTENERS[thread.size].major / 2;
    add(thread.id, thread.name, thread.depth, { minX: x, maxX: x, minY: y, maxY: y }, r);
  }
  // Cut-outs (#218) sweep the referenced outline plus the path offset (`inset`) and the cutter
  // radius. The outline's bounding box covers every point of the offset path, so growing it by
  // the offset is the safe superset the collision checks want.
  for (const cutout of plan.cutouts) {
    const aabb = aabbOfProfile(cutout.outline);
    if (!aabb) continue;
    const box = { minX: aabb.min[0], maxX: aabb.max[0], minY: aabb.min[1], maxY: aabb.max[1] };
    add(cutout.id, cutout.name, cutout.depth, box, sweepRadiusForJob(job, 0) + cutout.inset);
  }
  return cuts;
}

/**
 * The job's depth limit as #174's verifier takes it. It is the MINIMUM of two limits, and the
 * whole point is that there is exactly one function that composes them:
 *
 *   - `sacrificialDepthLimit` (#213 §3) — `thickness − minFloor` over the part, the strip's
 *     height over a side strip, `thickness + breakthrough` over an under-board's overhang, and
 *     `0` over air. With no sacrificial material it collapses to the CNC-2 `stockDepthLimit`,
 *     so a job that does not use sacrificial material gets the exact numbers it had before.
 *   - the under-surface voids (#231 item 3) — a thinner membrane over a declared void.
 *
 * The two are independent: a void is a fact about the blank, the sacrificial material a fact
 * about the setup. Whichever is shallower at a point wins.
 *
 * A through-cut (#218) is threaded from HERE: `through` is the spatial mask the CAM built, and
 * `sacrificialDepthLimit` consults it where a point is inside a through region or kerf. A job
 * with no through work passes no mask and reads exactly as before.
 *
 * `margin` (#345) is the job's `boundaryMargin` as the caller resolved it, and only the void half
 * uses it: the job's own `minFloor`/`breakthrough` are the document's numbers and are not the
 * house's to override. It is passed in rather than looked up because this module must stay free of
 * the settings store — the panel and the worker each resolve it once and hand the same number here.
 */
export function jobDepthLimit(job: EngraveJob, margin?: Mm, through?: ThroughMask, bedBoardMm?: number | null): DepthLimit {
  const sacrificial = sacrificialDepthLimit(job.stock, job.sacrificial, {
    minFloor: job.minFloor,
    breakthrough: job.breakthrough,
    ...(through === undefined ? {} : { through }),
    // #712 — the wasteboard under a bed job counts exactly as an under-board does.
    ...(bedBoardMm === undefined || bedBoardMm === null ? {} : { bedBoardMm }),
  });
  return (x, y) => {
    const base = sacrificial(x, y);
    const local = keepOutLimitAt(job, x, y, margin);
    return local === null ? base : Math.min(base, local);
  };
}

/**
 * The pure derivation every downstream consumer reads. The stock outline is
 * `rectProfile(length, width)` with its FRONT-LEFT corner at the origin — the job frame IS
 * the work frame (#200 decision 3), and it is never centred.
 *
 * Labels, shapes and combined shapes funnel through `itemProfile` into the ONE `engraves` list
 * (#214/#215): the document keeps three fields so old jobs and the label pipeline are untouched,
 * but nothing downstream can tell one from another except by its id. Cuttable 3D primitives
 * (#435) join that same list; refused ones never do.
 *
 * Items are walked in `resolveItems`' dependency order, so a `frame`/`cutaway` always finds the
 * profile of what it references. An item with a broken reference never appears in that order.
 * A `construction` item resolves (so it can be referenced) but produces no cut of its own.
 *
 * Traces (#219) are a SEPARATE list: they take no part in `resolveItems` (nothing references one),
 * never reach `engraves`, and are appended in document order after the region items.
 */
/**
 * How `toPartPlan` treats a label whose face is not parsed yet (#180). The default lets
 * `resolveFont` throw, which is the COMPILE path's promise: a program is never generated from an
 * estimate of the text. `'estimate'` places the line as `inkBoxOf`'s documented upper-bound box
 * instead, for the callers that only ask WHERE the cut is and run before the faces are up — the
 * jaw check behind `validateJob` (#488 review), whose first call is a panel render and the
 * wizard's hand-off, both of which can precede `ensureFontsLoaded`. An upper bound can only
 * over-state the extent, which for a collision check is the safe direction.
 */
export interface PartPlanOptions {
  unparsedFace?: 'throw' | 'estimate';
  /**
   * #677 — REGIONS THE DOCUMENT DOES NOT HOLD, built by the caller from the job's own geometry.
   * The one user is the variable-depth V-carve's CORE: the middle the V's width cannot reach at
   * the cap, derived by the worker from the design and the cone and pocketed by the setup's flat
   * cutter in its own program. They join `engraves` AFTER every item region, so the document's
   * operation order is unchanged, and from there they are ordinary regions — measured, pocketed,
   * predicted and verified like any other. Nothing here is ever saved.
   */
  derivedEngraves?: readonly DerivedEngrave[];
}

/** #677 — one derived region: a profile the job never stored, cut at one depth. */
export interface DerivedEngrave {
  id: string;
  name: string;
  profile: Profile;
  depth: Mm;
}

/**
 * The map region `measureLabels` judges a rotary item against (#240).
 *
 * It is deliberately larger than the map itself. The around axis is PERIODIC, so a region across
 * the seam is authored on either side of 0/C and is not "off the stock"; and the X ends are the BAND
 * findings' to judge, in their own operator sentence ("runs into the jaws"), rather than this
 * stage's generic "beyond the supported material". Covering a turn either side of the seam and the
 * whole stick-out leaves `item-outside-stock` inert on a rotary job, so each refusal has one owner
 * and one sentence.
 */
function rotaryMapSupport(map: RotaryMap): Profile {
  const around = map.circumference;
  return pTranslate([-around, -around], rectProfile(map.stickout + 2 * around, 3 * around));
}

export function toPartPlan(job: EngraveJob, options: PartPlanOptions = {}): PartPlan {
  // #240 — a job in the rotary chuck is planned on its MAP: X along the axis from the jaws, Y the
  // surface arc at the design radius, over the stick-out the jaws leave free. The same document
  // items, the same funnels; only the stock those coordinates are measured against changes. A
  // flat job reads its blank exactly as before.
  const rotary = rotaryMapOf(job);
  const stockOutline = rotary
    ? rectProfile(rotary.stickout, rotary.circumference)
    : rectProfile(job.stock.length, job.stock.width);
  const { order } = resolveItems(job);
  // Read once: `labelGlyphMeasure` answers `null` for a face that is not parsed, which is the cue
  // to fall back. It is only built when the caller asked for the fallback, so the compile path
  // pays nothing for a question it must answer by throwing.
  const measure = options.unparsedFace === 'estimate' ? labelGlyphMeasure(job.customFonts ?? []) : null;

  // #674 — the cone a PRISM's ring derives from. The job's own snapshot wins (it is part of the
  // document and every caller — the worker, the panel, a spec — carries it once a job is real);
  // a snapshot-less job reads its key from the builtin registry, the same fallback `jobTool` makes.
  const cone = (() => {
    const tool = toolForJob(job, getTools());
    return tool === null ? null : vCone(tool);
  })();
  const profiles = new Map<string, Profile>();
  /** The human name of each resolved item, for a cut-out's operation name (#218). */
  const names = new Map<string, string>();
  const engraves: PartPlan['engraves'] = [];
  // #739 — the construction labels a cutaway can leave standing, by id. A cutaway island that
  // is not one of these is an ordinary item the job cuts in its own operation, not raised text.
  const constructionLabels = new Map(
    job.labels.filter((label) => label.construction === true).map((label) => [label.id, label] as const),
  );
  const raisedTexts: PartPlan['raisedTexts'] = [];
  const ctx: ItemReferenceContext = {
    stockOutline,
    profileOf: (id) => profiles.get(id) ?? null,
  };

  for (const item of order) {
    // A self-intersecting polygon is not a region — the fill rule would invent one (#214).
    // It is dropped here, at the one funnel every consumer reads, so no toolpath is ever
    // generated for it; `validateJob` reports the `polygon-self-intersecting` finding so the
    // user sees why it is missing rather than silently losing a cut.
    if (isShape(item) && item.kind === 'polygon' && polygonSelfIntersects(item.points)) continue;

    const profile =
      measure !== null && !isShape(item) && measure(item.text, item.font, item.weight, item.size) === null
        ? estimatedLabelProfile(item)
        : itemProfile(item, job.customFonts, ctx);
    profiles.set(item.id, profile);
    names.set(item.id, itemOperationName(item));
    // A construction item is reference-only (#215): it resolves, but cuts nothing.
    if (item.construction) continue;
    // #739 — a CUTAWAY around construction labels leaves RAISED TEXT standing: the panel is
    // cleared and the letters stay at full height. Carry the field it clears and those labels'
    // resolved profiles (only the islands that are construction labels), so the measurement
    // opens exactly the profile the CAM pockets.
    if (isShape(item) && item.kind === 'cutaway') {
      const islands = item.islands.flatMap((id) => {
        const island = profiles.get(id);
        return constructionLabels.has(id) && island !== undefined ? [{ labelId: id, profile: island }] : [];
      });
      if (islands.length > 0) raisedTexts.push({ id: item.id, field: profile, islands });
    }
    // #674 — a PRISM is not pocketed: the V cuts the RING around the shape, so the shape stands.
    // The ring is DERIVED here (pure profile algebra: an outward offset less the shape), from the
    // same `prismNumbers` the row, the findings and the sheet read. Its design is the TOP boundary
    // — the mouth at the top face — which the region builder treats like an inlay's. Without a cone
    // there is no ring to build, so the shape stays an ordinary region for the preview and
    // `prism-needs-cone` stops the job.
    if ('prism' in item && item.prism !== undefined && textureCarries(item.kind) && cone !== null) {
      const numbers = prismNumbers(cone, item.depth, item.prism).numbers;
      engraves.push({
        id: item.id,
        name: itemOperationName(item, 'Prism'),
        profile: prismRingProfile(profile, numbers.marginMm),
        depth: item.depth,
        prism: { baseMm: numbers.baseMm },
      });
      continue;
    }
    // #670 — a TEXTURE region is not pocketed: its pattern's strokes are traces, appended to that
    // list below. It still resolves a profile, so a frame or a cut-out may still name it. A
    // combined shape cannot carry one (its profile has holes); `validateJob` says so by name and
    // the item keeps its ordinary region behaviour here rather than vanishing.
    if ('texture' in item && item.texture !== undefined && textureCarries(item.kind)) continue;
    // A through region (#218) has no typed depth: its floor is the setup's `thickness +
    // breakthrough`, which is exactly what the region builder used to invent for itself. Carry
    // the flag as well, so the verifier's mask and the preview can tell it from a blind pocket
    // at the same depth.
    const through = 'through' in item && item.through === true;
    const variableDepth = 'vCarveDepth' in item && item.vCarveDepth === 'variable';
    const inlay =
      'inlay' in item && item.inlay !== undefined
        ? { role: item.inlay.role, glueGapMm: item.inlay.glueGapMm ?? DEFAULT_INLAY_GLUE_GAP_MM }
        : undefined;
    engraves.push({
      id: item.id,
      // The ready-made operation name (#214/#215), carried on the one funnel so the region
      // builder can hand it to `generateEngrave` without re-deriving the shape.
      name: itemOperationName(item),
      profile,
      depth: through ? job.stock.thickness + job.breakthrough : item.depth,
      through,
      ...(variableDepth ? { variableDepth: true } : {}),
      ...(inlay === undefined ? {} : { inlay }),
    });
  }

  // Profile cut-outs (#218), a fifth sibling. Their outline is resolved from the profiles map the
  // walk above filled, so an item that did not resolve (broken reference, cycle, self-intersecting
  // polygon) simply has no cut-out either. `'stock-inset'` follows the blank's own rectangle.
  const cutouts: PartPlan['cutouts'] = [];
  for (const cutout of job.cutouts ?? []) {
    if (!cutout.enabled) continue;
    const outline = cutout.of === 'stock-inset' ? stockOutline : profiles.get(cutout.of);
    if (outline === undefined) continue;
    cutouts.push({
      id: cutout.id,
      name: cutoutOperationName(cutout, cutout.of === 'stock-inset' ? null : (names.get(cutout.of) ?? null)),
      outline,
      side: cutout.side,
      inset: cutout.inset,
      depth: job.stock.thickness + job.breakthrough,
      thickness: job.stock.thickness,
      tabs: cutout.tabs,
    });
  }

  // CHAMFERS (#669), a seventh sibling. Their rim is the REFERENCED ITEM's own profile — its
  // outline, at the item's own geometry — and the chamfer states which side of it the cutter runs.
  // A chamfer whose rim never resolved is absent here, exactly as a cut-out with a broken
  // reference is: `validateJob` reports it and no path is generated.
  const chamfers: PartPlan['chamfers'] = [];
  for (const chamfer of job.chamfers ?? []) {
    if (!chamfer.enabled || chamfer.of === undefined) continue;
    const region = profiles.get(chamfer.of);
    if (region === undefined) continue;
    chamfers.push({
      id: chamfer.id,
      name: chamferOperationName(chamfer, names.get(chamfer.of) ?? null),
      outline: region,
      side: chamfer.side,
      width: chamfer.width,
    });
  }

  // 3D primitives (#435) join the SAME region funnel only where they reduce to a flat-floor
  // region: a box or cylinder opening out of the top face. Nothing references a primitive, so
  // there is no dependency ordering to respect and no entry in `profiles`. The refused forms are
  // deliberately absent here — `validateJob` names them and stops generation, so no toolpath can
  // be written from an approximation.
  for (const primitive of job.primitives ?? []) {
    if (!primitive.enabled || !primitiveReducesToRegion(primitive)) continue;
    const placed = pRotate(primitive.rotation, primitiveProfile(primitive));
    engraves.push({
      id: primitive.id,
      name: primitiveOperationName(primitive),
      profile: pTranslate([primitive.position.x, primitive.position.y], placed),
      depth: primitive.depth,
    });
  }

  // #677 — DERIVED regions (the variable V-carve's core) join the same funnel, after every item
  // region. They are cut by a program of their own, so their place here is only the CAM's
  // operation order within that program.
  for (const derived of options.derivedEngraves ?? []) engraves.push({ ...derived });

  // Traces (#219) are their own list: no topological ordering (nothing references one), no
  // profile, no region pipeline. A disabled or construction trace is skipped, like a region item;
  // a blank stroke label (no paths) is dropped rather than emitted as an empty operation.
  const traces: PartPlan['traces'] = [];
  for (const item of job.traces ?? []) {
    if (!item.enabled || item.construction) continue;
    const { paths, closed } = tracePaths(item, job.tool);
    if (paths.length === 0) continue;
    // #674 — a FLUTE: the line's depth becomes a profile along its path, derived HERE so the CAM,
    // the prediction and the picture read one array. The entry keeps the item's depth (the deepest
    // point), so the swept-cut check and the self-overlap warning stay conservative.
    if (item.kind === 'line' && item.flute !== undefined) {
      const numbers = fluteNumbers(item.flute, item.depth);
      const profile = fluteProfile(paths[0]!, closed[0] ?? false, item.depth, numbers.rampMm);
      traces.push({
        id: item.id,
        name: fluteOperationName(item),
        paths: [profile.points],
        closed: [profile.closed],
        depth: item.depth,
        depths: [profile.depths],
      });
      continue;
    }
    traces.push({ id: item.id, name: traceOperationName(item), paths, closed, depth: item.depth });
  }
  // #670 — TEXTURES join the same list, after the ordinary traces, in document order. The paths
  // are DERIVED here from the document's numbers (a seed and two lengths), never stored: the
  // pattern is a pure function of the shape and those numbers, so the same document posts the
  // same program byte for byte. A texture that cuts through, has no depth, or sits on a shape the
  // pattern cannot be clipped to produces nothing — `validateJob` names the reason.
  for (const item of job.shapes) {
    if (!item.enabled || item.construction || item.texture === undefined) continue;
    if (!textureCarries(item.kind) || item.through === true) continue;
    const numbers = textureNumbers(item.texture, item.depth);
    const strokes = textureStrokes(item, numbers);
    if (strokes.paths.length === 0) continue;
    traces.push({
      id: item.id,
      name: textureOperationName(numbers.pattern),
      paths: strokes.paths,
      closed: strokes.paths.map(() => false),
      depth: item.depth,
    });
  }

  // Plunge drills (#220) are a third sibling list: hole centres only, no profile and no region
  // pipeline. A disabled drill is skipped, like a disabled region item; `through` is carried
  // through for the region builder, which turns it into the local stock thickness. #668 — `mode`
  // and the bore's `diameter` travel the same way: the region builder needs the hole's radius for
  // its disc, and `validateJob` needs both for the bore's own refusals.
  const drills: PartPlan['drills'] = [];
  for (const item of job.drills ?? []) {
    if (!item.enabled) continue;
    drills.push({
      id: item.id,
      name: drillOperationName(item),
      holes: drillHoles(item),
      depth: item.depth,
      through: item.through,
      mode: item.mode ?? 'drill',
      diameter: item.diameter ?? null,
      ...(item.peckMm === undefined ? {} : { peckMm: item.peckMm }),
    });
  }

  // Milled threads (#445) are a fourth sibling list: one axis each, no profile and no region
  // pipeline. A disabled thread is skipped, like a disabled region item; `through` is carried
  // through for the CAM, which refuses it by name until the through-cut gate lands (#213/#218).
  const threads: PartPlan['threads'] = [];
  for (const item of job.threads ?? []) {
    if (!item.enabled) continue;
    threads.push({
      id: item.id,
      name: threadOperationName(item),
      position: [item.position.x, item.position.y],
      size: item.size,
      depth: item.depth,
      through: item.through,
    });
  }

  // Under-surface voids (#231): a disabled void reserves nothing. `zCeiling` is copied straight
  // through in the frame #178's layer stack reads (PART-frame z from the bottom face).
  const keepOuts: PartPlan['stock']['keepOuts'] = [];
  for (const ko of job.keepOuts ?? []) {
    if (!ko.enabled) continue;
    keepOuts.push({ id: ko.id, name: ko.name ?? '', footprint: keepOutProfile(ko), zCeiling: ko.zCeiling });
  }

  // #492 — the blank's two-colour facts, when the job holds one. This is the ONLY place the plan
  // learns there are colour planes at all; everything downstream (the stack, the boundary, the
  // limit) is inert without it. `split` stays PART-frame z, the frame #178 reads: cap is measured
  // from the TOP face, so the colour change is `thickness − capMm`.
  const colour = job.stock.colour;
  const layerGrid = printedLayerGridOf(job.stock);

  // #432 — the job's facing choice, as a depth or nothing. A toggle that is on with a zero depth
  // (the field not filled in yet) is NOT a facing pass: it removes nothing, and the plan says so
  // with `null` rather than handing CAM a zero-depth operation. #240 — a rod in the chuck is not
  // faced in this frame at all: a skim is a flat-blank pass, and the rotary findings refuse one.
  const facing =
    rotary === null && job.facing !== undefined && job.facing.enabled && job.facing.depth > 0
      ? { depth: job.facing.depth }
      : null;

  return {
    stock: {
      outline: stockOutline,
      supported: rotary ? rotaryMapSupport(rotary) : supportedFootprint(job.stock, job.sacrificial),
      thickness: job.stock.thickness,
      keepOuts,
      // #492 — the two-colour facts, copied in the plan's own frame. A laminate carries `split`
      // only (no printer grid); a printed blank carries its layer height too. Every key is absent
      // for a single-colour job, so it plans exactly as it always did.
      ...(colour
        ? {
            split: job.stock.thickness - colour.capMm,
            ...(layerGrid
              ? { layerHeight: layerGrid.layerHeight, firstLayerHeight: layerGrid.firstLayerHeight }
              : {}),
          }
        : {}),
    },
    raisedTexts,
    engraves,
    cutouts,
    chamfers,
    traces,
    drills,
    threads,
    facing,
  };
}
