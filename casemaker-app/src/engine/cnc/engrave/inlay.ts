/**
 * #673 — THE V-CARVE INLAY PAIR: the FEMALE pocket and the MALE plug, and the numbers that make
 * them close.
 *
 * THE MODEL: a job is ONE blank. `job.stock` is singular, and the simulation, the frozen package,
 * the Cut step and the machine all assume one blank on the bed per run — so an inlay is TWO JOBS,
 * one per blank. The female's job is an ordinary job whose region carries an {@link InlayMark};
 * `inlayMaleJob` derives the male's document from it (its own id and name, its own copy of the
 * blank, the design MIRRORED in Y for the glue-up flip, and one cutaway cutting the complement
 * around the plug). The male is saved as its own job file and cut as its own run; the run sheets
 * say which blank each is. Nothing at run time links the two documents: the male stores the
 * numbers it was built for, and its sheet says to build it again if the female changed.
 *
 * THE NUMBERS, one set, one place (this file):
 *  - the pocket depth F is the region's own `depth` (the existing field);
 *  - the glue gap g is the marker's `glueGapMm`, default {@link DEFAULT_INLAY_GLUE_GAP_MM};
 *  - the cone (half-angle θ, the tangent `tanHalf`) is the job's V-bit.
 * Everything else is DERIVED here and nowhere else: the plug depth `P = F − g`, the plug's top
 * inset `g·tanθ`, its end inset `F·tanθ`, the wall clearance `g·cosθ`, and the floor gap `g`.
 *
 * THE GEOMETRY (z = 0 at the female's top face, positive up; the cavity below):
 *  - the FEMALE cavity's cross-section at depth d is `erode(design, d·tanθ)` — what a V at θ cuts;
 *  - the plug's cross-section at depth d is `erode(design, (g+d)·tanθ)`: at the glue plane (d = 0,
 *    the plug's BASE) that is the design's ring `g·tanθ` wide, and at its END (d = P = F − g) it is
 *    `erode(design, F·tanθ)` — exactly the female floor's extent, so it stops `g` above the floor;
 *  - so at every depth the plug sits INSIDE the cavity with the walls parallel. The clearance
 *    measured square to the flank is `g·sinθ`: the flank plane turns by θ from vertical, so a
 *    vertical shift of g moves it `g·tanθ` horizontally and `g·tanθ·cosθ = g·sinθ` square to it.
 *
 * ON THE MALE, the island the cut leaves standing GROWS with depth: the cut region at depth m is
 * `R ⊖ m·tanθ`, so its hole — the island — is `islandTop ⊕ m·tanθ`. The island at the male's TOP
 * face is therefore the plug's TIP (`erode(design, F·tanθ)` — the female floor's extent), and the
 * island at the male's FLOOR (m = P) is its BASE (`erode(design, g·tanθ)`). The male's top face is
 * the face that goes to the bottom of the female pocket: male depth m maps to female depth
 * `d = P − m`.
 *
 * The male's design is MIRRORED in Y about the blank's centre line: the male is machined on the
 * face that is glued down, so the part it makes is the mirror image of the design as the female
 * shows it, and the glue-up flip turns it back.
 */

import { newId } from '@/utils/id';
import { labelOutline } from './partPlan';
import { DEFAULT_INLAY_GLUE_GAP_MM } from './inlayDefaults';
import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveJob,
  EngraveLabel,
  EngraveShape,
  EngraveVectorShape,
  InlayMark,
} from '@/types/engraveJob';
import type { CustomFont } from '@/types/textLabel';
import type { VCone } from '../vProfile';

// The pair's one labelled default lives in `inlayDefaults.ts` so `partPlan.ts` can read it without
// importing this module (this module imports the plan's label outline); re-exported here so every
// existing importer keeps its path.
export { DEFAULT_INLAY_GLUE_GAP_MM };

/**
 * #673 — every number an inlay pair runs with, derived once from the pocket depth, the glue gap
 * and the cone. The row, the findings, the male's builder and both run sheets read THIS.
 */
export interface InlayNumbers {
  /** The female's flat depth, mm — the region's own `depth`. */
  pocketDepthMm: number;
  /** The vertical clearance between the plug's end and the female's floor, mm. */
  glueGapMm: number;
  /** The male's carve depth, hence how far the plug stands proud of its face, mm: `F − g`. */
  plugDepthMm: number;
  /**
   * How far the plug's BASE sits inside the design at the glue plane, mm: `g·tanθ` — the visible
   * ring after planing. A derived FACT, not a build offset.
   */
  topInsetMm: number;
  /**
   * The plug's TIP's own inset, mm: `F·tanθ` — exactly the female floor's extent, and the erosion
   * the MALE's island takes at its top face (the island grows with depth, so the top face is the
   * tip).
   */
  endInsetMm: number;
  /**
   * The wall clearance between the plug and the cavity, square to the flank, mm: `g·sinθ`. The
   * flank turns θ from vertical, so a vertical shift of g moves it `g·tanθ` horizontally and
   * `g·tanθ·cosθ = g·sinθ` square to it.
   */
  wallClearanceMm: number;
  /** The cone's half-angle tangent the numbers were derived with. */
  tanHalf: number;
}

export type InlayCheck = { ok: true; numbers: InlayNumbers } | { ok: false; reason: string };

/** `0.2` — a millimetre value as a sentence prints it. */
export function inlayMm(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * THE DERIVATION. The gap must be above zero (it IS the clearance) and below the pocket depth (a
 * plug that reaches the floor is a press fit with nowhere for the glue).
 */
export function inlayNumbers(cone: VCone, pocketDepthMm: number, glueGapMm: number): InlayCheck {
  if (!(pocketDepthMm > 0)) {
    return { ok: false, reason: 'the pocket depth must be above zero' };
  }
  if (!(glueGapMm > 0)) {
    return { ok: false, reason: `the glue gap must be above zero; it is ${inlayMm(glueGapMm)} mm` };
  }
  if (!(glueGapMm < pocketDepthMm)) {
    return {
      ok: false,
      reason:
        `the glue gap (${inlayMm(glueGapMm)} mm) must be below the pocket depth ` +
        `(${inlayMm(pocketDepthMm)} mm) — a plug that reaches the floor has no gap to glue into`,
    };
  }
  const tanHalf = cone.tanHalf;
  const sinHalf = tanHalf / Math.sqrt(1 + tanHalf * tanHalf);
  return {
    ok: true,
    numbers: {
      pocketDepthMm,
      glueGapMm,
      plugDepthMm: pocketDepthMm - glueGapMm,
      topInsetMm: glueGapMm * tanHalf,
      endInsetMm: pocketDepthMm * tanHalf,
      // Square to the flank: the vertical gap times sinθ (a vertical shift of g moves the flank
      // g·tanθ horizontally; its perpendicular component is g·tanθ·cosθ = g·sinθ).
      wallClearanceMm: glueGapMm * sinHalf,
      tanHalf,
    },
  };
}

/** The gap a marker runs with: its own, or the inlay default. */
export function inlayGlueGap(mark: InlayMark): number {
  return mark.glueGapMm ?? DEFAULT_INLAY_GLUE_GAP_MM;
}

/**
 * The items that carry an inlay mark, with their markers — the ONE owner of the set.
 *
 * #742 widened it to every kind a marker can be put on: labels (lettering is what most inlay jobs
 * are), the simple shapes, the combined kinds the schema already accepts, and imported vectors.
 * The findings, the recommendation, the run sheet and the male's derivation all read this list, so
 * an item can never carry a mark one reader sees and another does not.
 */
export function inlayMarked(
  job: EngraveJob,
): { item: EngraveAnyItem; mark: InlayMark }[] {
  const out: { item: EngraveAnyItem; mark: InlayMark }[] = [];
  for (const item of [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])]) {
    if (item.inlay !== undefined) out.push({ item, mark: item.inlay });
  }
  return out;
}

/**
 * Mirror a region item in Y about the blank's centre line — the glue-up flip about the X axis.
 *
 * The transform is exact: the position's Y becomes `width − y`, the rotation NEGATES (a mirror
 * conjugates a rotation: `diag(1,−1)·R(r)·diag(1,−1) = R(−r)`), and a polygon's or vector's local
 * points mirror in their own Y. Rect, circle and slot are symmetric in their own frame, so their
 * geometry needs nothing else.
 */
export function mirrorShapeInY<T extends EngraveShape | EngraveCombinedShape | EngraveVectorShape>(
  shape: T,
  stockWidth: number,
): T {
  const base = {
    ...shape,
    position: { x: shape.position.x, y: stockWidth - shape.position.y },
    rotation: -shape.rotation,
  };
  if (shape.kind === 'polygon') {
    return { ...base, points: shape.points.map(([x, y]) => [x, -y] as [number, number]) } as T;
  }
  if (shape.kind === 'vector') {
    return {
      ...base,
      contours: shape.contours.map((ring) => ring.map(([x, y]) => [x, -y] as [number, number])),
    } as T;
  }
  return base as T;
}

/** The male job's name for a female's: the pair's one link, said in words. */
export function inlayMaleJobName(femaleName: string): string {
  return `${femaleName} — male`;
}

/** A millimetre value in a refusal, printed to 0.001 mm without a trailing zero run. */
function mm(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * What a refusal calls an item, in the words the findings use (`jobSetup.itemLabel`). It lives
 * here rather than being imported because `jobSetup.ts` imports this module.
 */
function inlayItemName(item: EngraveAnyItem): string {
  if (!('kind' in item)) return `Engrave text "${item.text}"`;
  const named = item.name !== undefined && item.name !== '' ? ` "${item.name}"` : '';
  switch (item.kind) {
    case 'rect':
      return `Rectangle${named}`;
    case 'circle':
      return `Circle${named}`;
    case 'slot':
      return `Slot${named}`;
    case 'polygon':
      return `Polygon${named}`;
    case 'border':
      return `Border${named}`;
    case 'frame':
      return `Frame${named}`;
    case 'cutaway':
      return `Cutaway${named}`;
    case 'vector':
      return `Imported outline${named}`;
  }
}

/** What a referenced item is to the item naming it, for the refusal sentence. */
type MaleRefRole = 'outline' | 'island';

/** One item kind's mirrored copies, collected per list of the male document. */
interface MaleIslandItems {
  shapes: EngraveShape[];
  combined: EngraveCombinedShape[];
  vectors: EngraveVectorShape[];
}

interface MaleCopyContext {
  /** The male blank's width: the line the design mirrors about. */
  stockWidth: number;
  /** The plug depth every construction copy is given, mm (a construction item never cuts). */
  depth: number;
  /** Every item of the female's document, by id, for a combined item's references. */
  byId: ReadonlyMap<string, EngraveAnyItem>;
  customFonts: readonly CustomFont[];
  /** The id of the marked region's own copy; referenced copies are named from it. */
  rootId: string;
  out: MaleIslandItems;
  /** Original id → copy id, so a shared reference is copied once. */
  copies: Map<string, string>;
  /** The ids on the current reference path, so a cycle is refused rather than followed. */
  visiting: Set<string>;
}

type MaleCopy = { ok: true; id: string } | { ok: false; reason: string };

/** `it` for the marked region itself; `its island "x"` for an item it names. */
function maleSubject(role: MaleRefRole | null, ref: string): string {
  return role === null ? 'it' : `its ${role} "${ref}"`;
}

/** The name a mirrored copy carries, so the male's item list says what each construction is. */
function maleCopyName(item: EngraveAnyItem, isRoot: boolean): string {
  const suffix = isRoot ? 'plug' : 'mirror';
  if (!('kind' in item)) return `Engrave text "${item.text}" (${suffix})`;
  if (item.name !== undefined && item.name !== '') return `${item.name} (${suffix})`;
  return isRoot ? 'male plug' : `mirror of ${inlayItemName(item)}`;
}

/** Strip every cut-only marker: a mirrored copy is a construction island, not a cut of its own. */
function asConstruction<T extends EngraveShape | EngraveCombinedShape | EngraveVectorShape>(
  item: T,
  id: string,
  depth: number,
): T {
  const base = {
    ...item,
    id,
    depth,
    enabled: true,
    construction: true,
    inlay: undefined,
    texture: undefined,
    prism: undefined,
    vCarveDepth: undefined,
    through: undefined,
  };
  return base as T;
}

/**
 * A text label's placed outline as a construction VECTOR in the male document — the minimal model
 * support #742 needs, because a label has no geometry field to mirror. The rings are mirrored in
 * Y about the blank's centre line, then centred on their own box so the vector keeps the
 * document's convention (contours relative to `position`, the box's centre).
 */
function pushLabelOutline(
  label: EngraveLabel,
  id: string,
  outline: readonly (readonly [number, number][])[],
  ctx: MaleCopyContext,
  name: string,
): string {
  const mirrored = outline.map((ring) =>
    ring.map(([x, y]) => [x, ctx.stockWidth - y] as [number, number]),
  );
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of mirrored) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  ctx.out.vectors.push({
    id,
    kind: 'vector',
    name,
    sourceName: label.text.trim() === '' ? 'text' : label.text.trim(),
    contours: mirrored.map((ring) => ring.map(([x, y]) => [x - cx, y - cy] as [number, number])),
    fillRule: 'NonZero',
    width: Math.max(maxX - minX, 0.001),
    height: Math.max(maxY - minY, 0.001),
    position: { x: cx, y: cy },
    rotation: 0,
    depth: ctx.depth,
    enabled: true,
    construction: true,
  });
  return id;
}

/** Resolve one reference of a combined item to its mirrored copy. */
function mirrorReference(ref: string, role: MaleRefRole, ctx: MaleCopyContext): MaleCopy {
  const target = ctx.byId.get(ref);
  if (target === undefined) {
    return { ok: false, reason: `its ${role} "${ref}" is not in this job` };
  }
  if (!target.enabled) {
    return { ok: false, reason: `its ${role} "${ref}" is switched off` };
  }
  return mirrorRegionIntoMale(target, `${ctx.rootId}-ref-${ref}`, ctx, role, false);
}

/**
 * ONE female region — and everything a combined item references — as mirrored construction items
 * in the male's document. Refused, with the clause that says why, when a kind cannot be expressed
 * (a label with no text, a font that cannot be set here, a vector with no points) or a reference
 * cannot be followed (missing, switched off, or a cycle).
 */
function mirrorRegionIntoMale(
  item: EngraveAnyItem,
  id: string,
  ctx: MaleCopyContext,
  role: MaleRefRole | null,
  isRoot: boolean,
): MaleCopy {
  const memo = ctx.copies.get(item.id);
  if (memo !== undefined) return { ok: true, id: memo };
  const subject = maleSubject(role, item.id);
  if (ctx.visiting.has(item.id)) {
    return { ok: false, reason: `${subject} refers back to itself` };
  }

  ctx.visiting.add(item.id);
  try {
    let result: MaleCopy;
    if (!('kind' in item)) {
      let outline: [number, number][][] | null;
      try {
        outline = labelOutline(item, ctx.customFonts);
      } catch {
        // `resolveFont` throws when a face is not parsed (a custom font can also be unavailable).
        return { ok: false, reason: `${subject} cannot be set in its font` };
      }
      if (outline === null || outline.length === 0) {
        return {
          ok: false,
          reason: item.text.trim() === '' ? `${subject} has no text` : `${subject} has no shape`,
        };
      }
      result = { ok: true, id: pushLabelOutline(item, id, outline, ctx, maleCopyName(item, isRoot)) };
    } else if (item.kind === 'border') {
      // A border follows the stock outline, which is a rectangle centred on the blank: the Y
      // mirror maps it onto itself, so the copy is the same ring under a new id.
      ctx.out.combined.push({ ...asConstruction(item, id, ctx.depth), name: maleCopyName(item, isRoot) });
      result = { ok: true, id };
    } else if (item.kind === 'frame') {
      const around = mirrorReference(item.around, 'outline', ctx);
      if (!around.ok) return around;
      ctx.out.combined.push({
        ...asConstruction(item, id, ctx.depth),
        name: maleCopyName(item, isRoot),
        around: around.id,
      });
      result = { ok: true, id };
    } else if (item.kind === 'cutaway') {
      const outer = mirrorReference(item.outer, 'outline', ctx);
      if (!outer.ok) return outer;
      const islands: string[] = [];
      for (const island of item.islands) {
        const copy = mirrorReference(island, 'island', ctx);
        if (!copy.ok) return copy;
        islands.push(copy.id);
      }
      ctx.out.combined.push({
        ...asConstruction(item, id, ctx.depth),
        name: maleCopyName(item, isRoot),
        outer: outer.id,
        islands,
      });
      result = { ok: true, id };
    } else if (item.kind === 'vector') {
      if (item.contours.length === 0) return { ok: false, reason: `${subject} has no shape` };
      const mirrored = mirrorShapeInY(item, ctx.stockWidth);
      ctx.out.vectors.push({ ...asConstruction(mirrored, id, ctx.depth), name: maleCopyName(item, isRoot) });
      result = { ok: true, id };
    } else {
      const mirrored = mirrorShapeInY(item, ctx.stockWidth);
      ctx.out.shapes.push({ ...asConstruction(mirrored, id, ctx.depth), name: maleCopyName(item, isRoot) });
      result = { ok: true, id };
    }
    if (result.ok) ctx.copies.set(item.id, result.id);
    return result;
  } finally {
    ctx.visiting.delete(item.id);
  }
}

export type InlayMaleResult =
  | { ok: true; job: EngraveJob }
  | {
      ok: false;
      reason: string;
      /** The marked item whose region refused, when the refusal is about one region. */
      itemId?: string;
    };

/**
 * #673 — THE MALE BLANK'S DOCUMENT, derived from the female's.
 *
 * The male is an ordinary job: one blank (a copy of the female's, its measured bow dropped — it
 * is a different piece), the same cutter, and ONE cutaway whose islands are ALL the inlay regions.
 * Each region's ISLAND is a construction copy of the marked item MIRRORED in Y (#742): a shape, a
 * combined item with mirrored copies of everything it references, a vector, or a label converted
 * to a vector of its placed glyph outline. The cutaway clears everything around those islands, so
 * each one survives as a plug. Its depth is the derived `P = F − g`, and its marker stores the
 * numbers it was built for, including the island's erosion (`F·tanθ`), which `itemProfile` applies
 * as a profile offset.
 *
 * Refused — with a sentence that names the region — when the female has no inlay region, when a
 * region's numbers do not derive, when two regions disagree on pocket depth or glue gap (the one
 * cutaway erodes every island by one inset), or when a mark cannot be expressed as a mirrored
 * island (text with no ink, a reference that is missing or switched off). Nothing is silently
 * dropped: a male missing one of its regions would be an incomplete pair.
 */
export function inlayMaleJob(job: EngraveJob, cone: VCone): InlayMaleResult {
  const females = inlayMarked(job).filter(
    (entry) => entry.mark.role === 'female' && entry.item.enabled,
  );
  if (females.length === 0) {
    return { ok: false, reason: 'this job has no inlay region to make a male for' };
  }
  const byId = new Map<string, EngraveAnyItem>();
  for (const item of [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])]) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const margin = Math.max(job.edgeMargin, 0.5);
  const out: MaleIslandItems = { shapes: [], combined: [], vectors: [] };
  const regions: { item: EngraveAnyItem; numbers: InlayNumbers; islandId: string }[] = [];
  for (const { item, mark } of females) {
    const who = inlayItemName(item);
    // #742 — a REFERENCE item cuts nothing, so its "pocket" is not a pocket: a male derived from
    // it would pair with a female half the female's own program never made. Refused in words, not
    // dropped (the mark may be left over from before the item was made reference-only).
    if (item.construction === true) {
      return {
        ok: false,
        itemId: item.id,
        reason:
          `${who} is marked as the female half of an inlay, but no male can be made: it is ` +
          'reference only, so there is no pocket for a plug to fit.',
      };
    }
    const check = inlayNumbers(cone, item.depth, inlayGlueGap(mark));
    if (!check.ok) {
      return {
        ok: false,
        itemId: item.id,
        reason: `${who} is marked as the female half of an inlay, but no male can be made: ${check.reason}.`,
      };
    }
    const islandId = `inlay-plug-${regions.length + 1}`;
    const copied = mirrorRegionIntoMale(
      item,
      islandId,
      {
        stockWidth: job.stock.width,
        depth: check.numbers.plugDepthMm,
        byId,
        customFonts: job.customFonts,
        rootId: islandId,
        out,
        copies: new Map(),
        visiting: new Set(),
      },
      null,
      true,
    );
    if (!copied.ok) {
      return {
        ok: false,
        itemId: item.id,
        reason: `${who} is marked as the female half of an inlay, but no male can be made: ${copied.reason}.`,
      };
    }
    regions.push({ item, numbers: check.numbers, islandId });
  }
  // The construction items never cut, but the schema wants a real depth on every shape; the plug
  // depth is the honest one (it is the depth the island is carved around).
  const blankId = 'inlay-blank';
  const shapes: EngraveShape[] = [
    {
      id: blankId,
      name: 'blank around the plugs',
      kind: 'rect',
      position: { x: job.stock.length / 2, y: job.stock.width / 2 },
      rotation: 0,
      depth: regions[0]!.numbers.plugDepthMm,
      cornerRadius: 0,
      width: Math.max(0.1, job.stock.length - 2 * margin),
      height: Math.max(0.1, job.stock.width - 2 * margin),
      enabled: true,
      construction: true,
    },
  ];
  // #742 review — ONE CUTAWAY, because a plug is one piece of the male blank. One cutaway PER
  // region each cleared the blank except for its OWN island, so with two marks the ring's cutaway
  // erased the lettering's island (and the lettering's erased the ring): together they cut away
  // the whole blank and no plug survived. The one cutaway names EVERY region as an island, so
  // each is excluded from the region that clears around it.
  //
  // `itemProfile` erodes every island of a male cutaway by the ONE `islandInsetMm` the marker
  // stores. Mixed pocket depths or glue gaps would therefore cut one region's island at another
  // region's inset, and which one won would depend on document order — refuse them instead of
  // silently making a pair that does not fit.
  const first = regions[0]!.numbers;
  for (const region of regions) {
    const n = region.numbers;
    if (
      Math.abs(n.pocketDepthMm - first.pocketDepthMm) <= 1e-9 &&
      Math.abs(n.glueGapMm - first.glueGapMm) <= 1e-9
    ) {
      continue;
    }
    return {
      ok: false,
      itemId: region.item.id,
      reason:
        `${inlayItemName(region.item)} and ${inlayItemName(regions[0]!.item)} are both female ` +
        'halves of one inlay, but their pockets are ' +
        `${mm(n.pocketDepthMm)} mm deep with a ${mm(n.glueGapMm)} mm glue gap and ` +
        `${mm(first.pocketDepthMm)} mm deep with a ${mm(first.glueGapMm)} mm glue gap. A male ` +
        'plug is one piece cut by one region around every island, so all the female halves must ' +
        'share one depth and one glue gap: match them, or save this half as a job of its own.',
    };
  }
  const only = regions[0]!.item;
  const onlyName = 'kind' in only ? only.name : `Engrave text "${only.text}"`;
  const cuts: EngraveCombinedShape[] = [
    {
      kind: 'cutaway',
      id: 'inlay-male-1',
      name:
        regions.length > 1
          ? 'male plugs'
          : onlyName === undefined || onlyName === ''
            ? 'male plug'
            : `${onlyName} — male plug`,
      position: { x: 0, y: 0 },
      rotation: 0,
      depth: first.plugDepthMm,
      enabled: true,
      outer: blankId,
      islands: regions.map((region) => region.islandId),
      inlay: {
        role: 'male',
        glueGapMm: first.glueGapMm,
        pocketDepthMm: first.pocketDepthMm,
        tanHalf: first.tanHalf,
        // The island's TOP face is the plug's TIP (the V's hole grows with depth), so the island
        // is eroded by the tip's inset — the female floor's extent — not by the base's ring. Every
        // region shares it: the mixed-numbers refusal above is what makes one inset honest.
        islandInsetMm: first.endInsetMm,
      },
    },
  ];
  const { flatness: _measuredOnTheFemale, ...stock } = job.stock;
  return {
    ok: true,
    job: {
      schemaVersion: 3,
      id: newId('job'),
      name: inlayMaleJobName(job.name),
      machineId: job.machineId,
      stock,
      // Each plug's island is a construction item (or items, for a combined region); the ONE
      // cutaway is the operation. No setups: the implicit single setup cuts the male's region
      // with the job's cutter.
      labels: [],
      shapes: [...shapes, ...out.shapes],
      combined: [...out.combined, ...cuts],
      ...(out.vectors.length === 0 ? {} : { vectors: out.vectors }),
      toolKey: job.toolKey,
      ...(job.tool === undefined ? {} : { tool: job.tool }),
      workholding: job.workholding,
      minFloor: job.minFloor,
      edgeMargin: job.edgeMargin,
      sacrificial: job.sacrificial,
      breakthrough: job.breakthrough,
      jawClearance: job.jawClearance,
      ...(job.margins === undefined ? {} : { margins: job.margins }),
      ...(job.cutOverride === undefined ? {} : { cutOverride: job.cutOverride }),
      ...(job.metalLineOverride === undefined ? {} : { metalLineOverride: job.metalLineOverride }),
      ...(job.facing === undefined ? {} : { facing: job.facing }),
      customFonts: [],
    },
  };
}
