/**
 * #261 slice 2 — THE MODE SWITCH.
 *
 * `RackParams.mode` names the family: absent (or `'rack-16.5'`) is the printed-shelf rack this
 * archetype has always made, and `'u-mount'` is the 10″ standard's rails. The manager's condition
 * for the switch: THE PRINTED-SHELF PATH STAYS BYTE-IDENTICAL for an absent mode — pinned here on
 * the shipped mini-rack template, which carries accessories, notches and a wall option.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { findTemplate } from '@/library/templates';
import { projectSchema } from '@/store/projectSchema';
import type { Project } from '@/types';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The shipped 10″ printed-shelf template — a feature-heavy sample of the printed-shelf path. */
function rackProject(): Project {
  const tpl = findTemplate('mini-rack-10in');
  if (!tpl) throw new Error('mini-rack-10in template not found');
  return tpl.build();
}

function withMode(mode: 'rack-16.5' | 'u-mount', u?: number): Project {
  const project = rackProject();
  const rack = project.case.rack!;
  return {
    ...project,
    case: {
      ...project.case,
      rack: { ...rack, mode, ...(u === undefined ? {} : { u }) },
    },
  };
}

describe('#261 slice 2 the mode switch', () => {
  it('an absent mode is the printed-shelf rack, byte-identical (pinned on the shipped template)', () => {
    // Taken on this commit; the pin is the promise that the mode switch moved nothing on the path
    // every saved project uses.
    const PIN = 'a7f025d356257418';
    const absent = sha(JSON.stringify(compileProject(rackProject())));
    const explicit = sha(JSON.stringify(compileProject(withMode('rack-16.5'))));
    expect(absent).toBe(explicit);
    expect(absent).toBe(PIN);
  });

  it('u-mount mode builds the standard’s four parts and nothing of the printed-shelf family', () => {
    const plan = compileProject(withMode('u-mount', 6));
    const ids = plan.nodes.map((n) => n.id);
    expect(ids).toEqual(['umount-rail-left-6u', 'umount-rail-right-6u', 'umount-deck-6u', 'umount-blank-1u']);
    expect(ids.some((id) => id.startsWith('rack-'))).toBe(false);
  });

  it('u-mount mode defaults to 6U when the document names none', () => {
    const plan = compileProject(withMode('u-mount'));
    expect(plan.nodes.map((n) => n.id)).toContain('umount-rail-left-6u');
  });

  it('the document schema admits both modes, and 1–12 units', () => {
    const base = rackProject();
    const rack = base.case.rack!;
    expect(projectSchema.safeParse(base).success).toBe(true);
    expect(projectSchema.safeParse(withMode('u-mount', 6)).success).toBe(true);

    const bad = { ...base, case: { ...base.case, rack: { ...rack, mode: 'u-mount', u: 13 } } };
    expect(projectSchema.safeParse(bad).success).toBe(false);
    const zero = { ...base, case: { ...base.case, rack: { ...rack, mode: 'u-mount', u: 0 } } };
    expect(projectSchema.safeParse(zero).success).toBe(false);
  });
});
