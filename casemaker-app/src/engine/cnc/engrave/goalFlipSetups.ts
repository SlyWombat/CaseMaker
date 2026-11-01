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
import { applyMat, rotationMatrix, targetTurns, type Mat3 } from './targetScale';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { orient } from '@/engine/cnc/setups/orient';
import type { Face, MountSpec } from '@/engine/cnc/setups/types';
import { jobMount, jobSetups } from './jobSetup';
import { newId } from '@/utils/id';
import type { EngraveJob, EngraveTargetObject, JobSetup, JobSetupPins } from '@/types/engraveJob';

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

interface Box3 {
  x: number;
  y: number;
  z: number;
}

/** The rotated stock box's machine-frame bounds and the setup's work origin (front-left-TOP). */
function setupFrame(R: Mat3, stock: Box3): { origin: Box3; machineToWork: (m: Box3) => Box3 } {
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

/** The dowel holes setup 1 leaves: where they go, their diameter and their depth. */
export interface DowelHold {
  /** Diameter of the drill the shop OWNS that makes the holes, mm. */
  diameterMm: number;
  /** The cutter's registry key, for the sentence. */
  cutter: string;
  /** Through the stock and into the board under it, mm. */
  depthMm: number;
  /** The holes' centres, in SETUP 1's work XY — in the stock's margin, clear of the part. */
  at: [{ x: number; y: number }, { x: number; y: number }];
}

/** The narrowest drill the shop owns, or null when it owns none. */
export function ownedDrill(tools?: readonly { key: string; tool: Tool }[]): { tool: Tool; key: string } | null {
  let best: { tool: Tool; key: string; d: number } | null = null;
  for (const entry of tools ?? getTools()) {
    if (entry.tool.shape !== 'drill') continue;
    const d = cuttingDiameter(entry.tool);
    if (d === null || !(d > 0)) continue;
    if (best === null || d < best.d) best = { tool: entry.tool, key: entry.key, d };
  }
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
  const drill = ownedDrill(tools);
  if (drill === null) return null;
  const diameter = cuttingDiameter(drill.tool);
  if (diameter === null || !(diameter > 0)) return null;
  const L = job.stock.length;
  const W = job.stock.width;
  const f = goalFootprint(target);
  const margin = 4;
  if (about === 'x') {
    // The line runs along X, in the +Y margin behind the part.
    const y = Math.min(W - margin, Math.max(f.maxY + margin, W - margin));
    const yEdge = Math.max(margin, Math.min(y, W - margin));
    return {
      diameterMm: diameter,
      cutter: drill.key,
      depthMm: Number((job.stock.thickness + 2).toFixed(2)),
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
    diameterMm: diameter,
    cutter: drill.key,
    depthMm: Number((job.stock.thickness + 2).toFixed(2)),
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
 * Convert a plan's faces into the document's side setups. Side 1 is the job's current setup,
 * materialised with its goal; each later side gets the goal in its own work frame and a setup
 * with the orientation, the mount and — where the hold exists — the pin reference.
 */
export function planFlipSetups(
  job: EngraveJob,
  target: EngraveTargetObject,
  faces: readonly Face[],
  tools?: readonly { key: string; tool: Tool }[],
): FlipSetupsResult {
  if (faces.length < 2) return { ok: false, reason: 'a flip plan needs at least two sides' };
  if (job.setups !== undefined) return { ok: false, reason: 'this job already states its setups' };
  if (faces[0] !== 'top') return { ok: false, reason: 'the job’s first setup is not the stock’s top face' };
  const mount: MountSpec = { kind: jobMount(job) };
  const stock: Box3 = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
  const base = jobSetups(job)[0];
  if (base === undefined) return { ok: false, reason: 'the job has no first setup' };

  const firstTurn = orient(faces[0]!, mount, stock);
  if (!firstTurn.ok) return { ok: false, reason: firstTurn.reason };
  const laterTurns = faces.slice(1).map((face) => {
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

  const setups: JobSetup[] = [];
  const goals: EngraveTargetObject[] = [];

  const firstGoal: EngraveTargetObject = { ...target, id: newId('goal'), setupId: base.id };
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
    const goal: EngraveTargetObject = { ...placed, id: newId('goal'), setupId: id };
    goals.push(goal);
    const pins = hold === null ? undefined : pinsFor(hold, stock, R);
    setups.push({
      id,
      orientation: { ...turned.orientation },
      mount: { kind: mount.kind },
      itemIds: [goal.id],
      tools: [job.toolKey],
      ...(pins === undefined ? {} : { pins }),
    });
  }
  return { ok: true, setups, goals, hold };
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
