/**
 * The tray through the app path: the goal’s chamfer reaches the rim stage.
 *
 * #1180 — SPLIT FROM opsAcceptance959.spec.ts so this case runs in its own worker. The part and
 * helpers come from `helpers/trayAcceptance.ts`; the describe is moved verbatim.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { planModelCam } from '@/engine/cnc/cam/model/plan';
import {
  BALL6, CHAMFER3175, EDGE_BREAK_LEG_MM, VENDOR_SET,
  placedTree } from './helpers/trayAcceptance';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildModelPlanInputForGoal, postModelPlan, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';

import { TRAY_STEP, installAcceptanceCatalogue, clearAcceptanceCatalogue } from './helpers/trayAcceptance';


installAcceptanceCatalogue();
const TRAY = TRAY_STEP;
afterAll(() => clearAcceptanceCatalogue());

describe.skipIf(TRAY === undefined)('#989 — the tray through the app path: the goal’s chamfer reaches the rim stage', () => {
  it('posts the pinned V’s chamfer program, every feed one leg below a tray rim, the top rim included', async () => {
    const placed = await placedTree(TRAY!, [110, 140], -1.2);
    const thickness = placed.tree.frame.stockTop - placed.tree.frame.partBottom;
    // `placedTree` puts the tray's top face at `modelTop` in the work frame (Z 0 = stock top).
    const topZ = -1.2;
    const goal: EngraveTargetObject = {
      ...placed.target,
      name: 'tray-70-app-path-989',
      chamfer: { widthMm: EDGE_BREAK_LEG_MM, toolKey: `inv:${CHAMFER3175.id}` },
    };
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [],
      name: goal.name,
      targetObject: goal,
      toolKey: '',
      tool: BALL6,
      stock: { ...base.stock, length: 110, width: 140, thickness, material: 'hardwood' },
    };
    const shop: EngraveShopOpts = {
      tools: VENDOR_SET.map((t) => ({ key: `inv:${t.id}`, tool: t, provenance: 'test' })),
      feeds: null,
    };
    {
      const t0 = performance.now();
      // #1004 — the literal production steps with the card's single setup: build the seam's input,
      // edit its setup list, plan, then post-and-verify through the extracted tail.
      const input = await buildModelPlanInputForGoal(job, goal, BALL6, shop);
      input.setups = [{ frame: { up: [0, 0, 1], stockTop: 0 }, underside: 'flatOnStockBottom' }];
      const output = await planModelCam(input);
      const out = await postModelPlan(job, goal, BALL6, null, shop, output, {
        goalFindings: [],
        reachFindings: [],
        coverageFindings: [],
        modelRoughFindings: [],
        chamferFindings: [],
      });
      // The run's own facts, printed so the acceptance comment can quote them.
      const chamferOps = (out.plan?.perSetup ?? []).flatMap((s) => s.ops.filter((o) => o.kind === 'chamfer'));
      console.log(
        `#989 tray app path: ${((performance.now() - t0) / 1000).toFixed(1)} s, programs [${out.programs.map((p) => p.toolKey).join(', ')}], ` +
          `chamfer ops [${chamferOps.map((o) => `${o.region.id}@${o.region.topZ}`).join(', ')}]`,
      );
      expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
      // THE POINT OF #989: the rim stage planned chamfer ops at all (before the seam carried the
      // goal's chamfer there were none), and the TOP face rims are among them. Pinned to the
      // measured set — 26 top-face rims plus the tray's lower rim (rim-33 at z = −4.2), 27 in
      // all. #994 re-pinned the STL rows in this file from 41 to 27 chamfer ops (its modelled-
      // chamfer rule stops cutting a fillet's facets — rim-38…rim-51); this case was left at the
      // pre-#994 40/41 and is re-pinned here to the same 27, naming #994. A regression to
      // fewer-but-nonzero ops still fails, not just to zero.
      const TOP_RIM_OPS = 26;
      expect(chamferOps.length, `chamfer ops: ${chamferOps.map((o) => `${o.region.id}@${o.region.topZ}`).join(', ')}`).toBe(TOP_RIM_OPS + 1);
      const topRimOps = chamferOps.filter((o) => Math.abs(o.region.topZ - topZ) < 0.01);
      expect(topRimOps.length, `top-face chamfer ops: ${topRimOps.map((o) => o.region.id).join(', ')}`).toBe(TOP_RIM_OPS);
      expect(
        chamferOps.some((o) => o.region.id === 'rim-33' && Math.abs(o.region.topZ - -4.2) < 0.01),
        'the tray’s lower rim (rim-33 at z = −4.2) is no longer broken',
      ).toBe(true);
      // The V program exists at all. Before the seam carried the goal's chamfer there was none,
      // whatever the plan did with the rest of the part.
      // #1032 — a POSTED program names its registry key (this shop's own `inv:…` row), while the
      // plan's IR keeps `cutterKeyOf` (`tool.id ?? tool.name`); read each where it lives.
      const vCutterKey = CHAMFER3175.id!;
      const vKey = `inv:${vCutterKey}`;
      const vPrograms = out.programs.filter((p) => p.toolKey === vKey);
      expect(vPrograms.length, `programs: ${out.programs.map((p) => p.toolKey).join(', ')}`).toBe(1);
      // Every feed on the V run is one leg below a rim's own z; the TOP rim's plane is `topZ`,
      // so the V run reaches topZ − leg and never cuts above it.
      const vFeedZs: number[] = [];
      for (const setup of out.plan?.perSetup ?? []) {
        for (const ir of setup.programs) {
          if ((ir.tool.id ?? ir.tool.name) !== vCutterKey) continue;
          for (const op of ir.operations) for (const m of op.moves) if (m.kind === 'feed') vFeedZs.push(m.z);
        }
      }
      expect(vFeedZs.length).toBeGreaterThan(4);
      const shallowest = vFeedZs.reduce((a, z) => Math.max(a, z), -Infinity);
      expect(shallowest).toBeCloseTo(topZ - EDGE_BREAK_LEG_MM, 6);
      for (const z of vFeedZs) expect(z).toBeLessThanOrEqual(topZ - EDGE_BREAK_LEG_MM + 1e-6);
    }
  }, 1_800_000);
});
