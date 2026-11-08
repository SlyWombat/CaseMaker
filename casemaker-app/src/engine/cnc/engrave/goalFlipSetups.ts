/**
 * #872 slice 3 — THE ONE PRESS: turn an approved flip plan into saved setups and the goals they
 * cut, and state the HOLD that survives the flip.
 *
 * A plan's sides are stock ORIENTATIONS. To become setups a side needs three things the plan does
 * not carry: the goal placed in the NEW setup's work frame, the mount and the reference that
 * finds the stock again (`pins`, `remount`), and a hold the first setup leaves that the second is
 * registered against. This module is that conversion, pure: a job, its goal and the plan's faces
 * in, the setups and goals (and the hold's facts) out.
 *
 * THE GOAL IN A NEW FRAME. Setup 1's work frame has the stock spanning X 0…L, Y 0…W, Z −T…0 (the
 * work origin on its top face). A side with the stock turned by `R` (the setups engine's matrix)
 * puts the same physical point at `R·(x, y, z + T) − origin`, `origin` being the rotated stock
 * box's front-left-top corner in machine coordinates. Each side is computed FROM THE ORIGINAL
 * goal and stock — never chained from the previous side — so a four-side plan cannot accumulate
 * rounding, and the flipped setup cuts the same part from the other side, not a mirrored copy.
 *
 * THE HOLD. A flip is only a plan if setup 1 leaves something for setup 2 to register on: two
 * dowel HOLES, drilled in the stock's margin and OUTSIDE the goal's footprint, named with the
 * diameter of a drill the shop OWNS and a depth through the stock into the board under it. Setup 2
 * records them as its `pins`, carried into its mounted work frame; because the two holes are off
 * the stock's centre line, `pinReference`'s mirror question has one right answer.
 */

import { getTools } from '@/engine/cnc/toolRegistry';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { placeTarget } from './targetPlace';
import { applyMat, placedSize, rotationMatrix, targetTurns, type Mat3 } from './targetScale';
import { silhouettePlane, UNDERSIDE_TAB_THICKNESS_MM } from './goalUnderside';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { orient, type Mat } from '@/engine/cnc/setups/orient';
import type { Face, MountSpec } from '@/engine/cnc/setups/types';
import { jobMount, jobSetups } from './jobSetup';
import { flipMatrix, flipOrientation, FLIP_BORE_CHIP_CLEARANCE_MM, FLIP_BORE_DIAMETER_MM } from './flipChoice';
import { newId } from '@/utils/id';
import type { EngraveJob, EngraveTargetObject, JobSetup, JobSetupPins, SetupFlip } from '@/types/engraveJob';
import { coverageTriangles, sampleCoverageField, type CoverageMesh } from './goalCoverage';

const DEG = Math.PI / 180;

/** Row-major 3×3 product, `a·b`. */
function matMul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as number[];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out as unknown as Mat3;
}

/** Euler XYZ turns (`Rx·Ry·Rz`, the app's own convention) from a matrix. */
export function turnsOfMatrix(m: Mat3): { x: number; y: number; z: number } {
  const sy = Math.max(-1, Math.min(1, m[2]!));
  const y = Math.asin(sy);
  const cy = Math.cos(y);
  if (Math.abs(cy) > 1e-9) {
    return { x: Math.atan2(-m[5]!, m[8]!) / DEG, y: y / DEG, z: Math.atan2(-m[1]!, m[0]!) / DEG };
  }
  // Gimbal lock: X and Z describe one turn; put all of it in X.
  return { x: Math.atan2(m[7]!, m[4]!) / DEG, y: y / DEG, z: 0 };
}

/** Degrees into 0…360 (six decimals), so a stored document reads one turn one way. */
function normalize(deg: number): number {
  const v = Math.round((((deg % 360) + 360) % 360) * 1e6) / 1e6;
  return v === 360 ? 0 : v;
}

export interface Box3 {
  x: number;
  y: number;
  z: number;
}

/** The rotated stock box's machine-frame bounds and the setup's work origin (front-left-TOP). */
export function setupFrame(R: Mat3, stock: Box3): { origin: Box3; machineToWork: (m: Box3) => Box3 } {
  let minX = Infinity, minY = Infinity, maxZ = -Infinity;
  for (const cx of [0, stock.x]) {
    for (const cy of [0, stock.y]) {
      for (const cz of [0, stock.z]) {
        const m = applyMat(R, { x: cx, y: cy, z: cz });
        minX = Math.min(minX, m.x);
        minY = Math.min(minY, m.y);
        maxZ = Math.max(maxZ, m.z);
      }
    }
  }
  const origin = { x: minX, y: minY, z: maxZ };
  return {
    origin,
    machineToWork: (m) => ({ x: m.x - origin.x, y: m.y - origin.y, z: m.z - origin.z }),
  };
}

/** The physical point (setup 1's work coordinates) as the setup turns it: machine = R·(p + (0,0,T)). */
function toMachine(R: Mat3, stock: Box3, p: Box3): Box3 {
  return applyMat(R, { x: p.x, y: p.y, z: p.z + stock.z });
}

/** `Mᵗ`, row-major 3×3 — a proper rotation's own inverse (`orient`'s own guarantee: det = +1,
 *  orthonormal), so this is all the inverse chain below needs. */
function transpose(m: Mat3): Mat3 {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

/**
 * #898 part 2 — THE EXPLICIT AFFINE, both ways, for a reader (C's whole-surface union) that needs
 * to carry a point measured in one setup's own work frame back to setup 1's (the document's own
 * geometry) — or forward, the same chain `goalForSetup` already walks for a bbox.
 *
 * FORWARD is this module's own existing chain restated as one call: `toMachine` (shift by the
 * stock's thickness, box-frame bottom-origin, then `R`) then `frame.machineToWork` (re-zero on
 * the rotated box's own top). INVERSE solves the same equation for the setup-1 point: `R` is a
 * proper rotation (orthonormal), so `R⁻¹ = Rᵗ` and `p = Rᵗ·(w + origin) − (0,0,T)`. Computed
 * fresh from `R` and `stock` every call — never chained — the same promise the forward chain
 * already keeps.
 */
export interface SetupAffine {
  /** Setup 1's own work frame → this setup's own work frame (the forward chain, restated). */
  toSetup(p: Box3): Box3;
  /** This setup's own work frame → setup 1's (the document's) — the inverse. */
  toDocument(p: Box3): Box3;
}

export function setupAffine(R: Mat3, stock: Box3): SetupAffine {
  const frame = setupFrame(R, stock);
  const Rt = transpose(R);
  return {
    toSetup: (p) => frame.machineToWork(toMachine(R, stock, p)),
    toDocument: (w) => {
      const m = { x: w.x + frame.origin.x, y: w.y + frame.origin.y, z: w.z + frame.origin.z };
      const r = applyMat(Rt, m);
      return { x: r.x, y: r.y, z: r.z - stock.z };
    },
  };
}

/**
 * #914 — the single Z constant that turns a PURE rotation of a setup-1 work-frame point (`R·p`,
 * no shift — `goalFlipPlan`'s own `rotateCoverageMesh`, which never needed the absolute frame
 * because its classification is translation-invariant) into that same point's real depth below
 * THIS candidate orientation's own stock top: `setupAffine(R, stock).toSetup(p).z` always equals
 * `(R·p).z + faceDepthOffsetMm(R, stock)` — the two chains differ only by this one constant, so
 * the plan's reach-aware scoring can add it to an already-rotated triangle's z instead of
 * re-transforming the whole mesh a second time.
 */
export function faceDepthOffsetMm(R: Mat3, stock: Box3): number {
  const c = applyMat(R, { x: 0, y: 0, z: stock.z });
  return c.z - setupFrame(R, stock).origin.z;
}

/**
 * #898 part 2 — WHICH GENERATED-PROGRAM-LIST INDEXES BELONG TO THIS SETUP, in cut order. Read off
 * the generator's OWN posted list (`EngraveProgram.setupId`, `programs.ts`'s `setupPrograms`
 * carries the same id through), never predicted from `JobSetup.tools`: a setup whose rest pass
 * finds nothing to cut drops a program (#419's own settle pass, `engraveGenerate.ts`), and a face
 * or neck file can insert one — only the real, posted list knows where a setup's programs
 * actually landed.
 */
export function programIndexesFor(setupId: string, programs: readonly { setupId: string }[]): number[] {
  const out: number[] = [];
  programs.forEach((p, i) => {
    if (p.setupId === setupId) out.push(i);
  });
  return out;
}

/** #914/#898 — how flat a face must be to count as "the stock's own bottom", degrees off straight
 *  down; the same tolerance `goalFlipPlan`'s own noise rule reads a flat remainder by. */
const STOCK_BOTTOM_FLAT_DEG = 3;

export interface ExcludedSurface {
  reason: 'stock-bottom';
  areaMm2: number;
}

/**
 * #914/#898 — THE GOAL'S OWN UNDERSIDE, PRESSED AGAINST THE STOCK'S BOTTOM in setup 1: no setup a
 * flip plan offers ever puts this face up — it is the face the part sits ON — so it is excluded
 * BY DESIGN, not refused for lack of a holdable side. The maintainer named the elephant's
 * underside as the first case (#943 review §4.1: "the elephant's underside on the stock bottom is
 * excluded by design"). This looks for exactly that shape: a FLAT face (within
 * `STOCK_BOTTOM_FLAT_DEG` of straight down) sitting at the STOCK's own bottom plane
 * (`z ≈ −stockThicknessMm`, setup 1's own work-frame convention — top at 0). A goal with no such
 * face there (nothing flat at the stock's own bottom) returns null.
 *
 * NOT THE MESH'S OWN MINIMUM. An earlier version of this function anchored on the mesh's lowest
 * vertex, which is WRONG whenever the goal does not reach all the way to the stock's physical
 * floor: on the real stick figure (36 mm stock, ~27 mm goal depth) the goal's lowest point sits 9
 * mm clear of the stock bottom, and that 9 mm clearance means a FLIPPED setup reaches those faces
 * easily (9 mm is well inside a 21 mm band) — crediting them as both "excluded" and "reached"
 * would double-count the same area. Anchoring on the stock's own floor instead of the mesh's
 * minimum is why `stockThicknessMm` is a required input, not an optional one.
 *
 * THIS IS A NAMED FIRST CASE, not a general "any excluded region" system: a shape whose true
 * stock-bottom contact is NOT flat (curved feet, three point-contacts) is not detected, and this
 * function says so by returning null rather than guessing at a shape it has not seen. Extend it
 * when a second shape needs a different rule.
 */
export function stockBottomExclusion(mesh: CoverageMesh, stockThicknessMm: number, pitchMm = 0.3): ExcludedSurface | null {
  const field = sampleCoverageField(mesh, pitchMm);
  // `{}` — the default classification is irrelevant here: this reads `nz`/`areaMm2`/`centre`
  // directly, never `cls` (`coverageTriangles`' own `facingDeg` means "tilt down PAST VERTICAL",
  // a near-90° test for its purpose; "flat", for this function, means near nz = −1, straight
  // down, a much narrower band this function tests for itself).
  const facts = coverageTriangles(mesh, field, {});
  const stockBottomZ = -stockThicknessMm;
  const atTheFloor = 0.5; // mm — slop around the stock's own bottom plane, not a tuned tolerance
  const straightDown = -Math.cos((STOCK_BOTTOM_FLAT_DEG * Math.PI) / 180);
  let areaMm2 = 0;
  for (const f of facts) {
    if (!(f.areaMm2 > 0)) continue;
    if (f.nz > straightDown) continue; // not within STOCK_BOTTOM_FLAT_DEG of straight down
    if (f.centre[2] > stockBottomZ + atTheFloor) continue; // not at the stock's own floor
    areaMm2 += f.areaMm2;
  }
  return areaMm2 > 0 ? { reason: 'stock-bottom', areaMm2 } : null;
}

/**
 * The same goal seen from a setup whose stock turn is `R` (stock→machine): the identical mesh
 * under that isometry, expressed as a target placement (bbox centre in XY, top in Z, Euler XYZ).
 */
export function goalForSetup(target: EngraveTargetObject, stock: Box3, R: Mat3): EngraveTargetObject {
  const mesh = targetObjectMesh(target);
  const { place } = placeTarget(target, mesh);
  const frame = setupFrame(R, stock);
  const placed = (bx: number, by: number, bz: number): Box3 => {
    const [x, y, z] = place(bx, by, bz);
    return frame.machineToWork(toMachine(R, stock, { x, y, z }));
  };

  const turns = turnsOfMatrix(matMul(R, rotationMatrix(targetTurns(target))));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const bx of [mesh.bbox.min[0], mesh.bbox.max[0]]) {
    for (const by of [mesh.bbox.min[1], mesh.bbox.max[1]]) {
      for (const bz of [mesh.bbox.min[2], mesh.bbox.max[2]]) {
        const w = placed(bx, by, bz);
        minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x);
        minY = Math.min(minY, w.y); maxY = Math.max(maxY, w.y);
        maxZ = Math.max(maxZ, w.z);
      }
    }
  }
  return {
    ...target,
    position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: maxZ },
    rotationX: normalize(turns.x),
    rotationY: normalize(turns.y),
    rotation: normalize(turns.z),
  };
}

/** The setups engine's flat row-major matrix, from `orient`'s row-pair form. */
function asMat3(m: Mat): Mat3 {
  return m.flat() as unknown as Mat3;
}

/**
 * #1073 — THE SIDE-2 GOAL FOR A STATED FLIP: the side-1 goal through the axis's own turn
 * (`flipMatrix`), placed by the SAME isometry `goalForSetup` already applies. The tab band and the
 * release follow because they ride the goal copy; the holes follow through `pinsFor`'s same
 * transform. One matrix, never a second hand-written mirror.
 */
export function goalForFlip(target: EngraveTargetObject, stock: Box3, axis: SetupFlip['axis']): EngraveTargetObject {
  return goalForSetup(target, stock, asMat3(flipMatrix(axis)));
}

/** The dowel holes setup 1 leaves: where they go, their diameter and their depth. */
export interface DowelHold {
  /** The BORE's diameter, mm — ⌀6 on the flip path, helically interpolated, not the cutter's own size. */
  diameterMm: number;
  /** The cutter's registry key that bores it, for the sentence. */
  cutter: string;
  /** Through the stock, through the job's breakthrough and the chip clearance — into the board, mm. */
  depthMm: number;
  /** The holes' centres, in SETUP 1's work XY — in the stock's margin, clear of the part. */
  at: [{ x: number; y: number }, { x: number; y: number }];
}

/** The tool's stated reach, mm — the SHOULDER when it states one, else the FLUTE (the #785 rule);
 *  null when the record states neither and the reach is simply unknown. */
function statedReachMm(tool: Tool): number | null {
  const positive = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v > 0 ? v : null);
  return positive(tool.shoulderLength) ?? positive(tool.fluteLength);
}

/**
 * #1073 — THE CUTTER THE LOCATING BORES ARE MADE WITH.
 *
 * The bore is ⌀6 and it is HELICAL INTERPOLATION, not a drill's own size — the maintainer's shop
 * is 1/8 in only (#977), so there is no ⌀5–6 cutter to find, and a ⌀6 drill could not make the
 * hole the wired V2's ⌀2 tip enters with room anyway. A flat SMALLER than the bore bores it out
 * on a helix; the one that must win is the OWNED FLAT WITH THE LONGEST REACH, because the flute
 * has to stand the whole depth of the bore (the M1 tray's 25.5 mm is why the 3.175 × 42 exists).
 *
 * The rule: among owned flats narrower than the bore, the longest stated reach that reaches the
 * depth wins (ties to the larger diameter, so the bore takes fewer orbits). A record that states
 * no reach at all is kept as the fallback — the #785 rule treats an unknown reach as an assumption
 * to state, not a refusal — and only a shop with no qualifying flat at all returns null.
 *
 * #911 stands in spirit: the first cut picked the narrowest tool and proposed ⌀0.2 holes; a hold
 * must be a hole a probe can enter.
 */
export function ownedBoreCutter(
  tools?: readonly { key: string; tool: Tool }[],
  needDepthMm = 0,
): { tool: Tool; key: string } | null {
  const entries = tools ?? getTools();
  let reaches: { tool: Tool; key: string; d: number; reach: number } | null = null;
  let unknown: { tool: Tool; key: string; d: number } | null = null;
  for (const entry of entries) {
    if (entry.tool.shape !== 'flat') continue;
    const d = cuttingDiameter(entry.tool);
    if (d === null || !(d > 0)) continue;
    // A flat AT the bore's size cannot interpolate it — it would rub, not cut, the wall.
    if (!(d < FLIP_BORE_DIAMETER_MM)) continue;
    const reach = statedReachMm(entry.tool);
    if (reach === null) {
      if (unknown === null || d > unknown.d) unknown = { tool: entry.tool, key: entry.key, d };
      continue;
    }
    if (reach < needDepthMm) continue;
    if (reaches === null || reach > reaches.reach || (reach === reaches.reach && d > reaches.d)) {
      reaches = { tool: entry.tool, key: entry.key, d, reach };
    }
  }
  const best = reaches ?? unknown;
  return best === null ? null : { tool: best.tool, key: best.key };
}

/** The goal's footprint in setup 1's work XY, from its placed mesh bbox. */
function goalFootprint(target: EngraveTargetObject): { minX: number; maxX: number; minY: number; maxY: number } {
  const mesh = targetObjectMesh(target);
  const { place } = placeTarget(target, mesh);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const bx of [mesh.bbox.min[0], mesh.bbox.max[0]]) {
    for (const by of [mesh.bbox.min[1], mesh.bbox.max[1]]) {
      for (const bz of [mesh.bbox.min[2], mesh.bbox.max[2]]) {
        const [x, y] = place(bx, by, bz);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * The hold setup 1 must leave for the flip: two dowel holes in the margin, clear of the goal's
 * footprint, on a line parallel to the flip axis and OFF the stock's centre line (so the pin
 * question can tell the right way round from a stock spun 180° about Z).
 */
export function dowelHold(
  job: EngraveJob,
  target: EngraveTargetObject,
  about: 'x' | 'y',
  tools?: readonly { key: string; tool: Tool }[],
): DowelHold | null {
  const L = job.stock.length;
  const W = job.stock.width;
  const f = goalFootprint(target);
  const margin = 4;
  // #1073 — THROUGH THE BLANK, ITS BREAKTHROUGH AND THE CHIP CLEARANCE: the bore only has to let
  // the probe in from side 2, so it stops half a millimetre into the board under the blank — the
  // job's own breakthrough plus `FLIP_BORE_CHIP_CLEARANCE_MM` — never the old 2 mm.
  const depthMm = Number((job.stock.thickness + job.breakthrough + FLIP_BORE_CHIP_CLEARANCE_MM).toFixed(2));
  // The cutter must stand the whole bore: the flute reaches the depth, and it is narrower than
  // the ⌀6 bore so the helix can open it. The HOLD states the BORE, never the cutter's size.
  const drill = ownedBoreCutter(tools, depthMm);
  if (drill === null) return null;
  if (about === 'x') {
    // The line runs along X, in the +Y margin behind the part.
    const y = Math.min(W - margin, Math.max(f.maxY + margin, W - margin));
    const yEdge = Math.max(margin, Math.min(y, W - margin));
    return {
      diameterMm: FLIP_BORE_DIAMETER_MM,
      cutter: drill.key,
      depthMm,
      // Off the centre line: 30 % and 70 % of the stock, never 50 %.
      at: [
        { x: Number((L * 0.3).toFixed(2)), y: Number(yEdge.toFixed(2)) },
        { x: Number((L * 0.7).toFixed(2)), y: Number(yEdge.toFixed(2)) },
      ],
    };
  }
  const x = Math.min(L - margin, Math.max(f.maxX + margin, L - margin));
  const xEdge = Math.max(margin, Math.min(x, L - margin));
  return {
    diameterMm: FLIP_BORE_DIAMETER_MM,
    cutter: drill.key,
    depthMm,
    at: [
      { x: Number(xEdge.toFixed(2)), y: Number((W * 0.3).toFixed(2)) },
      { x: Number(xEdge.toFixed(2)), y: Number((W * 0.7).toFixed(2)) },
    ],
  };
}

/** The setups and goals a plan adds, or why it cannot be added. */
export type FlipSetupsResult =
  | { ok: true; setups: JobSetup[]; goals: EngraveTargetObject[]; hold: DowelHold | null }
  | { ok: false; reason: string };

/**
 * #1073 line 2 — THE TAB BAND'S NUMBERS, in one place. The plane is the goal's widest cross-section
 * (`silhouettePlane`); side 1 stops the band ABOVE it and side 2 at the same band BELOW it, in
 * each side's own top-down depth. The tab thickness is the goal's stated `underside.tabs`, else
 * the default — the same number C's release op reads (default 1 mm).
 */
export function flipTabBands(
  target: EngraveTargetObject,
): { plane: number; tab: number; band1: number; band2: number } | { reason: string } {
  const plane = silhouettePlane(target);
  if (plane === null) return { reason: 'the goal’s mesh could not be read, so its widest line is unknown' };
  const tab = Math.max(0.2, target.underside?.tabs?.thicknessMm ?? UNDERSIDE_TAB_THICKNESS_MM);
  const minZ = target.position.z - placedSize(target).z;
  const band1 = Number((target.position.z - (plane + tab)).toFixed(3));
  const band2 = Number((plane - tab - minZ).toFixed(3));
  if (!(band1 > 0) || !(band2 > 0)) {
    return { reason: `a ${Number(tab.toFixed(2))} mm tab band does not fit inside this part at its widest line` };
  }
  return { plane, tab, band1, band2 };
}

/**
 * Convert a plan's faces into the document's side setups. Side 1 is the job's current setup,
 * materialised with its goal; each later side gets the goal in its own work frame and a setup
 * with the orientation, the mount and — where the hold exists — the pin reference.
 *
 * #1073 — `flip` is the operator's stated turn over. When given, the ONE later side is the stock's
 * bottom turned by the chosen axis (not the mount's default half turn), the side-1 goal and the
 * hold go through that same reflection, and the later setup stores the choice verbatim. A flip
 * choice describes exactly one turn over, so a plan of more than two sides, or a second side that
 * is not the bottom, is refused by name rather than half-turned.
 */
export function planFlipSetups(
  job: EngraveJob,
  target: EngraveTargetObject,
  faces: readonly Face[],
  tools?: readonly { key: string; tool: Tool }[],
  flip?: SetupFlip,
): FlipSetupsResult {
  if (faces.length < 2) return { ok: false, reason: 'a flip plan needs at least two sides' };
  if (job.setups !== undefined) return { ok: false, reason: 'this job already states its setups' };
  if (faces[0] !== 'top') return { ok: false, reason: 'the job’s first setup is not the stock’s top face' };
  if (flip !== undefined) {
    if (faces.length !== 2) {
      return { ok: false, reason: 'the flip choice states one turn over — a plan with two sides' };
    }
    if (faces[1] !== 'bottom') {
      return { ok: false, reason: 'the flip choice turns the stock over — the second side is its bottom face' };
    }
  }
  const mount: MountSpec = { kind: jobMount(job) };
  const stock: Box3 = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
  const base = jobSetups(job)[0];
  if (base === undefined) return { ok: false, reason: 'the job has no first setup' };

  const firstTurn = orient(faces[0]!, mount, stock);
  if (!firstTurn.ok) return { ok: false, reason: firstTurn.reason };
  const laterTurns: { face: Face; turned: ReturnType<typeof orient> }[] =
    flip !== undefined
      ? [
          {
            face: faces[1]!,
            turned: {
              ok: true,
              matrix: flipMatrix(flip.axis),
              orientation: flipOrientation(flip.axis),
              // The half turn's own axis: left↔right is the machine's Y, front↔back its X.
              rotate: { about: flip.axis === 'left-right' ? 'y' : 'x', degrees: 180 },
            },
          },
        ]
      : faces.slice(1).map((face) => {
          const turned = orient(face, mount, stock);
          return { face, turned };
        });
  for (const { turned } of laterTurns) {
    if (!turned.ok) return { ok: false, reason: turned.reason };
  }
  // The hold follows the FIRST flip's axis: that is the stock's first turn over, and the holes
  // must be on a line parallel to it.
  const flipAbout = laterTurns[0]!.turned.ok ? (laterTurns[0]!.turned.rotate?.about ?? 'x') : 'x';

  const hold = dowelHold(job, target, flipAbout, tools);

  // #1073 line 2 — A FRAME FLIP LEAVES THE PART ON TABS: both sides' goals are banded about the
  // part's silhouette plane, and both state the underside record C's release op reads — one
  // record, as the issue demands. The vendor method and a plain two-side plan write no bands.
  let band: { band1: number; band2: number; underside: NonNullable<EngraveTargetObject['underside']> } | null = null;
  if (flip !== undefined && flip.method === 'tabs-in-blank') {
    const b = flipTabBands(target);
    if ('reason' in b) return { ok: false, reason: b.reason };
    band = {
      band1: b.band1,
      band2: b.band2,
      underside: {
        ...(target.underside ?? {}),
        kind: 'flipped-tabs',
        source: 'user',
        // The thickness the band was cut to is written only when the goal states tabs; a goal
        // that states none keeps C's op's own default (1 mm), the same number used here.
        ...(target.underside?.tabs === undefined ? {} : { tabs: { ...target.underside.tabs, thicknessMm: b.tab } }),
      },
    };
  }

  const setups: JobSetup[] = [];
  const goals: EngraveTargetObject[] = [];

  const firstGoal: EngraveTargetObject = {
    ...target,
    id: newId('goal'),
    setupId: base.id,
    ...(band === null ? {} : { bandMm: band.band1, underside: band.underside }),
  };
  goals.push(firstGoal);
  setups.push({
    id: base.id,
    orientation: { ...firstTurn.orientation },
    mount: { kind: mount.kind },
    itemIds: [firstGoal.id],
    tools: [job.toolKey],
  });

  for (const { turned } of laterTurns) {
    if (!turned.ok) continue; // unreachable: checked above
    const id = newId('setup');
    // `orient` returns [row, row, row]; this module works on the flat row-major form.
    const R = turned.matrix.flat() as unknown as Mat3;
    const placed = goalForSetup(target, stock, R);
    const goal: EngraveTargetObject = {
      ...placed,
      id: newId('goal'),
      setupId: id,
      ...(band === null ? {} : { bandMm: band.band2, underside: band.underside }),
    };
    goals.push(goal);
    const pins = hold === null ? undefined : pinsFor(hold, stock, R);
    setups.push({
      id,
      orientation: { ...turned.orientation },
      mount: { kind: mount.kind },
      itemIds: [goal.id],
      tools: [job.toolKey],
      ...(pins === undefined ? {} : { pins }),
      // #1073 — the operator's choice, stored verbatim on the setup it turns.
      ...(flip === undefined ? {} : { flip }),
    });
  }
  return { ok: true, setups, goals, hold };
}

/** #898 — the two sides a flipped-tabs underside cuts the part from, and the tab band between. */
export interface UndersideFlipPlan {
  /** The silhouette plane in setup 1's work frame, mm (below the stock top). */
  planeZ: number;
  /** The tab band's half-thickness: each side stops this far short of the plane, mm. */
  tabThicknessMm: number;
  setups: JobSetup[];
  goals: EngraveTargetObject[];
  hold: DowelHold | null;
}

export type UndersideFlipResult = { ok: true; plan: UndersideFlipPlan } | { ok: false; reason: string };

/**
 * #898 — "FLIPPED, HELD BY TABS", as the two setups it is. The part parts at its silhouette plane
 * (its widest cross-section, `silhouettePlane`); setup 1 cuts down to `plane + tab` and setup 2,
 * the stock turned over, cuts down to `plane − tab` in its own frame. The band between the two
 * floors is the material the tabs are made of — it survives both programs, and the run sheet says
 * to cut them off by hand. Registration is #872's dowel hold (the flipped side sits on its pins).
 *
 * A goal whose underside is not `flipped-tabs` is refused by name; so is a part too thin for the
 * stated tab band. The bands are the split's own `bandMm` on each side's goal copy, so the
 * generator floors each program exactly there.
 */
export function planUndersideFlip(
  job: EngraveJob,
  target: EngraveTargetObject,
  tools?: readonly { key: string; tool: Tool }[],
): UndersideFlipResult {
  if (target.underside?.kind !== 'flipped-tabs') {
    return { ok: false, reason: 'this goal is not set to be cut from both sides' };
  }
  const b = flipTabBands(target);
  if ('reason' in b) return { ok: false, reason: b.reason };
  const { plane, tab, band1, band2 } = b;
  const base = planFlipSetups(job, target, ['top', 'bottom'], tools);
  if (!base.ok) return base;
  return {
    ok: true,
    plan: {
      planeZ: plane,
      tabThicknessMm: tab,
      setups: base.setups,
      goals: [{ ...base.goals[0]!, bandMm: band1 }, { ...base.goals[1]!, bandMm: band2 }],
      hold: base.hold,
    },
  };
}

/**
 * #891 — THE SIDES FOLLOW THE BLANK. A flip plan's later goals were placed through the stock box
 * the plan was built for; a THICKNESS change moves a flipped side's work frame (its origin is the
 * turned stock's top), so the goal that side cuts is re-derived from setup 1's own goal through
 * the same isometry `planFlipSetups` used. `bandMm` and the setup ids carry over, so a budget
 * split's bands survive the edit too. A side whose turn the new box cannot hold is left exactly as
 * it was — its own finding states the refusal — and so is a goal whose mesh cannot be read.
 * Null when there is nothing to re-hold (no saved list, one setup, no later goal) or nothing moved.
 */
export function reholdSetupGoals(job: EngraveJob, stock: { x: number; y: number; z: number }): EngraveTargetObject[] | null {
  const targets = job.targetObjects;
  const setups = job.setups;
  if (targets === undefined || setups === undefined || setups.length < 2) return null;
  const first = setups[0]!;
  const base = targets.find((t) => t.setupId === first.id);
  if (base === undefined) return null;
  let changed = false;
  const next = targets.map((goal) => {
    if (goal.setupId === undefined || goal.setupId === first.id) return goal;
    const setup = setups.find((s) => s.id === goal.setupId);
    if (setup === undefined) return goal;
    const faceUp = setup.orientation.top;
    if (faceUp === 'top') return goal;
    try {
      // #1073 — a setup that states its flip turns by the chosen axis, not the mount's default
      // half turn: front↔back on a bracket is a real choice, and the re-hold must keep it.
      let R: Mat3;
      if (setup.flip !== undefined && faceUp === 'bottom') {
        R = asMat3(flipMatrix(setup.flip.axis));
      } else {
        const turned = orient(faceUp, setup.mount, stock);
        if (!turned.ok) return goal;
        R = turned.matrix.flat() as unknown as Mat3;
      }
      const placed = goalForSetup(base, stock, R);
      const moved: EngraveTargetObject = { ...placed, id: goal.id, setupId: setup.id };
      if (goal.bandMm !== undefined) moved.bandMm = goal.bandMm;
      const same =
        Math.abs(moved.position.x - goal.position.x) < 1e-9 &&
        Math.abs(moved.position.y - goal.position.y) < 1e-9 &&
        Math.abs(moved.position.z - goal.position.z) < 1e-9 &&
        Math.abs(moved.rotation - goal.rotation) < 1e-9 &&
        Math.abs((moved.rotationX ?? 0) - (goal.rotationX ?? 0)) < 1e-9 &&
        Math.abs((moved.rotationY ?? 0) - (goal.rotationY ?? 0)) < 1e-9;
      if (same) return goal;
      changed = true;
      return moved;
    } catch {
      return goal;
    }
  });
  return changed ? next : null;
}

/**
 * #888 — THE BUDGET'S SPLIT, as setups: the goal cut as a top band and a bottom band, each from
 * its own side of the stock (the bottom band with the stock turned over, registered on the same
 * dowel holes #872 uses). Each side's goal copy states its band (`bandMm`), and the generator
 * floors that side's cut there — so one program per side, each about half the levels, each under
 * the move budget the finding states.
 *
 * The plan's numbers come from the finding (`suggestedSplit`), which was computed with the
 * generator's OWN move model: this function does not re-derive them, or the press and the sentence
 * could disagree about what fits. A job that already states setups, or a plan the setups engine
 * refuses, is refused with its reason rather than half-built.
 */
export function splitGoalForBudget(
  job: EngraveJob,
  target: EngraveTargetObject,
  split: { firstMm: number; secondMm: number },
  tools?: readonly { key: string; tool: Tool }[],
): FlipSetupsResult {
  let plan: FlipSetupsResult;
  try {
    plan = planFlipSetups(job, target, ['top', 'bottom'], tools);
  } catch (e) {
    // The goal's bytes are not a mesh the app can read: the press states the reason instead of
    // throwing into the panel.
    return { ok: false, reason: e instanceof Error ? e.message : 'the goal could not be read' };
  }
  if (!plan.ok) return plan;
  const [first, second] = plan.goals;
  if (first === undefined || second === undefined) return { ok: false, reason: 'the split needs both sides' };
  return {
    ...plan,
    goals: [
      { ...first, bandMm: split.firstMm },
      { ...second, bandMm: split.secondMm },
    ],
  };
}

/**
 * The hold's two holes in a setup's mounted work XY. The transform is the SAME isometry the goal
 * went through, so the pins are the physical holes and never a guessed mirror; a setup that turns
 * the stock so the holes no longer run vertically (a quarter turn) cannot use them and states
 * none, rather than a line that would send the operator to the wrong place.
 */
function pinsFor(hold: DowelHold, stock: Box3, R: Mat3): JobSetupPins | undefined {
  const axis = applyMat(R, { x: 0, y: 0, z: 1 });
  if (Math.abs(axis.z) < 0.9) return undefined;
  const frame = setupFrame(R, stock);
  const map = (p: { x: number; y: number }): { x: number; y: number } => {
    const w = frame.machineToWork(toMachine(R, stock, { x: p.x, y: p.y, z: 0 }));
    return { x: Number(w.x.toFixed(2)), y: Number(w.y.toFixed(2)) };
  };
  return { at: [map(hold.at[0]), map(hold.at[1])] };
}
