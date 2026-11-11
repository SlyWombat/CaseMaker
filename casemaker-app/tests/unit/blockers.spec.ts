// #1109 — every blocker names the field, the rule and a NUMBER TO TYPE (or the word type/pick/try/
// choose), so a disabled button always proposes the way out. The old rule `/\d|type|pick/i` was
// satisfied by the 0 in "above 0 mm" — an accident, not a suggestion — so an explicit verb is
// required now.
import { describe, expect, it } from 'vitest';

import { blocker, operationCreateBlocked } from '@/components/welcome/operationCreate';
import { boxProblem } from '@/engine/cnc/stockStart';
import type { OperationChoice } from '@/components/welcome/OperationStep';
import type { SizedMachine } from '@/engine/cnc/machine';

const SUGGESTS = /type|pick|try|choose/i;

const CASES: [string, OperationChoice | null][] = [
  ['empty text', { type: 'engrave', text: '  ', depth: 0.5, font: 'sans' as never }],
  ['zero depth', { type: 'engrave', text: 'hi', depth: 0, font: 'sans' as never }],
  ['no mesh', { type: 'surface', target: null }],
  ['cutout without a length', { type: 'cutout', shape: 'rect', length: 0, width: 40, radius: 0 }],
  ['cutout without a width', { type: 'cutout', shape: 'rect', length: 60, width: 0, radius: 0 }],
  ['pocket without a length', { type: 'pocket', length: 0, width: 40, depth: 6 }],
  ['pocket without a width', { type: 'pocket', length: 60, width: 0, depth: 6 }],
  ['pocket without a depth', { type: 'pocket', length: 60, width: 40, depth: 0 }],
  ['outline pocket without depth', { type: 'outline', outline: {} as never, use: 'pocket', depth: 0 }],
  ['pcb not imported', { type: 'pcb', imported: false }],
  ['flute without length', { type: 'flute', lengthMm: 0 }],
  ['flat without depth', { type: 'flat', a: 0, depth: 0 }],
  ['too few faces', { type: 'faces-all-round', a: 0, count: 2, acrossFlats: 15 }],
  ['across flats zero', { type: 'faces-all-round', a: 0, count: 6, acrossFlats: 0 }],
  ['cross-hole without diameter', { type: 'cross-hole', a: 0, diameter: 0 }],
];

const MACHINE = {
  name: 'Z1',
  envelope: {
    x: { min: 0, max: 200 },
    y: { min: 0, max: 200 },
    z: { min: 0, max: 100 },
  },
} as unknown as SizedMachine;

describe('#1109 every blocker proposes a value', () => {
  for (const [name, choice] of CASES) {
    it(`${name} names the field and a value`, () => {
      const message = operationCreateBlocked(choice);
      expect(message, name).not.toBeNull();
      expect(message!, name).toMatch(SUGGESTS);
      // #1109 item 2 — a NUMERIC blocker is built through blocker(): "<Field> needs <rule> — …".
      // The action-worded gates ("Type the text…", "Pick the mesh…") keep the branch's sentences.
      if (!/^(Type|Pick|Give|Faces)/.test(message!)) expect(message!, name).toMatch(/needs .+ — .+\.$/);
    });
  }

  it('the cut-out card proposes its own decided defaults (item 3)', () => {
    expect(operationCreateBlocked({ type: 'cutout', shape: 'rect', length: 0, width: 40, radius: 0 })).toBe(
      'The shape needs a length above 0 — type a number in mm (for example 60).',
    );
    expect(operationCreateBlocked({ type: 'cutout', shape: 'rect', length: 60, width: 0, radius: 0 })).toBe(
      'The shape needs a width above 0 — type a number in mm (for example 40).',
    );
    expect(operationCreateBlocked({ type: 'pocket', length: 60, width: 40, depth: 0 })).toBe(
      'The pocket depth needs a size above 0 — type a number in mm (for example 6).',
    );
  });

  it('hex on a ⌀20 rod: up to 17 mm; try 15 (item 4)', () => {
    const message = operationCreateBlocked(
      { type: 'faces-all-round', a: 0, count: 6, acrossFlats: 0 },
      { rodDiameterMm: 20 },
    );
    expect(message).toBe('Across flats needs a size — the rod is ⌀20, so up to 17 mm; try 15.');
  });

  it('the stock size blocker proposes the field’s own number', () => {
    const message = boxProblem({ length: 0, width: 60, thickness: 12 }, MACHINE);
    expect(message).toBe('Length needs a size above 0 — type a number in mm (for example 80).');
    expect(message!.charAt(0)).toBe(message!.charAt(0).toUpperCase());
  });

  it('blocker() is the one shape', () => {
    expect(blocker('Depth', 'a size above 0', 'type a number in mm (for example 3)')).toBe(
      'Depth needs a size above 0 — type a number in mm (for example 3).',
    );
  });
});
