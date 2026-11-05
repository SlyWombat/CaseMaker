/**
 * cam/model/ops/pocket.ts — §3.1 of `docs/design/cam-model-engine.md`.
 *
 * Z-level pocketing per recognised `PocketNode` (#958), largest flat that fits — uses the EXISTING
 * `pocketLoops` (`cam/pocket.ts:204`) unchanged for the 2D rings at each level; there is no new
 * pocketing math. What this file adds is the Z-level stepping and the ring→move conversion
 * `pocketLoops` itself does not do (it is deliberately kernel-free and 2D-only, returning rings,
 * not `CamMove[]`).
 *
 * The `offset` function is INJECTED, exactly as `pocketLoops` itself requires (`cam/pocket.ts`'s own
 * header: "Do NOT write polygon offsetting by hand" — the real one is Clipper2's `CrossSection.offset`,
 * built once by the caller; this file's own tests use a trivial fake, the same pattern `pocket.ts`'s
 * own tests use).
 *
 * Linking: EVERY move between one ring/level and the next — same-level ring-to-ring as much as
 * level-to-level — goes through #962's `link()` (A's review 6622610124, finding 1): a plain feed
 * from one ring's exit to the next ring's start is only safe when `pocketLoops`' own "ring i+1
 * lies one step-over inside ring i" holds for a SIMPLE nested region, and it does not for a
 * pocket with an island between the two rings, or a region whose erosion has split into separate
 * lobes — either gouges the island or cuts across the wall between lobes. The `MaterialField` this
 * op builds is a global one, not a per-ring one: `topAt(x, y)` reports the floor Z anywhere inside
 * `freeSpace` (`node.region` eroded by the cutter radius, less a 0.01 mm chord grace — the same
 * free space A's `pocketRedFirst959.spec.ts` checks the moves against) and "never cut" everywhere
 * else, so `link()` feeds through material this op WILL remove and retracts around anything it
 * will not (an island, the wall between lobes, open air outside the node). `link()`'s own
 * `retract()` is also what fixes the diagonal rapid-from-depth this file used to emit on every
 * level change (straight up, across, straight down — never X/Y/Z together below the safe plane).
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import { estimateCycleSeconds } from '@/engine/cnc/cam/ir';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';
import { pocketLoops, type OffsetFn, type Polygons } from '@/engine/cnc/cam/pocket';
import { tourNearest } from '@/engine/cnc/cam/tour';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';
import { link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { cutterKeyOf } from '../sequence';
import type { PocketNode } from '../features';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';
import { dropCutterHeight, type CutterProfile, type DropCutterMesh } from '../dropcutter';
import { maskLoopsFromPredicate } from './rasterMask';

export interface PocketOpOptions {
  cutter: Tool;
  node: PocketNode;
  region: RegionRef;
  /** mm; the rings' own spacing within one level. */
  stepOverMm: number;
  /** mm; the Z distance between depth passes. The last pass is shorter when it does not divide evenly. */
  stepDownMm: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  /** The real Clipper2 offset, or a test fake — `pocketLoops`' own contract, unchanged. */
  offset: OffsetFn;
  safeZMm: number;
  hopZMm: number;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  rapid: RapidEstimate;
  /** Where the tool starts, for the first ring's tour — the work origin by default. */
  startFrom?: readonly [number, number];
  /**
   * For an OPEN node only (A's review 6622610124, finding 3): the part's own outer outline
   * (`FeatureTree.contour.outline`) and a boolean pair to extend `node.region` across its open
   * edge before `pocketLoops` ever sees it — otherwise the open boundary is offset inward like a
   * real wall, this cutter's radius never reaches the true edge, and `pocketLoops` can throw on a
   * ledge narrower than the cutter. Absent on a non-open node; absent here on an open one leaves
   * the old (unextended) behaviour, stated by the caller, not silently assumed.
   */
  openOutline?: Polygons;
  boolean?: { union: BooleanFn; subtract: BooleanFn };
  /**
   * #966 — the real design mesh, ALREADY ROTATED into this setup's own frame (the SAME one
   * `recogniseFeatures` built `node` from — `plan.ts`'s own `curvedGeometry`/`rotatedGeometryFor`,
   * the same mesh `oppositeSurfaceSafeDepthMm`/`rough()`'s `clSurface` already read for the
   * identical reason: the ground truth for "what is really there," not a second source).
   *
   * `node.region` states "cleared area at `floorZ`" (its own doc on `features.ts`) ONLY — reused
   * UNMODIFIED at every Z level from `mouthZ` down to `floorZ`, it says nothing about a remainder
   * surface (an organic overhang with no floor patch of its own to register a sibling `PocketNode`
   * and correct `mouthZ` down for it) closing back over the SAME XY footprint at a higher Z. This
   * is #966's exact finding: a ⌀6 flat planned straight through ~22 mm of solid body between two
   * of the elephant's legs, because the belly closing the gap above `floorZ` was never checked —
   * `tree.ts`'s own parent-correction of `mouthZ` only ever fires for a SIBLING floor-patch node,
   * never for a curved/organic surface with no floor of its own.
   *
   * With this set, EVERY level this op steps (and the `open`/linking field below) is bounded by
   * the real per-column ceiling, read with a ZERO-RADIUS point probe (`dropcutter.ts`, #957) —
   * never this op's own cutter radius; see the implementation's own note on why a real-radius
   * probe double-counts a node's own walls (already handled by the 2D erosion every region
   * boundary gets) as a false shadow. Never less safe than `node.region` alone, only ever MORE
   * restrictive. Absent → the pre-#966 behaviour, unchanged: no existing call site/test passes
   * this, so nothing already passing is affected.
   */
  aboveMaterial?: {
    mesh: DropCutterMesh;
    marginMm?: number;
    /**
     * `mesh`'s triangles sit on the mesh's own absolute Z axis; `node.floorZ`/`mouthZ` (every
     * caller in `plan.ts` already rebases them onto `Z 0 = stock top` — that file's own header
     * note) do not. Added back onto a level's `z` before it is compared against the mesh's own
     * drop-cutter height — `meshAbsoluteZ = z + zOffsetMm`. Absent → 0: a direct caller (a unit
     * test, or any future one) that hands `node` mesh-absolute Z values unchanged needs no offset.
     */
    zOffsetMm?: number;
  };
}

/** The Z passes from the node's mouth down to its floor, each `stepDownMm` apart (the last one shorter, never longer). */
function depthPasses(mouthZ: number, floorZ: number, stepDownMm: number): number[] {
  const total = mouthZ - floorZ;
  if (!(total > 0)) return [floorZ];
  const count = Math.ceil(total / stepDownMm);
  const levels: number[] = [];
  for (let i = 1; i <= count; i++) {
    levels.push(i === count ? floorZ : mouthZ - i * stepDownMm);
  }
  return levels;
}

/** One closed ring's own cutting moves, NOT including how the tool arrives at its start — the caller (`pocket`) decides that: a plunge for the first ring of a level, a plain feed from the previous ring's exit otherwise. */
function traceRing(ring: readonly [number, number][], z: number, feedMmPerMin: number): ToolpathIR['operations'][number]['moves'] {
  const start = ring[0]!;
  const moves: ToolpathIR['operations'][number]['moves'] = [];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: feedMmPerMin });
  }
  // Close the ring back to its own start.
  moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: feedMmPerMin });
  return moves;
}

/**
 * Rings in a deterministic, short-travel order (#487's tour) — WITHIN one offset step only. Tour
 * ordering ACROSS steps would interleave inner and outer rings and turn some of them into
 * full-width slots (ring i+1 is only safe to feed into directly when it is truly one step-over
 * inside ring i, which only holds within a single `pocketLoops` offset step).
 *
 * `from` is wherever the tool actually is before this step starts (the manager's own follow-up
 * to the per-ring rotation above) — `tourNearest`'s own default of `[0, 0]` ignored it, so a
 * multi-lobe step (several disconnected rings at the same offset, common on the organizer) could
 * visit its FARTHEST ring first and its nearest one last, however good the per-ring entry seam
 * then is.
 */
function orderedRings(loops: readonly [number, number][][], from: readonly [number, number]): [number, number][][] {
  if (loops.length <= 1) return loops as [number, number][][];
  const points = loops.map((r) => r[0]! as readonly [number, number]);
  return tourNearest(points, from).map((i) => loops[i]!);
}

/** Index of `ring`'s vertex nearest `target`; ties to the lower index — same rule `tour.ts`
 * itself uses, so the same input always rotates the same way. */
function nearestVertexIndex(ring: readonly [number, number][], target: readonly [number, number]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i]!;
    const distance = (x - target[0]) ** 2 + (y - target[1]) ** 2;
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * `ring`, rotated so its own vertex nearest `target` is first — same points, same winding, just a
 * different seam. The manager's own named lever toward Makera's 5.9 rapids/1,000: `ring[0]` used
 * to be whichever vertex Clipper happened to emit first, so a same-level or level-change link into
 * this ring often had most of its own perimeter to cross before `link()` even got a choice between
 * a short hop and a retract — the SAME pattern `engraveJob.ts`'s own `entryOn` already fixed for
 * engrave regions (no reversal here: a pocket ring's winding is already the cutting one).
 */
function rotatedToEntry(ring: readonly [number, number][], target: readonly [number, number]): [number, number][] {
  const start = nearestVertexIndex(ring, target);
  return start === 0 ? (ring as [number, number][]) : [...ring.slice(start), ...ring.slice(0, start)];
}

/**
 * What a round tool of radius `toolRadius`, centred ANYWHERE inside `node.region`'s valid
 * centre-space, can ever reach — `dilate(erode(region, r), r)`, the morphological OPENING (A's
 * review 6622610124, finding 5). `region \ erode(region, D)` (the old formula) overclaims a SHARP
 * convex corner: polygon erosion does not round a convex corner, so the "frame" between the true
 * boundary and ANY eroded copy fills the corner's full square wedge, when a round tool can only
 * ever reach the OPENING's rounded profile there, leaving `r² − πr²/4` per corner permanently
 * uncut, however many rings are cut. Computed once per op: it does not depend on progress.
 */
function fullyReachable(region: Polygons, offset: OffsetFn, toolRadius: number): Polygons {
  return offset(offset(region, -toolRadius), toolRadius);
}

/**
 * The region cleared once the tool has traced out to `depthMm` from the true boundary — a
 * CONSERVATIVE account (never claims more cleared than is certain): `open` (the opening, finding
 * 5's fix) with whatever is still uncut at `depthMm` subtracted as a hole. `offset(region,
 * -depthMm)` returning nothing means `open` itself is fully reached; otherwise the hole is always
 * a subset of `open` (eroding further only shrinks it), so subtracting it is always consistent.
 */
function clearedToDepth(open: Polygons, region: Polygons, offset: OffsetFn, depthMm: number): Polygons {
  const uncut = offset(region, -depthMm);
  if (uncut.length === 0) return open;
  return [...open, ...uncut.map((ring) => [...ring].reverse())];
}

export function pocket(opts: PocketOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/pocket: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const levels = depthPasses(opts.node.mouthZ, opts.node.floorZ, opts.stepDownMm);

  // A's review 6622610124, finding 3: an OPEN node's own boundary at its open edge is not a real
  // wall — `pocketLoops` must not stand this cutter off it. Extending the region across that edge,
  // with a real boolean (never a hand-rolled one), lets the inward offset reach exactly to the
  // true edge there, same as the contour will cut it; the overshoot past the true edge is air,
  // removed by the contour op regardless. The extension must be STRICTLY more than the tool
  // radius: eroding by exactly `r` the same amount it was extended leaves the fake outer boundary
  // at the true edge with zero margin (degenerate — a ledge exactly `r` wide swept barely at all);
  // `2r` leaves a real margin whatever the ledge's own width, so only the node's OTHER (real)
  // walls end up deciding what the cutter can reach. The raw band runs the WHOLE outline's open
  // edge, not just this node's own stretch of it (advisor's review on dd150a9b) — clipped to
  // `near` (the node's own footprint, grown by the same 2r) before it is unioned in, or every
  // OTHER open node on the part gets this one's band too.
  // The open-edge extension band alone (undefined when this node is not open) — reused below,
  // unchanged, both to build `region` and (#970 FOLLOW-UP 2's own doc further down) to keep the
  // shadow check's own wall erosion from eating into it: an OPEN edge is never a real wall, so
  // unlike `opts.node.region`'s own true walls there is nothing there to double-count.
  const openExtensionBand: Polygons | undefined =
    opts.node.open && opts.openOutline !== undefined && opts.boolean !== undefined
      ? (() => {
          const wholeBand = opts.boolean.subtract(opts.offset(opts.openOutline, 2 * toolRadius), opts.openOutline);
          const near = opts.offset(opts.node.region, 2 * toolRadius);
          // A ∩ B = A \ (A \ B) — the only intersection `union`/`subtract` alone can express.
          return opts.boolean.subtract(wholeBand, opts.boolean.subtract(wholeBand, near));
        })()
      : undefined;
  const region = openExtensionBand === undefined ? opts.node.region : opts.boolean!.union(opts.node.region, openExtensionBand);

  // #966 — THE SHADOW CHECK (`PocketOpOptions.aboveMaterial`'s own doc above): a column's real
  // "ceiling" is Z-INDEPENDENT — sampled ONCE here on a grid, never re-queried per level, exactly
  // `rough()`'s own `clSurface` reuse (that op's header: the CL surface does not depend on the
  // current level either). `ceilingMaskAt` then stitches THIS level's own "nothing solid above
  // here" rectilinear mask from that one grid, cheaply, same geometry `rough()`'s `maskLoops`
  // already proved — only the inside rule differs (`rasterMask.ts`'s own header).
  //
  // THE PROBE IS A ZERO-RADIUS POINT, NEVER this op's own cutter radius — found the hard way
  // (this branch's own full regression run: `curvedOpsProperty959.spec.ts`'s sloped/filletedFloor
  // fixtures regressed from ~98% down to ~87-94% the first time this used `profileOf(opts.cutter)`):
  // `dropCutterHeight`'s own real-radius profile is
  // CORRECT for `oppositeSurfaceSafeDepthMm`/`rough()`'s `clSurface` because THOSE checks have no
  // other account of the tool's own body — but `pocket()` already has one, the 2D morphological
  // erosion/opening `fullyReachable`/`pocketLoops` apply to every region boundary, THIS node's own
  // walls included. A node's own vertical wall, queried with the real tool radius, reads back the
  // WALL's own full height everywhere within one radius of it (a vertical facet's points span
  // every Z from floor to top, all within reach) — exactly the node's own, ALREADY-handled
  // boundary, now double-counted as a false "shadow" band running the whole way round every
  // pocket. A zero-radius point probe only ever sees whatever is EXACTLY on the vertical line
  // through (x, y) — a genuine overhang from an unrelated feature (the belly, the slab) still
  // reads back correctly (its triangles DO sit exactly over that column), while a nearby wall,
  // whose own XY projection is degenerate (zero area) and essentially never meets a sampled grid
  // point exactly, is correctly invisible here — left entirely to the existing 2D erosion to keep
  // the tool's real body off it, as it always has.
  //
  // The grid is judged by the MAX of each cell's centre and four corners (finding the real top
  // surface — the worse/higher side — never the low one, the same conservative convention
  // `rough()`'s own sampling uses), at the SAME pitch `rough()` derives from step-over/radius.
  // Cells with no triangle at all directly above them (open air, nothing to obstruct) are seeded
  // at `Number.NEGATIVE_INFINITY`, not left unset — `rough()`'s own `Number.isFinite` guard exists
  // because ITS grid only ever samples points already known to be inside a recognised region; this
  // grid spans the WHOLE mesh's bbox near the node, where "no triangle found" simply means
  // "nothing above, always open," not "no information."
  const POINT_PROFILE: CutterProfile = { radiusMm: 0, flatRadiusMm: 0, kind: 'flat' };
  let ceilingMaskAt: ((levelZ: number) => Polygons) | null = null;
  if (opts.aboveMaterial !== undefined) {
    const marginMm = opts.aboveMaterial.marginMm ?? ARC_CHORD_TOLERANCE_MM;
    const zOffsetMm = opts.aboveMaterial.zOffsetMm ?? 0;
    const mesh = opts.aboveMaterial.mesh;
    // #970 FOLLOW-UP 2 (the tray/organizer real-part regression, found by E's T3 run on
    // 966-pocket-shadow@7f915ce0 after the margin-sign fix above — real reference parts, no
    // overhang, lost 1.10/0.62 coverage points): "a sample is only judged when it falls genuinely
    // inside `region`" is not enough on its own. A DRAFTED (non-vertical) wall, unlike a plain
    // vertical one, has real non-degenerate XY extent at every height along its own slope — so a
    // zero-radius probe sampled well inside `region` but near this SAME node's own wall still
    // legitimately hits that wall's own higher reaches (confirmed directly: the tray's own
    // tool-slot walls, probed at points sitting exactly on `region`'s own boundary, read the
    // slot's TOP LAND 6 mm above the slot's floor — the node's own wall, already kept off by the
    // ordinary 2D erosion `fullyReachable`/`pocketLoops` apply below, double-counted a second time
    // as an external shadow). The fillet case above is the SAME class of bug with a curved wall in
    // place of a flat drafted one — "real XY extent at every height" fits both.
    //
    // THE FIX: judge a sample against `opts.node.region` eroded by this op's own cutter radius
    // ALONE — where the cutter's CENTRE can ever be, not `fullyReachable`'s opening (erode THEN
    // dilate back out). `fullyReachable` is the wrong shape for this: along a straight wall the
    // dilate step restores the boundary to the true wall again (a round tool's own EDGE still
    // reaches a straight wall exactly, which is the whole point of `fullyReachable` everywhere
    // else it is used in this file) — so it supplied no margin there at all, confirmed directly
    // against the tray (a reduction from ~3.4 % lost to ~2.9 %, not the fix). The plain erosion
    // has no such dilate-back step: it is strictly smaller near every wall, by exactly
    // `toolRadius`, everywhere, matching where the tool's centre can really stand while its OWN
    // edge is what the existing 2D erosion (`fullyReachable`/`pocketLoops`, below and in
    // `rough.ts`) already keeps off the wall — so a wall/draft/fillet/rim/scoop within one radius
    // of the node's own TRUE boundary is correctly excluded from ever being read as a "ceiling"
    // at all here, the SAME geometry already accounted for, not a second, independent obstruction.
    //
    // Eroding `opts.node.region` wholesale is not quite right either, found the hard way: an OPEN
    // edge is not a real wall at all (the whole reason it was extended above) — there is nothing
    // there to double-count, and the real design mesh genuinely can (and for an open shoulder,
    // routinely does — `pocketShadow966.spec.ts`'s own table slab, whose top closes the gap right
    // out to the part's true outer edge) carry real overhang material out to and past that edge.
    // A first attempt re-added `openExtensionBand` AFTER eroding `opts.node.region` wholesale, but
    // that still blinded a toolRadius-wide band of real, judgeable floor just INSIDE the true open
    // edge near a CONVEX corner (the extension band's own rounded corner, built from `openOutline`
    // directly, does not line up with `node.region`'s own independently-rounded eroded corner
    // there) — so the fix is keyed off `openOutline` itself, not reconstructed from two separately
    // offset shapes: anything within `toolRadius` of the TRUE open edge (`openOutline`, never the
    // 2r-extended one) is restored regardless of what eroding `node.region`'s OTHER, REAL walls
    // did to it, since there is no wall there in the first place.
    // `pocketShadow966.spec.ts`'s existing cases, both the slab (a real overhang, including right
    // at and past its own open corners) and the open-no-slab fixture (no overhang at all,
    // including at its own corners), are the regression guard for this exact edge case.
    const trueWallSafe = opts.offset(opts.node.region, -toolRadius);
    const reachableDomain =
      openExtensionBand === undefined
        ? trueWallSafe
        : (() => {
            // The toolRadius-wide ring just inside the TRUE open outline (the outline itself less
            // its own erosion) — never a real wall, however `node.region`'s OTHER walls round a
            // nearby corner, so never eroded away. A ∩ B = A \ (A \ B), `union`/`subtract`'s own
            // only way to express an intersection.
            const nearTrueEdgeRing = opts.boolean!.subtract(opts.openOutline!, opts.offset(opts.openOutline!, -toolRadius));
            const nearTrueEdgeInRegion = opts.boolean!.subtract(opts.node.region, opts.boolean!.subtract(opts.node.region, nearTrueEdgeRing));
            return opts.boolean!.union(opts.boolean!.union(trueWallSafe, openExtensionBand), nearTrueEdgeInRegion);
          })();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of region) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (Number.isFinite(minX) && maxX > minX && maxY > minY) {
      const pitch = Math.min(0.5, Math.max(0.1, Math.min(opts.stepOverMm, toolRadius) / 4));
      const nx = Math.max(2, Math.floor((maxX - minX) / pitch + 1e-9) + 1);
      const ny = Math.max(2, Math.floor((maxY - minY) / pitch + 1e-9) + 1);
      const ceiling = new Float64Array(nx * ny).fill(Number.NEGATIVE_INFINITY);
      const half = pitch / 2;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = minX + i * pitch;
          const y = minY + j * pitch;
          let hi = Number.NEGATIVE_INFINITY;
          for (const [dx, dy] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]] as const) {
            const sx = x + dx;
            const sy = y + dy;
            // A sample is only judged when it falls inside `reachableDomain` (`region` eroded then
            // dilated by this op's own cutter radius, FOLLOW-UP 2's own doc above) — never WHICH
            // node it came from, only where it actually is, and never any closer to a wall than the
            // cutter can ever really be centred: `reachableDomain` is EVERY node this op may
            // legally stand on, closed-node extension and all, less one cutter radius at the true
            // boundary, so this never excludes a sample a real overhang legitimately needs caught,
            // only one that is this node's own, already-accounted-for wall/draft/fillet/rim.
            if (!pointInPolygons(reachableDomain, sx, sy)) continue;
            const h = dropCutterHeight(POINT_PROFILE, mesh, sx, sy);
            if (h !== null && h > hi) hi = h;
          }
          ceiling[j * nx + i] = hi;
        }
      }
      // `ceiling` is sampled in the MESH's own absolute Z; `levelZ` arrives in whatever frame
      // the caller's `node.floorZ`/`mouthZ` are already in (stock-top-relative, from every real
      // `plan.ts` call site) — `zOffsetMm`'s own doc above. Converting the mesh-absolute ceiling
      // into the LEVEL's frame (subtracting `zOffsetMm`), rather than the other way around, keeps
      // the comparison in whichever frame the caller actually posts moves in.
      //
      // #970 FOLLOW-UP (found by tracing, not assumed, after Session A's independent re-check of
      // this op's own full regression run flagged `curvedOpsProperty959.spec.ts`'s coverage drop
      // as a real bug rather than fixture noise): `ceiling` at a point genuinely INSIDE this
      // node's own floor, with nothing real above it, reads back that floor's OWN height — there
      // is nothing else solid along that vertical line in the FINISHED design mesh to find; the
      // floor itself is the only triangle a downward probe ever hits there. The predicate used to
      // read `ceiling + marginMm < levelZ`, i.e. "safe only when the ceiling sits a whole margin
      // BELOW this level" — at a node's own LAST level (`depthPasses`' own guarantee: the final
      // entry is always exactly `floorZ`), that demands `floorZ + marginMm < floorZ`, false for
      // any positive margin, so the deepest pass excluded its OWN floor's entire interior,
      // everywhere, confirmed directly (a debug count on the synthetic "open gap, no slab"
      // fixture: 37 053 of 37 249 grid cells included at every intermediate level, 13 444 — only
      // the cells already outside the 2D region — at the final one). Two real, reproduced cases:
      // an isolated floor near another feature (`pocketShadow966.spec.ts`'s own "#970 over-clip"
      // case) and a nested parent/child floor-patch pair (`pocketShadowNestedFloor966.spec.ts`,
      // the shelf/well case) both hit this independently, since `plan.ts`'s `allPockets` plans
      // every node as its own `pocket()` call.
      //
      // THE FIX: give the margin BACK to the level instead of taking it from the ceiling —
      // `ceiling - zOffsetMm - marginMm < levelZ`, i.e. "safe unless the ceiling sits a margin's
      // width or more ABOVE this level." At a node's own floor (`ceiling === levelZ` exactly),
      // `floorZ - marginMm < floorZ` is true for any positive margin, so the node's own floor
      // correctly includes itself. A real overhang (the elephant's belly, this file's own slab)
      // still excludes every level at or below its own underside: `ceiling` there is well ABOVE
      // `levelZ - marginMm` for every level down to and including the node's own (unreachable)
      // floor, so `pocketShadow966.spec.ts`'s existing "fixed" and "red-first" cases (the slab
      // case) are unaffected — this only ever widens the margin IN THE SAME DIRECTION it already
      // favoured (toward cutting a genuine floor, never toward cutting past a real obstruction).
      ceilingMaskAt = (levelZ: number): Polygons =>
        maskLoopsFromPredicate(
          nx,
          ny,
          minX,
          minY,
          pitch,
          (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && ceiling[j * nx + i]! - zOffsetMm - marginMm < levelZ,
        );
    }
  }

  /** `region ∩ mask` — the same `A \ (A \ B)` trick the open-node extension above already uses;
   * requires a real boolean, same contract as that extension (stated by the caller, never assumed). */
  const intersectWithRegion = (mask: Polygons): Polygons => {
    if (opts.boolean === undefined) {
      throw new Error('cam/model/ops/pocket: aboveMaterial needs a real boolean (union/subtract) to apply the #966 shadow mask');
    }
    return opts.boolean.subtract(region, opts.boolean.subtract(region, mask));
  };

  // The GLOBALLY safe region — reachable all the way to `floorZ`, the most restrictive of every
  // level's own mask (the masks are NESTED: as `z` drops, fewer columns still satisfy "ceiling
  // below z", never more) — is what `open`/the linking field below are built from, so neither ever
  // claims a column is cleared to `floorZ` when a shadow stopped it short.
  const floorSafeRegion = ceilingMaskAt === null ? region : intersectWithRegion(ceilingMaskAt(opts.node.floorZ));

  const open = fullyReachable(floorSafeRegion, opts.offset, toolRadius);

  // A's review 6622610124, finding 1: the free space EVERY same-level or level-to-level link must
  // stay inside is `open` (finding 5's own reachable area), NOT a second erosion of `region` —
  // `linkIsClear` already tests the whole cutter disc against this field, and a disc centred at
  // `region` eroded once more only fits when its CENTRE is eroded a second time (advisor's review
  // on dd150a9b): `erode(open, r) = erode(region, r)` (opening is idempotent), so testing the disc
  // against `open` is exactly A's own centre-line criterion, not a stricter one that forces a
  // retract on nearly every transition. A point outside `open` (an island, the wall between two
  // lobes, open air outside the node) is reported as never cut, so `link()` retracts around it.
  const material: MaterialField = {
    topAt: (x, y) => (pointInPolygons(open, x, y) ? opts.node.floorZ : Number.POSITIVE_INFINITY),
  };
  const linkOptions: LinkOptions = {
    material,
    // The REGION's own clearance plane (already above every obstacle IN this region), not the
    // program-wide `safeZMm` — `RegionRef.regionClearanceZ`'s own doc in `plan.ts` draws this
    // line; advisor's review on dd150a9b caught the two being swapped here.
    clearanceZ: opts.region.regionClearanceZ,
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
    hopClearanceMm: opts.hopZMm,
  };

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];

  // Tracks where the tool actually is, so a link is only asked for from the SECOND ring/level
  // onward — the very first ring of the whole op has no "from" position, just its own plunge.
  let prevExit: [number, number, number] | null = null;

  // Wherever the tool actually is right now — `opts.startFrom` (the work origin by default)
  // before the very first ring of the whole op, the previous ring's own exit (always its own
  // entry — it closes on itself) after that. Shared by the step tour (which ring to visit next)
  // and the per-ring entry rotation (where in that ring to start) below.
  const comingFrom = (): readonly [number, number] => (prevExit === null ? (opts.startFrom ?? [0, 0]) : [prevExit[0], prevExit[1]]);

  for (const z of levels) {
    // #966 — THIS level's own true cuttable area: `region`, further restricted to wherever the
    // real ceiling (sampled once, above) is below `z` — the masks are nested (a shallower level's
    // mask is a SUPERSET of every deeper one's), so a column whose own ceiling sits between
    // `floorZ` and `mouthZ` is still correctly cut down to it, then excluded from every level past
    // that, never cut deeper than its own real obstruction allows.
    const levelRegion = ceilingMaskAt === null ? region : intersectWithRegion(ceilingMaskAt(z));
    const steps = pocketLoops(levelRegion, toolRadius, opts.stepOverMm, opts.offset);
    for (const [stepIndex, step] of steps.entries()) {
      const loops = orderedRings(step, comingFrom());
      for (const loop of loops) {
        // This is the lever toward Makera's own rapids/1,000: `ring[0]` used to be whichever
        // vertex Clipper happened to emit first, so the link into this ring often had most of its
        // own perimeter to cross before `link()` ever got a choice between a short hop and a
        // retract.
        const ring = rotatedToEntry(loop, comingFrom());
        const start = ring[0]!;
        if (prevExit === null) {
          // The very first ring of the whole op: rapid up, then plunge down.
          moves.push({ kind: 'rapid', x: start[0], y: start[1], z: opts.hopZMm });
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        } else if (prevExit[2] === z) {
          // Same level: `open`'s own field is accurate everywhere on it (the whole op's footprint
          // is the same at every Z), so `link()` alone decides feed vs. retract.
          const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
          const to: LinkPoint = { x: start[0], y: start[1], z };
          moves.push(...link(from, to, linkOptions));
        } else {
          // A level change (advisor's review on 9e976f0b): `open` reports every point in the
          // node's footprint as reachable, with no notion of "not yet, at THIS depth" — handing
          // `link()` the full 3D jump lets its short-hop branch read a same-XY descent as a clear
          // feed at the CUTTING rate, a plunge/ramp with no plunge feed at all. The horizontal
          // part of the move is linked at the level JUST FINISHED, where `open` is honestly
          // accurate (everything in it has actually been swept by now); the vertical part is
          // always a plain feed at plungeFeed, never left to `link()`'s own feed rate.
          const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
          const landing: LinkPoint = { x: start[0], y: start[1], z: prevExit[2] };
          moves.push(...link(from, landing, linkOptions));
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        }
        moves.push(...traceRing(ring, z, opts.feeds.feedMmPerMin));
        const entry: [number, number, number] = [start[0], start[1], z];
        prevExit = entry; // the ring closes back to its own start
        // `toolRadius + stepIndex * stepOverMm` is this step's own offset from the true boundary
        // (pocketLoops' own convention); clearedToDepth adds the tool's own radius again, since
        // that is how far out the tool has actually swept once its centre reaches this step's path.
        const depthMm = toolRadius + stepIndex * opts.stepOverMm + toolRadius;
        passes.push({ z, boundary: [ring as [number, number][]], cleared: { z, boundary: clearedToDepth(open, region, opts.offset, depthMm) }, entry, exit: entry });
      }
    }
    const finalDepthMm = toolRadius + Math.max(0, steps.length - 1) * opts.stepOverMm + toolRadius;
    cleared.push({ z, boundary: clearedToDepth(open, region, opts.offset, finalDepthMm) });
  }

  // Every op leaves the tool at a safe height when it ends: a straight retract at the LAST XY
  // (no lateral travel below the safe plane), matching `generateProfile`'s own final move — the
  // next op, concatenated onto this one (`concatToolpathIR`), starts from a safe state, not depth.
  const lastMove = moves[moves.length - 1];
  if (lastMove) moves.push({ kind: 'rapid', x: lastMove.x, y: lastMove.y, z: opts.safeZMm });

  const ir: ToolpathIR = {
    frame: 'flat',
    tool: opts.cutter,
    toolNumber: opts.toolNumber,
    spindleRpm: opts.spindleRpm,
    air: opts.air,
    safeZ: opts.safeZMm,
    hopZ: opts.hopZMm,
    operations: [
      {
        number: 1,
        name: `[T${opts.toolNumber}] Pocket "${opts.node.id}"`,
        labelId: opts.node.id,
        depth: opts.node.mouthZ - opts.node.floorZ,
        depthPasses: levels.length,
        passStepMm: opts.stepDownMm,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };

  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}
