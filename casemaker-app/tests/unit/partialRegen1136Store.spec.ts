// #1136 stage 3 — THE JUDGEMENT IS NEVER PARTIAL. A partial post is only a saving if the WHOLE
// composed run passes the verifier, the sweep and the goal check; when the composed run fails
// judgement, the store abandons it, re-posts the whole run, and says so. The generator is faked
// here (the real one is covered by partialRegen1136.spec.ts); this test is the store's decision:
// the first generate hands the carry over, the second must not, and the run that survives is the
// FULL one, with the fallback stated in the findings and the run log.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  useEngraveRunStore,
  setEngraveRunClientLoader,
  currentRunInputStamps,
  runShopSignature,
} from '@/store/engraveRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useSimStore } from '@/store/simStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { SimLoadOk } from '@/workers/sim/session';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

function setup(id: string, itemIds: string[], tools: string[]): JobSetup {
  return { id, orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools };
}

/** A two-setup job with a replacement already written: the state Generate sees after the press. */
function replacedJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  const [a, b] = job.labels.map((l) => l.id);
  job.setups = [setup('s1', [a!], ['flat-1.0']), setup('s2', [b!], ['flat-1.0'])];
  job.cutterSubstitutions = { s2: { 'flat-1.0': 'flat-0.6' } };
  return job;
}

function clean(): EngraveGenerated {
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 5, passes: 2 },
    nc: 'G90\nM02',
    verify: null,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    designItems: [],
    programs: [
      {
        setupIndex: 1,
        setupId: 's1',
        toolKey: 'flat-1.0',
        nc: 'G90\nM02',
        verify: null,
        frameNc: null,
        frameVerify: null,
        programHash: 'clean-program',
        cam: null,
      },
    ],
    errors: [],
  };
}

function swept(): SimLoadOk {
  return {
    ok: true,
    diagnostics: [],
    summary: { rotary: false },
    stats: { engine: 'exact', removedVolume: 0 },
    count: 1,
    meshes: { removal: null },
  } as unknown as SimLoadOk;
}

describe('#1136 stage 3 — a composed run that fails judgement falls back to the whole run', () => {
  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    setEngraveRunClientLoader(null);
    useEngraveJobStore.getState().replace(replacedJob());
  });
  afterEach(() => {
    setEngraveRunClientLoader(null);
    useSimStore.setState({ loadProgram: useSimStore.getState().loadProgram });
  });

  it('abandons the partial post, re-posts the whole run, and says so', async () => {
    const previous = clean();
    // The state a replacement leaves: a green result the package was cut from, stale for the job.
    useEngraveRunStore.setState({
      generated: previous,
      staleSince: Date.now(),
      staleReason: 'job',
      inputs: currentRunInputStamps(),
      shopSignature: runShopSignature(),
      phase: 'idle',
    });
    const partial: EngraveGenerated = {
      ...clean(),
      // The partial result the real generator marks: one block carried, one re-posted.
      partialRegen: { affectedSetups: [2], reposted: 1, carried: 1 },
    };
    const full = clean();
    const carried: (EngraveGenerated | undefined)[] = [];
    let generateCount = 0;
    let oracleCount = 0;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (_job, _tool, _catalogue, _cal, _margins, _shop, _progress, _tools, prior) => {
        carried.push(prior);
        generateCount += 1;
        return generateCount === 1 ? partial : full;
      },
      simOracle: async () => {
        oracleCount += 1;
        // The composed run fails the whole-run check; the full run passes it.
        return oracleCount === 1
          ? ({ ok: false, band: 0.016, levels: [], worst: { underCut: 0.5, overCut: 0 } } as never)
          : ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } as never);
      },
    }));
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
        return swept();
      },
    });
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }

    // TWO generates: the partial press and the fallback. Only the first is handed the carry.
    expect(generateCount).toBe(2);
    expect(carried[0]).toBe(previous);
    expect(carried[1]).toBeUndefined();
    // The full run is the run — never the partial result shown as one.
    const s = useEngraveRunStore.getState();
    expect(s.generated).not.toBe(partial);
    expect(s.generated?.partialRegen).toBeUndefined();
    expect(s.phase).toBe('ready');
    expect(s.oracle?.ok).toBe(true);
    // And the operator is told, in the findings and in the run log.
    expect(s.generated?.findings.some((f) => f.code === 'partial-regen' && /whole run/i.test(f.message))).toBe(true);
    expect(s.log.some((entry) => /partial re-post|whole run/i.test(entry.label))).toBe(true);
  });
});
