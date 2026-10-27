// @vitest-environment jsdom
/**
 * #724 W5 — the E2E API's Save reason asks the gate THE SAME WAY the panel does: with the job.
 *
 * Without the machine and the holding, a rotary program read as one for a machine with no module
 * — "This machine has no rotary module" on a profile that has one. This is the exercise's
 * internal reason, and it is the API the off-bench harness reads its disabled states from, so a
 * wrong gate here is a wrong report there.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { installCaseMakerTestApi } from '@/testing/windowApi';
import { ROTARY_UNMEASURED_REFUSAL } from '@/store/engraveRunGate';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

const ROTARY_PROGRAM: EngraveProgram = {
  setupIndex: 1,
  setupId: 'setup-1',
  toolKey: 'flat-1.0',
  nc: 'G90',
  verify: null,
  frameNc: null,
  frameVerify: null,
  programHash: 'abcd1234',
  cam: null,
  frame: 'rotary',
};

function generated(): EngraveGenerated {
  return {
    ok: false,
    stage: 'findings',
    findings: [],
    feeds: null,
    threads: null,
    cam: null,
    nc: null,
    verify: null,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs: [ROTARY_PROGRAM],
    errors: [],
  };
}

interface RunState {
  canSave: boolean;
  saveReason: string | null;
}

const runState = (): RunState =>
  (window as unknown as { __caseMaker: { getEngraveRunState(): RunState } }).__caseMaker.getEngraveRunState();

beforeEach(() => {
  useEngraveRunStore.getState().reset();
  installCaseMakerTestApi();
});

describe('#724 W5 — the E2E API’s Save reason', () => {
  it('is the bench sentence for a rotary job, not “no rotary module”', () => {
    const base = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: {
        ...base,
        stock: { ...base.stock, length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
        workholding: {
          kind: 'rotary-chuck',
          rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
        },
      },
    });
    useEngraveRunStore.setState({ generated: generated(), phase: 'idle', simStatus: null });

    const state = runState();
    expect(state.canSave).toBe(false);
    expect(state.saveReason).toBe(ROTARY_UNMEASURED_REFUSAL);
    expect(state.saveReason).not.toContain('no rotary module');
  });
});
