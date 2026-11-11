// #1109 — every blocker names the field, the rule and a NUMBER TO TYPE (or the word type/pick), so
// a disabled button always proposes the way out.
import { describe, expect, it } from 'vitest';

import { operationCreateBlocked } from '@/components/welcome/operationCreate';
import { boxProblem } from '@/engine/cnc/stockStart';
import type { OperationChoice } from '@/components/welcome/OperationStep';
import type { SizedMachine } from '@/engine/cnc/machine';

const SUGGESTS = /\d|type|pick/i;

const CASES: [string, OperationChoice | null][] = [
  ['empty text', { type: 'engrave', text: '  ', depth: 0.5, font: 'sans' as never }],
  ['zero depth', { type: 'engrave', text: 'hi', depth: 0, font: 'sans' as never }],
  ['no mesh', { type: 'surface', target: null }],
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
    });
  }

  it('the stock size blocker proposes a number', () => {
    const message = boxProblem({ length: 0, width: 60, thickness: 12 }, MACHINE);
    expect(message).not.toBeNull();
    expect(message!).toMatch(SUGGESTS);
    expect(message!.charAt(0)).toBe(message!.charAt(0).toUpperCase());
  });
});
