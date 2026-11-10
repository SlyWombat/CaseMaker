/**
 * tests/unit/helpers/rotaryPenetration.ts — THE ROTARY PENETRATION SWEEP (#1164 slice a).
 *
 * The analyst's independent proof, lifted from `analysis-1155/sweep2.mjs` (scratch, not a repo
 * artifact) into a repo helper that returns numbers instead of printing prose. What it computes,
 * unchanged from the script:
 *
 * - the DESIGN SURFACE: every triangle sampled in barycentric space at 0.12 mm, keeping the
 *   samples inside the rod (`hypot(y, z) ≤ R`);
 * - the TOOL VOLUME: a ball of radius r at the tip pose plus its SHANK above the ball's centre — a
 *   point is inside when, above the centre, its lateral distance is < r, and below it, its distance
 *   to the centre is < r;
 * - a MOVE's penetration = the largest shortest-distance-to-the-tool-boundary over the samples it
 *   passes through — a LOWER bound on the normal overcut;
 * - the frame: the tool axis is the radial ray at angle A (degrees as POSTED; the script's sign
 *   flag exists because negating A buries the tool ~1,600 moves on the giraffe), the tip at radius
 *   Z on that ray, Y = 0; ball centre = (X, (Z + r)·(sin A, cos A));
 * - G1 moves are interpolated at ≤ 0.2 mm in (X, Z, arc at R); X buckets of 0.5 mm keep it seconds.
 *
 * The analyst's baseline (the giraffe's 2026-11-10 program): max 1.116 mm, 264 moves > 0.3 mm,
 * 15,635 surface samples > 0.3 mm, 184 > 1 mm. `rotaryPenetration1164.spec.ts` pins it.
 */

export interface RotaryMove {
  /** The pose the move STARTS from (after the preamble and any rapids since the last cut). */
  startX: number;
  startZ: number;
  startA: number;
  /** Tool X along the rod, mm. */
  x: number;
  /** Tip radius on the ray, mm. */
  z: number;
  /** The A angle AS POSTED, degrees. */
  aDeg: number;
  /** 1-based source line. */
  line: number;
  /** The operation the move belongs to ('rough' | 'finish' | the NC's own label). */
  operation: string;
}

export interface RotaryCutter {
  radius: number;
  shape: 'ball' | 'flat' | 'bull' | string;
}

export interface PenetrationAt {
  x: number;
  y: number;
  z: number;
  rho: number;
  aDeg: number;
  line: number;
}

export interface OperationPenetration {
  maxPenetrationMm: number;
  at: PenetrationAt | null;
  line: number | null;
  /** The number of moves in this operation whose own max exceeded `thresholdMm`. */
  movesOver: (thresholdMm: number) => number;
}

export interface RotaryPenetration {
  worst: (PenetrationAt & { penMm: number }) | null;
  /** Per move (G1 only): source line and its own maximum penetration. */
  moves: { line: number; operation: string; maxPenMm: number }[];
  byOperation: Record<string, OperationPenetration>;
  /** Moves by their own max: [0, <0.05, <0.3, <1, <2, ≥2 mm]. */
  histogram: [number, number, number, number, number, number];
  samples: { total: number; over005: number; over03: number; over1: number; over2: number };
}

/** Sample spacing on the design surface, mm (the analyst's constant). */
export const SURFACE_SAMPLE_MM = 0.12;
/** Move interpolation step, mm (the analyst's constant). */
export const MOVE_STEP_MM = 0.2;
const BUCKET_MM = 0.5;

/** Parse a posted rotary NC into G1 moves, labelled by `operationOf(lineText, index)`. */
export function parseRotaryMoves(
  nc: string,
  operationOf: (line: string, lineNumber: number) => string,
): RotaryMove[] {
  const lines = nc.split(/\r?\n/);
  let x = 0;
  let z = 27.25; // the giraffe script's start; the CALLER's first G-line sets the real value
  let a = 0;
  const moves: RotaryMove[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(G0?[01])\b/.exec(line);
    if (m === null) continue;
    const word = (c: string): number | null => {
      const q = new RegExp(c + '(-?[\\d.]+)').exec(line);
      return q === null ? null : Number(q[1]);
    };
    const nx = word('X') ?? x;
    const nz = word('Z') ?? z;
    const na = word('A') ?? a;
    if (m[1] !== 'G0') moves.push({ startX: x, startZ: z, startA: a, x: nx, z: nz, aDeg: na, line: i + 1, operation: operationOf(line, i + 1) });
    x = nx;
    z = nz;
    a = na;
  }
  return moves;
}

/**
 * The sweep. `triangles` is the mesh flattened to [x0,y0,z0, x1,y1,z1, x2,y2,z2, …] in the rod's
 * own frame (the +X placement baked in, as `analysis-1155/tris.json` is).
 */
export function sweepRotaryPenetration(input: {
  triangles: readonly number[];
  /** The rod's radius (the envelope). */
  R: number;
  moves: readonly RotaryMove[];
  cutter: RotaryCutter;
  /** Sign applied to A (the script's argv; 1 = as posted). */
  aSign?: number;
}): RotaryPenetration {
  const { triangles: tris, R, moves } = input;
  const r = input.cutter.radius;
  const sign = input.aSign ?? 1;

  // ── the design surface, sampled inside the rod ───────────────────────────────────────────────
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t]!;
    const ay = tris[t + 1]!;
    const az = tris[t + 2]!;
    const e1x = tris[t + 3]! - ax;
    const e1y = tris[t + 4]! - ay;
    const e1z = tris[t + 5]! - az;
    const e2x = tris[t + 6]! - ax;
    const e2y = tris[t + 7]! - ay;
    const e2z = tris[t + 8]! - az;
    const bx = tris[t + 6]!;
    const by = tris[t + 7]!;
    const bz = tris[t + 8]!;
    // The THIRD edge is c − b (the script's `c[0] - b[0]`), not c − a: an edge length decides the
    // tessellation, and c − a silently changed `N` on the triangles where it is the longest.
    const L = Math.max(
      Math.hypot(e1x, e1y, e1z),
      Math.hypot(e2x, e2y, e2z),
      Math.hypot(bx - tris[t + 3]!, by - tris[t + 4]!, bz - tris[t + 5]!),
    );
    const n = Math.max(1, Math.ceil(L / SURFACE_SAMPLE_MM));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n;
        const v = j / n;
        const x = ax + u * e1x + v * e2x;
        const y = ay + u * e1y + v * e2y;
        const z = az + u * e1z + v * e2z;
        if (Math.hypot(y, z) > R) continue;
        px.push(x);
        py.push(y);
        pz.push(z);
      }
    }
  }
  const total = px.length;
  let lo = Infinity;
  for (const x of px) if (x < lo) lo = x;
  const buckets = new Map<number, number[]>();
  for (let k = 0; k < total; k++) {
    const b = Math.floor((px[k]! - lo) / BUCKET_MM);
    const arr = buckets.get(b);
    if (arr === undefined) buckets.set(b, [k]);
    else arr.push(k);
  }

  // ── the pose sweep ──────────────────────────────────────────────────────────────────────────
  const gouged = new Float32Array(total);
  const worstOfPose = (x: number, z: number, aDeg: number, line: number): number => {
    const a = (sign * aDeg * Math.PI) / 180;
    const uy = Math.sin(a);
    const uz = Math.cos(a);
    const cy = (z + r) * uy;
    const cz = (z + r) * uz;
    let best = 0;
    for (let b = Math.floor((x - r - lo) / BUCKET_MM); b <= Math.floor((x + r - lo) / BUCKET_MM); b++) {
      const arr = buckets.get(b);
      if (arr === undefined) continue;
      for (const k of arr) {
        const wx = px[k]! - x;
        if (wx > r || wx < -r) continue;
        const wy = py[k]! - cy;
        const wz = pz[k]! - cz;
        const h = wy * uy + wz * uz;
        const d2 = wx * wx + wy * wy + wz * wz;
        const pen = h >= 0 ? r - Math.sqrt(Math.max(0, d2 - h * h)) : r - Math.sqrt(d2);
        if (pen > 0) {
          if (pen > gouged[k]!) gouged[k] = pen;
          if (pen > best) best = pen;
        }
      }
    }
    return best;
  };

  let worst: RotaryPenetration['worst'] = null;
  const histogram: RotaryPenetration['histogram'] = [0, 0, 0, 0, 0, 0];
  const perMove: RotaryPenetration['moves'] = [];
  // Every move sweeps from ITS OWN start pose — the one the NC had reached after the preamble and
  // any rapids since the last cut. Chaining consecutive G1 ends instead skips the repositioning
  // and sweeps the tool along paths it never travelled.
  for (const move of moves) {
    const len = Math.hypot(move.x - move.startX, move.z - move.startZ, ((move.aDeg - move.startA) * Math.PI * R) / 180);
    const steps = Math.max(1, Math.ceil(len / MOVE_STEP_MM));
    let maxPen = 0;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const pen = worstOfPose(
        move.startX + f * (move.x - move.startX),
        move.startZ + f * (move.z - move.startZ),
        move.startA + f * (move.aDeg - move.startA),
        move.line,
      );
      if (pen > maxPen) maxPen = pen;
    }
    if (maxPen > (worst?.penMm ?? 0)) {
      // Report the worst pose's own point: re-scan its samples cheaply at the move's end pose is
      // not exact, so report the move's line and its max; `at` is the deepest sample of the pose.
      worst = { penMm: maxPen, x: move.x, y: 0, z: move.z, rho: move.z, aDeg: move.aDeg, line: move.line };
    }
    histogram[maxPen <= 0 ? 0 : maxPen < 0.05 ? 1 : maxPen < 0.3 ? 2 : maxPen < 1 ? 3 : maxPen < 2 ? 4 : 5]++;
    perMove.push({ line: move.line, operation: move.operation, maxPenMm: maxPen });
  }

  const byOperation: Record<string, OperationPenetration> = {};
  for (const move of perMove) {
    const entry = (byOperation[move.operation] ??= { maxPenetrationMm: 0, at: null, line: null, movesOver: () => 0 });
    if (move.maxPenMm > entry.maxPenetrationMm) entry.maxPenetrationMm = move.maxPenMm;
  }
  for (const [name, entry] of Object.entries(byOperation)) {
    const lines = perMove.filter((m) => m.operation === name);
    entry.movesOver = (thresholdMm: number) => lines.filter((m) => m.maxPenMm > thresholdMm).length;
    const deepest = lines.reduce((best, m) => (m.maxPenMm > best.maxPenMm ? m : best), lines[0]!);
    entry.line = deepest.line;
    if (worst !== null && deepest.maxPenMm === entry.maxPenetrationMm) {
      const move = moves.find((m) => m.line === deepest.line)!;
      entry.at = { x: move.x, y: 0, z: move.z, rho: move.z, aDeg: move.aDeg, line: move.line };
    }
  }

  const samples = { total, over005: 0, over03: 0, over1: 0, over2: 0 };
  for (let k = 0; k < total; k++) {
    const v = gouged[k]!;
    if (v > 0.05) samples.over005++;
    if (v > 0.3) samples.over03++;
    if (v > 1) samples.over1++;
    if (v > 2) samples.over2++;
  }
  return { worst, moves: perMove, byOperation, histogram, samples };
}
