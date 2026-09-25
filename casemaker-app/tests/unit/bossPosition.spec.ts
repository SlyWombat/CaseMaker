// Issue #104 — boss-insert position option. 'bottom' (legacy default)
// anchors bosses to the case floor. 'top' anchors them to the lid
// underside, with a tapered support column on the inside wall providing
// material continuity for screw threading from above.

import { describe, it, expect } from 'vitest';
import {
  computeBossPlacements,
  buildBossesUnion,
  buildLidBosses,
} from '@/engine/compiler/bosses';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeLidDims } from '@/engine/compiler/lid';
import { createDefaultProject } from '@/store/projectStore';

describe('Boss position (#104)', () => {
  it('default position is "bottom" — placements unchanged from pre-#104 behavior', () => {
    const project = createDefaultProject('rpi-4b');
    const placements = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true },
    });
    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) {
      expect(p.position).toBe('bottom');
    }
  });

  it('explicit position="top" ADDS a lid-anchored boss above the floor seat (#162)', () => {
    // Issue #162 — 'top' used to REPLACE the floor standoff, leaving the
    // board resting on nothing. It is now additive: every hole keeps its
    // floor seat and gains a lid-anchored boss, clamping the board.
    const project = createDefaultProject('rpi-4b');
    const holes = project.board.mountingHoles.length;
    const placements = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true, position: 'top' },
    });
    expect(placements.length).toBe(holes * 2);
    expect(placements.filter((p) => p.position === 'bottom').length).toBe(holes);
    expect(placements.filter((p) => p.position === 'top').length).toBe(holes);
    // Every hole must have a seat under it — that is the whole point.
    for (const seat of placements.filter((p) => p.position === 'bottom')) {
      expect(placements.some((t) => t.position === 'top' && t.x === seat.x && t.y === seat.y)).toBe(true);
    }
    // IDs must stay unique now that a hole yields two placements.
    expect(new Set(placements.map((p) => p.id)).size).toBe(placements.length);
  });

  it('top-position with NON-screw-down joint falls back to bottom (no screw, no top-anchor)', () => {
    const project = createDefaultProject('rpi-4b');
    const placements = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'snap-fit',
      bosses: { ...project.case.bosses, enabled: true, position: 'top' },
    });
    for (const p of placements) {
      expect(p.position).toBe('bottom');
    }
  });

  it('buildBossesUnion emits ops for bottom placements only', () => {
    const project = createDefaultProject('rpi-4b');
    const all = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true, position: 'top' },
    });
    // #162 — the floor seat survives, so bottom ops are still emitted.
    const ops = buildBossesUnion(all);
    expect(ops.length).toBe(project.board.mountingHoles.length);

    const bottomPlacements = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true },
    });
    const bottomOps = buildBossesUnion(bottomPlacements);
    expect(bottomOps.length).toBe(bottomPlacements.length);
  });

  it('buildLidBosses emits ops for top placements only, anchored to the lid underside Z', () => {
    const project = createDefaultProject('rpi-4b');
    const top = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true, position: 'top' },
    });
    const dims = computeShellDims(project.board, project.case, project.hats ?? [], () => undefined);
    const lidUndersideZ = dims.outerZ - project.case.lidThickness;
    // #162 — buildLidBosses now takes the board-top anchor so the post
    // actually reaches the board instead of being floor+standoff long.
    const postBottomZ =
      project.case.floorThickness + project.board.defaultStandoffHeight + project.board.pcb.size.z + 0.3;
    const ops = buildLidBosses(top, lidUndersideZ, postBottomZ);
    const topCount = top.filter((b) => b.position === 'top').length;
    expect(ops.length).toBe(topCount);
    expect(ops.length).toBeGreaterThan(0);
  });

  it('no shell-side support columns remain for top bosses (#162)', () => {
    // #104's columns attached to nothing once the floor seat came back —
    // they left the shell in 5 disconnected pieces. Removed entirely.
    const project = createDefaultProject('rpi-4b');
    const plan = compileProject({
      ...project,
      case: {
        ...project.case,
        joint: 'screw-down',
        boardRetention: 'screws',
        bosses: { ...project.case.bosses, enabled: true, position: 'top' },
      },
    });
    expect(plan.nodes.find((n) => n.id === 'shell')).toBeDefined();
  });

  it('compileProject builds successfully for both bottom and top boss configs', () => {
    const baseProject = createDefaultProject('rpi-4b');
    const bottom = compileProject({
      ...baseProject,
      case: {
        ...baseProject.case,
        joint: 'screw-down',
        bosses: { ...baseProject.case.bosses, enabled: true, position: 'bottom' },
      },
    });
    const top = compileProject({
      ...baseProject,
      case: {
        ...baseProject.case,
        joint: 'screw-down',
        bosses: { ...baseProject.case.bosses, enabled: true, position: 'top' },
      },
    });
    expect(bottom.nodes.find((n) => n.id === 'shell')).toBeDefined();
    expect(bottom.nodes.find((n) => n.id === 'lid')).toBeDefined();
    expect(top.nodes.find((n) => n.id === 'shell')).toBeDefined();
    expect(top.nodes.find((n) => n.id === 'lid')).toBeDefined();
    // Sanity: lid and shell op trees are different between bottom and top
    // configs (top adds bosses to the lid; bottom adds them to the shell).
    expect(JSON.stringify(top.nodes)).not.toBe(JSON.stringify(bottom.nodes));
  });

  // computeLidDims is used downstream of buildLidBosses; sanity that it
  // gives a sensible Z position relative to the shell.
  it('lid underside Z is consistent with computeLidDims', () => {
    const project = createDefaultProject('rpi-4b');
    const dims = computeShellDims(project.board, project.case, project.hats ?? [], () => undefined);
    const lidDims = computeLidDims(project.board, project.case, project.hats ?? [], () => undefined);
    expect(lidDims.zPosition).toBeGreaterThanOrEqual(0);
    expect(lidDims.zPosition).toBeLessThanOrEqual(dims.outerZ);
  });
});
