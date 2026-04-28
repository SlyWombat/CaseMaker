import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import { cube, cylinder, rotate, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;

const SLOT_WIDTH = 3;
const SLOT_GAP = 3;
const SLOT_INSET_FROM_EDGE = 6;

const HEX_RADIUS = 2.2;
const HEX_GAP = 1.4;
const HEX_INSET_FROM_EDGE = 5;

function buildSlotCutouts(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[],
  resolveHat: HatResolver,
): BuildOp[] {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const { wallThickness: wall, floorThickness: floor } = params;
  const coverage = clamp01(params.ventilation.coverage);
  const slotHeight = (dims.cavityZ - 4) * coverage;
  if (slotHeight <= 1) return [];
  const slotZ = floor + 2;
  const usableX = dims.outerX - 2 * SLOT_INSET_FROM_EDGE;
  const stride = SLOT_WIDTH + SLOT_GAP;
  const slotCount = Math.max(1, Math.floor(usableX / stride));
  const totalUsed = slotCount * stride - SLOT_GAP;
  const startX = (dims.outerX - totalUsed) / 2;
  const ops: BuildOp[] = [];
  for (let i = 0; i < slotCount; i++) {
    const xPos = startX + i * stride;
    ops.push(
      translate(
        [xPos, dims.outerY - wall - 1, slotZ],
        cube([SLOT_WIDTH, wall + 2, slotHeight], false),
      ),
    );
  }
  return ops;
}

function buildHexCutouts(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[],
  resolveHat: HatResolver,
): BuildOp[] {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const { wallThickness: wall, floorThickness: floor } = params;
  const coverage = clamp01(params.ventilation.coverage);
  const usableHeight = (dims.cavityZ - 2 * HEX_INSET_FROM_EDGE) * coverage;
  const usableWidth = dims.outerX - 2 * HEX_INSET_FROM_EDGE;
  if (usableHeight <= HEX_RADIUS * 2 || usableWidth <= HEX_RADIUS * 2) return [];

  // Hex flat-to-flat = sqrt(3) * radius. Pitch X = 1.5 * radius * 2 + gap-ish.
  // Use simple triangular grid: rows alternate offset by stride/2.
  const strideX = 2 * HEX_RADIUS + HEX_GAP;
  const strideY = Math.sqrt(3) * HEX_RADIUS + HEX_GAP;
  const cols = Math.max(1, Math.floor((usableWidth - HEX_RADIUS) / strideX));
  const rows = Math.max(1, Math.floor((usableHeight - HEX_RADIUS) / strideY));
  if (cols < 1 || rows < 1) return [];

  const ops: BuildOp[] = [];
  const xOriginCentered =
    (dims.outerX - (cols - 1) * strideX) / 2;
  const zOriginBase = floor + (dims.cavityZ - (rows - 1) * strideY) / 2;
  for (let r = 0; r < rows; r++) {
    const isOddRow = r % 2 === 1;
    const xOffset = isOddRow ? strideX / 2 : 0;
    for (let c = 0; c < cols - (isOddRow ? 1 : 0); c++) {
      const x = xOriginCentered + c * strideX + xOffset;
      const z = zOriginBase + r * strideY;
      // A hex prism is approximated with a 6-segment cylinder rotated to lie along Y.
      const hex = cylinder(wall + 2, HEX_RADIUS, 6, false);
      ops.push(
        translate(
          [x, dims.outerY - wall - 1, z],
          // Rotate about X so the cylinder's axis aligns with +y (the wall normal).
          rotate([90, 0, 0], translate([0, 0, -(wall + 2)], hex)),
        ),
      );
    }
  }
  return ops;
}

export function buildVentilationCutouts(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): BuildOp[] {
  if (!params.ventilation.enabled) return [];
  if (params.ventilation.coverage <= 0) return [];
  if (params.ventilation.pattern === 'slots') return buildSlotCutouts(board, params, hats, resolveHat);
  if (params.ventilation.pattern === 'hex') return buildHexCutouts(board, params, hats, resolveHat);
  return [];
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
