// The engrave RUN state (#206): the save gate and the staleness rule. No wasm, no worker — the
// client is faked, so this is the pure half of the store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as store from '@/store/engraveRunStore';
import * as gate from '@/store/engraveRunGate';
import {
  useEngraveRunStore,
  setEngraveRunClientLoader,
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
import { useSettingsStore } from '@/store/settingsStore';
import { calibrationFromReplies, type MachineCalibration } from '@/engine/cnc';
import { clearFeedCatalogue, setFeedCatalogue, type FeedCatalogueRow } from '@/engine/cnc/feeds';
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
    useEngraveJobStore.getState().replace(defaultEngraveJob());
    // No Makera catalogue unless a test loads one: it is module state (`feeds.ts`), so it outlives a
    // test that set it (#324).
    clearFeedCatalogue();
  });

  it('refuses Save before anything is generated', () => {
    expect(saveBlocker(view())).toBe('Generate first.');
  });

  it('requires acknowledgement for the named warning codes only', () => {
    const g: EngraveGenerated = {
      ...clean(),
      findings: [
        { severity: 'warning', code: 'vise-default', message: 'unmeasured ' },
        { severity: 'warning', code: 'stock-proud-too-small', message: 'not an ack code' },
      ],
    };
    expect(requiredAckCodes(view({ generated: g }))).toEqual(['vise-default']);
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
    expect(saveBlocker(useEngraveRunStore.getState())).toBe('the job or the machine frame changed since it was generated');
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
    const second: MachineCalibration = { ...first, source: 'a different read, saved mid-run' };

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
      expect(saveBlocker(useEngraveRunStore.getState())).toBe('the job or the machine frame changed since it was generated');
    } finally {
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
    useEngraveJobStore.getState().replace(defaultEngraveJob());
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
    expect(runtimeImports).toEqual(['@/engine/cnc/simGate']);
  });
});
