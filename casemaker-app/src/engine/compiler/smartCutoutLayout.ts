import type { BoardProfile, CaseParameters, HatPlacement, HatProfile, PortPlacement } from '@/types';
import { computeShellDims } from './caseShell';

export const MIN_BRIDGE_THICKNESS = 1.5;

export type SmartCutoutAction = 'as-is' | 'extended-to-top';

export interface SmartCutoutDecision {
  portId: string;
  action: SmartCutoutAction;
  topClearanceMm: number;
  reason: string;
}

export interface SmartLayoutResult {
  ports: PortPlacement[];
  decisions: SmartCutoutDecision[];
}

/**
 * Pre-pass over port cutouts: when a side-facing cutout's top is closer than
 * MIN_BRIDGE_THICKNESS to the outer shell top, extend the cutout up through
 * the top so it becomes a notch instead of leaving a thin unsupported bridge
 * of wall material above it (issue #17, see `giga-parts.jpg`).
 */
export function applySmartCutoutLayout(
  ports: PortPlacement[],
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
): SmartLayoutResult {
  const shell = computeShellDims(board, params, hats, resolveHat);
  const decisions: SmartCutoutDecision[] = [];
  const out: PortPlacement[] = [];

  for (const port of ports) {
    if (!port.enabled || port.facing === '+z') {
      out.push(port);
      continue;
    }

    // Issue #43 — must include the standoff that lifts the host PCB above the
    // floor. `ports.ts:50` computes the actual cutout Z as
    // `floor + standoff + position.z`; this pre-pass needs to match or it
    // overestimates `topClearance` by exactly `defaultStandoffHeight` and the
    // bridge-thinning branch never fires (regression of issue #17).
    const cutoutTopWorldZ =
      params.floorThickness +
      board.defaultStandoffHeight +
      port.position.z +
      port.size.z +
      port.cutoutMargin;
    const topClearance = shell.outerZ - cutoutTopWorldZ;

    if (topClearance > 0 && topClearance < MIN_BRIDGE_THICKNESS) {
      const extraZ = topClearance + MIN_BRIDGE_THICKNESS;
      out.push({
        ...port,
        size: { ...port.size, z: port.size.z + extraZ },
      });
      decisions.push({
        portId: port.id,
        action: 'extended-to-top',
        topClearanceMm: topClearance,
        reason: `Bridge above cutout would be ${topClearance.toFixed(2)}mm (< ${MIN_BRIDGE_THICKNESS}mm). Cutout extended to wall top.`,
      });
    } else {
      out.push(port);
      if (topClearance > 0) {
        decisions.push({
          portId: port.id,
          action: 'as-is',
          topClearanceMm: topClearance,
          reason: `Bridge above cutout is ${topClearance.toFixed(2)}mm — adequate.`,
        });
      }
    }
  }

  return { ports: out, decisions };
}
