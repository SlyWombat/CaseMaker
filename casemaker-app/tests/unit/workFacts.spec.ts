// #1103 — the work facts the Holding step's recommendation reads, from the question choice.
import { describe, expect, it } from 'vitest';

import { workFactsOf } from '@/components/welcome/workFacts';
import type { OperationChoice } from '@/components/welcome/OperationStep';
import type { StockProposal } from '@/engine/cnc/stockProposal';

const BLANK = { form: 'plate', material: 'hardwood', length: 75, width: 72.7, thickness: 20.1, finish: 'rough', sentence: '' } as StockProposal;

describe('#1103 the work facts', () => {
  it('a surfacing pass takes the mesh height', () => {
    const choice: OperationChoice = { type: 'surface', target: { size: { x: 65, y: 62.7, z: 19.1 } } as never };
    expect(workFactsOf(choice, BLANK)).toEqual({ deepestCutMm: 19.1, through: false, reachesEdgeWithinMm: 0 });
  });

  it('an engraving takes its depth and is not through', () => {
    const choice: OperationChoice = { type: 'engrave', text: 'hi', depth: 0.5, font: 'sans' as never };
    expect(workFactsOf(choice, BLANK)).toMatchObject({ deepestCutMm: 0.5, through: false });
  });

  it('a PCB and an outline profile are through the blank', () => {
    expect(workFactsOf({ type: 'pcb', imported: true }, BLANK)).toMatchObject({ deepestCutMm: 20.1, through: true });
    expect(
      workFactsOf({ type: 'outline', outline: {} as never, use: 'profile' }, BLANK),
    ).toMatchObject({ deepestCutMm: 20.1, through: true });
  });

  it('an outline pocket is a depth, not a through cut', () => {
    expect(workFactsOf({ type: 'outline', outline: {} as never, use: 'pocket', depth: 3 }, BLANK)).toMatchObject({
      deepestCutMm: 3,
      through: false,
    });
  });

  it('no choice is no work', () => {
    expect(workFactsOf(null, BLANK)).toEqual({ deepestCutMm: 0, through: false, reachesEdgeWithinMm: null });
  });
});
