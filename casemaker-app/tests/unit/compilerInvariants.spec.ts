import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { listBuiltinBoardIds } from '@/library';
import { TEMPLATES } from '@/library/templates';
import { computeShellDims } from '@/engine/compiler/caseShell';
import type { BuildOp, BuildPlan } from '@/engine/compiler/buildPlan';
import type { Project } from '@/types';

/**
 * Issue #58 — compiler-invariant assertions across the matrix of built-in
 * boards × templates. Each invariant codifies an assumption the engine
 * relies on; many were undocumented and only surfaced as user-facing bugs
 * (issues #43 / #45 / #74 / #90). Future regressions get caught here.
 */

interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Walk a BuildOp tree, applying translate offsets, and return the union
 * bbox of every primitive (cube / cylinder / mesh) inside. Rotates / scales
 * are NOT applied — for cutouts we only care that an ESTIMATE bounds the
 * primitive's world position, not its exact post-rotation extent.
 */
function bboxOf(op: BuildOp): BBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  function expand(x: number, y: number, z: number): void {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  function walk(o: BuildOp, ox: number, oy: number, oz: number): void {
    if (o.kind === 'translate') {
      walk(o.child, ox + o.offset[0], oy + o.offset[1], oz + o.offset[2]);
    } else if (o.kind === 'rotate' || o.kind === 'scale') {
      // Rotations may swap which axis the cylinder body extends along;
      // for the post-rotate axisCylinder pattern (used for ±x / ±y
      // cutouts) the original primitive bbox is still a useful
      // pre-rotation envelope. We expand by the radius envelope to be
      // conservative.
      walk(o.child, ox, oy, oz);
    } else if (o.kind === 'cube') {
      const [sx, sy, sz] = o.size;
      const x0 = o.center ? ox - sx / 2 : ox;
      const y0 = o.center ? oy - sy / 2 : oy;
      const z0 = o.center ? oz - sz / 2 : oz;
      expand(x0, y0, z0);
      expand(x0 + sx, y0 + sy, z0 + sz);
    } else if (o.kind === 'cylinder') {
      const r = o.radiusLow;
      const h = o.height;
      // Z-axis cylinder; rotations earlier in the tree may swap axes,
      // but we extend the bbox in all three by r so any orientation is
      // covered. Conservative — keeps the assertion meaningful even on
      // rotated cylinders.
      expand(ox - r, oy - r, oz - r);
      expand(ox + r, oy + r, oz + h + r);
    } else if (o.kind === 'mesh') {
      const p = o.positions;
      for (let i = 0; i < p.length; i += 3) {
        expand(ox + p[i]!, oy + p[i + 1]!, oz + p[i + 2]!);
      }
    }
    if ('children' in o) for (const c of o.children) walk(c, ox, oy, oz);
  }
  walk(op, 0, 0, 0);
  return { min, max };
}

function projectsToTest(): Array<{ label: string; build: () => Project }> {
  const out: Array<{ label: string; build: () => Project }> = [];
  for (const id of listBuiltinBoardIds()) {
    out.push({ label: `board:${id}`, build: () => createDefaultProject(id) });
  }
  for (const tpl of TEMPLATES) {
    out.push({ label: `template:${tpl.id}`, build: () => tpl.build() });
  }
  return out;
}

describe('compiler invariants (#58) — matrix of boards × templates', () => {
  const cases = projectsToTest();

  describe('Invariant 1: BuildPlan emits at LEAST shell + lid; optionally extra named parts', () => {
    // Some templates legitimately add extra top-level nodes:
    //   - Hinge print-in-place pin (#92)            — id: hinge-pin
    //   - TPU gasket (#108)                          — id: gasket
    //   - Spring-cam latch arms (#109)               — id: latch-arm-<id>
    //   - Top-position boss flex bumpers (#111)      — id: bumper-<i>
    // The invariant we're protecting is that EVERY plan has shell + lid;
    // the open-ended set of extras is a feature, not a regression.
    for (const c of cases) {
      it(`${c.label}: nodes include shell + lid (extras allowed)`, () => {
        const plan = compileProject(c.build());
        const ids = plan.nodes.map((n) => n.id);
        expect(ids).toContain('shell');
        expect(ids).toContain('lid');
      });
    }
  });

  describe('Invariant 2: compileProject is pure — two calls produce structurally identical plans', () => {
    for (const c of cases) {
      it(`${c.label}: identical node count + ids on two calls`, () => {
        const a = compileProject(c.build());
        const b = compileProject(c.build());
        // Structural identity: same node IDs in the same order. Deep-equal
        // of BuildOp trees is too strict (mesh primitives carry
        // Float32Array buffers whose object identity legitimately differs)
        // but topology + cube/cylinder primitive sizes must match.
        expect(a.nodes.length).toBe(b.nodes.length);
        for (let i = 0; i < a.nodes.length; i++) {
          expect(a.nodes[i]!.id).toBe(b.nodes[i]!.id);
          expect(opSignature(a.nodes[i]!.op)).toBe(opSignature(b.nodes[i]!.op));
        }
      });
    }
  });

  describe('Invariant 3: shell bbox covers [0, 0, 0] → [outerX, outerY, outerZ]', () => {
    for (const c of cases) {
      it(`${c.label}: shell bbox is at least the case envelope`, () => {
        const project = c.build();
        const dims = computeShellDims(
          project.board,
          project.case,
          project.hats ?? [],
          () => undefined,
        );
        const plan = compileProject(project);
        const shell = plan.nodes.find((n) => n.id === 'shell')!;
        const bb = bboxOf(shell.op);
        // The shell body has cutouts (which bbox doesn't see — bboxOf
        // counts every primitive including subtractive ones), so the
        // bbox we compute is the UNION of the outer cube and any
        // protrusions / cutouts. The outer envelope must be inside.
        expect(bb.min[0]).toBeLessThanOrEqual(0);
        expect(bb.min[1]).toBeLessThanOrEqual(0);
        expect(bb.max[0]).toBeGreaterThanOrEqual(dims.outerX);
        expect(bb.max[1]).toBeGreaterThanOrEqual(dims.outerY);
        // Z is allowed to dip below 0 because mounting features extrude
        // outward from the -z face. So check max only.
        expect(bb.max[2]).toBeGreaterThanOrEqual(dims.outerZ);
      });
    }
  });

  describe('Invariant 4: smartCutoutDecisions are part of the plan output (#51)', () => {
    for (const c of cases) {
      it(`${c.label}: plan.smartCutoutDecisions is an array`, () => {
        const plan = compileProject(c.build());
        expect(Array.isArray(plan.smartCutoutDecisions)).toBe(true);
      });
    }
  });

  describe('Invariant 5: placementReport is attached to every plan (#51)', () => {
    for (const c of cases) {
      it(`${c.label}: plan.placementReport.issues is an array`, () => {
        const plan = compileProject(c.build());
        expect(plan.placementReport).toBeDefined();
        expect(Array.isArray(plan.placementReport!.issues)).toBe(true);
      });
    }
  });

  describe('Invariant 6: shell node tree contains no zero-extent cube / empty union / empty difference', () => {
    for (const c of cases) {
      it(`${c.label}: shell BuildPlan tree is well-formed`, () => {
        const plan = compileProject(c.build());
        const shell = plan.nodes.find((n) => n.id === 'shell')!;
        assertWellFormed(shell.op, `${c.label} shell`);
      });
    }
  });

  describe('Invariant 7: lid node tree is well-formed', () => {
    for (const c of cases) {
      it(`${c.label}: lid BuildPlan tree is well-formed`, () => {
        const plan = compileProject(c.build());
        const lid = plan.nodes.find((n) => n.id === 'lid')!;
        assertWellFormed(lid.op, `${c.label} lid`);
      });
    }
  });
});

/**
 * Topological signature of a BuildOp tree: the kind tree plus primitive
 * sizes (cube dims, cylinder height/radius/segments, mesh vertex+index
 * counts). Used to compare two plans without running into Float32Array
 * identity issues.
 */
function opSignature(op: BuildOp): string {
  switch (op.kind) {
    case 'cube':
      return `cube[${op.size.join(',')},c=${op.center ?? false}]`;
    case 'cylinder':
      return `cyl[h=${op.height},r=${op.radiusLow},s=${op.segments ?? 48}]`;
    case 'mesh':
      return `mesh[v=${op.positions.length / 3},t=${op.indices.length / 3}]`;
    case 'translate':
      return `t(${op.offset.join(',')})|${opSignature(op.child)}`;
    case 'rotate':
      return `r(${op.degrees.join(',')})|${opSignature(op.child)}`;
    case 'scale':
      return `s(${op.factor})|${opSignature(op.child)}`;
    case 'union':
    case 'difference':
    case 'intersection':
      return `${op.kind}[${op.children.map(opSignature).join('|')}]`;
  }
}

function assertWellFormed(op: BuildOp, ctx: string): void {
  if (op.kind === 'cube') {
    expect(op.size[0], `${ctx}: cube size.x`).toBeGreaterThan(0);
    expect(op.size[1], `${ctx}: cube size.y`).toBeGreaterThan(0);
    expect(op.size[2], `${ctx}: cube size.z`).toBeGreaterThan(0);
  } else if (op.kind === 'cylinder') {
    expect(op.height, `${ctx}: cylinder height`).toBeGreaterThan(0);
    expect(op.radiusLow, `${ctx}: cylinder radius`).toBeGreaterThan(0);
  } else if (op.kind === 'mesh') {
    expect(op.positions.length, `${ctx}: mesh positions length`).toBeGreaterThan(0);
    expect(op.positions.length % 3, `${ctx}: mesh positions multiple of 3`).toBe(0);
    expect(op.indices.length, `${ctx}: mesh indices length`).toBeGreaterThan(0);
    expect(op.indices.length % 3, `${ctx}: mesh indices multiple of 3`).toBe(0);
  }
  if (op.kind === 'union' || op.kind === 'difference' || op.kind === 'intersection') {
    expect(op.children.length, `${ctx}: ${op.kind} has children`).toBeGreaterThan(0);
    for (const c of op.children) assertWellFormed(c, `${ctx} > ${op.kind}`);
  }
  if ('child' in op && op.child) assertWellFormed(op.child, `${ctx} > ${op.kind}`);
}

/** Used only by Invariant 4's plan reference — referenced indirectly via
 *  the BuildPlan import; suppresses unused-import lint when fields used. */
function suppressUnused(p: BuildPlan): void {
  void p;
}
void suppressUnused;
