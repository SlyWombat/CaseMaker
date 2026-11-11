// @vitest-environment jsdom
// #752 R-UI-4 — the Operation step on a rod in the rotary chuck: three groups, each operation's
// one field, Relief tagged simulate only, and — since #241 slice 2 — the face group authorable:
// Flat, Faces all round and Cross-hole each carry the index (A) they are cut at.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OperationStep, type OperationChoice } from '@/components/welcome/OperationStep';
import { operationCreateBlocked } from '@/components/welcome/operationCreate';
import { ROTARY_OPERATION_GROUPS } from '@/components/welcome/rotaryOperations';
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

  it('offers the face group as authorable, and each face operation asks for its index and its one field', () => {
    const onChoice = renderStep();
    for (const id of ['flat', 'faces-all-round', 'cross-hole']) {
      const chip = screen.getByTestId(`start-wizard-op-rotary-${id}`) as HTMLButtonElement;
      expect(chip.disabled, id).toBe(false);
    }

    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-flat'));
    expect(lastChoice(onChoice)).toEqual({ type: 'flat', a: 0, depth: 1 });
    expect((screen.getByTestId('start-wizard-op-face-angle') as HTMLInputElement).value).toBe('0');
    fireEvent.change(screen.getByTestId('start-wizard-op-face-angle'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('start-wizard-op-face-depth'), { target: { value: '2' } });
    expect(lastChoice(onChoice)).toEqual({ type: 'flat', a: 30, depth: 2 });
    expect(operationCreateBlocked(lastChoice(onChoice))).toBeNull();

    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-faces-all-round'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'faces-all-round', a: 30, count: 6, acrossFlats: 17.321 });
    fireEvent.change(screen.getByTestId('start-wizard-op-faces-count'), { target: { value: '8' } });
    fireEvent.change(screen.getByTestId('start-wizard-op-faces-across'), { target: { value: '18.5' } });
    expect(lastChoice(onChoice)).toEqual({ type: 'faces-all-round', a: 30, count: 8, acrossFlats: 18.5 });

    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-cross-hole'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'cross-hole', a: 30 });
    fireEvent.change(screen.getByTestId('start-wizard-op-hole-diameter'), { target: { value: '3' } });
    expect(lastChoice(onChoice)).toEqual({ type: 'cross-hole', a: 30, diameter: 3 });
  });

  it('tags Relief from a mesh simulate only, as a fact, not a disabled control', () => {
    renderStep();
    expect(screen.getByTestId('rotary-operation-tag-relief').textContent).toBe('simulate only');
    const relief = screen.getByTestId('start-wizard-op-rotary-relief') as HTMLButtonElement;
    expect(relief.disabled).toBe(false);
  });

  it('asks Engrave text for its text and Reads, along by default', () => {
    const onChoice = renderStep();
    // #1123 item 3 — the highlighted Engrave text is a default, not a pick: nothing is reported
    // until it (or another chip) is clicked. Its one field and Reads are drawn meanwhile.
    expect(lastChoice(onChoice)).toBeNull();
    expect((screen.getByTestId('start-wizard-op-reads-select') as HTMLSelectElement).value).toBe('along');
    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-engrave'));
    expect(lastChoice(onChoice)).toMatchObject({ type: 'engrave', text: '', reads: 'along' });
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe('Type the text to engrave — for example, a name.');
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
    // #1109 item 3 — the blocker proposes the field's decided example (length → 80).
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe(
      'The flute needs a length above 0 — type a number in mm (for example 80).',
    );
  });

  it('Relief asks for its file; Create waits for one that reads cleanly', () => {
    const onChoice = renderStep();
    fireEvent.click(screen.getByTestId('start-wizard-op-rotary-relief'));
    expect(screen.getByTestId('start-wizard-op-surface-file')).toBeDefined();
    expect(lastChoice(onChoice)).toEqual({ type: 'surface', target: null });
    expect(operationCreateBlocked(lastChoice(onChoice))).toBe('Pick the mesh to surface — a .stl or .step file.');
  });

  it('a flat job shows the preset cards, with the flat picker behind Something else…', () => {
    renderStep(defaultEngraveJob());
    // #1100 — the step opens on the eight intent cards, not the sixteen engine chips.
    expect(screen.getByTestId('start-wizard-presets')).toBeDefined();
    expect(screen.queryByTestId('operation-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('start-wizard-preset-something-else'));
    expect(screen.getByTestId('operation-picker')).toBeDefined();
    expect(screen.queryByTestId('rotary-operation-picker')).toBeNull();
  });
});
