// #174's last owed test: a VERIFIER refusal driven through Generate into a disabled Save.
//
// `engraveRunStore.spec.ts` blocks Save on a generic findings error (`item-empty`), and
// `engraveGenerate.spec.ts` proves the worker refuses a cut past a void's membrane — but nothing
// drove THAT refusal through the store, so the `stage: 'verify'` half of the gate had no cover.
// This spec runs the real pipeline (real Manifold, real post, real verifier) with only the
// worker *client* faked, exactly as the store calls it, and asserts the run stops where the
// issue says it must: the text exists, the verifier refused it, no simulation ran, Save is shut.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  useEngraveRunStore,
  setEngraveRunClientLoader,
  saveBlocker,
  runErrorCodes,
} from '@/store/engraveRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { setSimClientLoader, type SimClient } from '@/store/simStore';
import type { SimLoadResult } from '@/workers/sim/session';
import type { EngraveJob, EngraveKeepOut } from '@/types/engraveJob';

/** A sim worker that refuses every load, so the accepted job stops at the simulation and never
 *  reaches a real worker (`engraveRunStore` drives `simStore.loadProgram` once the gate passes). */
function refusingSimClient(): SimClient {
  const refusal = { ok: false, pathOnly: false, diagnostics: [] } as unknown as SimLoadResult;
  return {
    setSimSinks: () => {},
    loadSim: async () => refusal,
    requestFrame: () => {},
    simPath: async () => ({ xyz: new Float32Array(0), step: new Uint32Array(0), kind: new Uint8Array(0), t: new Float32Array(0) }),
    disposeSim: async () => {},
  } as unknown as SimClient;
}

/**
 * A 12 mm blank with a 2 mm membrane over a magnet pocket (ceiling at z 10 from the bottom), so
 * `minFloor` 1 leaves a deepest cut of 1.0 mm over the void. A 1.5 mm cut there clears
 * `validateJob` (which only knows the stock's own floor) and is refused by the verifier alone —
 * which is precisely the stage this spec exists to reach.
 */
const pocket: EngraveKeepOut = {
  id: 'pocket',
  name: 'Magnet pocket',
  kind: 'rect',
  position: { x: 50, y: 30 },
  rotation: 0,
  enabled: true,
  zCeiling: 10,
  width: 30,
  height: 20,
  cornerRadius: 0,
};

function overMembraneJob(depth: number): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    keepOuts: [pocket],
    labels: [],
    shapes: [
      {
        id: 'a',
        name: 'A',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth,
        enabled: true,
        width: 10,
        height: 10,
        cornerRadius: 0,
      },
    ],
  };
}

/** The real generate, behind the store's own client seam. `simOracle` must never be reached. */
const simOracle = vi.fn(async () => {
  throw new Error('the oracle must not run for a refused program');
});

describe('engraveRunStore — a verifier refusal stops the run (#174)', () => {
  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    simOracle.mockClear();
    setEngraveRunClientLoader(async () => ({
      // Forward the cutter the store resolved (#305) and the feed rows it read (#324): the fake
      // stands in for the client, so it must not resolve either of its own.
      engraveGenerate: async (job, tool, catalogue) => engraveGenerate(tl, job, tool, catalogue),
      simOracle,
    }));
    setSimClientLoader(async () => refusingSimClient());
  });

  it('blocks Save on a real cut-too-deep, with the text produced and no simulation run', async () => {
    useEngraveJobStore.setState({ job: overMembraneJob(1.5) });
    await useEngraveRunStore.getState().generate();
    const run = useEngraveRunStore.getState();

    // The refusal is the verifier's, on the posted TEXT — not an earlier stage's finding.
    expect(run.generated).not.toBeNull();
    expect(run.generated!.stage).toBe('verify');
    expect(run.generated!.nc).not.toBeNull();
    expect(run.generated!.nc!.startsWith(';@MKR|BEGIN')).toBe(true);
    expect(
      run.generated!.verify!.findings.some((f) => f.code === 'cut-too-deep' && f.severity === 'error'),
    ).toBe(true);

    // And the store acted on it: blocked, never simulated, Save shut with the reason the user
    // reads off the button.
    expect(run.phase).toBe('blocked');
    expect(run.simStatus).toBeNull();
    expect(simOracle).not.toHaveBeenCalled();
    expect(runErrorCodes(run)).toContain('cut-too-deep');
    expect(saveBlocker(run)).toMatch(/^\d+ error/);
    expect(saveBlocker(run)).toContain('outstanding');
  });

  it('does not block the same cut when it stays within the membrane', async () => {
    useEngraveJobStore.setState({ job: overMembraneJob(0.8) });
    await useEngraveRunStore.getState().generate();
    const run = useEngraveRunStore.getState();

    // The verifier lets it through, so this is NOT a verify refusal: the pipeline completes and
    // the run proceeds past the gate, stopping at the (refusing) simulation instead. That is the
    // point of the pair — the gate singles out the verifier's error, not every blocked run.
    expect(run.generated!.stage).toBe('done');
    expect(run.generated!.verify!.findings.some((f) => f.code === 'cut-too-deep')).toBe(false);
    expect(runErrorCodes(run)).not.toContain('cut-too-deep');
    expect(run.simStatus).not.toBeNull();
  });
});
