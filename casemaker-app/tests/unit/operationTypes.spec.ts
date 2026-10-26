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
      'v-carve-variable',
      'inlay',
      'pocket',
      'profile',
      'chamfer',
      'hole',
      'bore',
      'thread',
      'surface',
      'texture',
      'flute',
      'prism',
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
    // #665 — a region that asks for the medial-axis carve is its own operation, and only on a
    // job whose cutter makes a V-carve at all.
    expect(operationTypeOfItem({ kind: 'rect', vCarveDepth: 'variable' }, 'v-carve')).toBe('v-carve-variable');
    expect(operationTypeOfItem({ kind: 'rect', vCarveDepth: 'variable' }, 'pocket')).toBe('pocket');
    // #673 — an inlay half is its own operation whatever the cutter makes the row; the row says
    // which half, and a construction item never is one.
    expect(operationTypeOfItem({ kind: 'rect', inlay: { role: 'female' } }, 'v-carve')).toBe('inlay');
    expect(operationTypeOfItem({ kind: 'cutaway', inlay: { role: 'male' } }, 'v-carve')).toBe('inlay');
    expect(operationTypeOfItem({ kind: 'rect', inlay: { role: 'female' }, construction: true }, 'v-carve')).toBeNull();
    // #670 — a texture region is its own operation whatever the cutter makes of a plain region,
    // and the marker reads before the inlay one (the plan gives it precedence; `texture-shape`
    // refuses a region carrying both).
    expect(operationTypeOfItem({ kind: 'rect', texture: { pattern: 'stipple' } }, 'v-carve')).toBe('texture');
    expect(operationTypeOfItem({ kind: 'rect', texture: { pattern: 'scallop' } }, 'pocket')).toBe('texture');
    expect(operationTypeOfItem({ kind: 'rect', texture: { pattern: 'stipple' }, inlay: { role: 'female' } }, 'v-carve')).toBe('texture');
    expect(operationTypeOfItem({ kind: 'rect', texture: { pattern: 'stipple' }, construction: true }, 'v-carve')).toBeNull();
    // #674 — a fluted line is a flute; a prism region is a prism, and the prism reads first (the
    // plan gives its marker precedence; `prism-shape` refuses a region carrying two markers).
    expect(operationTypeOfItem({ kind: 'line', flute: {} }, 'pocket')).toBe('flute');
    expect(operationTypeOfItem({ kind: 'line' }, 'pocket')).toBe('engrave');
    expect(operationTypeOfItem({ kind: 'stroke-label' }, 'pocket')).toBe('engrave');
    expect(operationTypeOfItem({ kind: 'rect', prism: {} }, 'v-carve')).toBe('prism');
    expect(operationTypeOfItem({ kind: 'circle', prism: { baseMm: 2 } }, 'pocket')).toBe('prism');
    expect(operationTypeOfItem({ kind: 'rect', prism: {}, texture: { pattern: 'stipple' } }, 'v-carve')).toBe('prism');
    expect(operationTypeOfItem({ kind: 'rect', prism: {}, construction: true }, 'v-carve')).toBeNull();
    expect(operationTypeOfItem({ kind: 'circle', through: true }, 'pocket')).toBe('profile');
    expect(operationTypeOfItem({ kind: 'cutout' }, 'pocket')).toBe('profile');
    // #669 — a chamfer is its own operation on an item's outline.
    expect(operationTypeOfItem({ kind: 'chamfer' }, 'pocket')).toBe('chamfer');
    expect(operationTypeOfItem({ kind: 'drill' }, 'pocket')).toBe('hole');
    expect(operationTypeOfItem({ kind: 'drill-array' }, 'pocket')).toBe('hole');
    // #668 — a bore is the same item with `mode: 'bore'`: a hole whose width the job states, not
    // the cutter's.
    expect(operationTypeOfItem({ kind: 'drill', mode: 'bore' }, 'pocket')).toBe('bore');
    expect(operationTypeOfItem({ kind: 'drill-array', mode: 'bore' }, 'pocket')).toBe('bore');
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
      updateShape: (id: string, patch: Record<string, unknown>) => {
        added.push(`update:${id}:${JSON.stringify(patch)}`);
      },
      addCutout: () => {
        added.push('cutout');
        return 'i3';
      },
      addChamfer: () => {
        added.push('chamfer');
        return 'i6';
      },
      addDrill: (kind: string) => {
        added.push(`drill:${kind}`);
        return 'i4';
      },
      addThread: () => {
        added.push('thread');
        return 'i5';
      },
      addTrace: (kind: string) => {
        added.push(`trace:${kind}`);
        return 'i7';
      },
      updateTrace: (id: string, patch: Record<string, unknown>) => {
        added.push(`update:${id}:${JSON.stringify(patch)}`);
      },
    } as unknown as Partial<typeof before>);
    try {
      expect(addOperationOfType('engrave')).toBe('i1');
      expect(addOperationOfType('v-carve')).toBe('i2');
      // #665 — the variable type adds the same rect and switches its depth model.
      expect(addOperationOfType('v-carve-variable')).toBe('i2');
      expect(addOperationOfType('pocket')).toBe('i2');
      expect(addOperationOfType('profile')).toBe('i3');
      // #669 — Chamfer the edge adds a chamfer item.
      expect(addOperationOfType('chamfer')).toBe('i6');
      expect(addOperationOfType('hole')).toBe('i4');
      // #668 — Bore to size is the same `drill` item with the bore's mode; the store seeds the
      // diameter (its own spec proves the value).
      expect(addOperationOfType('bore')).toBe('i4');
      expect(addOperationOfType('thread')).toBe('i5');
      // #670 — Texture a surface adds a rect carrying a stipple marker.
      expect(addOperationOfType('texture')).toBe('i2');
      // #674 — Flute along a line adds a line with the marker; Raise a prism a rect with its own.
      expect(addOperationOfType('flute')).toBe('i7');
      expect(addOperationOfType('prism')).toBe('i2');
      expect(added).toEqual([
        'label',
        'shape:rect', // v-carve
        'shape:rect', // v-carve-variable's region…
        'update:i2:{"vCarveDepth":"variable"}', // …switched to the medial-axis depth
        'shape:rect', // pocket
        'cutout',
        'chamfer',
        'drill:drill',
        'drill:drill',
        'thread',
        'shape:rect', // texture
        'update:i2:{"texture":{"pattern":"stipple"}}',
        'trace:line', // flute
        'update:i7:{"flute":{}}',
        'shape:rect', // prism
        'update:i2:{"prism":{}}',
      ]);
    } finally {
      useEngraveJobStore.setState(before);
    }
  });
});
