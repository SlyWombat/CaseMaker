import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import type { FanMount, CaseFace } from '@/types/fan';
import { FAN_SPECS } from '@/types/fan';
import { cube, cylinder, difference, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

export interface FanOpGroups {
  additive: BuildOp[];
  subtractive: BuildOp[];
}

interface FaceFrame {
  origin: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
}

function faceFrame(face: CaseFace, x: number, y: number, z: number): FaceFrame {
  switch (face) {
    case '+z':
      return { origin: [0, 0, z], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
    case '-z':
      return { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
    case '+y':
      return { origin: [0, y, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] };
    case '-y':
      return { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] };
    case '+x':
      return { origin: [x, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };
    default:
      return { origin: [0, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };
  }
}

function generateGrille(spec: typeof FAN_SPECS[keyof typeof FAN_SPECS], grille: FanMount['grille']): BuildOp[] {
  const r = spec.bladeRadiusMm;
  const segments = 48;
  switch (grille) {
    case 'open':
      return [cylinder(spec.depthMm + 4, r, segments)];
    case 'cross': {
      const opening = cylinder(spec.depthMm + 4, r, segments);
      const barWidth = 1.6;
      const bar1 = translate([-r, -barWidth / 2, -1], cube([2 * r, barWidth, spec.depthMm + 4]));
      const bar2 = translate([-barWidth / 2, -r, -1], cube([barWidth, 2 * r, spec.depthMm + 4]));
      return [difference([opening, bar1, bar2])];
    }
    case 'concentric': {
      const opening = cylinder(spec.depthMm + 4, r, segments);
      const ringWidth = 1.5;
      const rings: BuildOp[] = [];
      const innerR = r * 0.45;
      const midR = r * 0.7;
      rings.push(cylinder(spec.depthMm + 4, innerR + ringWidth, segments));
      rings.push(cylinder(spec.depthMm + 4, innerR, segments));
      rings.push(cylinder(spec.depthMm + 4, midR + ringWidth, segments));
      rings.push(cylinder(spec.depthMm + 4, midR, segments));
      // opening minus (ring1) plus (ring1Inner) etc — approximate as two annular subtractions
      return [
        difference([
          opening,
          difference([
            cylinder(spec.depthMm + 4, innerR + ringWidth, segments),
            cylinder(spec.depthMm + 4, innerR, segments),
          ]),
          difference([
            cylinder(spec.depthMm + 4, midR + ringWidth, segments),
            cylinder(spec.depthMm + 4, midR, segments),
          ]),
        ]),
      ];
    }
    case 'honeycomb': {
      // Approximate with a coarse hex grid of small holes covering the blade region.
      const hexR = 2;
      const pitchX = 2 * hexR + 0.6;
      const pitchY = Math.sqrt(3) * hexR + 0.6;
      const cols = Math.floor((2 * r) / pitchX);
      const rows = Math.floor((2 * r) / pitchY);
      const holes: BuildOp[] = [];
      for (let row = 0; row < rows; row++) {
        const yOff = -r + (row + 0.5) * pitchY;
        for (let col = 0; col < cols; col++) {
          const xOff = -r + (col + 0.5) * pitchX + (row % 2 === 0 ? 0 : pitchX / 2);
          if (Math.hypot(xOff, yOff) > r - hexR) continue;
          holes.push(translate([xOff, yOff, -1], cylinder(spec.depthMm + 4, hexR, 6)));
        }
      }
      return holes;
    }
    case 'spiral':
      // Simplified: two opposing arc-sweep bars (looks spiral-ish, prints flat)
      return [
        difference([
          cylinder(spec.depthMm + 4, r, segments),
          translate([-r, -1, -1], cube([2 * r, 2, spec.depthMm + 4])),
          translate([-1, -r, -1], cube([2, 2 * r, spec.depthMm + 4])),
        ]),
      ];
  }
}

export function buildFanMountOps(
  fans: FanMount[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
): FanOpGroups {
  const out: FanOpGroups = { additive: [], subtractive: [] };
  if (!fans || fans.length === 0) return out;
  const dims = computeShellDims(board, params, hats, resolveHat);

  for (const fan of fans) {
    if (!fan.enabled) continue;
    const spec = FAN_SPECS[fan.size];
    if (!spec) continue;
    const frame = faceFrame(fan.face, dims.outerX, dims.outerY, dims.outerZ);
    // Position center of fan at (origin + uAxis*u + vAxis*v).
    const cx = frame.origin[0] + frame.uAxis[0] * fan.position.u + frame.vAxis[0] * fan.position.v;
    const cy = frame.origin[1] + frame.uAxis[1] * fan.position.u + frame.vAxis[1] * fan.position.v;
    const cz = frame.origin[2] + frame.uAxis[2] * fan.position.u + frame.vAxis[2] * fan.position.v;
    // Generate grille at origin then translate to (cx, cy, cz - depth/2) so the cylinder's
    // axis is along Z (only +z/-z faces really lay flat — for v1 we ship that case).
    if (fan.face !== '+z' && fan.face !== '-z') {
      // Side-mounted fans need rotation; skip for v1 and emit just an open hole.
      const opening = cylinder(spec.depthMm + 6, spec.bladeRadiusMm, 48);
      out.subtractive.push(translate([cx, cy, cz], opening));
      continue;
    }
    const grilleOps = generateGrille(spec, fan.grille);
    const baseZ = fan.face === '+z' ? cz - spec.depthMm - 1 : cz - 1;
    for (const op of grilleOps) {
      out.subtractive.push(translate([cx, cy, baseZ], op));
    }
    if (fan.bossesEnabled) {
      const half = spec.screwSpacingMm / 2;
      for (const [du, dv] of [
        [-half, -half],
        [half, -half],
        [-half, half],
        [half, half],
      ] as Array<[number, number]>) {
        const sx = cx + du;
        const sy = cy + dv;
        const screwHole = cylinder(spec.depthMm + 4, spec.screwHoleMm / 2, 24);
        out.subtractive.push(translate([sx, sy, baseZ], screwHole));
      }
    }
  }
  return out;
}
