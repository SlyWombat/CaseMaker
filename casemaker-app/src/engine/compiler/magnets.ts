/**
 * Issue #152 — the case's magnet pockets and the swappable nameplate.
 *
 * Two consumers of `fasteners.ts`'s `magnetPocket`:
 *
 *  1. `case.magnetPockets` — a row of blind pockets at (u, v) on a case face.
 *  2. `case.nameplate` — a separate printed plate carrying text, with pockets
 *     on its back, and pockets on the case face at the SAME world centres, so a
 *     magnet in each pulls the plate home.
 *
 * Everything is resolved first into plain numbers (`resolveMagnets`), so the
 * panel can state facts — the pause height of a captured pocket, the boss a
 * thin wall needs — from the same arithmetic the geometry is cut with.
 *
 * Coordinates: shell ops are WORLD; lid ops are LID-LOCAL (ProjectCompiler
 * lifts the lid by `lidDims.zPosition` afterwards), the `textLabels.ts`
 * convention. The nameplate node is WORLD, sitting on the face in the
 * assembled frame; the print table lays it flat for export.
 */
import type {
  BoardProfile,
  CaseFace,
  CaseParameters,
  Facing,
  HatPlacement,
  HatProfile,
  MagnetRetention,
  MagnetSize,
  NameplateParams,
  Project,
  Vec3,
} from '@/types';
import type { CustomFont } from '@/types/textLabel';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import {
  MAGNETS,
  MAGNET_CAPTURE_SKIN,
  MAGNET_PAUSE_LAYER,
  magnetCapturePauseZ,
  magnetPocket,
  magnetPocketBoss,
  magnetPocketDiameterForRetention,
} from './fasteners';
import {
  difference,
  extrude,
  roundedRectPrism,
  rotate,
  translate,
  union,
  type BuildNode,
  type BuildOp,
} from './buildPlan';
import { computeShellDims } from './caseShell';
import { computeLidDims } from './lid';
import { faceFrame, placeOnFace } from '@/engine/coords';
import { centredTextOutline, faceRotations } from './textLabels';
import { getBuiltinHat } from '@/library/hats';
import { getBuiltinDisplay } from '@/library/displays';

type DisplayResolver = (id: string) => DisplayProfile | undefined;

/** Solid behind a case pocket (between its floor and the cavity), mm. */
export const MAGNET_BACKING = 1;
/** Wall of the inside boss around a pocket, mm (four 0.4 mm perimeters). */
export const MAGNET_BOSS_WALL = 1.6;
/** Default row pitch beyond the disc, mm. */
export const MAGNET_ROW_GAP = 6;
/** Solid between a plate pocket's floor and the text (or the face), mm. */
export const NAMEPLATE_FACE_SKIN = 0.6;
/** Pocket edge to plate edge, mm, when there are two or more magnets. */
export const NAMEPLATE_EDGE = 3;
/** Text margin inside the plate outline, mm per side. */
export const NAMEPLATE_TEXT_MARGIN = 2;

const INWARD: Record<CaseFace, Facing> = {
  '+x': '-x',
  '-x': '+x',
  '+y': '-y',
  '-y': '+y',
  '+z': '-z',
  '-z': '+z',
};

/** Human face names — UI text and the nameplate's node id. */
export const FACE_NAME: Record<CaseFace, string> = {
  '-y': 'front',
  '+y': 'back',
  '-x': 'left',
  '+x': 'right',
  '+z': 'top',
  '-z': 'bottom',
};

export const NAMEPLATE_NODE_PREFIX = 'nameplate-';

/** The nameplate's node id for a face, e.g. `nameplate-front`. */
export function nameplateNodeId(face: CaseFace): string {
  return `${NAMEPLATE_NODE_PREFIX}${FACE_NAME[face]}`;
}

/** One case-side pocket, resolved to numbers. */
export interface ResolvedPocket {
  /** The `MagnetPocket.id` it came from, or `nameplate`. */
  sourceId: string;
  face: CaseFace;
  size: MagnetSize;
  /** What was asked for. */
  retention: MagnetRetention;
  /** What is cut: a side-wall 'captured' is cut open for glue. */
  cut: MagnetRetention;
  /** Pocket centre on the face, (u, v) mm. */
  u: number;
  v: number;
  /** Mouth centre: WORLD for the shell, LID-LOCAL for '+z'. */
  at: Vec3;
  /** Mouth centre in the assembled WORLD frame, whichever node it is in. */
  world: Vec3;
  inward: Facing;
  diameter: number;
  depth: number;
  /** Skin between face and pocket; 0 for an open pocket. */
  skin: number;
  /** The face's own material along the axis, mm. */
  wall: number;
  /** An inside boss, when the wall is thinner than skin + depth + backing. */
  boss: { diameter: number; length: number } | null;
  /** For a captured pocket: pause after the layer finishing at this Z, mm. */
  pauseZ: number | null;
  /** True when the pocket circle runs off the face. */
  offFace: boolean;
}

export interface ResolvedNameplate {
  params: NameplateParams;
  nodeId: string;
  /** u offsets of the magnets from the plate centre (symmetric), mm. */
  offsets: number[];
  /** Plate pocket depth actually cut (clamped to the plate), mm. */
  plateDepth: number;
  /** Plate thickness the table pocket needs, mm. */
  neededThickness: number;
  textWidth: number;
}

export interface MagnetFacts {
  pockets: ResolvedPocket[];
  nameplate: ResolvedNameplate | null;
  /** Plain sentences for the panel: things the user should know. */
  notes: string[];
}

interface ShellCtx {
  outerX: number;
  outerY: number;
  outerZ: number;
  lidTopLocal: number;
  lidZ: number;
}

function faceExtent(face: CaseFace, c: ShellCtx): [number, number] {
  if (face === '+z' || face === '-z') return [c.outerX, c.outerY];
  if (face === '+y' || face === '-y') return [c.outerX, c.outerZ];
  return [c.outerY, c.outerZ];
}

function wallFor(face: CaseFace, params: CaseParameters): number {
  if (face === '+z') return params.lidThickness;
  if (face === '-z') return params.floorThickness;
  return params.wallThickness;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** A row of `count` offsets, `pitch` apart, centred on 0. */
export function rowOffsets(count: number, pitch: number): number[] {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => r2((i - (n - 1) / 2) * pitch));
}

/** Magnet offsets along a plate's width: one centred, or spread edge to edge. */
export function nameplateOffsets(p: NameplateParams): number[] {
  const n = Math.max(1, Math.min(4, Math.floor(p.magnetCount)));
  if (n === 1) return [0];
  const inset = MAGNETS[p.magnetSize].pocket.d / 2 + NAMEPLATE_EDGE;
  const span = Math.max(0, p.width - 2 * inset);
  return rowOffsets(n, span / (n - 1));
}

function resolveOne(
  sourceId: string,
  face: CaseFace,
  u: number,
  v: number,
  size: MagnetSize,
  retention: MagnetRetention,
  params: CaseParameters,
  c: ShellCtx,
): ResolvedPocket {
  const vertical = face === '+z' || face === '-z';
  const cut: MagnetRetention = retention === 'captured' && !vertical ? 'glue' : retention;
  const spec = MAGNETS[size];
  const diameter = magnetPocketDiameterForRetention(size, cut);
  const depth = spec.pocket.h;
  const skin = cut === 'captured' ? MAGNET_CAPTURE_SKIN : 0;
  const wall = wallFor(face, params);
  const need = skin + depth + MAGNET_BACKING;
  const onLid = face === '+z';
  const frame = faceFrame(face, c.outerX, c.outerY, onLid ? c.lidTopLocal : c.outerZ);
  const at = placeOnFace(frame, u, v);
  const world: Vec3 = onLid ? [at[0], at[1], at[2] + c.lidZ] : at;
  const [fw, fh] = faceExtent(face, c);
  const rad = diameter / 2;
  return {
    sourceId,
    face,
    size,
    retention,
    cut,
    u,
    v,
    at,
    world,
    inward: INWARD[face],
    diameter,
    depth,
    skin,
    wall,
    boss: need > wall ? { diameter: r2(diameter + 2 * MAGNET_BOSS_WALL), length: r2(need) } : null,
    // The case floor prints on the bed and the lid prints flipped, so in both
    // the pocket's mouth face is the first layer: the pause is skin + depth.
    pauseZ: cut === 'captured' ? magnetCapturePauseZ(size, skin, MAGNET_PAUSE_LAYER, depth) : null,
    offFace: u - rad < 0 || v - rad < 0 || u + rad > fw || v + rad > fh,
  };
}

/**
 * Resolve every pocket and the nameplate to numbers. Pure: no geometry.
 */
export function resolveMagnets(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = () => undefined,
  customFonts: readonly CustomFont[] = [],
): MagnetFacts {
  const out: MagnetFacts = { pockets: [], nameplate: null, notes: [] };
  const list = (params.magnetPockets ?? []).filter((m) => m.enabled);
  const plate = params.nameplate?.enabled ? params.nameplate : null;
  if (list.length === 0 && !plate) return out;

  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const lid = computeLidDims(board, params, hats, resolveHat, display, resolveDisplay);
  const c: ShellCtx = {
    outerX: dims.outerX,
    outerY: dims.outerY,
    outerZ: dims.outerZ,
    lidTopLocal: lid.z,
    lidZ: lid.zPosition,
  };

  for (const m of list) {
    const pitch = m.pitch ?? MAGNETS[m.size].d + MAGNET_ROW_GAP;
    for (const du of rowOffsets(m.count ?? 1, pitch)) {
      out.pockets.push(
        resolveOne(m.id, m.face, m.u + du, m.v, m.size, m.retention ?? 'glue', params, c),
      );
    }
  }

  if (plate) {
    const offsets = nameplateOffsets(plate);
    const spec = MAGNETS[plate.magnetSize];
    const engraveDepth = plate.textMode === 'engrave' ? plate.textDepth : 0;
    const neededThickness = r2(spec.pocket.h + NAMEPLATE_FACE_SKIN + engraveDepth);
    const plateDepth = r2(Math.min(spec.pocket.h, plate.thickness - NAMEPLATE_FACE_SKIN - engraveDepth));
    // Measuring the text needs its font loaded; the panel can ask before the
    // compile has loaded it, and then simply has no width to report yet.
    let typeset: ReturnType<typeof centredTextOutline>;
    try {
      typeset = plate.text.trim()
        ? centredTextOutline(plate.text, plate.font ?? 'sans-default', plate.weight ?? 'regular', plate.textSize, customFonts)
        : null;
    } catch {
      typeset = null;
    }
    for (const du of offsets) {
      // The SAME (u, v) the plate's pockets sit at: the plate is centred on
      // (plate.u, plate.v) and its offsets are symmetric, so whichever way its
      // text runs along u, its pocket centres land on these.
      const p = resolveOne(
        'nameplate',
        plate.face,
        plate.u + du,
        plate.v,
        plate.magnetSize,
        plate.retention ?? 'glue',
        params,
        c,
      );
      out.pockets.push(p);
    }
    out.nameplate = {
      params: plate,
      nodeId: nameplateNodeId(plate.face),
      offsets,
      plateDepth,
      neededThickness,
      textWidth: typeset ? r2(typeset.width) : 0,
    };

    if (plateDepth < spec.pocket.h) {
      out.notes.push(
        plateDepth <= 0
          ? `The nameplate is ${plate.thickness} mm thick; a ${plate.magnetSize} mm magnet needs ${neededThickness} mm, so its back is left without pockets.`
          : `The nameplate is ${plate.thickness} mm thick; a ${plate.magnetSize} mm magnet needs ${neededThickness} mm. Its pockets are cut ${plateDepth} mm deep, so the magnets stand ${r2(spec.h - plateDepth)} mm proud of the back.`,
      );
    }
    const room = plate.width - 2 * NAMEPLATE_TEXT_MARGIN;
    if (typeset && typeset.width > room) {
      out.notes.push(
        `The nameplate text is ${r2(typeset.width)} mm wide; the plate leaves ${r2(room)} mm for it. Widen the plate or shrink the text.`,
      );
    }
    if (offsets.length > 1 && offsets[1]! - offsets[0]! < spec.pocket.d + 1) {
      out.notes.push(
        `${offsets.length} magnets of ${spec.d} mm do not fit side by side on a ${plate.width} mm plate; use fewer or widen it.`,
      );
    }
  }

  for (const p of out.pockets) {
    const who = p.sourceId === 'nameplate' ? 'A nameplate pocket' : 'A magnet pocket';
    const where = FACE_NAME[p.face];
    if (p.offFace) {
      const [fw, fh] = faceExtent(p.face, c);
      out.notes.push(
        `${who} at u ${r2(p.u)} mm, v ${r2(p.v)} mm runs off the ${where} face (${r2(fw)} × ${r2(fh)} mm).`,
      );
    }
    if (p.retention === 'captured' && p.cut !== 'captured') {
      out.notes.push(
        `${who} on the ${where} wall cannot be captured: a side wall prints the pocket on edge, so a magnet cannot be dropped in mid-print. It is cut open for glue.`,
      );
    }
  }
  // State each distinct pause once, not per pocket.
  const pauses = new Map<string, number>();
  for (const p of out.pockets) {
    if (p.pauseZ !== null) pauses.set(p.face === '+z' ? 'lid' : 'case body', p.pauseZ);
  }
  for (const [part, z] of pauses) {
    out.notes.push(
      `Captured magnets: pause the ${part} print at Z ${z.toFixed(2)} mm (${MAGNET_PAUSE_LAYER} mm layers, after the layer that finishes there) and drop the magnets in; a ${MAGNET_CAPTURE_SKIN} mm skin closes the face.`,
    );
  }
  return out;
}

function projectResolvers(project: Project) {
  const customHats = new Map((project.customHats ?? []).map((h) => [h.id, h] as const));
  const customDisplays = new Map((project.customDisplays ?? []).map((d) => [d.id, d] as const));
  return {
    resolveHat: (id: string) => customHats.get(id) ?? getBuiltinHat(id),
    resolveDisplay: (id: string) => customDisplays.get(id) ?? getBuiltinDisplay(id),
  };
}

/** `resolveMagnets` for a whole project, with the compiler's resolvers. A
 *  pocket that runs into a port, the board or another interior feature is
 *  stated by the compiler's shared clash pass (`caseClashes.ts`), which tests
 *  the real solids rather than their boxes. */
export function magnetFactsForProject(project: Project): MagnetFacts {
  const r = projectResolvers(project);
  return resolveMagnets(
    project.board,
    project.case,
    project.hats ?? [],
    r.resolveHat,
    project.display,
    r.resolveDisplay,
    project.customFonts ?? [],
  );
}

/** A case face's (u, v) extent, mm — for defaults that land mid-face. */
export function faceSizeForProject(project: Project, face: CaseFace): [number, number] {
  const r = projectResolvers(project);
  const dims = computeShellDims(project.board, project.case, project.hats ?? [], r.resolveHat, project.display, r.resolveDisplay);
  return faceExtent(face, { outerX: dims.outerX, outerY: dims.outerY, outerZ: dims.outerZ, lidTopLocal: 0, lidZ: 0 });
}

export interface MagnetOpGroups {
  /** Inside bosses, WORLD, to union into the shell. */
  shellAdd: BuildOp[];
  /** Pocket cutters, WORLD, to subtract from the shell. */
  shellCut: BuildOp[];
  /** Inside bosses, LID-LOCAL. */
  lidAdd: BuildOp[];
  /** Pocket cutters, LID-LOCAL. */
  lidCut: BuildOp[];
  /** The nameplate part, WORLD (assembled), or null. */
  nameplate: BuildNode | null;
  facts: MagnetFacts;
}

/** The inside boss for one resolved pocket, or null when the wall is thick
 *  enough. Same frame as `pocketCutter` (WORLD for the shell, LID-LOCAL for
 *  '+z'). Started 0.05 mm inside the face so it never shares the face's plane. */
export function pocketBossOp(p: ResolvedPocket): BuildOp | null {
  if (!p.boss) return null;
  return magnetPocketBoss({
    at: p.at,
    axis: p.inward,
    start: 0.05,
    length: p.boss.length - 0.05,
    diameter: p.boss.diameter,
  });
}

/** Cutter for one resolved case pocket (exported for the specs). */
export function pocketCutter(p: ResolvedPocket): BuildOp {
  return magnetPocket({
    size: p.size,
    at: p.at,
    axis: p.inward,
    diameter: p.diameter,
    depth: p.depth,
    skin: p.skin,
    material: Math.max(p.wall, p.boss?.length ?? 0),
    floor: MAGNET_BACKING,
  });
}

/** The nameplate as a solid, in the plate's own frame: centred on the origin
 *  in x/y, back face at z = 0, front (text) face at z = thickness. */
export function buildNameplateLocal(
  plate: NameplateParams,
  resolved: Pick<ResolvedNameplate, 'offsets' | 'plateDepth'>,
  customFonts: readonly CustomFont[] = [],
): BuildOp {
  const t = plate.thickness;
  const body = translate(
    [-plate.width / 2, -plate.height / 2, 0],
    roundedRectPrism(plate.width, plate.height, t, plate.cornerRadius ?? 2),
  );
  const cuts: BuildOp[] = [];
  if (resolved.plateDepth > 0) {
    for (const du of resolved.offsets) {
      cuts.push(
        magnetPocket({ size: plate.magnetSize, at: [du, 0, 0], axis: '+z', depth: resolved.plateDepth }),
      );
    }
  }
  const typeset = plate.text.trim()
    ? centredTextOutline(plate.text, plate.font ?? 'sans-default', plate.weight ?? 'regular', plate.textSize, customFonts)
    : null;
  let solid: BuildOp = body;
  if (typeset) {
    if (plate.textMode === 'engrave') {
      cuts.push(translate([0, 0, t - plate.textDepth], extrude(typeset.outline, plate.textDepth + 0.05)));
    } else {
      // Sunk 0.2 mm so the letters fuse to the plate (textLabels' EMBOSS_EMBED).
      solid = union([body, translate([0, 0, t - 0.2], extrude(typeset.outline, plate.textDepth + 0.2))]);
    }
  }
  return cuts.length > 0 ? difference([solid, ...cuts]) : solid;
}

/**
 * The ops for the case's magnets and the nameplate node. Every list is empty,
 * and `nameplate` null, for a project with neither — the compiler then adds
 * nothing, so such a project's plan is unchanged.
 */
export function buildMagnetOps(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = () => undefined,
  customFonts: readonly CustomFont[] = [],
): MagnetOpGroups {
  const facts = resolveMagnets(board, params, hats, resolveHat, display, resolveDisplay, customFonts);
  const out: MagnetOpGroups = { shellAdd: [], shellCut: [], lidAdd: [], lidCut: [], nameplate: null, facts };
  for (const p of facts.pockets) {
    const onLid = p.face === '+z';
    const boss = pocketBossOp(p);
    if (boss) (onLid ? out.lidAdd : out.shellAdd).push(boss);
    (onLid ? out.lidCut : out.shellCut).push(pocketCutter(p));
  }
  const np = facts.nameplate;
  if (np) {
    const plate = np.params;
    let op = buildNameplateLocal(plate, np, customFonts);
    for (const r of faceRotations(plate.face)) op = rotate(r, op);
    // The plate's centre on the face, in the assembled world frame.
    const onLid = plate.face === '+z';
    const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
    const lid = computeLidDims(board, params, hats, resolveHat, display, resolveDisplay);
    const frame = faceFrame(plate.face, dims.outerX, dims.outerY, onLid ? lid.z + lid.zPosition : dims.outerZ);
    out.nameplate = { id: np.nodeId, op: translate(placeOnFace(frame, plate.u, plate.v), op) };
  }
  return out;
}

/** The nameplate's text as a font-bearing label, so the job scheduler loads
 *  its font before the synchronous compile (fonts/registry `fontKeysForLabels`). */
export function nameplateFontLabels(
  params: CaseParameters,
): { text: string; font: string; weight: 'regular' | 'bold'; enabled: boolean }[] {
  const p = params.nameplate;
  if (!p?.enabled || !p.text.trim()) return [];
  return [{ text: p.text, font: p.font ?? 'sans-default', weight: p.weight ?? 'regular', enabled: true }];
}
