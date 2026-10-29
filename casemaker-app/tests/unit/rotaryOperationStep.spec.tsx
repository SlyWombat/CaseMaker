// @vitest-environment jsdom
// #752 R-UI-4 — the Operation step on a rod in the rotary chuck: three groups, each operation's
// one field, Relief tagged simulate only, and the face group stated but NOT authorable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OperationStep, operationCreateBlocked, type OperationChoice } from '@/components/welcome/OperationStep';
import { ROTARY_FACE_REASON, ROTARY_OPERATION_GROUPS } from '@/components/welcome/rotaryOperations';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';

function dowelJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { jawDiameter: null, stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [],
  } as EngraveJob;
}

function renderStep(job: EngraveJob = dowelJob()): ReturnType<typeof vi.fn> {
  const onChoice = vi.fn();
  render(<OperationStep job={job} hasOperations={false} onChoiceChange={onChoice} />);
  return onChoice;
}

const lastChoice = (spy: ReturnType<typeof vi.fn>): OperationChoice | null =>
  spy.mock.calls[spy.mock.calls.length - 1]?.[0] as OperationChoice | null;

afterEach(cleanup);

describe('#752 the rotary Operation step', () => {
  it('draws the three groups on a rod, and the flat picker is not there', () => {
    renderStep();
    expect(screen.getByTestId('rotary-operation-picker')).toBeDefined();
    for (const group of ['surface', 'face', '3d']) {
      expect(screen.getByTestId(`rotary-operation-group-${group}`)).toBeDefined();
    }
    expect(screen.queryByTestId('operation-picker')).toBeNull();
    // The chips are the design's words, in the design's groups.
    expect(ROTARY_OPERATION_GROUPS.map((g) => g.label)).toEqual(['On the surface', 'On a face', '3D']);
  });

  it('states the face group’s reason once and on every face chip, and those chips cannot be picked', () => {
    const onChoice = renderStep();
    const before = lastChoice(onChoice);
    for (const id of ['flat', 'faces-all-round', 'cross-hole']) {
      const chip = screen.getByTestId(`start-wizard-op-rotary-${id}`) as HTMLButtonElement;
      expect(chip.disabled, id).toBe(true);
      expect(chip.title, id).toBe(ROTARY_FACE_REASON);
      // A disabled chip takes no pick: the answer the shell would Create from does not change.
      fireEvent.click(chip);
      expect(lastChoice(onChoice)).toEqual(before);
    }
    expect(screen.getByTestId('rotary-face-reason').textContent).toBe(ROTARY_FACE_REASON);
    // Operator words: no issue number, no code token.
    expect(ROTARY_FACE_REASON).not.toMatch(/#\d|axis-crossing|wrap-into-clamp|rotary-/);
  });

  it('tags Relief from a mesh simulate only, as a fact, not a disabled control', () => {
    renderStep();
    expect(screen.getByTestId('rotary-operation-tag-relief').textContent).toBe('simulate only');
    const relief = screen.getByTestId('start-wizard-op-rotary-relief') as HTMLButtonElement;
    expect(relief.disabled).toBe(false);
  });

  it('asks Engrave text for its text and Reads, along by default', () => {
    const onChoice = renderStep();
    expect(lastChoice(onChoice)).toMatchObject({ type: 'engrave', text: '', reads: 'along' });
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe('Type the text to engrave.');
    expect((screen.getByTestId('start-wizard-op-reads-select') as HTMLSelectElement).value).toBe('along');
    fireEvent.change(screen.getByTestId('start-wizard-op-reads-select'), { target: { value: 'around' } });
    expect(lastChoice(onChoice)).toMatchObject({ type: 'engrave', text: '', reads: 'around' });
    fireEvent.change(screen.getByTestId('start-wizard-op-text'), { target: { value: 'Zoomba' } });
    expect(lastChoice(onChoice)).toMatchObject({ type: 'engrave', text: 'Zoomba', reads: 'around' });
    expect(operationCreateBlocked(lastChoice(onChoice))).toBeNull();
  });

  it('asks V-carve for its text, which may be left empty for a region', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-v-carve'));
    expect(lastChoice(onChoice)).toEqual({ type: 'v-carve', text: '' });
    fireEvent.change(screen.getByTestId('start-wizard-op-vcarve-text'), { target: { value: 'Hi' } });
    expect(lastChoice(onChoice)).toEqual({ type: 'v-carve', text: 'Hi' });
    fireEvent.change(screen.getByTestId('start-wizard-op-vcarve-text'), { target: { value: '' } });
    expect(lastChoice(onChoice)).toEqual({ type: 'v-carve', text: '' });
    // An empty text is a region to draw — Create is not blocked.
    expect(operationCreateBlocked(lastChoice(onChoice))).toBeNull();
  });

  it('Pocket asks for nothing — the size comes in the panel', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-pocket'));
    expect(lastChoice(onChoice)).toEqual({ type: 'pocket' });
    expect(screen.getByTestId('start-wizard-op-pocket-note').textContent).toContain('in the panel');
  });

  it('Flute asks for its length along, and Create wants it above zero', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-flute'));
    expect(lastChoice(onChoice)).toEqual({ type: 'flute', lengthMm: 20 });
    fireEvent.change(screen.getByTestId('start-wizard-op-flute-length'), { target: { value: '30' } });
    expect(lastChoice(onChoice)).toEqual({ type: 'flute', lengthMm: 30 });
    fireEvent.change(screen.getByTestId('start-wizard-op-flute-length'), { target: { value: '0' } });
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe('The flute needs a length above 0 mm.');
  });

  it('Relief asks for its file; Create waits for one that reads cleanly', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-relief'));
    expect(screen.getByTestId('start-wizard-op-surface-file')).toBeDefined();
    expect(lastChoice(onChoice)).toEqual({ type: 'surface', target: null });
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe('Choose the mesh to surface.');
  });

  it('a flat job keeps the flat picker, unchanged', () => {
    renderStep(defaultEngraveJob());
    expect(screen.getByTestId('operation-picker')).toBeDefined();
    expect(screen.queryByTestId('rotary-operation-picker')).toBeNull();
  });
});
