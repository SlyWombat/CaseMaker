// @vitest-environment jsdom
// The guided job setup (#254) and the cutting overrides' provenance (#246). The pure half —
// the answers, the #231 fix and the one tagged document write — is asserted without React; the
// panel + flow are driven through jsdom like `engravePanel.spec.tsx`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  applyAnswers,
  blankViseFindings,
  defaultSetupAnswers,
  stepFindings,
  stockProudFix,
} from '@/engine/cnc/engrave/setupFlow';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { presetJawStrips } from '@/engine/cnc/sacrificial';

vi.mock('@/engine/exportTrigger', () => ({ saveText: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngraveRunStore.getState().reset();
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
});

/** Walk the flow to the blank step (holding -> material -> blank). */
function toBlankStep(): void {
  fireEvent.click(screen.getByTestId('engrave-setup-open'));
  fireEvent.click(screen.getByTestId('engrave-setup-next'));
  fireEvent.click(screen.getByTestId('engrave-setup-next'));
}

describe('guided job setup — the pure answers (#254)', () => {
  it('every value applyAnswers writes carries a source, and measured is never demoted', () => {
    const job = defaultEngraveJob();
    // Pretend thickness was a caliper reading and the cutter was typed.
    job.sources = { stock: { thickness: 'measured' }, tool: 'user' };

    const answers = defaultSetupAnswers(job);
    expect(answers.sources.stock.thickness).toBe('measured'); // carried, not demoted
    expect(answers.sources.stock.length).toBe('user'); // a shipped default, asserted now
    expect(answers.sources.tool).toBe('user');

    const applied = applyAnswers(job, answers);
    // No value the flow wrote is untagged: all four stock fields and the cutter have a source.
    expect(applied.sources!.stock).toEqual({
      length: 'user',
      width: 'user',
      thickness: 'measured',
      material: 'user',
    });
    expect(applied.sources!.tool).toBe('user');
    // The vise and sacrificial carry their own `source`, so they are tagged too.
    expect(applied.workholding.vise.source).toBeTruthy();
    expect(applied.sacrificial.source).toBeTruthy();
  });

  it('catches the #231 case — a 3.81 mm blank in the shipped 4 mm-proud vise', () => {
    const job = defaultEngraveJob(); // 12 mm stock, stockProud 4
    const answers = defaultSetupAnswers(job);
    answers.stock = { ...answers.stock, thickness: 3.81 };

    const findings = blankViseFindings(answers);
    const error = findings.find((f) => f.code === 'vise-stock-proud-exceeds-thickness');
    expect(error).toBeTruthy();
    expect(error!.severity).toBe('error');
    // …and the flow reaches it through `validateJob` on the would-be document too.
    expect(stepFindings('blank', job, answers).some((f) => f.code === 'vise-stock-proud-exceeds-thickness')).toBe(true);

    // The fix is half the blank (capped at the shipped 4 mm), asserted as the user's setup.
    const fix = stockProudFix(answers);
    expect(fix).not.toBeNull();
    expect(fix!.stockProud).toBeCloseTo(1.905, 6);
    expect(fix!.source).toBe('saved');

    // Applying it resolves the refusal.
    const fixed = { ...answers, vise: fix! };
    expect(blankViseFindings(fixed).some((f) => f.code === 'vise-stock-proud-exceeds-thickness')).toBe(false);
    expect(stockProudFix(fixed)).toBeNull();
  });

  it('carries a custom sacrificial setup through untouched until the choice changes', () => {
    const job = defaultEngraveJob();
    const answers = defaultSetupAnswers(job);
    // A job that already has strips: the seeded answers keep them.
    answers.sacrificial = presetJawStrips();
    expect(applyAnswers(job, answers).sacrificial).toEqual(presetJawStrips());
  });
});

describe('guided job setup — the flow in the panel (#254)', () => {
  it('opens from the panel, is absent until asked for, and writes the #231 fix', () => {
    render(<EngravePanel />);
    expect(screen.queryByTestId('engrave-setup-flow')).toBeNull();

    toBlankStep();
    expect(screen.getByTestId('engrave-setup-step-blank')).toBeTruthy();

    // 3.81 mm blank against the 4 mm-proud default: the fix is offered at the step.
    fireEvent.change(screen.getByTestId('engrave-setup-stock-thickness'), { target: { value: '3.81' } });
    expect(screen.getByTestId('engrave-setup-step-blank').textContent).toContain(
      'vise-stock-proud-exceeds-thickness',
    );
    expect(screen.getByTestId('engrave-setup-fix-proud').textContent).toContain('1.905');
    fireEvent.click(screen.getByTestId('engrave-setup-fix-proud'));
    expect(screen.getByTestId('engrave-setup-step-blank').textContent).not.toContain(
      'vise-stock-proud-exceeds-thickness',
    );

    // Finish: the job now carries the blank and the corrected vise, every value tagged.
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // cutter
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // finish
    expect(screen.queryByTestId('engrave-setup-flow')).toBeNull();

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.thickness).toBe(3.81);
    expect(job.workholding.vise.stockProud).toBeCloseTo(1.905, 6);
    expect(job.workholding.vise.source).toBe('saved');
    // Every value the flow wrote is tagged, and shows on the panel.
    expect(screen.getByTestId('engrave-stock-thickness-source').getAttribute('data-source')).toBe('user');
    expect(screen.getByTestId('engrave-tool-source').getAttribute('data-source')).toBe('user');
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/^saved/);
  });

  it('“Same as last job” finishes in one click without changing the numbers', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-setup-open'));
    const before = useEngraveJobStore.getState().job.stock;
    fireEvent.click(screen.getByTestId('engrave-setup-same'));
    expect(screen.queryByTestId('engrave-setup-flow')).toBeNull();
    expect(useEngraveJobStore.getState().job.stock).toEqual(before);
    // …but the values are now asserted, so they carry sources.
    expect(useEngraveJobStore.getState().job.sources!.stock!.length).toBe('user');
  });

  it('lets the sacrificial and material answers through to the job', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-setup-open'));
    fireEvent.change(screen.getByTestId('engrave-setup-sacrificial'), { target: { value: 'strips' } });
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // material
    fireEvent.change(screen.getByTestId('engrave-setup-material'), { target: { value: 'hardwood' } });
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // blank
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // cutter
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // finish

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.material).toBe('hardwood');
    expect(job.sacrificial).toEqual(presetJawStrips());
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
