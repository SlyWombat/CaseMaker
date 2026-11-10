// @vitest-environment jsdom
// #1100 — WHAT ARE YOU MAKING? The eight preset cards and their answers: each card's defaults
// make a choice the Create gate accepts once its required field is filled, the sign's blank holds
// its line with the promised margin, and a 60 × 40 cut-out proposes the 80 × 60 plate.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { OperationStep, type OperationChoice } from '@/components/welcome/OperationStep';
import { operationCreateBlocked } from '@/components/welcome/operationCreate';
import { WIZARD_PRESETS, defaultPresetAnswers, presetChoice, presetWorkShape } from '@/components/welcome/presets';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { proposeStock } from '@/engine/cnc/stockProposal';

afterEach(cleanup);

const answers = defaultPresetAnswers();

describe('#1100 — the preset answers', () => {
  it('a sign with text is a makeable engrave, and its proposed blank holds the line with 5 mm', () => {
    const a = { ...answers, text: 'Hello' };
    const choice = presetChoice('sign', a)!;
    expect(operationCreateBlocked(choice)).toBeNull();
    const shape = presetWorkShape('sign', a)!;
    const blank = proposeStock(shape)!;
    if (shape.kind !== 'text') throw new Error('expected text work');
    expect(blank.length - shape.size.length).toBeCloseTo(10, 5);
    expect(blank.width - shape.size.width).toBeCloseTo(10, 5);
  });

  it('an empty sign is not makeable: the gate asks for the text', () => {
    expect(operationCreateBlocked(presetChoice('sign', answers)!)).toBe('Type the text to engrave.');
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
    for (const id of ['design-file', 'part-3d', 'pcb', 'dowel', 'something-else'] as const) {
      expect(presetChoice(id, answers), id).toBeNull();
      expect(presetWorkShape(id, answers), id).toBeNull();
    }
    expect(WIZARD_PRESETS).toHaveLength(8);
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
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe('Type the text to engrave.');

    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'Hello' } });
    const choice = lastChoice(onChoice);
    expect(choice?.type).toBe('engrave');
    expect(operationCreateBlocked(choice)).toBeNull();
  });

  it('selecting Cut out a shape reports the card’s numbers', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-preset-cutout'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'cutout', length: 60, width: 40 });
    fireEvent.click(screen.getByTestId('start-wizard-preset-shape-circle'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'cutout', shape: 'circle', length: 60, width: 60 });
  });
});
