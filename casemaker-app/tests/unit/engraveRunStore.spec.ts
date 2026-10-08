// The engrave RUN state (#206): the save gate and the staleness rule. No wasm, no worker — the
// client is faked, so this is the pure half of the store.

import { describe, it, expect, beforeEach } from 'vitest';

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
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';

const NOTHING: EngraveGenerated = {
  ok: false,
  stage: 'findings',
  findings: [],
  feeds: null,
  cam: null,
  nc: null,
  verify: null,
  frameNc: null,
  frameVerify: null,
  predicted: [],
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
    cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 5, passes: 2 },
    nc: 'G90\nM02',
    verify: null,
    frameNc: null,
    frameVerify: null,
    predicted: [],
    errors: [],
  };
}

describe('engraveRunStore (#206)', () => {
  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    setEngraveRunClientLoader(null);
    useEngraveJobStore.getState().replace(defaultEngraveJob());
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
    expect(saveBlocker(view({ generated: okGen, staleSince: Date.now(), simStatus: 'ready' }))).toBe('the job changed since it was generated');
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
    expect(saveBlocker(useEngraveRunStore.getState())).toBe('the job changed since it was generated');
  });
});
