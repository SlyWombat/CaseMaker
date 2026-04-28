import { describe, it, expect } from 'vitest';
import { findTemplate } from '@/library/templates';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { getBuiltinHat } from '@/library/hats';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

describe('Issue #32 — GIGA + DMX template + side-Z stack height', () => {
  it('giga-dmx-controller template builds without error', () => {
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    expect(project.board.id).toBe('arduino-giga-r1-wifi');
    expect(project.hats.length).toBe(1);
    expect(project.hats[0]!.hatId).toBe('cqrobot-dmx-shield-max485');
  });

  it('case envelope for GIGA + DMX is at least 45 mm tall (XLR z-extent included)', () => {
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    const dims = computeShellDims(
      project.board,
      project.case,
      project.hats,
      (id) => getBuiltinHat(id),
    );
    expect(dims.outerZ).toBeGreaterThanOrEqual(45);
  });

  it('compiled GIGA + DMX shell has at least 2 cylinder cutouts (XLR connectors)', () => {
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const cyls = countOps(shell.op, 'cylinder');
    expect(cyls).toBeGreaterThanOrEqual(2);
  });

  // Issue #35: GIGA profile previously had a fictional USB-B port and DC barrel
  // jack, and the template pushed an empty `ports: []` array so the XLR
  // cutouts never made it into the case wall.
  it('GIGA profile no longer carries fictional USB-B or barrel-jack components', () => {
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    const ids = project.board.components.map((c) => c.id);
    expect(ids).not.toContain('usb-b-prog');
    expect(ids).not.toContain('barrel-power');
    const kinds = project.board.components.map((c) => c.kind);
    expect(kinds).not.toContain('usb-b');
    expect(kinds).not.toContain('barrel-jack');
  });

  it('GIGA + DMX template auto-fills HAT ports (XLR placements present)', () => {
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    const placement = project.hats[0]!;
    expect(placement.ports.length).toBeGreaterThanOrEqual(2);
    // After the DMX shield orientation correction (XLRs on the -x short edge,
    // above the host's USB cluster), both XLR placements face -x.
    const xlrFacings = placement.ports
      .filter((p) => p.sourceComponentId.includes('xlr'))
      .map((p) => p.facing);
    expect(xlrFacings).toContain('-x');
  });

  it('GIGA + DMX template aligns the Uno-form-factor shield with the host frame (no x-offset)', () => {
    // Uno-form-factor shields plug into the Uno-compatible header column at
    // the -x (USB) end of the Mega/Giga, so the shield's x=0 maps to host
    // x=0. No offsetOverride.
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    const placement = project.hats[0]!;
    expect(placement.offsetOverride?.x ?? 0).toBe(0);
  });
});
