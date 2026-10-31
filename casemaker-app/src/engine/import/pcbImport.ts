/**
 * A PCB from its Gerber set (#743 P-4) — the whole job's design, as ordinary items.
 *
 * THE FILES ARE THE DESIGN (principle 16). A board is a Plate of PCB stock whose copper, holes
 * and outline come from the files the operator picks; this module reads the set, tells each file
 * what it is, and lays the board on the blank — it creates items, never a PCB job type.
 *
 * WHICH FILE IS WHICH (design §3.1). The Gerber X2 `%TF.FileFunction%` is read first
 * (`Copper,L1,Top`, `Copper,L2,Bot`, `Profile,NP`); a file that states none is read by its name
 * (`.gtl`/`F_Cu`, `.gbl`/`B_Cu`, `.gko`/`_Edge_Cuts`, `.drl`/`.xln` with an `M48` header). A
 * file whose role cannot be told is LISTED with its role `unknown` and a note — never guessed.
 * Solder mask, silkscreen and paste are listed as not used, one line each.
 *
 * ONE SIDE (Q10, amended 2026-10-30). Top copper is what v1 cuts. A set with ONLY bottom copper
 * is mirrored about the board's X centre — the whole board, copper, holes and outline, because it
 * is milled from the top with the board face down — and the summary says so. A set with BOTH is
 * NOT refused: most hobby boards are two-layer, so the top copper, holes and outline import as
 * normal and a WARNING states that the bottom copper's pieces are not milled. A jumper-wired
 * top-only board is useful, and the person decides whether this one is.
 *
 * PLACEMENT (Q17). The board's outline box is centred on the blank; the file's own origin is not
 * used, because a board's coordinates are wherever the CAD package put them. With no outline file
 * the board is the rectangle around the copper plus 1 mm (Q2), said in the summary.
 *
 * WHAT THE FILES BECOME (§3.3), all existing item kinds: a construction vector for the copper, a
 * construction vector for the outline, an `isolation` frame around the copper, one drill item per
 * hole (through), and a cut-out following the outline with the shop's tabs. Cutter assignment
 * (§3.4) belongs to the caller that owns the tool library; the items it would touch are marked
 * `isolation` and `through` here, and a drill carries the HOLE's own ⌀ so that caller can choose
 * between drilling it and boring it (`pcbCutters.ts`).
 *
 * SLOTS (the maintainer's note, 2026-10-30). A drill file may hold `G85`/`M15` slots. They are
 * READ and reported, and no item is made for them YET — the plan's note names them and their
 * width, so one oval connector hole neither loses the file nor hides the rest of the board.
 */

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { mergeGerberShapes, readGerber, type GerberPoint, type GerberShape } from './gerber';
import { readExcellon, type ExcellonHole, type ExcellonSlot } from './excellon';
import { sha256HexBytes } from './sha256';
import type {
  EngraveCutout,
  EngraveDrill,
  EngraveDrillItem,
  EngraveFrameShape,
  EngraveVectorShape,
} from '@/types/engraveJob';

/** The isolation's width and depth (design Q3/Q4) — two passes of a 0.215 mm cut, 0.1 mm deep. */
export const PCB_ISOLATION_WIDTH_MM = 0.4;
export const PCB_ISOLATION_DEPTH_MM = 0.1;
/** The board's margin around the copper when the set states no outline (Q2), mm. */
export const PCB_FALLBACK_MARGIN_MM = 1;

export type PcbRole = 'top-copper' | 'bottom-copper' | 'outline' | 'drills' | 'unused' | 'unknown';

export interface PcbSourceFile {
  name: string;
  bytes: Uint8Array;
}

export interface PcbFileReport {
  name: string;
  role: PcbRole;
  /** One line for the import summary. */
  summary: string;
  sha256: string;
  kind: 'gerber' | 'excellon';
}

export interface PcbItems {
  vectors: EngraveVectorShape[];
  frames: EngraveFrameShape[];
  drills: EngraveDrill[];
  cutouts: EngraveCutout[];
}

export interface PcbImportOk {
  ok: true;
  files: PcbFileReport[];
  /** The board's box on the blank, mm from the blank's front-left corner. */
  board: { left: number; top: number; width: number; height: number };
  items: PcbItems;
  /** The copper and the outline vector ids, for a caller that wants to name them. */
  copperId: string;
  outlineId: string;
  mirrored: boolean;
  /** Facts worth a finding row: what the board has that this cut does not make. */
  warnings: PcbWarning[];
  notes: string[];
}

export type PcbImportRefusalCode = 'pcb-no-copper' | 'pcb-off-blank' | 'pcb-file-refused';

/** A fact the import states without refusing: the cut is still planned. */
export interface PcbWarning {
  code: 'pcb-bottom-not-cut';
  message: string;
}

export type PcbImportResult = PcbImportOk | { ok: false; code: PcbImportRefusalCode; error: string };

export interface PcbImportOpts {
  /** The blank the board is laid on, mm. */
  blank: { length: number; width: number; thickness: number };
  /** The shop's holding tabs for the cut-out. */
  tabs: { count: number; width: number; height: number };
  /** The caller's id source (the store's `newId`), so this module stays free of the store. */
  idFor: (what: string) => string;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

type Point = GerberPoint;

function boundsOf(contours: readonly Point[][]): { min: Point; max: Point } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of contours) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return minX === Infinity ? null : { min: [minX, minY], max: [maxX, maxY] };
}

/** Shift and centre rings for an item: `position` is the rings' bounding-box centre. */
function place(
  contours: readonly Point[][],
  map: (p: Point) => Point,
): { contours: Point[][]; position: { x: number; y: number }; width: number; height: number } {
  const moved = contours.map((ring) => ring.map(map));
  const b = boundsOf(moved);
  if (b === null) throw new Error('an item has no points');
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  return {
    contours: moved.map((ring) => ring.map(([x, y]): Point => [x - cx, y - cy])),
    position: { x: cx, y: cy },
    width: b.max[0] - b.min[0],
    height: b.max[1] - b.min[1],
  };
}

const ROLE_WORDS: Readonly<Record<PcbRole, string>> = {
  'top-copper': 'top copper',
  'bottom-copper': 'bottom copper',
  outline: 'outline',
  drills: 'drills',
  unused: 'not used',
  unknown: 'role not told',
};

function roleFromFunction(fileFunction: string | null): PcbRole | null {
  if (fileFunction === null) return null;
  const f = fileFunction.toLowerCase();
  if (f.startsWith('copper')) {
    return f.includes('bot') || f.includes('l2') ? 'bottom-copper' : 'top-copper';
  }
  if (f.startsWith('profile')) return 'outline';
  return 'unused';
}

function roleFromName(name: string): PcbRole | null {
  const lower = name.toLowerCase();
  if (/_f_cu|\.gtl$/.test(lower)) return 'top-copper';
  if (/_b_cu|\.gbl$/.test(lower)) return 'bottom-copper';
  if (/_edge_cuts|\.gko$|\.gm1$/.test(lower)) return 'outline';
  if (/\.(drl|xln)$/.test(lower)) return 'drills';
  if (/\.(gts|gbs|gto|gbo|gtp|gbp)$/.test(lower)) return 'unused';
  return null;
}

function looksLikeDrill(text: string, name: string): boolean {
  return /\.(drl|xln)$/i.test(name) || /^\s*M48\b/.test(text);
}

/**
 * Plan the board: read the set, decide the roles, merge the copper, and build the items. The
 * caller owns the job — this returns plain item data and a summary, and never mutates one.
 */
export function planPcbImport(tl: ManifoldToplevel, files: readonly PcbSourceFile[], opts: PcbImportOpts): PcbImportResult {
  const copperFiles: { name: string; shapes: GerberShape[]; role: PcbRole; sha256: string }[] = [];
  const outlineFiles: { name: string; shapes: GerberShape[]; sha256: string }[] = [];
  const holes: ExcellonHole[] = [];
  const slots: ExcellonSlot[] = [];
  const drillsSeen: string[] = [];
  const reports: PcbFileReport[] = [];
  const notes: string[] = [];

  for (const file of files) {
    const text = decoder.decode(file.bytes);
    const sha256 = sha256HexBytes(file.bytes);
    if (looksLikeDrill(text, file.name)) {
      const read = readExcellon(text);
      if (!read.ok) {
        return { ok: false, code: 'pcb-file-refused', error: `${file.name}: ${read.error}` };
      }
      holes.push(...read.holes);
      slots.push(...read.slots);
      drillsSeen.push(file.name);
      notes.push(...read.notes.map((n) => `${file.name}: ${n}`));
      reports.push({
        name: file.name,
        role: 'drills',
        summary: `${file.name} · drills · ${read.holes.length} hole${read.holes.length === 1 ? '' : 's'}${read.slots.length > 0 ? `, ${read.slots.length} slot${read.slots.length === 1 ? '' : 's'}` : ''}`,
        sha256,
        kind: 'excellon',
      });
      continue;
    }
    const read = readGerber(text);
    if (!read.ok) {
      const named = roleFromName(file.name);
      if (named !== null && named !== 'unused') {
        return { ok: false, code: 'pcb-file-refused', error: `${file.name}: ${read.error}` };
      }
      reports.push({ name: file.name, role: 'unknown', summary: `${file.name} · ${ROLE_WORDS.unknown} · not read`, sha256, kind: 'gerber' });
      notes.push(`${file.name} is not a Gerber file this import reads (${read.error}); its role is not guessed.`);
      continue;
    }
    const role = roleFromFunction(read.fileFunction) ?? roleFromName(file.name) ?? 'unknown';
    const shapes = read.shapes.length;
    if (role === 'top-copper' || role === 'bottom-copper') {
      copperFiles.push({ name: file.name, shapes: read.shapes, role, sha256 });
    } else if (role === 'outline') {
      outlineFiles.push({ name: file.name, shapes: read.shapes, sha256 });
    }
    reports.push({
      name: file.name,
      role,
      summary: `${file.name} · ${ROLE_WORDS[role]} · ${shapes} shape${shapes === 1 ? '' : 's'}`,
      sha256,
      kind: 'gerber',
    });
    if (role === 'unknown') notes.push(`${file.name} states no file function and its name tells none; its role is not guessed.`);
    notes.push(...read.notes.map((n) => `${file.name}: ${n}`));
  }

  const tops = copperFiles.filter((f) => f.role === 'top-copper');
  const bottoms = copperFiles.filter((f) => f.role === 'bottom-copper');
  if (tops.length === 0 && bottoms.length === 0) {
    return { ok: false, code: 'pcb-no-copper', error: 'No copper file among these: pick the top copper (.gtl, F_Cu).' };
  }
  // A TWO-LAYER BOARD IS NOT REFUSED (the maintainer's note, 2026-10-30): the common case must
  // still give the person a top-only board, and a warning names what the cut does not make.
  const warnings: PcbWarning[] = [];
  if (tops.length > 0 && bottoms.length > 0) {
    const bottomCopper = mergeGerberShapes(tl, (bottoms[0] as { shapes: GerberShape[] }).shapes);
    warnings.push({
      code: 'pcb-bottom-not-cut',
      message: `This board has copper on both sides; Case Maker cuts the top side only for now — the bottom copper's ${bottomCopper.pieces} piece${bottomCopper.pieces === 1 ? '' : 's'} of copper ${bottomCopper.pieces === 1 ? 'is' : 'are'} not milled.`,
    });
  }
  if (tops.length > 1 || bottoms.length > 1) {
    return { ok: false, code: 'pcb-file-refused', error: 'More than one top copper file was picked; pick the board\'s one copper layer.' };
  }
  const copperFile = (tops[0] ?? bottoms[0]) as { name: string; shapes: GerberShape[]; role: PcbRole; sha256: string };
  // Only a BOTTOM-ONLY set is mirrored; a two-layer set is cut from the top as drawn.
  const mirrored = tops.length === 0 && bottoms.length > 0;
  if (mirrored) notes.push('the set has only bottom copper, so the board is mirrored about its X centre and cut from the top.');
  if (drillsSeen.length > 1) notes.push(`${drillsSeen.length} drill files were read; their holes are merged.`);

  let copper = mergeGerberShapes(tl, copperFile.shapes);
  const outlineRead = outlineFiles[0] === undefined ? null : mergeGerberShapes(tl, outlineFiles[0].shapes);

  // The mirror is about the BOARD's own X centre: the outline's when the set states one, else the
  // copper's. Everything is mirrored — copper, outline and holes — because the board is cut from
  // the top with its face down.
  const reference = boundsOf(outlineRead?.contours ?? copper.contours);
  if (reference === null) {
    return { ok: false, code: 'pcb-file-refused', error: `${copperFile.name}: the copper has no extent` };
  }
  const mirrorCx = (reference.min[0] + reference.max[0]) / 2;
  const flip = (rings: Point[][]): Point[][] =>
    rings.map((ring) => ring.map(([x, y]): Point => [2 * mirrorCx - x, y]).reverse());

  if (mirrored) {
    copper = { ...copper, contours: flip(copper.contours) };
  }
  const outlineContours = outlineRead === null ? null : mirrored ? flip(outlineRead.contours) : outlineRead.contours;

  // The board's box: the outline's, or the copper's plus the fallback margin (Q2).
  let boardContours: Point[][];
  let stated = true;
  if (outlineContours !== null) {
    boardContours = outlineContours;
  } else {
    const b = boundsOf(copper.contours);
    if (b === null) return { ok: false, code: 'pcb-file-refused', error: `${copperFile.name}: the copper has no extent` };
    const m = PCB_FALLBACK_MARGIN_MM;
    const min: Point = [b.min[0] - m, b.min[1] - m];
    const max: Point = [b.max[0] + m, b.max[1] + m];
    boardContours = [[min, [max[0], min[1]], max, [min[0], max[1]]]];
    stated = false;
    notes.push('the set states no outline file, so the board is the rectangle around the copper plus 1 mm.');
  }
  const boardBounds = boundsOf(boardContours);
  if (boardBounds === null) return { ok: false, code: 'pcb-file-refused', error: 'the board outline has no extent' };
  const boardWidth = boardBounds.max[0] - boardBounds.min[0];
  const boardHeight = boardBounds.max[1] - boardBounds.min[1];
  if (boardWidth > opts.blank.length + 1e-9 || boardHeight > opts.blank.width + 1e-9) {
    return {
      ok: false,
      code: 'pcb-off-blank',
      error: `The board is ${round(boardWidth)} × ${round(boardHeight)} mm; the blank is ${round(opts.blank.length)} × ${round(opts.blank.width)} mm. Use a larger blank.`,
    };
  }

  // Centred on the blank (Q17); the file's own origin is not used.
  const left = (opts.blank.length - boardWidth) / 2;
  const top = (opts.blank.width - boardHeight) / 2;
  const toJob = (p: Point): Point => [p[0] - boardBounds.min[0] + left, p[1] - boardBounds.min[1] + top];
  // A hole is in the FILE's frame, so a bottom-only set mirrors it too, exactly as it mirrors the
  // copper and the outline.
  const holePoint = (p: Point): Point => toJob(mirrored ? [2 * mirrorCx - p[0], p[1]] : p);

  const copperPlaced = place(copper.contours, toJob);
  const copperId = opts.idFor('pcb-copper');
  const copperItem: EngraveVectorShape = {
    kind: 'vector',
    id: copperId,
    name: mirrored ? 'Copper — bottom, mirrored' : 'Copper — top',
    sourceName: copperFile.name,
    contours: copperPlaced.contours,
    fillRule: 'NonZero',
    width: copperPlaced.width,
    height: copperPlaced.height,
    position: copperPlaced.position,
    rotation: 0,
    depth: PCB_ISOLATION_DEPTH_MM,
    enabled: true,
    construction: true,
    importedFrom: { name: copperFile.name, sha256: copperFile.sha256 },
  };
  const outlinePlaced = place(boardContours, toJob);
  const outlineId = opts.idFor('pcb-outline');
  const outlineItem: EngraveVectorShape = {
    kind: 'vector',
    id: outlineId,
    name: 'Board outline',
    sourceName: outlineFiles[0]?.name ?? 'around the copper',
    contours: outlinePlaced.contours,
    fillRule: 'NonZero',
    width: outlinePlaced.width,
    height: outlinePlaced.height,
    position: outlinePlaced.position,
    rotation: 0,
    // The schema requires a positive depth on every vector. This item is never cut
    // (`construction`), so the number is inert; the board's thickness is the honest one — the
    // outline is the through profile the cut-out follows.
    depth: opts.blank.thickness,
    enabled: true,
    construction: true,
    ...(outlineFiles[0] === undefined ? {} : { importedFrom: { name: outlineFiles[0].name, sha256: outlineFiles[0].sha256 } }),
  };
  const frame: EngraveFrameShape = {
    kind: 'frame',
    id: opts.idFor('pcb-isolation'),
    name: 'Isolate the copper',
    around: copperId,
    gap: 0,
    width: PCB_ISOLATION_WIDTH_MM,
    depth: PCB_ISOLATION_DEPTH_MM,
    isolation: true,
    position: { x: 0, y: 0 },
    rotation: 0,
    enabled: true,
  };
  const drillItems: EngraveDrill[] = holes.map((hole): EngraveDrillItem => {
    const [x, y] = holePoint([hole.x, hole.y]);
    return {
      kind: 'drill',
      id: opts.idFor('pcb-hole'),
      name: `⌀${round(hole.diameter)} hole`,
      position: { x, y },
      rotation: 0,
      depth: opts.blank.thickness,
      enabled: true,
      through: true,
      mode: 'drill',
      // The hole's own size: unread by a plunge, but the number a BORE is helixed to (§3.4).
      diameter: hole.diameter,
    };
  });
  const cutout: EngraveCutout = {
    kind: 'cutout',
    id: opts.idFor('pcb-cutout'),
    name: 'Cut out the board',
    enabled: true,
    of: outlineId,
    side: 'outside',
    inset: 0,
    tabs: { ...opts.tabs },
  };
  if (slots.length > 0) {
    const widths = [...new Set(slots.map((s) => `${round(s.width)} mm`))].join(', ');
    const where = slots
      .slice(0, 5)
      .map((s) => `(${round(s.from.x)}, ${round(s.from.y)})–(${round(s.to.x)}, ${round(s.to.y)})`)
      .join('; ');
    notes.push(
      `${slots.length} slot${slots.length === 1 ? '' : 's'} (${widths} wide) ${slots.length === 1 ? 'was' : 'were'} read but no item was made for ${slots.length === 1 ? 'it' : 'them'} yet: ${where}${slots.length > 5 ? '; …' : ''}. The rest of the board imported.`,
    );
  }
  if (!stated) notes.push('the board box is not a stated outline; the cut-out follows the rectangle.');

  return {
    ok: true,
    files: reports,
    board: { left, top, width: boardWidth, height: boardHeight },
    items: { vectors: [copperItem, outlineItem], frames: [frame], drills: drillItems, cutouts: [cutout] },
    copperId,
    outlineId,
    mirrored,
    warnings,
    notes,
  };
}

function round(v: number): number {
  return Number(v.toFixed(3));
}
