// @vitest-environment jsdom
// The Engrave panel (#205): add a label, a depth past the floor, the tool hint, the vise badge
// and buttons, and a refused override gating Generate. A fake preview client stands in for the
// worker (`setEngravePreviewClientLoader`); the pure `validateJob` and `feedsFor` are what the
// assertions below actually exercise.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { BADGE_POCKET_KEEP_OUT_ID } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams, type BadgeParams } from '@/types/badge';
import { useProjectStore } from '@/store/projectStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { presetJawStrips } from '@/engine/cnc/sacrificial';
import { runSheetFileName, runSheetFrameFileName } from '@/engine/cnc/engrave/runSheet';
import { saveEngraveProgram } from '@/engine/exportTrigger';
import { clearFeedCatalogue, setFeedCatalogue, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';

// The save path is the thing under test (#207): mock it so a test can read the files the panel
// hands it, without a real download. EngravePanel imports only `saveEngraveProgram` from here.
vi.mock('@/engine/exportTrigger', () => ({ saveEngraveProgram: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client that answers every request with "no new preview", which the panel must survive. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const rows = (): HTMLElement[] => screen.queryAllByTestId(/^engrave-label-row-/);

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose(); // cancel any debounce the reset scheduled
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
});

describe('EngravePanel (#205)', () => {
  it('adds a label row when “Add label” is clicked', () => {
    render(<EngravePanel />);
    expect(rows()).toHaveLength(3);
    fireEvent.click(screen.getByTestId('engrave-add-label'));
    expect(rows()).toHaveLength(4);
  });

  it('marks a depth past the floor and shows the finding under that row', () => {
    render(<EngravePanel />);
    // 12 mm stock, 1 mm minimum floor -> at most 11 mm.
    expect(screen.getByTestId('engrave-label-maxdepth-0').textContent).toContain('11');
    expect(screen.queryByTestId('engrave-label-finding-0-depth-exceeds-stock')).toBeNull();

    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '11.5' } });
    expect(screen.getByTestId('engrave-label-finding-0-depth-exceeds-stock')).toBeTruthy();
    // …and Generate is gated on it.
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('updates the “strokes thinner than” hint when the tool changes', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-thin-strokes').textContent).toContain('1.0 mm');
    fireEvent.change(screen.getByTestId('engrave-tool'), { target: { value: 'flat-3.175x12-metal' } });
    expect(screen.getByTestId('engrave-thin-strokes').textContent).toContain('3.175 mm');
  });

  it('changes the vise badge from unmeasured defaults once the vise is saved', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/unmeasured/);
    fireEvent.click(screen.getByTestId('engrave-vise-save'));
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/^saved/);
    expect(screen.getByTestId('engrave-vise-badge').textContent).not.toMatch(/unmeasured/);
  });

  it('shows a refused cutting override and disables Generate', () => {
    render(<EngravePanel />);
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('engrave-feeds-refused')).toBeNull();

    // The 1.0 mm cutter has a 0.5 mm radius; a 2 mm step-over leaves an uncut spine (#191).
    fireEvent.change(screen.getByTestId('engrave-override-stepOver'), { target: { value: '2' } });
    expect(screen.getByTestId('engrave-feeds-refused').textContent).toContain('step-over');
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);

    // Emptying the field clears the override, so the refusal (and the only way to undo it) must
    // have stayed on screen while it was refused.
    fireEvent.change(screen.getByTestId('engrave-override-stepOver'), { target: { value: '' } });
    expect(screen.queryByTestId('engrave-feeds-refused')).toBeNull();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(false);
  });
});

// #317 — a value the machine moved was invisible: the row kept its provenance tag and the panel
// showed 13 000 rpm where the source said 15 000. These are the rendering half; the diagnostics
// themselves are pinned in `feedCatalogue.spec.ts` / `cncFeeds.spec.ts`. No vendor number below is
// derived from Studio's database — the row is a hand-built fixture in the service's shape.
describe('EngravePanel — the clamp notice (#317)', () => {
  /** The built-in metal flat end's vendor id, which the row must name to be selected at all. */
  const VENDOR_ID = '112111313812';
  const ROW: FeedCatalogueRow = {
    cutterId: VENDOR_ID,
    material: 'Softwood', // the default job's stock, through the vendor's own word
    rpm: 15000,
    feed: 900,
    plungeFeed: 300,
    stepDown: 1.2,
  };

  /** The default job, with the cutter whose id the rows above name. */
  const renderWithCatalogueCutter = (): void => {
    render(<EngravePanel />);
    fireEvent.change(screen.getByTestId('engrave-tool'), { target: { value: 'flat-3.175x12-metal' } });
  };

  afterEach(() => clearFeedCatalogue());

  it('says the machine moved a number, and names the code it moved it for', () => {
    setFeedCatalogue([ROW]);
    renderWithCatalogueCutter();
    const tag = screen.getByTestId('engrave-feeds-clamped');
    expect(tag.textContent).toContain('(1)');
    expect(tag.getAttribute('data-codes')).toBe('rpm-clamped');
    // The provenance tag stays: "whose number is this" and "the machine moved it" are two facts.
    expect(screen.getByTestId('engrave-feeds-status')).toBeTruthy();
  });

  it('is silent when the row is inside the ceiling', () => {
    setFeedCatalogue([{ ...ROW, rpm: 12000 }]);
    renderWithCatalogueCutter();
    expect(screen.queryByTestId('engrave-feeds-clamped')).toBeNull();
  });

  it('counts the clamps and NOT a catalogue row that yielded a field (#325)', () => {
    // A row with no usable feed and a clamped rpm is BOTH a `catalogue-ignored` and an
    // `rpm-clamped`. Only one of them is the machine's doing, so the tag must say (1) — counting
    // the pair would make the sentence a lie about the row that simply had nothing to say.
    setFeedCatalogue([{ ...ROW, feed: 0 }]);
    renderWithCatalogueCutter();
    const tag = screen.getByTestId('engrave-feeds-clamped');
    expect(tag.textContent).toContain('(1)');
    expect(tag.getAttribute('data-codes')).toBe('rpm-clamped');
  });

  it('is absent when the feeds are refused — the refusal box already says so', () => {
    setFeedCatalogue([ROW]);
    renderWithCatalogueCutter();
    // The 3.175 mm cutter's radius is 1.5875 mm; a 2 mm step-over leaves an uncut spine.
    fireEvent.change(screen.getByTestId('engrave-override-stepOver'), { target: { value: '2' } });
    expect(screen.getByTestId('engrave-feeds-refused')).toBeTruthy();
    expect(screen.queryByTestId('engrave-feeds-clamped')).toBeNull();
  });
});

// #214 work item 5: the "Add label" button became an "Add" menu with the five kinds. The label
// entry keeps the historic id so the pre-#214 flow is still one click.
describe('EngravePanel — the Add menu (#214)', () => {
  it('offers all five kinds, and a rectangle adds a rect row with its own editor', () => {
    render(<EngravePanel />);
    for (const kind of ['label', 'rect', 'circle', 'slot', 'polygon']) {
      expect(screen.getByTestId(`engrave-add-${kind}`)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId('engrave-add-rect'));
    const job = useEngraveJobStore.getState().job;
    expect(job.shapes).toHaveLength(1);
    expect(job.shapes[0]!.kind).toBe('rect');
    expect(screen.getByTestId('engrave-shape-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-shape-width-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-shape-height-0')).toBeTruthy();
  });

  it('gives each shape kind its own editor fields', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-circle'));
    expect(screen.getByTestId('engrave-shape-diameter-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-add-slot'));
    expect(screen.getByTestId('engrave-shape-length-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-shape-width-1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-add-polygon'));
    expect(screen.getByTestId('engrave-shape-points-2')).toBeTruthy();

    expect(useEngraveJobStore.getState().job.shapes.map((s) => s.kind)).toEqual([
      'circle',
      'slot',
      'polygon',
    ]);
  });

  it('reports a self-intersecting polygon under its row and gates Generate', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-polygon'));
    fireEvent.change(screen.getByTestId('engrave-shape-points-0'), {
      target: { value: '-5, -5\n5, 5\n5, -5\n-5, 5' },
    });
    expect(screen.getByTestId('engrave-shape-finding-0-polygon-self-intersecting')).toBeTruthy();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });
});

// #213 §5: the Sacrificial material section — presets, the source badge and "Save as my setup".
describe('EngravePanel — sacrificial material (#213)', () => {
  it('starts with no sacrificial material and a "none" badge', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-sac-badge').textContent).toMatch(/none/);
    expect(screen.queryByTestId('engrave-sac-under-thickness')).toBeNull();
  });

  it('applies "Part on a larger board" as a saved setup', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-preset-board'));
    expect(screen.getByTestId('engrave-sac-badge').textContent).toMatch(/^saved/);
    expect((screen.getByTestId('engrave-sac-under') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-sac-under-thickness') as HTMLInputElement).value).toBe('12');
    expect((screen.getByTestId('engrave-sac-under-overhang-left') as HTMLInputElement).value).toBe('10');

    const job = useEngraveJobStore.getState().job;
    expect(job.sacrificial.under?.overhang.left).toBe(10);
    expect(job.sacrificial.source).toBe('saved');
  });

  it('applies "Strips between the jaws" as left and right flush strips', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-preset-strips'));
    expect((screen.getByTestId('engrave-sac-side-left') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-sac-side-right') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-sac-side-front') as HTMLInputElement).checked).toBe(false);

    const job = useEngraveJobStore.getState().job;
    expect(job.sacrificial.sides.left).toEqual({ thickness: 6, height: 'flush' });
    expect(job.sacrificial.sides.right).toEqual({ thickness: 6, height: 'flush' });
    expect(job.sacrificial.under).toBeNull();
  });

  it('turning the board on creates a saved setup whose numbers can be edited', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-under'));
    expect(screen.getByTestId('engrave-sac-badge').textContent).toMatch(/^saved/);
    fireEvent.change(screen.getByTestId('engrave-sac-under-thickness'), { target: { value: '8' } });
    expect(useEngraveJobStore.getState().job.sacrificial.under?.thickness).toBe(8);
  });

  it('"Save as my setup" stores the setup in settings fixtures', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-preset-strips'));
    fireEvent.click(screen.getByTestId('engrave-sac-save'));
    expect(useSettingsStore.getState().fixtures.sacrificial).toEqual(
      useEngraveJobStore.getState().job.sacrificial,
    );
  });

  it('shows a front strip without a board as an error finding', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-side-front'));
    expect(screen.getByTestId('engrave-finding-side-strip-unsupported')).toBeTruthy();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a new job starts from the setup saved in settings fixtures', () => {
    render(<EngravePanel />);
    act(() => {
      useSettingsStore.getState().setSacrificial(presetJawStrips());
      useEngraveJobStore.getState().reset();
    });
    expect(useEngraveJobStore.getState().job.sacrificial).toEqual(presetJawStrips());
    // …and it is shown, so the seam is wired to the UI, not just the store.
    expect((screen.getByTestId('engrave-sac-side-left') as HTMLInputElement).checked).toBe(true);
  });
});

// #215 work item 3: panel rows for the three combined kinds, with a picker for the referenced
// item. The engine half (profile algebra, resolveItems, the item-reference finding) is in; these
// assert the UI produces the right document and surfaces the finding.
describe('EngravePanel — combined shapes (#215)', () => {
  it('adds a border row with inset and width, and counts it as an item', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-item-count').textContent).toBe('3');

    fireEvent.click(screen.getByTestId('engrave-add-border'));
    const job = useEngraveJobStore.getState().job;
    expect(job.combined).toHaveLength(1);
    expect(job.combined![0]!.kind).toBe('border');
    expect(screen.getByTestId('engrave-combined-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-combined-inset-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-combined-width-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-item-count').textContent).toBe('4');
  });

  it('adds a frame referencing the first item, and the picker changes the target', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-frame'));

    const job = useEngraveJobStore.getState().job;
    const frame = job.combined![0]!;
    expect(frame.kind).toBe('frame');
    // The default target is the first item, so the new frame is valid on creation.
    expect(frame.kind === 'frame' && frame.around).toBe(job.labels[0]!.id);

    const second = job.labels[1]!.id;
    fireEvent.change(screen.getByTestId('engrave-combined-around-0'), { target: { value: second } });
    const updated = useEngraveJobStore.getState().job.combined![0]!;
    expect(updated.kind === 'frame' && updated.around).toBe(second);
  });

  it('adds a cut-away whose islands are chosen with checkboxes', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-cutaway'));

    const start = useEngraveJobStore.getState().job;
    expect(start.combined![0]!.kind).toBe('cutaway');
    expect(start.combined![0]!.kind === 'cutaway' && start.combined![0]!.islands).toEqual([]);

    const islandId = start.labels[1]!.id;
    fireEvent.click(screen.getByTestId(`engrave-combined-island-0-${islandId}`));
    const after = useEngraveJobStore.getState().job.combined![0]!;
    expect(after.kind === 'cutaway' && after.islands).toEqual([islandId]);

    // Unchecking removes it again.
    fireEvent.click(screen.getByTestId(`engrave-combined-island-0-${islandId}`));
    const cleared = useEngraveJobStore.getState().job.combined![0]!;
    expect(cleared.kind === 'cutaway' && cleared.islands).toEqual([]);
  });

  it('disables frame and cut-away on an empty job but not a border', () => {
    act(() => {
      const job = useEngraveJobStore.getState().job;
      useEngraveJobStore.getState().replace({ ...job, labels: [], shapes: [], combined: [] });
    });
    render(<EngravePanel />);
    expect((screen.getByTestId('engrave-add-border') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('engrave-add-frame') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('engrave-add-cutaway') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports a broken reference under its row and gates Generate', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-frame'));
    // The frame names labels[0]; remove that label so the reference dangles.
    fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
    expect(screen.getByTestId('engrave-combined-finding-0-item-reference')).toBeTruthy();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a combined item', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-border'));
    fireEvent.click(screen.getByTestId('engrave-combined-remove-0'));
    expect(useEngraveJobStore.getState().job.combined).toEqual([]);
  });

  // #215 gap 1: nothing set `construction: true`, so raised text (a cut-away with a label island)
  // could not be built through the panel. The label and shape rows each own the control now.
  it('marks a label reference-only, so a cut-away can leave it standing as raised text', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-cutaway'));
    const labelId = useEngraveJobStore.getState().job.labels[0]!.id;
    fireEvent.click(screen.getByTestId(`engrave-combined-island-0-${labelId}`));
    fireEvent.click(screen.getByTestId('engrave-label-construction-0'));

    const job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.construction).toBe(true);
    const cut = job.combined![0]!;
    expect(cut.kind === 'cutaway' && cut.islands).toEqual([labelId]);

    // Unchecking clears the flag again (undefined, not a lingering false).
    fireEvent.click(screen.getByTestId('engrave-label-construction-0'));
    expect(useEngraveJobStore.getState().job.labels[0]!.construction).toBeFalsy();
  });

  it('marks a shape reference-only', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-rect'));
    fireEvent.click(screen.getByTestId('engrave-shape-construction-0'));
    expect(useEngraveJobStore.getState().job.shapes[0]!.construction).toBe(true);
  });
});

// #207's mount: the "Run sheet" button opens the printable sheet for a generated, verified job,
// and the file it names is the file Save writes.
describe('EngravePanel — the run sheet mount (#207)', () => {
  /** A generated + verified result the panel can open the sheet for. */
  function readyGenerated(nc: string): EngraveGenerated {
    return {
      ok: true,
      stage: 'done',
      findings: [],
      feeds: null,
      cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 5, passes: 2 },
      nc,
      verify: {
        ok: true,
        findings: [],
        stats: { lines: 2, cuttingMoves: 1, deepestZ: -2, bbox: { min: [0, 0, -2], max: [1, 1, 0] } },
      },
      // #244 — a run that reached `ok` always has the frame (§5 of engraveGenerate), and Save must
      // write BOTH files (#273): the sheet's dry run loads this one by name.
      frameNc: `${nc}\n;frame\n`,
      frameVerify: null,
      predicted: [],
      errors: [],
    };
  }

  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    vi.mocked(saveEngraveProgram).mockClear();
  });

  it('is disabled until a job has generated and verified', () => {
    render(<EngravePanel />);
    expect((screen.getByTestId('engrave-run-sheet') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the sheet for a verified job, and Save writes the sheet’s file name', async () => {
    render(<EngravePanel />);
    const nc = ';@MKR|BEGIN\nG21 G90\nM02';
    act(() => {
      useEngraveRunStore.setState({
        generated: readyGenerated(nc),
        simStatus: 'ready',
        simDiagnostics: [],
        oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
        phase: 'ready',
        acknowledged: true,
      });
    });

    const button = screen.getByTestId('engrave-run-sheet') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    // #255 — this is a WEB build (`vitest.config.ts` defines `__BUILD_TARGET__` as 'web'), so the
    // upload control is not merely disabled: it is not in the tree at all. Asserted HERE, on a run
    // where Save and the run sheet are both live, because at that point the `{!blocked && …}` branch
    // is rendering and an absent testid means something. Anywhere earlier it would be trivially true.
    expect(screen.queryByTestId('engrave-upload')).toBeNull();
    expect(screen.queryByTestId('engrave-upload-panel')).toBeNull();

    // Opening the sheet awaits the bundled fonts (the diagram typesets each label), so the
    // overlay appears on a later tick rather than synchronously.
    const sheet = await screen.findByTestId('run-sheet');
    const expected = runSheetFileName(useEngraveJobStore.getState().job.name);
    expect(expected).toBe('Untitled-engrave-job.nc');
    expect(sheet.textContent).toContain(expected);

    // Save's file name is the sheet's, not the mesh-export sanitiser's — asserted, not trusted.
    // And it writes the FRAME too (#273): §6 sends the operator to that file by name, so the panel
    // that writes one without the other would make the dry run a dead step.
    fireEvent.click(screen.getByTestId('engrave-save'));
    await waitFor(() => expect(vi.mocked(saveEngraveProgram)).toHaveBeenCalledTimes(1));
    const [savedNc, savedFrame, savedName] = vi.mocked(saveEngraveProgram).mock.calls[0]!;
    expect(savedNc).toBe(nc);
    expect(savedName).toBe(useEngraveJobStore.getState().job.name);
    // The frame the panel hands over is the run's own verified one — never re-derived here.
    expect(savedFrame).toBe(useEngraveRunStore.getState().generated!.frameNc);
    expect(runSheetFrameFileName(savedName)).toBe('Untitled-engrave-job-frame.nc');
    // §6 and the saved file agree about the name, which is the whole point of the shared sanitiser.
    expect(sheet.textContent).toContain(runSheetFrameFileName(savedName));
  });

  it('refuses the sheet once the job is stale', () => {
    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({
        generated: readyGenerated(';@MKR|BEGIN\nM02'),
        simStatus: 'ready',
        oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
        phase: 'ready',
        acknowledged: true,
        staleSince: Date.now(),
      });
    });
    expect((screen.getByTestId('engrave-run-sheet') as HTMLButtonElement).disabled).toBe(true);
  });

  // #174's last owed cover: a VERIFIER refusal is not a job-validation error, so it cannot gate
  // the Generate button — it can only shut Save, and it must say why. The store half (a real
  // `cut-too-deep` produced by the real pipeline) is `engraveRunVerify.spec.ts`; this is the
  // same result as the panel renders it.
  it('keeps Save shut and names the reason when the verifier refused the file (#174)', () => {
    const refused: EngraveGenerated = {
      ...readyGenerated(';@MKR|BEGIN\nG21 G90\nG1 Z-1.5 F200\nM02'),
      ok: false,
      stage: 'verify',
      verify: {
        ok: false,
        findings: [
          { severity: 'error', code: 'cut-too-deep', line: 3, message: 'cuts to -1.5 mm; only 1 mm is allowed' },
        ],
        stats: { lines: 3, cuttingMoves: 1, deepestZ: -1.5, bbox: { min: [0, 0, -1.5], max: [1, 1, 0] } },
      },
      errors: [{ stage: 'verify', message: '1 verifier error(s)' }],
    };
    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({ generated: refused, simStatus: null, phase: 'blocked' });
    });

    expect((screen.getByTestId('engrave-save') as HTMLButtonElement).disabled).toBe(true);
    // The button's own tooltip carries the reason, and the line under it spells it out.
    expect(screen.getByTestId('engrave-save')!.getAttribute('title')).toContain('1 error outstanding');
    expect(screen.getByTestId('engrave-save-blocked').textContent).toContain('1 error outstanding');
    expect(screen.getByTestId('engrave-run-errors').textContent).toContain('1 error outstanding');
  });
});

// #219's panel: the two single-line kinds in the Add menu, their editors, and the finding the
// pure validator raises when a trace's strokes merge under the cutter.
describe('EngravePanel — single-line traces (#219)', () => {
  it('adds a Line and a Single-line text from the Add menu', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-line'));
    expect(useEngraveJobStore.getState().job.traces![0]!.kind).toBe('line');
    expect(screen.getByTestId('engrave-trace-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-trace-points-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-trace-closed-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-add-stroke-label'));
    expect(useEngraveJobStore.getState().job.traces![1]!.kind).toBe('stroke-label');
    expect(screen.getByTestId('engrave-trace-row-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-trace-text-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-trace-font-1')).toBeTruthy();
    // Traces count as items (#219), alongside the three default labels.
    expect(screen.getByTestId('engrave-item-count').textContent).toBe('5');
  });

  it('commits points only when the path is a valid polyline', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-line'));
    // One point is not a line: the job keeps the valid default path.
    fireEvent.change(screen.getByTestId('engrave-trace-points-0'), { target: { value: '1, 2' } });
    const after = useEngraveJobStore.getState().job.traces![0]!;
    expect(after.kind === 'line' && after.points.length).toBe(2);
    // Three points commit.
    fireEvent.change(screen.getByTestId('engrave-trace-points-0'), {
      target: { value: '0, 0\n10, 0\n10, 10' },
    });
    const done = useEngraveJobStore.getState().job.traces![0]!;
    expect(done.kind === 'line' && done.points.length).toBe(3);
  });

  it('warns (not errors) when a trace’s strokes merge, and leaves Generate enabled', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-line'));
    // Two parallel segments 0.8 mm apart under the 1.0 mm cutter (r = 0.5).
    fireEvent.change(screen.getByTestId('engrave-trace-points-0'), {
      target: { value: '-5, 0\n5, 0\n5, 0.8\n-5, 0.8' },
    });
    expect(screen.getByTestId('engrave-trace-finding-0-trace-self-overlap')).toBeTruthy();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('removes a trace', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-line'));
    fireEvent.click(screen.getByTestId('engrave-trace-remove-0'));
    expect(useEngraveJobStore.getState().job.traces).toEqual([]);
  });
});

// #220's panel half (#260): the two drill kinds in the Add menu, their editors, and the refusal
// the pure validator raises for a through hole until #218 lands.
describe('EngravePanel — plunge drills (#260)', () => {
  it('adds a Hole and a Hole array from the Add menu', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-drill'));
    expect(useEngraveJobStore.getState().job.drills![0]!.kind).toBe('drill');
    expect(screen.getByTestId('engrave-drill-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-drill-depth-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-drill-through-0')).toBeTruthy();
    // A single hole has no lattice.
    expect(screen.queryByTestId('engrave-drill-count-x-0')).toBeNull();

    fireEvent.click(screen.getByTestId('engrave-add-drill-array'));
    expect(useEngraveJobStore.getState().job.drills![1]!.kind).toBe('drill-array');
    expect(screen.getByTestId('engrave-drill-row-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-drill-count-x-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-drill-pitch-y-1')).toBeTruthy();
    // Drills count as items, alongside the three default labels.
    expect(screen.getByTestId('engrave-item-count').textContent).toBe('5');
  });

  it('commits a count only when it is a whole number', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-drill-array'));
    // A fractional count would be refused by the schema, so the row keeps the default 2.
    fireEvent.change(screen.getByTestId('engrave-drill-count-x-0'), { target: { value: '1.5' } });
    const after = useEngraveJobStore.getState().job.drills![0]!;
    expect(after.kind === 'drill-array' && after.count.x).toBe(2);
    fireEvent.change(screen.getByTestId('engrave-drill-count-x-0'), { target: { value: '3' } });
    const done = useEngraveJobStore.getState().job.drills![0]!;
    expect(done.kind === 'drill-array' && done.count.x).toBe(3);
  });

  it('refuses a through hole and disables Generate, naming #218', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-drill'));
    fireEvent.click(screen.getByTestId('engrave-drill-through-0'));
    expect(useEngraveJobStore.getState().job.drills![0]!.through).toBe(true);
    const finding = screen.getByTestId('engrave-drill-finding-0-drill-through-unavailable');
    expect(finding.textContent).toContain('#218');
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a drill', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-drill'));
    fireEvent.click(screen.getByTestId('engrave-drill-remove-0'));
    expect(useEngraveJobStore.getState().job.drills).toEqual([]);
  });
});

// #243 §14.2 A2: the Simulated row carries the same blind-spot sentence the Simulate panel
// builds — imported from `simCoverage`, never written again, so the two cannot disagree.
describe('EngravePanel — the Simulated row’s coverage sentence (#243)', () => {
  beforeEach(() => {
    useEngraveRunStore.getState().reset();
  });

  it('names the geometry the sweep saw and did not see for a swept run', () => {
    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({ simStatus: 'ready', pathOnly: false, simDiagnostics: [] });
    });
    const cov = screen.getByTestId('engrave-sim-coverage').textContent ?? '';
    expect(cov).toContain('Checked: the tool against the stock');
    // The Z1 states no holder, so the collet nut is named as a blind spot.
    expect(cov).toContain('the collet nut');
  });

  it('says so in the same place when the run was path-only', () => {
    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({ simStatus: 'refused', pathOnly: true, simDiagnostics: [] });
    });
    expect(screen.getByTestId('engrave-sim-coverage').textContent ?? '').toMatch(/path-only/);
  });

  it('says nothing was swept when the run was refused outright', () => {
    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({ simStatus: 'refused', pathOnly: false, simDiagnostics: [] });
    });
    expect(screen.getByTestId('engrave-sim-coverage').textContent ?? '').toContain('Nothing was swept');
  });
});

// #271 — the under-surface void PRODUCER. Everything downstream of `job.keepOuts` existed and was
// tested; nothing could write one, so the depth limit, the `item-over-void` warning and the run
// sheet's §1 list were all unreachable from the app. These tests drive the row that writes it and
// then ask `jobDepthLimit` — the single owner of the limit, the function #174's verifier refuses
// against — what the job now permits. A UI assertion alone would not prove the void reached the
// limit; a store assertion alone would not prove there is a way to write it.
describe('EngravePanel — under-surface voids (#271)', () => {
  it('adds a void from the Stock section and it round-trips through the schema', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-keepout-count').textContent?.trim()).toBe('0');
    expect(screen.queryByTestId('engrave-keepout-row-0')).toBeNull();

    fireEvent.click(screen.getByTestId('engrave-add-keepout-rect'));

    expect(screen.getByTestId('engrave-keepout-count').textContent?.trim()).toBe('1');
    expect(screen.getByTestId('engrave-keepout-row-0')).toBeTruthy();

    const job = useEngraveJobStore.getState().job;
    expect(job.keepOuts).toHaveLength(1);
    const ko = job.keepOuts![0]!;
    expect(ko.kind).toBe('rect');
    expect(ko.enabled).toBe(true);
    // Half of the 12 mm default blank, rounded to 0.1 — a neutral starting ceiling, not a guess.
    expect(ko.zCeiling).toBe(6);

    // The default must LOAD: the schema rejects the whole document if one field is out of range.
    const reparsed = parseEngraveJob(JSON.parse(JSON.stringify(job)) as unknown);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.job.keepOuts).toHaveLength(1);
  });

  it('states the membrane the ceiling leaves, and what it permits as the ceiling moves', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-keepout-rect'));

    // 12 mm blank, minFloor 1 mm, ceiling 6: 6.00 mm of material left, 5.00 mm of cut allowed.
    const readout = screen.getByTestId('engrave-keepout-membrane-0').textContent ?? '';
    expect(readout).toContain('6.00');
    expect(readout).toContain('5.00');

    // The ceiling is measured UP from the bottom face, so a HIGHER ceiling leaves LESS material.
    fireEvent.change(screen.getByTestId('engrave-keepout-zceiling-0'), { target: { value: '10' } });
    const higher = screen.getByTestId('engrave-keepout-membrane-0').textContent ?? '';
    expect(higher).toContain('2.00');
    expect(higher).toContain('1.00');
    expect(useEngraveJobStore.getState().job.keepOuts![0]!.zCeiling).toBe(10);

    // A ceiling at the top face is not inside the blank: it says so instead of promising a cut.
    fireEvent.change(screen.getByTestId('engrave-keepout-zceiling-0'), { target: { value: '12' } });
    expect(screen.getByTestId('engrave-keepout-membrane-0').textContent).toMatch(/not inside a 12 mm blank/);
  });

  it('writes a void the depth limit actually reads, and only over its footprint', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-keepout-rect'));
    fireEvent.change(screen.getByTestId('engrave-keepout-zceiling-0'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('engrave-keepout-name-0'), { target: { value: 'Magnet pocket' } });

    const job = useEngraveJobStore.getState().job;
    const ko = job.keepOuts![0]!;
    const limit = jobDepthLimit(job);
    // Inside the 20 × 10 footprint centred on the blank: the membrane less the floor (2 − 1).
    expect(limit(ko.position.x, ko.position.y)).toBeCloseTo(1, 6);
    // Well clear of it: the stock's own limit, untouched by the void.
    expect(limit(2, 2)).toBeCloseTo(job.stock.thickness - job.minFloor, 6);
    // The name reaches the job too — the run sheet and the warning both print it.
    expect(ko.name).toBe('Magnet pocket');
  });

  it('edits the footprint, renames and removes a void', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-keepout-circle'));
    fireEvent.change(screen.getByTestId('engrave-keepout-diameter-0'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('engrave-keepout-x-0'), { target: { value: '30' } });

    const ko = useEngraveJobStore.getState().job.keepOuts![0]!;
    expect(ko.kind === 'circle' && ko.diameter).toBe(12);
    expect(ko.position.x).toBe(30);
    // The other axis is untouched — a partial position patch merges.
    expect(ko.position.y).toBe(useEngraveJobStore.getState().job.stock.width / 2);

    fireEvent.click(screen.getByTestId('engrave-keepout-remove-0'));
    expect(useEngraveJobStore.getState().job.keepOuts).toEqual([]);
    expect(screen.getByTestId('engrave-keepout-count').textContent?.trim()).toBe('0');
  });

  it('keeps a disabled void in the job but out of the depth limit', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-keepout-rect'));
    fireEvent.change(screen.getByTestId('engrave-keepout-zceiling-0'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('engrave-keepout-enabled-0'));

    const job = useEngraveJobStore.getState().job;
    expect(job.keepOuts).toHaveLength(1);
    expect(job.keepOuts![0]!.enabled).toBe(false);
    // The blank still has the pocket; the job simply reserves nothing for it.
    const limit = jobDepthLimit(job);
    expect(limit(job.keepOuts![0]!.position.x, job.keepOuts![0]!.position.y)).toBeCloseTo(
      job.stock.thickness - job.minFloor,
      6,
    );
  });
});

// #271 route 1 — the blank is already in the project, so the panel must not ask for it again.
// These tests set `case.badge` on the project, press the button, and read back BOTH the job the
// store now holds and the limit `jobDepthLimit` derives from it: a button that changed the stock
// but not the limit (or the reverse) would pass an assertion on either one alone.
describe('EngravePanel — the badge blank (#271 route 1)', () => {
  /** Put a badge on the project (or take it off, with `undefined`). */
  function setBadge(badge: BadgeParams | undefined): void {
    act(() => {
      const store = useProjectStore.getState();
      if (badge) store.patchCase({ badge });
      else {
        const nextCase = { ...store.project.case };
        delete nextCase.badge;
        useProjectStore.setState({ project: { ...store.project, case: nextCase } });
      }
    });
  }

  afterEach(() => setBadge(undefined));

  it('offers the button only when the project has an enabled badge', () => {
    render(<EngravePanel />);
    const button = (): HTMLButtonElement => screen.getByTestId('engrave-stock-from-badge') as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    // A badge that exists but is switched off is not a badge project.
    setBadge(defaultBadgeParams({ enabled: false }));
    expect(button().disabled).toBe(true);

    setBadge(defaultBadgeParams());
    expect(button().disabled).toBe(false);
  });

  it('takes the stock and the magnet pocket from the badge in one press', () => {
    setBadge(defaultBadgeParams());
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-stock-from-badge'));

    const job = useEngraveJobStore.getState().job;
    expect(job.stock).toEqual({ length: 76.2, width: 38.1, thickness: 3.81, material: 'pla' });
    expect((screen.getByTestId('engrave-stock-length') as HTMLInputElement).value).toBe('76.2');
    // The numbers are the model's, not something someone typed here (decision 28's question).
    expect(screen.getByTestId('engrave-stock-length-source').dataset.source).toBe('computed');

    // The void is declared, drawn as a row, and stated as a consequence.
    expect(job.keepOuts!.map((k) => k.id)).toEqual([BADGE_POCKET_KEEP_OUT_ID]);
    expect(screen.getByTestId('engrave-keepout-count').textContent?.trim()).toBe('1');
    expect(screen.getByTestId('engrave-keepout-membrane-0').textContent).toContain('1.51');

    // 1.51 mm of membrane over the pocket, less the 1 mm minimum floor.
    const limit = jobDepthLimit(job);
    expect(limit(38.1, 19.05)).toBeCloseTo(0.51, 6);
    expect(limit(5, 5)).toBeCloseTo(2.81, 6);
    expect(screen.getByTestId('engrave-badge-notes')).toBeTruthy();
  });

  it('lands on the same void when it is pressed twice', () => {
    setBadge(defaultBadgeParams());
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-stock-from-badge'));
    fireEvent.click(screen.getByTestId('engrave-stock-from-badge'));
    expect(useEngraveJobStore.getState().job.keepOuts).toHaveLength(1);
  });

  it('removes the void IT stamped when the badge has no pocket — and never one the user typed', () => {
    setBadge(defaultBadgeParams());
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-stock-from-badge'));
    // A void of the user's own, beside the stamped one.
    fireEvent.click(screen.getByTestId('engrave-add-keepout-circle'));
    expect(useEngraveJobStore.getState().job.keepOuts).toHaveLength(2);

    setBadge(defaultBadgeParams({ magnetPocket: null }));
    fireEvent.click(screen.getByTestId('engrave-stock-from-badge'));

    const ids = useEngraveJobStore.getState().job.keepOuts!.map((k) => k.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(BADGE_POCKET_KEEP_OUT_ID);
    expect(ids[0]!.startsWith('ko-')).toBe(true);
  });
});
