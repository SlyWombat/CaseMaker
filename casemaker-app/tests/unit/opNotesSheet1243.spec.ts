/**
 * #1243 — EVERY OP'S NOTES REACH THE SHEET'S STATEMENTS, through one collection path.
 *
 * land18's finish op writes notes (the #960 wall-row lines, the #1033 join audit) and nothing read
 * them; #1206 gives the contour op notes too, with a contour-only route. `collectOpNotes` is the
 * one path both ride. The sheet prints the plan's `severity: 'sheet'` statements (runSheet.ts's
 * own filter), so a note that lands there is on the sheet.
 */
import { describe, expect, it } from 'vitest';

import {
  collectOpNotes,
  planModelCam,
  type ModelPlanInput,
  type OpOutcome,
  type PlannedOp,
} from '@/engine/cnc/cam/model/plan';
import type { PlanStatement } from '@/engine/cnc/cam/model/types';
import { buildRandomPart } from '../tools/randomParts';
import { flatEndMill } from '@/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

function opWithNotes(name: string, notes: string[] | undefined, kind: PlannedOp['kind'] = 'finish'): PlannedOp {
  return {
    kind,
    region: {
      id: name, kind: 'curved', bounds: { min: [0, 0], max: [1, 1] }, topZ: 0, bottomZ: -1,
      obstacles: [], regionClearanceZ: 2,
    },
    outcome: {
      ir: { operations: [{ name }] } as unknown as OpOutcome['ir'],
      cutter: 'x',
      passes: [],
      ...(notes === undefined ? {} : { notes }),
    },
  };
}

describe('#1243 collectOpNotes — one path, op order, repeats folded', () => {
  it('notes from two ops both appear, in op order, and a shared note folds with its count', () => {
    const statements: PlanStatement[] = [];
    collectOpNotes(
      [opWithNotes('op-a', ['shared note', 'first only']), opWithNotes('op-b', ['shared note', 'second only'])],
      statements,
    );
    expect(statements.map((s) => s.text)).toEqual(['shared note', 'first only', 'second only']);
    expect(statements[0]).toEqual({
      severity: 'sheet',
      code: 'plan-run',
      count: 2,
      ids: ['op-a', 'op-b'],
      text: 'shared note',
    });
    expect(statements[1]!.count).toBe(1);
    expect(statements[2]!.count).toBe(1);
    // Every one rides the sheet's own filter.
    expect(statements.every((s) => s.severity === 'sheet')).toBe(true);
  });

  it('an op with no notes contributes nothing, and a contour op’s note keeps #1206’s exact shape', () => {
    const statements: PlanStatement[] = [];
    collectOpNotes(
      [opWithNotes('pocket-op', undefined, 'pocket'), opWithNotes('contour-op', ['2 tabs asked, 2 placed'], 'contour')],
      statements,
    );
    expect(statements).toEqual([{ severity: 'sheet', code: 'plan-run', count: 1, text: '2 tabs asked, 2 placed' }]);
  });
});

const HOUSE = [
  flatEndMill(3.175, { number: 1, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 }),
  { ...flatEndMill(6, { number: 5, id: 'ball-6', name: 'ball-6' }), shape: 'ball' as const, typeText: 'Ball Nose', fluteLength: 30 },
];

/** The #1221/#986 'figure' fixture (seed 1): its ball finish writes both note kinds. */
function figureInput(): ModelPlanInput {
  const part = buildRandomPart(1, 'figure', tl);
  return {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: HOUSE, catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  } as unknown as ModelPlanInput;
}

describe('#1243 a real plan’s finish notes reach the sheet’s statements', () => {
  it('both the wall-row note and the join note are stated once each, unchanged', async () => {
    const plan = await planModelCam(figureInput());
    const opNotes = plan.perSetup.flatMap((s) => s.ops.flatMap((op) => op.outcome.notes ?? []));
    expect(opNotes.length, 'the fixture must write at least one note for this test to mean anything').toBeGreaterThan(0);
    const statements = plan.perSetup.flatMap((s) => s.statements);
    for (const note of opNotes) {
      const matching = statements.filter((st) => st.text === note);
      expect(matching, `the note "${note.slice(0, 40)}…" must be stated`).toHaveLength(1);
      expect(matching[0]!.severity).toBe('sheet'); // the sheet's own filter
      expect(matching[0]!.code).toBe('plan-run');
      expect(matching[0]!.count).toBe(opNotes.filter((n) => n === note).length);
    }
    // The wall-row note is among them (the fixture's own fact).
    expect(opNotes.some((n) => n.includes('raster row(s) over walls steeper'))).toBe(true);
  }, 300_000);
});
