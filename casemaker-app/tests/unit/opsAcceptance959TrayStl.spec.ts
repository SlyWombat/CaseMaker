/**
 * The tray 70 STL row through the user’s own door, beside the STEP row.
 *
 * #1180 — SPLIT FROM opsAcceptance959.spec.ts (773 s serial) so this case runs in its own worker
 * beside the rest of the acceptance set. The part, the catalogue and the plan helpers come from
 * `helpers/trayAcceptance.ts`; the test body is moved verbatim.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  expectSevenLinesPass, measureStlRow, shippedStlBeside } from './helpers/trayAcceptance';

import { TRAY_STEP, installAcceptanceCatalogue, clearAcceptanceCatalogue } from './helpers/trayAcceptance';

const TRAY = TRAY_STEP;
const CATALOGUE = installAcceptanceCatalogue();
afterAll(() => clearAcceptanceCatalogue());

describe.skipIf(TRAY === undefined || (!CATALOGUE.installed && !CATALOGUE.optedOut))('#991 the tray STL row — planned through the user’s own door', () => {
  it('#991 the shipped STL row: planned through the user’s own door, printed beside the STEP row', async () => {
    const stlPath = shippedStlBeside(TRAY!);
    expect(stlPath, 'the Makerables .stl is not beside the STEP').not.toBeNull();
    if (stlPath === null) return;
    const row = await measureStlRow('tray', stlPath, [110, 140], -1.2);
    expect(row.setup.features.report.source, 'an STL must take the mesh path').toBe('mesh');
    expect(row.rims).toBe(35);
    expect(row.modelled).toBe(0);
    expect(row.chamferOps).toBe(27);
    expect(row.measured, 'the STL row measured nothing').not.toBeNull();
    // #999 — THE ROUGH IS POSTED: an absent roughToolKey means the engine chooses, so the ⌀6
    // flat's rough must be among the posted runs (60.38 % was this row with the ball alone).
    expect(
      row.setup.programs.some((ir) => ir.tool.id === '111031606032'),
      `flat-6 did not post: ${row.setup.programs.map((ir) => ir.tool.id ?? ir.tool.name).join(', ')}`,
    ).toBe(true);
    // The seven lines are judged on BOTH rows: the STL row must clear its own gate (the same
    // 0.95 pass coverage) and cut nothing into the part. Its RIM line differs from the STEP
    // row's by the filed defect above; that is the only line allowed to.
    expect(row.measured!.coverage, 'the STL row fell under the card coverage floor').toBeGreaterThanOrEqual(0.9852);
    expect(row.measured!.adjudicatedFraction ?? 0, 'the STL row cut into the part').toBe(0);
    // #991 (the clarified ruling) — the SAME seven lines as the STEP row, on the same vendor basis
    // (`vendorScoreFor` already resolves 'tray-stl' to the tray card).
    expectSevenLinesPass(row.measured!, 'tray STL row');
  }, 900_000);
});
