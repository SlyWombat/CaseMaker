import type { CaseParameters, BoardProfile } from '@/types';
import { cylinder, difference, translate, type BuildOp } from './buildPlan';

export interface BossPlacement {
  id: string;
  x: number;
  y: number;
  outerDiameter: number;
  holeDiameter: number;
  totalHeight: number;
}

export function computeBossPlacements(
  board: BoardProfile,
  params: CaseParameters,
): BossPlacement[] {
  if (!params.bosses.enabled) return [];
  const { wallThickness: wall, internalClearance: cl, floorThickness: floor } = params;
  const standoff = board.defaultStandoffHeight;
  const totalHeight = floor + standoff;
  return board.mountingHoles.map((h) => ({
    id: `boss-${h.id}`,
    x: h.x + wall + cl,
    y: h.y + wall + cl,
    outerDiameter: params.bosses.outerDiameter,
    holeDiameter: params.bosses.holeDiameter,
    totalHeight,
  }));
}

export function buildBossesUnion(placements: BossPlacement[]): BuildOp[] {
  return placements.map((b) => {
    const outer = cylinder(b.totalHeight, b.outerDiameter / 2, 32);
    const pilot = cylinder(b.totalHeight + 2, b.holeDiameter / 2, 24);
    const piloted = difference([outer, translate([0, 0, -1], pilot)]);
    return translate([b.x, b.y, 0], piloted);
  });
}
