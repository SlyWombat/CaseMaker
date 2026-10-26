// @vitest-environment jsdom
// The guided job setup (#254) and the cutting overrides' provenance (#246). The pure half —
// the answers, the #231 fix and the one tagged document write — is asserted without React; the
// panel + flow are driven through jsdom like `engravePanel.spec.tsx`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { StartWizard } from '@/components/welcome/StartWizard';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

// #516 item 5 — the default job no longer seeds a cutter; the recommendation names `flat-1.0`.
// These engine tests need the job to name its cutter, so `dj()` applies that recommendation.
function dj(...args: Parameters<typeof defaultEngraveJob>): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob(...args);
  job.toolKey = 'flat-1.0';
  return job;
}
import {
  applyAnswers,
  applyHoldAnswers,
  blankViseFindings,
  defaultSetupAnswers,
  materialOptionsFor,
  stepFindings,
  stockProudFix,
} from '@/engine/cnc/engrave/setupFlow';
import { Z1 } from '@/engine/cnc/machine';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { presetJawStrips } from '@/engine/cnc/sacrificial';
import { jobItemCount } from '@/engine/cnc/stockStart';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { validateVise } from '@/engine/cnc/fixture';

vi.mock('@/engine/exportTrigger', () => ({ saveText: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetStartWizard();
  act(() => {
    useEngraveJobStore.setState({ job: dj() });
  });
  useEngraveRunStore.getState().reset();
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
});

describe('guided job setup — the pure answers (#254)', () => {
  it('every value applyAnswers writes carries a source, and measured is never demoted', () => {
    const job = dj();
    // Pretend thickness was a caliper reading.
    job.sources = { stock: { thickness: 'measured' } };

    const answers = defaultSetupAnswers(job);
    expect(answers.sources.stock.thickness).toBe('measured'); // carried, not demoted
    expect(answers.sources.stock.length).toBe('user'); // a shipped default, asserted now

    const applied = applyAnswers(job, answers);
    // No value the flow wrote is untagged: all four stock fields have a source.
    expect(applied.sources!.stock).toEqual({
      length: 'user',
      width: 'user',
      thickness: 'measured',
      material: 'user',
    });
    // The vise and sacrificial carry their own `source`, so they are tagged too.
    expect(applied.workholding.vise.source).toBeTruthy();
    expect(applied.sacrificial.source).toBeTruthy();
  });

  it('catches the #231 case — a 3.81 mm blank in the shipped 4 mm-proud vise', () => {
    const job = dj(); // 12 mm stock, stockProud 4
    const answers = defaultSetupAnswers(job);
    answers.stock = { ...answers.stock, thickness: 3.81 };

    const findings = blankViseFindings(answers);
    const error = findings.find((f) => f.code === 'vise-stock-proud-exceeds-thickness');
    expect(error).toBeTruthy();
    expect(error!.severity).toBe('error');
    // …and the flow reaches it through `validateJob` on the would-be document too.
    expect(stepFindings('blank', job, answers).some((f) => f.code === 'vise-stock-proud-exceeds-thickness')).toBe(true);

    // The fix is the blank's own seating on the jaws' ledges (#208/#391 review item 1), asserted as
    // the user's setup: 3.81 − 3.1 mm of ledge step.
    const fix = stockProudFix(answers);
    expect(fix).not.toBeNull();
    expect(fix!.stockProud).toBeCloseTo(0.71, 6);
    expect(fix!.source).toBe('saved');

    // Applying it resolves the refusal.
    const fixed = { ...answers, vise: fix! };
    expect(blankViseFindings(fixed).some((f) => f.code === 'vise-stock-proud-exceeds-thickness')).toBe(false);
    expect(stockProudFix(fixed)).toBeNull();
  });

  it('offers the seated stock-proud on a blank no taller than the ledge step (#406, #488)', () => {
    const job = dj(); // stockProud 4
    const answers = defaultSetupAnswers(job);
    answers.stock = { ...answers.stock, thickness: 3 };
    // The proud-exceeds-thickness refusal is real…
    expect(blankViseFindings(answers).some((f) => f.code === 'vise-stock-proud-exceeds-thickness')).toBe(true);
    // …and the derived value (3 − 3.1 = −0.1) is a valid state since #488: a blank below the jaw
    // tops gets a note when its cuts keep the jaw clearance, so the button offers it.
    const fix = stockProudFix(answers);
    expect(fix?.stockProud).toBeCloseTo(-0.1, 9);
    expect(fix?.source).toBe('saved');
  });

  it('shows `vise-default` once on the blank step, not once per validator (#353)', () => {
    const job = dj();
    const answers = defaultSetupAnswers(job);

    // Both passes used to answer it, and the step printed both copies. Now the vise validator
    // owns the finding…
    expect(validateVise(answers.stock, answers.vise, answers.sacrificial).some((f) => f.code === 'vise-default')).toBe(true);
    // …and the job validator does not repeat it…
    expect(validateJob(applyAnswers(job, answers)).some((f) => f.code === 'vise-default')).toBe(false);
    // …so the blank step — which merges both and de-duplicates as a net — says it exactly once.
    expect(stepFindings('blank', job, answers).filter((f) => f.code === 'vise-default')).toHaveLength(1);
  });

  it('carries a custom sacrificial setup through untouched until the choice changes', () => {
    const job = dj();
    const answers = defaultSetupAnswers(job);
    // A job that already has strips: the seeded answers keep them.
    answers.sacrificial = presetJawStrips();
    expect(applyAnswers(job, answers).sacrificial).toEqual(presetJawStrips());
  });
});

describe('#684 review — step 3 writes only the holding answers', () => {
  it('leaves the stock and a stock source the answers cannot carry untouched', () => {
    const base = dj();
    const job = {
      ...base,
      stock: {
        ...base.stock,
        material: 'plastic' as const,
        colour: { kind: 'laminate' as const, capMm: 0.075 },
      },
      sources: { ...(base.sources ?? {}), stock: { length: 'user' as const, colour: 'assumed' as const } },
    };
    const answers = defaultSetupAnswers(job);
    const vise = { ...answers.vise, stockProud: 0.2 };
    const after = applyHoldAnswers(job, { ...answers, vise });

    // The stock and its provenance are step 2's: a laminate's assumed cap has no answer field, so
    // a whole-setup write replaced the map and lost the fact that the cap was an assumption.
    expect(after.stock).toEqual(job.stock);
    expect(after.sources?.stock?.colour).toBe('assumed');
    expect(after.sources?.stock?.length).toBe('user');
    // The holding answers do land, each stamped by its own object.
    expect(after.workholding.vise).toEqual(vise);
    expect(after.sacrificial).toEqual(answers.sacrificial);
  });
});

describe('round stock — the cut face is a circle, not its box (#683)', () => {
  /** One small label on 50 mm round stock, its centre at (x, y). */
  function roundJob(x: number, y: number, form: 'disc' | 'rod' | 'plate' = 'disc') {
    const job = dj();
    job.stock = { length: 50, width: 50, thickness: 5, material: 'softwood' };
    job.stockEntry = { kind: 'made', shelfId: null, file: null, form, finish: 'rough', conductive: false };
    job.labels = [{ ...job.labels[0]!, text: 'X', size: 2, position: { x, y }, depth: 1 }];
    return job;
  }

  it('refuses a label that reaches a box corner, naming the item and the circle', () => {
    const job = roundJob(3, 3);
    const off = validateJob(job).find((f) => f.code === 'item-off-round-stock');
    expect(off).toBeDefined();
    expect(off!.severity).toBe('error');
    // #688: the finding points at the item, so the panel draws its Fix beside that item.
    expect(off!.labelId).toBe(job.labels[0]!.id);
    expect(off!.message).toContain('⌀50 mm');
    expect(off!.message).toContain('1 mm in from the edge');
  });

  it('a centred label is inside the inscribed circle, so there is no finding', () => {
    expect(validateJob(roundJob(25, 25)).some((f) => f.code === 'item-off-round-stock')).toBe(false);
  });

  it('is about the round form: the same corner on a plate raises nothing, but a rod does', () => {
    expect(validateJob(roundJob(3, 3, 'plate')).some((f) => f.code === 'item-off-round-stock')).toBe(false);
    // A rod's cut face is the same ⌀D circle — it stands on its end.
    expect(validateJob(roundJob(3, 3, 'rod')).some((f) => f.code === 'item-off-round-stock')).toBe(true);
  });
});

describe('the material list the job may be cut in (#347)', () => {
  it('is the starting table’s materials plus the machine’s own, in that order, with no duplicates', () => {
    const values = materialOptionsFor(Z1).map((o) => o.value);
    expect(values).toEqual([
      // What this app can cut with no help, in the table's own order…
      'softwood', 'hardwood', 'mdf', 'pla', 'petg', 'plastic',
      // …then the Z1's own list, which the starting table has no row for: the vendor's
      // `t_MaterialList` in this app's words, metals included, plus the printed-blank classes
      // PrusaSlicer names (#456).
      'abs', 'acrylic',
      'pet', 'asa', 'hips', 'pa', 'pa-cf', 'pa-gf', 'pc', 'pp', 'tpu', 'pva',
      'aluminium-6061', 'aluminium-7075', 'brass', 'copper',
    ]);
    // Every one of them has a word to show; offering a value the app cannot label would render a
    // blank `<option>`.
    for (const option of materialOptionsFor(Z1)) expect(option.label).toBe(MATERIAL_LABELS[option.value]);
  });

  it('answers with the table’s materials when there is no machine to ask', () => {
    // The panel builds this list from `jobMachine(job)`, which always answers — but the no-argument
    // case must still be a usable list rather than an empty control.
    expect(materialOptionsFor().map((o) => o.value)).toEqual(['softwood', 'hardwood', 'mdf', 'pla', 'petg', 'plastic']);
  });

  it('offers the metals on the one machine this app models, and only what it declares', () => {
    // The acceptance that matters for #347: a metal can be ASKED FOR at all. Before this, the list
    // was four wood-or-plastic materials and no machine's table could be answered from.
    const body = materialOptionsFor(Z1).map((o) => o.value);
    for (const metal of ['aluminium-6061', 'aluminium-7075', 'brass', 'copper'] as const) {
      expect(body).toContain(metal);
    }
    // A machine that declares nothing extra gets the table and nothing more — the profile is the
    // second half of the union, not a promise about every material the app knows.
    const bare = { ...Z1, materials: [] };
    expect(materialOptionsFor(bare).map((o) => o.value)).toEqual(['softwood', 'hardwood', 'mdf', 'pla', 'petg', 'plastic']);
  });
});

describe('guided job setup — the flow in the panel (#254, #681)', () => {
  /** The ONE wizard, mounted the way `AppShell` mounts it: it unmounts when it closes. */
  function WizardHost() {
    const open = useStartWizardStore((s) => s.open);
    return open ? <StartWizard /> : <></>;
  }

  function renderPanel(): void {
    render(
      <>
        <EngravePanel />
        <WizardHost />
      </>,
    );
  }

  it('opens from the panel, is absent until asked for, and writes the #231 fix at the holding step', async () => {
    renderPanel();
    expect(screen.queryByTestId('start-wizard')).toBeNull();

    fireEvent.click(screen.getByTestId('engrave-setup-open'));
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeTruthy();
    // One wizard, one counter — the panel's edit names a step of the SAME modal.
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');
    expect(screen.queryByTestId('engrave-setup-progress')).toBeNull();

    // A 3.81 mm blank under the shipped 4 mm-proud vise is #231. The blank is step 2 now, and
    // `setStock` makes the vise follow the thickness (#344), so the disagreement this step catches
    // is the one a SAVED vise states: put the shipped value back and re-open at holding.
    fireEvent.click(screen.getByTestId('start-wizard-back'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 2 of 4 · Stock');
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '3.81' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    fireEvent.click(screen.getByTestId('start-wizard-close'));
    act(() => {
      useEngraveJobStore.getState().setVise({ stockProud: 4, source: 'saved' });
    });
    fireEvent.click(screen.getByTestId('engrave-setup-open'));

    const row = screen.getByTestId('engrave-setup-step-finding-vise-stock-proud-exceeds-thickness');
    // The sentence is operator text; the code lives only in the test id (A10, D1).
    expect(row.textContent).toContain('nothing is left in the jaws');
    expect(row.textContent).not.toContain('vise-stock-proud-exceeds-thickness');
    // The fix itself says what it would write, in the operator's own numbers.
    expect(screen.getByTestId('engrave-setup-fix-slot').textContent).toContain(
      'taller than this 3.81 mm blank',
    );
    // The seated value, not half the blank: the fix button names the number it would write.
    expect(screen.getByTestId('engrave-setup-fix-proud').textContent).toContain('0.71');
    fireEvent.click(screen.getByTestId('engrave-setup-fix-proud'));
    expect(screen.queryByTestId('engrave-setup-step-finding-vise-stock-proud-exceeds-thickness')).toBeNull();

    // Step 4 creates nothing new for a job that already has its operation, and the wizard closes.
    fireEvent.click(screen.getByTestId('engrave-setup-next'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe(
      'Step 4 of 4 · What are you cutting?',
    );
    fireEvent.click(screen.getByTestId('start-wizard-create'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.thickness).toBe(3.81);
    expect(job.workholding.vise.stockProud).toBeCloseTo(0.71, 6);
    expect(job.workholding.vise.source).toBe('saved');
    // Every value the flow wrote is tagged, and shows on the panel.
    expect(screen.getByTestId('engrave-stock-thickness-source').getAttribute('data-source')).toBe('user');
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/^saved/);
  });

  it('renders the shipped-vise warning once, not once per validator (#353)', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('engrave-setup-open'));
    // The row is keyed by code, so two copies would be two elements with the same testid — which
    // is exactly what the review saw. One row, and its words, is the fix.
    const rows = screen.getAllByTestId('engrave-setup-step-finding-vise-default');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Vise dimensions: shipped defaults (reference unit)');
  });

  it('the panel’s Stock and Hold edit controls open that step of the same wizard, with the same counter', () => {
    renderPanel();

    fireEvent.click(screen.getByTestId('engrave-stock-edit'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 2 of 4 · Stock');
    expect(screen.getByTestId('start-wizard-step-stock')).toBeDefined();
    fireEvent.click(screen.getByTestId('start-wizard-close'));

    fireEvent.click(screen.getByTestId('engrave-hold-edit'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeDefined();
    // There is no second numbering anywhere in the modal.
    expect(screen.queryByTestId('engrave-setup-progress')).toBeNull();
  });

  it('a re-entry finishes at the step it came to edit: Done applies the edit and adds no item (#681)', () => {
    // One item of the operator's own — the three shipped demo lines do not count as items.
    const one = dj();
    one.labels = [{ ...one.labels[0]!, text: 'A name' }];
    act(() => {
      useEngraveJobStore.setState({ job: one });
    });
    renderPanel();

    fireEvent.click(screen.getByTestId('engrave-setup-open')); // openWizard('holding')
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');

    // The edited step's answer is applied as it is made; Done leaves without a walk to step 4, so
    // no second item can be made by accident. The 12 mm default blank is taller than the jaws, so
    // the block mount is the one its numbers call for — no board under it, the sides free.
    fireEvent.click(screen.getByTestId('engrave-setup-mount-block'));
    fireEvent.click(screen.getByTestId('start-wizard-done'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    expect(jobItemCount(useEngraveJobStore.getState().job)).toBe(1);
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(1);
    expect(useEngraveJobStore.getState().job.workholding.vise.seat).toBe('floor');
    expect(useEngraveJobStore.getState().job.workholding.vise.stockProud).toBeCloseTo(-8, 6);
    expect(useEngraveJobStore.getState().job.sacrificial.under).toBeNull();

    // Walking on is still offered; at step 4 the button says what it would do to an existing job.
    fireEvent.click(screen.getByTestId('engrave-setup-open'));
    fireEvent.click(screen.getByTestId('engrave-setup-next'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe(
      'Step 4 of 4 · What are you cutting?',
    );
    expect(screen.getByTestId('start-wizard-create').textContent).toBe('Add the operation');
  });

  it('lets the sacrificial and material answers through to the job', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('engrave-setup-open'));

    // The waste board writes as it is chosen: there is no later Finish to collect it. The board is
    // under the part, between the jaws, so it does not push their faces outward.
    fireEvent.click(screen.getByTestId('engrave-setup-mount-board'));
    const under = useEngraveJobStore.getState().job.sacrificial.under;
    expect(under?.thickness).toBe(2);
    expect(under?.overhang).toEqual({ left: 0, right: 0, front: 0, back: 0 });

    // The material is step 2's answer; writing it returns to this same holding step.
    fireEvent.click(screen.getByTestId('start-wizard-back'));
    fireEvent.change(screen.getByTestId('start-wizard-stock-material'), { target: { value: 'hardwood' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');

    fireEvent.click(screen.getByTestId('engrave-setup-next'));
    fireEvent.click(screen.getByTestId('start-wizard-create'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.material).toBe('hardwood');
    expect(job.sacrificial.under?.thickness).toBe(2);
  });
});

describe('cutting overrides — provenance (#246)', () => {
  it('shows a typed override, promotes it to measured, and back', () => {
    render(<EngravePanel />);
    // The override inputs live in a `<details>`, whose children are still in the DOM.
    fireEvent.change(screen.getByTestId('engrave-override-stepOver'), { target: { value: '0.4' } });

    const tag = screen.getByTestId('engrave-override-stepOver-source');
    expect(tag.getAttribute('data-source')).toBe('user');
    fireEvent.click(tag);
    expect(screen.getByTestId('engrave-override-stepOver-source').getAttribute('data-source')).toBe('measured');
    fireEvent.click(screen.getByTestId('engrave-override-stepOver-source'));
    expect(screen.getByTestId('engrave-override-stepOver-source').getAttribute('data-source')).toBe('user');
  });

  it('a computed field shows computed; clearing the override returns it to computed', () => {
    render(<EngravePanel />);
    const input = screen.getByTestId('engrave-override-stepOver');
    expect(screen.getByTestId('engrave-override-stepOver-source').getAttribute('data-source')).toBe('computed');
    fireEvent.change(input, { target: { value: '0.4' } });
    expect(screen.getByTestId('engrave-override-stepOver-source').getAttribute('data-source')).toBe('user');
    fireEvent.change(screen.getByTestId('engrave-override-stepOver'), { target: { value: '' } });
    expect(screen.getByTestId('engrave-override-stepOver-source').getAttribute('data-source')).toBe('computed');
  });

  it('a later edit never relabels an existing measured value, and a reload keeps it', () => {
    const store = useEngraveJobStore.getState();
    store.setCutOverride({ feed: 450 }, 'measured');
    store.setCutOverride({ plungeFeed: 150 });
    expect(useEngraveJobStore.getState().job.sources!.cut).toEqual({
      feed: 'measured',
      plungeFeed: 'user',
    });

    // Through the schema (a reload): the measured tag survives — regenerate does not drop it.
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(useEngraveJobStore.getState().job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.sources!.cut).toEqual({ feed: 'measured', plungeFeed: 'user' });
    expect(parsed.job.cutOverride).toEqual({ feed: 450, plungeFeed: 150 });
  });

  it('re-tagging a field the job does not override is a no-op', () => {
    const store = useEngraveJobStore.getState();
    store.setCutOverrideSource('rpm', 'measured');
    expect(useEngraveJobStore.getState().job.sources?.cut?.rpm).toBeUndefined();
  });

  it('clearing the whole override drops its provenance too', () => {
    const store = useEngraveJobStore.getState();
    store.setCutOverride({ feed: 450 }, 'measured');
    store.setCutOverride(null);
    expect(useEngraveJobStore.getState().job.cutOverride).toBeUndefined();
    expect(useEngraveJobStore.getState().job.sources?.cut).toBeUndefined();
  });
});
