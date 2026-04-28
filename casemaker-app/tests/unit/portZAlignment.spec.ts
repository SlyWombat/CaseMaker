import { describe, it, expect } from 'vitest';
import { buildPortCutoutOp } from '@/engine/compiler/ports';
import { createDefaultProject } from '@/store/projectStore';
import { listBuiltinBoardIds } from '@/library';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function findFirstTranslate(op: BuildOp): { offset: [number, number, number] } | null {
  if (op.kind === 'translate') return { offset: op.offset };
  if ('child' in op && op.child) return findFirstTranslate(op.child);
  return null;
}

describe('Issue #28 — port cutout Z aligns with elevated board (sits on bosses)', () => {
  it('every built-in board: every side-port cutout includes the standoff offset in its world-Z (cutout center aligns with elevated component center)', () => {
    for (const id of listBuiltinBoardIds()) {
      const project = createDefaultProject(id);
      for (const port of project.ports) {
        if (port.facing === '+z') continue;
        const op = buildPortCutoutOp(port, project.board, project.case);
        if (!op) continue;
        const t = findFirstTranslate(op);
        expect(t, `${id}/${port.id} cutout missing translate`).not.toBeNull();
        const wz = t!.offset[2];
        const expectedFloor = project.case.floorThickness;
        const standoff = project.board.defaultStandoffHeight;
        const zMin = expectedFloor + standoff + port.position.z - port.cutoutMargin;
        // Rect cutouts: the outer translate puts the cube at zMin.
        // Round cutouts (#4): the outer translate puts the centered cylinder
        // at zMin + (size.z + 2*margin) / 2 so the cylinder axis is centered
        // on the connector body.
        const sizeZ = port.size.z + 2 * port.cutoutMargin;
        const expectedWZ =
          (port.cutoutShape === 'round')
            ? zMin + sizeZ / 2
            : zMin;
        expect(
          wz,
          `${id}/${port.id} (${port.cutoutShape ?? 'rect'}) cutout Z=${wz}, expected ${expectedWZ}`,
        ).toBeCloseTo(expectedWZ, 4);
      }
    }
  });

  it('rpi-4b USB-C port cutout sits at floor + standoff + pcb.z (within margin)', () => {
    const project = createDefaultProject('rpi-4b');
    const usbc = project.ports.find((p) => p.sourceComponentId === 'usbc-power');
    expect(usbc).toBeDefined();
    const op = buildPortCutoutOp(usbc!, project.board, project.case);
    const t = findFirstTranslate(op!);
    const standoff = project.board.defaultStandoffHeight;
    const expectedFloorWZ =
      project.case.floorThickness +
      standoff +
      project.board.pcb.size.z -
      usbc!.cutoutMargin;
    expect(t!.offset[2]).toBeCloseTo(expectedFloorWZ, 2);
  });
});
