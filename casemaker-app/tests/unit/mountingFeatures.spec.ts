import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildMountingFeatureOps,
  fourCornerScrewTabs,
} from '@/engine/compiler/mountingFeatures';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';

describe('mounting features (#9 Phase 10a)', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
  });

  it('fourCornerScrewTabs produces 4 features with correct preset id', () => {
    const tabs = fourCornerScrewTabs(100, 70);
    expect(tabs.length).toBe(4);
    expect(tabs.every((f) => f.type === 'screw-tab')).toBe(true);
    expect(tabs.every((f) => f.face === '-z')).toBe(true);
    expect(tabs.every((f) => f.presetId === 'four-corner-screw-tabs')).toBe(true);
  });

  it('applyMountingPreset adds 4 corner tabs to the project', () => {
    useProjectStore.getState().applyMountingPreset('four-corner-screw-tabs');
    const features = useProjectStore.getState().project.mountingFeatures;
    expect(features.length).toBe(4);
  });

  it('applyMountingPreset rear-vesa-100 adds a single feature with patternSize 100', () => {
    useProjectStore.getState().applyMountingPreset('rear-vesa-100');
    const features = useProjectStore.getState().project.mountingFeatures;
    expect(features.length).toBe(1);
    expect(features[0]!.type).toBe('vesa-mount');
    expect(features[0]!.params.patternSize).toBe(100);
  });

  it('disabled mounting feature produces no compiled ops', () => {
    useProjectStore.getState().applyMountingPreset('four-corner-screw-tabs');
    const features = useProjectStore
      .getState()
      .project.mountingFeatures.map((f) => ({ ...f, enabled: false }));
    const project = useProjectStore.getState().project;
    const ops = buildMountingFeatureOps(features, project.board, project.case);
    expect(ops.additive.length).toBe(0);
    expect(ops.subtractive.length).toBe(0);
  });

  it('compileProject includes mounting feature additive ops in the union', () => {
    useProjectStore.getState().applyMountingPreset('four-corner-screw-tabs');
    const plan = compileProject(useProjectStore.getState().project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!.op;
    // Outer wrapper is difference (cutouts present from corner-tab holes), inner is union with tabs.
    expect(shell.kind).toBe('difference');
  });

  // Issue #45 — VESA holes must orient along the face's outward normal so
  // they actually pierce the wall. The earlier code shipped a fixed Z-axis
  // cylinder for every face; on +y the result was a 20mm slug standing up at
  // the corner instead of a through-hole.
  it('rear-vesa-100 (+y face) produces hole cylinders rotated to pierce +y', () => {
    useProjectStore.getState().applyMountingPreset('rear-vesa-100');
    const project = useProjectStore.getState().project;
    const ops = buildMountingFeatureOps(
      project.mountingFeatures,
      project.board,
      project.case,
    );
    // Subtractive ops should be 4 holes; each is translate(rotate(cylinder)).
    // The rotate's degrees should be [-90, 0, 0] for +y facing (axisCylinder).
    expect(ops.subtractive.length).toBe(4);
    let foundRotate = false;
    function visit(op: import('@/engine/compiler/buildPlan').BuildOp): void {
      if (op.kind === 'rotate') {
        const [rx, ry, rz] = op.degrees;
        if (rx === -90 && ry === 0 && rz === 0) foundRotate = true;
      }
      if ('child' in op && op.child) visit(op.child);
      if ('children' in op) for (const c of op.children) visit(c);
    }
    ops.subtractive.forEach(visit);
    expect(foundRotate, 'VESA holes on +y face must have a rotate of -90,0,0').toBe(true);
  });
});
