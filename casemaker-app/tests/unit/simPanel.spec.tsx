// @vitest-environment jsdom
// The Simulate panel (#196 §5): the Simulate gate, the true runner count, the refusal banner and
// the disclaimer. A fake client stands in for the worker (`setSimClientLoader`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SimPanel } from '@/components/panels/SimPanel';
import { setSimClientLoader, useSimStore, type SimClient } from '@/store/simStore';
import { DEFAULT_STOCK, buildSimSetup, useSimSetupStore } from '@/store/simSetupStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import { resetRegistry, setInventoryEntries, setRegistry } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { RESTART_TOOL_LENGTH_NOTE } from '@/engine/cnc/restart';
import { parseGcode } from '@/engine/cnc/gcode';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { Z1 } from '@/engine/cnc/machine';
import type { SimDiagnostic, SimLoadResult } from '@/workers/sim/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHOSEN_TOOL = 'flat-3.175x12-metal';

/** A worker client that returns one canned load result and ignores the sinks. */
function fakeClient(result: SimLoadResult): SimClient {
  return {
    setSimSinks: () => {},
    loadSim: async () => result,
    requestFrame: () => {},
    // #197 — the store fetches the whole path after a successful or path-only load.
    simPath: async () => ({ xyz: new Float32Array(0), step: new Uint32Array(0), kind: new Uint8Array(0), t: new Float32Array(0) }),
    disposeSim: async () => {},
  } as unknown as SimClient;
}

/** 25 listed records for a code whose true count the runner summary says is 30. */
const CAPPED: SimDiagnostic[] = Array.from({ length: 25 }, () => ({
  source: 'runner',
  severity: 'error',
  code: 'outside-envelope',
  message: 'a move leaves the envelope',
}));

const READY = {
  ok: true,
  diagnostics: CAPPED,
  summary: { diagnosticCounts: { 'outside-envelope': 30 } },
  stats: { engine: 'exact', removedVolume: 1284.6, ms: { total: 840 } },
  count: 10,
  meshes: { stock: {}, result: {}, removal: null, gouges: [] },
} as unknown as SimLoadResult;

/** A column-engine load (#222/#239) that also carried a clamped rotary cut. */
const READY_COLUMN = {
  ok: true,
  diagnostics: [],
  summary: { diagnosticCounts: {} },
  stats: { engine: 'column', removedVolume: 20, ms: { total: 30 }, resolution: { dx: 0.1, dThetaDeg: 0.25 } },
  count: 5,
  axisClamped: { count: 4, deepestZ: -0.7 },
  meshes: { stock: {}, result: {}, removal: null, gouges: [] },
} as unknown as SimLoadResult;

/**
 * #535 — a FLAT column run: the grid's Y pitch is the shop's flat pitch in mm, and the panel states
 * it. A rotary grid's second axis is θ, so the same field is not printed as millimetres there.
 */
const READY_FLAT_COLUMN = {
  ok: true,
  diagnostics: [],
  summary: { diagnosticCounts: {}, rotary: false },
  stats: { engine: 'column', removedVolume: 12, ms: { total: 20 }, resolution: { dx: 0.1, dThetaDeg: 0.1 } },
  count: 4,
  meshes: { stock: {}, result: {}, removal: null, gouges: [] },
} as unknown as SimLoadResult;

const REFUSED = {
  ok: false,
  pathOnly: false,
  diagnostics: [
    { source: 'sweep', severity: 'error', code: 'too-many-checkpoints', message: '482 Z levels — a 3D job V1 does not simulate.' },
  ],
} as unknown as SimLoadResult;

/** A swept load that carries a fixture obstacle and a diagnostic that names a line (#243, #245). */
const READY_COVERED = {
  ok: true,
  diagnostics: [
    { source: 'sweep', severity: 'error', code: 'rapid-into-fixture', message: 'line 3: a rapid drives the tool into the fixture', line: 3, checkpoint: 2 },
  ],
  summary: { diagnosticCounts: {} },
  stats: { removedVolume: 12.5, ms: { total: 100 } },
  count: 4,
  meshes: { stock: {}, result: {}, removal: null, gouges: [], fixture: [{ id: 'jaw1', label: 'vise-jaw-front', mesh: {} }] },
  fixtureSource: 'default',
  fixtureUncertainty: 0.5,
} as unknown as SimLoadResult;

/** #314 — the same loaded fixture, for a run whose sweep could not prove the nut: an obstacle
 *  rose above the stock top while the machine still states no collet-nut dimensions. */
const READY_NUT_UNPROVEN = {
  ...READY_COVERED,
  diagnostics: [
    ...READY_COVERED.diagnostics,
    {
      source: 'sweep',
      severity: 'warning',
      code: 'holder-vs-fixture-unproven',
      message: 'an obstacle rises 3.000 mm above the stock top and the collet nut’s size is not known',
    },
  ],
} as unknown as SimLoadResult;

/** #691 — the sweep could not prove the chosen cutter's shank, so the panel's own caveat names it. */
const READY_SHANK_UNPROVEN = {
  ...READY,
  diagnostics: [
    { source: 'sweep', severity: 'warning', code: 'holder-unproven', message: 'the shank length is unstated' },
  ],
} as unknown as SimLoadResult;

// --- #249 restart ---------------------------------------------------------------------------
/** A two-stroke job in our own dialect, for the restart generator. */
const RESTART_PROGRAM = [
  'G90 G21',
  'T1 M6',
  'M331',
  'S12000 M3',
  'G0 X2 Y2 Z5',
  'G0 Z1',
  'G1 Z-1 F200',
  'G1 X10 Y2',
  'G1 X10 Y6',
  'G1 X2 Y6',
  'G0 Z15',
  'M332',
  'M5',
  'G28',
  'M02',
].join('\n');
/** The panel builds its setup from the default stock and a chosen starting tool (T1 here). */
const RESTART_TL = buildTimeline(parseGcode(RESTART_PROGRAM), buildSimSetup(DEFAULT_STOCK, 1), Z1);
const RESTART_STEP = (() => {
  for (let i = 0; i < RESTART_TL.events.length; i++) {
    const e = RESTART_TL.events[i];
    if (e === undefined || e.kind !== 'move' || e.synthetic !== undefined) continue;
    const w = RESTART_TL.stateAt(i).work;
    if (w[0] === 10 && w[1] === 2 && w[2] === -1) return i;
  }
  throw new Error('the resume move was not found in the fixture program');
})();

const READY_RESTART = {
  ok: true,
  diagnostics: [],
  summary: { steps: RESTART_TL.events.length, diagnosticCounts: {} },
  pauses: [],
  checkpoints: [],
  stats: { removedVolume: 10, ms: { total: 50 } },
  count: 2,
  meshes: { stock: {}, result: {}, removal: null, gouges: [] },
} as unknown as SimLoadResult;

/** The runner produced a path and the sweep refused: a path-only session (#194). */
const REFUSED_PATH_ONLY = {
  ok: false,
  pathOnly: true,
  diagnostics: [{ source: 'sweep', severity: 'error', code: 'sweep-budget-exceeded', message: 'too slow', line: 7 }],
  summary: { steps: 3, diagnosticCounts: {} },
  pauses: [],
  segments: [],
} as unknown as SimLoadResult;

/**
 * #691 — what the engrave run's own store keeps about the job's simulation, which is what the moved
 * facts must read. `generated` stays null: the facts under test do not depend on the program object.
 */
const JOB_RUN = {
  simStatus: 'ready' as const,
  pathOnly: false,
  simEngine: 'exact' as const,
  simDiagnostics: [] as SimDiagnostic[],
  phase: 'ready' as const,
};

function openPlainFile(): void {
  // No header: stock defaults, and the tool starts unset.
  useSimSetupStore.getState().openFile('plain.nc', 'G0 X0 Y0\nG1 Z-1 F100\n');
}

beforeEach(() => {
  useSimSetupStore.getState().reset();
  // The registry and the pick memory are module state: a pick made in one test would otherwise leak
  // into the next, which is the same leak the sim-setup spec guards against (#316).
  resetRegistry();
  useSettingsStore.setState({ toolPicks: {} });
  // #691 — the job and its run are stores too; a run left by one test would be presented as the
  // next test's job facts.
  useEngraveRunStore.getState().reset();
  useEngraveJobStore.getState().replace(defaultEngraveJob());
  setSimClientLoader(async () => fakeClient(REFUSED));
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await useSimStore.getState().dispose();
  });
  setSimClientLoader(null);
});

describe('SimPanel', () => {
  it('disables Simulate until a tool is selected', async () => {
    openPlainFile();
    render(<SimPanel />);
    const button = screen.getByTestId('sim-simulate') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    expect((screen.getByTestId('sim-simulate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('draws the chosen cutter’s silhouette (#489)', () => {
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);
    const thumb = screen.getByTestId('sim-tool-profile');
    expect(thumb.querySelector('svg')).not.toBeNull();
    expect(thumb.querySelectorAll('[data-dimension]')).toHaveLength(0);
    expect(thumb.querySelector('[data-shape]')).not.toBeNull();
  });

  it('says a shape-only match is a suggestion, and an exact one is not (#316)', async () => {
    // The panel is the half of #316 the user reads. Makera sells six 3.175 mm flats that differ
    // only in length, so "matched from the file's TOOL record" over a 12 mm entry when the file
    // states 42 mm would be a claim the evidence does not support.
    const TOOL_LINE = (flute: number) =>
      `;@MKR|TOOL|number=1|id=112111313812|name=3.175*${flute}mm Flat End(Metal)|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=${flute}|flutelength=${flute}|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0`;

    act(() => useSimSetupStore.getState().openFile('long.nc', `${TOOL_LINE(42)}\n`));
    render(<SimPanel />);
    const weak = screen.getByTestId('sim-tool-match');
    expect(weak.getAttribute('data-strength')).toBe('suggested');
    expect(weak.getAttribute('data-provenance')).toBe('shape');
    expect(weak.textContent).toContain('check it');

    cleanup();
    act(() => useSimSetupStore.getState().reset());
    act(() => useSimSetupStore.getState().openFile('exact.nc', `${TOOL_LINE(12)}\n`));
    render(<SimPanel />);
    const firm = screen.getByTestId('sim-tool-match');
    expect(firm.getAttribute('data-strength')).toBe('exact');
    expect(firm.getAttribute('data-provenance')).toBe('id');
    expect(firm.textContent).toContain('matched from the file’s TOOL record');
  });

  it('asks which of two equally-matching rows the file was cut with, and applies the pick (#316)', async () => {
    // The owned cutter and the catalogue row it was registered from carry the same `g_ID` and the
    // same lengths, so the file names neither. The panel asks — with no row preselected, because a
    // seeded choice would be a silent one — and applies the answer the person gives.
    const CAT: ToolLibraryEntry = {
      key: 'cat:112111313812',
      provenance: 'the house catalogue',
      tool: flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)', fluteLength: 12, shoulderLength: 12 }),
    };
    const INV: ToolLibraryEntry = {
      key: 'inv:box-1',
      provenance: 'registered from the catalogue',
      tool: flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)', fluteLength: 12, shoulderLength: 12 }),
    };
    setRegistry([CAT]);
    setInventoryEntries([INV]);
    const TOOL_LINE =
      ';@MKR|TOOL|number=1|id=112111313812|name=3.175*12mm Flat End(Metal)|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0';

    act(() => useSimSetupStore.getState().openFile('ambiguous.nc', `${TOOL_LINE}\n`));
    render(<SimPanel />);

    // Nothing is applied, so the select is empty and Simulate is refused until the question is
    // answered — but this is a QUESTION, not a missing tool, so the "required" line stays away.
    expect((screen.getByTestId('sim-tool') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('sim-simulate') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('sim-tool-required')).toBeNull();

    const chooser = screen.getByTestId('sim-tool-ambiguous');
    expect(chooser.textContent).toContain('more than one of your cutters');
    expect(chooser.textContent).toContain('pick the one it was cut with');
    const owned = screen.getByTestId('sim-tool-candidate-0');
    const catalogue = screen.getByTestId('sim-tool-candidate-1');
    // Drawn in tier order (owned first), which is the order the Manage picker groups them in.
    expect(owned.getAttribute('data-key')).toBe('inv:box-1');
    expect(owned.getAttribute('data-tier')).toBe('owned');
    expect(catalogue.getAttribute('data-key')).toBe('cat:112111313812');
    expect(catalogue.getAttribute('data-tier')).toBe('catalogue');

    fireEvent.click(catalogue);
    expect(useSimSetupStore.getState().toolKey).toBe('cat:112111313812');
    expect((screen.getByTestId('sim-tool') as HTMLSelectElement).value).toBe('cat:112111313812');
    // The answer is the person's, not the file's, and the line keeps saying so (#316).
    const line = screen.getByTestId('sim-tool-match');
    expect(line.getAttribute('data-picked')).toBe('cat:112111313812');
    expect(line.getAttribute('data-strength')).toBe('suggested');
    expect(line.textContent).toContain('the one you picked');
    expect(line.textContent).toContain('the file does not confirm');
    expect(screen.queryByTestId('sim-tool-ambiguous')).toBeNull();
  });

  it('names the cutter the file asks for when this house does not have it (#332)', async () => {
    // A `;@CM|TOOL|key=` line is the file saying which cutter it was written for. When the registry
    // does not hold that key, the closest entry is offered — but the sentence has to say which
    // cutter is missing, or the substitution is silent.
    const HEADER = [
      ';@MKR|TOOL|number=1|id=0|name=six-flat copy|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0',
      ';@CM|TOOL|key=user:six-flat-copy',
    ].join('\n');

    act(() => useSimSetupStore.getState().openFile('foreign.nc', `${HEADER}\n`));
    render(<SimPanel />);
    const weak = screen.getByTestId('sim-tool-match');
    expect(weak.getAttribute('data-strength')).toBe('suggested');
    expect(weak.textContent).toContain('user:six-flat-copy');
    expect(weak.textContent).toContain('does not have');

    // The phrase names the evidence the rule actually used (#332 review). This file states only
    // geometry, so the fallback was the shape step — and the sentence must not offer a vendor id
    // the file never wrote.
    expect(weak.getAttribute('data-provenance')).toBe('shape');
    expect(weak.textContent).toContain('shape and diameter');
    expect(weak.textContent).not.toContain('vendor id');

    // The same file WITH the vendor id the fallback matched on: now the id is the evidence, and
    // "closest by shape and diameter" would be describing a rule that did not answer.
    cleanup();
    act(() => useSimSetupStore.getState().reset());
    act(() => useSimSetupStore.getState().openFile('foreign-id.nc', `${HEADER.replace('|id=0', '|id=112111313812')}\n`));
    render(<SimPanel />);
    const byId = screen.getByTestId('sim-tool-match');
    expect(byId.getAttribute('data-provenance')).toBe('id');
    expect(byId.textContent).toContain('user:six-flat-copy');
    expect(byId.textContent).toContain('vendor id');
    expect(byId.textContent).not.toContain('shape and diameter');

    // And when the key DOES resolve, and the file's own geometry agrees with the entry, the key is
    // what answered — the strongest reason there is.
    cleanup();
    act(() => useSimSetupStore.getState().reset());
    act(() => useSimSetupStore.getState().openFile('ours.nc', `${HEADER.replace('user:six-flat-copy', 'flat-3.175x12-metal')}\n`));
    render(<SimPanel />);
    const firm = screen.getByTestId('sim-tool-match');
    expect(firm.getAttribute('data-strength')).toBe('exact');
    expect(firm.getAttribute('data-provenance')).toBe('key');
    expect(firm.textContent).toContain('matched from the cutter the file names');

    // A held key whose entry no longer measures what the file cut (#316 review): the cutter was
    // edited since the file was posted. The key is still what the file says, so it is still the
    // answer — but "matched from the cutter the file names" would hide that the sweep is wrong.
    cleanup();
    act(() => useSimSetupStore.getState().reset());
    act(() => useSimSetupStore.getState().openFile('edited.nc', `${HEADER.replace('user:six-flat-copy', 'flat-1.0')}\n`));
    render(<SimPanel />);
    const edited = screen.getByTestId('sim-tool-match');
    expect(edited.getAttribute('data-provenance')).toBe('key');
    expect(edited.getAttribute('data-strength')).toBe('suggested');
    expect(edited.textContent).toContain('flat-1.0');
    expect(edited.textContent).toContain('cutting diameter');
  });

  it('names the cutter the file asks for even when nothing matched (#332 review)', async () => {
    // A file that states a key this house does not hold AND no TOOL record to match on leaves the
    // select empty. A bare "required" would hide which cutter is missing, which is the one fact the
    // file did give us — so the sentence carries it.
    act(() => useSimSetupStore.getState().openFile('norecord.nc', ';@CM|TOOL|key=user:missing-tool\n'));
    render(<SimPanel />);
    const required = screen.getByTestId('sim-tool-required');
    expect(required.textContent).toContain('user:missing-tool');
    expect(required.textContent).toContain('does not have');
    expect(required.textContent).toContain('choose the tool');

    // And with no key line at all there is nothing to name: the plain sentence stands.
    cleanup();
    act(() => useSimSetupStore.getState().reset());
    act(() => useSimSetupStore.getState().openFile('plain.nc', 'G0 X0 Y0\n'));
    render(<SimPanel />);
    expect(screen.getByTestId('sim-tool-required').textContent).toBe(
      'required — choose the tool this program was written for.',
    );
  });

  it('shows the runner summary count, not the capped list length', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    const row = await screen.findByTestId('sim-diag-runner-outside-envelope');
    expect(row.textContent).toContain('30');
    expect(row.textContent).not.toContain('25');
  });

  it('renders a refusal banner and no result block', async () => {
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-refusal');
    expect(screen.getByText(/482 Z levels/)).toBeTruthy();
    expect(screen.queryByTestId('sim-result')).toBeNull();
  });

  // #506 — the engrave run's verify stage loads its generated program into this same `simStore`
  // (`engraveRunStore`) without opening a file in `simSetupStore`. Opening Simulate .nc afterwards
  // used to show the panel's empty file row directly above that finished Result/Diagnostics.
  it('does not present a session the panel did not start (#506)', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    await act(async () => {
      await useSimStore
        .getState()
        .loadProgram('G0 X1 Y1\n', buildSimSetup(DEFAULT_STOCK, 'unknown'), flatEndMill(3.175), Z1.id, undefined, [], null, 'engrave');
    });
    render(<SimPanel />);

    // The empty state, and nothing from the engrave run underneath it.
    expect(screen.getByTestId('sim-file-name').textContent).toBe('No file open');
    expect(screen.getByTestId('sim-drop-hint')).toBeTruthy();
    expect(screen.queryByTestId('sim-result')).toBeNull();
    expect(screen.queryByTestId('sim-diagnostics')).toBeNull();
    expect(screen.queryByTestId('sim-close')).toBeNull();
    // The load itself succeeded: this is about whose run the panel may present, not the sweep.
    expect(useSimStore.getState().status).toBe('ready');
  });

  // #506 — a Result belongs to the program it swept. Opening another `.nc` after a run must not
  // leave the old numbers under the new file's row (the issue's "current file or a previous file").
  it('drops a previous file’s result when another file is opened (#506)', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');

    act(() => useSimSetupStore.getState().openFile('other.nc', 'G0 X2 Y2\n'));
    expect(screen.getByTestId('sim-file-name').textContent).toBe('other.nc');
    expect(screen.queryByTestId('sim-result')).toBeNull();
    expect(screen.queryByTestId('sim-diagnostics')).toBeNull();
  });

  it('shows the disclaimer after a successful load', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    expect(screen.getByTestId('sim-disclaimer').textContent).toContain('rigid, ideal machine');
  });

  it('#804 — the results stay on the surface and the caveats sit behind “What was checked”', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');

    const fold = screen.getByTestId('sim-what-checked') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    // ONE line: what the sweep was checked against, and how many facts it did not check.
    const summary = screen.getByTestId('sim-what-checked-summary').textContent ?? '';
    expect(summary).toContain('What was checked');
    expect(summary).toContain('Checked against the stock');
    // The physics sentence and the coverage sentences are behind the fold.
    fireEvent.click(screen.getByTestId('sim-what-checked-summary'));
    expect(fold.open).toBe(true);
    expect(screen.getByTestId('sim-disclaimer').textContent).toContain('rigid, ideal machine');
  });

  it('names the backend that ran, and defaults to the exact sweeper (#222)', async () => {
    setSimClientLoader(async () => fakeClient(READY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    // READY reports the exact sweeper's own `stats.engine`, which is the field the badge reads.
    expect(screen.getByTestId('sim-backend').textContent).toContain('exact');
    // #535 — the exact sweep has no grid, so no resolution tag is drawn for it.
    expect(screen.queryByTestId('sim-grid')).toBeNull();
    expect(screen.queryByTestId('sim-axis-clamped')).toBeNull();
  });

  it('#535 — a flat column run states the grid it was simulated on', async () => {
    setSimClientLoader(async () => fakeClient(READY_FLAT_COLUMN));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    expect(screen.getByTestId('sim-backend').textContent).toContain('column');
    expect(screen.getByTestId('sim-grid').textContent).toContain('simulated on a 0.1 mm grid');
  });

  it('surfaces the clamped rotary count with the result, not only in diagnostics (#239)', async () => {
    setSimClientLoader(async () => fakeClient(READY_COLUMN));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    expect(screen.getByTestId('sim-backend').textContent).toContain('column');
    const clamped = screen.getByTestId('sim-axis-clamped').textContent ?? '';
    expect(clamped).toContain('4');
    expect(clamped).toContain('clamped');
  });

  it('names the geometry this run did not check (#243)', async () => {
    setSimClientLoader(async () => fakeClient(READY_COVERED));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    const text = screen.getByTestId('sim-disclaimer').textContent ?? '';
    expect(text).toContain('the modelled fixture (vise-jaw-front)');
    expect(text).toContain('The modelled fixture is a shipped default');
    expect(text).toContain('the spindle body, head and gantry');
    // #314 — this run's codes carry no holder question, so the unmeasured collet nut is NOT
    // named: the sweep raises `holder-vs-fixture-unproven` only where an obstacle rises above
    // the stock top, and a blind spot the run never had would be a false one.
    expect(text).not.toContain('the collet nut');
  });

  // #314 — the other direction, through the panel: when the run DOES raise the code, the
  // sentence names the nut, because the check was needed and could not be made.
  it('names the collet nut when the run raised the unproven-holder code (#314)', async () => {
    setSimClientLoader(async () => fakeClient(READY_NUT_UNPROVEN));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    expect(screen.getByTestId('sim-disclaimer').textContent ?? '').toContain('the collet nut');
  });

  // #691 — the caveat that names the cutter must use its one display name, never the vendor label
  // (`tool.name`), which is data for the hover.
  it('names the chosen cutter by its display name in the panel’s own shank caveat (#691)', async () => {
    setSimClientLoader(async () => fakeClient(READY_SHANK_UNPROVEN));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    const text = screen.getByTestId('sim-disclaimer').textContent ?? '';
    expect(text).toContain('the shank of “⌀ 3.175 mm flat end · 12 mm flute” above the cutter');
    expect(text).not.toContain('3.175*12mm');
  });

  it('says a path-only run checked nothing but the path', async () => {
    setSimClientLoader(async () => fakeClient(REFUSED_PATH_ONLY));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-refusal');
    expect(screen.getByTestId('sim-disclaimer').textContent).toContain('path-only');
  });

  it('jumps to a diagnostic’s line in the G-code pane when its line is clicked (#245)', async () => {
    setSimClientLoader(async () => fakeClient(READY_COVERED));
    openPlainFile();
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');
    expect(screen.queryByTestId('sim-gcode-jump')).toBeNull();

    fireEvent.click(screen.getByTestId('sim-diag-jump-sweep-rapid-into-fixture'));
    expect(screen.getByTestId('sim-gcode-jump').getAttribute('data-line')).toBe('3');
  });

  it('generates a restart at the current step and offers it for saving (#249)', async () => {
    setSimClientLoader(async () => fakeClient(READY_RESTART));
    useSimSetupStore.getState().openFile('job.nc', RESTART_PROGRAM);
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);
    // T1 M6 is a no-op only when the machine already holds T1; pick that so the resume is exact.
    fireEvent.change(screen.getByTestId('sim-starting-tool'), { target: { value: '1' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');

    act(() => useSimStore.getState().setStep(RESTART_STEP));
    fireEvent.click(screen.getByTestId('sim-restart-generate'));
    await screen.findByTestId('sim-restart-result');
    expect(screen.getByTestId('sim-restart-runsheet').textContent).toContain('expected length');
    expect(screen.getByTestId('sim-restart-runsheet').textContent).toContain(RESTART_TOOL_LENGTH_NOTE);
    expect(screen.getByTestId('sim-restart-save').textContent).toContain(`job-restart-step${RESTART_STEP}.nc`);
    expect(screen.queryByTestId('sim-restart-refused')).toBeNull();
  });

  it('shows a refused restart with the verifier’s reason, and no save button (#249)', async () => {
    setSimClientLoader(async () => fakeClient(READY_RESTART));
    // 11.5 mm deep in the 10 mm default stock: the verifier refuses the generated file.
    useSimSetupStore.getState().openFile('deep.nc', RESTART_PROGRAM.replace('G1 Z-1 F200', 'G1 Z-11.5 F200'));
    act(() => useSimSetupStore.getState().setTool(CHOSEN_TOOL));
    render(<SimPanel />);
    fireEvent.change(screen.getByTestId('sim-starting-tool'), { target: { value: '1' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('sim-simulate'));
    });
    await screen.findByTestId('sim-result');

    act(() => useSimStore.getState().setStep(RESTART_STEP));
    fireEvent.click(screen.getByTestId('sim-restart-generate'));
    const refused = await screen.findByTestId('sim-restart-refused');
    expect(refused.textContent).toContain('cut-too-deep');
    expect(screen.queryByTestId('sim-restart-save')).toBeNull();
  });

  // #726 W8 — after Generate, the session is the RUN's: the panel presents the job's own program
  // and its diagnostics, not an empty open-a-file form with a "required" tool.
  it('a generated job shows the job’s run, not the open-a-file form', () => {
    act(() => {
      useEngraveJobStore.getState().replace({
        ...defaultEngraveJob(),
        name: 'Tray job',
        toolKey: CHOSEN_TOOL,
        stock: { ...defaultEngraveJob().stock, length: 100, width: 60, thickness: 6 },
      });
      useEngraveRunStore.setState({
        ...JOB_RUN,
        generated: {} as never,
        simDiagnostics: [
          { source: 'sweep', severity: 'warning', code: 'holder-unproven', message: 'the shank length is unstated' },
        ],
      });
      useSimStore.setState({ origin: 'engrave', loadedProgram: 'job.nc' });
    });
    render(<SimPanel />);

    expect(screen.getByTestId('sim-file-name').textContent).toBe('Tray job');
    expect(screen.getByTestId('sim-job-run-line').textContent).toContain('100 × 60 × 6 mm');
    expect(screen.getByTestId('sim-job-run-line').textContent).toContain('the job’s own program');
    expect(screen.getByTestId('sim-job-diagnostics').textContent).toContain('holder-unproven');
    // The empty form's demands are gone: no stock fields, no "required" tool, no disabled button.
    expect(screen.queryByTestId('sim-stock-length')).toBeNull();
    expect(screen.queryByTestId('sim-tool-required')).toBeNull();
    expect(screen.queryByTestId('sim-simulate')).toBeNull();
    expect(screen.queryByTestId('sim-drop-hint')).toBeNull();

    // #726 W8 review — an edit past Generate leaves the sweep on screen behind a program that no
    // longer matches the job; the line says so instead of "the job's own program".
    act(() => useEngraveRunStore.setState({ staleSince: Date.now() }));
    expect(screen.getByTestId('sim-job-run-line').textContent).toContain('the job changed since this run');

    // Opening a file here gives the panel its form back: the row shows the file, and the run's
    // Result stays hidden until this panel runs it (#506's rule, not the flag's).
    act(() => useSimSetupStore.getState().openFile('stranger.nc', 'G0 X0 Y0'));
    expect(screen.getByTestId('sim-file-name').textContent).toBe('stranger.nc');
    expect(screen.queryByTestId('sim-job-run-line')).toBeNull();
    expect(screen.queryByTestId('sim-result')).toBeNull();
  });

  // #691 — the "Checked: … / Not checked: …" sentence and the under/over-cut numbers moved here
  // from under Generate (audit B14). They are facts about THIS job's picture, read from the run
  // store's own copy of the run — never from whatever file this panel has open (#506).
  describe('#691 the job’s own simulation facts', () => {
    it('claims nothing before this job has been simulated', () => {
      render(<SimPanel />);
      expect(screen.queryByTestId('sim-job-facts')).toBeNull();
      expect(screen.queryByTestId('sim-job-coverage')).toBeNull();
      expect(screen.queryByTestId('sim-job-oracle')).toBeNull();
    });

    it('reads an under-cut here as a fact about the picture, in §4 figures', () => {
      act(() => {
        useEngraveRunStore.setState({
          ...JOB_RUN,
          oracle: { ok: false, band: 0.018, levels: [], worst: { underCut: 0.25, overCut: 0 } },
        });
      });
      render(<SimPanel />);

      // #726 W9 — the main path says ONE sentence: what was checked. The comparison prose is
      // the Technical fold's, not the first thing above the picture.
      const checkedLine = screen.getByTestId('sim-job-checked').textContent ?? '';
      expect(checkedLine).toContain('Checked: the tool against the stock');
      expect(checkedLine).toContain('the modelled fixture');
      expect(checkedLine).not.toContain('predicted regions');
      expect(checkedLine).not.toContain('two engines');
      const coverage = screen.getByTestId('sim-job-coverage').textContent ?? '';
      expect(coverage).toContain('Not checked: the spindle body, head and gantry');
      expect(coverage).toContain("Checked against the CAM's predicted regions");
      expect(coverage).toContain("the two engines' own resolution");

      const oracle = screen.getByTestId('sim-job-oracle').textContent ?? '';
      expect(oracle).toContain('Matches prediction — worst under-cut 0.25 mm² exceeds the 0.001 mm² floor');
      expect(oracle).toContain('tolerance 0.018 mm');
      // §4 — no four-decimal figure anywhere in the sentence.
      expect(oracle).not.toMatch(/\.\d{4}/);
    });

    it('names the job’s cutter by its one display name in the shank caveat', () => {
      act(() => {
        useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: CHOSEN_TOOL });
        useEngraveRunStore.setState({
          ...JOB_RUN,
          simDiagnostics: [
            { source: 'sweep', severity: 'warning', code: 'holder-unproven', message: 'the shank length is unstated' },
          ],
        });
      });
      render(<SimPanel />);

      const coverage = screen.getByTestId('sim-job-technical').textContent ?? '';
      expect(coverage).toContain('the shank of “⌀ 3.175 mm flat end · 12 mm flute” above the cutter');
      // The vendor label is data, not a name (#691's same rule as the select).
      expect(coverage).not.toContain('3.175*12mm');
    });

    it('#726 W9 — a mesh (surface) run claims no 2.5D comparison, and its prose is Technical', () => {
      act(() => {
        useEngraveRunStore.setState({
          ...JOB_RUN,
          generated: { surface3d: {} } as never,
          oracle: { ok: true, band: 0.1, levels: [], worst: { underCut: 0, overCut: 0 } },
          simGridPitchMm: 0.1,
        });
      });
      render(<SimPanel />);

      // The main path is one checked sentence plus the surface check's own honest line.
      expect(screen.getByTestId('sim-job-checked').textContent).toContain('Checked: the tool against the stock');
      expect(screen.getByTestId('sim-job-oracle').textContent).toContain(
        'No 2.5D check for a surface program — checked on the 0.1 mm dexel grid',
      );
      // The contradiction W9 found: the coverage claimed a predicted-regions comparison the
      // surface program never made, one line above the oracle's "No 2.5D check". Neither that
      // sentence nor the two-engine band belongs to a run with no prediction.
      const technical = screen.getByTestId('sim-job-technical').textContent ?? '';
      expect(technical).not.toContain('predicted regions');
      expect(technical).not.toContain('two engines');
      expect(technical).toContain('Not checked:');
    });

    // #724 W7 — the sweep was given a cylinder on the chuck (`toSetup`), not a vise envelope. The
    // facts used to name the vise fixture anyway; they now state the map's own keep-out bands.
    it('#724 W7 — a rotary job’s facts name the keep-out bands, not a vise fixture', () => {
      act(() => {
        const base = defaultEngraveJob();
        useEngraveJobStore.getState().replace({
          ...base,
          stock: { ...base.stock, length: 100, width: 20, thickness: 20, shape: 'cylinder', diameter: 20, material: 'pla' },
          workholding: {
            kind: 'rotary-chuck',
            rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
          },
        });
        useEngraveRunStore.setState({ ...JOB_RUN });
      });
      render(<SimPanel />);

      // The main path's one sentence holds for a rotary job too: the tool against the stock.
      expect(screen.getByTestId('sim-job-checked').textContent).toContain('Checked: the tool against the stock.');
      // The workholding prose reads in Technical (#726 W9) — and it never names a vise.
      const coverage = screen.getByTestId('sim-job-coverage').textContent ?? '';
      expect(coverage).not.toContain('the modelled fixture');
      expect(coverage).not.toContain('vise');
      expect(coverage).toContain('checked as keep-out bands on the map');
      expect(coverage).toContain('the first 3 mm of the stick-out at the jaws');
      expect(coverage).toContain('the last 10 mm at the free end');
      // The workholding IS checked (as bands), so the "none is modelled" blind spot cannot stand.
      expect(coverage).not.toContain('any fixture — none is modelled');
    });
  });

  // #687/#691 — the Tool select draws the one display-name form, grouped by kind; the vendor's
  // label belongs in the hover (audit D5).
  it('lists the cutters by kind under the one display name, the vendor label in the hover (#691)', () => {
    openPlainFile();
    render(<SimPanel />);
    const select = screen.getByTestId('sim-tool') as HTMLSelectElement;
    const option = Array.from(select.querySelectorAll('option')).find((o) => o.value === CHOSEN_TOOL) as
      | HTMLOptionElement
      | undefined;
    expect(option).toBeTruthy();
    expect(option!.textContent).toBe('⌀ 3.175 mm flat end · 12 mm flute · metal');
    expect(option!.getAttribute('title')).toContain('3.175*12mm Flat End(Metal)');
    expect(option!.closest('optgroup')?.getAttribute('label')).toBe('flat end');
    // No row prints the vendor label as the name.
    const vendorAsName = Array.from(select.querySelectorAll('option')).some((o) => (o.textContent ?? '').includes('3.175*12mm'));
    expect(vendorAsName).toBe(false);
  });
});
