/**
 * #1111 R2 — A TIE ON OUTCOME IS DECIDED BY STATED KEYS, NOT BY THE ORDER THE HOUSE ARRIVED IN.
 *
 * The app's and the CLI's owned sets are the same 35 cutters; they arrived in different orders (the
 * app's registry is catalogue-ordered, the CLI's inventory-ordered), and a pick that kept the first
 * equal-geometry candidate posted the same toolpath under different cutters' headers — the M1
 * tray's ⌀3.175 finish chose a 10 mm-flute metal ball on the app and the 22 mm on the CLI (#1093's
 * e2e found it).
 *
 * The keys, in this order: feeds measured on this machine (over a table row); the larger reach
 * margin (`fluteLength − deepest cut`, a cutter with no stated flute counting as 0); and finally the
 * registry key, lexical. The rank row names the keys it was decided on.
 *
 * RED before the change: `ballTieDecision`/`ballTieSentence` did not exist, equal candidates kept
 * the first measured, and the tray's two orders chose different balls.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import {
  ballTieDecision,
  ballTieSentence,
  planModelCam,
  type BallTieKeys,
  type ModelPlanInput,
} from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { EngraveTargetObject } from '@/types/engraveJob';

const keys = (over: Partial<BallTieKeys> = {}): BallTieKeys => ({
  measured: 0,
  margin: 10,
  key: 'inv:kz-ball-nose-3-175-22',
  ...over,
});

describe('#1111 R2 — the tie keys, in their stated order', () => {
  it('a row measured on this machine beats a table row, whatever the margins', () => {
    const measured = keys({ measured: 1, margin: 0.4, key: 'inv:kz-ball-nose-m-3-175-10' });
    const table = keys({ measured: 0, margin: 12.4 });
    expect(ballTieDecision(measured, table)).toBeGreaterThan(0);
    expect(ballTieDecision(table, measured)).toBeLessThan(0);
  });

  it('the larger reach margin wins when neither feeds row is measured', () => {
    const longFlute = keys({ margin: 12.4 });
    const shortFlute = keys({ margin: 0.4, key: 'inv:kz-ball-nose-m-3-175-10' });
    expect(ballTieDecision(longFlute, shortFlute)).toBeGreaterThan(0);
    expect(ballTieDecision(shortFlute, longFlute)).toBeLessThan(0);
  });

  it('the registry key is the last resort — lexically smaller wins — and equal is equal', () => {
    const a = keys({ key: 'inv:kz-ball-nose-3-175-22' });
    const b = keys({ key: 'inv:kz-ball-nose-m-3-175-10' });
    expect(ballTieDecision(a, b)).toBeGreaterThan(0);
    expect(ballTieDecision(b, a)).toBeLessThan(0);
    expect(ballTieDecision(a, keys({}))).toBe(0);
  });

  it('the sentence names what won: the measured row, or the two margins', () => {
    const ten: Tool = { ...flatEndMill(3.175, { id: '132112313810', name: 'metal 10' }), shape: 'ball', fluteLength: 10 };
    const twentyTwo: Tool = { ...flatEndMill(3.175, { id: '131012313822', name: 'plain 22' }), shape: 'ball', fluteLength: 22 };
    const marginSentence = ballTieSentence(twentyTwo, keys({ margin: 12.4 }), ten, keys({ margin: 0.4 }));
    expect(marginSentence).toContain('tie on leftover and cycle');
    expect(marginSentence).toContain('reach margin');
    expect(marginSentence).toContain('inv:kz-ball-nose-3-175-22');
    const measuredSentence = ballTieSentence(ten, keys({ measured: 1, margin: 0.4 }), twentyTwo, keys({ margin: 12.4 }));
    expect(measuredSentence).toContain('measured on this machine');
  });
});

describe('#1111 R2 — the tray’s ⌀3.175 finish is the same ball whichever way the house arrives', () => {
  const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
  const ten: Tool = { ...flatEndMill(3.175, { number: 3, id: '132112313810', name: 'metal 10' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 10 };
  const twentyTwo: Tool = { ...flatEndMill(3.175, { number: 4, id: '131012313822', name: 'plain 22' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 22 };

  async function plan(house: Tool[]): Promise<{ finishCutters: Set<string>; allCutters: Set<string>; rank: string | null }> {
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
    };
  }

  it('the 22 mm flute is chosen in both house orders, and the tie row names its reach margin', async () => {
    const tenFirst = await plan([flat6, ten, twentyTwo]);
    const longFirst = await plan([flat6, twentyTwo, ten]);
    for (const run of [tenFirst, longFirst]) {
      // The FINISH (and its pencil) run on the 22 mm ball whichever way the two arrived. The metal
      // 10 mm MAY still appear — it is the #965 rest ball — so only the finish ops name the pick.
      expect(run.finishCutters.has('131012313822'), 'the 22 mm ball cuts the finish').toBe(true);
      expect(run.finishCutters.has('132112313810'), 'the 10 mm metal ball is not the finish').toBe(false);
      if (run.rank !== null) expect(run.rank).toContain('reach margin');
    }
    // The tie is what decided the first order (the legacy append puts both same-diameter balls in
    // the rank); the second has one candidate of that diameter and needs no tie-break.
    expect(tenFirst.rank).toContain('tie on leftover and cycle');
    expect(longFirst.rank).toBeNull();
  }, 300_000);
});
