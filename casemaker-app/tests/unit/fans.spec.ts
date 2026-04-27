import { describe, it, expect, beforeEach } from 'vitest';
import { buildFanMountOps } from '@/engine/compiler/fans';
import { FAN_SPECS } from '@/types/fan';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';

describe('Marketing gap #14 — fan mount feature', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
  });

  it('FAN_SPECS contains 30/40/40-tall/50/60mm sizes', () => {
    expect(Object.keys(FAN_SPECS)).toContain('30x30x10');
    expect(Object.keys(FAN_SPECS)).toContain('40x40x10');
    expect(Object.keys(FAN_SPECS)).toContain('40x40x20');
    expect(Object.keys(FAN_SPECS)).toContain('50x50x10');
    expect(Object.keys(FAN_SPECS)).toContain('60x60x15');
  });

  it('FAN_SPECS 40mm has 32mm screw spacing', () => {
    expect(FAN_SPECS['40x40x10'].screwSpacingMm).toBe(32);
  });

  it('addFanMount appends to the project and removeFanMount removes it', () => {
    useProjectStore.getState().addFanMount('40x40x10', '+z');
    expect(useProjectStore.getState().project.fanMounts.length).toBe(1);
    const id = useProjectStore.getState().project.fanMounts[0]!.id;
    useProjectStore.getState().removeFanMount(id);
    expect(useProjectStore.getState().project.fanMounts.length).toBe(0);
  });

  it('disabled fan produces no compile ops', () => {
    useProjectStore.getState().addFanMount('40x40x10', '+z');
    const project = useProjectStore.getState().project;
    const fans = project.fanMounts.map((f) => ({ ...f, enabled: false }));
    const ops = buildFanMountOps(fans, project.board, project.case);
    expect(ops.additive.length).toBe(0);
    expect(ops.subtractive.length).toBe(0);
  });

  it('compileProject includes fan cutout ops when a +z fan is added', () => {
    useProjectStore.getState().addFanMount('40x40x10', '+z');
    const plan = compileProject(useProjectStore.getState().project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!.op;
    expect(shell.kind).toBe('difference');
  });
});
