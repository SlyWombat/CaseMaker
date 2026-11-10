/**
 * The tray imported at the door: B-rep faces and the card’s numbers.
 *
 * #1180 — SPLIT FROM opsAcceptance959.spec.ts so this case runs in its own worker. The part and
 * helpers come from `helpers/trayAcceptance.ts`; the describe is moved verbatim.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { planModelCam } from '@/engine/cnc/cam/model/plan';
import {
  BALL6, CARD_SETUPS, CHAMFER3175, EDGE_BREAK_LEG_MM, SHOP_991 } from './helpers/trayAcceptance';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { readTargetObjectFile } from '@/engine/import/targetObject';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';

import { TRAY_STEP, installAcceptanceCatalogue, clearAcceptanceCatalogue } from './helpers/trayAcceptance';


installAcceptanceCatalogue();
const TRAY = TRAY_STEP;
afterAll(() => clearAcceptanceCatalogue());

describe.skipIf(TRAY === undefined)('#991 — the tray imported at the door: B-rep faces, the card’s numbers', () => {
  it('the door keeps faceId and the seam plans 38 rims / 27 chamfer ops with source "step"', async () => {
    const bytes = fs.readFileSync(TRAY!);
    const read = await readTargetObjectFile(new File([bytes], path.basename(TRAY!)), 'tray-991');
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
    const setup = output.perSetup[0]!;
    const chamferOps = setup.ops.filter((op) => op.kind === 'chamfer').length;
    console.log(`#991 tray door: ${setup.features.report.source} path, ${setup.features.rims.length} rims, ${chamferOps} chamfer ops; notes: ${setup.notes.filter((n) => /edge break|not broken/.test(n)).slice(0, 3).join(' | ')}; unplanned: ${(setup.unplanned ?? []).filter((u) => u.kind === 'chamfer').slice(0, 3).map((u) => u.reason).join(' | ')}`);
    expect(setup.features.report.source).toBe('step');
    expect(setup.features.rims.length).toBe(38);
    expect(chamferOps).toBe(27);
  }, 900_000);
});
