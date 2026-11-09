/**
 * #1111/#1114 — THE PLAN'S PICKS AMONG EQUALS, ON THE ENGINE.
 *
 * The key-level cases (the reach-margin gate, the shortest sufficient flute, the key) live in
 * `pickAmongEquals.spec.ts`. This file proves the plan uses them:
 *
 *  - the M1 tray's two ⌀3.175 balls, in either house order, end on the same ball — at a shallow cut
 *    both pass the gate and the SHORTER FLUTE wins (the stiffest adequate tool);
 *  - a part with two same-diameter flats picks by the same rule — the shorter sufficient flute —
 *    and the sheet states the decider.
 *
 * RED before #1111: the two house orders chose different balls (the first in arrival order), and a
 * same-diameter flat was chosen by list position with nothing stated.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { EngraveTargetObject } from '@/types/engraveJob';

describe('#1111 R2 — the tray’s ⌀3.175 finish is the same ball whichever way the house arrives', () => {
  const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
  const ten: Tool = { ...flatEndMill(3.175, { number: 3, id: '132112313810', name: 'metal 10' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 10 };
  const twentyTwo: Tool = { ...flatEndMill(3.175, { number: 4, id: '131012313822', name: 'plain 22' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 22 };

  const flat25: Tool = { ...flatEndMill(3.175, { number: 5, id: 'inv:kz-o-flute-3-175-25', name: '25 mm O-flute' }), fluteLength: 25 };
  const flat12: Tool = { ...flatEndMill(3.175, { number: 6, id: 'inv:kz-o-flute-m-3-175-12', name: '12 mm O-flute' }), fluteLength: 12 };

  async function plan(house: Tool[]): Promise<{ finishCutters: Set<string>; allCutters: Set<string>; rank: string | null; notes: string; primaryCutter: string | null }> {
    const part = buildRandomPart(1, 'sloped', tl);
    const stl = buildBinaryStl([{ positions: part.mesh.positions, indices: part.mesh.indices }]);
    const bytes = Buffer.from(stl);
    const target: EngraveTargetObject = {
      id: 'fixture-1111',
      name: 'sloped',
      format: 'stl',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      data: bytes.toString('base64'),
      size: { x: part.stock.length, y: part.stock.width, z: part.stock.thickness },
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    };
    const input: ModelPlanInput = {
      geometry: { triangles: part.mesh },
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
      stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house, catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0 },
      goal: sampleGoalHeightfield(target, { pitchMm: 0.1, stockTopZ: 0 }),
    };
    const output = await planModelCam(input);
    const ops = output.perSetup.flatMap((s) => s.ops);
    return {
      // The finish and the pencil are the chosen ball's own ops (#965's rest is a DIFFERENT ball,
      // so the rest's cutter must not be read as the finish).
      finishCutters: new Set(ops.filter((op) => op.kind === 'finish' || op.kind === 'pencil').map((op) => op.outcome.cutter)),
      allCutters: new Set(ops.map((op) => op.outcome.cutter)),
      rank: output.perSetup.flatMap((s) => s.notes).find((n) => n.startsWith('ball rank')) ?? null,
      notes: output.perSetup.flatMap((s) => s.notes).join('\n'),
      primaryCutter: output.perSetup[0]?.sequence[0]?.cutterKey ?? null,
    };
  }

  it('the same ball is chosen in both house orders, and the tie row says what decided it', async () => {
    const tenFirst = await plan([flat6, ten, twentyTwo]);
    const longFirst = await plan([flat6, twentyTwo, ten]);
    // This fixture is 10 mm thick: BOTH 3.175 balls pass the 1.0 mm gate (10 mm and 22 mm of flute
    // against a 4.7 mm cut), so the SHORTER FLUTE wins — 132112313810 (10 mm) over 131012313822
    // (22 mm) — whichever way they arrived (#1114: the stiffest adequate tool). The tray's own
    // 9.613 mm cut is the gate case (the 10 mm ball's 0.387 mm margin fails), pinned with the keys
    // in `pickAmongEquals.spec.ts`.
    for (const run of [tenFirst, longFirst]) {
      expect(run.finishCutters.has('132112313810'), 'the shortest sufficient ball cuts the finish').toBe(true);
      expect(run.finishCutters.has('131012313822'), 'the other ball is not the finish').toBe(false);
    }
    // Where the rank ties, the row names the decider.
    const ranked = [tenFirst, longFirst].filter((run) => run.rank !== null);
    expect(ranked.length, 'the two-ball rank ran').toBeGreaterThan(0);
    for (const run of ranked) {
      expect(run.rank).toContain('tie on leftover and cycle');
      expect(run.rank).toContain('shortest sufficient flute');
    }
  }, 300_000);

  it('a same-diameter flat tie picks the shorter sufficient flute, and the sheet states the decider', async () => {
    // Two ⌀3.175 flats; both reach the part's remainder, so the 12’s shorter flute wins over the
    // 25’s (#1114). The row states the decider instead of a pending policy.
    const run = await plan([flat25, flat12, twentyTwo]);
    expect(run.primaryCutter).toBe('inv:kz-o-flute-m-3-175-12');
    expect(run.notes).toContain('same diameter');
    expect(run.notes).toContain('shortest sufficient flute');
  }, 300_000);
});
