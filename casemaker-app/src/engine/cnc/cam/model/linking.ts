/**
 * cam/model/linking.ts — stay-down linking (#962, C), and the shared op/material contract every
 * op in `cam/model/ops/` and `cam/model/sequence.ts` builds against (#956's design note, #956 issue
 * comment 6619787259, C; §3.0.1 of `docs/design/cam-model-engine.md`).
 *
 * `tour.ts` is ordering only (`nearestNeighbourOrder`/`twoOptOrder`/`tourNearest`) — no clearance-plane
 * or stay-down concept. This module is that concept: one pure `link()`, called by every rough/finish
 * op alike, so #961's price and #962's own moves cannot diverge.
 *
 * Five deviations from C's literal comment, flagged there for C to confirm, not silently assumed:
 * `ObstacleBox[]` (existing type) in place of a new `Box3[]`; `MaterialState` methods in place of
 * free functions (a free function would need mutable global state, which breaks the moment two
 * candidate sequences are priced side by side); `stayDownClearanceMm`/`retractClearanceMm` as this
 * note's own tentative names for "the two clearance heights"; `PassRef`'s consumer left unnamed
 * rather than invented; `Vec3` (existing, `@/types/units`) in place of a new `Point3`.
 */

import type { Vec2, Vec3 } from '@/types/units';
import type { Tool } from '@/engine/cnc/tool';
import type { ObstacleBox } from '@/engine/cnc/setup';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';

/** One ring (outer boundary or a hole); `pocket.ts`'s `Polygons` is `Polygon[]`. NEW — no existing equivalent. */
export type Polygon = [number, number][];

/** NEW — no existing equivalent. */
export interface Box2 {
  min: [number, number];
  max: [number, number];
}

/**
 * Every op generator returns one of these (C's point 1). `cutter` is a ToolKey — no such type exists
 * yet (`roughToolKey?: string`, `types/engraveJob.ts:770`), so this is a bare `string`, not invented.
 */
export interface OpOutcome {
  ir: ToolpathIR;
  /** What the op removed, per depth — the material state's input. Absent for an op that removes nothing new (a rim's chamfer over an already-finished edge). */
  cleared?: RegionAtZ[];
  cutter: string;
}

/** The material removed at one Z — outer boundary plus holes. */
export interface RegionAtZ {
  z: number;
  boundary: Polygon[];
}

/** C's shape. Nothing in `plan.ts`'s `SetupPlan` or in `link()` below consumes this yet — flagged on #956, not guessed at. */
export interface PassRef {
  z: number;
  boundary: Polygon[];
  cleared: RegionAtZ;
}

export type RegionKind = 'pocket' | 'island-top' | 'curved' | 'contour' | 'rim';

export interface RegionRef {
  id: string;
  kind: RegionKind;
  bounds: Box2;
  topZ: number;
  bottomZ: number;
  /**
   * The fixture's boxes that actually reach this region's bounds — already inflated by the fixture
   * envelope's own `uncertainty` (the same inflation `prepareFixtureBoxes`/the sweep applies,
   * `workers/geometry/sweep.ts:622`), not the whole fixture. This is the #949 jaw-clearance data.
   */
  obstacles: ObstacleBox[];
}

/**
 * The material state over EVERY op planned so far in this setup — not the current op's own region.
 * Backed by #957's CL surface (C's own line: "the CL surface is the backing store"). A method
 * interface, not module-level functions: a free function would need mutable global state shared
 * across every candidate sequence #961 prices, which breaks as soon as two run side by side.
 */
export interface MaterialState {
  /** Removed material at this depth, so far. `null` where nothing has been cleared at that Z yet. */
  clearedAt(z: number): RegionAtZ | null;
  /** Is a straight link from `from` to `to`, held at `z`, entirely inside what `clearedAt` already removed? */
  linkIsClear(from: Vec2, to: Vec2, z: number, cutter: Tool): boolean;
}

/**
 * One planned operation, in a `SetupPlan.ops[]` execution order. `region` and `outcome` replace an
 * earlier, less complete sketch of this type (a bare `regionId: string` / `passes: Pass[]`) once
 * C's #961/#962 contract (above) was folded in — see the design note's §3.0.1 deviations list.
 */
export interface PlannedOp {
  kind: 'pocket' | 'contour' | 'rough' | 'rest' | 'finish' | 'pencil' | 'chamfer';
  region: RegionRef;
  outcome: OpOutcome;
}

export interface LinkContext {
  material: MaterialState;
  region: RegionRef;
  cutter: Tool;
  /** Tentative name (C's comment names the concept, not this field) — the Z a stay-down link may run at, inside cleared material. */
  stayDownClearanceMm: number;
  /** Tentative name — the Z a retract must clear to above this region's own fixture obstacles. */
  retractClearanceMm: number;
}

/**
 * ONE pure linker, called by every rough/finish op alike (not one per op kind): `feed` at depth for
 * a stay-down link when `material.linkIsClear` allows it, `rapid` at `retractClearanceMm` otherwise.
 * Never emits past `context.region.obstacles` — the #949 jaw-clearance class.
 *
 * Vertical legs (the retract itself) use `feeds.plungeFeed`, not `feeds.feed` (Review B's F8: the
 * old engine's `staircaseCorner` call sites fed a near-vertical leg at the cutting feed). `link()` is
 * where every retract/stay-down vertical between regions or passes is decided; §2's CL-surface
 * staircase rule (`clsurface.ts`) carries the equivalent rule for a vertical INSIDE one region's own
 * drop-cutter sampling — the two don't need to know about each other.
 */
export function link(_context: LinkContext, _from: Vec3, _to: Vec3, _z: number): CamMove[] {
  throw new Error('cam/model/linking: link() not implemented (#962)');
}
