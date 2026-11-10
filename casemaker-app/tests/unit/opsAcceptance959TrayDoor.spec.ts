/**
 * The tray imported at the door (B-rep faces, the card's numbers) AND the app path that plans it:
 * ONE plan, two assertion sets.
 *
 * #1180 — the door case (#991) and the app-path case (#989, formerly
 * opsAcceptance959TrayApp.spec.ts) planned the SAME tuple in two files: same tray STEP placement
 * (110×140, top −1.2), same single card setup, same tool (BALL6) and the same shop (the vendor set
 * mapped to `inv:<id>`, no feeds), same 0.5 mm edge break. The goal objects differed only in
 * id/name/sha, which the planner does not consume. The plan now runs once in `beforeAll`; both
 * assertion sets read it. The part and helpers come from `helpers/trayAcceptance.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planModelCam, type ModelPlanOutput } from '@/engine/cnc/cam/model/plan';
import {
  BALL6, CARD_SETUPS, CHAMFER3175, EDGE_BREAK_LEG_MM, SHOP_991 } from './helpers/trayAcceptance';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { readTargetObjectFile } from '@/engine/import/targetObject';
import { buildModelPlanInputForGoal, postModelPlan, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';

import { TRAY_STEP, installAcceptanceCatalogue, clearAcceptanceCatalogue } from './helpers/trayAcceptance';

installAcceptanceCatalogue();
const TRAY = TRAY_STEP;
afterAll(() => clearAcceptanceCatalogue());

interface SharedPlan {
  input: Awaited<ReturnType<typeof buildModelPlanInputForGoal>>;
  output: ModelPlanOutput;
  setup: ModelPlanOutput['perSetup'][number];
  job: EngraveJob;
  goal: EngraveTargetObject;
  shop: EngraveShopOpts;
}

let shared: SharedPlan | null = null;

beforeAll(async () => {
  if (TRAY === undefined) return;
  const bytes = fs.readFileSync(TRAY);
  const read = await readTargetObjectFile(new File([bytes], path.basename(TRAY)), 'tray-991');
  expect(read.ok, read.ok ? '' : read.error).toBe(true);
  if (!read.ok) return;
  expect(read.faceId, 'the door dropped the STEP face ids').toBeDefined();
  const size = read.size;
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format as EngraveTargetObject['format'],
    sha256: read.sha256,
    data: read.data,
    faceId: read.faceId,
    size,
    position: { x: 55, y: 70, z: -1.2 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    chamfer: { widthMm: EDGE_BREAK_LEG_MM, toolKey: `inv:${CHAMFER3175.id}` },
  };
  const base = defaultEngraveJob();
  const job: EngraveJob = {
    ...base,
    labels: [],
    shapes: [],
    targetObject: goal,
    toolKey: '',
    tool: BALL6,
    stock: { ...base.stock, length: 110, width: 140, thickness: 1.2 + size.z, material: 'hardwood' },
  };
  const input = await buildModelPlanInputForGoal(job, goal, BALL6, SHOP_991);
  input.setups = CARD_SETUPS;
  expect(input.geometry.faceId?.length, 'the seam did not carry the face ids').toBe(input.geometry.triangles.triangleCount);
  console.log(`#991 tray door input: legMm ${input.edgeBreak.legMm}, pinned ${JSON.stringify(input.cutters.pinned)}`);
  const output = await planModelCam(input);
  shared = { input, output, setup: output.perSetup[0]!, job, goal, shop: SHOP_991 };
}, 1_800_000);

describe.skipIf(TRAY === undefined)('#991 — the tray imported at the door: B-rep faces, the card’s numbers', () => {
  it('the door keeps faceId and the seam plans 38 rims / 27 chamfer ops with source "step"', () => {
    const setup = shared!.setup;
    const chamferOps = setup.ops.filter((op) => op.kind === 'chamfer').length;
    console.log(`#991 tray door: ${setup.features.report.source} path, ${setup.features.rims.length} rims, ${chamferOps} chamfer ops; notes: ${setup.notes.filter((n) => /edge break|not broken/.test(n)).slice(0, 3).join(' | ')}; unplanned: ${(setup.unplanned ?? []).filter((u) => u.kind === 'chamfer').slice(0, 3).map((u) => u.reason).join(' | ')}`);
    expect(setup.features.report.source).toBe('step');
    expect(setup.features.rims.length).toBe(38);
    expect(chamferOps).toBe(27);
  }, 900_000);
});

describe.skipIf(TRAY === undefined)('#989 — the tray through the app path: the goal’s chamfer reaches the rim stage', () => {
  it('posts the pinned V’s chamfer program, every feed one leg below a tray rim, the top rim included', async () => {
    const { output, job, goal, shop } = shared!;
    // `placedTree`/the door put the tray's top face at `modelTop` in the work frame (Z 0 = stock top).
    const topZ = -1.2;
    const t0 = performance.now();
    // #1004 — the literal production steps with the card's single setup: the seam's input is
    // built and edited in `beforeAll`; this case posts-and-verifies through the extracted tail.
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
  }, 900_000);
});
