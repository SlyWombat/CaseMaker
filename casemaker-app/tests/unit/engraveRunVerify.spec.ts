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
import { regions } from './helpers/engravePipeline';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { noneSacrificial, presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { placeTabs } from '@/engine/cnc/cam/profile';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { HOP_Z } from '@/engine/cnc/cam/ir';
import { verifyProgram } from '@/engine/cnc/verify';
import {
  useEngraveRunStore,
  setEngraveRunClientLoader,
  saveBlocker,
  runErrorCodes,
} from '@/store/engraveRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { setSimClientLoader, type SimClient } from '@/store/simStore';
import type { SimLoadResult } from '@/workers/sim/session';
import type { EngraveCutout, EngraveJob, EngraveKeepOut } from '@/types/engraveJob';

/** The 3.175 mm flat the cut-out specs use: 20 mm of flute and shoulder clears a 12.3 mm cut. */
const PROFILER = flatEndMill(3.175, {
  name: '3.175 mm flat end',
  fluteLength: 20,
  shoulderLength: 20,
});

/** The default 100 × 60 × 12 blank with ONE tabbed cut-out and a 12 mm board under it (#218). */
function cutoutJob(
  cutoutOver: Partial<EngraveCutout> = {},
  jobOver: Partial<EngraveJob> = {},
): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    toolKey: 'inv:flat-3.175x20',
    tool: PROFILER,
    sacrificial: presetPartOnBoard(),
    breakthrough: 0.3,
    cutouts: [
      {
        kind: 'cutout',
        id: 'cut-1',
        name: 'Badge',
        enabled: true,
        of: 'stock-inset',
        side: 'inside',
        inset: 5,
        tabs: { count: 4, width: 4, height: 1 },
        ...cutoutOver,
      },
    ],
    ...jobOver,
  };
}

/** A minimal, verifier-shaped program around a body of moves. */
const program = (body: string[]): string =>
  ['G90 G21', 'T1 M6', 'M331', 'G53 G0 Z-3', 'S12000 M3', ...body, 'G0 Z5', 'M5', 'M332', 'M2'].join('\n');

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
 * A 12 mm blank with a 2 mm membrane over a magnet pocket (ceiling at z 10 from the bottom).
 * #345 makes that ceiling an `above` bound, and on a blank that states no print decision A keeps
 * the job's 1 mm structural floor over it — the layers are unknown, so the floor is the only number
 * with a basis — for a deepest cut of 2 − 1.0 = 1.0 mm. A 1.5 mm cut there clears `validateJob`
 * (which only knows the stock's own floor) and is refused by the verifier alone — which is
 * precisely the stage this spec exists to reach. (These are SHAPES, not labels, so #345 decision B's
 * per-item check — which walks `job.labels` — leaves them to the verifier's per-move backstop.)
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

describe('through cuts and holding tabs at the verifier (#218)', () => {
  it('caps a cut inside a tab span at the tab top, and permits through depth elsewhere', () => {
    const job = cutoutJob();
    const rr = regions(tl, job);
    const mask = rr.throughMask;
    expect(mask).not.toBeNull();
    const contour = rr.profiles[0]!.path[0]!;
    const spans = placeTabs(contour, 4, 4, 3.175 / 2).spans;
    expect(spans).toHaveLength(4);
    const span = spans[0]!;
    const mid: [number, number] = [
      (span.start[0] + span.end[0]) / 2,
      (span.start[1] + span.end[1]) / 2,
    ];
    // Inside the span the mask lowers the limit to the tab's top, 12 − 1; the rest of the kerf
    // is the ordinary through allowance, 12 + 0.3.
    expect(mask!(mid[0], mid[1])).toBeCloseTo(11, 9);
    const corner = contour[0]!;
    expect(mask!(corner[0], corner[1])).toBeCloseTo(12.3, 9);

    const ctx = {
      setup: toSetup(job, Z1),
      machine: Z1,
      tool: PROFILER,
      depthLimit: jobDepthLimit(job, undefined, mask!),
      minRapidZ: HOP_Z,
    };
    // The same plunge, at the same depth, on either side of the tab's end.
    const refusal = verifyProgram(
      program([`G0 X${mid[0]} Y${mid[1]}`, 'G0 Z1', 'G1 Z-12.3 F300']),
      ctx,
    );
    const f = refusal.findings.find((x) => x.code === 'cut-too-deep');
    expect(f).toBeDefined();
    expect(f!.message).toContain('11.000 mm permitted');

    const permitted = verifyProgram(
      program([`G0 X${corner[0]} Y${corner[1]}`, 'G0 Z1', 'G1 Z-12.3 F300']),
      ctx,
    );
    expect(permitted.findings.some((x) => x.code === 'cut-too-deep')).toBe(false);
  });
});

describe('through cuts through the store (#218)', () => {
  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    simOracle.mockClear();
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (job, tool, catalogue) => engraveGenerate(tl, job, tool, catalogue),
      simOracle,
    }));
    setSimClientLoader(async () => refusingSimClient());
  });

  it('refuses a through cut-out with no board under it, before any program is posted', async () => {
    useEngraveJobStore.setState({ job: cutoutJob({}, { sacrificial: noneSacrificial() }) });
    await useEngraveRunStore.getState().generate();
    const run = useEngraveRunStore.getState();

    expect(run.generated!.stage).toBe('findings');
    expect(run.generated!.nc).toBeNull();
    expect(runErrorCodes(run)).toContain('through-needs-board');
    expect(run.phase).toBe('blocked');
    expect(simOracle).not.toHaveBeenCalled();
  });

  it('accepts a board exactly `breakthrough + 1` thick', async () => {
    const board = presetPartOnBoard();
    const job = cutoutJob(
      {},
      {
        sacrificial: {
          ...board,
          under: { ...board.under!, thickness: 0.3 + 1 },
        },
      },
    );
    useEngraveJobStore.setState({ job });
    await useEngraveRunStore.getState().generate();
    const run = useEngraveRunStore.getState();

    expect(run.generated!.stage).toBe('done');
    expect(runErrorCodes(run)).not.toContain('through-needs-board');
    expect(run.generated!.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
