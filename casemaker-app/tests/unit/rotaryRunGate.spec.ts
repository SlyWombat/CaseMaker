// @vitest-environment jsdom
// #240/#545 — the ONE rotary safety line, and the two save paths it must not be confused with.
//
// Save .nc, Upload and the release/one-screen Cut all read `saveBlocker`, so the refusal is stated
// once. The `.cutjob` DOCUMENT save is a different action with its own store and never reaches
// this module: a rotary job can be checked, saved as a document and reopened while its `.nc` waits
// for the module's bench check. Both halves are asserted here, at the same job and the same
// machine, so the distinction cannot drift.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { Z1, type RotaryProfile, type RotarySourcedField } from '@/engine/cnc/machine';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { jobMachine } from '@/engine/cnc/calibration';
import {
  resetEngraveJobFileStore,
  setJobFileIO,
  useEngraveJobFileStore,
  type JobFileIO,
} from '@/store/engraveJobFileStore';
import {
  ROTARY_NO_MODULE_REFUSAL,
  ROTARY_UNMEASURED_REFUSAL,
  gateViewFor,
  withPeriod,
  programFrame,
  releaseBlocker,
  rotaryUnmeasured,
  saveBlocker,
  uploadBlocker,
  type EngraveRunView,
} from '@/store/engraveRunGate';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import type { ProjectFileHandle, SaveTextOutcome } from '@/store/persistence';
import type { EngraveJob, RotaryChuck } from '@/types/engraveJob';

const CHUCK: RotaryChuck = {
  stickout: 30,
  gripDiameter: null,
  jawMode: 'reverse-inner',
  tailstock: true,
  source: 'Makera Z1 wiki, 4-axis accessory',
};

/** A rod held in the rotary: the axis-frame box L × D × D, with `shape` saying it is round. */
function rotaryRodJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'rod',
    stock: { ...base.stock, length: 30, width: 10, thickness: 10, shape: 'cylinder', diameter: 10 },
    workholding: { kind: 'rotary-chuck', rotary: { ...CHUCK } },
  };
}

function view(over: Partial<EngraveRunView> = {}): EngraveRunView {
  return {
    generated: null,
    oracle: null,
    simDiagnostics: [],
    simStatus: null,
    phase: 'idle',
    acknowledged: false,
    staleSince: null,
    error: null,
    ...over,
  };
}

function emptyResult(programs: EngraveProgram[] = []): EngraveGenerated {
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
    programs,
    errors: [],
  };
}

/** A generated program with only the facts the gate reads; it states the ROTARY frame. */
function rotaryProgram(): EngraveProgram {
  return {
    setupIndex: 1,
    setupId: 'setup-1',
    toolKey: 'flat-1.0',
    nc: 'G90\nM02',
    verify: null,
    frameNc: null,
    frameVerify: null,
    programHash: 'abcd1234',
    cam: null,
    frame: 'rotary',
  };
}

const MEASURED_SOURCES = Object.fromEntries(
  (Object.keys(Z1.rotary!.sources) as RotarySourcedField[]).map((key) => [key, 'measured (#238, 2026-10-26)']),
) as RotaryProfile['sources'];

const MEASURED: RotaryProfile = { ...Z1.rotary!, sources: MEASURED_SOURCES };

describe('the rotary safety line (#240/#545)', () => {
  it('refuses Save .nc, Upload and the release with the ONE sentence while a source is unmeasured', () => {
    // Both triggers: the job is held in the chuck (slice 1 — the CAM still writes a flat file),
    // and a generated program states the rotary frame (the fact that keeps the rule on later).
    for (const v of [
      view({ machine: Z1, rotaryHeld: true }),
      view({ machine: Z1, generated: emptyResult([rotaryProgram()]) }),
    ]) {
      expect(saveBlocker(v)).toBe(ROTARY_UNMEASURED_REFUSAL);
      expect(uploadBlocker(v)).toBe(ROTARY_UNMEASURED_REFUSAL);
      expect(releaseBlocker(v)).toBe(ROTARY_UNMEASURED_REFUSAL);
    }
    // The exact words are the contract: they are the sentence the panel shows, unchanged.
    expect(ROTARY_UNMEASURED_REFUSAL).toBe(
      "The rotary module has not been measured on this machine yet — this program can be checked and simulated, but saving its .nc and running it wait for the module's bench check.",
    );
    // #724 W5 — the sentence must not promise what this gate is shutting (Save .nc).
    expect(ROTARY_UNMEASURED_REFUSAL).not.toContain('checked and saved');
  });

  it('an unknown machine cannot show a module at all, so a rotary job gets the no-module sentence', () => {
    // #240 review — the bench sentence would CLAIM a module exists and is merely unmeasured. With
    // no record there is no such claim to make, and A words must never reach a machine that cannot
    // turn A.
    expect(saveBlocker(view({ machine: null, rotaryHeld: true }))).toBe(ROTARY_NO_MODULE_REFUSAL);
    expect(saveBlocker(view({ rotaryHeld: true }))).toBe(ROTARY_NO_MODULE_REFUSAL);
    expect(ROTARY_NO_MODULE_REFUSAL).toBe(
      'This machine has no rotary module — a rotary program cannot run on it.',
    );
  });

  it('every source starting "measured" lifts the rule, and the normal gate answers again', () => {
    const machine = { rotary: MEASURED };
    expect(rotaryUnmeasured(machine)).toBe(false);
    expect(saveBlocker(view({ machine, rotaryHeld: true }))).toBe('Generate first.');
    expect(uploadBlocker(view({ machine, rotaryHeld: true }))).toBe('Generate first.');
    expect(releaseBlocker(view({ machine, rotaryHeld: true }))).toBe('Generate first.');
  });

  it('a profile with NO rotary block refuses a rotary job with the no-module sentence', () => {
    // #240 review — "nothing to measure" is not "measured": a machine whose profile carries no
    // module must never receive a rotary job or a rotary-frame program.
    const noModule = { rotary: undefined };
    expect(rotaryUnmeasured(noModule)).toBe(true); // cannot be proven measured either
    expect(saveBlocker(view({ machine: noModule, rotaryHeld: true }))).toBe(ROTARY_NO_MODULE_REFUSAL);
    expect(uploadBlocker(view({ machine: noModule, rotaryHeld: true }))).toBe(ROTARY_NO_MODULE_REFUSAL);
    expect(releaseBlocker(view({ machine: noModule, rotaryHeld: true }))).toBe(ROTARY_NO_MODULE_REFUSAL);
    // …and the program's own frame is enough on its own.
    expect(saveBlocker(view({ machine: noModule, generated: emptyResult([rotaryProgram()]) }))).toBe(
      ROTARY_NO_MODULE_REFUSAL,
    );
  });

  it('a measured rotary machine lets a rotary-frame program through to the normal gate', () => {
    // Not a rotary refusal any more: the ordinary gate answers, and its answer here is the empty
    // result's own ("no program was produced"), which is the proof the rule stepped aside.
    const answer = saveBlocker(view({ machine: { rotary: MEASURED }, generated: emptyResult([rotaryProgram()]) }));
    expect(answer).not.toBe(ROTARY_UNMEASURED_REFUSAL);
    expect(answer).not.toBe(ROTARY_NO_MODULE_REFUSAL);
    expect(answer).toBe('no program was produced');
  });

  it('a run with no rotary fact is not asked the rotary question at all', () => {
    expect(saveBlocker(view({ machine: Z1 }))).toBe('Generate first.');
    // A flat job on a machine with no module is an ordinary job, not a rotary one.
    expect(saveBlocker(view({ machine: { rotary: undefined } }))).toBe('Generate first.');
    expect(saveBlocker(view({ machine: null }))).toBe('Generate first.');
  });
});

describe('one period at the render site (#724 W5)', () => {
  it('keeps a sentence’s own period and gives a fragment one', () => {
    expect(withPeriod(ROTARY_UNMEASURED_REFUSAL)).toBe(ROTARY_UNMEASURED_REFUSAL);
    expect(withPeriod('the run is still going')).toBe('the run is still going.');
    expect(withPeriod('  tick the clearance check  ')).toBe('tick the clearance check.');
    // A sentence that already ends keeps its ONE period; the render site no longer adds a second.
    expect(withPeriod('the run is still going.')).toBe('the run is still going.');
  });
});

describe('the gate’s view carries the machine and the holding (#724 W5)', () => {
  it('a view with no machine says "no module"; the same run with the job says the bench sentence', () => {
    const rotaryJob: EngraveJob = {
      ...defaultEngraveJob(),
      stock: { ...defaultEngraveJob().stock, length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
      workholding: {
        kind: 'rotary-chuck',
        rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
      },
    };
    const run = view({ generated: emptyResult([rotaryProgram()]) });
    // The machine-less view a caller with no job makes: nothing to read, so "no module".
    expect(saveBlocker({ ...run, machine: null })).toBe(ROTARY_NO_MODULE_REFUSAL);
    // With the job, it is the bench sentence on the profile that HAS the module.
    expect(saveBlocker(gateViewFor(run, jobMachine(rotaryJob), true))).toBe(ROTARY_UNMEASURED_REFUSAL);
    // …and a plate job is not a rotary run at all, whatever the view once carried.
    expect(saveBlocker(gateViewFor(view(), jobMachine(defaultEngraveJob()), false))).not.toBe(ROTARY_UNMEASURED_REFUSAL);
  });
});

describe('the frame a program record states (#240)', () => {
  it('absent reads flat; the stored program keeps what the post wrote', () => {
    expect(programFrame({})).toBe('flat');
    expect(programFrame({ frame: 'flat' })).toBe('flat');
    expect(programFrame({ frame: 'rotary' })).toBe('rotary');
    expect(programFrame(rotaryProgram())).toBe('rotary');
  });
});

describe('the .cutjob document save is NOT the .nc save (#545)', () => {
  const handle: ProjectFileHandle = { name: 'rod.cutjob.json' };
  let saves: { text: string; proposed: string }[];

  beforeEach(() => {
    localStorage.clear();
    useEngraveJobStore.getState().reset();
    resetEngraveJobFileStore();
    saves = [];
    const io: JobFileIO = {
      write: async () => undefined,
      save: async (text, proposed): Promise<SaveTextOutcome> => {
        saves.push({ text, proposed });
        return { kind: 'saved', handle };
      },
      open: async () => null,
    };
    setJobFileIO(io);
  });

  afterEach(() => {
    setJobFileIO(null);
  });

  it('a rotary job saves as a document, and its .nc stays refused', async () => {
    const job = rotaryRodJob();
    useEngraveJobStore.getState().replace(job);

    await useEngraveJobFileStore.getState().save();

    // (a) THE DOCUMENT SAVED: bytes on disk, the rotary workholding intact.
    expect(saves).toHaveLength(1);
    expect(saves[0]!.proposed).toBe('rod.cutjob.json');
    const parsed = parseEngraveJob(JSON.parse(saves[0]!.text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.workholding).toEqual({ kind: 'rotary-chuck', rotary: CHUCK });
    expect(parsed.job.stock).toMatchObject({ shape: 'cylinder', diameter: 10, length: 30 });
    expect(useEngraveJobFileStore.getState().dirty).toBe(false);

    // (b) THE .nc SAVE IS REFUSED for the same job on the same machine.
    expect(
      saveBlocker(view({ machine: Z1, rotaryHeld: job.workholding.kind === 'rotary-chuck' })),
    ).toBe(ROTARY_UNMEASURED_REFUSAL);
  });
});
