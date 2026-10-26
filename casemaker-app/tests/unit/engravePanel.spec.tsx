// @vitest-environment jsdom
// The Engrave panel (#205): add a label, a depth past the floor, the tool hint, the vise badge
// and buttons, and a refused override gating Generate. A fake preview client stands in for the
// worker (`setEngravePreviewClientLoader`); the pure `validateJob` and `feedsFor` are what the
// assertions below actually exercise.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore, undoEngraveRemoval, resetEngraveRemovalUndo, REMOVAL_UNDO_MS } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useMachineStore } from '@/store/machineStore';
import { resetEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { resetEngravePackageStore } from '@/store/engravePackageStore';
import { resetCncMode } from '@/store/cncModeStore';
import { resetEngraveRows } from '@/store/engraveRowStore';
import {
  resetEngraveRegistrationStore,
  useEngraveRegistrationStore,
} from '@/store/engraveRegistrationStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { MARGIN_DEFAULTS, checkBounds, splitBound } from '@/engine/cnc/engrave/depthBounds';
import { assessSurfaceSpread } from '@/engine/cnc/engrave/surfaceSpread';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { BADGE_POCKET_KEEP_OUT_ID, badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams, type BadgeParams } from '@/types/badge';
import { useProjectStore } from '@/store/projectStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { presetJawStrips } from '@/engine/cnc/sacrificial';
import { runSheetFileName, runSheetFrameFileName } from '@/engine/cnc/engrave/runSheet';
import { saveEngraveProgram } from '@/engine/exportTrigger';
import { clearFeedCatalogue, setFeedCatalogue, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { setInventoryEntries, resetRegistry } from '@/engine/cnc/toolRegistry';
import { setJobFileIO } from '@/store/engraveJobFileStore';
import { flatEndMill } from '@/engine/cnc/tool';
import { vCone } from '@/engine/cnc/vProfile';
import { vCarvePlane, vCarveStepover, vCarveStepoverClampNote } from '@/engine/cnc/vCarveGeometry';
import { itemName, V_BIT_CARVE_SENTENCE, type ToolRecommendation } from '@/engine/cnc/engrave/recommendTool';
import type { EngraveDrill, EngraveJob, EngraveShape, EngraveTargetObject, EngraveTraceItem } from '@/types/engraveJob';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

// The save path is the thing under test (#207): mock it so a test can read the files the panel
// hands it, without a real download. EngravePanel imports only `saveEngraveProgram` from here.
vi.mock('@/engine/exportTrigger', () => ({ saveEngraveProgram: vi.fn() }));
// #469 — the desktop gate around the machine surfaces. This harness is jsdom, where the real
// `__BUILD_TARGET__` is not desktop, so the routing tests would otherwise be dead code. The
// getter keeps the other 90-odd tests in the web-build state they were written for.
const caps = vi.hoisted(() => ({ canDriveMachine: false }));
vi.mock('@/platform/capabilities', () => ({
  get canDriveMachine() {
    return caps.canDriveMachine;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client that answers every request with "no new preview", which the panel must survive. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const rows = (): HTMLElement[] => screen.queryAllByTestId(/^engrave-label-row-/);

/**
 * #411 — an item's editor lives behind its row's chevron, so a spec that reads or fills one of its
 * fields opens the row first. The rows a job STARTS with are folded; a row a test adds through the
 * panel is not (the add handlers expand it), which is why the "Add …" cases need nothing here.
 */
const expand = (prefix: string, index = 0): void => {
  fireEvent.click(screen.getByTestId(`${prefix}-expand-${index}`));
};

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
  // #411 — the fold is module-level session state, so a spec that expanded a row would otherwise
  // leave the next one with an editor already showing. The removal undo is the same kind of state
  // and carries a live timer with it, so it goes too.
  resetEngraveRows();
  resetEngraveRemovalUndo();
  act(() => {
    // #516 item 5 — the default job no longer seeds a cutter, but these panel tests exercise
    // Generate/sheet/facing paths that need one, so the store job states `flat-1.0` (the
    // recommendation the panel would apply once the preview lands).
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-1.0' } });
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
    expand('engrave-label');
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
    // #407 — this is the built-in `(Metal)` row, the only built-in at 3.175 mm: on the default
    // softwood blank the worker's `engraveRegions` refuses the pair (`tool-metal-line`). The hint
    // below is a fact about the selected cutter, computed beside that refusal; this jsdom harness
    // has no worker, and the panel's fallback (`validateJob` + `validateVise`) does not carry the
    // worker's finding, so the refusal itself is pinned in `engravePreview.spec.ts` and
    // `engraveGenerate.spec.ts`, not here.
    fireEvent.change(screen.getByTestId('engrave-tool'), { target: { value: 'flat-3.175x12-metal' } });
    expect(screen.getByTestId('engrave-thin-strokes').textContent).toContain('3.175 mm');
  });

  it('overrides a refused metal-line cutter behind a double confirm (#572)', () => {
    // The finding is worker-only, so this jsdom harness injects it through the preview store —
    // the same shape the worker's `engraveRegions` returns. The affordance must demand TWO clicks,
    // and only the second records the override on the job.
    const preview = {
      colourBoundaryDepth: null,
      recommendation: null,
      findings: [
        {
          severity: 'error',
          code: 'tool-metal-line',
          message: '"Engraving V-bit 30 x 0.5 (Metal)" is on Makera\'s "for Metal" line, and this job cuts Softwood.',
        },
      ],
    } as unknown as EngravePreview;

    act(() => {
      useEngravePreviewStore.setState({ preview, status: 'ready' });
    });
    render(<EngravePanel />);

    expect(screen.getByTestId('metal-line-use-anyway')).toBeTruthy();
    fireEvent.click(screen.getByTestId('metal-line-use-anyway'));
    // The first click only warns; the override is not yet recorded.
    expect(useEngraveJobStore.getState().job.metalLineOverride).toBeUndefined();
    fireEvent.click(screen.getByTestId('metal-line-confirm'));
    expect(useEngraveJobStore.getState().job.metalLineOverride).toBe(true);
  });

  it('changes the vise badge from the shipped set once the vise is saved', () => {
    render(<EngravePanel />);
    // "shipped · reference unit", not "unmeasured": the numbers ARE measured — once, on the unit
    // Makera measured, which is not this user's vise (#208, 2026-10-15).
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/shipped/);
    fireEvent.click(screen.getByTestId('engrave-vise-save'));
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/^saved/);
    expect(screen.getByTestId('engrave-vise-badge').textContent).not.toMatch(/shipped/);
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
    // #407 — the only built-in row carrying this vendor id is the `(Metal)` one, and on the
    // default softwood blank the worker refuses the pair (`tool-metal-line`). The clamp notice is
    // about the feed row, not the line; the panel's no-worker fallback does not run
    // `engraveRegions`, so the refusal is not rendered here — it is pinned in
    // `engravePreview.spec.ts` and `engraveGenerate.spec.ts`.
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
    expect(screen.getByTestId('engrave-finding-0-side-strip-unsupported')).toBeTruthy();
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
    // The job's own label, not one this test added: fold it open to reach its control (#411).
    expand('engrave-label');
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
      threads: null,
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
      // #432 — a run that does not face emits no facing program, and that is not a refusal.
      facingNc: null,
      facingVerify: null,
      facingToolKey: null,
      facingError: null,
      facingCam: null,
      predicted: [],
      // #419 J3 — the same program, as the run's list of one.
      programs: [
        {
          setupIndex: 1,
          setupId: 'setup-implicit',
          toolKey: 'flat-1.0',
          nc,
          verify: {
            ok: true,
            findings: [],
            stats: { lines: 2, cuttingMoves: 1, deepestZ: -2, bbox: { min: [0, 0, -2], max: [1, 1, 0] } },
          },
          frameNc: `${nc}\n;frame\n`,
          frameVerify: null,
          programHash: '00000000',
          cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 5, passes: 2 },
        },
      ],
      errors: [],
    };
  }

  beforeEach(() => {
    useEngraveRunStore.getState().reset();
    resetEngraveRegistrationStore();
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
    expect(expected).toBe('Untitled-job.nc');
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
    expect(runSheetFrameFileName(savedName)).toBe('Untitled-job-frame.nc');
    // §6 and the saved file agree about the name, which is the whole point of the shared sanitiser.
    expect(sheet.textContent).toContain(runSheetFrameFileName(savedName));
  });

  it('prints the measured landing range from this job’s registration (#475)', async () => {
    const target = { host: '192.0.2.10', port: 2222 };
    const job = useEngraveJobStore.getState().job;
    // The registration measured five touches; the sheet must print THESE numbers, not the plan.
    const assessment = assessSurfaceSpread(job, [
      { z: -56.1, source: 'probe' },
      { z: -56.05, source: 'probe' },
      { z: -56.02, source: 'probe' },
      { z: -56.08, source: 'probe' },
      { z: -56.04, source: 'probe' },
    ]);
    expect(assessment.ok).toBe(true);
    useEngraveRegistrationStore.getState().measureSurface(job.id, target, assessment);
    act(() => {
      useMachineStore.setState({
        machine: {
          name: 'Z1',
          host: target.host,
          port: target.port,
          busy: false,
          ip: null,
          mac: null,
          status: '<Idle|MPos:0,0,0>',
          profileId: 'Z1',
          observedAt: '2026-10-17T00:00:00.000Z',
          notes: [],
        },
      });
    });

    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({
        generated: readyGenerated(';@MKR|BEGIN\nG21 G90\nM02'),
        simStatus: 'ready',
        simDiagnostics: [],
        phase: 'ready',
        acknowledged: true,
      });
    });
    fireEvent.click(screen.getByTestId('engrave-run-sheet'));
    const sheet = await screen.findByTestId('run-sheet');

    // The executor's readings, in the plan's order, with their provenance and the landing range.
    // #608 — the landing range is the band less the RESIDUAL (0.042), not the spread (0.08): the
    // near-linear ramp fits a plane, so the tilt leaves more room than the old spread-only rule.
    expect(sheet.textContent).toContain("Measured: lowest -56.1 at the cut area's centre (probe)");
    expect(sheet.textContent).toContain('spread 0.08 mm against the 11 mm band');
    expect(sheet.textContent).toContain('the floors may land from 0 to 10.958 mm below Z0');
    // The plan-only stop rule is replaced, not duplicated: the sheet knows what this blank measured.
    expect(sheet.textContent).not.toContain('If the touches miss a fitted plane by more than');
  });

  it('refuses the sheet once the job is stale', () => {    render(<EngravePanel />);
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

  // #409 — the three stroke-model fields are OPT-IN and the editor is the only place a LABEL item
  // can turn them on. They stay absent by default, so a stored job that states none of them lays
  // out exactly as before; clearing a field returns it to absent.
  it('edits a single-line label’s bold width, condense and gap, and clears them again', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-line'));
    fireEvent.click(screen.getByTestId('engrave-add-stroke-label'));

    // A `line` has no stroke model — these are the LABEL item's fields.
    expect(screen.queryByTestId('engrave-trace-weight-0')).toBeNull();
    expect(screen.queryByTestId('engrave-trace-widthscale-1')).toBeTruthy();
    expect(screen.queryByTestId('engrave-trace-spacing-1')).toBeTruthy();

    const stroke = (): Extract<EngraveTraceItem, { kind: 'stroke-label' }> => {
      const t = useEngraveJobStore.getState().job.traces![1]!;
      if (t.kind !== 'stroke-label') throw new Error('expected the added stroke label');
      return t;
    };

    fireEvent.change(screen.getByTestId('engrave-trace-weight-1'), { target: { value: '1.5' } });
    expect(stroke().weight).toBe(1.5);
    // Out of the schema's bounds is not committed: the job must stay loadable.
    fireEvent.change(screen.getByTestId('engrave-trace-weight-1'), { target: { value: '50' } });
    expect(stroke().weight).toBe(1.5);
    fireEvent.change(screen.getByTestId('engrave-trace-weight-1'), { target: { value: '' } });
    expect(stroke().weight).toBeUndefined();

    fireEvent.change(screen.getByTestId('engrave-trace-widthscale-1'), { target: { value: '0.8' } });
    expect(stroke().widthScale).toBe(0.8);
    fireEvent.change(screen.getByTestId('engrave-trace-widthscale-1'), { target: { value: '0.3' } });
    expect(stroke().widthScale).toBe(0.8);
    fireEvent.change(screen.getByTestId('engrave-trace-widthscale-1'), { target: { value: '' } });
    expect(stroke().widthScale).toBeUndefined();

    const gap = screen.getByTestId('engrave-trace-spacing-1') as HTMLInputElement;
    fireEvent.click(gap);
    expect(stroke().spacing).toBe('cut-width');
    fireEvent.click(gap);
    expect(stroke().spacing).toBeUndefined();
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

  it('refuses a through hole with no board under it, and disables Generate (#218)', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-drill'));
    fireEvent.click(screen.getByTestId('engrave-drill-through-0'));
    expect(useEngraveJobStore.getState().job.drills![0]!.through).toBe(true);
    // The shipped job has no sacrificial material, so the cut would reach the vise. The gate is
    // the board's, no longer #218's absence.
    const finding = screen.getByTestId('engrave-drill-finding-0-through-needs-board');
    expect(finding.textContent).toContain('under-board');
    expect(finding.textContent).toContain('1.3');
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a drill', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-drill'));
    fireEvent.click(screen.getByTestId('engrave-drill-remove-0'));
    expect(useEngraveJobStore.getState().job.drills).toEqual([]);
  });
});

// #668 — BORE TO SIZE: the picker's own type. A bore is the drill item with `mode: 'bore'` and a
// stated hole diameter, so it adds from the same menu, opens on the hole ⌀ rather than the
// cutter's width, and states the helix pitch the CAM will cut.
describe('EngravePanel — bore to size (#668)', () => {
  it('adds a bore at a clearance diameter and states its helix pitch', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-bore'));
    const drill = useEngraveJobStore.getState().job.drills![0]!;
    expect(drill.mode).toBe('bore');
    // The job's cutter is ⌀1 mm: a new bore is a clearance hole over it — ⌀2, not the cutter's own.
    expect(drill.diameter).toBe(2);
    expect(screen.getByTestId('engrave-drill-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-drill-row-0').textContent).toContain('Bore');
    // The row's technical fold states the pitch the CAM uses, resolved from the feeds row and the
    // shop's ramp angle.
    const pitch = screen.getByTestId('engrave-drill-bore-pitch-0').textContent ?? '';
    // Both of the pitch's sources, and where the shop's came from.
    expect(pitch).toContain('per turn');
    expect(pitch).toContain('step-down');
    expect(pitch).toContain('ramp (fallback)');
  });

  it('writes the hole ⌀, and refuses a hole no wider than the cutter', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-bore'));
    fireEvent.change(screen.getByTestId('engrave-drill-diameter-0'), { target: { value: '4.5' } });
    expect(useEngraveJobStore.getState().job.drills![0]!.diameter).toBe(4.5);
    expect(screen.queryByTestId('engrave-drill-finding-0-bore-narrow')).toBeNull();

    // ⌀1 against a ⌀1 cutter has no centre path: the finding names it and Generate is gated.
    fireEvent.change(screen.getByTestId('engrave-drill-diameter-0'), { target: { value: '1' } });
    expect(useEngraveJobStore.getState().job.drills![0]!.diameter).toBe(1);
    const finding = screen.getByTestId('engrave-drill-finding-0-bore-narrow');
    expect(finding.textContent).toContain('not wider than');
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });
});

// #665 — V-CARVE (VARIABLE DEPTH): the picker adds a region with the flag set, and the shape row's
// fold switches it back to the plane cut. The default job's cutter is a flat end mill, so the
// control is not offered at all — a flat cutter pockets one depth.
describe('EngravePanel — V-carve variable depth (#665)', () => {
  const V_TOOL = flatEndMill(3.175, {
    name: '3.175 mm 90° V',
    typeText: 'Chamfer',
    shape: 'chamfer',
    tipDiameter: null,
    diameter: 3.175,
    angle: 90,
    halfAngle: null,
  });

  it('adds a variable-depth region from the picker and switches it back with the row', () => {
    act(() => {
      useEngraveJobStore.setState({
        job: { ...defaultEngraveJob(), toolKey: 'test:v-90', tool: V_TOOL },
      });
    });
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-v-carve-variable'));
    expect(useEngraveJobStore.getState().job.shapes[0]!.vCarveDepth).toBe('variable');
    const select = screen.getByTestId('engrave-shape-vcarve-depth-0') as HTMLSelectElement;
    expect(select.value).toBe('variable');
    // #677 — no flat cutter is set up on this job, so the note says which cutter to add; with the
    // clearance pair the note names it instead.
    expect(screen.getByTestId('engrave-shape-vcarve-note-0').textContent).toContain(
      'add a flat end mill to the setup',
    );
    fireEvent.change(select, { target: { value: 'plane' } });
    expect(useEngraveJobStore.getState().job.shapes[0]!.vCarveDepth).toBe('plane');
    expect(screen.queryByTestId('engrave-shape-vcarve-note-0')).toBeNull();
  });

  it('does not offer the control to a flat cutter', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-rect'));
    expect(screen.queryByTestId('engrave-shape-vcarve-depth-0')).toBeNull();
  });

  // #677 — with a flat end mill after the V in the setup, the row states the CORE CLEARANCE: the
  // note names the cutter, and the second-cutter control is worded as the flat bottom rather than
  // a rest pass.
  it('names the clearance cutter and words the second cutter as the core', () => {
    const V_KEY = 'inv:v-677';
    const FLAT = flatEndMill(1.5, { name: '1.5 mm flat', fluteLength: 20, shoulderLength: 20 });
    const FLAT_KEY = 'inv:flat-677';
    act(() =>
      setInventoryEntries([
        { key: V_KEY, tool: V_TOOL, provenance: 'EngravePanel core spec' },
        { key: FLAT_KEY, tool: FLAT, provenance: 'EngravePanel core spec' },
      ]),
    );
    const shape: EngraveShape = {
      id: 'plate',
      name: 'plate',
      kind: 'rect',
      position: { x: 50, y: 30 },
      rotation: 0,
      depth: 0.5,
      enabled: true,
      width: 20,
      height: 10,
      cornerRadius: 0,
      vCarveDepth: 'variable',
    };
    act(() =>
      useEngraveJobStore.setState({
        job: {
          ...defaultEngraveJob(),
          labels: [],
          traces: [],
          toolKey: V_KEY,
          tool: V_TOOL,
          shapes: [shape],
          setups: [
            {
              id: 'setup-1',
              orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
              mount: { kind: 'vise' },
              itemIds: ['plate'],
              tools: [V_KEY, FLAT_KEY],
            },
          ],
        },
      }),
    );
    render(<EngravePanel />);
    expand('engrave-shape');
    expect(screen.getByTestId('engrave-shape-vcarve-note-0').textContent).toContain(
      '1.5 mm flat end pockets it flat at that depth in its own program',
    );
    expect(screen.getByText('Clear the middle the V cannot reach')).toBeTruthy();
    expect(screen.getByTestId('engrave-shape-rest-note-0').textContent).toContain('pockets the middle');
    act(() => resetRegistry());
  });
});

// #669 — CHAMFER THE EDGE: a chamfer row picks a rim and a width, and says which side of the edge
// the cutter runs. The job's default cutter is a flat end mill, so the row states that a cone is
// what a chamfer needs rather than pretending a bevel can be cut with it.
describe('EngravePanel — chamfer the edge (#669)', () => {
  it('adds a chamfer, and asks for a rim when the job has none', () => {
    render(<EngravePanel />);
    // The default job is three text labels: no shape's outline to follow.
    fireEvent.click(screen.getByTestId('engrave-add-chamfer'));
    const chamfer = useEngraveJobStore.getState().job.chamfers![0]!;
    expect(chamfer.side).toBe('outside');
    expect(chamfer.width).toBe(0.5);
    expect(chamfer.of).toBeUndefined();
    expect(screen.getByTestId('engrave-chamfer-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-chamfer-finding-0-chamfer-needs-edge')).toBeTruthy();
    // No cone cutter on the default job's flat end mill.
    expect(screen.getByTestId('engrave-chamfer-derived-0').textContent).toContain('no usable cone');
  });

  it('follows a pocket’s outline once one exists, and writes the width and the side', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-rect'));
    const shapeId = useEngraveJobStore.getState().job.shapes[0]!.id;
    fireEvent.click(screen.getByTestId('engrave-add-chamfer'));
    expect(useEngraveJobStore.getState().job.chamfers![0]!.of).toBe(shapeId);
    fireEvent.change(screen.getByTestId('engrave-chamfer-width-0'), { target: { value: '1.5' } });
    expect(useEngraveJobStore.getState().job.chamfers![0]!.width).toBe(1.5);
    fireEvent.change(screen.getByTestId('engrave-chamfer-side-0'), { target: { value: 'inside' } });
    expect(useEngraveJobStore.getState().job.chamfers![0]!.side).toBe('inside');
    // A flat end mill cannot cut a bevel, and the row names the shape it is rather than hiding it.
    expect(screen.getByTestId('engrave-chamfer-finding-0-chamfer-needs-cone')).toBeTruthy();
  });

  it('never shows a rim the chamfer does not have', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-rect'));
    const shapeId = useEngraveJobStore.getState().job.shapes[0]!.id;
    fireEvent.click(screen.getByTestId('engrave-add-chamfer'));
    // Disabling the rim takes it out of the picker; the select must still name the document's rim
    // (with the word for why) rather than falling through to the first remaining option.
    act(() => useEngraveJobStore.getState().updateShape(shapeId, { enabled: false }));
    const select = screen.getByTestId('engrave-chamfer-of-0') as HTMLSelectElement;
    expect(select.value).toBe(shapeId);
    const chosen = select.selectedOptions[0];
    expect(chosen?.textContent).toContain('(disabled)');
  });
});

// #434 — a drill bit is a DRILL-ONLY cutter: one program has one tool, and the bit cannot open a
// region. The panel offers the registry's drill only when the job's cutting work is all holes, and
// states the point angle (and where it came from) for the drill it has selected.
describe('EngravePanel — the drill bit as a drill-only cutter (#434)', () => {
  const DRILL_KEY = 'inv:drill-3';
  const DRILL = flatEndMill(3, {
    name: '3 mm drill',
    typeText: 'Drill',
    shape: 'drill',
    tipDiameter: 3,
    diameter: 3,
    cornerRadius: null,
    angle: null,
    centreCutting: null,
  });
  const HOLE = {
    id: 'port',
    kind: 'drill' as const,
    name: 'port',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 2,
    enabled: true,
    through: false,
  };

  /** The same drill, selected, with no regions/traces/threads: the drill-only shape. */
  function drillOnlyJob(): ReturnType<typeof defaultEngraveJob> {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    job.traces = [];
    job.threads = [];
    job.drills = [HOLE];
    job.toolKey = DRILL_KEY;
    return job;
  }

  function show(job: ReturnType<typeof defaultEngraveJob>): void {
    setInventoryEntries([{ key: DRILL_KEY, tool: DRILL, provenance: 'EngravePanel drill spec' }]);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({ preview: null, status: 'idle' });
    render(<EngravePanel />);
  }

  const optionValues = (): string[] =>
    Array.from((screen.getByTestId('engrave-tool') as HTMLSelectElement).options).map((o) => o.value);

  afterEach(() => {
    act(() => resetRegistry());
  });

  it('offers an owned drill bit for a job that cuts only holes, and states its point', () => {
    show(drillOnlyJob());
    expect(optionValues()).toContain(DRILL_KEY);
    expect((screen.getByTestId('engrave-tool') as HTMLSelectElement).value).toBe(DRILL_KEY);

    // The angle is the shop's `drill.pointAngleDeg` (the drill states none), labelled as such, and
    // the tip's point length is stated with it.
    const point = screen.getByTestId('engrave-drill-point').textContent ?? '';
    expect(point).toContain('Drill point.');
    expect(point).toContain('118.0°');
    expect(point).toContain('drill.pointAngleDeg');
    expect(point).toContain('fallback');
    expect(point).toContain('0.901 mm above the tip');
  });

  it('does not offer a drill to a job that engraves regions', () => {
    show(defaultEngraveJob());
    expect(optionValues()).not.toContain(DRILL_KEY);
    // No drill is selected, so there is no point note to state.
    expect(screen.queryByTestId('engrave-drill-point')).toBeNull();
  });

  it('keeps a selected drill listed in a mixed job and says why that pairing is refused', () => {
    const job = defaultEngraveJob();
    job.drills = [HOLE];
    job.toolKey = DRILL_KEY;
    show(job);
    // The select must always have its own value among its options.
    expect(optionValues()).toContain(DRILL_KEY);
    expand('engrave-drill');
    const finding = screen.getByTestId('engrave-drill-finding-0-drill-mixed-tools');
    expect(finding.textContent).toContain('drilled holes only');
  });
});

// #445 phase B3: the thread row (B1) is reachable from the panel here. The row's own patch contract
// is `engraveThreadRow.spec.tsx`'s; what these cases pin is the WIRING — the menu entry, the count,
// the fold, the removal's undo — so "a person can add a thread" stops being an unverified claim.
describe('EngravePanel — milled threads (#445 B3)', () => {
  it('adds a Thread from the Add menu, open, at the shop’s starting depth', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-thread'));

    const job = useEngraveJobStore.getState().job;
    expect(job.threads).toHaveLength(1);
    expect(job.threads![0]!.kind).toBe('thread');
    // The same "the row you just added is the open one" rule every other kind follows (#411).
    expect(screen.getByTestId('engrave-thread-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-thread-depth-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-thread-size-0')).toBeTruthy();

    // `engrave.newThreadDepthMm`'s labelled fallback with no shop service is 5 mm — a thread that
    // starts as deep as a label would show a hole in the collapsed line, not a threaded length.
    expect(job.threads![0]!.depth).toBe(5);
    // It counts as an item, alongside the three default labels.
    expect(screen.getByTestId('engrave-item-count').textContent).toBe('4');
  });

  it('writes the thread’s size and depth into the job', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-thread'));

    fireEvent.change(screen.getByTestId('engrave-thread-size-0'), { target: { value: 'M5' } });
    fireEvent.change(screen.getByTestId('engrave-thread-depth-0'), { target: { value: '8' } });

    const thread = useEngraveJobStore.getState().job.threads![0]!;
    expect(thread.size).toBe('M5');
    expect(thread.depth).toBe(8);
    // The patch is a merge: the fields the person did not touch survive (`updateThread`).
    expect(thread.position).toEqual({ x: useEngraveJobStore.getState().job.stock.length / 2, y: useEngraveJobStore.getState().job.stock.width / 2 });
  });

  it('removes a thread and offers its undo at the removal site', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-thread'));
    const id = useEngraveJobStore.getState().job.threads![0]!.id;

    fireEvent.click(screen.getByTestId('engrave-thread-remove-0'));
    expect(useEngraveJobStore.getState().job.threads).toEqual([]);
    // The strip names the thing in the row's own words, like every other kind (#411).
    expect(screen.getByTestId('engrave-undo-what').textContent).toBe('Thread removed.');

    fireEvent.click(screen.getByTestId('engrave-undo'));
    expect(useEngraveJobStore.getState().job.threads!.map((t) => t.id)).toEqual([id]);
    expect(screen.queryByTestId('engrave-undo-strip')).toBeNull();
  });

  it('opens a thread row with the item list’s expand-all', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-thread'));
    fireEvent.click(screen.getByTestId('engrave-item-collapse-all'));
    expect(screen.queryByTestId('engrave-thread-depth-0')).toBeNull();

    // `itemRowIds` has to carry the thread's id, or "expand all" leaves this one row folded.
    fireEvent.click(screen.getByTestId('engrave-item-expand-all'));
    expect(screen.getByTestId('engrave-thread-depth-0')).toBeTruthy();
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
    // The blank AND the print facts that ride with it (#352, #368): the badge the template makes
    // states how it was printed, so the blank arrives with a layer grid. No bow comes with it —
    // since #496 a bow belongs to the piece as clamped and is only written by a measurement. The
    // blank is TURNED for the vise (#383): 38.1 mm across X, 76.2 mm along Y.
    expect(job.stock).toEqual({
      length: 38.1,
      width: 76.2,
      thickness: 3.81,
      material: 'pla',
      colour: { kind: 'printed', capMm: 0.81, layerHeight: 0.2, firstLayerHeight: 0.2 },
    });
    expect((screen.getByTestId('engrave-stock-length') as HTMLInputElement).value).toBe('38.1');
    // The numbers are the model's, not something someone typed here (decision 28's question).
    expect(screen.getByTestId('engrave-stock-length-source').dataset.source).toBe('computed');

    // The void is declared, drawn as a row, and stated as a consequence.
    expect(job.keepOuts!.map((k) => k.id)).toEqual([BADGE_POCKET_KEEP_OUT_ID]);
    expect(screen.getByTestId('engrave-keepout-count').textContent?.trim()).toBe('1');
    expand('engrave-keepout');
    expect(screen.getByTestId('engrave-keepout-membrane-0').textContent).toContain('1.51');

    // 1.51 mm of declared membrane over the pocket, and because the blank states its print the roof
    // is snapped onto the 0.2 mm layer grid (1.40) and the boundary margin taken off it: 1.20 mm.
    // The badge's own 1 mm minimum floor is NOT what stands in here — it does that only for a badge
    // that states no print (#345 decision A), and this one does state one.
    const limit = jobDepthLimit(job);
    expect(limit(19.05, 38.1)).toBeCloseTo(1.2, 6);
    expect(limit(5, 5)).toBeCloseTo(2.81, 6);
    expect(screen.getByTestId('engrave-badge-notes')).toBeTruthy();
  });

  it('reads the layer-aligned limit, not the analytic one, once the blank states its print (#351)', () => {
    // The blank the wizard hands the job (#352) carries the badge's print, so the pocket's roof is
    // quantised onto the 0.2 mm layer grid: the 1.51 mm of declared membrane becomes a 1.40 mm
    // roof, and the 0.2 mm boundary margin makes the limit 1.20. The row used to print the
    // analytic 1.51 − 0.2 = 1.31 while the verifier refused every cut below 1.20 (#351).
    //
    // Seeded through the same `badgeBlankFor` → `takeBadgeBlank` seam `engraveFromBadge.spec` uses,
    // to hold this spec on the panel's own readout rather than re-covering the wizard's badge→blank
    // plumbing (the project-badge route is the test above, which now presses the button on a badge
    // that states its print — #368 gave the schema the mirror that used to strip it).
    act(() => {
      useEngraveJobStore
        .getState()
        .takeBadgeBlank(
          badgeBlankFor(defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } })),
        );
    });
    render(<EngravePanel />);

    expand('engrave-keepout'); // #411 — the sentence is in the row's editor now
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
    expect(jobDepthLimit(job)(19.05, 38.1)).toBeCloseTo(1.2, 6);
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
  /** The badge route, the one place the app CHOOSES a label's depth (#352), on a badge that states
   * no print — the state these rows' analytic numbers (the jaws' 0.905, the pocket's 0.51) are on.
   * `over` can put a print back, which is what the split-band test below does. */
  function takeBadgeBlank(over: Partial<BadgeParams> = {}): void {
    act(() => {
      useEngraveJobStore
        .getState()
        .takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined, ...over })));
    });
  }
  /** A badge that states how it was printed — what puts the colour split into the depth model. */
  const PRINTED: Partial<BadgeParams> = { print: { layerHeight: 0.2, firstLayerHeight: 0.2 } };
  const recommended = (i: number) => screen.queryByTestId(`engrave-label-recommended-${i}`)?.textContent ?? null;

  it('names the constraint under the depth it filled in, and calls the ceiling a ceiling', () => {
    takeBadgeBlank();
    // #365: the seeded 'Name' line sits BESIDE the pocket — that is the whole point of the band it
    // is laid in — and since #369 it is clear of the JAWS too. It carried the pocket's 0.51 mm
    // before #365 made the void bound per-line, and the jaws' 0.905 mm before #369 made the jaw
    // bound per-item — two floors neither the pocket nor the jaws could reach the line to impose.
    // #440: nor is the blank's underside an answer for it. Nothing limits this line, so the
    // recommendation is the depth the line itself asks for (the seed's 0.5 mm), and the 2.81 mm
    // ceiling only bounds it. A second line, placed over the pocket, is what shows the void clause.
    act(() => {
      useEngraveJobStore.getState().addLabel();
      const id = useEngraveJobStore.getState().job.labels[1]!.id;
      // …and on the TURNED blank (#383) it has to be a line that fits: a new label's default
      // 'New text' at 10 mm is ~70 mm wide across a 38.1 mm blank, so it overhangs both jaws and
      // earns no recommendation at all (no floor stays 1 mm above the jaw tops). The seed's own
      // face, 8 mm, is 28.3 mm wide and clears them by 4.9 mm; at y = 57 it sits inside the
      // pocket's 15.6–60.6 band without overlapping the seeded line, which stops at y = 52.2.
      useEngraveJobStore
        .getState()
        .updateLabel(id, { text: 'Name', size: 8, position: { x: 19.05, y: 57 } });
    });
    render(<EngravePanel />);
    // #411 — the recommendation is part of the row's editor, which is folded on a job that starts
    // from a blank. Both lines: the seeded one and the one this test added.
    expand('engrave-label');
    expand('engrave-label', 1);

    const seeded = recommended(0)!;
    expect(seeded).toContain('Recommended 0.5 mm');
    expect(seeded).toContain(
      "the blank's 1 mm minimum floor allows 2.81 mm, and the label's own 0.5 mm depth is within it",
    );
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

  it('keeps the sentence after the person types a number the blank cannot carry, and reconciles the two', () => {
    takeBadgeBlank();
    render(<EngravePanel />);
    expand('engrave-label'); // #411
    // #440 — a typed depth is the label's own design, so on a blank that can carry it the
    // recommendation is that same number and there is nothing to reconcile. This is the state where
    // the ceiling DOES bind: 3.5 mm asks for more than the 3.81 mm badge keeps above its 1 mm floor.
    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '3.5' } });

    const line = recommended(0)!;
    expect(line).toContain('Recommended 2.81 mm');
    expect(line).toContain(
      "the blank's 1 mm minimum floor allows 2.81 mm, but the label's own 3.5 mm depth asks for more — " +
        "the floor stops at the blank's limit",
    );
    // The advice is not withdrawn, and the row is honest that the field is no longer on it.
    expect(line).toContain('This label is at 3.5 mm');
    // The ceiling paragraph must not call the number it just recommended "not the recommendation".
    expect(screen.getByTestId('engrave-label-maxdepth-0').textContent).toContain(
      'The recommendation stops here — a deeper cut would break the blank’s minimum floor.',
    );
  });

  it('offers no recommendation for a reference-only label, or one that states its own colour intent', () => {
    takeBadgeBlank();
    // #363 seeds ONE line on a badge, so add a second: this test needs a row that is NEITHER of the
    // two refusals below, or "every row is null" would pass for the wrong reason. Small and clear
    // of the pocket and of both jaw faces (#383's turned blank is only 38.1 mm across X), so the
    // recommendation it should keep is a real one.
    act(() => {
      const id = useEngraveJobStore.getState().addLabel();
      useEngraveJobStore.getState().updateLabel(id, { text: 'OK', size: 6, position: { x: 19.05, y: 8 } });
    });
    render(<EngravePanel />);
    // #411 — both rows open: row 0 is the one the two refusals are pressed on, row 1 the control.
    expand('engrave-label');
    expand('engrave-label', 1);
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
    // it over the pocket (the turned blank's centre, #383), where the ceiling is the floor that
    // binds. Written straight into the job so the seed's own provenance stays what the last
    // assertions read, which `updateLabel` would claim as the person's.
    act(() => {
      const job = useEngraveJobStore.getState().job;
      const [first, ...rest] = job.labels;
      useEngraveJobStore.setState({
        job: { ...job, labels: [{ ...first!, position: { x: 19.05, y: 38.1 } }, ...rest] },
      });
      // The walk has to be re-run at the new position: `setState` writes a document, it does not
      // re-depth one, and the line has not been over the void since the blank was taken. It is the
      // same walk `takeBadgeBlank` ends on, so the store's number below is the store's own answer.
      useEngraveJobStore.getState().redepthLabelsForBlank();
    });
    render(<EngravePanel />);
    expand('engrave-label'); // #411 — the recommendation is inside the row now

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
  /** A blank whose surface was measured bowed — what lifts the recommendation since #496. */
  const domed = (): void => {
    const job = defaultEngraveJob();
    job.stock.flatness = {
      xMm: 0.33,
      yMm: 0.1,
      source: 'measured',
      touchCount: 5,
      measuredAt: '2026-10-18T10:00:00.000Z',
    };
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

    // 0.001 mm of probe plus the measured 0.33 mm drop — above the 0.2 mm house layer, so there is
    // something to take, and the basis says which term moved it.
    const recommended = screen.getByTestId('engrave-margins-recommended').textContent!;
    expect(recommended).toContain('0.331');
    expect(recommended).toContain('falls 0.33 mm along X');

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
      useEngraveJobStore.getState().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined })));
      const job = useEngraveJobStore.getState().job;
      expect(job.labels[0]!.depthIntent).toBeUndefined(); // nothing has stated a colour intent yet
      useEngraveJobStore.setState({
        job: {
          ...job,
          stock: {
            ...job.stock,
            colour: {
              kind: 'printed',
              capMm: defaultBadgeParams().thickness - defaultBadgeParams().splitHeight,
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
    expand('engrave-label'); // #411 — "no control is drawn" is only meaningful with the row open
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
    expand('engrave-label'); // #411 — the two states live in the row's editor

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
    expand('engrave-label'); // #411
    fireEvent.click(screen.getByTestId('engrave-label-reveal-0'));

    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '1.55' } });

    const job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.depth).toBe(1.55);
    // `'custom'`, not a cleared key: the label did mean something and the person has taken the
    // number over. Neither state stays lit — a pressed "reveal" over 1.55 mm would be the row
    // drawing a colour the depth does not have.
    expect(job.labels[0]!.depthIntent).toBe('custom');
    // …and BOTH halves of the claim are stamped (#170 review): `depth` is the number the route must
    // not re-depth (#362), and `depthIntent` is what says the `'custom'` above is a PERSON's
    // statement rather than one the app wrote for itself. Without the second stamp the two are
    // indistinguishable, and the recommendation would be free to revise a person's override.
    // (`toMatchObject`: the badge seed left its own `layout` claim beside these, which this test is
    // not about.)
    expect(job.sources?.labels?.[job.labels[0]!.id]).toMatchObject({
      depth: 'user',
      depthIntent: 'user',
    });
    expect(screen.getByTestId('engrave-label-surface-0').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('engrave-label-reveal-0').getAttribute('aria-pressed')).toBe('false');
  });

  it('clears a leftover intent from a blank that has none, so the field cannot lock it out (#170 review)', () => {
    // A job that came from a PRINTED blank and lost its print — or a document authored by hand —
    // can carry an intent no control is drawn for. The field is the only depth control such a row
    // has, and a stated intent is exactly what takes a label out of `recommendLabelDepth`'s reach
    // (#362): left standing it would go on claiming a colour the blank does not have, with nothing
    // on screen to say why no recommendation appears.
    render(<EngravePanel />);
    expand('engrave-label'); // #411 — the field that clears the intent is in the row's editor
    const id = useEngraveJobStore.getState().job.labels[0]!.id;
    act(() => {
      useEngraveJobStore.getState().updateLabel(id, { depthIntent: 'reveal' });
    });
    expect(useEngraveJobStore.getState().job.labels[0]!.depthIntent).toBe('reveal');

    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '1.5' } });

    const job = useEngraveJobStore.getState().job;
    expect(job.labels[0]!.depth).toBe(1.5);
    expect(job.labels[0]!.depthIntent).toBeUndefined();
    // The CLAIM is dropped too, not just the field: the store deletes it when the patch says
    // `undefined`, and a claim that outlived its intent would keep the label out of the app's reach
    // for good.
    expect(job.sources?.labels?.[id]).toEqual({ depth: 'user' });
  });
});

// #411 — the list's fold and the removal's undo. Both are panel state, not job data: how the list is
// folded is where the person left the panel, and the undo is a property of the last press rather
// than of the document.
describe('EngravePanel item rows (#411)', () => {
  it('folds the whole item list with the header’s two controls', () => {
    render(<EngravePanel />);
    // A job that arrives from a file is one line per item: the editor of every row is closed.
    expect(screen.queryByTestId('engrave-label-text-0')).toBeNull();

    fireEvent.click(screen.getByTestId('engrave-item-expand-all'));
    for (const i of [0, 1, 2]) expect(screen.getByTestId(`engrave-label-text-${i}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-item-collapse-all'));
    expect(screen.queryByTestId('engrave-label-text-0')).toBeNull();
  });

  it('opens only the void list with the void header’s expand-all', () => {
    act(() => {
      useEngraveJobStore.getState().addKeepOut('rect');
    });
    render(<EngravePanel />);

    fireEvent.click(screen.getByTestId('engrave-keepout-expand-all'));
    expect(screen.getByTestId('engrave-keepout-width-0')).toBeTruthy();
    // The two sections fold separately: the item list is untouched by the void header's control.
    expect(screen.queryByTestId('engrave-label-text-0')).toBeNull();
  });

  it('arrives with the editor showing when an item is added', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-label'));
    // The new row is the LAST label, and it is the only one open.
    expect(screen.getByTestId('engrave-label-text-3')).toBeTruthy();
    expect(screen.queryByTestId('engrave-label-text-0')).toBeNull();
  });

  it('offers the removal’s undo at the removal site, and puts the item back where it was', () => {
    render(<EngravePanel />);
    const before = useEngraveJobStore.getState().job.labels.map((l) => l.id);

    fireEvent.click(screen.getByTestId('engrave-label-remove-1'));
    expect(useEngraveJobStore.getState().job.labels.map((l) => l.id)).toEqual([
      before[0],
      before[2],
    ]);
    expect(screen.getByTestId('engrave-undo-what').textContent).toContain('removed.');
    // The strip names the thing in the row's own words.
    expect(screen.getByTestId('engrave-undo-what').textContent).toContain('Label');

    fireEvent.click(screen.getByTestId('engrave-undo'));
    // Back at index 1, not appended: the list (and the run sheet built from it) is what it was.
    expect(useEngraveJobStore.getState().job.labels.map((l) => l.id)).toEqual(before);
    expect(screen.queryByTestId('engrave-undo-strip')).toBeNull();
  });

  it('brings a removed label’s claims back with it', () => {
    render(<EngravePanel />);
    const id = useEngraveJobStore.getState().job.labels[0]!.id;
    expand('engrave-label');
    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '1.5' } });
    expect(useEngraveJobStore.getState().job.sources?.labels?.[id]).toEqual({ depth: 'user' });

    // The removal takes the claim with it (#363), so the undo has to be the one that brings it back:
    // a restored label whose typed depth had lost its provenance would be re-depthable by the next
    // blank change (#362).
    fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
    expect(useEngraveJobStore.getState().job.sources?.labels?.[id]).toBeUndefined();
    fireEvent.click(screen.getByTestId('engrave-undo'));
    expect(useEngraveJobStore.getState().job.sources?.labels?.[id]).toEqual({ depth: 'user' });
  });

  it('retires the undo on the next edit of any kind', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
    expect(screen.getByTestId('engrave-undo-strip')).toBeTruthy();

    // Any write — including one that has nothing to do with the removal — retires the strip, which
    // is the maintainer's "until the next edit" without a timer.
    fireEvent.click(screen.getByTestId('engrave-add-label'));
    expect(screen.queryByTestId('engrave-undo-strip')).toBeNull();
    expect(useEngraveJobStore.getState().removalUndo).toEqual([]);
  });

  it('offers a void’s undo under the voids, not under the item list below it', () => {
    act(() => {
      useEngraveJobStore.getState().addKeepOut('rect');
    });
    render(<EngravePanel />);

    fireEvent.click(screen.getByTestId('engrave-keepout-remove-0'));
    const strip = screen.getByTestId('engrave-undo-strip');
    expect(strip.textContent).toContain('Void');

    // Placement, not just presence: the strip is drawn above the "Items" heading, in the section the
    // void came out of — an undo offered under the item list would look like it belonged to an item.
    const itemsHeading = screen.getByTestId('engrave-item-count').closest('h3')!;
    expect(strip.compareDocumentPosition(itemsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-undo'));
    expect(useEngraveJobStore.getState().job.keepOuts).toHaveLength(1);
    expect(screen.queryByTestId('engrave-undo-strip')).toBeNull();
  });

  it('arms no undo for a void a ROUTE stamped, only for one a person removed', () => {
    // `takeBadgeBlank` removes the pocket void by id when a badge has none. Nobody declared it, and a
    // strip appearing out of a blank change would be the panel offering to undo something the person
    // never did.
    act(() => {
      useEngraveJobStore.getState().upsertKeepOut({
        id: BADGE_POCKET_KEEP_OUT_ID,
        kind: 'rect',
        name: 'Magnet pocket',
        position: { x: 10, y: 10 },
        rotation: 0,
        enabled: true,
        width: 10,
        height: 6,
        cornerRadius: 0,
        zCeiling: 1.9,
      });
    });
    render(<EngravePanel />);

    // A badge whose model declares no pocket, so the route clears the stale one rather than writing
    // its own.
    act(() => {
      useEngraveJobStore
        .getState()
        .takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ magnetPocket: null })));
    });
    expect(useEngraveJobStore.getState().job.keepOuts ?? []).toHaveLength(0);
    expect(useEngraveJobStore.getState().removalUndo).toEqual([]);
    expect(screen.queryByTestId('engrave-undo-strip')).toBeNull();
  });

  it('folds only its own list when a section header says “collapse all”', () => {
    // The bug the review found: `collapseAll` cleared the whole open set, so pressing it on the ITEMS
    // header also folded the void list below it. A list header acts on its own list.
    act(() => {
      useEngraveJobStore.getState().addKeepOut('rect');
    });
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-item-expand-all'));
    fireEvent.click(screen.getByTestId('engrave-keepout-expand-all'));
    expect(screen.getByTestId('engrave-label-text-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-keepout-width-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-item-collapse-all'));
    expect(screen.queryByTestId('engrave-label-text-0')).toBeNull();
    expect(screen.getByTestId('engrave-keepout-width-0')).toBeTruthy();
  });

  it('keeps every removal undoable in turn, newest first', () => {
    // The maintainer's decision: "a quick second removal never loses the first one's undo."
    render(<EngravePanel />);
    const before = useEngraveJobStore.getState().job.labels.map((l) => l.id);

    fireEvent.click(screen.getByTestId('engrave-label-remove-0')); // CASE
    expect(screen.getByTestId('engrave-undo-what').textContent).toContain('CASE');
    fireEvent.click(screen.getByTestId('engrave-label-remove-0')); // MAKER, now first
    expect(screen.getByTestId('engrave-undo-what').textContent).toContain('MAKER');
    // Both are still held, oldest first — the strip only ever shows the top.
    expect(useEngraveJobStore.getState().removalUndo.map((r) => r.what)).toHaveLength(2);

    fireEvent.click(screen.getByTestId('engrave-undo'));
    expect(screen.getByTestId('engrave-undo-what').textContent).toContain('CASE');
    fireEvent.click(screen.getByTestId('engrave-undo'));
    // Both back, each at its own index — the list is what it was, not two appended items.
    expect(useEngraveJobStore.getState().job.labels.map((l) => l.id)).toEqual(before);
    expect(screen.queryByTestId('engrave-undo-strip')).toBeNull();
  });

  it('takes a removal back on Ctrl-Z, and only then on the project’s undo', () => {
    // The precedence rule the shortcut in `AppShell` reads (`undoEngraveRemoval`): a pending removal
    // outranks the project's undo, so the key undoes the thing the person just did. An empty stack
    // returns false, which is the shortcut's signal to fall through to `undoProject` — no press is
    // swallowed. This is the seam; that the handler calls it is an e2e (`engrave.spec.ts`).
    render(<EngravePanel />);
    const before = useEngraveJobStore.getState().job.labels.map((l) => l.id);
    expect(undoEngraveRemoval()).toBe(false);

    fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
    expect(undoEngraveRemoval()).toBe(true);
    expect(useEngraveJobStore.getState().job.labels.map((l) => l.id)).toEqual(before);
    expect(undoEngraveRemoval()).toBe(false);
  });

  it('re-arms the 8 s window for each removal, then retires the whole stack', () => {
    vi.useFakeTimers();
    try {
      render(<EngravePanel />);
      fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
      act(() => {
        vi.advanceTimersByTime(REMOVAL_UNDO_MS - 1);
      });
      expect(screen.getByTestId('engrave-undo-strip')).toBeTruthy();

      // The window belongs to the TOP of the stack, not to a moment in the session: a removal made
      // just before the first would have lapsed still gets its own full 8 s, so at 15.998 s — nearly
      // twice the window after the first press — the strip is up. A single fixed deadline would have
      // retired it at 8 s.
      act(() => {
        vi.advanceTimersByTime(REMOVAL_UNDO_MS - 1);
      });
      fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
      act(() => {
        vi.advanceTimersByTime(REMOVAL_UNDO_MS - 1);
      });
      expect(screen.getByTestId('engrave-undo-strip')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      // The whole stack goes, not just the top: what the person can see is one strip, and an undo
      // nothing offers any more would be a lie about what is still possible.
      expect(screen.queryByTestId('engrave-undo-strip')).toBeNull();
      expect(useEngraveJobStore.getState().removalUndo).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the focus to Undo, because the press took the control with it', () => {
    // #411 review: the row and its `✕` are gone after the press, so without this the focus falls to
    // `<body>` and a keyboard user has to hunt along the panel to find the way back.
    render(<EngravePanel />);
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
    expect(document.activeElement).toBe(screen.getByTestId('engrave-undo'));
  });

  it('announces the removal into a live region that was already there and empty', () => {
    // #411 review: a `role="status"` node that ARRIVES with its text is not announced — the region
    // has to be in the document, and empty, before the text is written into it. Hence a region that
    // is always present and never seen, and a visible strip with no live role at all.
    render(<EngravePanel />);
    const live = screen.getByTestId('engrave-undo-announce');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toBe('');

    fireEvent.click(screen.getByTestId('engrave-label-remove-0'));
    expect(screen.getByTestId('engrave-undo-announce').textContent).toContain('CASE');
    // The visible strip carries the words for the eye, not a second announcement for the ear.
    expect(screen.getByTestId('engrave-undo-strip').getAttribute('role')).toBeNull();
  });
});

// #432 slice 4 — the facing choice is a TWO-STATE control whose default is the stock's finish.
// Decision Q6 was "rough or unknown → on; finished sheet or printed blank → off; always
// overridable", and the maintainer's depth decision was that the depth is asked every time facing
// is on, arriving filled in. These cases pin the panel's half of that: what it shows before anyone
// chooses, what a press writes, and that a typed number is left alone.
describe('EngravePanel (#432 slice 4) — the facing choice', () => {
  const job = () => useEngraveJobStore.getState().job;

  /** A job whose stock names a finish — the one input the facing default reads (#413). */
  const withFinish = (finish: 'rough' | 'finished' | 'printed' | 'unknown'): void => {
    act(() => {
      useEngraveJobStore.setState({
        job: {
          ...defaultEngraveJob(),
          stockEntry: { kind: 'made', shelfId: null, file: null, form: 'plate', finish, conductive: false },
        },
      });
    });
  };

  it('offers the finish’s default as advice and does not face a job nobody has chosen for', () => {
    withFinish('rough');
    render(<EngravePanel />);
    // The default is ON for rough stock, and the panel says so — but the job itself carries no
    // `facing` key, so nothing is faced until someone presses.
    expect(screen.getByTestId('engrave-facing-why').textContent).toContain('rough stock is faced first');
    expect(screen.getByTestId('engrave-facing-why').textContent).toContain('Nothing has been chosen');
    expect(screen.getByTestId('engrave-facing-state').textContent).toBe('not chosen');
    expect(screen.getByTestId('engrave-facing-on').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('engrave-facing-depth')).toBeNull();
    expect(job().facing).toBeUndefined();
  });

  it('fills the depth in when facing is turned on, and says where the number came from', () => {
    withFinish('rough');
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-facing-on'));
    expect(job().facing).toEqual({ enabled: true, depth: 0.5 });
    expect((screen.getByTestId('engrave-facing-depth') as HTMLInputElement).value).toBe('0.5');
    expect(screen.getByTestId('engrave-facing-depth-why').textContent).toContain(
      "Rough stock, so the shop's 0.5 mm skim is filled in",
    );
  });

  it('turns it off for a finished face and keeps the sentence that says why', () => {
    withFinish('finished');
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-facing-why').textContent).toContain('a finished face is cut as it is');
    fireEvent.click(screen.getByTestId('engrave-facing-off'));
    expect(job().facing).toEqual({ enabled: false, depth: 0.2 });
    expect(screen.getByTestId('engrave-facing-state').textContent).toBe('facing off');
    expect(screen.queryByTestId('engrave-facing-depth')).toBeNull();
  });

  it('takes a typed depth as the operator’s own number and says it is not the filled-in one', () => {
    withFinish('rough');
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-facing-on'));
    fireEvent.change(screen.getByTestId('engrave-facing-depth'), { target: { value: '0.35' } });
    expect(job().facing?.depth).toBe(0.35);
    expect(screen.getByTestId('engrave-facing-depth-why').textContent).toContain('Your number');
    // Off and back on again keeps what was typed: the toggle is not the depth field's reset.
    fireEvent.click(screen.getByTestId('engrave-facing-off'));
    expect(job().facing).toEqual({ enabled: false, depth: 0.35 });
    fireEvent.click(screen.getByTestId('engrave-facing-on'));
    expect(job().facing).toEqual({ enabled: true, depth: 0.35 });
  });

  it('reads a badge blank as printed even when no shelf entry names a finish', () => {
    act(() => {
      const base = defaultEngraveJob();
      useEngraveJobStore.setState({
        job: {
          ...base,
          stock: { ...base.stock, colour: { kind: 'printed', capMm: 9, layerHeight: 0.2, firstLayerHeight: 0.2 } },
        },
      });
    });
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-facing-why').textContent).toContain('The stock is a printed blank');
    expect(screen.getByTestId('engrave-facing-why').textContent).toContain('cut as printed');
  });

  it('says the finish is not recorded when nothing says it, and still offers the default', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-facing-why').textContent).toContain('finish is not recorded');
    fireEvent.click(screen.getByTestId('engrave-facing-on'));
    expect(job().facing).toEqual({ enabled: true, depth: 0.2 });
  });

  // #474/#493 — the maintainer, 2026-10-17: facing plastic will never work. The material withholds
  // the choice, so neither a rough printed PETG blank nor a purchased acrylic sheet gets the "face
  // it" button, and the sentence names the material and says why.
  it.each([
    ['petg', 'PETG'],
    ['abs', 'ABS'],
    ['acrylic', 'Acrylic'],
  ] as const)('withholds facing on %s, whatever the finish says', (material, label) => {
    act(() => {
      const base = defaultEngraveJob();
      useEngraveJobStore.setState({
        job: {
          ...base,
          stock: { ...base.stock, material },
          stockEntry: { kind: 'made', shelfId: null, file: null, form: 'plate', finish: 'rough', conductive: false },
        },
      });
    });
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-facing-why').textContent).toContain(
      `facing is not offered on ${label}: a flat cutter smears a plastic top`,
    );
    expect(screen.queryByTestId('engrave-facing-on')).toBeNull();
    expect(screen.queryByTestId('engrave-facing-off')).toBeNull();
    expect(screen.queryByTestId('engrave-facing-state')).toBeNull();
    expect(screen.queryByTestId('engrave-facing-depth')).toBeNull();
  });

  it('only offers to turn facing off when a plastic job already carries it', () => {
    act(() => {
      const base = defaultEngraveJob();
      useEngraveJobStore.setState({
        job: { ...base, stock: { ...base.stock, material: 'petg' }, facing: { enabled: true, depth: 0.5 } },
      });
    });
    render(<EngravePanel />);
    expect(screen.queryByTestId('engrave-facing-on')).toBeNull();
    expect(screen.getByTestId('engrave-facing-state').textContent).toBe('facing on');
    expect(screen.queryByTestId('engrave-facing-depth')).toBeNull();
    fireEvent.click(screen.getByTestId('engrave-facing-off'));
    expect(job().facing).toEqual({ enabled: false, depth: 0.5 });
  });
});

// #432 review R11 — a withheld facing file used to be invisible in the panel: Save wrote one file
// fewer than the sheet named and only the printed sheet said why. A facing job now carries a
// Facing row in the Generate list: the cutter the file runs, or `facingError` when there is no
// file. Facing off adds no row at all.
describe('EngravePanel (#432 review R11) — the facing row', () => {
  const FACE_TOOL = '3.175 mm flat (facing)';

  /** A generated run, with the facing half the case wants; the other half is a clean skip. */
  function generated(over: Partial<EngraveGenerated> = {}): EngraveGenerated {
    return {
      ok: true,
      stage: 'done',
      findings: [],
      feeds: null,
      threads: null,
      cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 5, passes: 2 },
      nc: 'G90\nM02',
      verify: {
        ok: true,
        findings: [],
        stats: { lines: 2, cuttingMoves: 1, deepestZ: -2, bbox: { min: [0, 0, -2], max: [1, 1, 0] } },
      },
      frameNc: null,
      frameVerify: null,
      facingNc: ';@MKR|BEGIN\nM02',
      facingVerify: null,
      facingToolKey: 'user:facing-3.175',
      facingError: null,
      facingCam: {
        toolName: FACE_TOOL,
        diameterMm: 3.175,
        passes: 2,
        stepDown: 0.25,
        stepOver: 2.8,
        rpm: 12000,
        feed: 500,
        plungeFeed: 200,
        air: true,
      },
      predicted: [],
      programs: [],
      errors: [],
      ...over,
    };
  }

  function faceJob(facing: { enabled: boolean; depth: number } | undefined): void {
    act(() => {
      // #516 item 5 — the default job no longer seeds a cutter; the sheet/generate paths need one.
      useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-1.0', facing } });
    });
  }

  function show(result: EngraveGenerated): void {
    act(() => {
      useEngraveRunStore.setState({ generated: result, phase: 'ready', simStatus: null });
    });
    render(<EngravePanel />);
  }

  beforeEach(() => {
    useEngraveRunStore.getState().reset();
  });

  it('names the cutter the facing file runs, in the sheet’s words', () => {
    faceJob({ enabled: true, depth: 0.5 });
    show(generated());

    const row = screen.getByTestId('engrave-run-facing');
    expect(row.textContent).toContain(FACE_TOOL);
    expect(row.textContent).toContain('⌀ 3.175 mm flat');
    expect(row.getAttribute('data-state')).toBe('tick');
  });

  it('shows the withheld reason when no facing file was produced', () => {
    faceJob({ enabled: true, depth: 0.5 });
    const error = 'the tool list has no flat end mill the catalogue recommends for PLA';
    show(generated({ facingNc: null, facingVerify: null, facingToolKey: null, facingCam: null, facingError: error }));

    const row = screen.getByTestId('engrave-run-facing');
    // The sheet's vocabulary, so the screen and the printed page say the same thing.
    expect(row.textContent).toContain('the facing program was not produced');
    expect(row.textContent).toContain(error);
    expect(row.textContent).toContain('the top will not be skimmed');
    expect(row.getAttribute('data-state')).toBe('cross');
  });

  it('adds no row when the job does not face', () => {
    faceJob(undefined);
    show(generated());
    expect(screen.queryByTestId('engrave-run-facing')).toBeNull();
  });

  it('adds no row when facing is turned off or its depth is zero', () => {
    faceJob({ enabled: false, depth: 0.5 });
    show(generated());
    expect(screen.queryByTestId('engrave-run-facing')).toBeNull();
    cleanup();
    faceJob({ enabled: true, depth: 0 });
    show(generated());
    expect(screen.queryByTestId('engrave-run-facing')).toBeNull();
  });
});

// #469 / #419 §3 — which machine surface the panel offers. A job whose generated result has more
// than one program is the release step's (it uploads the whole list and plays it in order); a
// one-program job keeps the single-file upload. The capability is mocked desktop above, and the
// machine is seeded so the release step has a target to plan against.
describe('EngravePanel — the release step routing (#469)', () => {
  const TARGET = { host: '192.0.2.10', port: 2222 };
  const VERIFY = {
    ok: true,
    findings: [],
    stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] } },
  };

  function program(index: number, toolKey: string): EngraveProgram {
    const nc = `G0 X${index} Y0\nM02\n`;
    return {
      setupIndex: index,
      setupId: `setup-${index}`,
      toolKey,
      nc,
      verify: VERIFY,
      frameNc: null,
      frameVerify: null,
      programHash: `hash-${index}`,
      cam: null,
    };
  }

  function generated(programs: EngraveProgram[], over: Partial<EngraveGenerated> = {}): EngraveGenerated {
    return {
      ok: true,
      stage: 'done',
      findings: [],
      feeds: null,
      threads: null,
      cam: null,
      nc: programs[0]?.nc ?? null,
      verify: programs[0]?.verify ?? null,
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
      ...over,
    };
  }

  function show(result: EngraveGenerated): void {
    act(() => {
      useMachineStore.setState({
        machine: {
          name: 'Z1',
          host: TARGET.host,
          port: TARGET.port,
          busy: false,
          ip: null,
          mac: null,
          status: '<Idle|MPos:0,0,0>',
          profileId: 'Z1',
          observedAt: '2026-10-17T00:00:00.000Z',
          notes: [],
        },
      });
      useEngraveRunStore.setState({
        generated: result,
        oracle: { ok: true, band: 0, levels: [], worst: { underCut: 0, overCut: 0 } },
        simDiagnostics: [],
        simStatus: 'ready',
        phase: 'ready',
        acknowledged: false,
        staleSince: null,
        error: null,
      });
    });
    render(<EngravePanel />);
    // #419 §3 — the run controls live under Cut, over the package the green gate freezes.
    fireEvent.click(screen.getByTestId('cnc-mode-cut'));
  }

  beforeEach(() => {
    caps.canDriveMachine = true;
    resetCncMode();
    resetEngravePackageStore();
  });

  afterEach(() => {
    caps.canDriveMachine = false;
    useEngraveRunStore.getState().reset();
    useMachineStore.setState({ machine: null });
    resetEngraveReleaseStore();
    resetEngravePackageStore();
    resetCncMode();
  });

  it('routes a multi-program job to the release step, not the single-file upload', async () => {
    show(generated([program(1, 'flat-1.0'), program(2, 'flat-3.175x12-metal')]));

    expect(await screen.findByTestId('engrave-release')).toBeTruthy();
    // The one-file upload is not offered beside it: there would be two run panels and one of them
    // would play half the job with the vacuum left on.
    expect(screen.queryByTestId('engrave-upload-panel')).toBeNull();
    expect(screen.getByTestId('engrave-release-upload').textContent).toContain('Upload all 2 programs');
  });

  it('keeps the single-file upload for a one-program job', async () => {
    show(generated([program(1, 'flat-1.0')]));

    expect(await screen.findByTestId('engrave-upload-panel')).toBeTruthy();
    expect(screen.queryByTestId('engrave-release')).toBeNull();
  });

  it('shows the release blocker, and no run controls, when the release step may not own the job', async () => {
    // A faced job: the face file is not in `programs`, so the release step refuses by name.
    show(generated([program(1, 'flat-1.0'), program(2, 'flat-3.175x12-metal')], { facingNc: 'M02\n' }));

    const blocked = await screen.findByTestId('engrave-release-blocked');
    expect(blocked.textContent).toContain('faces the stock first');
    expect(screen.queryByTestId('engrave-release-upload')).toBeNull();
    expect(screen.queryByTestId('engrave-release-start')).toBeNull();
  });
});

// #221 — a V-bit on a REGION job is the cutter, not an exclusion. The panel has to state the
// strategy the engine models: the typed depth is the pocket floor, the design is correct at the
// colour plane, and the pass pitch is the requested one beside the effective one. Every number
// below is asserted against the engine's own answer, not a literal copied out of the render.
describe('EngravePanel — the V-carve strategy (#221)', () => {
  const V_TOOL = flatEndMill(0.3, {
    name: '30° engraving bit',
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: 0.3,
    diameter: 3.175,
    halfAngle: 15,
    angle: 30,
  });
  const FILM = 1.2;

  /** The panel's own rounding (`mm3`), so the assertion is about the number, not the spelling. */
  const mm3 = (v: number): string => String(Math.round(v * 1000) / 1000);

  /** Two fixed-id regions on a PLA blank (the V row exists only for PLA and PETG). */
  function vJob() {
    const job = defaultEngraveJob();
    job.stock = { ...job.stock, material: 'pla' };
    job.toolKey = 'inv:v30';
    job.labels = [
      { ...job.labels[0]!, id: 'title', text: 'TITLE', depth: 2.0 },
      { ...job.labels[1]!, id: 'sub', text: 'SUB', depth: 0.5 },
    ];
    return job;
  }

  /** The preview the panel reads its film from; the rest of the preview is outside this spec. */
  function previewWith(colourBoundaryDepth: number | null, recommendation: ToolRecommendation | null = null): EngravePreview {
    return { colourBoundaryDepth, recommendation, findings: [] } as unknown as EngravePreview;
  }

  function show(job = vJob(), preview: EngravePreview | null = previewWith(FILM)): void {
    setInventoryEntries([{ key: 'inv:v30', tool: V_TOOL, provenance: 'EngravePanel V-carve spec' }]);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({ preview, status: preview === null ? 'idle' : 'ready' });
    render(<EngravePanel />);
  }

  // The describe-level hook runs BEFORE the file-level `cleanup()`, so the registry notification
  // still reaches a mounted panel and has to be wrapped like any other state update.
  afterEach(() => {
    act(() => resetRegistry());
  });

  it('states the floor/colour-plane depth note and no longer calls the V-bit a stroke-width limit', () => {
    show();
    const note = screen.getByTestId('engrave-vcarve-depth-note').textContent ?? '';
    expect(note).toContain('V-carve.');
    expect(note).toContain('the pocket floor');
    expect(note).toContain('colour plane');
    expect(note).toContain(`${mm3(FILM)} mm below the top`);
    expect(note).toContain('0.3 mm wide');
    expect(note).toContain('15.0° from the axis');
    // A V-bit has no flat stroke-width to state: the old hint is suppressed on a V-carve.
    expect(screen.queryByTestId('engrave-thin-strokes')).toBeNull();
  });

  it('prints the plane geometry and the effective pitch beside the requested one, from the engine', () => {
    show();
    const cone = vCone(V_TOOL)!;
    const title = vJob().labels[0]!;
    const plane = vCarvePlane(cone, title.depth, FILM);
    const stepover = vCarveStepover(plane.planeRadius, cone, 0.6);
    // The default seed asks for 0.6 of the groove at the plane; for this cone that is wider than
    // the tip radius, so the panel must show BOTH numbers and the clamp note.
    expect(stepover.clamped).toBe(true);
    expect(stepover.requested).toBeGreaterThan(stepover.effective);

    const text = screen.getByTestId('engrave-vcarve-item-title').textContent ?? '';
    expect(text).toContain(`${mm3(plane.grooveWidth)} mm groove at the plane`);
    expect(text).toContain(`floor ${mm3(plane.floorInset)} mm narrower per side`);
    expect(text).toContain(`top opening ${mm3(plane.surfaceOutset)} mm wider per side`);
    expect(text).toContain(
      `pass pitch ${mm3(stepover.effective)} mm beside the requested ${mm3(stepover.requested)} mm`,
    );

    // The warning is the FINDING's sentence, not a paraphrase: same engine function, same words.
    expect(screen.getByTestId('engrave-vcarve-clamp-title').textContent).toBe(
      vCarveStepoverClampNote(itemName(title), stepover, cone.tipRadius),
    );
  });

  it('says the plane is the floor when the blank states no film', () => {
    const job = vJob();
    show(job, null); // no print on this blank, and no preview to resolve one from
    expect(screen.getByTestId('engrave-vcarve-depth-note').textContent).toContain(
      'this blank states no film, so the plane is the floor',
    );
    // With no film the plane IS the floor, so the note still carries per-item arithmetic.
    expect(screen.getByTestId('engrave-vcarve-item-title')).toBeTruthy();
  });

  it('waits for the print to resolve rather than showing no-film arithmetic as a placeholder', () => {
    const job = vJob();
    job.stock = {
      ...job.stock,
      colour: { kind: 'printed', capMm: job.stock.thickness - 1.2, layerHeight: 0.2 },
    };
    show(job, null); // the preview that resolves the film has not landed yet
    expect(screen.getByTestId('engrave-vcarve-depth-note').textContent).toContain(
      'resolving it from the print',
    );
    expect(screen.queryByTestId('engrave-vcarve-item-title')).toBeNull();
    expect(screen.queryByTestId('engrave-vcarve-clamp-title')).toBeNull();
  });

  it('names a V-bit pick a V-bit, and gives its Why? row the V-carve sentence', () => {
    const rec: ToolRecommendation = {
      key: 'inv:v30',
      compromise: false,
      reason: `${V_BIT_CARVE_SENTENCE}.`,
      conditionNote: null,
      catalogueNote: null,
      selectedNote: null,
      candidates: [
        {
          key: 'inv:v30',
          diameter: 0.3,
          qualifies: true,
          worst: null,
          reachKnown: false,
          reachOk: true,
          condition: null,
          vCarve: true,
        },
        {
          key: 'flat-1.0',
          diameter: 1.0,
          qualifies: true,
          worst: { labelId: 'title', ratio: 0.4, emptyChars: 0 },
          reachKnown: true,
          reachOk: true,
          condition: null,
        },
      ],
    };
    show(vJob(), previewWith(FILM, rec));

    expect(screen.getByTestId('engrave-tool-recommended-tag').textContent).toContain('recommended: 0.3 mm');
    const box = screen.getByTestId('engrave-recommendation').textContent ?? '';
    expect(box).toContain('Recommended: 0.3 mm V-bit');
    expect(box).toContain(V_BIT_CARVE_SENTENCE);

    // The disclosure names the cone as a V-bit and gives it the strategy sentence, while a flat
    // candidate keeps the flat name and its own measured row.
    const vRow = screen.getByTestId('engrave-candidate-inv:v30').textContent ?? '';
    expect(vRow).toContain('0.3 mm V-bit');
    expect(vRow).toContain(V_BIT_CARVE_SENTENCE);
    const flatRow = screen.getByTestId('engrave-candidate-flat-1.0').textContent ?? '';
    expect(flatRow).toContain('1.0 mm flat end');
    expect(flatRow).toContain('40 % kept');
  });
});

// #435 — the primitive rows, the Add menu entries and the optional target object.
describe('EngravePanel — 3D primitives and the target object (#435)', () => {
  function setJob(mutate: (job: EngraveJob) => EngraveJob): void {
    act(() => {
      useEngraveJobStore.setState({ job: mutate(defaultEngraveJob()) });
    });
  }

  it('adds each primitive kind from the menu and counts it as an item', () => {
    render(<EngravePanel />);
    const before = Number(screen.getByTestId('engrave-item-count').textContent);
    fireEvent.click(screen.getByTestId('engrave-add-primitive-box'));
    fireEvent.click(screen.getByTestId('engrave-add-primitive-cylinder'));
    fireEvent.click(screen.getByTestId('engrave-add-primitive-cone'));
    fireEvent.click(screen.getByTestId('engrave-add-primitive-sphere'));

    expect(screen.getByTestId('engrave-primitive-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-primitive-row-3')).toBeTruthy();
    expect(Number(screen.getByTestId('engrave-item-count').textContent)).toBe(before + 4);
    expect(useEngraveJobStore.getState().job.primitives?.map((p) => p.kind)).toEqual([
      'box',
      'cylinder',
      'cone',
      'sphere',
    ]);
  });

  it('edits a box through its row and puts it in the plan as a region', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-primitive-box'));
    // The add opens the row (#411), so its editor is already showing.
    fireEvent.change(screen.getByTestId('engrave-primitive-width-0'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('engrave-primitive-depth-0'), { target: { value: '1.5' } });

    const primitive = useEngraveJobStore.getState().job.primitives?.[0];
    expect(primitive?.kind).toBe('box');
    if (primitive?.kind !== 'box') return;
    expect(primitive.width).toBe(30);
    expect(primitive.depth).toBe(1.5);
    expect(screen.getByTestId('engrave-primitive-row-0').textContent).toContain('1.5 mm');
  });

  it('shows the by-name refusal on a cone row instead of approximating it', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-primitive-cone'));
    expect(screen.getByTestId('engrave-primitive-finding-0-primitive-cone-needs-cam')).toBeTruthy();
    expect(screen.getByTestId('engrave-primitive-warn-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-primitive-cut-0').textContent).toContain('refuses it by name');
  });

  it('will not commit a sphere cap deeper than its diameter', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-primitive-sphere'));
    const before = useEngraveJobStore.getState().job.primitives?.[0]?.depth;
    fireEvent.change(screen.getByTestId('engrave-primitive-depth-0'), { target: { value: '50' } });
    expect(useEngraveJobStore.getState().job.primitives?.[0]?.depth).toBe(before);
  });

  it('shows the target object section, places the object and removes it with undo', () => {
    const targetObject: EngraveTargetObject = {
      id: 'tgt-1',
      name: 'bracket.stl',
      format: 'stl',
      sha256: 'a'.repeat(64),
      data: 'AAAA',
      size: { x: 10, y: 8, z: 4 },
      position: { x: 50, y: 30, z: 0 },
      rotation: 0,
      enabled: true,
    };
    setJob((job) => ({ ...job, targetObject }));
    render(<EngravePanel />);

    expect(screen.getByTestId('engrave-target-count').textContent).toBe('1');
    expect(screen.getByTestId('engrave-target-row-0').textContent).toContain('bracket.stl');
    expect(screen.getByTestId('engrave-target-row-0').textContent).toContain('10×8×4 mm');

    expand('engrave-target');
    fireEvent.change(screen.getByTestId('engrave-target-x-0'), { target: { value: '12' } });
    expect(useEngraveJobStore.getState().job.targetObject?.position.x).toBe(12);

    fireEvent.click(screen.getByTestId('engrave-target-remove-0'));
    expect(useEngraveJobStore.getState().job.targetObject).toBeUndefined();
    expect(screen.getByTestId('engrave-undo-strip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('engrave-undo'));
    expect(useEngraveJobStore.getState().job.targetObject?.id).toBe('tgt-1');
  });

  it('offers the hidden file input for a target object, and explains the no-cut warning', () => {
    const targetObject: EngraveTargetObject = {
      id: 'tgt-1',
      name: 'bracket.stl',
      format: 'stl',
      sha256: 'a'.repeat(64),
      data: 'AAAA',
      size: { x: 10, y: 8, z: 4 },
      position: { x: 50, y: 30, z: 0 },
      rotation: 0,
      enabled: true,
    };
    setJob((job) => ({ ...job, targetObject }));
    render(<EngravePanel />);

    const input = screen.getByTestId('engrave-target-input') as HTMLInputElement;
    expect(input.accept).toContain('.stl');
    expect(input.accept).toContain('.3mf');
    expand('engrave-target');
    expect(screen.getByTestId('engrave-target-finding-0-target-object-not-cut')).toBeTruthy();
  });
});

// #673 — THE INLAY HALF: the glue gap, the derived plug numbers, and the male blank's own job.
describe('EngravePanel — inlay (#673)', () => {
  const V_TOOL = flatEndMill(3.175, {
    name: '3.175 mm 90° V',
    typeText: 'Chamfer',
    shape: 'chamfer',
    tipDiameter: null,
    diameter: 3.175,
    angle: 90,
    halfAngle: null,
  });

  const INLAY: EngraveShape = {
    id: 'plate',
    name: 'plate',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 2,
    enabled: true,
    width: 20,
    height: 10,
    cornerRadius: 0,
    inlay: { role: 'female' },
  };

  function showJob(): void {
    act(() =>
      useEngraveJobStore.setState({
        job: {
          ...defaultEngraveJob(),
          labels: [],
          traces: [],
          toolKey: 'inv:v-673',
          tool: V_TOOL,
          shapes: [INLAY],
        },
      }),
    );
    render(<EngravePanel />);
    expand('engrave-shape');
  }

  it('states the derived plug numbers and writes the glue gap onto the marker', () => {
    showJob();
    const note = screen.getByTestId('engrave-shape-inlay-note-0').textContent ?? '';
    expect(note).toContain('Pocket 2 mm · plug 1.8 mm');
    expect(note).toContain('0.2 mm inside the design');
    fireEvent.change(screen.getByTestId('engrave-shape-inlay-gap-0'), { target: { value: '0.3' } });
    expect(useEngraveJobStore.getState().job.shapes[0]!.inlay).toEqual({ role: 'female', glueGapMm: 0.3 });
  });

  it('saves the male blank as its own job file', async () => {
    const save = vi.fn(async (_text: string, _name: string) => ({ kind: 'downloaded' as const }));
    setJobFileIO({ save, write: vi.fn(), open: vi.fn() });
    try {
      showJob();
      await act(async () => {
        fireEvent.click(screen.getByTestId('engrave-shape-inlay-male-0'));
      });
      expect(save).toHaveBeenCalledTimes(1);
      const [text, name] = save.mock.calls[0]! as unknown as [string, string];
      expect(name).toMatch(/male\.cutjob\.json$/);
      const parsed = parseEngraveJob(JSON.parse(text) as unknown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.job.name).toContain('— male');
      expect(parsed.job.combined?.[0]?.inlay?.role).toBe('male');
    } finally {
      setJobFileIO(null);
    }
  });
});

// #670 — THE TEXTURE: the pattern's numbers, the strokes they derive, and the marker they write.
describe('EngravePanel — texture (#670)', () => {
  const TEXTURE: EngraveShape = {
    id: 'panel',
    name: 'grip',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 0.8,
    enabled: true,
    width: 10,
    height: 6,
    cornerRadius: 0,
    texture: { pattern: 'stipple', pitchMm: 2, strokeMm: 1, seed: 3 },
  };

  function showTextureJob(): void {
    act(() =>
      useEngraveJobStore.setState({
        job: { ...defaultEngraveJob(), labels: [], traces: [], shapes: [TEXTURE] },
      }),
    );
    render(<EngravePanel />);
    expand('engrave-shape');
  }

  const marker = () => useEngraveJobStore.getState().job.shapes[0]!.texture;

  it('chips the region as a Texture and states the strokes the pattern derives', () => {
    showTextureJob();
    expect(screen.getByTestId('engrave-shape-type-0').textContent).toBe('Texture');
    expect(screen.getByText('Texture stipple')).toBeTruthy();
    const note = screen.getByTestId('engrave-shape-texture-note-0').textContent ?? '';
    // The numbers the CAM will run, from the same module the plan calls — not the marker's raw
    // fields.
    expect(note).toMatch(/\d+ strokes? at a 2 mm pitch/);
    expect(note).toContain('1 mm stroke');
    expect(note).toContain('seed 3');
    expect(note).toContain('0.8 mm deep');
  });

  it('writes the pattern, the pitch and the seed onto the marker', () => {
    showTextureJob();
    fireEvent.change(screen.getByTestId('engrave-shape-texture-pattern-0'), { target: { value: 'scallop' } });
    expect(marker()).toMatchObject({ pattern: 'scallop', pitchMm: 2 });
    // A scallop has no stroke length and no seed: the fields are not offered.
    expect(screen.queryByTestId('engrave-shape-texture-seed-0')).toBeNull();
    fireEvent.change(screen.getByTestId('engrave-shape-texture-pitch-0'), { target: { value: '2.5' } });
    expect(marker()).toMatchObject({ pattern: 'scallop', pitchMm: 2.5 });
    fireEvent.change(screen.getByTestId('engrave-shape-texture-pattern-0'), { target: { value: 'stipple' } });
    fireEvent.change(screen.getByTestId('engrave-shape-texture-seed-0'), { target: { value: '8' } });
    expect(marker()).toMatchObject({ pattern: 'stipple', seed: 8, pitchMm: 2.5 });
  });

  it('adds a stipple rect from the picker, with its row open', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-texture'));
    const shapes = useEngraveJobStore.getState().job.shapes;
    const added = shapes[shapes.length - 1]!;
    expect(added.texture).toEqual({ pattern: 'stipple' });
    // The row arrived open (#411), so its editor is on screen; its note counts the strokes at the
    // CAM's own defaults.
    const note = screen.getByTestId(`engrave-shape-texture-note-${shapes.length - 1}`).textContent ?? '';
    expect(note).toContain('1 mm pitch');
    expect(note).toContain('seed 1');
  });
});

// #674 — FLUTES and PRISMS: the markers on their rows, the numbers they derive, and the controls
// each one hides (a prism is one plane region cut from its middle outward, not a ladder or a pair).
describe('EngravePanel — flute and prism (#674)', () => {
  const V_TIP = flatEndMill(3.175, {
    name: '3.175 mm 90° V (0.2 tip)',
    typeText: 'Chamfer',
    shape: 'chamfer',
    tipDiameter: 0.2,
    diameter: 3.175,
    angle: 90,
    halfAngle: null,
  });

  const FLUTE: EngraveTraceItem = {
    id: 'grip',
    name: 'grip',
    kind: 'line',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 2,
    enabled: true,
    points: [
      [-10, 0],
      [10, 0],
    ],
    closed: false,
    flute: {},
  };

  const PRISM: EngraveShape = {
    id: 'plate',
    name: 'plate',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 2,
    enabled: true,
    width: 20,
    height: 10,
    cornerRadius: 0,
    prism: {},
  };

  function show(job: Partial<EngraveJob>): void {
    act(() =>
      useEngraveJobStore.setState({
        job: { ...defaultEngraveJob(), labels: [], traces: [], shapes: [], toolKey: 'inv:v-674', tool: V_TIP, ...job },
      }),
    );
    render(<EngravePanel />);
  }

  it('chips a fluted line as a Flute, states its ramp, and writes it back', () => {
    show({ traces: [FLUTE] });
    expand('engrave-trace');
    expect(screen.getByTestId('engrave-trace-type-0').textContent).toBe('Flute');
    const note = screen.getByTestId('engrave-trace-flute-note-0').textContent ?? '';
    // 3 × the 2 mm depth: a 6 mm ramp at each end, and the middle at full depth.
    expect(note).toContain('6 mm at each end');
    expect(note).toContain('three times the depth');
    expect(note).toContain('2 mm deep');

    fireEvent.change(screen.getByTestId('engrave-trace-flute-ramp-0'), { target: { value: '1.5' } });
    const trace = useEngraveJobStore.getState().job.traces![0]!;
    expect(trace.kind === 'line' ? trace.flute : null).toEqual({ rampMm: 1.5 });
    // The note reads the typed ramp and its source.
    expect(screen.getByTestId('engrave-trace-flute-note-0').textContent).toContain('typed');

    // Unchecking the flute clears the marker; the line stays a plain trace.
    fireEvent.click(screen.getByTestId('engrave-trace-flute-0'));
    const after = useEngraveJobStore.getState().job.traces![0]!;
    expect(after.kind === 'line' ? after.flute : null).toBeUndefined();
    expect(screen.getByTestId('engrave-trace-type-0').textContent).toBe('Engrave');
  });

  it('adds a flute and a prism from the picker', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-flute'));
    const trace = useEngraveJobStore.getState().job.traces![0]!;
    expect(trace.kind).toBe('line');
    expect(trace.kind === 'line' ? trace.flute : null).toEqual({});

    fireEvent.click(screen.getByTestId('engrave-add-prism'));
    const shape = useEngraveJobStore.getState().job.shapes[0]!;
    expect(shape.prism).toEqual({});
    expect(screen.getByTestId('engrave-shape-type-0').textContent).toBe('Prism');
  });

  it('chips a prism as a Prism, states its derived numbers, and hides the V-carve and rest controls', () => {
    show({ shapes: [PRISM] });
    expand('engrave-shape');
    expect(screen.getByTestId('engrave-shape-type-0').textContent).toBe('Prism');
    expect(screen.getByText('Prism rect "plate" 20×10')).toBeTruthy();
    const note = screen.getByTestId('engrave-shape-prism-note-0').textContent ?? '';
    expect(note).toContain('stands 2 mm');
    expect(note).toContain('1 mm flat base');
    expect(note).toContain('the CAM’s default');
    expect(note).toContain('5 mm out');
    // A prism is one plane region: no medial-axis ladder, no rest pair.
    expect(screen.queryByTestId('engrave-shape-vcarve-depth-0')).toBeNull();

    fireEvent.change(screen.getByTestId('engrave-shape-prism-base-0'), { target: { value: '3' } });
    expect(useEngraveJobStore.getState().job.shapes[0]!.prism).toEqual({ baseMm: 3 });
  });

  it('turns a plain pocket into a prism and back from the row', () => {
    const plain: EngraveShape = { ...PRISM, prism: undefined };
    show({ shapes: [plain] });
    expand('engrave-shape');
    // The job's cutter is a V, so a plain rect is a V-carve until the prism marker replaces it.
    expect(screen.getByTestId('engrave-shape-type-0').textContent).toBe('V-carve');
    expect(screen.queryByTestId('engrave-shape-prism-note-0')).toBeNull();

    fireEvent.click(screen.getByTestId('engrave-shape-prism-0'));
    expect(useEngraveJobStore.getState().job.shapes[0]!.prism).toEqual({});
    expect(screen.getByTestId('engrave-shape-type-0').textContent).toBe('Prism');

    fireEvent.click(screen.getByTestId('engrave-shape-prism-0'));
    expect(useEngraveJobStore.getState().job.shapes[0]!.prism).toBeUndefined();
    expect(screen.getByTestId('engrave-shape-type-0').textContent).toBe('V-carve');
  });
});

// #675 — THE PECK: the setting's number in the Technical fold with its provenance, the job's own
// over it, a reset back to the source, and no peck at all on a bore (a bore is helixed).
describe('EngravePanel — per-hole peck (#675)', () => {
  const DRILL_BIT = flatEndMill(3, {
    name: '3 mm drill',
    typeText: 'Drill',
    shape: 'drill',
    tipDiameter: 3,
    diameter: 3,
    cornerRadius: null,
    angle: null,
    centreCutting: null,
  });

  const HOLE: EngraveDrill = {
    id: 'port',
    name: 'port',
    kind: 'drill',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 4,
    enabled: true,
    through: false,
  };

  function show(job: Partial<EngraveJob>): void {
    act(() =>
      useEngraveJobStore.setState({
        job: { ...defaultEngraveJob(), labels: [], traces: [], shapes: [], toolKey: 'inv:drill-3', tool: DRILL_BIT, ...job },
      }),
    );
    render(<EngravePanel />);
    expand('engrave-drill');
  }

  it('prefills the peck from the bit’s own source, with its provenance', () => {
    show({ drills: [HOLE] });
    const field = screen.getByTestId('engrave-drill-peck-0') as HTMLInputElement;
    // No location in this test, so `drill.peckDiameters` is its fallback (1) × the ⌀3 bit.
    expect(field.value).toBe('3');
    const source = screen.getByTestId('engrave-drill-peck-source-0').textContent ?? '';
    expect(source).toContain('drill.peckDiameters');
    expect(source).toContain('⌀3');
    expect(screen.queryByTestId('engrave-drill-peck-reset-0')).toBeNull();
  });

  it('writes the job’s own peck, says it is typed, and resets to the source', () => {
    show({ drills: [HOLE] });
    fireEvent.change(screen.getByTestId('engrave-drill-peck-0'), { target: { value: '1.5' } });
    expect(useEngraveJobStore.getState().job.drills![0]!.peckMm).toBe(1.5);
    expect(screen.getByTestId('engrave-drill-peck-source-0').textContent).toBe('typed in this job');
    // Out of the schema's bounds is not committed: the job must stay loadable.
    fireEvent.change(screen.getByTestId('engrave-drill-peck-0'), { target: { value: '0' } });
    expect(useEngraveJobStore.getState().job.drills![0]!.peckMm).toBe(1.5);

    fireEvent.click(screen.getByTestId('engrave-drill-peck-reset-0'));
    expect(useEngraveJobStore.getState().job.drills![0]!.peckMm).toBeUndefined();
    expect(screen.getByTestId('engrave-drill-peck-source-0').textContent).toContain('drill.peckDiameters');
  });

  it('offers no peck on a bore, which is helixed', () => {
    show({ drills: [{ ...HOLE, mode: 'bore', diameter: 10 }] });
    expect(screen.queryByTestId('engrave-drill-technical-0')).toBeNull();
    expect(screen.queryByTestId('engrave-drill-peck-0')).toBeNull();
  });
});
