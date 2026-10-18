/**
 * Peck drilling with a DRILL BIT (#434 phase 1) — the drills the location owns (1, 2, 2.5, 3 mm in the
 * Kazoo inventory), as opposed to #220's plunge with a flat end mill (`drill.ts`, untouched here).
 *
 * THE POINT. A drill's tip is a cone, so the hole is its full diameter only a POINT LENGTH above the tip:
 * `(d / 2) / tan(angle / 2)`. A blind hole's tip goes that much deeper than its full-diameter depth; a
 * through hole's tip clears the underside by the breakthrough PLUS that much, so the full diameter exits.
 * The included point angle is the tool's own `angle` when its record states one, else the shop's
 * `drill.pointAngleDeg` (118, chosen) — and the plan says which (#382's "a stated default with
 * provenance, never a hidden constant").
 *
 * THE PECKS. No canned cycles on the Z1 (`G81`/`G83` are refused, #184), so a peck is written out the
 * way #220 writes it: a feed down, a full retract to the hop height to clear the chips, a rapid back down
 * the open hole to `drill.peckClearanceMm` above the floor just cut. Each peck is `drill.peckDiameters`
 * × the diameter. Every cutting move is pure Z (the verifier's rule 9 sees no XY below the hop).
 *
 * THE NUMBERS ARE THE SHOP'S. Pecks chosen; the feed and the spindle speed are OUR placeholders
 * (`drill.plungeFeed`, `drill.spindleRpm`), seeded "placeholder, not measured; not a vendor number" —
 * no Makera row is in the repo (#347).
 *
 * THREADS are phase 2 (a helical thread mill) and are not here; chamfers are #221.
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import { HOP_Z, SAFE_Z, estimateCycleSeconds, toolNumberFor, type CamMove, type CamOperation, type RapidEstimate, type ToolpathIR } from './ir';
import { orderHolesNearest, peckDepths } from './drill';
import { drillPointAngle, pointLength, type Tool } from '../tool';

// The point's geometry is `tool.ts`': `jobSetup`'s depth checks need it too, and must not import
// this module (whose `drillSettings` pulls the defaults client into the worker's realm). Re-exported
// here so every existing `from '@/engine/cnc/cam/drillBit'` import keeps working.
export { pointLength };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface DrillSettings {
  /** Peck depth, in drill diameters. */
  peckDiameters: number;
  /** How far above the last floor the drill rapids back to, mm. */
  peckClearanceMm: number;
  /** The included point angle used when the drill's record states none, degrees. */
  pointAngleDeg: number;
  /** The drilling feed, mm/min — a placeholder. */
  plungeFeed: number;
  /** The drilling spindle speed — a placeholder. */
  spindleRpm: number;
}

const KEYS: Record<keyof DrillSettings, string> = {
  peckDiameters: 'drill.peckDiameters',
  peckClearanceMm: 'drill.peckClearanceMm',
  pointAngleDeg: 'drill.pointAngleDeg',
  plungeFeed: 'drill.plungeFeed',
  spindleRpm: 'drill.spindleRpm',
};

/** The drill settings from the shop defaults, with each one's source. */
export function drillSettings(defaults: ShopDefaults | null): { settings: DrillSettings; sources: Record<keyof DrillSettings, string> } {
  const settings = {} as DrillSettings;
  const sources = {} as Record<keyof DrillSettings, string>;
  for (const [field, key] of Object.entries(KEYS) as [keyof DrillSettings, string][]) {
    const d = readDefault(defaults, key);
    settings[field] = d.value;
    sources[field] = d.source;
  }
  return { settings, sources };
}

/** How deep the hole goes. */
export type HoleDepth =
  /** The full diameter reaches `fullDiameterDepth` below the top; the tip goes a point length deeper. */
  | { kind: 'blind'; fullDiameterDepth: number }
  /** Through stock `thickness` thick: the full diameter clears the underside by `breakthroughMm`. */
  | { kind: 'through'; thickness: number; breakthroughMm: number };

export interface DrillBitInput {
  tool: Tool;
  /** Hole centres, work XY. */
  holes: readonly (readonly [number, number])[];
  depth: HoleDepth;
  settings: DrillSettings;
  /** Where `settings.pointAngleDeg` came from — `drillSettings`' own source for it (`fallback` with no location). */
  pointAngleSource: string;
  /** The stock's XY size, to refuse a hole whose edge leaves it. Optional. */
  stock?: { length: number; width: number };
}

export interface DrillBitPlan {
  diameter: number;
  /** The included point angle, and where it came from. */
  angle: { deg: number; from: string };
  /**
   * The point default this plan was made with, to hand the simulation (`SimLoadOpts.drillPointDefault`)
   * so it sweeps the point the plan used rather than re-reading the setting (#382 review).
   */
  simDrillPoint: { deg: number; source: string };
  /** How far the tip is below the full diameter, mm. */
  pointLength: number;
  /** The tip's depth below the top, positive mm. */
  tipDepth: number;
  peck: number;
  /** The holes in the order they are drilled. */
  holes: [number, number][];
  moves: CamMove[];
  notes: string[];
}

export type DrillBitResult = { ok: true; plan: DrillBitPlan } | { ok: false; reason: string };

/** The drill's cutting diameter: the record's tip diameter, else its diameter. */
function drillDiameter(tool: Tool): number | null {
  const d = tool.tipDiameter ?? tool.diameter;
  return d !== null && d > 0 ? d : null;
}

/** Plan one drill operation: the point, the tip depth, the pecks, the moves — or why not. */
export function planDrillBit(input: DrillBitInput): DrillBitResult {
  const { tool, settings: s } = input;
  if (tool.shape !== 'drill') {
    return { ok: false, reason: `${tool.name} is a ${tool.shape} cutter, not a drill — a flat end mill is not the cutter for a drilled hole` };
  }
  const d = drillDiameter(tool);
  if (d === null) return { ok: false, reason: `${tool.name} states no diameter` };
  if (input.holes.length === 0) return { ok: false, reason: 'there are no holes to drill' };
  // The one rule the simulator sweeps the point by too (#382), so the plan and the sim agree.
  const point0 = drillPointAngle(tool, { deg: s.pointAngleDeg, source: input.pointAngleSource });
  if (!point0.ok) return point0;
  const angle = { deg: point0.deg, from: point0.from };
  if (input.stock) {
    const r = d / 2;
    const off = input.holes.find(([x, y]) => x - r < 0 || y - r < 0 || x + r > input.stock!.length || y + r > input.stock!.width);
    if (off) return { ok: false, reason: `the ${d} mm hole at (${off[0]}, ${off[1]}) runs off the ${input.stock.length} × ${input.stock.width} mm stock` };
  }
  const point = pointLength(d, angle.deg);
  const tipDepth =
    input.depth.kind === 'blind' ? input.depth.fullDiameterDepth + point : input.depth.thickness + input.depth.breakthroughMm + point;
  if (!(tipDepth > 0) || (input.depth.kind === 'blind' && !(input.depth.fullDiameterDepth > 0))) {
    return { ok: false, reason: 'the hole has no depth' };
  }
  if (input.depth.kind === 'through' && !(input.depth.breakthroughMm >= 0 && input.depth.thickness > 0)) {
    return { ok: false, reason: 'a through hole needs the stock thickness and a breakthrough of 0 or more' };
  }
  const peck = d * s.peckDiameters;
  const holes = orderHolesNearest(input.holes);
  // Rounded to the post's own precision, so the file and the plan state the same depth.
  const depths = peckDepths(r3(tipDepth), peck);
  const moves: CamMove[] = [];
  for (const [x, y] of holes) {
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
    moves.push({ kind: 'rapid', x, y, z: 0 });
    for (let i = 0; i < depths.length; i++) {
      const z = depths[i]!;
      moves.push({ kind: 'feed', x, y, z, f: s.plungeFeed });
      if (i < depths.length - 1) {
        // A full retract clears the chips (a drill packs its flutes), then back down the open hole.
        moves.push({ kind: 'rapid', x, y, z: HOP_Z });
        moves.push({ kind: 'rapid', x, y, z: z + s.peckClearanceMm });
      }
    }
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
  }
  const last = holes[holes.length - 1]!;
  moves.push({ kind: 'rapid', x: last[0], y: last[1], z: SAFE_Z });
  return {
    ok: true,
    plan: {
      diameter: d,
      angle,
      simDrillPoint: { deg: s.pointAngleDeg, source: input.pointAngleSource },
      pointLength: r3(point),
      tipDepth: r3(tipDepth),
      peck: r3(peck),
      holes,
      moves,
      notes: [
        `the ${angle.deg}° point (${angle.from}) puts the tip ${r3(point)} mm below the full ${d} mm diameter`,
        input.depth.kind === 'blind'
          ? `blind: full diameter to ${input.depth.fullDiameterDepth} mm, tip to ${r3(tipDepth)} mm`
          : `through ${input.depth.thickness} mm: the full diameter clears the underside by ${input.depth.breakthroughMm} mm, tip to ${r3(tipDepth)} mm`,
        `${depths.length} peck(s) of ${r3(peck)} mm (drill.peckDiameters × ${d}), a full retract after each`,
        `feed ${s.plungeFeed} mm/min and ${s.spindleRpm} rpm are placeholders, not measured (drill.plungeFeed, drill.spindleRpm)`,
      ],
    },
  };
}

/** The drill operation as a postable IR: one operation, the drill as its tool. */
export function drillBitIR(
  input: DrillBitInput & { name: string; labelId: string; air: boolean; rapid: RapidEstimate },
): { ok: true; ir: ToolpathIR; plan: DrillBitPlan } | { ok: false; reason: string } {
  const r = planDrillBit(input);
  if (!r.ok) return r;
  const op: CamOperation = {
    number: 1,
    name: input.name,
    labelId: input.labelId,
    depth: r.plan.tipDepth,
    moves: r.plan.moves,
    estimatedSeconds: estimateCycleSeconds(r.plan.moves, input.rapid),
  };
  return {
    ok: true,
    plan: r.plan,
    ir: {
      frame: 'flat',
      tool: input.tool,
      toolNumber: toolNumberFor(input.tool),
      spindleRpm: input.settings.spindleRpm,
      air: input.air,
      safeZ: SAFE_Z,
      hopZ: HOP_Z,
      operations: [op],
    },
  };
}
