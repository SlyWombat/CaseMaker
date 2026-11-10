// The engrave RUN state (#206): the save gate and the staleness rule. No wasm, no worker — the
// client is faked, so this is the pure half of the store.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  firstRunError,
  type EngraveRunView,
} from '@/store/engraveRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  ENGRAVE_PICK_DEBOUNCE_MS,
  ENGRAVE_PREVIEW_DEBOUNCE_MS,
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveGenerated, EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { goalCutIntoUnchecked, type DesignCheckItem, type DesignCheckReport, type GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';
import {
  conditionForKey,
  resetInventoryConditions,
  setInventoryConditions,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { useSimStore } from '@/store/simStore';
import { flightCrumbs } from '@/platform/flightRecorder';
import type { SimLoadOk } from '@/workers/sim/session';
import { useSettingsStore } from '@/store/settingsStore';
import { shopDefault, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { calibrationFromReplies, type MachineCalibration } from '@/engine/cnc';
import { clearFeedCatalogue, setFeedCatalogue, setLocatedFeedTable, type FeedCatalogueRow, type StoredFeedRow } from '@/engine/cnc/feeds';
import { resetFeedTableStore, useFeedTableStore } from '@/store/feedTableStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { setInventoryEntries } from '@/engine/cnc/toolRegistry';
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
  // #924 activation — `EngraveGenerated` states the design items now; a run with none is empty.
  designItems: [],
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
    // #924 activation — `EngraveGenerated` states the design items now; a run with none is empty.
    designItems: [],
    // #744 — a run of one program is the shape the walk reads; `nc` above is that program's file.
    programs: [
      {
        setupIndex: 1,
        setupId: 'setup-1',
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

/**
 * What a fake `loadProgram` hands the sweep (#744): a swept program with no findings. The store
 * reads the RESULT now (it walks every program), not only the sim store's published state.
 */
function swept(over: Partial<SimLoadOk> = {}): SimLoadOk {
  return {
    ok: true,
    diagnostics: [],
    summary: { rotary: false },
    stats: { engine: 'exact', removedVolume: 0 },
    count: 1,
    meshes: { removal: null },
    ...over,
  } as unknown as SimLoadOk;
}

describe('engraveRunStore (#206)', () => {
  // #844 — EVERY PROGRAM'S ORACLE JUDGES ITS OWN FILE. A multi-program run (a rest pair, a
  // board's several drill cutters) simulates each file; before this, only program 1's match was
  // judged. Now every program is compared with its OWN predictions, the run's tick is all of
  // them, and a failure names the file.
  describe('#844 every program’s own oracle', () => {
    const PREDICTED = (itemId: string): { depth: number; itemId: string; polygons: [] } => ({
      depth: 0.5,
      itemId,
      polygons: [],
    });

    /** Two programs, each with its own predictions (or none, like a stored result). */
    function twoPrograms(first: ReturnType<typeof PREDICTED>[] | undefined, second: ReturnType<typeof PREDICTED>[] | undefined): EngraveGenerated {
      const base = clean();
      return {
        ...base,
        predicted: [PREDICTED('top-level')],
        programs: [
          { ...base.programs[0]!, programHash: 'p1', ...(first === undefined ? {} : { predicted: first }) },
          { ...base.programs[0]!, programHash: 'p2', ...(second === undefined ? {} : { predicted: second }) },
        ],
      };
    }

    async function runWith(
      generated: EngraveGenerated,
      answer: (predicted: readonly { itemId?: string }[]) => { ok: boolean },
    ): Promise<{ seen: (readonly { itemId?: string }[])[] }> {
      // The job carries its own cutter, so the run does not depend on a registry another test
      // populated. `toolKey` stays `flat-1.0` (the program labels read it).
      const jobNow = useEngraveJobStore.getState().job;
      useEngraveJobStore.setState({ job: { ...jobNow, tool: flatEndMill(3.175, { name: '3.175 mm flat end' }) } });
      const realLoad = useSimStore.getState().loadProgram;
      useSimStore.setState({
        loadProgram: async () => {
          useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
          return swept();
        },
      });
      const seen: (readonly { itemId?: string }[])[] = [];
      setEngraveRunClientLoader(async () => ({
        engraveGenerate: async () => generated,
        simOracle: async (predicted) => {
          seen.push(predicted);
          const ok = answer(predicted).ok;
          return { ok, band: 0.016, levels: [], worst: { underCut: ok ? 0 : 0.5, overCut: 0 } } as never;
        },
      }));
      try {
        await useEngraveRunStore.getState().generate();
      } finally {
        useSimStore.setState({ loadProgram: realLoad });
      }
      return { seen };
    }

    it('judges each program against its own list, and the gate names the one that did not match', async () => {
      const { seen } = await runWith(twoPrograms([PREDICTED('first')], [PREDICTED('second')]), (predicted) => ({
        ok: predicted[0]?.itemId !== 'second',
      }));
      // One call per program, each with ITS OWN predictions.
      expect(seen).toHaveLength(2);
      expect(seen[0]![0]!.itemId).toBe('first');
      expect(seen[1]![0]!.itemId).toBe('second');
      const s = useEngraveRunStore.getState();
      expect(s.oracle?.ok).toBe(false);
      expect(s.oraclePrograms.map((o) => o.label)).toEqual(['program 1 (flat-1.0)', 'program 2 (flat-1.0)']);
      expect(s.oraclePrograms.map((o) => o.report.ok)).toEqual([true, false]);
      // The gate's sentence names the file, not the run.
      const sentence = saveBlocker(gate.gateViewFor(s, null, false));
      expect(sentence).toContain('program 2 (flat-1.0)');
      expect(sentence).toContain('the simulation does not match the prediction');
    });

    it('#1035 — the gate names the FINISH, never the rough whose coverage is deferred', () => {
      // The two-surface ruling (6b): an intermediate goal program's coverage is judged at the end
      // of the run, so a failing run names the program that really decided — never the deferred
      // rough that would otherwise be `find`'s first `!ok`.
      const goal = (over: Record<string, unknown> = {}): never =>
        ({
          ok: true, ran: true, reason: null, goalCells: 10, pitchMm: 0.1, cutIntoFloorMm: 0.1,
          cutIntoFraction: 0, cutIntoAreaMm2: 0, cutIntoVolumeMm3: 0, maxCutIntoMm: 0, maxCutIntoAt: null,
          leftoverFractions: [0, 0, 0], leftoverVolumeMm3: 0, maxLeftoverMm: 0, coverageFraction: 1,
          passCoverage: 0.95, medianDeltaMm: 0, edgeBreakFraction: 0, wallNotScoredFraction: 0,
          shadowNotScoredFraction: 0, straddlingNotScoredCells: 0, straddlingMaxStepMm: 0,
          adjudicatedFraction: 0, adjudicatedMaxMm: 0, adjudicatedMaxAt: null, sentence: 'goal check',
          ...over,
        }) as never;
      const rough = { index: 0, label: 'program 1 (flat-1.0)', report: { ok: false, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 }, goalCutInto: goal({ ok: false, leftoverFractions: [0.19, 0, 0] }) } as never, goalCoverageDeferred: true };
      const finish = { index: 1, label: 'program 2 (ball-2)', report: { ok: false, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 }, goalCutInto: goal({ ok: false, leftoverFractions: [0.12, 0, 0] }) } as never, goalCoverageDeferred: false };
      const sentence = saveBlocker(
        view({
          generated: clean(),
          phase: 'blocked',
          simStatus: 'ready',
          oracle: { ok: false, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
          oraclePrograms: [rough, finish],
        }),
      );
      expect(sentence).toBe('program 2 (ball-2): the simulation does not match the prediction');
    });

    it('a stored result with no per-program predictions uses the top-level list for program 1 and does not re-judge later files', async () => {
      const { seen } = await runWith(twoPrograms(undefined, undefined), () => ({ ok: true }));
      expect(seen).toHaveLength(1);
      expect(seen[0]![0]!.itemId).toBe('top-level');
      const s = useEngraveRunStore.getState();
      expect(s.oracle?.ok).toBe(true);
      expect(s.oraclePrograms.map((o) => o.index)).toEqual([0]);
    });

    it('all programs passing is the run’s tick, and the totals are the sum of their worsts', async () => {
      const { seen } = await runWith(twoPrograms([PREDICTED('first')], [PREDICTED('second')]), () => ({ ok: true }));
      expect(seen).toHaveLength(2);
      const s = useEngraveRunStore.getState();
      expect(s.oracle?.ok).toBe(true);
      expect(s.oraclePrograms).toHaveLength(2);
      expect(saveBlocker(gate.gateViewFor(s, null, false))).toBeNull();
    });
  });

  // #948 — THE COMBINED REPORT CARRIES THE GOAL CHECK. A goal program's own oracle report holds
  // `goalCutInto`, but the run's report is `combineOracles`' — and it used to drop the field, so
  // the Cut card's goal line never mounted on a real run. The verdict is the FINAL surface's: a
  // #869 rough/finish split posts two goal programs, both carry a check, and the rough's leftover
  // is not the run's answer — the LAST program's report that carries one is taken.
  describe('#948 the goal check on the combined report', () => {
    const report = (over: Partial<OracleReport> = {}): OracleReport => ({
      ok: true,
      band: 0.016,
      levels: [],
      worst: { underCut: 0, overCut: 0 },
      ...over,
    });
    const check = (reason: string): GoalCutIntoReport => goalCutIntoUnchecked(reason);

    it('takes the LAST program’s check, not the first: the finish surface is the verdict', () => {
      const combined = store.combineOracles([report({ goalCutInto: check('rough') }), report({ goalCutInto: check('finish') })], null);
      expect(combined.goalCutInto).toBeDefined();
      expect(combined.goalCutInto?.reason).toBe('finish');
    });

    it('carries the last report that has one when a later program does not', () => {
      const combined = store.combineOracles([report({ goalCutInto: check('only') }), report()], null);
      expect(combined.goalCutInto?.reason).toBe('only');
    });

    it('adds no key when no program has a goal check', () => {
      const combined = store.combineOracles([report(), report()], null);
      expect('goalCutInto' in combined).toBe(false);
    });

    it('a board’s copper report never supplies the goal check', () => {
      const combined = store.combineOracles([report()], report({ goalCutInto: check('copper') }));
      expect('goalCutInto' in combined).toBe(false);
    });
  });

  // #947 gate 7 / #924 — THE OTHER TWO PIECES OF THE ORACLE'S EVIDENCE travel with the goal check,
  // the same way. Without them the Simulate footer and the run sheet read `undefined`: the sliver
  // width sentence never appears, and a failed design check is a cross with no sentence behind it.
  describe('#947/#924 the sliver width and the design check on the combined report', () => {
    const report = (over: Partial<OracleReport> = {}): OracleReport => ({
      ok: true,
      band: 0.016,
      levels: [],
      worst: { underCut: 0, overCut: 0 },
      ...over,
    });
    const design = (ok: boolean): DesignCheckReport => ({
      ok,
      band: 0.016,
      levels: [],
      worst: { unreached: ok ? 0 : 1, tooFar: 0 },
      areaFloor: 0.001,
      pitchMm: 0.02,
      sentence: '',
    });

    it('carries the sliver width from the last program that ran the comparison', () => {
      const combined = store.combineOracles([report({ sliverWidthMm: 0.01 }), report()], null);
      expect(combined.sliverWidthMm).toBe(0.01);
      expect('sliverWidthMm' in store.combineOracles([report(), report()], null)).toBe(false);
    });

    it('carries the design check, and a failing one wins the carry', () => {
      expect(store.combineOracles([report({ designCheck: design(true) })], null).designCheck?.ok).toBe(true);
      // The run is red because program 1 failed its design check; the carried check must be the
      // one that explains the cross, not a later program's passing one.
      const mixed = store.combineOracles(
        [report({ ok: false, designCheck: design(false) }), report({ designCheck: design(true) })],
        null,
      );
      expect(mixed.designCheck?.ok).toBe(false);
      expect('designCheck' in store.combineOracles([report()], null)).toBe(false);
    });
  });

  // #924 activation — THE APP'S OWN GENERATE RUNS THE DESIGN CHECK. The generator gives each
  // program its own raw design items (`EngraveProgram.designItems`, the raw-geometry sibling of the
  // `predicted` list #844 forwards); the walk has to hand them to the oracle on the same call, or
  // the check stays dormant on every real job (the whole point of the wiring). A result without
  // them must behave exactly as it did before.
  describe('#924 the oracle is handed the program’s own design items', () => {
    const ITEM = (itemId: string): DesignCheckItem => ({
      itemId,
      design: [[[0, 0], [5, 0], [5, 5], [0, 5]]],
      depth: 0.5,
      cutter: { tipRadius: 1, tanHalf: 0, maxRadius: 1 },
    });
    const PRED = (itemId: string) => ({ depth: 0.5, itemId, polygons: [] });

    type Call = {
      predicted: readonly { itemId?: string }[];
      designItems: readonly DesignCheckItem[] | undefined;
    };

    async function runCapturing(generated: EngraveGenerated): Promise<Call[]> {
      const jobNow = useEngraveJobStore.getState().job;
      useEngraveJobStore.setState({ job: { ...jobNow, tool: flatEndMill(3.175, { name: '3.175 mm flat end' }) } });
      const realLoad = useSimStore.getState().loadProgram;
      useSimStore.setState({
        loadProgram: async () => {
          useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
          return swept();
        },
      });
      const calls: Call[] = [];
      setEngraveRunClientLoader(async () => ({
        engraveGenerate: async () => generated,
        simOracle: async (predicted, _pcb, designItems) => {
          calls.push({ predicted, designItems });
          return { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } as never;
        },
      }));
      try {
        await useEngraveRunStore.getState().generate();
      } finally {
        useSimStore.setState({ loadProgram: realLoad });
      }
      return calls;
    }

    /** Two engraving programs, each with its own predictions, and the given design items. */
    function twoFiles(items: {
      first?: DesignCheckItem[];
      second?: DesignCheckItem[];
      runLevel?: DesignCheckItem[];
    }): EngraveGenerated {
      const base = clean();
      return {
        ...base,
        predicted: [PRED('top-level')],
        ...(items.runLevel === undefined ? {} : { designItems: items.runLevel }),
        programs: [
          {
            ...base.programs[0]!,
            programHash: 'p1',
            predicted: [PRED('first')],
            ...(items.first === undefined ? {} : { designItems: items.first }),
          },
          {
            ...base.programs[0]!,
            programHash: 'p2',
            predicted: [PRED('second')],
            ...(items.second === undefined ? {} : { designItems: items.second }),
          },
        ],
      };
    }

    it('forwards each program’s own items on its own oracle call', async () => {
      const calls = await runCapturing(twoFiles({ first: [ITEM('first-item')], second: [ITEM('second-item')] }));
      expect(calls).toHaveLength(2);
      expect(calls[0]!.designItems?.map((d) => d.itemId)).toEqual(['first-item']);
      expect(calls[1]!.designItems?.map((d) => d.itemId)).toEqual(['second-item']);
    });

    it('a stored result with no per-program items hands program 1 the run’s own list, and later files none', async () => {
      const calls = await runCapturing(twoFiles({ runLevel: [ITEM('run-item')] }));
      expect(calls).toHaveLength(2);
      expect(calls[0]!.designItems?.map((d) => d.itemId)).toEqual(['run-item']);
      expect(calls[1]!.designItems).toBeUndefined();
    });

    it('a result with no items at all sends an empty list — the session runs no check, as before', async () => {
      const calls = await runCapturing(twoFiles({}));
      expect(calls).toHaveLength(2);
      // `clean()`'s run states none, so program 1 gets the empty list (not undefined) and the
      // session's own `length > 0` guard keeps the report exactly what it was before #924.
      expect(calls[0]!.designItems).toEqual([]);
      expect(calls[1]!.designItems).toBeUndefined();
    });
  });

  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    setEngraveRunClientLoader(null);
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: 'flat-1.0' }); // #516 item 5 — the default job no longer seeds a cutter
    // No Makera catalogue unless a test loads one: it is module state (`feeds.ts`), so it outlives a
    // test that set it (#324).
    clearFeedCatalogue();
  });

  // #1032 — A POSTED PROGRAM'S KEY MUST RESOLVE BY ALL THREE IDENTITIES A TOOL RECORD STATES.
  // The model engine stamps each program's `toolKey` with `cutterKeyOf(tool)` = `tool.id ??
  // tool.name`, and the built-in tier is not identified by its registry key: `flat-1.0` has no
  // `id` (so its NAME is stamped) and `flat-3.175x12-metal` carries the physical catalogue id
  // `112111313812`. The sweep resolved a posted key by exact registry key only, so a job planned
  // with either built-in was refused as "not on this bench" (the flipMouldShell walk's red on
  // 966-collapse, #1021 comment 6696909602). Red-first at d792bd281: both programs stop at
  // program 1's tool-refused and `simPrograms` holds only the failure.
  it('resolves a posted program keyed by a built-in’s display name and one keyed by its physical id', async () => {
    const base = clean();
    const program = base.programs[0]!;
    const generated: EngraveGenerated = {
      ...base,
      programs: [
        { ...program, programHash: 'name-keyed', toolKey: '1 mm flat end' },
        { ...program, programHash: 'id-keyed', toolKey: '112111313812' },
      ],
    };
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
        return swept();
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => generated,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
      setEngraveRunClientLoader(null);
    }
    const s = useEngraveRunStore.getState();
    expect(s.simDiagnostics.filter((d) => d.code === 'tool-refused')).toEqual([]);
    expect(s.simPrograms.map((p) => p.index)).toEqual([0, 1]);
    expect(s.simStatus).toBe('ready');
  });

  // #1034 — A FLIPPED SETUP SEEDS EVERY PROGRAM FROM ITS PREDECESSOR. Measured on the shell
  // (#1032): the four programs' seeds read [blank, blank, blank + carried, blank] — once a
  // cross-setup removal mesh was in the chain, #817's all-chain rule dropped the field path for
  // the REST of the later setup too, so side 2's finish was swept on a bare blank (neither
  // program 3's removal nor side 1's floor). The rule becomes per predecessor: a program whose
  // predecessor is in its own setup seeds from that predecessor's field, and the earlier setup's
  // carried floor rides the whole later setup.
  describe('#1034 — the sweep seeds each program from its own predecessor', () => {
    const fieldOf = (nc: string): unknown => ({ marker: `${nc}-field` });
    // A carryable seed must be a real mesh: `carrySeedsForSetup` transforms its positions.
    const meshOf = (nc: string): unknown => ({
      marker: nc,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      triangleCount: 1,
      vertexCount: 3,
      bbox: { min: [0, 0, 0], max: [1, 1, 0] },
      componentCount: 1,
    });

    /** A two-side job: setup 1 top-up, setup 2 bottom-up in the vise (the walk's own flip). */
    function shareTwoSetups(): void {
      const job = useEngraveJobStore.getState().job;
      useEngraveJobStore.setState({
        job: {
          ...job,
          tool: flatEndMill(3.175, { name: '3.175 mm flat end' }),
          setups: [
            {
              id: 'setup-1',
              orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
              mount: { kind: 'vise' },
              itemIds: [],
              tools: [],
            },
            {
              id: 'setup-2',
              orientation: { top: 'bottom', bottom: 'top', left: 'left', right: 'right', front: 'back', back: 'front' },
              mount: { kind: 'vise' },
              itemIds: [],
              tools: [],
            },
          ],
        },
      });
    }

    async function runPrograms(
      plan: readonly { nc: string; setupIndex: number }[],
      opts: { refuseFirst?: readonly string[] } = {},
    ): Promise<{
      calls: Map<string, { carried: unknown; priorFields: unknown }>;
      all: { nc: string; carried: unknown; priorFields: unknown }[];
    }> {
      shareTwoSetups();
      const base = clean();
      const program = base.programs[0]!;
      const generated: EngraveGenerated = {
        ...base,
        programs: plan.map(({ nc, setupIndex }) => ({ ...program, programHash: nc, setupIndex, nc })),
      };
      const calls = new Map<string, { carried: unknown; priorFields: unknown }>();
      const all: { nc: string; carried: unknown; priorFields: unknown }[] = [];
      const refused = new Set(opts.refuseFirst ?? []);
      const realLoad = useSimStore.getState().loadProgram;
      useSimStore.setState({
        loadProgram: async (...args: unknown[]) => {
          const nc = String(args[0]);
          calls.set(nc, { carried: args[12], priorFields: args[13] });
          all.push({ nc, carried: args[12], priorFields: args[13] });
          if (refused.delete(nc)) {
            // The engine's own refusal of a prior-material seed (`programSweep.ts`'s retry path).
            return {
              ok: false,
              pathOnly: false,
              diagnostics: [{ source: 'sweep', severity: 'error', code: 'prior-removal-column', message: 'this program’s engine cannot start from the material the previous program left' }],
            } as never;
          }
          useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
          return {
            ...swept(),
            removalField: fieldOf(nc),
            flatField: { marker: `${nc}-flat` },
            meshes: { removal: meshOf(nc) },
          } as never;
        },
      });
      setEngraveRunClientLoader(async () => ({
        engraveGenerate: async () => generated,
        simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
      }));
      try {
        await useEngraveRunStore.getState().generate();
      } finally {
        useSimStore.setState({ loadProgram: realLoad });
        setEngraveRunClientLoader(null);
      }
      return { calls, all };
    }

    it('seeds a flipped setup’s second program from its own predecessor, with the carried floor through the setup', async () => {
      const { calls } = await runPrograms([
        { nc: 'P1', setupIndex: 1 },
        { nc: 'P2', setupIndex: 1 },
        { nc: 'P3', setupIndex: 2 },
        { nc: 'P4', setupIndex: 2 },
      ]);
      // Program 3 — the first of the flipped setup — restarts from the blank with side 1's carried
      // floor and no same-setup fields (#1032, unchanged). Program 4 — SAME setup as its
      // predecessor — keeps the floor and seeds from program 3's own field, never the bare blank.
      expect(calls.get('P3')!.carried).not.toBeNull();
      expect(calls.get('P3')!.priorFields).toBeNull();
      expect(calls.get('P4')!.carried).not.toBeNull();
      expect(calls.get('P4')!.priorFields).toEqual([fieldOf('P3')]);
      // The INTRA-setup chain is unchanged: program 2 seeds from program 1's field, exactly the
      // pre-#1034 rule (a single-setup job's sweeps stay byte-identical).
      expect(calls.get('P2')!.priorFields).toEqual([fieldOf('P1')]);
      const s = useEngraveRunStore.getState();
      expect(s.simPrograms.map((p) => p.carriedFloor === true)).toEqual([false, false, true, true]);
      // Each seeded program names its seed: program 2 from program 1, program 4 from program 3.
      expect(s.simPrograms.map((p) => p.seedFrom ?? null)).toEqual([
        null,
        'program 1 (flat-1.0)',
        null,
        'program 3 (flat-1.0)',
      ]);
    });

    it('#1034 (C’s review) — a RETRY from the blank takes no same-setup fields and names no seed', async () => {
      // Program 2 is refused its seeded load (prior-removal-column) and re-swept from the blank.
      // The retry must not be field-seeded behind the sweep's back: fields null, seedFrom null —
      // otherwise the panel prints "Restarted from the blank" AND "starts from program 1's
      // removal" for the same program (#948's exactRun reset reads the same absence).
      const { all } = await runPrograms(
        [
          { nc: 'P1', setupIndex: 1 },
          { nc: 'P2', setupIndex: 1 },
        ],
        { refuseFirst: ['P2'] },
      );
      const p2 = all.filter((c) => c.nc === 'P2');
      expect(p2).toHaveLength(2);
      expect(p2[0]!.priorFields).toEqual([fieldOf('P1')]);
      expect(p2[1]!.priorFields).toBeNull();
      const summary = useEngraveRunStore.getState().simPrograms.find((p) => p.label.startsWith('program 2'))!;
      expect(summary.fromBlank).toBe(true);
      expect(summary.seedFrom ?? null).toBeNull();
      expect(summary.seedEarlier ?? 0).toBe(0);
    });

    it('a ball-only side 2 keeps the old behaviour: its first program carries side 1’s floor', async () => {
      const { calls } = await runPrograms([
        { nc: 'P1', setupIndex: 1 },
        { nc: 'P2', setupIndex: 1 },
        { nc: 'P3', setupIndex: 2 },
      ]);
      expect(calls.get('P3')!.carried).not.toBeNull();
      expect(calls.get('P3')!.priorFields).toBeNull();
      expect(useEngraveRunStore.getState().simPrograms.map((p) => p.carriedFloor === true)).toEqual([false, false, true]);
    });
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
      const ready = (rotary: boolean): SimLoadOk => {
        useSimStore.setState({
          status: 'ready',
          diagnostics: [],
          pathOnly: false,
          info: {
            stats: { engine: 'column', resolution: { dx: 0.1, dThetaDeg: 0.12 } },
            summary: { rotary },
          } as unknown as SimLoadOk,
        });
        return swept({
          stats: { engine: 'column', removedVolume: 0, resolution: { dx: 0.1, dThetaDeg: 0.12 } },
          summary: { rotary },
        } as unknown as Partial<SimLoadOk>);
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

  // #688 — Design's Save writes the .nc that goes to Makera Studio: a path to the machine, so it
  // waits on the clearance acknowledgement exactly as Upload and Release do. The statement's home
  // is Cut step 1 (#689), and the sentence names it because the checkbox is no longer beside Save.
  it('requires the clearance acknowledgement for Save as well as Upload', () => {
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
    expect(saveBlocker(v)).toBe('tick the statement in Cut, step 1');
    expect(uploadBlocker(v)).toBe('tick the statement in Cut, step 1');
    // The same run, acknowledged in Cut step 1, is what Save writes.
    expect(saveBlocker({ ...v, acknowledged: true })).toBeNull();
  });

  it('blocks Save on any error, on a failed oracle and on a stale result', () => {
    const okGen: EngraveGenerated = { ...clean(), findings: [], verify: { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1], max: [1, 1, 0] } } } };
    expect(saveBlocker(view({ generated: okGen, simStatus: 'ready', oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } }))).toBeNull();

    const withError: EngraveGenerated = { ...okGen, findings: [{ severity: 'error', code: 'item-empty', message: 'x' }] };
    expect(runErrorCodes(view({ generated: withError }))).toEqual(['item-empty']);
    // #724 B2 — the first error's own sentence, not `1 error outstanding`.
    expect(saveBlocker(view({ generated: withError, simStatus: 'ready' }))).toBe('x');

    // #949 — A GENERATE REFUSED BEFORE IT RAISED A FINDING IS STILL A RUN ERROR, with its own
    // sentence as the line, for any stage: the CAM's oversized-goal refusal is the case that found
    // this (it used to read "Not generated." with no words), and a post or feeds throw takes the
    // same path. The stage is the code; no Fix mapping matches it, so no dead press is drawn.
    const camRefused: EngraveGenerated = {
      ...okGen,
      ok: false,
      nc: null,
      findings: [],
      errors: [{ stage: 'cam', message: 'The goal object "column.stl" is larger than the blank: 8 mm past the right edge.' }],
    };
    expect(runErrorCodes(view({ generated: camRefused }))).toEqual(['cam']);
    expect(firstRunError(view({ generated: camRefused }))).toEqual({
      code: 'cam',
      message: 'The goal object "column.stl" is larger than the blank: 8 mm past the right edge.',
    });
    expect(saveBlocker(view({ generated: camRefused, simStatus: 'ready' }))).toBe(
      'The goal object "column.stl" is larger than the blank: 8 mm past the right edge.',
    );

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
    // #724 B2 — Save names the simulation's own sentence.
    expect(saveBlocker(v)).toBe("checkpoint 0: the cutter drives 0.967 mm³ into the fixture 'Vise fixed jaw (left)'");
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
        return swept();
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
        return swept();
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
        return swept();
      },
    });
    const generated: EngraveGenerated = {
      ...clean(),
      predicted: [
        { depth: 1, polygons: [] },
        { depth: 2, polygons: [] },
        { depth: 3, polygons: [] },
      ],
      // #744 — the program names the job's own cutter; the sweep resolves it from the job, not
      // from the registry the rest of this fake package happens to name.
      programs: [{ ...clean().programs[0]!, toolKey: 'inv:engrave-30-0-5' }],
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
          return swept();
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
        return swept();
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
        return swept();
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
    // #743 P-6 added `pcbWords`: one exported sentence builder whose only import is `import type`,
    // so it loads in a node script exactly as the other two do.
    // #845 added `machineWords`: two sentences and NO imports at all (the refusal a stated machine's
    // upload prints), pulled out of `machine.ts` — which imports zod — for exactly this reason.
    expect(runtimeImports).toEqual([
      '@/engine/cnc/engrave/pcbWords',
      '@/engine/cnc/machineWords',
      '@/engine/cnc/simGate',
      '@/engine/cnc/engrave/runInputs',
    ]);
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

  // #744 — THE APP'S HALF OF THE PER-PROGRAM SWEEP. Before this, only program 1 was loaded, so a
  // later cutter's rapid through stock (or its cutter, or its drill point) was never checked.
  describe('#744 every program is swept, and a failure names its program', () => {
    const OK = { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } };
    function prog(
      toolKey: string,
      nc: string,
      extra: Partial<EngraveGenerated['programs'][number]> = {},
    ): EngraveGenerated['programs'][number] {
      return {
        setupIndex: 1,
        setupId: 'setup-1',
        toolKey,
        nc,
        verify: null,
        frameNc: null,
        frameVerify: null,
        programHash: `hash-${nc}`,
        cam: null,
        ...extra,
      };
    }
    /** A two-cutter job: the job's own 1 mm flat, then a second setup's 3.175 mm flat. */
    function twoCutters(): EngraveGenerated {
      return { ...clean(), programs: [prog('flat-1.0', 'G90 P1'), prog('flat-3.175x12-metal', 'G90 P2')] };
    }

    it('a second program’s rapid through stock blocks Save, Upload and Release, naming that program', async () => {
      const realLoad = useSimStore.getState().loadProgram;
      const rapid = {
        source: 'sweep' as const,
        severity: 'error' as const,
        code: 'rapid-through-stock',
        message: 'a rapid passes through 2.01 mm³ of stock (line 7)',
      };
      useSimStore.setState({
        loadProgram: async (nc) => {
          if (nc === 'G90 P1') return swept();
          useSimStore.setState({ status: 'ready', diagnostics: [rapid], pathOnly: false });
          return swept({ diagnostics: [rapid] } as unknown as Partial<SimLoadOk>);
        },
      });
      setEngraveRunClientLoader(async () => ({ engraveGenerate: async () => twoCutters(), simOracle: async () => OK }));
      try {
        await useEngraveRunStore.getState().generate();
      } finally {
        useSimStore.setState({ loadProgram: realLoad });
      }
      const state = useEngraveRunStore.getState();
      expect(state.phase).toBe('blocked');
      // EVERY program's result is kept, in cut order, not just the first.
      expect(state.simPrograms.map((s) => s.label)).toEqual([
        'program 1 (flat-1.0)',
        'program 2 (flat-3.175x12-metal)',
      ]);
      const sentence = 'program 2 (flat-3.175x12-metal): a rapid passes through 2.01 mm³ of stock (line 7)';
      expect(saveBlocker(state)).toBe(sentence);
      expect(uploadBlocker(state)).toBe(sentence);
      expect(releaseBlocker(state)).toBe(sentence);
      expect(state.simDiagnostics.map((d) => d.message)).toContain(sentence);
    });

    // #744 review — a walk that stops at its FIRST program hands back one result, and the run has
    // two files: the blocker still has to say which program is the bad one.
    it('names a first program that stopped the walk, from the run’s own file count', async () => {
      const realLoad = useSimStore.getState().loadProgram;
      const rapid = {
        source: 'sweep' as const,
        severity: 'error' as const,
        code: 'rapid-through-stock',
        message: 'a rapid passes through 2.01 mm³ of stock (line 7)',
      };
      useSimStore.setState({
        loadProgram: async (nc) => {
          if (nc === 'G90 P1') {
            useSimStore.setState({ status: 'ready', diagnostics: [rapid], pathOnly: false });
            return swept({ diagnostics: [rapid] } as unknown as Partial<SimLoadOk>);
          }
          return swept();
        },
      });
      setEngraveRunClientLoader(async () => ({ engraveGenerate: async () => twoCutters(), simOracle: async () => OK }));
      try {
        await useEngraveRunStore.getState().generate();
      } finally {
        useSimStore.setState({ loadProgram: realLoad });
      }
      const state = useEngraveRunStore.getState();
      expect(state.phase).toBe('blocked');
      // The walk stopped at program 1, so its result is the only one — and it is labelled.
      expect(state.simPrograms.map((s) => s.label)).toEqual(['program 1 (flat-1.0)']);
      const sentence = 'program 1 (flat-1.0): a rapid passes through 2.01 mm³ of stock (line 7)';
      expect(saveBlocker(state)).toBe(sentence);
      expect(uploadBlocker(state)).toBe(sentence);
      expect(releaseBlocker(state)).toBe(sentence);
      expect(state.simDiagnostics.map((d) => d.message)).toContain(sentence);
    });

    it('hands each program its own cutter and drill point, and the stock the earlier one left', async () => {
      const POINT = { deg: 118, source: 'the drill plan' };
      const REMOVAL = {
        positions: new Float32Array(),
        indices: new Uint32Array(),
        vertexCount: 0,
        triangleCount: 0,
        bbox: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] },
      };
      const seen: {
        nc: string;
        cutter: Tool;
        drill: { deg: number; source: string } | null;
        seed: readonly unknown[];
      }[] = [];
      const realLoad = useSimStore.getState().loadProgram;
      useSimStore.setState({
        loadProgram: async (nc, _setup, cutter, _machine, _cal, _threads, drill, _origin, _surface, _ramp, _floor, seed) => {
          // The store hands the walk's list through; the session is what accepts one mesh or many.
          const seeds = seed === null || seed === undefined ? [] : Array.isArray(seed) ? seed : [seed];
          seen.push({ nc, cutter, drill: drill ?? null, seed: seeds });
          return swept({
            meshes: { removal: nc === 'G90 P1' ? REMOVAL : null },
          } as unknown as Partial<SimLoadOk>);
        },
      });
      const generated = twoCutters();
      generated.programs[1] = {
        ...generated.programs[1]!,
        drill: { simDrillPoint: POINT } as never,
      };
      setEngraveRunClientLoader(async () => ({ engraveGenerate: async () => generated, simOracle: async () => OK }));
      try {
        await useEngraveRunStore.getState().generate();
      } finally {
        useSimStore.setState({ loadProgram: realLoad });
      }
      expect(seen).toHaveLength(2);
      // The job's own cutter for the job's key; the registry's for a setup's later key.
      expect(seen[0]!.cutter.diameter).toBe(1.0);
      expect(seen[1]!.cutter.diameter).toBeCloseTo(3.175);
      // The second program's own plan point, not the first's and not a shop fallback.
      expect(seen[0]!.drill).toBeNull();
      expect(seen[1]!.drill).toEqual(POINT);
      // The second sweep starts on the stock the first left.
      expect(seen[0]!.seed).toEqual([]);
      expect(seen[1]!.seed).toEqual([REMOVAL]);
    });
  });
});

// #785 — Generate says what it is doing, and Cancel stops it and puts the panel back.
describe('#785 progress and Cancel', () => {
  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    setEngraveRunClientLoader(null);
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: 'flat-1.0' });
  });
  afterEach(() => setEngraveRunClientLoader(null));

  it('reports stage words while it works, and Cancel terminates the client and restores the phase', async () => {
    let release: (g: EngraveGenerated) => void = () => {};
    const held = new Promise<EngraveGenerated>((resolve) => {
      release = resolve;
    });
    let cancels = 0;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (_job, _tool, _catalogue, _cal, _margins, _shop, onProgress) => {
        onProgress?.({ stage: 'sample', label: 'sampling the goal' });
        onProgress?.({ stage: 'rough', label: 'roughing level 1 of 4', done: 1, total: 4 });
        return held;
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
      cancelGenerate: () => {
        cancels += 1;
      },
    }));

    const running = useEngraveRunStore.getState().generate();
    await new Promise((r) => setTimeout(r, 0));
    expect(useEngraveRunStore.getState().phase).toBe('generating');
    expect(useEngraveRunStore.getState().progress?.label).toBe('roughing level 1 of 4');

    useEngraveRunStore.getState().cancelGenerate();
    expect(cancels).toBe(1);
    expect(useEngraveRunStore.getState().phase).toBe('idle');
    expect(useEngraveRunStore.getState().progress).toBeNull();

    // The orphaned run's result arrives late and must not write any state.
    release(clean());
    await running;
    expect(useEngraveRunStore.getState().phase).toBe('idle');
    expect(useEngraveRunStore.getState().generated).toBeNull();
  });


  // #830 — THE RUN CANNOT SIT ON "Working…" FOREVER. A worker that dies rejects its pending calls
  // with its own words; a worker that goes quiet past the shop's `sim.stallMs` is stopped and
  // reported. Both leave the run blocked with a sentence, which is what the panel's Try again
  // hangs off.
  it('a Generate that goes quiet past the shop’s stall time is stopped and reported', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = 0;
      setEngraveRunClientLoader(async () => ({
        engraveGenerate: () => new Promise<EngraveGenerated>(() => undefined),
        cancelGenerate: () => {
          cancelled += 1;
        },
        simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
      }));
      const done = useEngraveRunStore.getState().generate();
      // The client loads on a microtask; the watchdog is armed behind it.
      await vi.advanceTimersByTimeAsync(0);
      expect(useEngraveRunStore.getState().phase).toBe('generating');
      await vi.advanceTimersByTimeAsync(shopDefault('sim.stallMs').value);
      const s = useEngraveRunStore.getState();
      expect(s.phase).toBe('blocked');
      expect(s.error).toContain('the generator reported nothing for');
      // #830 review — a silence while GENERATING is the generator's stop, not the simulation's,
      // and the sentence no longer carries its own "try again" (the press says it).
      expect(s.simStopped).toBe(false);
      expect(s.error).not.toContain('try again');
      expect(cancelled, 'the stuck worker is killed, not left running').toBe(1);
      void done;
    } finally {
      vi.useRealTimers();
    }
  });

  // #1076 — A QUEUED GENERATE IS NOT A DEAD WORKER. The sim worker is shared with the preview and
  // the measured pick: a generate pressed while they run waits its turn in silence. While that
  // work is provably in flight the panel says the wait, and the fault window only starts once the
  // generate itself has spoken.
  it('a generate queued behind the measured pick says the wait, and faults only when the worker is free and silent', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = 0;
      setEngraveRunClientLoader(async () => ({
        engraveGenerate: () => new Promise<EngraveGenerated>(() => undefined),
        cancelGenerate: () => {
          cancelled += 1;
        },
        simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
      }));
      // Start from an unheld measurement (an earlier test may leave the generate pending).
      useEngravePreviewStore.getState().releaseMeasurement();
      useEngravePreviewStore.getState().dispose();
      // The PREVIEW build is a real call in flight on the shared worker when Generate is pressed
      // (the pick is held by the press; the preview keeps updating).
      let releasePreview: () => void = () => undefined;
      const previewPending = new Promise<null>((resolve) => {
        releasePreview = () => resolve(null);
      });
      setEngravePreviewClientLoader(async () => ({
        engravePreview: () => previewPending,
        engraveSmartPick: async () => null,
      }));
      const jobNow = useEngraveJobStore.getState().job;
      useEngravePreviewStore.getState().request(jobNow);
      await vi.advanceTimersByTimeAsync(ENGRAVE_PREVIEW_DEBOUNCE_MS + 1);
      expect(useEngravePreviewStore.getState().status).toBe('loading');
      const done = useEngraveRunStore.getState().generate();
      await vi.advanceTimersByTimeAsync(0);
      expect(useEngraveRunStore.getState().phase).toBe('generating');
      await vi.advanceTimersByTimeAsync(shopDefault('sim.stallMs').value);
      const queued = useEngraveRunStore.getState();
      expect(queued.phase, 'a queued generate is not blocked').toBe('generating');
      expect(queued.progress?.label ?? '').toContain('waiting for the preview');
      expect(cancelled, 'the healthy, busy worker is not killed').toBe(0);
      // The preview finishes; the generate is still silent — now the silence is the worker's own.
      releasePreview();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(shopDefault('sim.stallMs').value);
      const s = useEngraveRunStore.getState();
      expect(s.phase).toBe('blocked');
      expect(s.error).toContain('the worker is alive');
      expect(cancelled).toBe(1);
      void done;
    } finally {
      setEngravePreviewClientLoader(null);
      useEngravePreviewStore.setState({ status: 'idle' });
      vi.useRealTimers();
    }
  });

  // #1076 — THE PRESS ITSELF CLEARS THE PICK'S STATUS. The generate holds the measured pick
  // (`holdMeasurement` writes `measuredStatus: 'idle'`) to supersede it, but the picked plan's
  // worker call keeps running to its next candidate boundary — so the store says "idle" while the
  // shared worker is still occupied, and the old watchdog read that silence as a dead generator.
  // The wait must be read from the CALL in flight, not from the status the press erased.
  it('a generate behind a pick whose status the press cleared says the wait, and faults once the pick ends', async () => {
    vi.useFakeTimers();
    try {
      useEngravePreviewStore.getState().releaseMeasurement();
      useEngravePreviewStore.getState().dispose();
      const jobNow = useEngraveJobStore.getState().job;
      useEngraveJobStore.setState({ job: { ...jobNow, tool: flatEndMill(3.175, { name: '3.175 mm flat end' }) } });
      let releasePick: () => void = () => undefined;
      const pickPending = new Promise<null>((resolve) => {
        releasePick = () => resolve(null);
      });
      setEngravePreviewClientLoader(async () => ({
        engravePreview: async () => null,
        engraveSmartPick: () => pickPending,
        cancelEngravePick: () => undefined,
      }));
      const job = useEngraveJobStore.getState().job;
      void useEngravePreviewStore.getState().measureNow(job); // the pick call starts on the worker
      await vi.advanceTimersByTimeAsync(0);
      expect(useEngravePreviewStore.getState().measuredStatus).toBe('measuring');

      let cancelled = 0;
      setEngraveRunClientLoader(async () => ({
        engraveGenerate: () => new Promise<EngraveGenerated>(() => undefined),
        cancelGenerate: () => {
          cancelled += 1;
        },
        simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
      }));
      const done = useEngraveRunStore.getState().generate();
      await vi.advanceTimersByTimeAsync(0);
      // The press supersedes the pick's state, but not its worker call.
      expect(useEngravePreviewStore.getState().measuredStatus).toBe('idle');
      await vi.advanceTimersByTimeAsync(shopDefault('sim.stallMs').value);
      const queued = useEngraveRunStore.getState();
      expect(queued.phase, 'the shared worker is busy — this is not a dead generator').toBe('generating');
      expect(queued.progress?.label ?? '').toContain('the measured pick');
      expect(cancelled, 'the healthy, busy worker is not killed').toBe(0);
      // The pick finishes: now the silence is the generator's own and the fault window applies.
      releasePick();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(shopDefault('sim.stallMs').value);
      expect(useEngraveRunStore.getState().phase).toBe('blocked');
      expect(cancelled).toBe(1);
      void done;
    } finally {
      setEngravePreviewClientLoader(null);
      // The generate is left pending: release the hold so the next test can request a preview.
      useEngravePreviewStore.getState().releaseMeasurement();
      useEngravePreviewStore.getState().dispose();
      vi.useRealTimers();
    }
  });

  it('a dead worker’s error is the run’s error, not a silent hang', async () => {
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => {
        throw new Error('the simulation worker stopped');
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    await useEngraveRunStore.getState().generate();
    const s = useEngraveRunStore.getState();
    expect(s.phase).toBe('blocked');
    expect(s.error).toBe('the simulation worker stopped');
    // The throw came from the CAM, not the sweep: this is not a stopped simulation.
    expect(s.simStopped).toBe(false);
  });

  it('a worker that dies mid-sweep is a STOP, not an error finding against the program', async () => {
    // #830 review — the sweep's load comes back null with the sim store in 'error': the worker
    // died. Nothing about the program was judged, so the run carries the worker's own sentence as
    // its stop; no `program 1 (…)` finding is invented, and the gate reads "not finished".
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        useSimStore.setState({ status: 'error', error: 'the simulation worker was killed', progress: null, phase: null });
        return null;
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => clean(),
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
    }));
    try {
      await useEngraveRunStore.getState().generate();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
    const s = useEngraveRunStore.getState();
    expect(s.phase).toBe('blocked');
    expect(s.simStopped, 'a worker that stopped judged no program').toBe(true);
    expect(s.error).toBe('the simulation worker was killed');
    expect(s.simDiagnostics, 'no finding is manufactured for a program that was never swept').toEqual([]);
    expect(s.simStatus, 'no simulation verdict was reached').toBeNull();
  });
});

describe('#893 — a run holds the measured pick, and an unsimulated program can be simulated', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function jobWithCutter(): void {
    const jobNow = useEngraveJobStore.getState().job;
    useEngraveJobStore.setState({ job: { ...jobNow, tool: flatEndMill(3.175, { name: '3.175 mm flat end' }) } });
  }

  /** A preview client that counts the pick, the preview and the pick-cancel calls. */
  function counted(): { picks: () => number; previews: () => number; cancels: () => number[] } {
    let picks = 0;
    let previews = 0;
    const cancels: number[] = [];
    setEngravePreviewClientLoader(async () => ({
      engravePreview: async () => {
        previews += 1;
        return null;
      },
      engraveSmartPick: async () => {
        picks += 1;
        return null;
      },
      cancelEngravePick: (gen: number) => {
        cancels.push(gen);
      },
    }));
    return { picks: () => picks, previews: () => previews, cancels: () => cancels };
  }

  beforeEach(() => {
    useEngravePreviewStore.getState().dispose();
    setEngravePreviewClientLoader(null);
  });
  afterEach(() => {
    useEngravePreviewStore.getState().dispose();
    setEngravePreviewClientLoader(null);
  });

  it('starts no pick while the measurement is held, and starts one when it is released', async () => {
    jobWithCutter();
    const countedClient = counted();
    const job = useEngraveJobStore.getState().job;
    useEngravePreviewStore.getState().holdMeasurement();
    useEngravePreviewStore.getState().request(job);
    await sleep(ENGRAVE_PICK_DEBOUNCE_MS + 200);
    expect(countedClient.picks(), 'no pick while the measurement is held').toBe(0);
    expect(countedClient.previews(), 'no preview either — a goal preview rebuilds its mesh').toBe(0);
    expect(countedClient.cancels().length, 'the worker-side search is stopped without a preview').toBe(1);
    useEngravePreviewStore.getState().releaseMeasurement();
    await sleep(ENGRAVE_PICK_DEBOUNCE_MS + 200);
    expect(countedClient.previews(), 'the preview resumes after the run').toBeGreaterThan(0);
    expect(countedClient.picks(), 'the pick resumes after the run').toBeGreaterThan(0);
  });

  it('a Generate holds it for the whole run, so the pick cannot touch the job it describes', async () => {
    jobWithCutter();
    const countedClient = counted();
    let releaseGen!: (g: EngraveGenerated) => void;
    const gen = new Promise<EngraveGenerated>((resolve) => {
      releaseGen = resolve;
    });
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
        return swept();
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => gen,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    try {
      const running = useEngraveRunStore.getState().generate();
      // An edit lands while the run is generating: without the hold this schedules a pick, and the
      // pick's plan write is what staleness the maintainer's elephant run.
      useEngravePreviewStore.getState().request(useEngraveJobStore.getState().job);
      await sleep(ENGRAVE_PICK_DEBOUNCE_MS + 200);
      expect(countedClient.picks(), 'no pick runs under a Generate').toBe(0);
      expect(countedClient.previews(), 'no preview runs under a Generate').toBe(0);
      expect(useEngraveRunStore.getState().phase).toBe('generating');
      releaseGen(clean());
      await running;
      // The job never changed under the run, so the result is current and the sweep ran.
      expect(useEngraveRunStore.getState().staleSince).toBeNull();
      expect(useEngraveRunStore.getState().oracle?.ok).toBe(true);
      // Released with the run: the next request measures again.
      useEngravePreviewStore.getState().request(useEngraveJobStore.getState().job);
      await sleep(ENGRAVE_PICK_DEBOUNCE_MS + 200);
      expect(countedClient.previews(), 'the preview resumes after the run').toBeGreaterThan(0);
      expect(countedClient.picks(), 'the pick resumes after the run').toBeGreaterThan(0);
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  });

  it('Cancel releases the preview hold even when the cancelled call never settles', async () => {
    jobWithCutter();
    const countedClient = counted();
    // A generate call that never settles, as a terminated worker's does: nothing rejects it.
    const never = new Promise<EngraveGenerated>(() => undefined);
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => never,
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    void useEngraveRunStore.getState().generate();
    await sleep(50);
    expect(countedClient.previews(), 'held while the run is in flight').toBe(0);
    useEngraveRunStore.getState().cancelGenerate();
    // The run's own `finally` never runs; the cancel released the hold, so a preview may start.
    useEngravePreviewStore.getState().request(useEngraveJobStore.getState().job);
    await sleep(ENGRAVE_PICK_DEBOUNCE_MS + 200);
    expect(countedClient.previews(), 'previews resume after a cancel').toBeGreaterThan(0);
  });

  it('writes the sweep and the check to the flight recorder, so a crash report can see them', async () => {
    jobWithCutter();
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
        return swept();
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => clean(),
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    try {
      await useEngraveRunStore.getState().generate();
      const stages = flightCrumbs()
        .filter((c) => c.kind === 'stage' && c.work === 'generate')
        .map((c) => c.stage);
      expect(stages).toContain('simulate');
      expect(stages).toContain('check');
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  });

  it('Simulate sweeps the program already generated, without generating again', async () => {
    jobWithCutter();
    let generates = 0;
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
        return swept();
      },
    });
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => {
        generates += 1;
        return clean();
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    try {
      await useEngraveRunStore.getState().generate();
      expect(generates).toBe(1);
      expect(useEngraveRunStore.getState().oracle?.ok).toBe(true);
      // A simulation that stopped before it finished: the row shows the program and the press.
      useEngraveRunStore.setState({
        simStatus: null,
        oracle: null,
        oraclePrograms: [],
        simDiagnostics: [],
        simPrograms: [],
        phase: 'blocked',
        error: 'the simulation stopped before it finished',
        simStopped: true,
      });
      await useEngraveRunStore.getState().simulate();
      const s = useEngraveRunStore.getState();
      expect(generates, 'Simulate does not generate again').toBe(1);
      expect(s.simStatus).toBe('ready');
      expect(s.oracle?.ok).toBe(true);
      expect(s.phase).toBe('ready');
      expect(s.staleSince).toBeNull();
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  });
});

// ── #1049 — THE TRADEOFF IS GENERATE'S OWN ─────────────────────────────────────────────────────
describe('#1049 the tradeoff Generate already measured', () => {
  const goalForIdeal = {
    id: 'g', name: 'g', format: 'stl' as const, sha256: 'x', data: '', size: { x: 1, y: 1, z: 1 },
    position: { x: 0, y: 0, z: 0 }, rotation: 0, enabled: true, role: 'goal' as const,
  };
  const resultWithProgram = (): EngraveGenerated => ({
    ...clean(),
    nc: 'G90\nM02',
    programs: [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'flat-1.0', nc: 'G90\nM02', verify: null, frame: 'flat' } as never],
  });
  const outcome = (ms: number): never => ({ coverage: 0.9, cutInto: { adjudicatedFraction: 0, maxMm: 0 }, leftoverAboveMm: 0.1, cycleSeconds: ms, leftoverCells: 1, coveredCells: 100, cellAreaMm2: 0.01 } as never);
  const tradeoff = { material: true, line: 'the ideal leaves less standing', differences: [] } as never;
  const withGoal = (): void => {
    useEngraveJobStore.setState({ job: { ...useEngraveJobStore.getState().job, targetObject: goalForIdeal, tool: flatEndMill(3.175, { name: '3.175 mm flat end' }) } });
  };
  /** Let the store's microtasks run. */
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const realLoad = (): void => {
    useSimStore.setState({ loadProgram: async () => { useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false }); return swept(); } });
  };

  it('lights the card from the result and plans nothing — engravePlanIdeal is not called', async () => {
    let idealCalls = 0;
    const withIdeal = resultWithProgram();
    withIdeal.planIdeal = { perSetup: [] } as never;
    withIdeal.planTradeoff = tradeoff;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => withIdeal,
      engravePlanIdeal: async () => {
        idealCalls += 1;
        return { tradeoff: null, owned: null, ideal: null };
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withGoal();
    const real = useSimStore.getState().loadProgram;
    realLoad();
    try {
      await useEngraveRunStore.getState().generate();
      expect(useEngraveRunStore.getState().idealPlan.status).toBe('ready');
      expect(useEngraveRunStore.getState().idealPlan.tradeoff).toEqual(tradeoff);
      expect(idealCalls, 'Generate already measured it').toBe(0);
    } finally {
      useSimStore.setState({ loadProgram: real });
    }
  }, 60_000);

  it('a result with no ideal leaves the card idle and plans nothing', async () => {
    let idealCalls = 0;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => resultWithProgram(),
      engravePlanIdeal: async () => {
        idealCalls += 1;
        return { tradeoff: null, owned: null, ideal: null };
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withGoal();
    const real = useSimStore.getState().loadProgram;
    realLoad();
    try {
      await useEngraveRunStore.getState().generate();
      expect(useEngraveRunStore.getState().idealPlan).toEqual({ status: 'idle', tradeoff: null });
      expect(idealCalls).toBe(0);
    } finally {
      useSimStore.setState({ loadProgram: real });
    }
  }, 60_000);

  // ── #1151 — OWNED PLAN FIRST, THE COMPARISON LATER ────────────────────────────────────────────
  it('#1151 — a deferred result starts the comparison on its OWN worker, not the shared one', async () => {
    let ownCalls = 0;
    let sharedCalls = 0;
    let heldArg: unknown = 'unset';
    const ownedOutcome = outcome(450);
    const deferred = { ...resultWithProgram(), idealDeferred: true };
    deferred.plan = { perSetup: [], outcome: ownedOutcome } as never;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => deferred,
      engravePlanIdeal: async () => {
        sharedCalls += 1;
        return { tradeoff: null, owned: null, ideal: null };
      },
      engravePlanIdealOnItsOwnWorker: async (...args: unknown[]) => {
        ownCalls += 1;
        heldArg = args[5];
        return { tradeoff, owned: ownedOutcome, ideal: ownedOutcome };
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withGoal();
    const real = useSimStore.getState().loadProgram;
    realLoad();
    try {
      await useEngraveRunStore.getState().generate();
      await settle();
      expect(ownCalls, 'the compare runs on its own worker').toBe(1);
      expect(sharedCalls, 'the shared sim worker is left to the sweep').toBe(0);
      expect(heldArg, 'the owned outcome rides so the ideal plans its half alone').toEqual(ownedOutcome);
      expect(useEngraveRunStore.getState().idealPlan).toEqual({ status: 'ready', tradeoff });
    } finally {
      useSimStore.setState({ loadProgram: real });
    }
  }, 60_000);

  it('#1151 — a deferred comparison that fails leaves the card idle and blocks nothing', async () => {
    const deferred = { ...resultWithProgram(), idealDeferred: true };
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => deferred,
      engravePlanIdealOnItsOwnWorker: async () => {
        throw new Error('the comparison worker stopped');
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withGoal();
    const real = useSimStore.getState().loadProgram;
    realLoad();
    try {
      await useEngraveRunStore.getState().generate();
      await settle();
      expect(useEngraveRunStore.getState().idealPlan).toEqual({ status: 'idle', tradeoff: null });
      expect(useEngraveRunStore.getState().phase).toBe('ready');
    } finally {
      useSimStore.setState({ loadProgram: real });
    }
  }, 60_000);

  it('a stale run’s ideal never writes over the current run', async () => {
    const releases: ((v: { tradeoff: unknown; owned: null; ideal: null }) => void)[] = [];
    const withIdeal = resultWithProgram();
    withIdeal.planIdeal = { perSetup: [] } as never;
    withIdeal.planTradeoff = tradeoff;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => withIdeal,
      engravePlanIdeal: () =>
        new Promise((resolve) => {
          releases.push(resolve as never);
        }),
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withGoal();
    const real = useSimStore.getState().loadProgram;
    realLoad();
    try {
      // #1048/#1049 — the press is the only caller now; a run's result sets the card, and a
      // press's late answer must not overwrite a later run's line.
      await useEngraveRunStore.getState().generate();
      useEngraveRunStore.getState().comparePlans();
      await Promise.resolve();
      expect(releases.length).toBe(1);
      // Run B lands its own result while A's press is still out.
      await useEngraveRunStore.getState().generate();
      expect(useEngraveRunStore.getState().idealPlan.tradeoff).toEqual(tradeoff);
      releases[0]!({ tradeoff: { material: true, line: 'stale line', differences: [] }, owned: null, ideal: null });
      await settle();
      expect(useEngraveRunStore.getState().idealPlan.tradeoff, 'A’s late answer is dropped').toEqual(tradeoff);
      expect(useEngraveRunStore.getState().idealPlan.status).toBe('ready');
    } finally {
      useSimStore.setState({ loadProgram: real });
    }
  }, 60_000);

  it('a stale run’s ideal never writes over the current run after an inventory change', async () => {
    // #1049 (the Manager's case) — AN INVENTORY CHANGE IS SHOP STATE, NOT JOB STATE: it must mark
    // the run stale, and then the press passes NO held outcome so the worker plans both halves
    // instead of comparing against a plan made with a different set of owned cutters.
    let idealCalls = 0;
    let heldArg: unknown = 'unset';
    const withIdeal = resultWithProgram();
    const ownedOutcome = outcome(450);
    withIdeal.plan = { perSetup: [], outcome: ownedOutcome } as never;
    withIdeal.planIdeal = { perSetup: [] } as never;
    withIdeal.planTradeoff = tradeoff;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => withIdeal,
      engravePlanIdeal: async (...args: unknown[]) => {
        idealCalls += 1;
        heldArg = args[5];
        return { tradeoff: null, owned: null, ideal: null };
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withGoal();
    const real = useSimStore.getState().loadProgram;
    realLoad();
    try {
      await useEngraveRunStore.getState().generate();
      useEngraveRunStore.getState().comparePlans();
      await settle();
      expect(idealCalls).toBe(1);
      expect(heldArg, 'the current run’s owned outcome is reused').toEqual(ownedOutcome);

      // The possession is registered in the house: the registry store moves, and the run must go
      // stale (the watcher compares `cuttersKey`, which hashes the inventory’s `inv:` entries).
      setInventoryEntries([{ key: 'inv:1049', tool: flatEndMill(2, { name: '2 mm flat' }), provenance: 'test' }]);
      useToolRegistryStore.setState({ items: [{ id: '1049' } as never] });
      expect(useEngraveRunStore.getState().staleSince, 'an inventory change marks the run stale').not.toBeNull();
      expect(useEngraveRunStore.getState().staleReason).toBe('cutters');

      useEngraveRunStore.getState().comparePlans();
      await settle();
      expect(idealCalls).toBe(2);
      expect(heldArg, 'a stale run passes no held outcome').toBeNull();
    } finally {
      setInventoryEntries([]);
      useToolRegistryStore.setState({ items: [] });
      useSimStore.setState({ loadProgram: real });
    }
  }, 60_000);
});

// #986 (E's nits) — the press re-runs; a refused ideal leaves no spinner.
describe('#986 the press and the failure path', () => {
  const generatedWithProgram = (): EngraveGenerated => ({
    ...clean(),
    nc: 'G90\nM02',
    programs: [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'flat-1.0', nc: 'G90\nM02', verify: null, frame: 'flat' } as never],
  });
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const goal = {
    id: 'g', name: 'g', format: 'stl' as const, sha256: 'x', data: '', size: { x: 1, y: 1, z: 1 },
    position: { x: 0, y: 0, z: 0 }, rotation: 0, enabled: true, role: 'goal' as const,
  };
  const withJob = (): void => {
    useEngraveJobStore.setState({ job: { ...useEngraveJobStore.getState().job, targetObject: goal, tool: flatEndMill(3.175, { name: '3.175 mm flat end' }) } });
  };

  it('the press re-runs the computation and lands ready again', async () => {
    let calls = 0;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => generatedWithProgram(),
      engravePlanIdeal: async () => {
        calls += 1;
        return { tradeoff: { material: false, line: null, differences: [] } as never, owned: null, ideal: null };
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withJob();
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({ loadProgram: async () => { useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false }); return swept(); } });
    try {
      await useEngraveRunStore.getState().generate();
      await settle();
      // #1049 — Generate plans both outcomes itself; a result with no ideal on it lights nothing
      // and calls nothing. The press is the only caller.
      expect(useEngraveRunStore.getState().idealPlan).toEqual({ status: 'idle', tradeoff: null });
      expect(calls).toBe(0);
      // The press re-runs the SAME computation — not just the recorded choice.
      useEngraveRunStore.getState().comparePlans();
      await settle();
      expect(calls).toBe(1);
      expect(useEngraveRunStore.getState().idealPlan.status).toBe('ready');
      useEngraveRunStore.getState().comparePlans();
      await settle();
      expect(calls).toBe(2);
      expect(useEngraveRunStore.getState().idealPlan.status).toBe('ready');
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  }, 60_000);

  // #1048 (restored in the #1049 rewrite; A's review) — STOP MUST FREE A QUEUED LOAD. The walk's
  // load waits for the worker when another computation holds it; Cancel is the operator's way out
  // and cannot be left waiting with it.
  it('#1048 — Stop works while the load waits for the worker', async () => {
    let cancels = 0;
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => generatedWithProgram(),
      engravePlanIdeal: async () => ({ tradeoff: { material: false, line: null, differences: [] }, owned: null, ideal: null }),
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
      cancelGenerate: () => {
        cancels += 1;
      },
    }));
    withJob();
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({ loadProgram: () => new Promise(() => undefined) as never });
    try {
      void useEngraveRunStore.getState().generate();
      await new Promise((r) => setTimeout(r, 0));
      expect(useEngraveRunStore.getState().phase, 'the walk is on the wait').toBe('simulating');
      // The press the panel's Cancel calls: it must free the app from a queued load too.
      useEngraveRunStore.getState().cancelGenerate();
      expect(cancels).toBe(1);
      expect(useEngraveRunStore.getState().phase).not.toBe('simulating');
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  }, 60_000);

  it('a refused ideal goes idle — no spinner is left behind', async () => {
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async () => generatedWithProgram(),
      engravePlanIdeal: async () => {
        throw new Error('the ideal refused');
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    withJob();
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({ loadProgram: async () => { useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false }); return swept(); } });
    try {
      await useEngraveRunStore.getState().generate();
      // #1049 — the press is what asks the worker; a refusing worker leaves no spinner.
      useEngraveRunStore.getState().comparePlans();
      await settle();
      expect(useEngraveRunStore.getState().idealPlan).toEqual({ status: 'idle', tradeoff: null });
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  }, 60_000);
});

// ── #1046 — THE LADDER'S PRESS PATH ────────────────────────────────────────────────────────────
describe('#1046 the ladder ask reaches the pipeline', () => {
  const cleanGen = (): EngraveGenerated => ({
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    cam: null,
    verify: null,
    surface3d: null,
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
    nc: ';@MKR|BEGIN\nG21 G90\nM02',
  } as unknown as EngraveGenerated);

  it('generate(null, { restLadder: true }) passes the flag as the pipeline’s restLadder argument', async () => {
    let seen: unknown = 'unset';
    setEngraveRunClientLoader(async () => ({
      engraveGenerate: async (...args: unknown[]) => {
        seen = args[8];
        return cleanGen();
      },
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }));
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({ loadProgram: async () => { useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false }); return swept(); } });
    try {
      await useEngraveRunStore.getState().generate(null, { restLadder: true });
      expect(seen, 'the press asks the owned plan to measure the rungs').toBe(true);
      // A plain Generate stays the pre-#1046 call: the flag is off, never left as the last press's.
      await useEngraveRunStore.getState().generate();
      expect(seen).toBe(false);
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  }, 60_000);
});
