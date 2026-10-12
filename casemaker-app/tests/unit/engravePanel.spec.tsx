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
import { MARGIN_DEFAULTS, checkBounds, splitBound } from '@/engine/cnc/engrave/depthBounds';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { BADGE_POCKET_KEEP_OUT_ID, badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
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

/**
 * Press a button whose handler AWAITS the labels' faces before it writes (#365 review): the click's
 * effect lands on a microtask, so a `fireEvent.click` alone would assert against a store nobody has
 * written to yet.
 */
const press = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
  });
};

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
    // #314 — the collet nut is named from the run's own codes, and this run raised none: the
    // Z1 stating no holder is no longer a blind spot in itself.
    expect(cov).not.toContain('the collet nut');
  });

  it('names the collet nut when the run raised the unproven-holder code (#314)', () => {
    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({
        simStatus: 'ready',
        pathOnly: false,
        simDiagnostics: [{ source: 'sweep', severity: 'warning', code: 'holder-vs-fixture-unproven', message: 'an obstacle rises above the stock top and the collet nut is unmeasured' }],
      });
    });
    expect(screen.getByTestId('engrave-sim-coverage').textContent ?? '').toContain('the collet nut');
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

    // 12 mm blank, ceiling 6: 6.00 mm of material left. #345 decision A — this blank states no
    // print, so there is no layer grid to make the 0.2 mm boundary margin a distance the printer can
    // hold, and the ceiling keeps the job's 1 mm minimum floor instead: 6 − 1.0 = 5.00 mm of cut,
    // and the row NAMES that rule rather than a boundary margin it is not on.
    const readout = screen.getByTestId('engrave-keepout-membrane-0').textContent ?? '';
    expect(readout).toContain('6.00');
    expect(readout).toContain('5.00');
    expect(readout).toContain('the 1 mm minimum floor');

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
    // Inside the 20 × 10 footprint centred on the blank: the 2 mm membrane less the job's 1 mm
    // minimum floor, which #345 decision A gates a no-print blank's void ceiling to (2 − 1.0 = 1.0).
    expect(limit(ko.position.x, ko.position.y)).toBeCloseTo(1.0, 6);
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

  it('takes the stock and the magnet pocket from the badge in one press', async () => {
    setBadge(defaultBadgeParams());
    render(<EngravePanel />);
    await press(screen.getByTestId('engrave-stock-from-badge'));

    const job = useEngraveJobStore.getState().job;
    expect(job.stock).toEqual({ length: 76.2, width: 38.1, thickness: 3.81, material: 'pla' });
    expect((screen.getByTestId('engrave-stock-length') as HTMLInputElement).value).toBe('76.2');
    // The numbers are the model's, not something someone typed here (decision 28's question).
    expect(screen.getByTestId('engrave-stock-length-source').dataset.source).toBe('computed');

    // The void is declared, drawn as a row, and stated as a consequence.
    expect(job.keepOuts!.map((k) => k.id)).toEqual([BADGE_POCKET_KEEP_OUT_ID]);
    expect(screen.getByTestId('engrave-keepout-count').textContent?.trim()).toBe('1');
    expect(screen.getByTestId('engrave-keepout-membrane-0').textContent).toContain('1.51');

    // 1.51 mm of membrane over the pocket, less the job's 1 mm minimum floor: the badge states no
    // print, so #345 decision A keeps the structural floor over the ceiling (1.51 − 1.0 = 0.51) —
    // the number the pre-#345 limit already printed.
    const limit = jobDepthLimit(job);
    expect(limit(38.1, 19.05)).toBeCloseTo(0.51, 6);
    expect(limit(5, 5)).toBeCloseTo(2.81, 6);
    expect(screen.getByTestId('engrave-badge-notes')).toBeTruthy();
  });

  it('reads the layer-aligned limit, not the analytic one, once the blank states its print (#351)', () => {
    // The blank the wizard hands the job (#352) carries the badge's print, so the pocket's roof is
    // quantised onto the 0.2 mm layer grid: the 1.51 mm of declared membrane becomes a 1.40 mm
    // roof, and the 0.2 mm boundary margin makes the limit 1.20. The row used to print the
    // analytic 1.51 − 0.2 = 1.31 while the verifier refused every cut below 1.20 (#351).
    //
    // Seeded through the same `badgeBlankFor` → `takeBadgeBlank` seam `engraveFromBadge.spec` and
    // the wizard use, rather than by pressing the button on a project badge: the badge schema has
    // no `print` key yet (#166 owns that mirror), so a badge written through `patchCase` arrives at
    // the panel with the field already stripped and there would be no print to read.
    act(() => {
      useEngraveJobStore
        .getState()
        .takeBadgeBlank(
          badgeBlankFor(defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } })),
        );
    });
    render(<EngravePanel />);

    const readout = screen.getByTestId('engrave-keepout-membrane-0').textContent ?? '';
    expect(readout).toContain('1.20'); // the number the run enforces — the one a person types against
    expect(readout).not.toContain('1.31'); // the analytic one it printed before
    // The declared membrane is still stated, and the sentence says the LAYER GRID moved the roof
    // rather than crediting the number to a membrane arithmetic it is not on.
    expect(readout).toContain('1.51');
    expect(readout).toContain('as designed');
    expect(readout).toContain('layers put the roof at 1.40');

    // And the limit the row shows is the limit the verifier takes at that point, not a parallel one.
    const job = useEngraveJobStore.getState().job;
    expect(jobDepthLimit(job)(38.1, 19.05)).toBeCloseTo(1.2, 6);
  });

  it('lands on the same void when it is pressed twice', async () => {
    setBadge(defaultBadgeParams());
    render(<EngravePanel />);
    await press(screen.getByTestId('engrave-stock-from-badge'));
    await press(screen.getByTestId('engrave-stock-from-badge'));
    expect(useEngraveJobStore.getState().job.keepOuts).toHaveLength(1);
  });

  it('removes the void IT stamped when the badge has no pocket — and never one the user typed', async () => {
    setBadge(defaultBadgeParams());
    render(<EngravePanel />);
    await press(screen.getByTestId('engrave-stock-from-badge'));
    // A void of the user's own, beside the stamped one.
    fireEvent.click(screen.getByTestId('engrave-add-keepout-circle'));
    expect(useEngraveJobStore.getState().job.keepOuts).toHaveLength(2);

    setBadge(defaultBadgeParams({ magnetPocket: null }));
    await press(screen.getByTestId('engrave-stock-from-badge'));

    const ids = useEngraveJobStore.getState().job.keepOuts!.map((k) => k.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(BADGE_POCKET_KEEP_OUT_ID);
    expect(ids[0]!.startsWith('ko-')).toBe(true);
  });
});

// #362 review, #345's rule — the number says where it came from. The label row used to show a
// recommended depth (0.51 on a badge blank) with no reason under it and, worse, a CEILING line
// reading like the reason. These are the rendering half; the arithmetic is pinned in
// `engraveMargins.spec.ts` and the seam that writes it in `engraveJob.spec.ts`.
describe('EngravePanel — where a label’s depth came from (#362 review)', () => {
  /** The badge route, the one place the app CHOOSES a label's depth (#352). */
  function takeBadgeBlank(over: Partial<BadgeParams> = {}): void {
    act(() => {
      useEngraveJobStore.getState().takeBadgeBlank(badgeBlankFor(defaultBadgeParams(over)));
    });
  }
  /** A badge that states how it was printed — what puts the colour split into the depth model. */
  const PRINTED: Partial<BadgeParams> = { print: { layerHeight: 0.2, firstLayerHeight: 0.2 } };
  const recommended = (i: number) => screen.queryByTestId(`engrave-label-recommended-${i}`)?.textContent ?? null;

  it('names the constraint under the depth it filled in, and calls the ceiling a ceiling', () => {
    takeBadgeBlank();
    // #365: the seeded 'Name' line sits BESIDE the pocket — that is the whole point of the band it
    // is laid in — so what binds it is the jaws. A second line, placed over the pocket, is what
    // shows the void clause; before #365 the void floor was blank-wide and the seeded line carried
    // the pocket's 0.51 mm it was nowhere near.
    act(() => {
      useEngraveJobStore.getState().addLabel();
      const id = useEngraveJobStore.getState().job.labels[1]!.id;
      useEngraveJobStore.getState().updateLabel(id, { position: { x: 38.1, y: 19.05 } });
    });
    render(<EngravePanel />);

    const seeded = recommended(0)!;
    expect(seeded).toContain('Recommended 0.905 mm');
    expect(seeded).toContain('stands 1.905 mm above the jaw tops');
    // The label is AT the recommendation, so nothing is added to reconcile: one number, no second.
    expect(seeded).not.toContain('This label is at');

    // …and the magnet pocket is what leaves 0.51 mm for a line that DOES reach it — the same first
    // clause the run sheet prints in §7 and `recommendLabelDepth` returns.
    const over = recommended(1)!;
    expect(over).toContain('Recommended 0.51 mm');
    expect(over).toContain('"Magnet pocket" leaves 0.51 mm of material');

    // The ceiling stays, and now says what it is. It was the only line under the field, and it read
    // as the reason for a recommended depth (2.81 mm being "the stock thickness less the minimum
    // floor").
    const ceiling = screen.getByTestId('engrave-label-maxdepth-0').textContent!;
    expect(ceiling).toContain('2.81');
    expect(ceiling).toContain('ceiling this blank allows, not the depth the app recommends');
  });

  it('keeps the sentence after the person types their own number, and reconciles the two', () => {
    takeBadgeBlank();
    render(<EngravePanel />);
    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '1.2' } });

    const line = recommended(0)!;
    expect(line).toContain('Recommended 0.905 mm');
    expect(line).toContain('stands 1.905 mm above the jaw tops');
    // The advice is not withdrawn, and the row is honest that the field is no longer on it.
    expect(line).toContain('This label is at 1.2 mm');
  });

  it('offers no recommendation for a reference-only label, or one that states its own colour intent', () => {
    takeBadgeBlank();
    // #363 seeds ONE line on a badge, so add a second: this test needs a row that is NEITHER of the
    // two refusals below, or "every row is null" would pass for the wrong reason.
    act(() => {
      useEngraveJobStore.getState().addLabel();
    });
    render(<EngravePanel />);
    // A construction label cuts nothing, so there is no depth to recommend (#215).
    fireEvent.click(screen.getByTestId('engrave-label-construction-0'));
    expect(recommended(0)).toBeNull();
    // …and a label that states an intent is the user's to place, not the app's to re-depth.
    fireEvent.click(screen.getByTestId('engrave-label-construction-0'));
    act(() => {
      const id = useEngraveJobStore.getState().job.labels[0]!.id;
      useEngraveJobStore.getState().updateLabel(id, { depthIntent: 'surface' });
    });
    expect(recommended(0)).toBeNull();
    // The row that is neither is untouched by either.
    expect(recommended(1)).not.toBeNull();
  });

  it('demotes on the job’s OWN margin, to a floor the checker can hold (#362 review)', () => {
    // Neither the margin nor the vise is the shipped one here, and neither is what the badge brings.
    // The job states its own 0.28 mm boundary margin, and its vise — SET, so a stock edit leaves it
    // alone (#344) — stands the badge 2.2 mm proud, which puts the jaws at 1.2 mm. So the void binds:
    // the pocket's ceiling 1.4 mm down on the 0.2 mm layer grid, less that margin, is 1.12 mm. That
    // lands inside the colour split's ±0.28 mm band at 1.2 mm (neither colour is decided there), so
    // the floor comes back up into the top colour at 0.92 mm.
    //
    // The two numbers are deliberately not 0.8 / 0.2: `1.2 − 0.28` is `0.9199999999999999` to a
    // float, so the demoted 0.92 mm is the recommendation the checker used to refuse against the very
    // bound it was computed from — passing at the shipped margin was float luck (the arithmetic is
    // pinned in `engraveMargins.spec.ts`; one `DEPTH_EPS` now satisfies both sides).
    const base = defaultEngraveJob();
    act(() => {
      useEngraveJobStore.setState({
        job: {
          ...base,
          margins: { boundaryMargin: 0.28, zTolerance: MARGIN_DEFAULTS.zTolerance, source: 'user' },
        },
      });
      useEngraveJobStore.getState().setVise({ stockProud: 2.2 });
    });
    takeBadgeBlank({ ...PRINTED, splitHeight: 2.61 });
    // #365: this test is about the VOID binding, and the seeded line is laid BESIDE the pocket — move
    // it over the pocket, where the ceiling is the floor that binds. Written straight into the job so
    // the seed's own provenance stays what the last assertions read, which `updateLabel` would claim
    // as the person's.
    act(() => {
      const job = useEngraveJobStore.getState().job;
      const [first, ...rest] = job.labels;
      useEngraveJobStore.setState({
        job: { ...job, labels: [{ ...first!, position: { x: 38.1, y: 19.05 } }, ...rest] },
      });
    });
    render(<EngravePanel />);

    // The row the panel offers is the JOB's number, not the house default — which is the margin the
    // recommendation below was worked out with.
    expect(screen.getByTestId('engrave-margins-value').textContent).toBe('0.28 mm');
    expect(screen.getByTestId('engrave-margins-source').textContent).toBe('set for this job');

    const line = recommended(0)!;
    expect(line).toContain('Recommended 0.92 mm');
    expect(line).toContain('"Magnet pocket" leaves 1.12 mm of material');
    expect(line).toContain('inside the colour split');
    expect(line).toContain('stops in the top colour at 0.92 mm');
    // And the bound that number is demoted against HOLDS it: 0.92 mm is a float tail above the
    // `1.2 − 0.28` plane, which is the pair the shared tolerance exists to reconcile.
    expect(checkBounds(0.92, [splitBound('surface', 1.2)!], 0.28)).toBeNull();

    // The store's own write matches it: the depth and the `surface` intent it implies are on the
    // job, both claimed as the app's own — which is what lets a later, different blank revise them.
    // `layout` is there too, because this is the line the badge route seeded (#363 review).
    const job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.depth).toBe(0.92);
    expect(job.labels[0]!.depthIntent).toBe('surface');
    expect(job.sources?.labels?.[job.labels[0]!.id]).toEqual({
      layout: 'computed',
      depth: 'computed',
      depthIntent: 'computed',
    });
  });
});

// #345 — the margins row. It is the only control that moves a job between "the house setting" and
// "my own number", so both directions are driven through the DOM here rather than through the store
// (whose own spec covers `setJobMargins`): what the row SHOWS is as much of the feature as the
// number it writes.
describe('EngravePanel margins row (#345)', () => {
  /** A blank that states the dome a printed badge carries — what lifts the recommendation. */
  const domed = (): void => {
    const job = defaultEngraveJob();
    job.stock.flatness = { dome: 0.33, across: 'width', source: 'badge' };
    act(() => useEngraveJobStore.setState({ job }));
  };

  it('states the margin a job with none of its own is running on, and where it came from', () => {
    render(<EngravePanel />);
    // No `margins` on the job: it follows the house setting, and the row says so rather than
    // claiming the number as the user's.
    expect(screen.getByTestId('engrave-margins-value').textContent).toBe('0.2 mm');
    expect(screen.getByTestId('engrave-margins-source').textContent).toBe('the house default');
    // There is nothing of the job's own to go back to yet.
    expect(screen.queryByTestId('engrave-margins-house')).toBeNull();
  });

  it('offers this blank’s own recommendation, and one click puts the job on it', () => {
    domed();
    render(<EngravePanel />);

    // 0.001 mm of probe plus the stated 0.33 mm dome — above the 0.2 mm house layer, so there is
    // something to take, and the basis says which term moved it.
    const recommended = screen.getByTestId('engrave-margins-recommended').textContent!;
    expect(recommended).toContain('0.331');
    expect(recommended).toContain('domed 0.33');

    fireEvent.click(screen.getByTestId('engrave-margins-use'));

    // The job now OWNS the number (so a later settings change cannot move it), and the row names it
    // the way the run sheet does — one namer (#345 review): a recommended margin is not "yours", it
    // is this blank's own arithmetic, and saying "yours" here and "this job's recommendation" on the
    // printout would describe the same number two ways.
    const job = useEngraveJobStore.getState().job;
    expect(job.margins).toEqual({ boundaryMargin: 0.331, zTolerance: 0.331, source: 'recommended' });
    expect(screen.getByTestId('engrave-margins-value').textContent).toBe('0.331 mm');
    expect(screen.getByTestId('engrave-margins-source').textContent).toBe("this job's recommendation");

    // …and the way back is offered only now that there is something to go back from.
    fireEvent.click(screen.getByTestId('engrave-margins-house'));
    expect(useEngraveJobStore.getState().job.margins).toBeUndefined();
    expect(screen.getByTestId('engrave-margins-value').textContent).toBe('0.2 mm');
    expect(screen.getByTestId('engrave-margins-source').textContent).toBe('the house default');
  });

  it('writes the recommendation into the job’s own margins, not into the house setting', () => {
    domed();
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-margins-use'));

    // The house setting is untouched: taking the advice for ONE blank is not a decision about every
    // job, which is the whole reason the job carries its own copy.
    expect(useSettingsStore.getState().margins.boundaryMargin).toBe(0.2);
    expect(useSettingsStore.getState().margins.source).toBe('default');
  });
});

// #170 — decision 20's control, in the row it lives in: two states and the numeric override, offered
// only where the blank has two outcomes to choose between. The arithmetic is pinned in
// `depthIntent.spec.ts`; what is pinned here is the SHAPE of the control — when it is there at all,
// which state it lights, and what it writes onto the document.
describe('EngravePanel — the two-state depth control (#170)', () => {
  /**
   * A blank that states its print, with the labels exactly as the badge route seeded them.
   *
   * Taken WITHOUT the print first and then given it, deliberately: handing the print to the badge
   * route makes `takeBadgeBlank` re-depth the seeded line onto the colour boundary (the two-colour
   * write #362 review pins), and this describe is about what the CONTROL writes, not what the seed
   * did. The precondition below is asserted rather than assumed.
   */
  function printedBlank(): void {
    act(() => {
      useEngraveJobStore.getState().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
      const job = useEngraveJobStore.getState().job;
      expect(job.labels[0]!.depthIntent).toBeUndefined(); // nothing has stated a colour intent yet
      useEngraveJobStore.setState({
        job: {
          ...job,
          stock: {
            ...job.stock,
            print: {
              split: defaultBadgeParams().splitHeight,
              layerHeight: 0.2,
              firstLayerHeight: 0.2,
            },
          },
        },
      });
    });
  }

  it('offers no colour state on a blank that states no print, and writes no intent from the field', () => {
    // The default job: PLA, one colour, no print. Depth is a free number and the field stands alone.
    render(<EngravePanel />);
    expect(screen.queryByTestId('engrave-label-surface-0')).toBeNull();
    expect(screen.queryByTestId('engrave-label-reveal-0')).toBeNull();

    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '1.5' } });
    const job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.depth).toBe(1.5);
    // Not `'custom'`: with no split there was no colour to override, and stamping an intent would
    // claim one the blank does not have (#362's stamp is what takes a label out of the app's reach).
    expect(job.labels[0]!.depthIntent).toBeUndefined();
    expect(job.sources?.labels?.[job.labels[0]!.id]).toEqual({ depth: 'user' });
  });

  it('writes the layer past the split for each state, and lights only the one that is on', () => {
    printedBlank();
    render(<EngravePanel />);

    const surface = screen.getByTestId('engrave-label-surface-0');
    const reveal = screen.getByTestId('engrave-label-reveal-0');
    // Two states, and neither is on: the seed placed this line without saying which colour it wants.
    expect(surface.getAttribute('aria-pressed')).toBe('false');
    expect(reveal.getAttribute('aria-pressed')).toBe('false');

    // 3.81 mm badge, split 3.0 mm up from the back → 0.81 nominal, on the 0.2 mm grid → 0.8. A
    // `reveal` floor is one printed layer below that plane…
    fireEvent.click(reveal);
    let job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.depthIntent).toBe('reveal');
    expect(job.labels[0]!.depth).toBe(1);
    // The state is the USER's statement, so the store stamps both halves — which is what stops the
    // badge route re-depthing a label a person has placed (#362).
    expect(job.sources?.labels?.[job.labels[0]!.id]).toMatchObject({ depth: 'user', depthIntent: 'user' });
    expect(screen.getByTestId('engrave-label-reveal-0').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('engrave-label-surface-0').getAttribute('aria-pressed')).toBe('false');

    // …and a `surface` floor one layer above it. The two states are exclusive: pressing one moves
    // the floor and unlights the other.
    fireEvent.click(surface);
    job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.depthIntent).toBe('surface');
    // 0.6, not 0.6000000000000001 — the field would show that tail and the checker would judge it
    // against a plane it misses by a trillionth (`roundDepth`).
    expect(job.labels[0]!.depth).toBe(0.6);
    expect(screen.getByTestId('engrave-label-surface-0').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('engrave-label-reveal-0').getAttribute('aria-pressed')).toBe('false');
  });

  it('takes a typed depth as the override, and says the number is the user’s', () => {
    printedBlank();
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-label-reveal-0'));

    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '1.55' } });

    const job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.depth).toBe(1.55);
    // `'custom'`, not a cleared key: the label did mean something and the person has taken the
    // number over. Neither state stays lit — a pressed "reveal" over 1.55 mm would be the row
    // drawing a colour the depth does not have.
    expect(job.labels[0]!.depthIntent).toBe('custom');
    expect(screen.getByTestId('engrave-label-surface-0').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('engrave-label-reveal-0').getAttribute('aria-pressed')).toBe('false');
  });
});
