/**
 * #964 — THE CUTTER SEQUENCE'S PROPERTY TEST (#961).
 *
 * On the seeded parts of `randomParts.ts`, planned through `planPocketsForTree` (plan.ts), three
 * rules the sequence must keep:
 *
 *   1. cutter count ≤ the card's vendor allowance + 1 — the plan's own `maxCutters` budget;
 *   2. a pocket is `unreachable` only when no cutter in the set can enter it — every unreachable
 *      finding must name a pocket whose narrowest opening is smaller than the smallest cutter's
 *      cutting diameter, and no pocket wide enough for the smallest cutter may be unreachable;
 *   3. the freeing contour is in the LAST program — whatever the rest chain does, the cut that
 *      frees the part runs after every pocket it could free it against.
 *
 * A failure names the seed and the numbers; it is a finding on #961.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart, type PartKind } from '../tools/randomParts';
import { planPocketsForTree, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { flatEndMill, cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';

const HOUSE: Tool[] = [
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 }),
  flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 }),
  flatEndMill(2, { number: 3, id: 'flat-2', name: 'flat-2', fluteLength: 30 }),
];
const MAX_CUTTERS = HOUSE.length + 1;
const SEEDS = [1, 2, 3, 4, 5] as const;
const KINDS: PartKind[] = ['rectilinear', 'filleted'];

function planOf(part: ReturnType<typeof buildRandomPart>): PlanPocketsResult {
  return planPocketsForTree(part.tree, {
    tabs: DEFAULT_RELEASE_TABS, offset: makeClipperOffset(tl),
    houseFlats: HOUSE,
    stepDownMm: 1.5,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    spindleRpm: 12000,
    air: true,
    maxCutters: MAX_CUTTERS,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
  });
}

const smallestDiameter = Math.min(...HOUSE.map((t) => cuttingDiameter(t) ?? Infinity));

describe('#964 the cutter sequence keeps its budget and its order (#961)', () => {
  for (const kind of KINDS) {
    for (const seed of SEEDS) {
      it(`${kind} seed ${seed}: budget, reachability and the freeing cut`, () => {
        const part = buildRandomPart(seed, kind, tl);
        const result = planOf(part);

        expect(
          result.sequence.length,
          `${kind} seed ${seed}: ${result.sequence.length} cutters for a ${MAX_CUTTERS}-cutter budget (${result.sequence.map((s) => s.cutterKey).join(', ')})`,
        ).toBeLessThanOrEqual(MAX_CUTTERS);

        const unreachable = result.unreachable.join(' | ');
        for (const node of part.tree.pockets) {
          const named = result.unreachable.some((u) => u.startsWith(`${node.id}:`));
          const fits = node.narrowest >= smallestDiameter - 1e-6;
          expect(
            named,
            `${kind} seed ${seed}: pocket ${node.id} (narrowest ${node.narrowest} mm) is ${named ? 'unreachable' : 'reachable'} against the smallest cutter ${smallestDiameter} mm; unreachable: ${unreachable || 'none'}`,
          ).toBe(!fits);
        }
        for (const message of result.unreachable) {
          const id = message.slice(0, message.indexOf(':'));
          const node = part.tree.pockets.find((n) => n.id === id);
          expect(node, `${kind} seed ${seed}: unreachable names an unknown pocket: ${message}`).toBeDefined();
          expect(
            node!.narrowest,
            `${kind} seed ${seed}: ${message} — but the smallest cutter is ${smallestDiameter} mm`,
          ).toBeLessThan(smallestDiameter);
        }

        const last = result.programs.at(-1)!;
        expect(
          last.ir.operations.some((op) => op.labelId === 'contour'),
          `${kind} seed ${seed}: the last program has no contour op (${result.programs.map((p) => p.cutterKey).join(' -> ')})`,
        ).toBe(true);
      }, 120_000);
    }
  }
});
