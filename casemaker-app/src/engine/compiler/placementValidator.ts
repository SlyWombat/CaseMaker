import type {
  Project,
  BoardProfile,
  HatProfile,
  PortPlacement,
  Facing,
  BoardComponent,
  CaseParameters,
} from '@/types';
import { computeShellDims } from './caseShell';
import { computeHatBaseZ } from './hats';
import { transformPlacementPorts } from './hatOrientation';
import { getBuiltinHat } from '@/library/hats';

/**
 * Issue #37 — cross-cutting validation that catches overlap, off-PCB, and
 * unsupported-mounting bugs that the per-subsystem compilers can't see in
 * isolation. Pure function: takes a Project, returns a structured report.
 *
 * The report is informational only — `compileProject` attaches it to the
 * BuildPlan and the UI surfaces it as a banner. The geometry pipeline does
 * not gate on it; the user can still export.
 */

export type PlacementSeverity = 'error' | 'warning';

export type PlacementIssueKind =
  | 'overlap'
  | 'off-pcb'
  | 'cutout-out-of-wall'
  | 'rim-margin'
  | 'misaligned'
  | 'unsupported-hat'
  | 'hat-stack-collision'
  | 'incompatible-hat';

export interface PlacementIssue {
  severity: PlacementSeverity;
  kind: PlacementIssueKind;
  involves: string[];
  face?: Facing;
  message: string;
}

export interface PlacementReport {
  issues: PlacementIssue[];
  errorCount: number;
  warningCount: number;
}

interface Rect2D {
  id: string;
  source: 'port' | 'hat-port' | 'vent' | 'fan' | 'antenna' | 'text';
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  shape?: 'rect' | 'round';
}

const SIDE_FACES: Facing[] = ['+x', '-x', '+y', '-y'];

function rectsOverlap(a: Rect2D, b: Rect2D): boolean {
  if (a.uMax <= b.uMin || b.uMax <= a.uMin) return false;
  if (a.vMax <= b.vMin || b.vMax <= a.vMin) return false;
  return true;
}

/** Project a port onto its face, returning a 2D rect in (u, v) where u is
 *  the in-wall horizontal axis (perpendicular to facing) and v is Z.
 *  `inflate` is the per-edge expansion applied to the connector body — pass
 *  the cutout margin to get the cut footprint, or 0 to get the body footprint
 *  (used for body-overlap detection). */
function projectPortToFace(
  port: PortPlacement,
  inflate: number,
): Rect2D | null {
  if (!port.facing || port.facing === '+z') return null;
  let uMin: number;
  let uMax: number;
  if (port.facing === '+x' || port.facing === '-x') {
    uMin = port.position.y - inflate;
    uMax = port.position.y + port.size.y + inflate;
  } else {
    uMin = port.position.x - inflate;
    uMax = port.position.x + port.size.x + inflate;
  }
  const vMin = port.position.z - inflate;
  const vMax = port.position.z + port.size.z + inflate;
  return {
    id: port.id,
    source: 'port',
    uMin,
    uMax,
    vMin,
    vMax,
    shape: port.cutoutShape,
  };
}

// Issue #67 — panel-mount connectors (USB, Ethernet, etc.) are deliberately
// at the PCB edge with their body overhanging in the `facing` direction. The
// overhang can reach 4–5 mm (Pi Pico micro-USB). Allow that direction extra
// budget; keep the tight ±1 mm rule on every other edge so we still catch
// genuine placement bugs.
const CONNECTOR_OVERHANG_BUDGET = 5;
const NON_OVERHANG_BUDGET = 1;

function validateBoardComponentBounds(board: BoardProfile): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  for (const c of board.components) {
    const cx = c.position.x + c.size.x / 2;
    const cy = c.position.y + c.size.y / 2;
    const facing = c.facing ?? null;
    const xMaxBudget = facing === '+x' ? CONNECTOR_OVERHANG_BUDGET : NON_OVERHANG_BUDGET;
    const xMinBudget = facing === '-x' ? CONNECTOR_OVERHANG_BUDGET : NON_OVERHANG_BUDGET;
    const yMaxBudget = facing === '+y' ? CONNECTOR_OVERHANG_BUDGET : NON_OVERHANG_BUDGET;
    const yMinBudget = facing === '-y' ? CONNECTOR_OVERHANG_BUDGET : NON_OVERHANG_BUDGET;
    if (cx < -xMinBudget || cx > board.pcb.size.x + xMaxBudget) {
      issues.push({
        severity: 'warning',
        kind: 'off-pcb',
        involves: [c.id],
        message: `Component "${c.id}" centroid is outside the PCB X outline (cx=${cx.toFixed(1)} mm, PCB x=0..${board.pcb.size.x})`,
      });
    }
    if (cy < -yMinBudget || cy > board.pcb.size.y + yMaxBudget) {
      issues.push({
        severity: 'warning',
        kind: 'off-pcb',
        involves: [c.id],
        message: `Component "${c.id}" centroid is outside the PCB Y outline (cy=${cy.toFixed(1)} mm, PCB y=0..${board.pcb.size.y})`,
      });
    }
  }
  return issues;
}

function validateMountingHoles(board: BoardProfile): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  for (const h of board.mountingHoles) {
    if (h.x < 0 || h.x > board.pcb.size.x || h.y < 0 || h.y > board.pcb.size.y) {
      issues.push({
        severity: 'error',
        kind: 'off-pcb',
        involves: [h.id],
        message: `Mounting hole "${h.id}" lies outside the PCB outline (${h.x.toFixed(1)}, ${h.y.toFixed(1)})`,
      });
    }
  }
  // Min spacing — flag if two holes are closer than 2× their max diameter.
  for (let i = 0; i < board.mountingHoles.length; i++) {
    for (let j = i + 1; j < board.mountingHoles.length; j++) {
      const a = board.mountingHoles[i]!;
      const b = board.mountingHoles[j]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = Math.max(a.diameter, b.diameter) * 2;
      if (dist < minDist) {
        issues.push({
          severity: 'warning',
          kind: 'misaligned',
          involves: [a.id, b.id],
          message: `Mounting holes "${a.id}" and "${b.id}" are ${dist.toFixed(1)} mm apart (< ${minDist.toFixed(1)} mm = 2 × max diameter)`,
        });
      }
    }
  }
  return issues;
}

function validateFaceOverlaps(
  faceRects: Map<Facing, Rect2D[]>,
): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  for (const face of SIDE_FACES) {
    const rects = faceRects.get(face) ?? [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        if (a.source === b.source && a.source === 'vent') continue;
        if (rectsOverlap(a, b)) {
          issues.push({
            severity: 'error',
            kind: 'overlap',
            involves: [a.id, b.id],
            face,
            message: `Cutouts on the ${face} face overlap: "${a.id}" (${a.source}) ∩ "${b.id}" (${b.source})`,
          });
        }
      }
    }
  }
  return issues;
}

function validateRimMargin(
  faceRects: Map<Facing, Rect2D[]>,
  params: CaseParameters,
  outerZ: number,
): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  // The rim — top of the wall — needs `lidThickness` clear above any cutout
  // so the lid pocket / snap-fit catch / recess doesn't slice into it.
  const rimMargin = params.lidThickness;
  const cavityTop = outerZ - params.lidThickness;
  for (const face of SIDE_FACES) {
    for (const rect of faceRects.get(face) ?? []) {
      if (rect.source === 'vent') continue;
      if (rect.vMax > cavityTop - rimMargin + 0.01) {
        issues.push({
          severity: 'warning',
          kind: 'rim-margin',
          involves: [rect.id],
          face,
          message: `Cutout "${rect.id}" on ${face} reaches within ${rimMargin.toFixed(1)} mm of the rim — may collide with the lid pocket / snap catches`,
        });
      }
    }
  }
  return issues;
}

function validateHatPlacements(
  project: Project,
  resolveHat: (id: string) => HatProfile | undefined,
): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  if (!project.hats || project.hats.length === 0) return issues;

  for (const placement of project.hats) {
    const profile = resolveHat(placement.hatId);
    if (!profile) continue;
    // Issue #71 — accept the cloned-from id too so cloning a board doesn't
    // strip its HAT compatibility.
    const matchesId = profile.compatibleBoards.includes(project.board.id);
    const matchesClonedFrom =
      project.board.clonedFrom !== undefined &&
      profile.compatibleBoards.includes(project.board.clonedFrom);
    if (
      profile.compatibleBoards.length > 0 &&
      !matchesId &&
      !matchesClonedFrom
    ) {
      issues.push({
        severity: 'error',
        kind: 'incompatible-hat',
        involves: [placement.id, profile.id],
        message: `HAT "${profile.name}" lists no compatibility with board "${project.board.id}"`,
      });
    }
    // Header-column overlap: with offsetOverride.x applied, the shield's
    // mounting holes must land somewhere inside the host PCB so it has
    // physical support.
    const offsetX = placement.offsetOverride?.x ?? 0;
    const offsetY = placement.offsetOverride?.y ?? 0;
    let supported = false;
    for (const hole of profile.mountingHoles) {
      const hx = hole.x + offsetX;
      const hy = hole.y + offsetY;
      if (
        hx >= 0 &&
        hx <= project.board.pcb.size.x &&
        hy >= 0 &&
        hy <= project.board.pcb.size.y
      ) {
        supported = true;
        break;
      }
    }
    if (!supported && profile.mountingHoles.length > 0) {
      issues.push({
        severity: 'error',
        kind: 'unsupported-hat',
        involves: [placement.id],
        message: `HAT "${placement.id}" has no mounting hole inside the host PCB outline (offset x=${offsetX}, y=${offsetY})`,
      });
    }
  }

  // Stack collision — Z extents of consecutive HATs must not overlap.
  const baseZ = computeHatBaseZ(
    project.board,
    project.case,
    project.hats,
    resolveHat,
  );
  const ordered = [...project.hats]
    .filter((p) => p.enabled)
    .sort((a, b) => a.stackIndex - b.stackIndex);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const prevProfile = resolveHat(prev.hatId);
    const curBase = baseZ.get(cur.id);
    if (!prevProfile || curBase === undefined) continue;
    const prevBase = baseZ.get(prev.id);
    if (prevBase === undefined) continue;
    const prevTallest = prevProfile.components.reduce(
      (m, c: BoardComponent) => Math.max(m, c.position.z + c.size.z),
      prevProfile.pcb.size.z,
    );
    const prevTop = prevBase + prevTallest;
    if (curBase < prevTop - 0.01) {
      issues.push({
        severity: 'error',
        kind: 'hat-stack-collision',
        involves: [prev.id, cur.id],
        message: `HATs "${prev.id}" and "${cur.id}" collide in Z: prev top ${prevTop.toFixed(1)} mm vs next base ${curBase.toFixed(1)} mm`,
      });
    }
  }

  return issues;
}

function buildFaceRects(
  project: Project,
  resolveHat: (id: string) => HatProfile | undefined,
): Map<Facing, Rect2D[]> {
  const map = new Map<Facing, Rect2D[]>();
  for (const f of SIDE_FACES) map.set(f, []);

  // Use the bare body (inflate=0) for the overlap test. Margin-on-margin
  // touches between physically adjacent connectors (e.g., the Jetson Nano's
  // stacked USB3 + RJ45 on the same +y wall) are the print-clearance budget,
  // not actual body collisions.
  for (const port of project.ports) {
    if (!port.enabled) continue;
    const rect = projectPortToFace(port, 0);
    if (rect && port.facing && port.facing !== '+z') {
      map.get(port.facing)!.push(rect);
    }
  }

  // HAT ports — apply offsetOverride and rotation, then project. Z is
  // measured from the world origin so we add the HAT base Z.
  if (project.hats && project.hats.length > 0) {
    const baseZ = computeHatBaseZ(
      project.board,
      project.case,
      project.hats,
      resolveHat,
    );
    for (const placement of project.hats) {
      if (!placement.enabled) continue;
      const profile = resolveHat(placement.hatId);
      if (!profile) continue;
      const z0 = baseZ.get(placement.id);
      if (z0 === undefined) continue;
      const offsetX = placement.offsetOverride?.x ?? 0;
      const offsetY = placement.offsetOverride?.y ?? 0;
      const ports = transformPlacementPorts(placement, profile);
      for (const port of ports) {
        if (!port.enabled || !port.facing || port.facing === '+z') continue;
        const shifted: PortPlacement = {
          ...port,
          position: {
            x: port.position.x + offsetX,
            y: port.position.y + offsetY,
            z: z0 + port.position.z - profile.pcb.size.z,
          },
        };
        const rect = projectPortToFace(shifted, 0);
        if (rect) {
          rect.id = `${placement.id}/${port.id}`;
          rect.source = 'hat-port';
          map.get(port.facing)!.push(rect);
        }
      }
    }
  }

  return map;
}

export function validatePlacements(project: Project): PlacementReport {
  const resolveHat = (id: string): HatProfile | undefined => {
    const builtin = getBuiltinHat(id);
    if (builtin) return builtin;
    return project.customHats?.find((h) => h.id === id);
  };

  const issues: PlacementIssue[] = [];
  issues.push(...validateBoardComponentBounds(project.board));
  issues.push(...validateMountingHoles(project.board));
  issues.push(...validateHatPlacements(project, resolveHat));

  const faceRects = buildFaceRects(project, resolveHat);
  issues.push(...validateFaceOverlaps(faceRects));

  const dims = computeShellDims(
    project.board,
    project.case,
    project.hats ?? [],
    resolveHat,
  );
  issues.push(...validateRimMargin(faceRects, project.case, dims.outerZ));

  return {
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
}
