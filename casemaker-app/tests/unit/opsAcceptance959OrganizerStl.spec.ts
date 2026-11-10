/**
 * The organizer STL row — the knife edge split, planned and measured through the user’s door.
 *
 * #1180 — SPLIT FROM opsAcceptance959.spec.ts (773 s serial) so this case runs in its own worker
 * beside the rest of the acceptance set. The part, the catalogue and the plan helpers come from
 * `helpers/trayAcceptance.ts`; the test body is moved verbatim.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  expectSevenLinesPass, measureStlRow, sevenVerdicts, shippedStlBeside } from './helpers/trayAcceptance';

import { ORGANIZER_STEP, installAcceptanceCatalogue, clearAcceptanceCatalogue } from './helpers/trayAcceptance';

const ORGANIZER = ORGANIZER_STEP;
installAcceptanceCatalogue();
afterAll(() => clearAcceptanceCatalogue());

describe.skipIf(ORGANIZER === undefined)('#993/#995 the organizer STL row', () => {
  it('#993/#995 the shipped STL row: the knife edge split, the user’s file now plans, measures and passes all seven lines', async () => {
    const stlPath = shippedStlBeside(ORGANIZER!);
    expect(stlPath, 'the Makerables .stl is not beside the STEP').not.toBeNull();
    if (stlPath === null) return;
    const row = await measureStlRow('organizer', stlPath, [170, 170], -0.8);
    expect(row.setup.features.report.source).toBe('mesh');
    expect(row.measured, 'the STL row measured nothing').not.toBeNull();
    // Pinned after #994: the 6 fillets that were read as modelled chamfers are curved remainder
    // now (74 rims / 6 modelled became 68 / 0); the chamfer line stayed 48, because those six
    // were among the 26 rims the exposure test already skipped (20 now).
    expect(row.rims).toBe(68);
    expect(row.modelled).toBe(0);
    expect(row.chamferOps).toBe(48);
    expect(row.measured!.coverage, 'the STL row fell under the card coverage floor').toBeGreaterThanOrEqual(0.9861);
    // PINNED at the split door: 3.973923346491006e-5 adjudicated. Measured ZERO at f73deb58
    // already — the 966-collapse line's plans removed the 40 nm strip this pin recorded — so it is
    // re-pinned to 0 here with the cause named (#1011's rule) rather than left failing.
    // #1014 does not move this plan: the organizer's finish feeds are identical with and without
    // the mask fix (the plan dumps are byte-identical).
    expect(row.measured!.adjudicatedFraction ?? 0, 'the STL row cut into the part').toBe(0);
    console.log(`#995 organizer STL row seven lines: ${sevenVerdicts(row.measured!)} — ${row.measured!.scored.sentence}`);
    expectSevenLinesPass(row.measured!, 'organizer STL row');
  }, 900_000);
});
