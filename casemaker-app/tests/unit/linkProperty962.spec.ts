/**
 * #964 — THE LINKER'S PROPERTY TEST (#962).
 *
 * On the seeded parts of `randomParts.ts`, planned through `planPocketsForTree`: the material
 * state after every planned op is rebuilt from the ops' own `PassRef.cleared` regions (the same
 * record the linker is meant to consume), and every link between consecutive passes is checked:
 *
 *   - a RAPID returned by `link()` is at or above the region's clearance plane;
 *   - a FEED that TRAVELS IN XY (a stay-down link) is clear of standing material at its Z —
 *     `linkIsClear`, which samples the WHOLE cutter disc along the segment (C's condition on the
 *     interface). A vertical feed is the retract/plunge leg every op's own entry uses (the
 *     linker's stated contract: "every vertical leg at the plunge feed"); it is not a link
 *     across ground and is not judged as one.
 *
 * A failure names the seed, the op and the two points; it is a finding on #962.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart, type PartKind } from '../tools/randomParts';
import { planPocketsForTree, type PassRef, type PlannedOp } from '@/engine/cnc/cam/model/plan';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { flatEndMill, cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import { link, linkIsClear, type LinkOptions, type LinkPoint, type MaterialField } from '@/engine/cnc/cam/model/linking';
import type { Polygon } from '@/engine/cnc/cam/model/plan';
import type { CamMove } from '@/engine/cnc/cam/ir';

const HOUSE: Tool[] = [
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' }),
  flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' }),
  flatEndMill(2, { number: 3, id: 'flat-2', name: 'flat-2' }),
];
const SEEDS = [1, 2, 3, 4, 5] as const;
const KINDS: PartKind[] = ['rectilinear', 'filleted'];

function planOf(part: ReturnType<typeof buildRandomPart>) {
  return planPocketsForTree(part.tree, {
    offset: makeClipperOffset(tl),
    houseFlats: HOUSE,
    stepDownMm: 1.5,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    spindleRpm: 12000,
    air: true,
    maxCutters: HOUSE.length + 1,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
  });
}

function pointInRing(ring: Polygon, x: number, y: number): number {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c ? 1 : 0;
}

/** The material top from the ops' cleared regions: the highest cleared Z containing (x, y). */
function materialFrom(ops: readonly PlannedOp[], stockTop = 0): MaterialField {
  const regions: { z: number; boundary: Polygon[] }[] = [];
  for (const op of ops) {
    for (const pass of op.outcome.passes ?? []) {
      regions.push({ z: pass.z, boundary: pass.cleared.boundary });
    }
    for (const cleared of op.outcome.cleared ?? []) regions.push({ z: cleared.z, boundary: cleared.boundary });
  }
  return {
    topAt(x: number, y: number): number {
      let top = stockTop;
      for (const region of regions) {
        if (region.z <= top) continue;
        // Even-odd over the region's rings; a point inside any ring is inside the region.
        if (region.boundary.some((ring) => pointInRing(ring, x, y) === 1)) top = region.z;
      }
      return top;
    },
  };
}

const asPoint = (v: [number, number, number]): LinkPoint => ({ x: v[0], y: v[1], z: v[2] });

describe('#964 the linker never crosses standing material (#962)', () => {
  for (const kind of KINDS) {
    for (const seed of SEEDS) {
      it(`${kind} seed ${seed}: every link is a clearance rapid or a clear stay-down feed`, () => {
        const part = buildRandomPart(seed, kind, tl);
        const result = planOf(part);
        const material = materialFrom(result.ops);
        let checked = 0;
        for (const [index, op] of result.ops.entries()) {
          const passes: PassRef[] = op.outcome.passes ?? [];
          if (passes.length < 2) continue;
          const radius = (cuttingDiameter(op.outcome.ir.tool) ?? 2) / 2;
          const clearanceZ = Math.max(...passes.map((p) => p.z)) + 1;
          const opts: LinkOptions = {
            material,
            clearanceZ,
            tool: { radiusMm: radius },
            feeds: { feed: 1000, plungeFeed: 300 },
          };
          for (let i = 1; i < passes.length; i++) {
            const from = asPoint(passes[i - 1]!.exit);
            const to = asPoint(passes[i]!.entry);
            const moves = link(from, to, opts);
            let at = from;
            for (const move of moves as CamMove[]) {
              const next = { x: move.x, y: move.y, z: move.z };
              if (move.kind === 'rapid') {
                expect(
                  move.z,
                  `${kind} seed ${seed}, op ${index} (${op.region.id}), link ${i}: a rapid at ${move.z} is below the clearance ${clearanceZ}`,
                ).toBeGreaterThanOrEqual(clearanceZ - 1e-6);
              } else if (Math.hypot(next.x - at.x, next.y - at.y) > 1e-9) {
                expect(
                  linkIsClear(at, next, opts),
                  `${kind} seed ${seed}, op ${index} (${op.region.id}), link ${i}: a stay-down feed from ${JSON.stringify(at)} to ${JSON.stringify(next)} (r=${radius}) crosses standing material`,
                ).toBe(true);
              }
              at = next;
            }
            checked++;
          }
        }
        expect(checked, `${kind} seed ${seed}: no multi-pass op to test`).toBeGreaterThan(0);
      }, 120_000);
    }
  }
});
