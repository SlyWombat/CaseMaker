// Issue #120 — part registry. Every project's BuildPlan has a typed list
// of named parts (case body, lid, gasket, hinge pin, latch arms, bumpers).
// The visibility pulldown + export modal both read this list.

import { describe, it, expect } from 'vitest';
import {
  enumerateParts,
  partsByCategory,
  partForId,
  printMetaForId,
  PRINT_FLIP_NODE_IDS,
} from '@/engine/exporters/parts';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { findTemplate } from '@/library/templates';
import { createDefaultProject } from '@/store/projectStore';

describe('Part registry (#120)', () => {
  it('protective-case template enumerates the expected named parts', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const ids = parts.map((p) => p.id);
    expect(ids).toContain('shell');
    expect(ids).toContain('lid');
    expect(ids).toContain('gasket');
    // 2 latches in the template
    expect(ids.filter((id) => id.startsWith('latch-arm-')).length).toBe(2);
  });

  it('Pi 4B default project enumerates only shell + lid', () => {
    const project = createDefaultProject('rpi-4b');
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const ids = parts.map((p) => p.id).sort();
    expect(ids).toEqual(['lid', 'shell']);
  });

  it('classifies parts by material correctly', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const byId = new Map(parts.map((p) => [p.id, p] as const));
    expect(byId.get('shell')?.material).toBe('rigid');
    expect(byId.get('lid')?.material).toBe('rigid');
    expect(byId.get('gasket')?.material).toBe('flex');
  });

  it('partsByCategory groups in fixed order: case → gasket → fastener → accessory', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const groups = partsByCategory(parts);
    const categories = groups.map((g) => g.category);
    // case must precede gasket must precede fastener (when all three present)
    const casIdx = categories.indexOf('case');
    const gasIdx = categories.indexOf('gasket');
    const fasIdx = categories.indexOf('fastener');
    expect(casIdx).toBeLessThan(gasIdx);
    expect(gasIdx).toBeLessThan(fasIdx);
  });

  it('lid has flipForPrint = true (rim sits on bed when slicing)', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const lid = parts.find((p) => p.id === 'lid');
    expect(lid?.printOrientation.flipForPrint).toBe(true);
  });

  it('returns empty list for null/undefined plan', () => {
    expect(enumerateParts(null)).toEqual([]);
    expect(enumerateParts(undefined)).toEqual([]);
  });

  // Issue #154 — the print table is the single source of the flip, for the
  // exporter (PRINT_FLIP_NODE_IDS) and the UI (partForId().printOrientation).
  // These two used to disagree on the fused racks: the exporter flipped them
  // while the metadata said they did not need flipping.
  it('the flip table and partForId agree for every known id (#154 drift regression)', () => {
    const IDS = [
      'stand',
      'wall-body',
      'wall-plate',
      'shell',
      'lid',
      'gasket',
      'hinge-pin',
      'latch-arm-0',
      'latch-pin-0',
      'rack-side-left',
      'rack-side-right',
      'rack-top',
      'rack-bottom',
      'rack-wall-cleat',
      'rack-wall-spacer',
      'rack-assembled-frame',
      'rack-assembled-all',
      'rack-blank-0',
      'rack-shelf-0',
      'rack-keystone-0',
      'rack-cable-tray-0',
      'bumper-0',
      // Issue #148 — a split piece is named for its grid cell, so the table
      // has to match it by pattern. It prints AS MODELLED: floor on the bed
      // with the joint laps hanging below it, supported from the plate.
      'shell-split-a1',
      'shell-split-b2',
      'some-unknown-node',
    ];
    for (const id of IDS) {
      const inFlipSet = PRINT_FLIP_NODE_IDS.includes(id);
      expect(partForId(id).printOrientation.flipForPrint, `flip disagreement for ${id}`).toBe(
        inFlipSet,
      );
      expect(printMetaForId(id).flipForPrint, `meta disagreement for ${id}`).toBe(inFlipSet);
    }
  });

  it('flips exactly the lid, the bottom plate, the two fused racks and both badge parts', () => {
    expect([...PRINT_FLIP_NODE_IDS].sort()).toEqual(
      [
        'lid',
        'rack-assembled-all',
        'rack-assembled-frame',
        'rack-bottom',
        'badge-bottom',
        'badge-top',
      ].sort(),
    );
    // The top plate is the bottom plate turned over, so it is already
    // counterbore-up as modelled and must NOT be flipped.
    expect(PRINT_FLIP_NODE_IDS).not.toContain('rack-top');
  });

  it('the fused racks report flipForPrint=true (was the drift bug)', () => {
    for (const id of ['rack-assembled-frame', 'rack-assembled-all']) {
      expect(partForId(id).printOrientation.flipForPrint, id).toBe(true);
    }
  });

  it('carries structured supports, with a why whenever supports are needed (#154)', () => {
    expect(partForId('shell').supports).toBe('none');
    expect(partForId('gasket').supports).toBe('none');

    const frame = partForId('rack-assembled-frame');
    expect(frame.supports).toBe('buildplate-only');
    expect(frame.supportWhy).toBeTruthy();

    const whole = partForId('rack-assembled-all');
    expect(whole.supports).toBe('full');
    expect(whole.supportWhy).toBeTruthy();

    // Every id family too — a support call with no reason is the doc-drift
    // problem this issue is fixing.
    for (const id of ['shell', 'lid', 'rack-assembled-frame', 'rack-assembled-all', 'rack-shelf-0']) {
      const meta = printMetaForId(id);
      if (meta.supports !== 'none') expect(meta.supportWhy, id).toBeTruthy();
    }
  });

  // Issue #280 — the bare blank is a plain slab: it prints AS MODELLED, either face up, so it
  // must NOT be in the flip set (the set is asserted exactly above).
  it('the blank prints as modelled, with no flip and no invented supports (#280)', () => {
    expect(PRINT_FLIP_NODE_IDS).not.toContain('blank');
    const blank = partForId('blank');
    expect(blank.printOrientation.flipForPrint).toBe(false);
    expect(blank.supports).toBe('none');
    expect(blank.displayName).toBe('Blank');
  });

  it('suggests walls/infill only where the part is structural (#154)', () => {
    const shelf = partForId('rack-shelf-0');
    expect(shelf.walls).toBeGreaterThan(0);
    expect(shelf.infill).toBeGreaterThan(0);
    // A faceplate is not load-bearing; no suggestion should be invented.
    expect(partForId('rack-blank-0').walls).toBeUndefined();
    expect(partForId('rack-blank-0').infill).toBeUndefined();
  });
});
