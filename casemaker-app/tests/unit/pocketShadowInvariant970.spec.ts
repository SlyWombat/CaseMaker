/**
 * #970's invariant, RE-PINNED FOR #1003's EXACT BOUND (#1031). Env-gated on the real tray STEP,
 * the same one `opsAcceptance959.spec.ts`'s acceptance cases use.
 *
 * The original pin asserted strict byte equality between the pocket programs planned with
 * `aboveMaterial` ON and OFF, on the premise that a column closes only under a downward-facing
 * facet (the old gate's `ceilingAboveMm`). #1003's bound (802d2be43) replaced that: a cell is
 * closed at level z when design of ANY facing stands above z inside it. The tray's scoops beside
 * pocket-6's −4.2 floor exercise exactly that without any overhang — measured on #1021, the floor
 * ring retreats from y 117.47 to 117.61 at the scoop corners — so strict equality is false by
 * design, and the old pin's own list of forbidden causes names the very geometry now correctly
 * closed.
 *
 * What is true, and pinned here:
 *  (a) SHADOW-ON NEVER CUTS WHAT SHADOW-OFF DID NOT: every feed cell of the ON run exists in the
 *      OFF run, and ON's swept floor there is at or above OFF's. (Cells are the 0.1 mm grid the
 *      acceptance's own stamp uses; the grid is anchored at the work frame's origin.)
 *  (b) EVERY DIFFERENCE CELL HAS DESIGN ABOVE ITS CUT LEVEL: where the OFF run's swept floor is
 *      below the ON run's, the design's own top surface at that XY stands above the level OFF cut
 *      to — the exact bound's own precondition. #970's over-clip bug cut where design did not
 *      stand above, and fails here.
 *  (c) THE TRAY'S DIFFERENCE IS PINNED AS NUMBERS with its cause: the count of those cells and the
 *      deepest design stand above the cut level, at the scoop bottoms at pocket-6's floor.
 *  (d) THE PLAIN STEPPED BLOCK KEEPS STRICT BYTE EQUALITY: a fixture with no standing design
 *      above any level, so #970's over-clip bug still has a red-first there.
 *
 * RED-FIRST for the re-pin: with 802d2be43's bound reverted, the ON run equals the OFF run on the
 * tray and the difference count reads 0, so (c) fails — the pin can tell the exact bound from the
 * old gate. The block case stays green either way.
 */
import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';
import { describe, expect, it } from 'vitest';
import { placedTree } from './helpers/trayAcceptance';

import { tl } from './helpers/manifoldExec';
import { recogniseFeatures } from '@/engine/cnc/cam/model/features';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { planPocketsForTree, type PlanPocketsOptions } from '@/engine/cnc/cam/model/plan';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { NO_SHOP } from '../tools/noShop';

const TRAY = process.env.CM_959_TRAY_STEP;

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const FLAT3175 = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 });

function pocketOptions(shadowMesh: PlanPocketsOptions['shadowMesh']): Omit<PlanPocketsOptions, 'offset'> {
  return {
    tabs: DEFAULT_RELEASE_TABS,
    houseFlats: [FLAT6, FLAT3175],
    stepDownMm: 1.5,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    spindleRpm: 12000,
    air: true,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    ...(shadowMesh === undefined ? {} : { shadowMesh }),
  };
}

const ctx: PostContext = {
  jobName: 'tray-invariant', stock: { length: 110, width: 140, thickness: 27.2 },
  materialName: 'hardwood', zDatum: 'probed-top-face', origin: 'topFrontLeft',
  camVersion: 'test-970', toolKey: 'multi',
};

const CELL_MM = 0.1;
/** The adjudication floor: a design stand below this is not a fact about the design. */
const MARGIN_MM = 0.05;

/** One run's swept top field: every posted program's exact stamp, folded by the lowest reach. */
function sweptField(goal: GoalHeightfield, programs: readonly { ir: ToolpathIR }[]): Float32Array {
  let acc: Float32Array | null = null;
  for (const { ir } of programs) {
    const posted = postZ1(ir, ctx, Z1);
    if (!posted.ok) throw new Error(`postZ1 refused: ${posted.errors.join('; ')}`);
    const parsed = parseGcode(posted.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error('the posted text carries no rectangular stock header');
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const stamp = exactSweptFieldTooled(goal, buildTimeline(parsed, setup, Z1), () => ir.tool);
    if (stamp === null) throw new Error(`no exact stamp for ${ir.tool.name}`);
    if (acc === null) acc = Float32Array.from(stamp.field);
    else for (let k = 0; k < acc.length; k++) if (stamp.field[k]! < acc[k]!) acc[k] = stamp.field[k]!;
  }
  if (acc === null) throw new Error('the run posted no programs');
  return acc;
}

describe.skipIf(TRAY === undefined)('#970/#1031 the real tray — shadow-on never cuts what shadow-off did not', () => {
  it('the ON run never cuts below the OFF run, and every difference cell has design above its cut level', async () => {
    const { tree, mesh, target } = await placedTree(TRAY!, [110, 140], -1.2);
    const goal = sampleGoalHeightfield(target, { maxCells: NO_SHOP.goalMaxCells, pitchMm: CELL_MM, stockTopZ: 0 });
    const offset = makeClipperOffset(tl);
    const withShadow = planPocketsForTree(tree, { offset, ...pocketOptions(mesh) });
    const withoutShadow = planPocketsForTree(tree, { offset, ...pocketOptions(undefined) });
    const on = sweptField(goal, withShadow.programs);
    const off = sweptField(goal, withoutShadow.programs);

    let differenceCells = 0;
    let materialCells = 0;
    let deepestStandMm = 0;
    const deeper: string[] = [];
    const airCells: { k: number; design: number; offZ: number }[] = [];
    for (let k = 0; k < on.length; k++) {
      if (goal.covered[k] !== 1) continue;
      const design = goal.z[k] as number;
      const onZ = on[k]!;
      const offZ = off[k]!;
      // (a) SHADOW-ON NEVER CUTS WHAT SHADOW-OFF DID NOT: never below it, at any cell.
      if (onZ < offZ - 1e-6) deeper.push(`cell ${k}: ON ${onZ.toFixed(4)} below OFF ${offZ.toFixed(4)}`);
      if (!(offZ < onZ - 1e-6)) continue;
      differenceCells++;
      // (b) A DIFFERENCE CELL WITH MATERIAL ABOVE ITS CUT LEVEL — the exact bound's own case: the
      // design stands above the level the OFF run cut to. (The 421 such cells on the tray stand at
      // most 0.003 mm above it: the scoop bottoms beside pocket-6's floor.)
      if (design > offZ - MARGIN_MM) {
        materialCells++;
        if (design - offZ > deepestStandMm) deepestStandMm = design - offZ;
        continue;
      }
      // THE AIR-PASS CLASS. The tray's deeper slots have design 3 mm BELOW the pocket floor: the
      // OFF ring passed over a void, and the ON run's retreat skipped that pass. No material
      // stands there, so this is not an over-clip — the exact bound's rule is about design ABOVE
      // the level — but it must be NAMED rather than silently allowed: if a difference cell's
      // design is not above its cut level and not one of these, the bound is closing where
      // nothing stands and (b) is broken.
      airCells.push({ k, design, offZ });
    }
    expect(deeper, deeper.slice(0, 8).join('\n')).toEqual([]);
    // Every air-pass cell is the deeper slot: design exactly the slot's own bottom, 3 mm below
    // the −4.2 floor the OFF run cut to. Anything else is an over-clip.
    const strays = airCells.filter((c) => Math.abs(c.design - (c.offZ - 3)) > 1e-3);
    expect(strays, strays.slice(0, 8).map((c) => `cell ${c.k}: design ${c.design.toFixed(4)} vs cut ${c.offZ.toFixed(4)}`).join('\n')).toEqual([]);
    // (c) THE TRAY'S DIFFERENCE, AS NUMBERS. Reverting 802d2be43's bound makes the count 0, so
    // this pin can tell the exact bound from the old gate; the block case below stays green.
    // RE-PINNED AGAIN BY #1251 (back to the values from before 6b4e8f560): 446 difference cells =
    // 421 material cells + 25 air-pass cells, deepest material stand 0.0029 mm. 6b4e8f560 (11-11)
    // had moved them to 400 / 400 / 0 / 0.0371 because the tray-top group's #1227 ring ran 0.001 mm
    // closer to the wall; #1251 puts the wall pass back at the plain radius, so the figures return
    // exactly. The 25 AIR-PASS CELLS are not a regression: they are the cells over the tray's deeper
    // slots, where the shadow-off ring passed over a void (design 3 mm BELOW the floor) and the
    // shadow-on run's retreat skipped that pass — no material stands there, and the strays check
    // above pins that each one is exactly the slot's own bottom.
    expect(differenceCells, 'the tray\'s difference — 0 means the exact bound is not in').toBe(446);
    expect(materialCells, 'difference cells with material standing above the cut level').toBe(421);
    expect(airCells.length, 'difference cells over the deeper slots (air passes)').toBe(25);
    expect(deepestStandMm, 'the deepest material stand above the cut level, mm').toBeCloseTo(0.0029, 3);
  }, 600_000);
});

describe('#1031 the plain stepped block — no standing design above any level', () => {
  it('posts byte-identical pocket text with the shadow check on or off', () => {
    // A 20 × 10 × 5 block with a 4-wide, 2-deep open step down its middle: every level's 2D
    // footprint already accounts for everything above it, so the exact bound changes nothing.
    const profile: [number, number][] = [[0, 0], [20, 0], [20, 5], [12, 5], [12, 3], [8, 3], [8, 5], [0, 5]];
    const y0 = 0, y1 = 10;
    const tris: [number, number, number][][] = [];
    const ring = (y: number, reverse: boolean): [number, number, number][] =>
      (reverse ? [...profile].reverse() : profile).map(([x, z]) => [x, y, z]);
    const cap = ring(y0, false);
    const cap1 = ring(y1, true);
    for (let i = 1; i < cap.length - 1; i++) tris.push([cap[0]!, cap[i]!, cap[i + 1]!]);
    for (let i = 1; i < cap1.length - 1; i++) tris.push([cap1[0]!, cap1[i]!, cap1[i + 1]!]);
    for (let i = 0; i < profile.length; i++) {
      const a = profile[i]!, b = profile[(i + 1) % profile.length]!;
      const a0: [number, number, number] = [a[0], y0, a[1]];
      const b0: [number, number, number] = [b[0], y0, b[1]];
      const a1: [number, number, number] = [a[0], y1, a[1]];
      const b1: [number, number, number] = [b[0], y1, b[1]];
      tris.push([a0, a1, b1], [a0, b1, b0]);
    }
    const positions = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => t.forEach((p, j) => positions.set(p, i * 9 + j * 3)));
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 2; i < positions.length; i += 3) { minZ = Math.min(minZ, positions[i]!); maxZ = Math.max(maxZ, positions[i]!); }
    // Place the block's top on the stock top (z = 0), the work frame's own datum.
    for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! - maxZ;
    const total = tris.length;
    const indices = new Uint32Array(total * 3);
    for (let i = 0; i < total * 3; i++) indices[i] = i;
    const mesh: ParsedMesh = { positions, indices, triangleCount: total, bbox: { min: [0, 0, minZ - maxZ], max: [20, 10, 0] } };
    const tree = recogniseFeatures({ triangles: mesh }, { up: [0, 0, 1], stockTop: 0 }, tl);
    expect(tree.pockets.length, 'the step is a pocket the chain must plan').toBeGreaterThan(0);
    const offset = makeClipperOffset(tl);
    const on = planPocketsForTree(tree, { offset, ...pocketOptions(mesh) });
    const off = planPocketsForTree(tree, { offset, ...pocketOptions(undefined) });
    const texts = (result: typeof on): string[] =>
      result.programs.map(({ ir }) => {
        const posted = postZ1(ir, ctx, Z1);
        return posted.ok ? posted.text : `REFUSED: ${posted.errors.join('; ')}`;
      });
    expect(texts(on)).toEqual(texts(off));
  }, 120_000);
});
