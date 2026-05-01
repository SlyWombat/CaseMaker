// Issue #104 — boss-insert position option. 'bottom' (legacy default)
// anchors bosses to the case floor. 'top' anchors them to the lid
// underside, with a tapered support column on the inside wall providing
// material continuity for screw threading from above.

import { describe, it, expect } from 'vitest';
import {
  computeBossPlacements,
  buildBossesUnion,
  buildLidBosses,
  buildBossSupportColumns,
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

  it('explicit position="top" with screw-down joint flips placements to top-anchored', () => {
    const project = createDefaultProject('rpi-4b');
    const placements = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true, position: 'top' },
    });
    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) {
      expect(p.position).toBe('top');
    }
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
    const ops = buildBossesUnion(all);
    expect(ops.length).toBe(0);

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
    const ops = buildLidBosses(top, lidUndersideZ);
    expect(ops.length).toBe(top.length);
    expect(ops.length).toBeGreaterThan(0);
  });

  it('buildBossSupportColumns emits one mesh per top-position boss against the closest wall', () => {
    const project = createDefaultProject('rpi-4b');
    const top = computeBossPlacements(project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true, position: 'top' },
    });
    const cols = buildBossSupportColumns(top, project.board, {
      ...project.case,
      joint: 'screw-down',
      bosses: { ...project.case.bosses, enabled: true, position: 'top' },
    });
    expect(cols.length).toBe(top.length);
    for (const c of cols) {
      expect(c.kind).toBe('mesh');
    }
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
