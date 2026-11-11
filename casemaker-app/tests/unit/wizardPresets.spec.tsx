// @vitest-environment jsdom
// #1100 — WHAT ARE YOU MAKING? The eight preset cards and their answers: each card's defaults
// make a choice the Create gate accepts once its required field is filled, the sign's blank holds
// its line with the promised margin, and a 60 × 40 cut-out proposes the 80 × 60 plate.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { OperationStep, type OperationChoice } from '@/components/welcome/OperationStep';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { operationCreateBlocked } from '@/components/welcome/operationCreate';
import { WIZARD_PRESETS, defaultPresetAnswers, presetChoice, presetWorkShape } from '@/components/welcome/presets';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { proposeStock } from '@/engine/cnc/stockProposal';
import { wizardStep } from '@/components/welcome/wizardSteps';

afterEach(cleanup);

const answers = defaultPresetAnswers();

describe('#1100 — the preset answers', () => {
  it('a sign with text is a makeable engrave, and its proposed plate leaves the sign margin each side', () => {
    const a = { ...answers, text: 'Hello' };
    const choice = presetChoice('sign', a)!;
    expect(operationCreateBlocked(choice)).toBeNull();
    const shape = presetWorkShape('sign', a)!;
    // #1100 item 3 — the sign margin is the shop's (`stock.signMarginMm`, 10 each side).
    const blank = proposeStock(shape, { signMarginMm: 10 })!;
    if (shape.kind !== 'text') throw new Error('expected text work');
    expect(shape.sign).toBe(true);
    expect(blank.length - shape.size.length).toBeCloseTo(20, 5);
    expect(blank.width - shape.size.width).toBeCloseTo(20, 5);
    expect(blank.form).toBe('plate');
  });

  it('Large makes 60 mm letters and a plate that holds them', () => {
    const a = { ...answers, text: 'Hello', letterSize: 'large' as const };
    const shape = presetWorkShape('sign', a)!;
    if (shape.kind !== 'text') throw new Error('expected text work');
    expect(shape.size.width).toBe(60);
    const blank = proposeStock(shape, { signMarginMm: 10 })!;
    expect(blank.width).toBeCloseTo(80, 5);
  });

  it('an empty sign is not makeable: the gate asks for the text', () => {
    expect(operationCreateBlocked(presetChoice('sign', answers)!)).toBe('Type the text to engrave — for example, a name.');
  });

  it('Cut out a shape 60 × 40 proposes 80 × 60 — ten millimetres each side, through a plate', () => {
    const blank = proposeStock(presetWorkShape('cutout', answers)!)!;
    expect(blank).toMatchObject({ form: 'plate', length: 80, width: 60, thickness: 12 });
    expect(operationCreateBlocked(presetChoice('cutout', answers)!)).toBeNull();
  });

  it('a pocket defaults to a makeable region on a plate that holds its floor and six under it', () => {
    const blank = proposeStock(presetWorkShape('pocket', answers)!)!;
    expect(blank).toMatchObject({ length: 80, width: 60, thickness: 12 });
    expect(operationCreateBlocked(presetChoice('pocket', answers)!)).toBeNull();
  });

  it('the file, 3D-part, board and else cards are doors, not answers of their own', () => {
    for (const id of ['design-file', 'part-3d', 'pcb', 'something-else'] as const) {
      expect(presetChoice(id, answers), id).toBeNull();
      expect(presetWorkShape(id, answers), id).toBeNull();
    }
    expect(WIZARD_PRESETS).toHaveLength(7);
  });
});

describe('#1100 — the step', () => {
  function renderStep(): ReturnType<typeof vi.fn> {
    const onChoice = vi.fn();
    render(<OperationStep job={defaultEngraveJob()} hasOperations={false} fresh onChoiceChange={onChoice} />);
    return onChoice;
  }
  const lastChoice = (spy: ReturnType<typeof vi.fn>): OperationChoice | null =>
    spy.mock.calls[spy.mock.calls.length - 1]?.[0] as OperationChoice | null;

  it('draws the cards with their blurbs in the DOM, never only in a title', () => {
    renderStep();
    for (const preset of WIZARD_PRESETS.filter((p) => p.rotaryOnly !== true)) {
      const card = screen.getByTestId(`start-wizard-preset-${preset.id}`);
      expect(card.textContent, preset.id).toContain(preset.blurb);
      expect(card.getAttribute('title'), preset.id).toBeNull();
    }
  });

  it('selecting the sign asks for its text and reports a blockable engrave until it is typed', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-preset-sign'));
    expect(screen.getByTestId('start-wizard-preset-text')).toBeDefined();
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe('Type the text to engrave — for example, a name.');

    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'Hello' } });
    const choice = lastChoice(onChoice);
    expect(choice?.type).toBe('engrave');
    expect(operationCreateBlocked(choice)).toBeNull();
  });

  // #1100 item 2 — Back from the stock step restores the sign's letter size, not only its text.
  it('Back keeps the sign’s letter size', () => {
    const onChoice = vi.fn();
    render(
      <OperationStep
        job={defaultEngraveJob()}
        hasOperations={false}
        initial={{ type: 'engrave', text: 'Hi', depth: 0.5, font: DEFAULT_FONT_ID, sizeMm: 60 }}
        onChoiceChange={onChoice}
      />,
    );
    expect((screen.getByTestId('start-wizard-preset-letter-large') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('start-wizard-preset-letter-medium') as HTMLInputElement).checked).toBe(false);
  });

  // #1100 item 4 — the step is named by its question.
  it('the step is titled What are you making?', () => {
    render(<OperationStep job={defaultEngraveJob()} hasOperations={false} fresh onChoiceChange={() => undefined} />);
    expect(screen.getByTestId('engrave-setup-step-what')).toBeDefined();
    // The shell owns the step's title; the table is the one naming.
    expect(wizardStep('operation').name).toBe('What are you making?');
    expect(wizardStep('machine').nextLabel).toBe('Next: what are you making');
  });

  // #1100 item 1 — a selected FILE card stays selected, spans the row and hosts its own field;
  // the foot-of-step copy is gone (one field, one place).
  it('A part from a 3D model stays selected and shows its file field in the card', () => {
    renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-preset-part-3d'));
    expect(screen.getByTestId('start-wizard-preset-part-3d').getAttribute('aria-pressed')).toBe('true');
    const wrapper = screen.getByTestId('start-wizard-preset-card-part-3d');
    expect(wrapper.contains(screen.getByTestId('start-wizard-op-surface-file'))).toBe(true);
    expect(screen.getAllByTestId('start-wizard-op-surface-picker')).toHaveLength(1);
  });

  it('A circuit board stays selected and shows its file field in the card', () => {
    renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-preset-pcb'));
    expect(screen.getByTestId('start-wizard-preset-pcb').getAttribute('aria-pressed')).toBe('true');
    const wrapper = screen.getByTestId('start-wizard-preset-card-pcb');
    expect(wrapper.contains(screen.getByTestId('start-wizard-op-pcb-files'))).toBe(true);
    expect(screen.getAllByTestId('start-wizard-op-pcb-picker')).toHaveLength(1);
  });

  it('A design from a file embeds the drop zone’s own field and adds no other', () => {
    renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-preset-design-file'));
    expect(screen.getByTestId('start-wizard-preset-design-file').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('start-wizard-drop-zone')).toBeDefined();
    expect(screen.queryByTestId('start-wizard-op-field')).toBeNull();
    expect(screen.queryByTestId('start-wizard-op-pcb')).toBeNull();
  });

  it('selecting Cut out a shape reports the card’s numbers', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-preset-cutout'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'cutout', length: 60, width: 40 });
    fireEvent.click(screen.getByTestId('start-wizard-preset-shape-circle'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'cutout', shape: 'circle', length: 60, width: 60 });
  });
});
