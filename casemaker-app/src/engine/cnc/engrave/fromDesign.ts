import { newEngraveShapeId } from '@/engine/cnc/engrave/defaults';
import { isShippedDemoLabelSet } from '@/engine/cnc/engrave/blankLabelSeed';
import { DEFAULT_BADGE_DOME_MM } from '@/engine/cnc/engrave/fromBadge';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import type { DesignImport } from '@/engine/import/design3mf';
import type { Mm } from '@/types/units';
import type {
  EngraveJob,
  EngraveJobSources,
  EngraveKeepOut,
  EngraveVectorShape,
  StockFlatness,
} from '@/types/engraveJob';

/**
 * A measured design as a stock-and-items patch (#410).
 *
 * `design3mf.ts` reads the blank and the design out of a PrusaSlicer project, in THE FILE'S OWN
 * FRAME. This is the second half: it puts them in the JOB's frame, and returns a patch rather than
 * a job — the same discipline as `badgeBlankFor` (#271).
 *
 * THE TURN, and why there is one. PrusaSlicer lays the blank out on the print bed, long side in X
 * (this file: 76.2 mm in X, 38.1 mm in Y). The bench clamps it the other way (#383): the jaws close
 * across the blank's 38.1 mm span, so that side runs across the jaws in X and the 76.2 mm side runs
 * along the feed, in Y. The design therefore has to be turned a quarter turn — and WHICH quarter
 * turn is a choice, not a fact:
 *
 *   - `ccw` (the default): `job_x = maxY − file_y`, `job_y = file_x − minX`. The file's +X — the way
 *     its text reads — runs away from the operator; its +Y runs toward the fixed jaw.
 *   - `cw`: `job_x = file_y − minY`, `job_y = maxX − file_x`. The other quarter turn, i.e. the `ccw`
 *     layout seen from the other end of the vise.
 *
 * Both are proper rotations (determinant +1), so neither mirrors the design — text reads correctly
 * either way and only its orientation on the bench differs. That is the opposite of a flip, and the
 * reason both are offered rather than one being "right": the design is not mirrored either way, so
 * the choice is the operator's convention, not a correctness question. The notes SAY which way this
 * patch turned it, because a job document cannot be read without knowing.
 *
 * The rings themselves are NOT rotated: they are always relative to their own bounding-box centre
 * (an item's contour frame), and a quarter turn about that centre is exactly the item's own
 * `rotation` field. So the measured points are carried verbatim and the turn is one number.
 *
 * This module is PURE and returns a patch: `engraveJobStore` owns the write and the `sources`
 * stamping (#254), exactly as it does for the badge route.
 */

/**
 * Which quarter turn puts the design on the jaws. See the module doc — both are proper rotations,
 * so this is a convention, not a correctness switch.
 */
export type DesignReadingDirection = 'ccw' | 'cw';

/**
 * The id the design's magnet pocket is declared under. FIXED, for the same reason the badge's is:
 * applying a design twice must land on the same void rather than a second copy of it, and the id is
 * how "the void the design brought" is told apart from one the user typed (`ko-…`).
 */
export const DESIGN_POCKET_KEEP_OUT_ID = 'design-magnet-pocket';

/**
 * Which design FILE a contribution came from (#437): the project's own Title, and the SHA-256 of
 * the bytes it was read from.
 *
 * The Title, not the picked filename: it is the identity the file itself carries, so a design
 * renamed on disk is still the same design, and re-saving it is what changes the hash. A re-import
 * of the same source REPLACES its previous items instead of adding a second set; an identical hash
 * means the bytes did not change, so the import is a no-op rather than a duplication.
 */
export interface DesignSource {
  /** The project's Title, as the 3MF metadata carries it — `DesignJobPatch.name`. */
  name: string;
  /** SHA-256 of the file's bytes, lowercase hex. */
  sha256: string;
}

/** What a design contributes, as plain data for the store to write. */
export interface DesignJobPatch {
  /** The project's name, as the 3MF's Title carries it. */
  name: string;
  /**
   * The file this patch was read from, when the caller read one (#437). Absent on patches built
   * without a file — the CLI's fresh-job route and tests — and then the import can only add.
   */
  source?: DesignSource;
  /**
   * The blank, in `EngraveJob.stock`'s shape and the JOB's frame. `material` is present only when
   * the file's own `filament_type` names a class this app knows (#456); otherwise the key is
   * OMITTED, so `setStock` leaves the job's existing material untouched instead of assuming PLA.
   */
  stock: Omit<EngraveJob['stock'], 'material'> & { material?: EngraveJob['stock']['material'] };
  /** One item per `NegativeVolume` that cuts the top face, named after the volume. */
  vectors: EngraveVectorShape[];
  /** The void under the top face, or null when the blank has none. */
  keepOut: EngraveKeepOut | null;
  /** Provenance for the fields this patch writes (#254). */
  sources: EngraveJobSources;
  /** One sentence per thing the design settled, for the panel to state back to the user. */
  notes: string[];
}

/**
 * The items a job can carry, as one list of lists — what `designReplacesItems` looks over.
 * `labels` is `EngraveJob`'s own required array; the rest are optional on the document.
 */
type JobItems = Pick<EngraveJob, 'labels'> & Partial<Pick<EngraveJob, 'shapes' | 'combined' | 'traces' | 'drills' | 'vectors'>>;

/**
 * May applying a design REPLACE this job's items? (#410 item 4 — the panel's import.)
 *
 * True only for a job that is still the one the app laid out: the shipped demo lines
 * (`isShippedDemoLabelSet`) and nothing else on it at all. Those three demo words are the hazard
 * the CLI route names — they are laid out for the 100 × 60 mm plank, so leaving them standing on a
 * 76.2 × 38.1 mm badge cuts `CASE` and `MAKER` into it.
 *
 * A job a person has put anything on is THEIRS. The design's items are added to it and the job
 * reports the findings that follow (an item the smaller blank no longer holds is `item-outside-stock`,
 * named and counted, not moved or dropped) — the same answer `takeBadgeBlank` gives a line it must
 * not re-lay, and for the same reason: a route may edit what a route wrote.
 *
 * Every list is checked, not just `labels`: a job whose words are still the demo's but which carries
 * a shape someone drew is a job someone has worked on.
 */
export function designReplacesItems(job: JobItems): boolean {
  const count = (x: { length: number } | undefined): number => x?.length ?? 0;
  return (
    isShippedDemoLabelSet(job) &&
    count(job.shapes) + count(job.combined) + count(job.traces) + count(job.drills) + count(job.vectors) === 0
  );
}

/** How far the design turns, degrees counter-clockwise about each item's own centre. */
export function designRotation(direction: DesignReadingDirection = 'ccw'): number {
  return direction === 'ccw' ? 90 : -90;
}

/**
 * A measurement as the job holds it: mm to the micron.
 *
 * Everything this module copies out of the file comes off a triangle soup, so it arrives at fifteen
 * significant figures — `38.099998474121094` for a blank that is 38.1, `0.9849972724914551` for a
 * floor the file states as 0.985. Full float noise is not precision: the panel's blank fields read
 * back `38.099998` while the note printed directly above them says 76.2 × 38.1 × 3.81, and a saved
 * job carries numbers no machine on this bench can act on. One micron is what every other number in
 * this module is WRITTEN at (`mm()` below rounds to the same place, as do the badge, blank, coupon
 * and run-sheet modules), and it is two orders of magnitude finer than the printer's layers or the
 * Z1's resolution — so the patch is written at that precision, once, at the boundary where the
 * FILE's frame becomes the JOB's.
 */
function um(v: number): Mm {
  return Number(v.toFixed(3));
}

/** The job's `length` and `width` for a blank measured in the file's frame — the swap itself. */
export function designStockSize(design: DesignImport): { length: Mm; width: Mm } {
  return { length: um(design.stock.widthY), width: um(design.stock.lengthX) };
}

/**
 * One point of the FILE frame in the JOB frame, mm. The job's origin is the blank's front-left
 * corner, so this maps the file's bounding box onto [0, length] × [0, width] exactly — the design
 * is not assumed to be centred on the file origin.
 */
export function designPointToJob(
  design: DesignImport,
  x: Mm,
  y: Mm,
  direction: DesignReadingDirection = 'ccw',
): { x: Mm; y: Mm } {
  const { minX, minY, lengthX, widthY } = design.stock;
  // Rounded here rather than at every call site: this is where a file-frame pair becomes a job
  // position, and the arithmetic above can reintroduce noise even from clean inputs.
  return direction === 'ccw'
    ? { x: um(minY + widthY - y), y: um(x - minX) }
    : { x: um(y - minY), y: um(minX + lengthX - x) };
}

/** `76.2` rather than `76.2…` — the notes are read, not parsed. */
function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

/** The badge blank's nominal size, mm — the part #345 measured the dome on (3 × 1.5 × 0.15 in). */
const BADGE_BLANK_MM = { lengthX: 76.2, widthY: 38.1, thickness: 3.81 } as const;

/** How far a measured blank may sit from that nominal size and still be that part, mm. */
const BADGE_BLANK_TOLERANCE_MM = 0.05;

/**
 * Is this the printed badge blank whose dome #345 measured? (#437)
 *
 * The 0.33 mm is a property of ONE printed part, not of every two-colour project: a 100 × 60 mm
 * plaque printed in two colours is not that blank, and it has no measured dome at all. The check is
 * the three dimensions — the file may lay the blank either way round — to a loose tolerance, because
 * the measurement comes off a triangle soup and `um()` only rounds what is written, not what is read.
 */
function isBadgeBlank(design: Pick<DesignImport, 'stock'>): boolean {
  const { lengthX, widthY, thickness } = design.stock;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= BADGE_BLANK_TOLERANCE_MM;
  const footprint =
    (near(lengthX, BADGE_BLANK_MM.lengthX) && near(widthY, BADGE_BLANK_MM.widthY)) ||
    (near(lengthX, BADGE_BLANK_MM.widthY) && near(widthY, BADGE_BLANK_MM.lengthX));
  return footprint && near(thickness, BADGE_BLANK_MM.thickness);
}

/**
 * The dome on the engraved face, or undefined (#345, #437).
 *
 * Only the badge blank gets a dome. For it `across` is computed from THIS job's spans rather than
 * copied from the badge route: the two routes turn the blank the same way since #383, but `across`
 * names a span in the JOB's frame (`materialScan.ts` reads `'width'` as its X, and carries the
 * warning), so the 38.1 mm span — the one #345 measured the 0.33 mm across — is this job's
 * `length`. Its source is `badge`: this route COPIES the badge blank's own default, it did not
 * measure anything here.
 *
 * For any other blank the dome is unknown, not a chosen default: a design file states no dome, and
 * stamping the badge's number onto an arbitrary plaque would put a figure nobody supplied into the
 * Z budget. `undefined` leaves the job with a flat assumption, which the notes say out loud.
 */
function stockFlatnessFor(
  design: DesignImport,
  stock: { length: Mm; width: Mm },
): StockFlatness | undefined {
  if (!isBadgeBlank(design)) return undefined;
  return {
    dome: DEFAULT_BADGE_DOME_MM,
    across: stock.length <= stock.width ? 'length' : 'width',
    source: 'badge',
  };
}

/**
 * Read `design` as this job's blank and its items, in the job's frame.
 *
 * Deliberately narrow, like `badgeBlankFor`: it settles what the BLANK is and what the design says
 * to cut, and touches no tool, no feeds, no vise and no margin. Which cutter does the cutting is a
 * separate decision (the two-tool rest-machining route, #410's second half) and belongs to a
 * module that can see the reachability numbers; a patch that guessed a cutter here would be a
 * choice made with less information than the panel has.
 */
export function designJobFor(
  design: DesignImport,
  opts: { direction?: DesignReadingDirection; id?: () => string; source?: DesignSource } = {},
): DesignJobPatch {
  const direction = opts.direction ?? 'ccw';
  const id = opts.id ?? newEngraveShapeId;
  const source = opts.source;
  const { length, width } = designStockSize(design);
  const rotation = designRotation(direction);
  // `undefined` on the synthetic patch shapes older callers build, and null when the file states
  // no class this app maps; both mean "the file did not settle the material" (#456).
  const filament = design.filament ?? null;
  const material = filament?.material ?? null;
  const stock: DesignJobPatch['stock'] = {
    length,
    width,
    thickness: um(design.stock.thickness),
    // The file's OWN filament class when it names one this app knows (#456). Omitted otherwise:
    // an unknown or absent type must not silently become PLA, so the job's material stays as it is.
    ...(material !== null ? { material } : {}),
    // The fibre the same filament states, when it states one this app knows (#464). ALWAYS present
    // and `undefined` when the file names none — same convention as `print` below, and the reason
    // it matters: re-importing a plain PETG design over a `PETG-CF` one has to take the flag away,
    // or every later run is still weighed as cutting an abrasive. A file whose class is unknown
    // states no fibre either (`parseFilament` only flags one beside a base it mapped).
    fibre: filament?.fibre ?? undefined,
    // Both keys are ALWAYS present and `undefined` when the file states no print — the convention
    // `fromBadge.ts` documents and the reason for it is the same here (#285 review). A job taking
    // this patch may already carry a layer grid from a blank that had one, and `setStock` reads the
    // KEY to decide whether to clear it: omitted means "this patch says nothing about the print",
    // which is not what a design that stated none has said. The CLI route builds a fresh job and
    // would never have noticed; the panel's import applies onto the job that is open.
    print: undefined,
    flatness: undefined,
  };

  const notes: string[] = [
    `The blank is ${mm(length)} × ${mm(width)} × ${mm(design.stock.thickness)} mm: the file's ` +
      `${mm(design.stock.lengthX)} × ${mm(design.stock.widthY)} laid across the jaws (#383), so its ` +
      `${mm(design.stock.widthY)} mm side now runs in Y along the feed and its ${mm(design.stock.lengthX)} mm ` +
      'side across them in X.',
    `The design was turned 90° ${direction === 'ccw' ? 'COUNTER-CLOCKWISE' : 'CLOCKWISE'} as seen from ` +
      'above to get there' +
      (direction === 'ccw'
        ? ": the file's +X — the way its text reads — runs away from the operator, its +Y toward the fixed jaw."
        : ": the file's +X — the way its text reads — runs toward the operator, its +Y toward the moving jaw."),
    'Nothing was mirrored: a quarter turn is a proper rotation, so the design reads correctly and only ' +
      'its orientation on the bench differs.',
    ...design.notes,
  ];

  // The blank's material, from the project's own filament statement (#456). The note is what makes
  // the value read as READ FROM THE FILE rather than computed or assumed: `computed` in `sources`
  // says the app derived the patch, and this sentence says which line of the file it came from.
  if (material !== null) {
    const fromSettings =
      filament!.settingsIds.length > 0
        ? `filament_settings_id ${filament!.settingsIds.map((id) => `"${id}"`).join(', ')}`
        : null;
    // Name the statement that actually settled the class (#456): a project with no
    // `filament_type` is answered by its profile name, and the note must not call that a type.
    const stated =
      filament!.types.length > 0
        ? `filament_type (${filament!.types.join(', ')}${fromSettings === null ? '' : `, ${fromSettings}`})`
        : (fromSettings ?? 'filament_type');
    notes.push(
      `The blank's filament is ${MATERIAL_LABELS[material]}, read from the file's own ${stated}. ` +
        "The job's stock material is the file's, not an assumption.",
    );
    // #464 — the fill is a separate statement on the job, so say which one was read and what it
    // changes. The material above is the BASE plastic on purpose; only the wear weighting reads
    // this flag, and a note that folded the two together would misdescribe what the row says.
    if (stock.fibre !== undefined) {
      const fill = stock.fibre === 'cf' ? 'carbon fibre' : 'glass fibre';
      notes.push(
        `The same filament states a ${fill} fill: the blank is cut as its base plastic, and the run's ` +
          'tool wear is weighed as cutting an abrasive — that is what the fibre flag on the job is for.',
      );
    }
  } else if (filament !== null) {
    const stated = filament.types.length > 0 ? filament.types.join(', ') : 'no filament_type';
    notes.push(
      `The file says ${stated} for the blank, which this app does not map to a stock material, so ` +
        "the job's stock material was left as it was.",
    );
  }

  // The print facts the file itself carries. They are what makes the depth limit follow the colour
  // boundary on the printer's own layer grid instead of a nominal height (#285), so they travel
  // with the blank rather than being re-derived from the badge template.
  if (design.colourSplit !== null && design.layerHeight !== null) {
    stock.print = {
      split: um(design.colourSplit),
      layerHeight: um(design.layerHeight),
      ...(design.firstLayerHeight !== null && design.firstLayerHeight !== design.layerHeight
        ? { firstLayerHeight: um(design.firstLayerHeight) }
        : {}),
    };
    stock.flatness = stockFlatnessFor(design, stock);
    notes.push(
      `The file states its print: ${mm(design.layerHeight)} mm layers` +
        (design.firstLayerHeight !== null ? ` (first layer ${mm(design.firstLayerHeight)} mm)` : '') +
        `, colour change ${mm(design.colourSplit)} mm above the back face — ` +
        `${mm(design.stock.thickness - design.colourSplit)} mm of the top extruder's material. ` +
        "The job's depth limit follows that boundary, not a nominal height.",
    );
    if (stock.flatness !== undefined) {
      notes.push(
        `The engraved face also carries the printed blank's dome, about ${mm(stock.flatness.dome)} mm across ` +
          `its ${stock.flatness.across} — the badge blank's own bench measurement (#345), copied with its ` +
          "'badge' provenance; nothing here measured it again, and a per-job probe can replace it.",
      );
    } else {
      notes.push(
        'This blank is not the badge blank #345 measured, and the file states no dome of its own, so no ' +
          'dome is claimed: the Z budget assumes a flat face until a per-job probe states one.',
      );
    }
  } else {
    notes.push(
      'The file states no print (no colour split, or no layer height), so the depth limit stays ' +
        'analytic: nothing here claims a colour boundary or a dome.',
    );
  }

  const vectors: EngraveVectorShape[] = design.regions.map((region) => {
    const centre = designPointToJob(design, region.centre[0], region.centre[1], direction);
    return {
      kind: 'vector',
      id: id(),
      name: region.name,
      sourceName: region.sourceName,
      contours: region.contours,
      fillRule: 'EvenOdd',
      // The rings are untouched, so the item's own bounding box is the region's turned a quarter
      // turn: the two sizes SWAP. `width` stays the X extent of what will be cut.
      width: um(region.height),
      height: um(region.width),
      position: { x: centre.x, y: centre.y },
      rotation,
      // The volume's OWN floor, measured from the top face — not a nominal depth (#410).
      depth: um(region.depth),
      enabled: true,
      // Which file this item came from, when the caller read one (#437). A re-import replaces the
      // previous items carrying the same source instead of adding a second set.
      ...(source !== undefined ? { importedFrom: source } : {}),
    };
  });

  let keepOut: EngraveKeepOut | null = null;
  if (design.pocket) {
    const pocket = design.pocket;
    const points = pocket.ring.map(([x, y]): [Mm, Mm] => {
      const p = designPointToJob(design, x, y, direction);
      return [p.x, p.y];
    });
    const centre = designPointToJob(design, pocket.centre[0], pocket.centre[1], direction);
    keepOut = {
      id: DESIGN_POCKET_KEEP_OUT_ID,
      name: 'Magnet pocket',
      kind: 'polygon',
      // The MEASURED ring, not its bounding rectangle: a magnet pocket has rounds in the corners,
      // and a rectangle would tell the job to keep the floor high over material that is not there.
      // Re-centred, and rounded AGAIN: the two `um()` calls in `designPointToJob` are not enough on
      // their own, because a difference of two 3-decimal numbers is not itself a 3-decimal number.
      points: points.map(([x, y]): [Mm, Mm] => [um(x - centre.x), um(y - centre.y)]),
      position: centre,
      rotation: 0,
      enabled: true,
      // `zCeiling` is measured from the blank's BOTTOM face — the same face, and the same quantity,
      // as the file's own bottom-up z (#231). Copied, never converted.
      zCeiling: um(pocket.ceiling),
    };
    const membrane = stock.thickness - pocket.ceiling;
    notes.push(
      `Magnet pocket ${mm(pocket.width)} × ${mm(pocket.length)} mm (X × Y once turned), its ceiling ` +
        `${mm(pocket.ceiling)} mm up from the blank's BOTTOM face: ${mm(membrane)} mm of material is left ` +
        `over it. Its footprint is the file's own ring, ${pocket.ring.length} points` +
        (pocket.holes > 1 ? `, the largest of ${pocket.holes} voids the slice found` : '') +
        '.',
    );
  }

  notes.push(
    `The design's ${vectors.length} item${vectors.length === 1 ? '' : 's'} carry the volumes' own names ` +
      `(${design.regions.map((r) => `"${r.name}"`).join(', ')}) and their own depths, measured from the ` +
      'top face — nothing was placed by hand.',
  );
  notes.push(
    'No cutter was chosen: `designJobFor` settles the blank and the items only. Which bit cuts them, and ' +
      'whether one bit or two, is decided with the reachability numbers in hand (#410).',
  );

  return {
    name: design.name,
    ...(source !== undefined ? { source } : {}),
    stock,
    vectors,
    keepOut,
    // Every field this patch writes is DERIVED from the file — the app read the geometry and did the
    // arithmetic, and nobody typed a number. That is `computed`, the same stamp `takeBadgeBlank`
    // uses for the blank it copies in (#254).
    sources: {
      stock: {
        length: 'computed',
        width: 'computed',
        thickness: 'computed',
        ...(material !== null ? { material: 'computed' as const } : {}),
        // The fibre came out of the same class word the material did (#464), so it carries the
        // same stamp — and only when a flag was actually written, like every other key here.
        ...(stock.fibre !== undefined ? { fibre: 'computed' as const } : {}),
        ...(stock.print ? { print: 'computed' as const } : {}),
        // Only when a dome was actually written (#437): a flatness the patch did not state must not
        // claim provenance, or the job's merge would keep a stale stamp for a value it never got.
        ...(stock.flatness ? { flatness: 'computed' as const } : {}),
      },
    },
    notes,
  };
}

/**
 * Add a design patch's items to a job's list, replacing a previous import of the SAME file (#437).
 *
 * Importing an edited design a second time used to append its volumes to the first import's, so the
 * job cut every item twice — once where the old file had it and once where the new one does. The
 * identity is `patch.source` (the project's Title plus the bytes' SHA-256), stamped onto every item
 * as `importedFrom`:
 *
 *   - a different source, or no source at all: append, exactly as before (`takeDesign` on a job a
 *     person built keeps adding, like any other item route);
 *   - the same source and the same hash: no-op. The bytes are identical, so this is the same import
 *     and the job's existing items — possibly edited by hand since — are left alone;
 *   - the same source, different bytes: the old import's items are REPLACED by the new patch's.
 *
 * Items from before this field existed carry no `importedFrom`; they are matched by the reader's
 * `sourceName` prefix (`<Title> › <volume>`) so a job made by the previous release de-duplicates on
 * its next import too. A replacement that removes an item someone has edited is the point: the item
 * came from the file, and the file has changed.
 */
export function mergeDesignItems(
  current: readonly EngraveVectorShape[],
  patch: Pick<DesignJobPatch, 'name' | 'source' | 'vectors'>,
): EngraveVectorShape[] {
  const source = patch.source;
  if (source === undefined) return [...current, ...patch.vectors];
  const fromThisSource = (item: EngraveVectorShape): boolean =>
    item.importedFrom !== undefined
      ? item.importedFrom.name === source.name
      : item.sourceName.startsWith(`${patch.name} › `);
  const previous = current.filter(fromThisSource);
  const unchanged =
    previous.length > 0 &&
    previous.every((item) => item.importedFrom?.sha256 === source.sha256);
  if (unchanged) return [...current];
  return [...current.filter((item) => !fromThisSource(item)), ...patch.vectors];
}
