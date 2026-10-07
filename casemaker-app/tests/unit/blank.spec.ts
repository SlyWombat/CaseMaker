import { describe, it, expect } from 'vitest';

import { BLANK_NODE_ID, blankOutline, buildBlankNodes } from '@/engine/compiler/blank';
import { derivedKind } from '@/engine/compiler/archetype';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { blankParamsProblem, defaultBlankParams } from '@/types/blank';
import { findTemplate } from '@/library/templates';
import { createDefaultProject } from '@/store/projectStore';
import { parseProject, serializeProject } from '@/store/persistence';
import { exec } from './helpers/manifoldExec';

/**
 * Issue #280 — the bare blank: the "just cut something" archetype.
 *
 * It is the weakest archetype claim in the project (no board, no cavity, no lid), so the tests
 * below are about two things only: that the geometry is exactly one plate in the frame the engrave
 * hand-off assumes, and that the archetype loses to every richer shape and survives a round trip.
 */

const DEFAULTS = defaultBlankParams();

function meshOf(params = DEFAULTS) {
  const node = buildBlankNodes(params)![0]!;
  return exec(node.op);
}

describe('#280 — blank geometry', () => {
  it('emits exactly one node, one connected solid', () => {
    const nodes = buildBlankNodes(DEFAULTS)!;
    expect(nodes.map((n) => n.id)).toEqual([BLANK_NODE_ID]);
    const m = meshOf();
    try {
      const parts = m.decompose();
      expect(parts.length, 'the blank is one connected solid').toBe(1);
      parts.forEach((p) => p.delete());
    } finally {
      m.delete();
    }
  });

  it('centres the outline on the origin and grounds it at z = 0', () => {
    const m = meshOf();
    try {
      const bb = m.boundingBox();
      expect(bb.min[0]).toBeCloseTo(-DEFAULTS.width / 2, 6);
      expect(bb.max[0]).toBeCloseTo(DEFAULTS.width / 2, 6);
      expect(bb.min[1]).toBeCloseTo(-DEFAULTS.height / 2, 6);
      expect(bb.max[1]).toBeCloseTo(DEFAULTS.height / 2, 6);
      expect(bb.min[2]).toBeCloseTo(0, 6);
      expect(bb.max[2]).toBeCloseTo(DEFAULTS.thickness, 6);
    } finally {
      m.delete();
    }
  });

  it('carries the analytic volume, corner radii included', () => {
    const area = DEFAULTS.width * DEFAULTS.height - (4 - Math.PI) * DEFAULTS.cornerRadius ** 2;
    const m = meshOf();
    try {
      // 5 mm³ — the kernel chords the corner arcs at its own segment count, as it does for the
      // badge (`badge.spec.ts`), so the prism is not the analytic one to the last decimal.
      expect(Math.abs(m.volume() - area * DEFAULTS.thickness)).toBeLessThan(5);
    } finally {
      m.delete();
    }
  });

  it('blankOutline is a translate — the origin-centred convention fromBadge/fromBlank assume', () => {
    expect(blankOutline(DEFAULTS).kind).toBe('p-translate');
  });

  it('drops the corner radius rather than emitting a degenerate outline', () => {
    const square = meshOf(defaultBlankParams({ cornerRadius: 0 }));
    try {
      // 100 × 60 exactly, with no rounded corners to undershoot.
      expect(Math.abs(square.volume() - 100 * 60 * 12)).toBeLessThan(1);
    } finally {
      square.delete();
    }
  });

  it('refuses an unbuildable parameter set rather than emitting junk', () => {
    expect(buildBlankNodes(defaultBlankParams({ width: 0 }))).toBeNull();
    expect(buildBlankNodes(defaultBlankParams({ height: -1 }))).toBeNull();
    expect(buildBlankNodes(defaultBlankParams({ thickness: 0 }))).toBeNull();
  });
});

describe('#280 — blankParamsProblem', () => {
  it('passes the shipped defaults', () => {
    expect(blankParamsProblem(DEFAULTS)).toBeNull();
  });

  it('names the half-the-shorter-side limit the profile builder clamps at', () => {
    expect(blankParamsProblem(defaultBlankParams({ width: 0 }))).toMatch(/width/);
    expect(blankParamsProblem(defaultBlankParams({ height: 0 }))).toMatch(/height/);
    expect(blankParamsProblem(defaultBlankParams({ thickness: 0 }))).toMatch(/thickness/);
    expect(blankParamsProblem(defaultBlankParams({ cornerRadius: -1 }))).toMatch(/negative/);
    // 30 is exactly half of 60 — the inner rectangle collapses to zero height there.
    expect(blankParamsProblem(defaultBlankParams({ cornerRadius: 30 }))).toMatch(/too big/);
    expect(blankParamsProblem(defaultBlankParams({ cornerRadius: 29.9 }))).toBeNull();
  });
});

describe('#280 — archetype dispatch', () => {
  it('is the LAST claim: rack > stand > badge > insert > blank > shell', () => {
    const base = createDefaultProject('rpi-4b');
    expect(derivedKind(base)).toBe('shell');
    expect(derivedKind(findTemplate('blank')!.build())).toBe('blank');

    const blankCase = { ...base.case, blank: defaultBlankParams() };
    const insert = findTemplate('tool-insert')!.build().case.insert!;
    const badge = findTemplate('badge-blank')!.build().case.badge!;
    const stand = findTemplate('guition-desk-stand')!.build().case.stand!;
    const rack = findTemplate('mini-rack-10in')!.build().case.rack!;

    // Every richer shape beats it...
    expect(derivedKind({ ...base, case: { ...blankCase, insert } })).toBe('insert');
    expect(derivedKind({ ...base, case: { ...blankCase, badge } })).toBe('badge');
    expect(derivedKind({ ...base, case: { ...blankCase, stand } })).toBe('stand');
    expect(derivedKind({ ...base, case: { ...blankCase, rack } })).toBe('rack');
    // ...and a disabled blank is not a claim at all.
    expect(derivedKind({ ...base, case: { ...base.case, blank: { ...DEFAULTS, enabled: false } } })).toBe('shell');
  });

  it('the template compiles to exactly one plate, centred, with a clean report', () => {
    const plan = compileProject(findTemplate('blank')!.build());
    expect(plan.nodes.map((n) => n.id)).toEqual([BLANK_NODE_ID]);
    expect(plan.placementReport!.errorCount).toBe(0);
  });

  it('reports an unbuildable blank instead of crashing', () => {
    const project = findTemplate('blank')!.build();
    project.case.blank = defaultBlankParams({ width: 0 });
    const plan = compileProject(project);
    // It falls through to the shell rather than emitting a degenerate plate...
    expect(plan.nodes.some((n) => n.id === BLANK_NODE_ID)).toBe(false);
    // ...and the placement report says why.
    const issue = plan.placementReport!.issues.find((i) => i.kind === 'blank-config');
    expect(issue, 'a blank-config issue is reported').toBeDefined();
    expect(issue!.severity).toBe('error');
  });
});

describe('#280 — case.blank survives storage (the Zod strip trap)', () => {
  it('a default project has no blank at all', () => {
    expect(createDefaultProject('rpi-4b').case.blank).toBeUndefined();
  });

  it('round-trips through serializeProject/parseProject', () => {
    const project = findTemplate('blank')!.build();
    expect(project.case.blank?.enabled).toBe(true);
    const parsed = parseProject(serializeProject(project));
    // Without a `caseParamsSchema` entry this is undefined — a field on a TypeScript type with no
    // Zod entry is stripped on load, with no error anywhere.
    expect(parsed.case.blank).toEqual(project.case.blank);
    expect(derivedKind(parsed)).toBe('blank');
  });
});
