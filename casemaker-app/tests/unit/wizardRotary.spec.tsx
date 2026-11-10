// @vitest-environment jsdom
// #1107 — THE ROTARY PATH ON A NEW JOB.
//
// The question step offers the rod intents when the house owns a rotary: Name on a dowel, Faces
// on a rod, A relief on a rod, in their own group at the top when the rotary is on the pins.
// Picking one makes the step the rotary one and the choice states its frame, so the blank can be
// proposed as a rod and the chuck pre-selected on Holding.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { OperationStep, type OperationChoice } from '@/components/welcome/OperationStep';
import { workShapeFor } from '@/components/welcome/workShape';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

afterEach(cleanup);

const ROTARY_ON = { owned: true, onPins: true };

function renderStep(facts = ROTARY_ON): ReturnType<typeof vi.fn> {
  const onChoice = vi.fn();
  render(
    <OperationStep
      job={defaultEngraveJob()}
      hasOperations={false}
      fresh
      rotaryFacts={facts}
      onChoiceChange={onChoice}
    />,
  );
  return onChoice;
}

const lastChoice = (spy: ReturnType<typeof vi.fn>): OperationChoice | null =>
  spy.mock.calls[spy.mock.calls.length - 1]?.[0] as OperationChoice | null;

describe('#1107 — the question step knows the rotary', () => {
  it('renders the On a rod group before the picker when the rotary is on the pins', () => {
    renderStep();
    const group = screen.getByTestId('start-wizard-rotary-intents');
    const cards = screen.getByTestId('start-wizard-presets');
    // #1100 folded the rod intents into the card list: with the machine in the chuck the rod
    // group is listed FIRST, above the flat cards.
    expect(group.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const id of ['dowel', 'faces', 'relief']) {
      expect(screen.getByTestId(`start-wizard-rotary-intent-${id}`)).toBeDefined();
    }
  });

  it('is absent when the house owns no rotary', () => {
    renderStep({ owned: false, onPins: false });
    expect(screen.queryByTestId('start-wizard-rotary-intents')).toBeNull();
  });

  it('picking Name on a dowel reports a rotary text choice and shows the rotary field', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-rotary-intent-dowel'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'engrave', frame: 'rotary' });
    // The rotary step's own fields are in place: Reads, and the text field to type in.
    expect(screen.getByTestId('start-wizard-op-reads-select')).toBeDefined();
    expect(screen.getByTestId('start-wizard-op-text')).toBeDefined();
  });

  it('picking Faces on a rod reports the face operation, framed rotary', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-rotary-intent-faces'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'faces-all-round', frame: 'rotary' });
  });

  it('names a flat-only pick that the rod intent drops', () => {
    renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-preset-something-else'));
    fireEvent.click(screen.getByTestId('engrave-setup-what-profile'));
    fireEvent.click(screen.getByTestId('start-wizard-rotary-intent-dowel'));
    expect(screen.getByTestId('start-wizard-rotary-dropped').textContent).toBe(
      'Profile is a flat-stock operation — on a rod, choose again.',
    );
  });

  it('the relief intent states the depth limit plainly until the #1164 fix', () => {
    renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-rotary-intent-relief'));
    expect(screen.getByTestId('start-wizard-rotary-relief-depth-note').textContent).toContain('do not cut it yet');
  });

  it('a relief proposes the rod from the mesh section, not an invented 20 mm', () => {
    const target = {
      id: 't1',
      name: 'relief.stl',
      format: 'stl' as const,
      sha256: 'a'.repeat(64),
      size: { x: 44, y: 30, z: 8 },
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      role: 'goal' as const,
      enabled: true,
    };
    expect(workShapeFor({ type: 'surface', target, frame: 'rotary' }, defaultEngraveJob())).toEqual({
      kind: 'rod',
      diameter: 30,
      length: 100,
    });
  });

  it('picking A relief on a rod asks for its mesh', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-rotary-intent-relief'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'surface', frame: 'rotary' });
    expect(screen.getByTestId('start-wizard-op-surface-file')).toBeDefined();
  });
});
