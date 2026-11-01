import type { BoardProfile, CaseDivider, CaseParameters, FitVariant, Project } from '@/types';
import { fitRelief } from '@/types/snap';
import { cavityOriginXY } from '@/engine/coords';
import { computeShellDims } from './caseShell';
import { computeBossPlacements } from './bosses';
import { HOLE_GRID_PITCH, HOLE_GRID_SOCKET, holeGridCentres } from './holeGrid';
import { PEG_TENON_BOTTOM_GAP, PEG_TENON_FIT, PEG_WIDTH_EAR, buildDividerPegOp, pegWidth } from './dividerPegs';
import { cube, rotate, translate, union, type BuildNode, type BuildOp } from './buildPlan';
import { rectProfile, pTranslate } from './profile';
import { getBuiltinHat } from '@/library/hats';
import { getBuiltinDisplay } from '@/library/displays';

/**
 * Issue #150 — the case-floor host for the divider system: a blind socket grid
 * in the floor of a board case, and drop-in dividers that plug into it, each
 * printed as its own part.
 *
 * The primitives are `holeGrid.ts` (the lattice) and `dividerPegs.ts` (the
 * wall-with-tenons); the toolbox (#155) is their other host. What this module
 * adds is what a BOARD case needs and a toolbox does not:
 *
 *   - keep-outs. The board, its overhanging components, a mounted display and
 *     every floor standoff/boss are taken out of the lattice, so a socket never
 *     opens under something it cannot be used beside. Whole sockets only: a
 *     socket that would touch a keep-out is dropped rather than clipped into a
 *     sliver no tenon fits.
 *   - the floor. A case floor defaults to 2 mm, so a socket can only go as deep
 *     as leaves `GRID_FLOOR_UNDER` of floor beneath it. The panel offers to
 *     thicken the floor rather than refusing the grid.
 *   - the fit. The case's print-fit ladder (#153, `types/snap.ts`
 *     `FIT_RELIEF_MM`: tight 0, standard 0.1, loose 0.25 mm) is added to the
 *     SOCKET — the cut — never to the tenon, per the ladder's own rule. The
 *     tenon is `socket − PEG_TENON_FIT` (0.3 mm, PROVISIONAL, `dividerPegs.ts`).
 *     So the side clearance is 0.30 / 0.40 / 0.55 mm.
 *
 * Pure geometry: no Manifold. The panel and the compiler both read
 * `caseDividerFacts`, so a divider the panel reports is exactly the one built.
 */

/** Socket edge to cavity wall, mm. Chosen so a divider ending in the outermost
 *  socket still clears the wall: the ear runs `PEG_WIDTH_EAR − socket/2` = 2.3 mm
 *  past the socket edge, leaving 0.7 mm to the wall. */
export const GRID_WALL_MARGIN = 3.0;
/** Socket edge to the board, a standoff or a boss, mm. */
export const GRID_KEEPOUT_GAP = 1.0;
/** Floor left under a socket, mm — the triage's `floorThickness ≥ depth + 1.2`. */
export const GRID_FLOOR_UNDER = 1.2;
/** Shallowest socket worth cutting, mm: below this the tenon (which stops
 *  `PEG_TENON_BOTTOM_GAP` short of the floor) has under 0.6 mm of grip. */
export const GRID_MIN_DEPTH = 1.0;
/** Gap between a divider's top and the lid's underside, mm. */
export const DIVIDER_TOP_CLEARANCE = 1.0;
/** A new divider's wall thickness, mm (the toolbox's divider wall). */
export const DIVIDER_THICKNESS = 2.4;
/** Gap a divider keeps from the board or a boss before it counts as a clash, mm. */
export const DIVIDER_CLASH_GAP = 0.5;

export const DEFAULT_FLOOR_GRID = {
  enabled: true,
  pitch: HOLE_GRID_PITCH,
  socket: HOLE_GRID_SOCKET,
  depth: 2,
} as const;

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Circle = { x: number; y: number; r: number };
export type WidenSide = 'xMin' | 'xMax' | 'yMin' | 'yMax';

export interface GridSocket {
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface DividerFact {
  id: string;
  /** "Divider 1" — the panel's name and the part's. */
  label: string;
  /** True when the part builds (the clashes below do not stop it). */
  builds: boolean;
  /** Wall length end to end, mm. */
  length: number;
  /** Wall height above the floor, mm. */
  height: number;
  /** Footprint in world XY, mm. */
  rect: Rect;
  /** Each clash, stated — empty when it seats cleanly. */
  clashes: string[];
  /** The nearest grid line that clears every clash, or null. */
  moveTo: number | null;
}

export interface CaseDividerFacts {
  /** False when the grid is absent or off — nothing else is meaningful then. */
  enabled: boolean;
  pitch: number;
  /** Nominal socket side, mm. */
  socket: number;
  /** Socket as cut: nominal plus the fit relief, mm. */
  socketCut: number;
  /** Tenon side, mm. */
  tenon: number;
  /** The whole gap across the socket (cut minus tenon), mm. */
  clearance: number;
  fit: FitVariant;
  /** Whether the fit came from the grid's own override or the case's setting. */
  fitSource: 'grid' | 'case';
  /** Depth asked for, and the depth actually cut, mm. */
  depthWanted: number;
  depth: number;
  /** The floor that would cut the full asked depth, mm. */
  floorNeeded: number;
  /** World X of every lattice column / Y of every lattice row. */
  columns: number[];
  rows: number[];
  /** Live sockets — the ones cut. */
  sockets: GridSocket[];
  /** Lattice points dropped for the board, standoffs, bosses or the wall corners. */
  blocked: number;
  /** Divider wall height, mm: the cavity's inside height less `DIVIDER_TOP_CLEARANCE`. */
  dividerHeight: number;
  /** Cavity inside height, floor top to the top of the cavity, mm. */
  cavityHeight: number;
  /** Floor top, world Z. */
  floorZ: number;
  dividers: DividerFact[];
  /** Grid-level facts for the panel, stated. */
  notes: string[];
  /** When no socket fits: the side to widen the cavity on, and by how much. */
  widen: { side: WidenSide; by: number } | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mm = (n: number) => `${round1(n)} mm`;

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function rectHitsCircle(r: Rect, c: Circle): boolean {
  const dx = c.x - Math.max(r.x0, Math.min(c.x, r.x1));
  const dy = c.y - Math.max(r.y0, Math.min(c.y, r.y1));
  return dx * dx + dy * dy < c.r * c.r;
}

function grow(r: Rect, g: number): Rect {
  return { x0: r.x0 - g, y0: r.y0 - g, x1: r.x1 + g, y1: r.y1 + g };
}

/** Is the point inside a rounded rectangle (corner radius `rad`)? */
function inRoundedRect(x: number, y: number, r: Rect, rad: number): boolean {
  if (x < r.x0 - 1e-9 || x > r.x1 + 1e-9 || y < r.y0 - 1e-9 || y > r.y1 + 1e-9) return false;
  if (rad <= 0) return true;
  const cx = Math.max(r.x0 + rad, Math.min(x, r.x1 - rad));
  const cy = Math.max(r.y0 + rad, Math.min(y, r.y1 - rad));
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad + 1e-9;
}

function rectInRoundedRect(inner: Rect, outer: Rect, rad: number): boolean {
  return (
    inRoundedRect(inner.x0, inner.y0, outer, rad) &&
    inRoundedRect(inner.x1, inner.y0, outer, rad) &&
    inRoundedRect(inner.x0, inner.y1, outer, rad) &&
    inRoundedRect(inner.x1, inner.y1, outer, rad)
  );
}

/** The board's footprint on the floor, world XY: the PCB plus anything that
 *  overhangs it, plus a mounted display. */
export function boardFootprint(
  board: BoardProfile,
  params: CaseParameters,
  display: Project['display'] = null,
  resolveDisplay: (id: string) => import('@/types/display').DisplayProfile | undefined = () => undefined,
): Rect {
  const o = cavityOriginXY(params);
  let x0 = 0;
  let y0 = 0;
  let x1 = board.pcb.size.x;
  let y1 = board.pcb.size.y;
  for (const c of board.components) {
    x0 = Math.min(x0, c.position.x);
    y0 = Math.min(y0, c.position.y);
    x1 = Math.max(x1, c.position.x + c.size.x);
    y1 = Math.max(y1, c.position.y + c.size.y);
  }
  if (display?.enabled) {
    const p = resolveDisplay(display.displayId);
    if (p) {
      x0 = Math.min(x0, display.offset.x);
      y0 = Math.min(y0, display.offset.y);
      x1 = Math.max(x1, display.offset.x + p.pcb.size.x);
      y1 = Math.max(y1, display.offset.y + p.pcb.size.y);
    }
  }
  return { x0: o.x + x0, y0: o.y + y0, x1: o.x + x1, y1: o.y + y1 };
}

function resolvers(project: Project) {
  const hatsById = new Map((project.customHats ?? []).map((h) => [h.id, h] as const));
  const displaysById = new Map((project.customDisplays ?? []).map((d) => [d.id, d] as const));
  return {
    resolveHat: (id: string) => hatsById.get(id) ?? getBuiltinHat(id),
    resolveDisplay: (id: string) => displaysById.get(id) ?? getBuiltinDisplay(id),
  };
}

const WIDEN_FACING: Record<WidenSide, import('@/types').Facing> = { xMin: '-x', xMax: '+x', yMin: '-y', yMax: '+y' };
export const WIDEN_SIDE_NAME: Record<WidenSide, string> = {
  xMin: 'left (−X)',
  xMax: 'right (+X)',
  yMin: 'front (−Y)',
  yMax: 'back (+Y)',
};

/**
 * Everything the panel says and the compiler builds, from the project alone.
 * Returns `enabled: false` (and nothing else of use) when the grid is off.
 */
export function caseDividerFacts(project: Project, opts: { trial?: boolean } = {}): CaseDividerFacts {
  const { board, case: params } = project;
  const g = params.floorGrid;
  const fit: FitVariant = g?.fit ?? params.fit ?? 'tight';
  const fitSource = g?.fit ? 'grid' : 'case';
  const pitch = g?.pitch ?? HOLE_GRID_PITCH;
  const socket = g?.socket ?? HOLE_GRID_SOCKET;
  const relief = fitRelief(fit);
  const socketCut = socket + relief;
  const tenon = socket - PEG_TENON_FIT;
  const depthWanted = g?.depth ?? DEFAULT_FLOOR_GRID.depth;
  const depth = Math.max(0, Math.min(depthWanted, params.floorThickness - GRID_FLOOR_UNDER));
  const { resolveHat, resolveDisplay } = resolvers(project);
  const dims = computeShellDims(board, params, project.hats ?? [], resolveHat, project.display, resolveDisplay);
  const wall = params.wallThickness;
  const cavity: Rect = { x0: wall, y0: wall, x1: wall + dims.cavityX, y1: wall + dims.cavityY };
  const innerR = Math.max(0, params.cornerRadius - wall);
  const facts: CaseDividerFacts = {
    enabled: g?.enabled === true,
    pitch,
    socket,
    socketCut,
    tenon,
    clearance: socketCut - tenon,
    fit,
    fitSource,
    depthWanted,
    depth,
    floorNeeded: depthWanted + GRID_FLOOR_UNDER,
    columns: [],
    rows: [],
    sockets: [],
    blocked: 0,
    dividerHeight: dims.cavityZ - DIVIDER_TOP_CLEARANCE,
    cavityHeight: dims.cavityZ,
    floorZ: params.floorThickness,
    dividers: [],
    notes: [],
    widen: null,
  };
  if (!facts.enabled) return facts;

  if (!(pitch > 0) || !(socket > 0) || pitch < socket + 1) {
    facts.notes.push(
      `A ${mm(pitch)} pitch cannot hold ${mm(socket)} sockets with a wall between them — the pitch needs to be at least ${mm(socket + 1)}.`,
    );
    return facts;
  }

  // The lattice, anchored at the cavity's -X/-Y corner (holeGrid's 'bbox').
  const outline = pTranslate([cavity.x0, cavity.y0], rectProfile(dims.cavityX, dims.cavityY));
  const centres = holeGridCentres(outline, { pitch, socket, margin: GRID_WALL_MARGIN });
  const x0 = cavity.x0 + GRID_WALL_MARGIN + socket / 2;
  const y0 = cavity.y0 + GRID_WALL_MARGIN + socket / 2;
  const nCols = new Set(centres.map((c) => c[0])).size;
  const nRows = new Set(centres.map((c) => c[1])).size;
  facts.columns = Array.from({ length: nCols }, (_, i) => x0 + i * pitch);
  facts.rows = Array.from({ length: nRows }, (_, j) => y0 + j * pitch);

  // Keep-outs: the board footprint, and every floor standoff / boss.
  const footprint = boardFootprint(board, params, project.display, resolveDisplay);
  const bosses: Circle[] = computeBossPlacements(board, params)
    .filter((b) => b.position === 'bottom')
    .map((b) => ({ x: b.x, y: b.y, r: b.outerDiameter / 2 }));
  const field: Rect = grow(cavity, -GRID_WALL_MARGIN);
  const fieldR = Math.max(0, innerR - GRID_WALL_MARGIN);
  const half = socketCut / 2;
  for (let row = 0; row < nRows; row++) {
    for (let col = 0; col < nCols; col++) {
      const x = facts.columns[col]!;
      const y = facts.rows[row]!;
      const sq: Rect = { x0: x - half, y0: y - half, x1: x + half, y1: y + half };
      // The wall margin is measured to the NOMINAL socket edge — the same
      // edge the lattice is laid out from — so the fit relief never costs the
      // outermost row. The relief is a few hundredths eating into a 3 mm margin.
      const h0 = socket / 2;
      const nominal: Rect = { x0: x - h0, y0: y - h0, x1: x + h0, y1: y + h0 };
      const clear =
        rectInRoundedRect(nominal, field, fieldR) &&
        !rectsOverlap(grow(sq, GRID_KEEPOUT_GAP), footprint) &&
        !bosses.some((b) => rectHitsCircle(grow(sq, GRID_KEEPOUT_GAP), b));
      if (clear) facts.sockets.push({ col, row, x, y });
      else facts.blocked++;
    }
  }

  if (depth < GRID_MIN_DEPTH) {
    facts.notes.push(
      `The floor is ${mm(params.floorThickness)}, which leaves room for only ${mm(depth)} of socket over the ${mm(GRID_FLOOR_UNDER)} kept under it — no sockets are cut. A ${mm(facts.floorNeeded)} floor takes the full ${mm(depthWanted)}.`,
    );
  } else if (depth < depthWanted) {
    facts.notes.push(
      `The sockets are cut ${mm(depth)} deep, not ${mm(depthWanted)}: the ${mm(params.floorThickness)} floor keeps ${mm(GRID_FLOOR_UNDER)} under them. A ${mm(facts.floorNeeded)} floor takes the full depth.`,
    );
  }

  const liveRows = new Set(facts.sockets.map((k) => k.row)).size;
  const liveCols = new Set(facts.sockets.map((k) => k.col)).size;
  if (liveRows < 2 || liveCols < 2) {
    // Offer a side with no port on it: widening a ported side would pull the
    // wall away from its connector. The amount is the least, in half-pitch
    // steps, that gives a bay at least two sockets each way, so a divider can
    // run either way in it.
    const ported = new Set((project.ports ?? []).filter((p) => p.enabled).map((p) => p.facing));
    const side = (['yMax', 'xMax', 'yMin', 'xMin'] as WidenSide[]).find((s) => !ported.has(WIDEN_FACING[s]));
    if (side && !opts.trial) {
      const t = params.clearanceTweaks ?? { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
      for (let by = pitch / 2; by <= 8 * pitch; by += pitch / 2) {
        const trial = caseDividerFacts(
          { ...project, case: { ...params, dividers: [], clearanceTweaks: { ...t, [side]: (t[side] ?? 0) + by } } },
          { trial: true },
        );
        if (new Set(trial.sockets.map((k) => k.row)).size >= 2 && new Set(trial.sockets.map((k) => k.col)).size >= 2) {
          facts.widen = { side, by };
          break;
        }
      }
    }
    const offer = facts.widen
      ? ` Widening the ${WIDEN_SIDE_NAME[facts.widen.side]} side by ${mm(facts.widen.by)} makes a bay at least two sockets each way.`
      : '';
    facts.notes.push(
      facts.sockets.length === 0
        ? `No socket fits: the cavity is sized to the board, and the ${mm(params.internalClearance)} clearance around it is narrower than a socket plus its ${mm(GRID_WALL_MARGIN)} wall margin.${offer}`
        : `The sockets beside the board make a single ${liveRows < 2 ? 'row' : 'column'}, so a divider can only run ${liveRows < 2 ? 'along X' : 'along Y'}.${offer}`,
    );
  }

  // Dividers.
  const live = new Set(facts.sockets.map((s) => `${s.col},${s.row}`));
  const height = facts.dividerHeight;
  const place = (d: CaseDivider, line: number) => {
    const along = d.axis === 'x' ? facts.columns : facts.rows;
    const across = d.axis === 'x' ? facts.rows : facts.columns;
    const first = d.start;
    const last = d.start + d.holes - 1;
    const problems: string[] = [];
    const lineName = d.axis === 'x' ? 'row' : 'column';
    if (line < 0 || line >= across.length || first < 0 || last >= along.length) {
      problems.push(
        `it runs off the grid — the floor has ${along.length} ${d.axis === 'x' ? 'columns' : 'rows'} and ${across.length} ${lineName}s`,
      );
      return { rect: null as Rect | null, problems };
    }
    const t = d.thickness ?? DIVIDER_THICKNESS;
    const a0 = along[first]! - PEG_WIDTH_EAR;
    const a1 = along[last]! + PEG_WIDTH_EAR;
    const c = across[line]!;
    const rect: Rect =
      d.axis === 'x' ? { x0: a0, x1: a1, y0: c - t / 2, y1: c + t / 2 } : { x0: c - t / 2, x1: c + t / 2, y0: a0, y1: a1 };
    if (rectsOverlap(grow(rect, DIVIDER_CLASH_GAP), footprint)) {
      const lo = d.axis === 'x' ? Math.max(rect.x0, footprint.x0) : Math.max(rect.y0, footprint.y0);
      const hi = d.axis === 'x' ? Math.min(rect.x1, footprint.x1) : Math.min(rect.y1, footprint.y1);
      const ax = d.axis === 'x' ? 'X' : 'Y';
      problems.push(
        hi > lo
          ? `it runs into the board from ${ax} ${mm(lo)} to ${mm(hi)}`
          : `it stands within ${mm(DIVIDER_CLASH_GAP)} of the board`,
      );
    } else if (bosses.some((b) => rectHitsCircle(grow(rect, DIVIDER_CLASH_GAP), b))) {
      problems.push('it runs into a board standoff');
    }
    if (!rectInRoundedRect(rect, cavity, innerR)) problems.push('its end runs into the case wall');
    for (const idx of [first, last]) {
      const key = d.axis === 'x' ? `${idx},${line}` : `${line},${idx}`;
      if (!live.has(key)) {
        problems.push(
          `its tenon at ${d.axis === 'x' ? `column ${idx + 1}` : `row ${idx + 1}`} has no socket under it`,
        );
      }
    }
    return { rect, problems };
  };

  (params.dividers ?? []).forEach((d, i) => {
    const label = `Divider ${i + 1}`;
    if (!d.enabled) return;
    const length = pegWidth(d.holes, pitch);
    const valid = Number.isInteger(d.holes) && d.holes >= 2 && Number.isInteger(d.line) && Number.isInteger(d.start);
    if (!valid) {
      facts.dividers.push({
        id: d.id,
        label,
        builds: false,
        length,
        height,
        rect: { x0: 0, y0: 0, x1: 0, y1: 0 },
        clashes: [`${label} needs a whole number of sockets, at least 2, on a whole grid line — it is not built.`],
        moveTo: null,
      });
      return;
    }
    const here = place(d, d.line);
    let moveTo: number | null = null;
    if (here.problems.length > 0) {
      const lines = (d.axis === 'x' ? facts.rows : facts.columns).length;
      for (let k = 1; k < lines && moveTo === null; k++) {
        for (const cand of [d.line - k, d.line + k]) {
          if (cand >= 0 && cand < lines && place(d, cand).problems.length === 0) {
            moveTo = cand;
            break;
          }
        }
      }
    }
    facts.dividers.push({
      id: d.id,
      label,
      builds: height > 0 && depth >= GRID_MIN_DEPTH && facts.sockets.length > 0,
      length,
      height,
      rect: here.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
      clashes: here.problems.map((p) => `${label}: ${p}.`),
      moveTo,
    });
  });

  // Two dividers that cross cannot both seat.
  const placed = facts.dividers.filter((d) => d.builds && d.rect.x1 > d.rect.x0);
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++)
      if (rectsOverlap(placed[i]!.rect, placed[j]!.rect))
        placed[j]!.clashes.push(`${placed[j]!.label}: it crosses ${placed[i]!.label} — only one can seat there.`);

  return facts;
}

/** The node id a case divider exports under. The axis is in the id because the
 *  print table lays an X wall and a Y wall down with different turns. */
export function caseDividerNodeId(d: Pick<CaseDivider, 'id' | 'axis'>): string {
  return `case-divider-${d.axis}-${d.id}`;
}

export interface CaseDividerOps {
  /** Blind socket cutters for the shell — empty when there is no grid. */
  floorCut: BuildOp[];
  /** One free node per built divider, in assembly position. */
  nodes: BuildNode[];
}

/**
 * The shell's socket cut and the divider parts. Both empty for a project with
 * no enabled grid, so its plan is unchanged.
 */
export function buildCaseDividerOps(project: Project): CaseDividerOps {
  const g = project.case.floorGrid;
  if (!g?.enabled) return { floorCut: [], nodes: [] };
  const f = caseDividerFacts(project);
  if (f.sockets.length === 0 || f.depth < GRID_MIN_DEPTH) return { floorCut: [], nodes: [] };
  // Cut from the floor's top face down `depth`, with 0.01 mm overshoot up so
  // the cut face is not coplanar with the floor top.
  const s = f.socketCut;
  const cutters = f.sockets.map((k) => translate([k.x - s / 2, k.y - s / 2, f.floorZ - f.depth], cube([s, s, f.depth + 0.01])));
  const floorCut: BuildOp[] = [cutters.length === 1 ? cutters[0]! : union(cutters)];

  const nodes: BuildNode[] = [];
  const byId = new Map(f.dividers.map((d) => [d.id, d] as const));
  for (const d of project.case.dividers ?? []) {
    const fact = byId.get(d.id);
    if (!d.enabled || !fact?.builds) continue;
    const op = buildDividerPegOp(
      { id: d.id, spans: d.holes, height: fact.height, thickness: d.thickness ?? DIVIDER_THICKNESS, enabled: true },
      { grid: { pitch: f.pitch, socket: f.socket }, socketDepth: f.depth, tenonFit: PEG_TENON_FIT, bottomGap: PEG_TENON_BOTTOM_GAP },
    );
    if (!op) continue;
    const r = fact.rect;
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    nodes.push({
      id: caseDividerNodeId(d),
      op: translate([cx, cy, f.floorZ], d.axis === 'y' ? rotate([0, 0, 90], op) : op),
    });
  }
  return { floorCut, nodes };
}

/**
 * Where a new divider along `axis` should go: the longest run of consecutive
 * live sockets on one grid line that seats cleanly and crosses no existing
 * divider. Falls back to the first line when nothing seats, and the panel then
 * states the clash like any other.
 */
export function suggestCaseDivider(
  project: Project,
  axis: 'x' | 'y',
): Pick<CaseDivider, 'axis' | 'line' | 'start' | 'holes'> {
  const base = caseDividerFacts(project, { trial: true });
  const lines = axis === 'x' ? base.rows.length : base.columns.length;
  const live = new Set(base.sockets.map((k) => (axis === 'x' ? `${k.col},${k.row}` : `${k.row},${k.col}`)));
  const alongCount = axis === 'x' ? base.columns.length : base.rows.length;
  let best: Pick<CaseDivider, 'axis' | 'line' | 'start' | 'holes'> | null = null;
  for (let line = 0; line < lines; line++) {
    let i = 0;
    while (i < alongCount) {
      if (!live.has(`${i},${line}`)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < alongCount && live.has(`${j + 1},${line}`)) j++;
      // Every sub-run of the live run, longest first: the full run may cross
      // a divider already standing at one end of it.
      for (let holes = j - i + 1; holes >= 2 && (!best || holes > best.holes); holes--) {
        for (let start = i; start + holes - 1 <= j; start++) {
          const cand = { axis, line, start, holes };
          const probe = caseDividerFacts(
            {
              ...project,
              case: { ...project.case, dividers: [...(project.case.dividers ?? []), { id: '__probe', enabled: true, ...cand }] },
            },
            { trial: true },
          );
          const fact = probe.dividers.find((d) => d.id === '__probe');
          if (fact && fact.clashes.length === 0) {
            best = cand;
            break;
          }
        }
      }
      i = j + 1;
    }
  }
  return best ?? { axis, line: 0, start: 0, holes: 2 };
}
