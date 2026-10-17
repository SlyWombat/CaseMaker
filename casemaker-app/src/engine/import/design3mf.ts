import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import type { Mm } from '@/types/units';
import type { FilamentFibre, StockMaterial } from '@/types/engraveJob';
import { finalizeOutline } from './outlineTypes';
import { PrusaThreeMfError, type PrusaShapeVolume, type PrusaTextVolume, type PrusaThreeMf, type PrusaVolume } from './prusa3mf';

/**
 * The design a PrusaSlicer project describes, measured out of its own geometry (#410).
 *
 * `prusa3mf.ts` reads the format; this reads the BLANK and the DESIGN. Nothing here is typed in
 * from the issue's table: the stock, the colour split, every footprint, every depth and the
 * magnet pocket are measured off the mesh the file carries, so a different project file works
 * without a code change.
 *
 * The one thing that is NOT free is the frame. PrusaSlicer lays the blank out on the bed (this
 * file: 76.2 mm in X, 38.1 mm in Y); the bench clamps it the other way round (#383) — see
 * `fromDesign.ts`, which does the turn and says so. Everything here is still in the FILE's frame.
 */

/** One `NegativeVolume` of the design, as a region to cut. */
export interface DesignRegion {
  /** The volume's name, kept verbatim — it becomes the job item's name (#410). */
  name: string;
  /** Where the rings came from, as `finalizeOutline` stamped them (`<project> › <volume>`). */
  sourceName: string;
  /** The volume's XY shadow, mm, recentred on its own bounding box (the item's contour frame). */
  contours: [Mm, Mm][][];
  /** The shadow's size, mm. */
  width: Mm;
  height: Mm;
  /** The shadow's centre in the FILE frame, mm. */
  centre: [Mm, Mm];
  /** The volume's z extent in the file frame (z = 0 at the blank's back face), mm. */
  zMin: Mm;
  zMax: Mm;
  /** Cut depth from the blank's top face, mm: `topZ − zMin`, clamped to the thickness. */
  depth: Mm;
  /** The text tool's parameters, when the volume came from text. */
  text: PrusaTextVolume | null;
  /** The SVG parameters, when the volume came from a shape. */
  shape: PrusaShapeVolume | null;
}

/** A void under the top face, measured from the bottom colour's own mesh. */
export interface DesignPocket {
  /** Size in the FILE frame, mm. */
  length: Mm;
  width: Mm;
  /** Centre in the FILE frame, mm. */
  centre: [Mm, Mm];
  /** Ceiling height above the blank's bottom face, mm — `EngraveKeepOut.zCeiling`'s own quantity. */
  ceiling: Mm;
  /** How many separate holes the slice found (1 for a plain magnet pocket). */
  holes: number;
  /**
   * The LARGEST hole's ring, in the file frame — the void's real footprint, corner radii and all.
   * The bounding box above is for the report; this is what a keep-out is built from, so the job
   * protects the shape the blank actually has rather than its rectangle.
   */
  ring: [Mm, Mm][];
}

/** The blank and the design, measured, still in the file's frame. */
export interface DesignImport {
  /** The project's name, from the 3MF's Title. */
  name: string;
  /**
   * The blank's bounding box, from the `ModelPart` volumes. `minX`/`minY` are the file-frame
   * corner the job frame has to be anchored to — the design is not assumed to sit on the origin.
   */
  stock: { lengthX: Mm; widthY: Mm; thickness: Mm; minX: Mm; minY: Mm; zMin: Mm; zMax: Mm };
  /**
   * The colour change height above the BACK FACE, mm, or null for a single-extruder blank — the
   * frame `PartSpec.colourSplit` and `stock.print.split` state, and the one the pocket below is
   * sliced in. NOT an absolute file z: those two agree only on a blank that happens to start at
   * z = 0, and a lifted blank would put the boundary somewhere else entirely.
   */
  colourSplit: Mm | null;
  /**
   * The project's own layer height, mm, or null when it states none. READ from the saved print
   * profile, not assumed: this is the number that puts the colour boundary on the printer's layer
   * grid (#285), so a job that guessed it would put the boundary at a height that was never printed.
   */
  layerHeight: Mm | null;
  /** The project's first-layer height, mm, or null. */
  firstLayerHeight: Mm | null;
  /**
   * The blank's own filament, as the project's print settings state it (#456), or null when the
   * blank's volumes name no extruder at all.
   */
  filament: {
    /** `filament_type` for the blank's extruders, deduplicated, in the file's order (e.g. `['PETG']`). */
    types: string[];
    /** `filament_settings_id` for those extruders — the name a person sees in the slicer. */
    settingsIds: string[];
    /**
     * The app material for the blank, or null when the type is absent, names a class this app does
     * not know, or the blank's extruders disagree. Null means "the file did not settle it": the
     * job's existing material is left alone rather than silently becoming PLA.
     */
    material: StockMaterial | null;
    /**
     * The fibre the blank's filament states, or null. A `PETG-CF` profile keeps `petg` as its
     * material and carries `cf` here (#464): the base is what the feeds and the catalogue answer,
     * and the flag is what makes the wear weighting abrasive. Null when no extruder names one or
     * they disagree, and when `material` is null — a flag with no material has nothing to weigh.
     */
    fibre: FilamentFibre | null;
  } | null;
  /** Every volume that cuts the top face, in the file's own order. */
  regions: DesignRegion[];
  /** The void under the top face, or null when the blank has none. */
  pocket: DesignPocket | null;
  /** Plain-language notes: what was measured, what was skipped, what is uncertain. */
  notes: string[];
}

type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** The axis-aligned bounds of one volume's own triangles, in the file frame. */
function boundsOf(file: PrusaThreeMf, v: PrusaVolume): Bounds {
  const { vertProperties, triVerts } = file.mesh;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = v.firstId; t <= v.lastId; t++) {
    for (let c = 0; c < 3; c++) {
      const vi = triVerts[t * 3 + c]!;
      for (let a = 0; a < 3; a++) {
        const p = vertProperties[vi * 3 + a]!;
        if (p < min[a]!) min[a] = p;
        if (p > max[a]!) max[a] = p;
      }
    }
  }
  return { min, max };
}

/** One volume as a Manifold. The vertex array is shared; only the triangle range differs. */
function manifoldOf(tl: ManifoldToplevel, file: PrusaThreeMf, v: PrusaVolume) {
  const count = v.lastId - v.firstId + 1;
  const triVerts = new Uint32Array(count * 3);
  for (let i = 0; i < count * 3; i++) triVerts[i] = file.mesh.triVerts[v.firstId * 3 + i]!;
  const mesh = new tl.Mesh({
    numProp: 3,
    vertProperties: file.mesh.vertProperties,
    triVerts,
  });
  const solid = tl.Manifold.ofMesh(mesh);
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new PrusaThreeMfError(
      `The volume "${v.name}" is not a closed solid (Manifold: ${status}), so it has no footprint to cut.`,
    );
  }
  return solid;
}

/** mm, trimmed of float noise, for the notes. */
function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

/**
 * Measure a PrusaSlicer project into a blank and a set of regions.
 *
 * The blank is the `ModelPart` volumes' bounding box; the colour split is the top of the LOWEST
 * extruder's material, when the blank stacks more than one extruder. Every `NegativeVolume` that
 * CROSSES the top face becomes a region, cut to `topZ − itsBottom` — its own geometry, never a
 * nominal depth. A volume that misses the face from either side (wholly above it, or enclosed in
 * the blank) is named in the notes and left out: neither is a cut this job's model can make.
 */
export function readDesign(tl: ManifoldToplevel, file: PrusaThreeMf): DesignImport {
  const parts = file.volumes.filter((v) => v.volumeType !== 'NegativeVolume');
  if (parts.length === 0) {
    throw new PrusaThreeMfError('The 3MF has only NegativeVolumes; there is no blank to cut.');
  }

  const box: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const partBounds = new Map<PrusaVolume, Bounds>();
  for (const v of parts) {
    const b = boundsOf(file, v);
    partBounds.set(v, b);
    for (let a = 0; a < 3; a++) {
      box.min[a] = Math.min(box.min[a]!, b.min[a]!);
      box.max[a] = Math.max(box.max[a]!, b.max[a]!);
    }
  }
  const topZ = box.max[2]!;
  const lengthX = box.max[0]! - box.min[0]!;
  const widthY = box.max[1]! - box.min[1]!;
  const thickness = topZ - box.min[2]!;
  const notes: string[] = [
    `The blank is ${mm(lengthX)} × ${mm(widthY)} × ${mm(thickness)} mm, measured from the file's ` +
      `${parts.length} ModelPart volume${parts.length === 1 ? '' : 's'}.`,
  ];

  // The colour split: the top of the material of the LOWEST extruder present, as a HEIGHT ABOVE THE
  // BLANK'S BACK FACE — the frame `DesignImport.colourSplit` documents, and the only one every
  // consumer reads it in: `PartSpec.colourSplit`, `stock.print.split` and the pocket slice below.
  // The file's own absolute z is converted here, once. A blank printed in one extruder has no
  // boundary, and the job's depth model stays analytic (as for any job whose stock states no print,
  // #285).
  const bottomPart = parts.reduce((a, b) => (partBounds.get(a)!.min[2]! <= partBounds.get(b)!.min[2]! ? a : b));
  const bottomExtruder = bottomPart.extruder;
  const sameColour = parts.filter((v) => v.extruder === bottomExtruder);
  const colourSplit =
    sameColour.length === parts.length
      ? null
      : Math.max(...sameColour.map((v) => partBounds.get(v)!.max[2]!)) - box.min[2]!;
  if (colourSplit !== null) {
    notes.push(
      `The blank changes colour ${mm(colourSplit)} mm above its back face: ` +
        `${mm(thickness - colourSplit)} mm of extruder ${parts.find((v) => v.extruder !== bottomExtruder)?.extruder} ` +
        `material sits on top of extruder ${bottomExtruder}.`,
    );
  }

  const regions: DesignRegion[] = [];
  for (const v of file.volumes) {
    if (v.volumeType !== 'NegativeVolume') continue;
    const b = boundsOf(file, v);
    const centre: [Mm, Mm] = [(b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2];
    const solid = manifoldOf(tl, file, v);
    const cs = solid.project();
    const rings = cs.toPolygons().map((ring) => ring.map(([x, y]): [Mm, Mm] => [x, y]));
    solid.delete();
    cs.delete();

    const finalized = finalizeOutline({
      format: '3mf',
      sourceName: `${file.objectName} › ${v.name}`,
      contours: rings,
      // EvenOdd: a solid's slice or shadow never self-overlaps, so the rings' nesting alone decides
      // the fill, and the rule then does not depend on which way round this manifold build winds
      // its holes (it is CCW outward, but nothing here should have to know that).
      fillRule: 'EvenOdd',
      notes: [],
    });
    if (!finalized.ok) {
      notes.push(`Skipped "${v.name}": ${finalized.error}`);
      continue;
    }

    const belowFace = b.min[2]! > topZ + 1e-6;
    const depth = Math.min(Math.max(topZ - b.min[2]!, 0), thickness);
    if (belowFace) {
      notes.push(
        `"${v.name}" starts at z = ${mm(b.min[2]!)} mm, above the top face at ${mm(topZ)} mm — ` +
          'it cuts nothing and was left out.',
      );
      continue;
    }
    // A NegativeVolume that never REACHES the top face is not a cut from the face: it is a void
    // enclosed in the blank, and cutting to `topZ − its bottom` would machine away the membrane
    // between the face and the void — the material the design keeps. The job's model has no other
    // way to say "a pocket that starts below the surface", so such a volume is left out and named.
    // Measured on the volume's own triangles: a volume that breaks the surface by any amount
    // counts (the badge's text sits 0.015 mm proud), which is why the test is not against `topZ` by
    // equality.
    if (b.max[2]! < topZ - 1e-6) {
      notes.push(
        `"${v.name}" stops at z = ${mm(b.max[2]!)} mm, below the top face at ${mm(topZ)} mm — it is a ` +
          'void inside the blank rather than a cut from the face, so it was left out.',
      );
      continue;
    }
    regions.push({
      name: v.name,
      sourceName: finalized.outline.sourceName,
      contours: finalized.outline.contours,
      width: finalized.outline.width,
      height: finalized.outline.height,
      centre,
      zMin: b.min[2]!,
      zMax: b.max[2]!,
      depth,
      text: v.text,
      shape: v.shape,
    });
  }

  const pocket = readPocket(tl, file, parts, partBounds, colourSplit, box);

  return {
    name: file.objectName,
    stock: {
      lengthX,
      widthY,
      thickness,
      minX: box.min[0]!,
      minY: box.min[1]!,
      zMin: box.min[2]!,
      zMax: topZ,
    },
    colourSplit,
    layerHeight: mmSetting(file, 'layer_height'),
    firstLayerHeight: mmSetting(file, 'first_layer_height'),
    filament: blankFilamentOf(file),
    regions,
    pocket,
    notes,
  };
}

/** A millimetre setting out of the project's print profile, or null when it states none. */
function mmSetting(file: PrusaThreeMf, key: string): number | null {
  const raw = file.settings[key];
  if (raw === undefined) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The app materials for the PrusaSlicer filament CLASSES a printed blank can carry (#456).
 *
 * `filament_type`'s value is the class, so this is keyed by the slicer's own words. FLEX and TPU
 * are two spellings of the same rubber, and NYLON is the common name for PA, so each pair maps to
 * ONE app material. The fibre-filled nylons are classes of their own because the wear weighting
 * treats them differently — they are abrasive (`runEnd.ts`'s `WEAR_CLASS`).
 *
 * The OTHER fibre composites (#464) map to their BASE plastic and carry the fibre beside it:
 * `PETG-CF` is a `petg` blank plus `cf`, not a `petg-cf` material, and `runEnd.ts` reads the flag
 * to weight it as abrasive. A class this app does not know — the engineering/odd `PEEK`, and the
 * niche `PVB` — stays unmapped: a blank the app cannot name must leave the job's material as it
 * was rather than silently becoming PLA.
 */
const FILAMENT_TYPE_MATERIALS: Readonly<Record<string, StockMaterial>> = {
  PLA: 'pla',
  PETG: 'petg',
  PET: 'pet',
  ABS: 'abs',
  ASA: 'asa',
  HIPS: 'hips',
  PA: 'pa',
  NYLON: 'pa',
  'PA-CF': 'pa-cf',
  'PA-GF': 'pa-gf',
  'PET-CF': 'pet',
  'PETG-CF': 'petg',
  'PC-CF': 'pc',
  PC: 'pc',
  PP: 'pp',
  FLEX: 'tpu',
  TPU: 'tpu',
  PVA: 'pva',
};

/** Does an upper-cased profile name contain `word` as a whole word? `PA-CF` counts as one word. */
function profileSays(profile: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(profile);
}

/** A profile's nylon base — PA, PA6, PA11, PA12, NYLON — which a composite name may spell out. */
const NYLON_IN_PROFILE = /(^|[^A-Z0-9])(PA\d*|NYLON)([^A-Z0-9]|$)/;

/** One filament's app material, with the fibre flag the class may also state (#464). */
interface FilamentClass {
  material: StockMaterial;
  fibre: FilamentFibre | null;
}

/**
 * The fibre words a profile name states. The file's own example is `Prusament PA11 Carbon Fiber
 * @XL` (#456): neither `PA-CF` nor `PA` is a whole word there, so the fill is read on its own.
 */
const FIBRE_IN_PROFILE: readonly { fibre: RegExp; kind: FilamentFibre }[] = [
  { fibre: /(^|[^A-Z0-9])(CF|CARBON[ -]?FIB(?:ER|RE)?)([^A-Z0-9]|$)/, kind: 'cf' },
  { fibre: /(^|[^A-Z0-9])(GF|GLASS[ -]?FIB(?:ER|RE)?)([^A-Z0-9]|$)/, kind: 'gf' },
];

/** The fibre a FILAMENT CLASS word states (`PETG-CF`), or null. The class is one token, so no boundaries. */
function fibreInClass(stated: string): FilamentFibre | null {
  if (stated.endsWith('-CF')) return 'cf';
  if (stated.endsWith('-GF')) return 'gf';
  return null;
}

/**
 * The app material a PROFILE NAME states when `filament_type` is absent, or null.
 *
 * A fibre word is read first, and it needs a base in the same name to answer: a bare `Carbon
 * Fiber` profile is still unknown. With one, the base plastic is the material and the fibre is the
 * flag (#464) — except nylon, whose `pa-cf`/`pa-gf` classes already carry it. The class words are
 * matched as whole words, with a nylon base such as `PA11` counting as PA. Composite class words
 * are filtered out of the base match: `PA-CF` already contains the whole word `PA`, and counting
 * both would look like two different materials.
 */
function materialFromProfile(profile: string): FilamentClass | null {
  if (profile === '') return null;
  const fibres = FIBRE_IN_PROFILE.filter((f) => f.fibre.test(profile));
  if (fibres.length > 1) return null; // both fills named: no single flag
  const fibre = fibres[0]?.kind ?? null;
  const found = new Set(
    Object.entries(FILAMENT_TYPE_MATERIALS)
      .filter(([word]) => (fibre === null || !word.includes('-')) && profileSays(profile, word))
      .map(([, material]) => material),
  );
  if (NYLON_IN_PROFILE.test(profile)) found.add('pa');
  if (found.size !== 1) return null;
  const material = [...found][0]!;
  if (fibre === null) return { material, fibre: null };
  if (material === 'pa') return { material: fibre === 'cf' ? 'pa-cf' : 'pa-gf', fibre };
  return { material, fibre };
}

/**
 * The app material for ONE extruder's filament statements, or null when this app cannot name it.
 *
 * PRECEDENCE: `filament_type` is the class and it WINS. When it states anything, that is the whole
 * answer — a known class maps and an unknown class stays unknown, even if `filament_settings_id`
 * happens to contain a word this map knows. `filament_settings_id` is consulted only when
 * `filament_type` is absent, so a profile called "Prusament PA11 Carbon Fiber @XL" makes the
 * blank's class concrete — matched on whole words, so `PETG` is found in a PETG profile but not
 * inside an unrelated word.
 */
function materialForFilament(type: string | null, settingsId: string | null): FilamentClass | null {
  const stated = type?.trim().toUpperCase() ?? '';
  if (stated !== '') {
    const material = FILAMENT_TYPE_MATERIALS[stated];
    return material === undefined ? null : { material, fibre: fibreInClass(stated) };
  }
  return materialFromProfile(settingsId?.toUpperCase() ?? '');
}

/**
 * The blank's filament, from the project's own `filament_type` / `filament_settings_id` (#456).
 *
 * The entries are the BLANK's extruders only (`prusa3mf.ts` excludes `NegativeVolume` extruders),
 * so a modifier's plastic cannot answer for the blank. When those extruders disagree, or any of
 * them names a class this app cannot map, there is no single material to state and `material` is
 * null — the job keeps the material it had. The fibre flag follows the material: a blank whose
 * extruders all state one fill keeps it, one filled colour among unfilled ones is enough to make
 * the blank abrasive, and two different fills settle nothing.
 */
function blankFilamentOf(file: PrusaThreeMf): DesignImport['filament'] {
  if (file.blankFilaments.length === 0) return null;
  const types: string[] = [];
  const settingsIds: string[] = [];
  const materials: StockMaterial[] = [];
  const fibres: FilamentFibre[] = [];
  let resolved = true;
  for (const filament of file.blankFilaments) {
    if (filament.type !== null && !types.includes(filament.type)) types.push(filament.type);
    if (filament.settingsId !== null && !settingsIds.includes(filament.settingsId)) {
      settingsIds.push(filament.settingsId);
    }
    const stated = materialForFilament(filament.type, filament.settingsId);
    if (stated === null) resolved = false;
    else {
      if (!materials.includes(stated.material)) materials.push(stated.material);
      if (stated.fibre !== null && !fibres.includes(stated.fibre)) fibres.push(stated.fibre);
    }
  }
  const material = resolved && materials.length === 1 ? materials[0]! : null;
  return {
    types,
    settingsIds,
    material,
    fibre: material !== null && fibres.length === 1 ? fibres[0]! : null,
  };
}

/**
 * The void under the top face, read from the BOTTOM colour's own mesh.
 *
 * A magnet pocket is a hole in the bottom part that stops short of the top, so a slice of that
 * part below the split shows it as an interior ring. Slicing at half the split height is deep
 * enough to cross a pocket a printer could actually bridge and high enough to stay clear of the
 * back face's own features; the rings' holes ARE the void. Returns null when the blank is single
 * colour (nothing to slice) or the slice has no hole.
 */
function readPocket(
  tl: ManifoldToplevel,
  file: PrusaThreeMf,
  parts: PrusaVolume[],
  partBounds: Map<PrusaVolume, Bounds>,
  colourSplit: number | null,
  box: Bounds,
): DesignPocket | null {
  if (colourSplit === null || colourSplit <= 0) return null;
  // The part that reaches the blank's bottom face, i.e. the one the pocket is cut into.
  const bottom = parts.reduce((a, b) => (partBounds.get(a)!.min[2]! <= partBounds.get(b)!.min[2]! ? a : b));
  const solid = manifoldOf(tl, file, bottom);
  const cs = solid.slice(box.min[2]! + colourSplit / 2);
  solid.delete();
  const holes = cs
    .toPolygons()
    .map((ring) => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i]!;
        const [x1, y1] = ring[(i + 1) % ring.length]!;
        a += x0 * y1 - x1 * y0;
      }
      return { ring, area: a / 2 };
    })
    .filter((r) => r.area < 0);
  cs.delete();
  if (holes.length === 0) return null;

  // The largest hole is the pocket; a slice through a real blank can also catch a stray feature, and
  // the footprint below has to be the one the magnet goes in.
  const biggest = holes.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a));
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (const [x, y] of biggest.ring) {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
  }
  return {
    length: max[0] - min[0],
    width: max[1] - min[1],
    centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2],
    ring: biggest.ring.map(([x, y]): [Mm, Mm] => [x, y]),
    // The ceiling is where the hole STOPS: the highest slice that still shows it. Found by bisection
    // on the slice, so it is measured from the mesh rather than read off a nominal pocket depth.
    ceiling: pocketCeiling(tl, file, bottom, box.min[2]!, colourSplit, holes.length),
    holes: holes.length,
  };
}

/**
 * How high above the blank's bottom face the void reaches, mm — the highest z whose slice of
 * `part` still shows `holes` interior rings. Bisection over [zMin, split]: the mesh is linear
 * between its own facets, so 24 halvings resolve the ceiling to well under a micron.
 */
function pocketCeiling(
  tl: ManifoldToplevel,
  file: PrusaThreeMf,
  part: PrusaVolume,
  zMin: number,
  split: number,
  holes: number,
): number {
  const countHoles = (z: number): number => {
    if (z <= zMin) return 0;
    const solid = manifoldOf(tl, file, part);
    const cs = solid.slice(z);
    solid.delete();
    let n = 0;
    for (const ring of cs.toPolygons()) {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i]!;
        const [x1, y1] = ring[(i + 1) % ring.length]!;
        a += x0 * y1 - x1 * y0;
      }
      if (a < 0) n++;
    }
    cs.delete();
    return n;
  };
  let lo = zMin;
  let hi = zMin + split;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (countHoles(mid) >= holes) lo = mid;
    else hi = mid;
  }
  return lo - zMin;
}
