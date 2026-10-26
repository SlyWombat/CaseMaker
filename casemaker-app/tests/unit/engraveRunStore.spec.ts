// The engrave RUN state (#206): the save gate and the staleness rule. No wasm, no worker — the
// client is faked, so this is the pure half of the store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as store from '@/store/engraveRunStore';
import * as gate from '@/store/engraveRunGate';
import { ORACLE_AREA_FLOOR } from '@/engine/cnc/engrave/oracle';
import {
  useEngraveRunStore,
  setEngraveRunClientLoader,
  oracleSentence,
  releaseBlocker,
  saveBlocker,
  uploadBlocker,
  requiredAckCodes,
  runErrorCodes,
  type EngraveRunView,
} from '@/store/engraveRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveGenerated, EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import {
  conditionForKey,
  resetInventoryConditions,
  setInventoryConditions,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { useSimStore } from '@/store/simStore';
import type { SimLoadOk } from '@/workers/sim/session';
import { useSettingsStore } from '@/store/settingsStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { calibrationFromReplies, type MachineCalibration } from '@/engine/cnc';
import { clearFeedCatalogue, setFeedCatalogue, setLocatedFeedTable, type FeedCatalogueRow, type StoredFeedRow } from '@/engine/cnc/feeds';
import { resetFeedTableStore, useFeedTableStore } from '@/store/feedTableStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { resetEngraveRegistrationStore, useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import type { FeedRow } from '@/platform/feedClient';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';

const NOTHING: EngraveGenerated = {
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
  programs: [],
  errors: [],
};

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
    programs: [],
    errors: [],
  };
}

describe('engraveRunStore (#206)', () => {
  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    setEngraveRunClientLoader(null);
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: 'flat-1.0' }); // #516 item 5 — the default job no longer seeds a cutter
    // No Makera catalogue unless a test loads one: it is module state (`feeds.ts`), so it outlives a
    // test that set it (#324).
    clearFeedCatalogue();
  });

  it('refuses Save before anything is generated', () => {
    expect(saveBlocker(view())).toBe('Generate first.');
  });

  it('oracleSentence falls back to ORACLE_AREA_FLOOR when the report omits the floor (#582)', () => {
    // #691 — the floor prints as a §4 figure (three decimals at most, trailing zeros dropped),
    // not the raw computed number and not `0.0010`.
    expect(gate.oracleSentence(view({ oracle: { ok: false, band: 0, levels: [], worst: { underCut: 0.002, overCut: 0 } } }))).toContain(`${Number(ORACLE_AREA_FLOOR.toFixed(3))} mm² floor`);
  });

  describe('#535 a surface program through the upload and release gates', () => {
    const FACTS = {
      resolutionNote: 'sampled on a 0.1 mm grid',
      gridPitchMm: 0.1,
      gridCells: 100,
      stepDownMm: 0.5,
      roughStepOverMm: 0.8,
      finishStepOverMm: 0.4,
      stockToLeaveMm: 0.3,
      roughingLayers: 3,
      notes: [],
    };
    const CHECK = {
      kind: 'surface' as const,
      gridPitchMm: 0.12,
      roughingLayers: 3,
      resolutionNote: 'sampled on a 0.1 mm grid',
      bbox: { min: [0, 0] as [number, number], max: [20, 20] as [number, number] },
    };

    /** A goal result: one program, no verifier report, its check the dexel sweep. */
    function surfaceGenerated(check: typeof CHECK | null, withFacts = true): EngraveGenerated {
      return {
        ...clean(),
        surface3d: withFacts ? FACTS : null,
        programs: [
          {
            setupIndex: 1,
            setupId: 'setup-1',
            toolKey: 'flat-1.0',
            nc: 'G90\nM02',
            verify: null,
            surfaceCheck: check,
            frameNc: null,
            frameVerify: null,
            programHash: 'abcd1234',
            cam: null,
          },
        ],
      };
    }

    const READY = {
      simStatus: 'ready' as const,
      phase: 'ready' as const,
      oracle: { ok: true, band: 0, levels: [], worst: { underCut: 0, overCut: 0 } },
    };

    it('Save, Upload and the release are open on the surface check — no verifier report needed', () => {
      const v = view({ generated: surfaceGenerated(CHECK), ...READY });
      expect(saveBlocker(v)).toBeNull();
      expect(uploadBlocker(v)).toBeNull();
      expect(releaseBlocker(v)).toBeNull();
    });

    it('a program with neither a report nor a check is still refused', () => {
      const v = view({ generated: surfaceGenerated(null, false), ...READY });
      expect(uploadBlocker(v)).toBe('the program carries no verifier report');
      expect(releaseBlocker(v)).toBe('a program did not pass the verifier');
    });
  });

  it('oracleSentence names the level and patch of the worst under-cut (#584)', () => {
    const sentence = gate.oracleSentence(
      view({
        oracle: {
          ok: false,
          band: 0.089,
          levels: [],
          areaFloor: 0.0399,
          worst: {
            underCut: 0.0815,
            overCut: 0,
            underAt: { z: -0.8, bbox: { min: [19.0, 37.0], max: [19.3, 37.27] } },
          },
        },
      }),
    );
    expect(sentence).toContain('0.04 mm² floor');
    expect(sentence).toContain('worst under-cut 0.082 mm²');
    expect(sentence).toContain('exceeds the 0.04 mm² floor by 0.042 mm²');
    expect(sentence).toContain('at level Z -0.8, near (19.15, 37.135) — a 0.3 × 0.27 mm patch');
    // §4 — no four-decimal figure anywhere in the sentence (#691).
    expect(sentence).not.toMatch(/\.\d{4}/);
  });

  it('a failing overage that rounds to zero says "less than 0.001", never "by 0 mm²" (#691)', () => {
    const sentence = gate.oracleSentence(
      view({
        oracle: {
          ok: false,
          band: 0.089,
          levels: [],
          areaFloor: 0.001,
          worst: {
            underCut: 0.0012,
            overCut: 0,
            underAt: { z: -0.8, bbox: { min: [19.0, 37.0], max: [19.3, 37.27] } },
          },
        },
      }),
    );
    // 0.0012 − 0.001 = 0.0002, which at §4's three decimals would print "by 0 mm²" — a failing
    // verdict stating no failure. The figure below the printed precision is said in words.
    expect(sentence).toContain('exceeds the 0.001 mm² floor by less than 0.001 mm²');
    expect(sentence).not.toContain('by 0 mm²');
  });

  describe('#535 the goal program’s check sentence', () => {
    const OK = { ok: true, band: 0.1, levels: [], worst: { underCut: 0, overCut: 0 } };

    it('states the dexel check and its grid, never the oracle’s vacuous 0/0', () => {
      const sentence = oracleSentence({ oracle: OK, surface: { gridPitchMm: 0.1 } });
      expect(sentence).toBe('No 2.5D check for a surface program — checked on the 0.1 mm dexel grid');
      // The old sentence's claim — both cuts inside the floor — must not appear: nothing was compared.
      expect(sentence).not.toContain('0.0000');
      expect(sentence).not.toContain('under-cut');
    });

    it('states the sweep without a grid when the exact engine ran it', () => {
      expect(oracleSentence({ oracle: OK, surface: { gridPitchMm: null } })).toBe(
        'No 2.5D check for a surface program — the simulation swept the stock',
      );
    });

    it('a program that is not a surface program keeps the oracle’s own sentence', () => {
      expect(oracleSentence({ oracle: OK })).toContain('under-cut');
    });

    it('the store captures the FLAT grid the sweep ran on, and no grid for a rotary one', async () => {
      const load = useSimStore.getState().loadProgram;
      const ready = (rotary: boolean): void => {
        useSimStore.setState({
          status: 'ready',
          diagnostics: [],
          pathOnly: false,
          info: {
            stats: { engine: 'column', resolution: { dx: 0.1, dThetaDeg: 0.12 } },
            summary: { rotary },
          } as unknown as SimLoadOk,
        });
      };
      try {
        useSimStore.setState({
          loadProgram: async () => ready(false),
        });
        // A goal-like result: its program's check states the HEIGHTFIELD pitch at generate time.
        const generated: EngraveGenerated = {
          ...clean(),
          programs: [
            {
              setupIndex: 1,
              setupId: 'setup-1',
              toolKey: 'flat-1.0',
              nc: 'G90\nM02',
              verify: null,
              surfaceCheck: {
                kind: 'surface',
                gridPitchMm: 0.1,
                roughingLayers: 3,
                resolutionNote: 'sampled on a 0.1 mm grid',
                bbox: { min: [0, 0], max: [1, 1] },
              },
              frameNc: null,
              frameVerify: null,
              programHash: 'abcd1234',
              cam: null,
            },
          ],
        };
        setEngraveRunClientLoader(async () => ({
          engraveGenerate: async () => generated,
          simOracle: async () => OK,
        }));
        await useEngraveRunStore.getState().generate();
        expect(useEngraveRunStore.getState().simGridPitchMm).toBe(0.12);
        // #535 — the check now records the grid the SWEEP ran on (0.12), not the sampled 0.1.
        expect(useEngraveRunStore.getState().generated?.programs[0]?.surfaceCheck?.gridPitchMm).toBe(0.12);

        // A rotary grid's second axis is degrees: it is never stated as a millimetre pitch.
        useSimStore.setState({
          loadProgram: async () => ready(true),
        });
        await useEngraveRunStore.getState().generate();
        expect(useEngraveRunStore.getState().simGridPitchMm).toBeNull();
      } finally {
        useSimStore.setState({ loadProgram: load });
      }
    });
  });

  it('requires acknowledgement for the named warning codes only', () => {
    const g: EngraveGenerated = {
      ...clean(),
      findings: [
        { severity: 'warning', code: 'vise-default', message: 'unmeasured ' },
        { severity: 'warning', code: 'vise-stock-not-proud', message: 'not an ack code' },
      ],
    };
    expect(requiredAckCodes(view({ generated: g }))).toEqual(['vise-default']);
  });

  // #688 — Design's Save writes the program; the clearance statement is the RUN's and belongs to
  // Cut step 1 (#689). The panel therefore asks `saveBlocker` to judge everything except the
  // acknowledgement, while Upload and Release keep the default — a program still cannot reach the
  // machine before the operator has said they looked.
  it('lets Design save without the clearance acknowledgement, but not Upload', () => {
    const okGen: EngraveGenerated = {
      ...clean(),
      findings: [],
      verify: { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1], max: [1, 1, 0] } } },
    };
    const v = view({
      generated: okGen,
      simStatus: 'ready',
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
      acknowledged: false,
      simDiagnostics: [{ severity: 'warning', code: 'vise-default', message: 'x' }] as EngraveRunView['simDiagnostics'],
    });
    expect(saveBlocker(v)).toBe('tick the clearance checkbox below');
    expect(saveBlocker(v, { requireAcknowledgement: false })).toBeNull();
    expect(uploadBlocker(v)).toBe('tick the clearance checkbox below');
  });

  it('blocks Save on any error, on a failed oracle and on a stale result', () => {
    const okGen: EngraveGenerated = { ...clean(), findings: [], verify: { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1], max: [1, 1, 0] } } } };
    expect(saveBlocker(view({ generated: okGen, simStatus: 'ready', oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } }))).toBeNull();

    const withError: EngraveGenerated = { ...okGen, findings: [{ severity: 'error', code: 'item-empty', message: 'x' }] };
    expect(runErrorCodes(view({ generated: withError }))).toEqual(['item-empty']);
    expect(saveBlocker(view({ generated: withError, simStatus: 'ready' }))).toContain('error');

    expect(saveBlocker(view({ generated: okGen, simStatus: 'ready', oracle: { ok: false, band: 0.016, levels: [], worst: { underCut: 2, overCut: 0 } } }))).toBe('the simulation does not match the prediction');
    expect(saveBlocker(view({ generated: okGen, staleSince: Date.now(), simStatus: 'ready' }))).toBe('the job or the machine frame changed since it was generated');
  });

  // #255 — Upload must never be reachable where Save is not. The two gates are separate functions
  // because Upload has one more clause, so the direction of that difference is asserted rather
  // than assumed: every reason Save is shut is a reason Upload is shut.
  it('never lets Upload be weaker than Save', () => {
    const okGen: EngraveGenerated = {
      ...clean(),
      verify: { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1], max: [1, 1, 0] } } },
    };
    const ready = { simStatus: 'ready' as const, oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } };
    const views: EngraveRunView[] = [
      view({ generated: okGen, ...ready }), // clear: this is the one the loop below compares against
      view(), // nothing generated
      view({ generated: clean() }), // generated, but the simulation never finished
      view({ generated: okGen, ...ready, staleSince: Date.now() }),
      view({ generated: { ...okGen, findings: [{ severity: 'error', code: 'item-empty', message: 'x' }] }, ...ready }),
      view({ generated: okGen, simStatus: 'ready', oracle: { ok: false, band: 0.016, levels: [], worst: { underCut: 2, overCut: 0 } } }),
      view({ generated: okGen, simStatus: 'ready' }), // the oracle never ran
      view({ generated: okGen, ...ready, phase: 'generating' }),
      view({ generated: okGen, ...ready, acknowledged: false, simDiagnostics: [{ severity: 'warning', code: 'vise-default', message: 'x' }] as EngraveRunView['simDiagnostics'] }),
    ];
    // At least one of them has to be genuinely clear, or the loop below proves nothing.
    expect(views.some((v) => saveBlocker(v) === null)).toBe(true);

    for (const v of views) {
      if (saveBlocker(v) !== null) {
        expect(uploadBlocker(v)).toBe(saveBlocker(v));
      } else {
        // Save is allowed; Upload is allowed too, unless the report is missing.
        expect(uploadBlocker(v)).toBeNull();
      }
    }
  });

  it('shuts Upload — and only Upload — when the program carries no verifier report', () => {
    const noReport: EngraveGenerated = { ...clean(), verify: null };
    const v = view({
      generated: noReport,
      simStatus: 'ready',
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
    });
    // Save has nothing to complain about: `runErrorCodes` reads `verify?.findings ?? []`, so an
    // absent report contributes no errors. That is exactly why Upload needs its own clause.
    expect(saveBlocker(v)).toBeNull();
    expect(uploadBlocker(v)).toBe('the program carries no verifier report');
  });

  // #469 (review R2) — the app uploads and plays ONE program. A job with two (a job stating
  // `setups[]`, or a facing job's face file beside its engraving) would leave the machine with
  // half the job and, on a `'first'` span, the vacuum on. Save stays open — the files are good —
  // and only Upload, which is the act that cannot complete, is shut.
  it('shuts Upload — and only Upload — on a job with more than one program (#469)', () => {
    const report = { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1] as [number, number, number], max: [1, 1, 0] as [number, number, number] } } };
    const program = (setupIndex: number): EngraveGenerated['programs'][number] => ({
      setupIndex,
      setupId: `setup-${setupIndex}`,
      toolKey: 'flat-1.0',
      nc: 'G90\nM02',
      verify: report,
      frameNc: null,
      frameVerify: null,
      programHash: `hash-${setupIndex}`,
      cam: null,
    });
    const v = view({
      generated: { ...clean(), verify: report, programs: [program(1), program(2)] },
      simStatus: 'ready',
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
    });
    expect(saveBlocker(v)).toBeNull();
    expect(uploadBlocker(v)).toBe('this job is 2 programs; the app plays one');
    // One program is not refused: the single-file case is every job the app can play today.
    expect(uploadBlocker({ ...v, generated: { ...v.generated!, programs: [program(1)] } })).toBeNull();
  });

  // #393 — the app's own half of the gap, and the reason the rule got one name. The session's
  // `ok: true` means the sweep produced material, so a program that drove the cutter into the jaw
  // reaches this store as a DIAGNOSTIC and nowhere else. If `runErrorCodes` stopped reading the
  // sweep's errors, Save and Upload would both open on a program the simulation refused — and the
  // scripts that write the bench files ask the same predicate (`engine/cnc/simGate.ts`).
  it('refuses to save or upload a program the simulation reported an error in (#393)', () => {
    const okGen: EngraveGenerated = {
      ...clean(),
      verify: { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1], max: [1, 1, 0] } } },
    };
    const v = view({
      generated: okGen,
      simStatus: 'ready',
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
      acknowledged: true,
      simDiagnostics: [
        {
          source: 'sweep',
          severity: 'error',
          code: 'tool-into-fixture',
          message: "checkpoint 0: the cutter drives 0.967 mm³ into the fixture 'Vise fixed jaw (left)'",
          checkpoint: 0,
        },
      ],
    });
    expect(runErrorCodes(v)).toEqual(['tool-into-fixture']);
    expect(saveBlocker(v)).toBe('1 error outstanding');
    expect(uploadBlocker(v)).toBe(saveBlocker(v));
  });

  it('marks a generated result stale as soon as the job is edited', async () => {
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => NOTHING,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    await useEngraveRunStore.getState().generate();
    const after = useEngraveRunStore.getState();
    expect(after.generated).not.toBeNull();
    expect(after.generated!.stage).toBe('findings');
    expect(after.phase).toBe('blocked');
    expect(after.staleSince).toBeNull();

    useEngraveJobStore.getState().setStock({ length: 120 });
    expect(useEngraveRunStore.getState().staleSince).not.toBeNull();
    // #581 — the stale mark says WHICH input moved, not "the job or the machine frame".
    expect(useEngraveRunStore.getState().staleReason).toBe('job');
    expect(saveBlocker(useEngraveRunStore.getState())).toBe('the job changed since it was generated');
  });

  // #297: the generator (post, verifier, frame file) and the simulation must judge ONE machine. The
  // saved frame is read once per run and handed to both; a change to the saved frame while the
  // generator is working must not reach the simulation load of the same run.
  it('hands the generator the frame read when Generate started, and calls the run stale if it changes mid-run (#297, #301)', async () => {
    const read = calibrationFromReplies(new Map(Object.entries(Z1_FRAME_REPLIES)), {
      machineId: 'Z1',
      measuredAt: '2026-10-06T13:01:11.000Z',
      host: '192.168.10.43',
    });
    if (!read.ok) throw new Error('the fixture should read');
    const first: MachineCalibration = read.calibration;
    // #581 follow-up — a REAL frame change: the stamp is the frame's numbers, not the read's
    // `source`/`measuredAt`, so a re-read of the same frame is not a different machine (below).
    const second: MachineCalibration = { ...first, frame: { ...first.frame, anchor1: [first.frame.anchor1[0] + 0.01, first.frame.anchor1[1]] } };

    useSettingsStore.setState({ machineCalibration: first });
    let generatedWith: MachineCalibration | null | undefined;
    let loads = 0;
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        loads += 1;
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (_job, _tool, _catalogue, calibration) => {
        generatedWith = calibration;
        // The user saves a new frame while the worker is generating.
        useSettingsStore.setState({ machineCalibration: second });
        return clean();
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
      useSettingsStore.setState({ machineCalibration: undefined });
    }
    expect(generatedWith).toBe(first);
    // The result describes the old frame, so it is stale and is never simulated against the new one.
    expect(useEngraveRunStore.getState().staleSince).not.toBeNull();
    expect(loads).toBe(0);
  });

  it('hands the simulation load the very frame the generator got (#297)', async () => {
    const read = calibrationFromReplies(new Map(Object.entries(Z1_FRAME_REPLIES)), {
      machineId: 'Z1',
      measuredAt: '2026-10-06T13:01:11.000Z',
      host: '192.168.10.43',
    });
    if (!read.ok) throw new Error('the fixture should read');
    useSettingsStore.setState({ machineCalibration: read.calibration });
    let generatedWith: MachineCalibration | null | undefined;
    let loadedWith: MachineCalibration | null | undefined;
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async (_nc, _setup, _tool, _id, calibration) => {
        loadedWith = calibration;
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (_job, _tool, _catalogue, calibration) => {
        generatedWith = calibration;
        return clean();
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
      useSettingsStore.setState({ machineCalibration: undefined });
    }
    expect(generatedWith).toBe(read.calibration);
    expect(loadedWith).toBe(read.calibration);
  });

  it('derives the ramp threshold from the predicted depths and hands it to the simulation load (#629)', async () => {
    const engraver: Tool = flatEndMill(0.5, { shape: 'engraving', tipDiameter: 0.5, diameter: 3.175, halfAngle: 15 });
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: 'inv:engrave-30-0-5', tool: engraver });
    let loadedThreshold: number | null | undefined;
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async (_nc, _setup, _tool, _id, _cal, _threads, _drill, _origin, _surface, threshold) => {
        loadedThreshold = threshold;
      },
    });
    const generated: EngraveGenerated = {
      ...clean(),
      predicted: [
        { depth: 1, polygons: [] },
        { depth: 2, polygons: [] },
        { depth: 3, polygons: [] },
      ],
    };
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => generated,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
      useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: 'flat-1.0' });
    }
    // The three depths are 1, 2, 3 mm apart by 1 mm: half the smallest level step is 0.5 mm.
    expect(loadedThreshold).toBeCloseTo(0.5);
  });

  // #301: the same rule Save already enforces for an edited job, for the machine's frame.
  it('marks a held result stale when the saved machine frame changes afterwards (#301)', async () => {
    useSettingsStore.setState({ machineCalibration: undefined });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => NOTHING,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    await useEngraveRunStore.getState().generate();
    expect(useEngraveRunStore.getState().staleSince).toBeNull();

    const read = calibrationFromReplies(new Map(Object.entries(Z1_FRAME_REPLIES)), {
      machineId: 'Z1',
      measuredAt: '2026-10-06T13:01:11.000Z',
      host: '192.168.10.43',
    });
    if (!read.ok) throw new Error('the fixture should read');
    useSettingsStore.getState().setMachineCalibration(read.calibration);
    try {
      expect(useEngraveRunStore.getState().staleSince).not.toBeNull();
      expect(useEngraveRunStore.getState().staleReason).toBe('machine');
      expect(saveBlocker(useEngraveRunStore.getState())).toBe('the machine frame changed since it was generated');
    } finally {
      useSettingsStore.setState({ machineCalibration: undefined });
    }
  });

  // #581 — two Generates on the same job whose verdicts disagree. #577 proved the sweep and the
  // oracle deterministic, so an input moved; the run records which, and the Matches prediction row
  // says so instead of flipping silently.
  describe('what changed between two Generates (#581)', () => {
    const DEF = (value: number) => ({ value, source: 'seeded' as const, setAt: null, unit: null, note: null });

    /** A fake run whose oracle verdict the test can flip, with a sim load that ends 'ready'. */
    function fakeRun(): { flip: (ok: boolean) => void; restore: () => void } {
      let ok = true;
      const load = useSimStore.getState().loadProgram;
      useSimStore.setState({
        loadProgram: async () => {
          useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
        },
      });
      setEngraveRunClientLoader(async () => ({
        engraveGenerate: async () => clean(),
        simOracle: async () => ({ ok, band: 0.016, levels: [], worst: { underCut: ok ? 0 : 2, overCut: 0 } }),
      }));
      return {
        flip: (next) => {
          ok = next;
        },
        restore: () => useSimStore.setState({ loadProgram: load }),
      };
    }

    afterEach(() => {
      useShopDefaultsStore.setState({ defaults: null });
      useSettingsStore.setState({ machineCalibration: undefined });
    });

    it('names the input that moved when the verdict flips', async () => {
      useSettingsStore.setState({ machineCalibration: undefined });
      useShopDefaultsStore.setState({ defaults: { 'drill.peckClearanceMm': DEF(0.4) } });
      const run = fakeRun();
      try {
        await useEngraveRunStore.getState().generate();
        expect(useEngraveRunStore.getState().oracle?.ok).toBe(true);
        expect(oracleSentence(useEngraveRunStore.getState())).not.toContain('since the previous Generate');

        run.flip(false);
        useShopDefaultsStore.setState({ defaults: { 'drill.peckClearanceMm': DEF(0.6) } });
        await useEngraveRunStore.getState().generate();

        const after = useEngraveRunStore.getState();
        expect(after.previousVerdict).toBe(true);
        expect(after.oracle?.ok).toBe(false);
        expect(after.changedSinceLast).toEqual(['shop']);
        expect(oracleSentence(after)).toContain('— the shop defaults changed since the previous Generate');
      } finally {
        run.restore();
      }
    });

    it('says so plainly when the verdict flips and no input moved — the determinism alarm', async () => {
      useSettingsStore.setState({ machineCalibration: undefined });
      const run = fakeRun();
      try {
        await useEngraveRunStore.getState().generate();
        run.flip(false);
        await useEngraveRunStore.getState().generate();

        const after = useEngraveRunStore.getState();
        expect(after.changedSinceLast).toEqual([]);
        expect(oracleSentence(after)).toContain(
          'nothing this run reads changed since the previous Generate; the same inputs gave a different verdict',
        );
      } finally {
        run.restore();
      }
    });

    it('stays silent when the verdict holds', async () => {
      useSettingsStore.setState({ machineCalibration: undefined });
      const run = fakeRun();
      try {
        await useEngraveRunStore.getState().generate();
        await useEngraveRunStore.getState().generate();

        const after = useEngraveRunStore.getState();
        expect(after.previousVerdict).toBe(true);
        expect(oracleSentence(after)).not.toContain('since the previous Generate');
      } finally {
        run.restore();
      }
    });
  });

  // #581 follow-up — an origin write is a NEW job object with the SAME fingerprint: the
  // registration's `setStock` stamps the measured bow and its provenance, both outside
  // `jobFingerprint` (#621/#627). The run's staleness is the job's STAMP, not the object's identity,
  // so that write must not stale a result that still describes the job — and a real edit still must.
  it('an origin write that replaces the job object does not stale the result', async () => {
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => NOTHING,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    await useEngraveRunStore.getState().generate();
    expect(useEngraveRunStore.getState().generated).not.toBeNull();
    expect(useEngraveRunStore.getState().staleSince).toBeNull();

    const before = useEngraveJobStore.getState().job;
    useEngraveJobStore.getState().replace({
      ...before,
      stock: {
        ...before.stock,
        flatness: { xMm: 0.33, yMm: 0.1, source: 'measured', touchCount: 5, measuredAt: '2026-10-25T04:10:00.000Z' },
      },
      sources: { ...before.sources, stock: { ...before.sources?.stock, flatness: 'measured' } },
    });
    expect(useEngraveJobStore.getState().job).not.toBe(before); // a new document object...
    expect(useEngraveRunStore.getState().staleSince).toBeNull(); // ...with the same program

    useEngraveJobStore.getState().setStock({ length: before.stock.length - 1 });
    expect(useEngraveRunStore.getState().staleSince).not.toBeNull();
    expect(useEngraveRunStore.getState().staleReason).toBe('job');
  });

  // The machine half of the same rule: saving a fresh read of the frame the machine already had is
  // not a different machine, and a real frame change still stales the pack mid-run.
  it('a re-read of the SAME machine frame does not stale the run', async () => {
    const read = calibrationFromReplies(new Map(Object.entries(Z1_FRAME_REPLIES)), {
      machineId: 'Z1',
      measuredAt: '2026-10-06T13:01:11.000Z',
      host: '192.168.10.43',
    });
    if (!read.ok) throw new Error('the fixture should read');
    const first: MachineCalibration = read.calibration;
    useSettingsStore.setState({ machineCalibration: first });
    let loads = 0;
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        loads += 1;
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => {
        // The operator takes a new calibration read while the worker is generating; same numbers.
        useSettingsStore.setState({ machineCalibration: { ...first, source: 'a re-read', measuredAt: '2026-10-25T04:11:00.000Z' } });
        return clean();
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    try {
      await useEngraveRunStore.getState().generate();
      // Asserted BEFORE the cleanup: clearing the saved frame afterwards IS a change, and rightly
      // stales the result — this test is about the re-read landing on the same numbers.
      expect(useEngraveRunStore.getState().staleSince).toBeNull();
      expect(useEngraveRunStore.getState().staleReason).toBeNull();
      expect(loads).toBe(1); // the run carried on: the frame it was posted against did not change
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
      useSettingsStore.setState({ machineCalibration: undefined });
    }
  });

  // #324 — the catalogue reaches the worker only if the CALLER sends it: `feeds.ts`'s module state
  // is invisible across the boundary, so whatever this store does not hand over is simply absent
  // when the `.nc` is posted. The other half of this pair is `engraveGenerate.spec.ts`'s S/F case,
  // which proves the handed rows are what the program and the run sheet are made of.
  it('hands the worker the catalogue rows the house loaded (#324)', async () => {
    const ROW: FeedCatalogueRow = {
      cutterId: '112111313812',
      material: 'Hardwood',
      rpm: 9800,
      feed: 700,
      plungeFeed: 250,
      stepDown: 0.7,
    };
    let seen: readonly FeedCatalogueRow[] | null = null;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (_job, _tool, catalogue) => {
        seen = catalogue;
        return NOTHING;
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    setFeedCatalogue([ROW]);
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      clearFeedCatalogue();
    }
    expect(seen).toEqual([ROW]);
  });

  it('passes "no saved frame" as null to both, not as a fresh read (#297)', async () => {
    useSettingsStore.setState({ machineCalibration: undefined });
    let generatedWith: MachineCalibration | null | undefined = undefined;
    let loadedWith: MachineCalibration | null | undefined = undefined;
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async (_nc, _setup, _tool, _id, calibration) => {
        loadedWith = calibration;
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (_job, _tool, _catalogue, calibration) => {
        generatedWith = calibration;
        return clean();
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
    expect(generatedWith).toBeNull();
    expect(loadedWith).toBeNull();
  });
});

// #432 review R10 — the facing pick runs in the worker, where `toolCondition`'s summary map is
// empty. The store therefore has to hand `inventoryConditions()` across in the same snapshot as
// `getTools()`; a wiring bug is invisible in the result (the worker just faces with a cutter the
// bench marked broken). This pins the hand-over itself; `facingTool.spec.ts` pins the rule it feeds.
describe('engraveRunStore (#432 R10) — the facing pick’s condition table', () => {
  function copy(id: string, condition: ToolCopy['condition']): ToolCopy {
    return {
      id,
      condition,
      whereabouts: { kind: 'box' },
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    };
  }

  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: 'flat-1.0' }); // #516 item 5 — the default job no longer seeds a cutter
    resetInventoryConditions();
  });

  afterEach(() => {
    setEngraveRunClientLoader(null);
    resetInventoryConditions();
  });

  it('hands the inventory’s summary table beside the cutter list', async () => {
    setInventoryConditions(
      [{ id: 'abc', quantity: 1, copies: [copy('abc-1', 'broken')] }],
      (id) => `inv:${id}`,
    );
    let handed: EngraveShopOpts | undefined;
    setEngraveRunClientLoader(async () => ({
      // NOTHING stops the pipeline at `findings`, so the test needs no sim client; the shop options
      // are already on the call by then.
      engraveGenerate: async (_job, _tool, _catalogue, _calibration, _margins, shop) => {
        handed = shop;
        return NOTHING;
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));

    await useEngraveRunStore.getState().generate();

    // The table is the inventory's own — note and all — not a rebuild of it, and it travels with
    // the same snapshot as `tools`. The worker can then skip this cutter by name.
    expect(handed?.conditions?.get('inv:abc')).toEqual(conditionForKey('inv:abc'));
    expect(handed?.conditions?.get('inv:abc')!.usable).toBe(0);
    expect(handed?.tools).not.toBeNull();
  });
});

describe('#395 one gate, two ways to reach it', () => {
  // The reason the gates live in their own module, and the only thing that keeps them there: the
  // store cannot be loaded outside a browser (`platform/features` reads vite `define`s), so a script
  // that needs one of these has to be able to import it WITHOUT the store. The script that actually
  // hands a file to the machine (`scripts/machine-upload-check.ts`) does exactly that.
  it('is the same implementation at both paths, not a re-implementation', () => {
    expect(store.uploadBlocker).toBe(gate.uploadBlocker);
    expect(store.saveBlocker).toBe(gate.saveBlocker);
    expect(store.runErrorCodes).toBe(gate.runErrorCodes);
    expect(store.requiredAckCodes).toBe(gate.requiredAckCodes);
    expect(store.ACKNOWLEDGE_CODES).toBe(gate.ACKNOWLEDGE_CODES);
  });

  it('keeps the gate module free of runtime imports that need a browser', () => {
    // A text guard, and one level deep: it pins the module's own imports, not the whole graph. What
    // it catches is the regression that would matter — a runtime import added to this module (the
    // obvious one being `featureSim`), which is how every other store here would break a node
    // script. The gate's behaviour is pinned by the tests above; this pins its addressability.
    const src = readFileSync(join(process.cwd(), 'src/store/engraveRunGate.ts'), 'utf8');
    const runtimeImports = [...src.matchAll(/^import\s+(?!type\b)[^'"]*'([^']+)'/gm)].map((m) => m[1]);
    // #581 added the second one: `runInputs` is pure engine data (`jobFingerprint`, `canonicalJson`,
    // `programHash`) whose every other import is `import type`, so it loads in a node script exactly
    // as `simGate` does. A browser import (`platform/features`, a client, a worker) still fails here.
    expect(runtimeImports).toEqual(['@/engine/cnc/simGate', '@/engine/cnc/engrave/runInputs']);
  });
});

// #642 — EVERY INPUT THE STAMP RECORDS has a watcher. Before this only the job and the machine frame
// marked a held result stale, so the shop defaults, the feeds table, the synced catalogue, the
// cutters' conditions, the depth margins and the registration's fitted surface could move under a
// result and Save/Upload stayed green — while the #581 stamp knew all eight. Each test below moves
// one input after a Generate and reads the reason named on the run.
describe('#642 the run watches every input it stamps', () => {
  const DEF = (value: number) => ({ value, source: 'chosen' as const, setAt: null, unit: null, note: null });
  const TARGET = { host: '192.0.2.10', port: 2222 };
  const ROW: StoredFeedRow = {
    material: 'softwood',
    edge: null,
    minDiameter: 0.8,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.5, stepOverFraction: 0.45, peckFraction: 1, air: true },
    source: 'seeded',
    provenance: 'A shop row.',
  };

  /** A generated, non-stale result: the state every watcher below has to notice a change under. */
  async function held(): Promise<void> {
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => NOTHING,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    await useEngraveRunStore.getState().generate();
    expect(useEngraveRunStore.getState().generated).not.toBeNull();
    expect(useEngraveRunStore.getState().staleSince).toBeNull();
  }

  afterEach(() => {
    setEngraveRunClientLoader(null);
    useShopDefaultsStore.setState({ defaults: null });
    resetFeedTableStore();
    setLocatedFeedTable(null);
    clearFeedCatalogue();
    resetInventoryConditions();
    resetEngraveRegistrationStore();
  });

  it('names the shop defaults when a value moves afterwards', async () => {
    await held();
    useShopDefaultsStore.setState({ defaults: { 'drill.peckClearanceMm': DEF(0.4) } });
    expect(useEngraveRunStore.getState().staleReason).toBe('shop');
    expect(saveBlocker(useEngraveRunStore.getState())).toBe('the shop defaults changed since it was generated');
  });

  it('a re-read of the shop defaults to the same values is not a change', async () => {
    useShopDefaultsStore.setState({ defaults: { 'drill.peckClearanceMm': DEF(0.4) } });
    await held();
    // A new object (a fresh read), the same numbers: `shopKey` hashes values, not the document.
    useShopDefaultsStore.setState({ defaults: { 'drill.peckClearanceMm': DEF(0.4) } });
    expect(useEngraveRunStore.getState().staleSince).toBeNull();
  });

  it('names the feed table when a row arrives afterwards', async () => {
    await held();
    setLocatedFeedTable([ROW]);
    useFeedTableStore.setState({
      rows: [{ id: 'feed-1', setAt: null, note: null, ...ROW } as FeedRow],
    });
    expect(useEngraveRunStore.getState().staleReason).toBe('feeds');
  });

  it('names the feed catalogue when a sync replaces its rows afterwards', async () => {
    await held();
    const CAT: FeedCatalogueRow = { cutterId: '112111313812', material: 'Hardwood', rpm: 9800, feed: 700, plungeFeed: 250, stepDown: 0.7 };
    setFeedCatalogue([CAT]);
    useToolRegistryStore.setState({ feedCount: 1 });
    expect(useEngraveRunStore.getState().staleReason).toBe('catalogue');
  });

  it('names the cutter list when an inventory condition moves afterwards', async () => {
    await held();
    const copy: ToolCopy = {
      id: 'abc-1',
      condition: 'broken',
      whereabouts: { kind: 'box' },
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    };
    setInventoryConditions([{ id: 'abc', quantity: 1, copies: [copy] }], (id) => `inv:${id}`);
    useToolRegistryStore.setState({ items: [] });
    expect(useEngraveRunStore.getState().staleReason).toBe('cutters');
  });

  it('names the depth margins when only zTolerance moves afterwards', async () => {
    await held();
    const before = useSettingsStore.getState().margins;
    try {
      useSettingsStore.setState({ margins: { ...before, zTolerance: before.zTolerance + 0.05 } });
      expect(useEngraveRunStore.getState().staleReason).toBe('margins');
    } finally {
      useSettingsStore.setState({ margins: before });
    }
  });

  it('a zTolerance change DURING the generate stales the result, not just boundaryMargin', async () => {
    // The mid-run check after `engraveGenerate` returns must compare the run's own margin STAMP: on a
    // first run no held result exists for the watcher to mark, so only this check can catch it.
    const before = useSettingsStore.getState().margins;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => {
        useSettingsStore.setState({ margins: { ...before, zTolerance: before.zTolerance + 0.05 } });
        return NOTHING;
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    try {
      await useEngraveRunStore.getState().generate();
      expect(useEngraveRunStore.getState().staleSince).not.toBeNull();
      expect(useEngraveRunStore.getState().staleReason).toBe('margins');
    } finally {
      useSettingsStore.setState({ margins: before });
    }
  });

  it('names the fitted surface frame when a registration replaces it afterwards', async () => {
    await held();
    useEngraveRegistrationStore
      .getState()
      .record(useEngraveJobStore.getState().job.id, TARGET, {} as never, {} as never, {
        plane: { offset: -0.2, slopeX: 0.002, slopeY: 0 },
        z0: -56,
      });
    expect(useEngraveRunStore.getState().staleReason).toBe('surface');
    expect(saveBlocker(useEngraveRunStore.getState())).toBe('the fitted surface frame changed since it was generated');
  });

  it('a FLAT registration after Generate is not a different surface frame', async () => {
    await held();
    useEngraveRegistrationStore
      .getState()
      .record(useEngraveJobStore.getState().job.id, TARGET, {} as never, {} as never, null);
    expect(useEngraveRunStore.getState().staleSince).toBeNull();
  });
});
