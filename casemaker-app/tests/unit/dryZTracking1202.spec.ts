/**
 * #1202 — THE SHOWN SEQUENCE IS THE WHOLE SEQUENCE (analyst defect, 2026-11-11).
 *
 * The Register card's "What will be sent" list stopped after the FIRST touch on a guarded plan:
 * 23 lines shown, 36 sent. The scripted machine answered a relative `G38.3 Z-…` with half the
 * travel as an ABSOLUTE machine Z — above the machine's clearance — so the scripted executor
 * stopped. The recording console now tracks the machine's position and G90/G91: the fast touch
 * triggers at the midpoint of its travel (inside the plan's band) and the slow touch answers at
 * that level, so the walk reaches the epilogue.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import {
  planRegistration,
  registrationSettings,
  runRegistration,
  type PlanInput,
  type RegistrationPlan,
} from '@/engine/cnc/registration';
import { dryRegistration, previewHolds, recordingConsole, type DryRoutine } from '@/engine/cnc/registration/dryRun';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const { settings: S } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

/** The tray on the M1 bracket: a guarded top seek (no expected surface), the 3D probe's Z touches. */
const PROBE: ProbeSpec = {
  id: 'fx-probe-3d',
  variant: '3d',
  instrument: 'xyz',
  tip: { diameterMm: 2, rimOffsetMm: 0.875, rimOffsetUncertaintyMm: 0.01 },
};

function trayPlan(): RegistrationPlan {
  const input: PlanInput = {
    stock: { xMin: 0, yMin: 0, xMax: 160, yMax: 126, cornerRadius: 8 },
    mount: 'bracket',
    expectedSurface: { machineZ: -60.788, from: 'the seat and the job’s stated thickness' },
    guarded: { floorMachineZ: -99, marginMm: 0 },
    seekFromMachineZ: -3,
    cutCentre: { x: 80, y: 63 },
    probe: PROBE,
    bracketOrigin: { x: -181.55, y: -184.8, from: 'anchor 1', offsetMeasured: true },
    mountObstacles: [],
  };
  const planned = planRegistration(input, S);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

describe('#1202 — the guarded top seek’s dry list is the whole sequence', () => {
  it('runs to the epilogue: the fast touch, the slow touch, and the trailing $H / M832', async () => {
    const plan = trayPlan();
    expect(plan.seek.band).toEqual({ min: -99, max: -6 });
    const dry = await dryRegistration(plan, {
      clearanceZ: plan.seek.fromMachineZ,
      settings: S,
      liveClearanceZ: plan.seek.fromMachineZ,
    });
    // The old scripted machine stopped at the FAST touch (its reply was above the clearance).
    expect(dry.error).toBeNull();
    expect(dry.refused).toBe(false);
    // Both top touches are in the list — the fast seek and the slow one at its level.
    expect(dry.lines.filter((l) => l.line.startsWith('G38.3 Z')).length).toBe(2);
    // The sequence reaches the run's own epilogue, not a truncated stop.
    expect(dry.lines.slice(-2).map((l) => l.line)).toEqual(['$H', 'M832']);

    // SHOWN == SENT: the executor, run against a fresh scripted machine, walks the same list.
    const console_ = recordingConsole();
    const run = await runRegistration(plan, {
      console: { send: (line, timing) => console_.send(line, timing) },
      operator: () => Promise.resolve(true),
      stopRequested: () => false,
      liveClearanceZ: plan.seek.fromMachineZ,
    });
    expect(run.ok).toBe(true);
    expect(dry.lines.map((l) => l.line)).toEqual(console_.lines);
  });
});

describe('#1202 — a preview that could not finish is not a preview', () => {
  const routine = (over: Partial<DryRoutine> = {}): DryRoutine => ({
    lines: [],
    identity: { routine: 'registration', shape: '00000000', lines: [] },
    refused: false,
    error: null,
    ...over,
  });

  it('holds the press on a dry error, first run or not', () => {
    // A preview that stopped early shows LESS than the truth: the operator must not run it on that.
    expect(previewHolds(routine({ error: 'stopped: the surface was not found' }), false, true)).toBe(true);
    expect(previewHolds(routine({ error: 'stopped: the surface was not found' }), true, true)).toBe(true);
    // The existing rules stand: a refused line holds, a first run needs its own tick.
    expect(previewHolds(routine({ refused: true }), false, true)).toBe(true);
    expect(previewHolds(routine(), true, false)).toBe(true);
    expect(previewHolds(routine(), true, true)).toBe(false);
    expect(previewHolds(routine(), false, false)).toBe(false);
    expect(previewHolds(null, false, false)).toBe(false);
  });
});
