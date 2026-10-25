// #662 — the operation types, as one table: the wizard's first question, the Add-operation picker
// and every row's chip read it, so what each type MEANS is pinned here rather than three times.
//
// The set is the operations matrix's UI-reachable list (#663, docs/market-research/): Engrave,
// V-carve, Pocket, Profile, Hole, Thread, and Surface a mesh (the row the engine posts and the UI
// could not reach until now). Region types follow the cutter — the engine has one cutter per
// program, so a V-bit makes a V-carve and anything else a pocket.

import { describe, expect, it } from 'vitest';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  OPERATION_TYPES,
  addOperationOfType,
  jobHasOperations,
  operationTypeOfItem,
  regionChipLabel,
  regionOperationType,
} from '@/components/panels/operationTypes';

describe('#662 the operation types', () => {
  it('lists the matrix’s operations in the order the pickers show them', () => {
    expect(OPERATION_TYPES.map((t) => t.id)).toEqual([
      'engrave',
      'v-carve',
      'pocket',
      'profile',
      'hole',
      'thread',
      'surface',
    ]);
    // Every type says what it makes, and carries the picker's test id.
    for (const type of OPERATION_TYPES) {
      expect(type.label.length).toBeGreaterThan(0);
      expect(type.blurb.length).toBeGreaterThan(0);
      expect(type.addTestId.startsWith('engrave-add-')).toBe(true);
    }
  });

  it('names a region by the job’s cutter: a V-bit carves, anything else pockets', () => {
    expect(regionOperationType(true)).toBe('v-carve');
    expect(regionOperationType(false)).toBe('pocket');
    expect(regionChipLabel(undefined, 'v-carve')).toBe('V-carve');
    expect(regionChipLabel(undefined, 'pocket')).toBe('Pocket');
    // A through region is a profile whatever the cutter.
    expect(regionChipLabel(true, 'v-carve')).toBe('Profile');
    expect(regionChipLabel(true, 'pocket')).toBe('Profile');
  });

  it('maps every operation item onto its type', () => {
    expect(operationTypeOfItem({ kind: 'label' }, 'pocket')).toBe('engrave');
    expect(operationTypeOfItem({ kind: 'trace' }, 'pocket')).toBe('engrave');
    expect(operationTypeOfItem({ kind: 'stroke-label' }, 'pocket')).toBe('engrave');
    expect(operationTypeOfItem({ kind: 'rect' }, 'pocket')).toBe('pocket');
    expect(operationTypeOfItem({ kind: 'rect' }, 'v-carve')).toBe('v-carve');
    expect(operationTypeOfItem({ kind: 'circle', through: true }, 'pocket')).toBe('profile');
    expect(operationTypeOfItem({ kind: 'cutout' }, 'pocket')).toBe('profile');
    expect(operationTypeOfItem({ kind: 'drill' }, 'pocket')).toBe('hole');
    expect(operationTypeOfItem({ kind: 'drill-array' }, 'pocket')).toBe('hole');
    expect(operationTypeOfItem({ kind: 'thread' }, 'pocket')).toBe('thread');
    // Not operations: a construction item, a kept-out void, an unknown kind.
    expect(operationTypeOfItem({ kind: 'rect', construction: true }, 'pocket')).toBeNull();
    expect(operationTypeOfItem({ kind: 'keepout' }, 'pocket')).toBeNull();
    expect(operationTypeOfItem(null, 'pocket')).toBeNull();
  });

  it('knows a job with nothing to cut, and one with a goal mesh', () => {
    expect(jobHasOperations({})).toBe(false);
    expect(jobHasOperations({ labels: [], shapes: [], traces: [] })).toBe(false);
    expect(jobHasOperations({ labels: [{}] })).toBe(true);
    expect(jobHasOperations({ targetObject: { role: 'goal' } })).toBe(true);
    // A REFERENCE is not an operation: it is never cut.
    expect(jobHasOperations({ targetObject: { role: 'reference' } })).toBe(false);
  });

  it('creates the store item each type means', () => {
    // The same function both pickers call; the store's actions are stubbed so the MAPPING is the
    // assertion (the actions themselves are the store's own specs').
    const added: string[] = [];
    const before = useEngraveJobStore.getState();
    useEngraveJobStore.setState({
      addLabel: () => {
        added.push('label');
        return 'i1';
      },
      addShape: (kind: string) => {
        added.push(`shape:${kind}`);
        return 'i2';
      },
      addCutout: () => {
        added.push('cutout');
        return 'i3';
      },
      addDrill: (kind: string) => {
        added.push(`drill:${kind}`);
        return 'i4';
      },
      addThread: () => {
        added.push('thread');
        return 'i5';
      },
    } as unknown as Partial<typeof before>);
    try {
      expect(addOperationOfType('engrave')).toBe('i1');
      expect(addOperationOfType('v-carve')).toBe('i2');
      expect(addOperationOfType('pocket')).toBe('i2');
      expect(addOperationOfType('profile')).toBe('i3');
      expect(addOperationOfType('hole')).toBe('i4');
      expect(addOperationOfType('thread')).toBe('i5');
      expect(added).toEqual(['label', 'shape:rect', 'shape:rect', 'cutout', 'drill:drill', 'thread']);
    } finally {
      useEngraveJobStore.setState(before);
    }
  });
});
