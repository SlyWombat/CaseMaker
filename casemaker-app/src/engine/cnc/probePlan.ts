/**
 * The probe planner (#188, decision 26, `/Fabrication.md` §7.3): derive the registration
 * plan from the part outline and how the part is held.
 *
 * THE POINT OF DECISION 26. The first question is not "which edges do we probe" but "how is
 * the part held?" — a badge in a printed nest, a plate under top clamps, a block in the
 * vise and a cylinder in the chuck are four different registration problems, and a
 * hand-written edge-find sequence is correct for exactly one of them. The app compiled the
 * part, so it knows the outline; given the workholding it can choose the surfaces itself.
 * There is a branch on `workholding.kind` in `datumOf` and again in `obstructionsOf`, and
 * none in the planning logic that consumes them — which is what lets all four cases fall out
 * of the same code with no per-case caller.
 *
 * PURE AND KERNEL-FREE. It needs the outline as polygons, not as a `Profile`: the boolean
 * and offset nodes (`p-union`, `p-difference`, `p-offset`, ...) need Clipper2, which lives in
 * the geometry worker. `outline` therefore accepts either already-evaluated `Polygons` or a
 * `Profile` from which the kernel-free subset can be recovered (`profilePolygons`). A
 * `roundedRect` is a `p-offset` and returns `null` — the caller evaluates it in the worker
 * and passes the polygons. Nothing here imports `Manifold`.
 *
 * WHAT IT DOES NOT DO: emit `G38.2`. A static `.nc` cannot carry a computed offset
 * (Smoothieware has no variables) and rotation compensation in one is impossible (§7.3, #187
 * item 1), so a mid-program probe→cutter swap is the `M490` handshake V1 defers. The plan is
 * therefore DATA: executable through Studio's dialogs today, emittable when the bridge lands.
 * The planner does not care which, which is exactly why it is pure.
 *
 * DECISION 28 follows through. What is obstructed is an input with provenance, never a
 * catalogue lookup: the vise's jaw *planes* are used because they are what the model carries,
 * while a clamp's footprint is taken from the object the caller built rather than from a
 * datasheet. Where a footprint cannot be resolved the planner says so in `notes` instead of
 * inventing one.
 */

import type { Profile } from '@/engine/compiler/profile';
import type { Mm, Vec2 } from '@/types/units';
import type { Polygons } from './cam/pocket';
import type { DatumSource, Workholding } from './setup';

const EPS = 1e-9;

/**
 * A touch's own repeatability: ball-contact scatter, mm. What is left after a touch.
 *
 * Still the 3D Probe's assumed figure for X, Y and Z. MEASURED 2026-10-08 for the WIRED probe in Z
 * only: five slow (F100) touches on the printed blank in the vise triggered within 0.001 mm of each
 * other, fast (F300) within 0.004 mm and 2–6 µm deep (`/Z1-Firmware-Dialect.md` §11.7, runbook C4).
 * 0.02 stays as the conservative value until the 3D Probe is measured the same way.
 */
export const PROBE_RESIDUAL_MM = 0.02;

/**
 * The chuck locates the axis. Its runout is the residual, mm. PROVISIONAL — an unverified
 * figure, the same standing as every stub until the bench measures it (#208).
 */
export const CHUCK_AXIS_RESIDUAL_MM = 0.05;

/**
 * A bracket seated on the anchor pins is repeatable to about this, mm. PROVISIONAL (#208 B1
 * owes the pin-to-face measurement); the datum exists because the geometry is, not because
 * the number is trustworthy.
 */
export const ANCHOR_BRACKET_RESIDUAL_MM = 0.05;

/** A vise's jaw squareness: the residual across the jaws, mm. PROVISIONAL (see above). */
export const VISE_JAW_RESIDUAL_MM = 0.05;

/** Flatness tolerance that collapses a run of vertices into one straight edge, mm. */
const DEFAULT_FLAT_TOL_MM = 0.02;

/** Segment count used to realise a `p-circle` outline, when it does not name its own. */
const DEFAULT_CIRCLE_SEGMENTS = 64;

/** The axes a probe can resolve. Z is not among them: it is always probed (§7.2). */
export type ProbeAxis = 'x' | 'y' | 'rotation';

export interface ProbeSpec {
  /** Probe ball/tip diameter, mm. Touch points are kept a radius clear of a corner. */
  tipDiameter: Mm;
  /**
   * The XY error the job can absorb, mm. An axis the fixture already holds within this is NOT
   * probed — the badge's nest leaves ±0.15 mm of seat clearance, which is invisible on
   * engraved text, so its plan is Z only (§7.3). Omit (or 0) to probe every axis the fixture
   * leaves open. A fixture's own residual is compared against this as a length; for rotation
   * that is the lateral slop it permits, not an angle.
   */
  toleranceMm?: Mm;
  /** A probe cannot usefully touch an edge shorter than this, mm. Default 2× tipDiameter. */
  minEdgeLength?: Mm;
  /** Flatness tolerance for reading a run of vertices as one straight edge, mm. */
  flatToleranceMm?: Mm;
}

/** The part, as the probe sees it: an XY outline, in the part's own frame. */
export interface ProbePart {
  /** Already-evaluated `Polygons`, or a `Profile` the kernel-free subset can recover. */
  outline: Profile | Polygons;
  /**
   * A cylinder's rotation about its axis is immaterial to the cut, so the planner never probes
   * it. Set for a `cylinder` part. This is the one place the part's *shape* changes the plan,
   * and it is stated rather than inferred.
   */
  axisymmetric?: boolean;
}

export interface ProbeTouch {
  /** The outline edge touched, its two endpoints in the part's own XY frame. */
  edge: [Vec2, Vec2];
  edgeLength: Mm;
  /** Where the tip goes, part frame. */
  at: Vec2;
  /**
   * What the edge tells us: a straight edge running along X is touched to learn Y (and, with
   * a second touch, rotation); one running along Y is touched to learn X.
   */
  reads: 'y' | 'x';
  /** What this touch resolves. A pair on one edge resolves rotation too. */
  fixes: ProbeAxis[];
  /** Why this edge was chosen, for the run sheet. */
  reason: string;
}

export interface ProbePlan {
  touches: ProbeTouch[];
  /** Always true. Z is probed on the engraved face whatever the fixture — no fixture gives it. */
  probeZ: true;
  /** What the fixture already establishes, before any touch. */
  datums: DatumSource[];
  /** XY residual left after the plan, mm. */
  residual: Mm;
  /** Rotation residual left after the plan, degrees. */
  rotationResidual: number;
  notes: string[];
}

export interface ProbeRefusal {
  refuse: true;
  /** `no-outline` — the outline needs the worker. `no-reachable-edge` — see `obstruction`. */
  code: 'no-outline' | 'no-reachable-edge';
  message: string;
  /** The fixture feature that blocked the plan, when one did (decision 28: it is named). */
  obstruction?: string;
}

export type ProbeResult = ProbePlan | ProbeRefusal;

// ---- Profile → polygons (the kernel-free subset) ----------------------------

/**
 * The polygon rings a `Profile` describes, or `null` when it needs Clipper2.
 *
 * Handles the constructors that are pure point maths: `p-poly`, `p-rect`, `p-circle`,
 * `p-translate`, `p-rotate`, `p-mirror`. The boolean and offset nodes (`p-union`,
 * `p-difference`, `p-intersection`, `p-offset`, `p-hull`) return `null` on purpose — this
 * module does not carry a geometry kernel, and a hand-rolled offset would be the very thing
 * `cam/pocket.ts` forbids. Evaluate those in the geometry worker and pass `Polygons`.
 */
export function profilePolygons(profile: Profile, circleSegments = DEFAULT_CIRCLE_SEGMENTS): Polygons | null {
  switch (profile.kind) {
    case 'p-poly':
      return profile.contours.map((ring) => ring.map(([x, y]) => [x, y] as Vec2));
    case 'p-rect': {
      const [w, h] = profile.size;
      const x0 = profile.center ? -w / 2 : 0;
      const y0 = profile.center ? -h / 2 : 0;
      return [[[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]];
    }
    case 'p-circle': {
      const n = Math.max(3, Math.round(profile.segments ?? circleSegments));
      const ring: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        ring.push([profile.radius * Math.cos(a), profile.radius * Math.sin(a)]);
      }
      return [ring];
    }
    case 'p-translate': {
      const child = profilePolygons(profile.child, circleSegments);
      const [dx, dy] = profile.offset;
      return child?.map((ring) => ring.map(([x, y]) => [x + dx, y + dy] as Vec2)) ?? null;
    }
    case 'p-rotate': {
      const child = profilePolygons(profile.child, circleSegments);
      if (!child) return null;
      const t = (profile.degrees * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      return child.map((ring) => ring.map(([x, y]) => [x * c - y * s, x * s + y * c] as Vec2));
    }
    case 'p-mirror': {
      const child = profilePolygons(profile.child, circleSegments);
      if (!child) return null;
      // Reflect across the line through the origin whose NORMAL is `normal`.
      const [nx, ny] = profile.normal;
      const len = Math.hypot(nx, ny) || 1;
      const ux = nx / len;
      const uy = ny / len;
      return child.map((ring) =>
        ring.map(([x, y]) => {
          const d = x * ux + y * uy;
          return [x - 2 * d * ux, y - 2 * d * uy] as Vec2;
        }),
      );
    }
    default:
      return null;
  }
}

// ---- Small 2D helpers -------------------------------------------------------

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 <= EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd across every ring, so a hole is not "inside" its own outline. */
function pointInPolygons(p: Vec2, polygons: Polygons): boolean {
  let inside = false;
  for (const ring of polygons) if (pointInRing(p, ring)) inside = !inside;
  return inside;
}

// ---- Straight edges ---------------------------------------------------------

/** One maximal straight run of a ring, as the probe sees it. */
interface Edge {
  a: Vec2;
  b: Vec2;
  length: Mm;
  /** Along X (|dx| ≥ |dy|) reads Y; along Y reads X. */
  reads: 'x' | 'y';
}

/** Every vertex between `i` and `j` lies within `tol` of the chord `pts[i] → pts[j]`. */
function allWithinChord(pts: readonly Vec2[], i: number, j: number, tol: number): boolean {
  for (let k = i + 1; k < j; k++) {
    if (pointSegmentDistance(pts[k]!, pts[i]!, pts[j]!) > tol) return false;
  }
  return true;
}

/**
 * An index whose vertex turns sharply enough to be a corner, or 0 when the ring has none.
 * Starting the walk at a corner keeps an edge from straddling the ring's seam and being
 * counted twice.
 */
function findCorner(ring: readonly Vec2[], tol: number): number {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n]!;
    const c = ring[i]!;
    const q = ring[(i + 1) % n]!;
    if (pointSegmentDistance(c, p, q) > tol) return i;
  }
  return 0;
}

/**
 * The maximal straight runs of one closed ring.
 *
 * A run is extended while every vertex stays within `flatTol` of its chord, so a rounded
 * corner is read as "the straight part ends here" without an R3.175 special case — the exact
 * consequence `/Fabrication.md` §7.3 asks for. Runs shorter than `minLength` are dropped,
 * which is also what discards the arc fragments a radius decomposes into.
 */
function straightEdges(ring: readonly Vec2[], flatTol: Mm, minLength: Mm): Edge[] {
  const n = ring.length;
  if (n < 3) return [];
  const start = findCorner(ring, flatTol);
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) pts.push(ring[(start + i) % n]!);
  pts.push(pts[0]!); // close it, so the walk below is linear

  const m = pts.length;
  const edges: Edge[] = [];
  let from = 0;
  while (from < m - 1) {
    let to = from + 1;
    while (to + 1 < m && allWithinChord(pts, from, to + 1, flatTol)) to++;
    const a = pts[from]!;
    const b = pts[to]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length >= minLength && length > EPS) {
      edges.push({ a, b, length, reads: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'y' : 'x' });
    }
    from = to;
  }
  return edges;
}

/** Where the tip goes on an edge: the clear span, at the given contacts. */
function touchPoints(edge: Edge, count: 1 | 2, tipR: number): Vec2[] {
  const inset = Math.min(tipR, edge.length / 2);
  const fractions = count === 1 ? [0.5] : [0.25, 0.75];
  return fractions.map((f) => {
    const t = Math.max(inset, Math.min(edge.length - inset, f * edge.length));
    const s = t / edge.length;
    return [edge.a[0] + (edge.b[0] - edge.a[0]) * s, edge.a[1] + (edge.b[1] - edge.a[1]) * s] as Vec2;
  });
}

// ---- What the fixture supplies, and what it blocks ---------------------------

/** A keep-out in the part frame. `test` covers shapes that are not polygons (a jaw plane). */
interface Obstruction {
  id: string;
  label: string;
  blocks: (p: Vec2) => boolean;
}

/** What the fixture already establishes, before any touch (§7.3's "datum candidates"). */
function datumOf(w: Workholding): DatumSource[] {
  switch (w.kind) {
    case 'anchor-bracket':
      // Seated against both faces of the L, so it fixes XY and squareness.
      return [{ fixes: ['x', 'y', 'rotation'], uncertainty: ANCHOR_BRACKET_RESIDUAL_MM }];
    case 'vise':
      // The fixed jaw is the LEFT jaw (#191): the part is referenced in X and rotation, and is
      // free to slide along the jaw in Y. Across the jaws the residual is jaw squareness.
      return [{ fixes: ['x', 'rotation'], uncertainty: VISE_JAW_RESIDUAL_MM }];
    case 'rotary-chuck':
      // The chuck locates the axis; rotation about an axis is not a datum it can give.
      return [{ fixes: ['x', 'y'], uncertainty: CHUCK_AXIS_RESIDUAL_MM }];
    case 'top-clamps':
      // Clamps push DOWN. They hold Z and give nothing in XY or rotation.
      return [];
    case 'tape-down':
      // Tape holds by friction along the whole underside: no XY reference at all.
      return [];
    case 'printed-nest':
      // The nest's pocket does not locate to precision — that is the inherent residual below,
      // not a datum.
      return [];
  }
}

/**
 * The residual a fixture leaves by construction, with no datum to name. The nest's pocket cut
 * at `+0.15` leaves ±0.15 mm of XY slop; that number is what makes the badge's plan Z-only.
 * Rotation's value is the lateral slop it permits, not an angle.
 */
function inherentResidual(w: Workholding): Partial<Record<ProbeAxis, Mm>> {
  if (w.kind === 'printed-nest') {
    const s = w.seatClearance;
    return { x: s, y: s, rotation: s };
  }
  return {};
}

/** The keep-outs the fixture puts over the part's own edges. */
function obstructionsOf(w: Workholding, notes: string[]): Obstruction[] {
  switch (w.kind) {
    case 'top-clamps':
      return w.clamps.map((clamp, i) => {
        const ring = profilePolygons(clamp.footprint);
        if (!ring) {
          notes.push(
            `clamp ${i + 1}'s footprint is a profile this kernel-free module cannot evaluate; ` +
              `its obstruction was NOT tested — pass the clamp a rectProfile or evaluated polygons`,
          );
        }
        return {
          id: `clamp-${i + 1}`,
          label: `clamp ${i + 1} at (${clamp.at[0]}, ${clamp.at[1]})`,
          blocks: ring ? (p: Vec2) => pointInPolygons(p, ring) : () => false,
        };
      });
    case 'vise':
      // Each jaw face carries the INWARD normal (the convention `Setup`'s stub uses), so the
      // jaw's material is the half-plane behind it: a negative signed distance is under the
      // jaw. The planes are what the model carries; decision 28 forbids substituting a
      // datasheet's jaw dimensions for them.
      return w.jawFaces.map((face, i) => ({
        id: `jaw-${i + 1}`,
        label: `vise jaw ${i + 1}`,
        blocks: (p: Vec2) =>
          (p[0] - face.origin[0]) * face.normal[0] + (p[1] - face.origin[1]) * face.normal[1] < 0,
      }));
    case 'anchor-bracket':
      notes.push(
        'the anchor bracket\'s footprint is not modelled (decision 28: measured, not catalogued); ' +
          'only its datum is used, so a face the bracket covers would not be rejected here',
      );
      return [];
    case 'rotary-chuck':
      notes.push('the chuck body outside the part\'s axial ends is not modelled; only its axis datum is used');
      return [];
    case 'printed-nest':
      notes.push(
        'the nest wall stands outside the part outline, so it does not block a touch on the ' +
          'part\'s own edges; its thickness is not modelled (decision 28)',
      );
      return [];
    case 'tape-down':
      return [];
  }
}

/**
 * The fixture features that stand in the way of a reachable surface, by label — the planner's
 * answer to "what is in the way", exported for callers that are not planning a touch (#272).
 * `sweep.ts` asks it, so the sweep's `fixture-unchecked` names what it cannot check instead of
 * keeping its own list of workholding kinds.
 *
 * An EMPTY LIST IS A REAL ANSWER, not a failure: nothing is above the part at all (`tape-down`),
 * or the body stands outside the part's own footprint (a nest wall, a chuck outside the axial
 * ends, an anchor bracket's unmodelled footprint). `notes` carries the same caveats
 * `planProbing` would put in a plan, so a footprint this kernel-free module cannot evaluate is
 * reported rather than silently dropped (decision 28).
 */
export function obstructionLabels(workholding: Workholding): { labels: string[]; notes: string[] } {
  const notes: string[] = [];
  return { labels: obstructionsOf(workholding, notes).map((o) => o.label), notes };
}

// ---- The planner ------------------------------------------------------------

type Pick = { edge: Edge; points: Vec2[] };

/** The first candidate edge whose touch points all clear the obstructions. */
function pickEdge(
  candidates: readonly Edge[],
  count: 1 | 2,
  tipR: number,
  obstructions: readonly Obstruction[],
  blocked: { by: Obstruction | null },
): Pick | null {
  for (const edge of candidates) {
    const points = touchPoints(edge, count, tipR);
    const blocker = points.map((p) => obstructions.find((o) => o.blocks(p))).find((o): o is Obstruction => !!o);
    if (!blocker) return { edge, points };
    blocked.by = blocked.by ?? blocker;
  }
  return null;
}

function bboxDiagonal(polygons: Polygons): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polygons) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0;
}

/**
 * Plan the registration for a part held this way.
 *
 * Returns a plan (possibly with no touches, when the fixture is already good enough) or a
 * refusal that names what is in the way. It never returns a touch point inside an obstruction
 * and never registers against something that is not a reference.
 */
export function planProbing(part: ProbePart, workholding: Workholding, probe: ProbeSpec): ProbeResult {
  const notes: string[] = [];
  const tipR = Math.max(probe.tipDiameter, 0) / 2;
  const flatTol = probe.flatToleranceMm ?? DEFAULT_FLAT_TOL_MM;
  const minEdge = probe.minEdgeLength ?? Math.max(2 * probe.tipDiameter, 2);
  const tolerance = probe.toleranceMm ?? 0;

  const polygons = Array.isArray(part.outline) ? part.outline : profilePolygons(part.outline);
  if (!polygons || polygons.length === 0) {
    return {
      refuse: true,
      code: 'no-outline',
      message:
        'no part outline to query: the outline needs a geometry kernel (a boolean or offset ' +
        'node), so evaluate it in the worker and pass Polygons',
    };
  }

  const datums = datumOf(workholding);
  const inherent = inherentResidual(workholding);
  const obstructions = obstructionsOf(workholding, notes);

  /** What is left on an axis before any touch: the best datum or inherent residual, else ∞. */
  const residualOf = (axis: ProbeAxis): Mm => {
    const fromDatums = datums.filter((d) => d.fixes.includes(axis)).map((d) => d.uncertainty);
    const fixed = fromDatums.length ? Math.min(...fromDatums) : Infinity;
    return Math.min(fixed, inherent[axis] ?? Infinity);
  };
  const needs = (axis: ProbeAxis): boolean =>
    !(axis === 'rotation' && part.axisymmetric) && residualOf(axis) > tolerance;

  const edges = polygons
    .flatMap((ring) => straightEdges(ring, flatTol, minEdge))
    .sort((a, b) => b.length - a.length);

  const touches: ProbeTouch[] = [];
  const resolved = new Set<ProbeAxis>();
  const blocked: { by: Obstruction | null } = { by: null };

  // 1. Rotation first, because it is the axis that forces a PAIR of touches and it settles the
  //    edge's own perpendicular axis for free (§7.3: two touches on one straight edge give
  //    position and rotation).
  if (needs('rotation')) {
    const pick = pickEdge(edges, 2, tipR, obstructions, blocked);
    if (pick) {
      const [p1, p2] = pick.points as [Vec2, Vec2];
      const fixes: ProbeAxis[] = [pick.edge.reads, 'rotation'];
      touches.push(
        { edge: [pick.edge.a, pick.edge.b], edgeLength: pick.edge.length, at: p1, reads: pick.edge.reads, fixes, reason: reasonFor(pick.edge, 2) },
        { edge: [pick.edge.a, pick.edge.b], edgeLength: pick.edge.length, at: p2, reads: pick.edge.reads, fixes: ['rotation'], reason: 'second touch on the same edge: rotation' },
      );
      resolved.add(pick.edge.reads);
      resolved.add('rotation');
      notes.push(
        'rotation is measured, and a static .nc cannot compensate it (Smoothieware has no ' +
          'variables, §7.3 / #187 item 1): apply it in Studio\'s dialogs, or re-post with the ' +
          'rotation baked into the geometry',
      );
    }
  }

  // 2. Whatever the pair above did not settle, one touch each.
  for (const axis of ['y', 'x'] as const) {
    if (!needs(axis) || resolved.has(axis)) continue;
    const pick = pickEdge(edges.filter((e) => e.reads === axis), 1, tipR, obstructions, blocked);
    if (pick) {
      touches.push({
        edge: [pick.edge.a, pick.edge.b],
        edgeLength: pick.edge.length,
        at: pick.points[0]!,
        reads: axis,
        fixes: [axis],
        reason: reasonFor(pick.edge, 1),
      });
      resolved.add(axis);
    }
  }

  const unresolved = (['x', 'y', 'rotation'] as ProbeAxis[]).filter((axis) => needs(axis) && !resolved.has(axis));
  if (unresolved.length) {
    const by = blocked.by;
    return {
      refuse: true,
      code: 'no-reachable-edge',
      message:
        `cannot resolve ${unresolved.join(' and ')}: no reachable straight edge is long enough ` +
        `(≥ ${minEdge.toFixed(2)} mm) and clear of the fixture` +
        (by ? ` — ${by.label} is in the way` : ''),
      ...(by ? { obstruction: by.label } : {}),
    };
  }

  const afterTouch = (axis: ProbeAxis): Mm => (resolved.has(axis) ? PROBE_RESIDUAL_MM : residualOf(axis));
  const residual = Math.max(afterTouch('x'), afterTouch('y'));
  const diagonal = bboxDiagonal(polygons);
  const rotationResidual = resolved.has('rotation')
    ? (Math.atan2(PROBE_RESIDUAL_MM, diagonal / 2) * 180) / Math.PI
    : 0;

  if (!touches.length) {
    notes.push(
      `every open axis is already held within the ${tolerance} mm the job tolerates (residual ` +
        `${fmt(residual)} mm) — no touch planned beyond Z`,
    );
  } else if (!needs('rotation')) {
    // The mechanical fix is the real de-risking of §7.3: it is what lets a static .nc work.
    notes.push('rotation is fixed mechanically by the fixture, so no compensation is needed (§7.3)');
  }
  notes.push('Z is always probed on the engraved face (§7.2): no fixture can supply it');

  return {
    touches,
    probeZ: true,
    datums,
    residual,
    rotationResidual,
    notes,
  };
}

function reasonFor(edge: Edge, count: 1 | 2): string {
  const what = count === 2 ? 'position and rotation' : edge.reads === 'y' ? 'Y' : 'X';
  return `longest reachable ${edge.reads === 'y' ? 'X-parallel' : 'Y-parallel'} edge (${edge.length.toFixed(1)} mm) gives ${what}`;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : 'unknown';
}
