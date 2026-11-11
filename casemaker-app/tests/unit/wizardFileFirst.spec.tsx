// @vitest-environment jsdom
// #1098 — THE FILE COMES FIRST. The question step opens with a drop zone; the format of the file
// decides the operation (mesh → Surface a mesh, SVG/DXF → the new outline choice, PNG → relief,
// Gerbers → circuit board), and an unknown file changes nothing while saying what the app reads.
//
// The spec's named sample (`samples/ESP32-C61_bluetooth-sensor.stl`) is a local-only download, so
// these tests use the tracked #873 goal fixture: the same door, read by the same importer.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OperationStep, type OperationChoice } from '@/components/welcome/OperationStep';
import { workShapeFor } from '@/components/welcome/workShape';
import { proposeStock } from '@/engine/cnc/stockProposal';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const STL = join(HERE, '..', 'fixtures', 'goals', 'thin-wall-box.stl');
const COASTER = join(HERE, '..', 'fixtures', 'outlines', 'coaster-60.svg');

function job(): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, labels: [], shapes: [] } as EngraveJob;
}

function renderStep(): ReturnType<typeof vi.fn> {
  const onChoice = vi.fn();
  render(<OperationStep job={job()} hasOperations={false} fresh onChoiceChange={onChoice} />);
  return onChoice;
}

const lastChoice = (spy: ReturnType<typeof vi.fn>): OperationChoice | null =>
  spy.mock.calls[spy.mock.calls.length - 1]?.[0] as OperationChoice | null;

function drop(name: string, bytes: Uint8Array | string, type = ''): void {
  // A Buffer is a view over a possibly shared ArrayBuffer; a File part needs a plain one.
  const part =
    typeof bytes === 'string'
      ? bytes
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const file = new File([part], name, { type });
  fireEvent.drop(screen.getByTestId('start-wizard-drop-zone'), { dataTransfer: { files: [file] } });
}

afterEach(cleanup);

describe('#1098 — the question step opens with the file', () => {
  it('an STL dropped on the step is read and picked as the surface target', async () => {
    const onChoice = renderStep();
    drop('thin-wall-box.stl', readFileSync(STL), 'model/stl');
    await waitFor(() => {
      const choice = lastChoice(onChoice);
      expect(choice?.type).toBe('surface');
      if (choice?.type === 'surface') {
        expect(choice.target).not.toBeNull();
        expect(choice.target!.name).toBe('thin-wall-box.stl');
      }
    });
  });

  it('an SVG becomes the outline choice, cut it out by default, and sizes a 70 × 70 blank', async () => {
    const onChoice = renderStep();
    drop('coaster-60.svg', readFileSync(COASTER), 'image/svg+xml');
    await waitFor(() => expect(lastChoice(onChoice)?.type).toBe('outline'));

    const choice = lastChoice(onChoice)!;
    expect(choice).toMatchObject({ type: 'outline', use: 'profile' });
    // Cut it out is the default radio (the one a profile job needs).
    expect((screen.getByTestId('start-wizard-op-outline-cut') as HTMLInputElement).checked).toBe(true);
    // The outline sizes the blank from its own extent: 60 × 60 plus 5 mm each side. The flattened
    // circle measures a few µm over its nominal 60 mm, so the shape is read to the tenth.
    const shape = workShapeFor(choice, job());
    expect(shape.kind).toBe('outline');
    if (shape.kind !== 'outline') throw new Error('expected the outline work shape');
    expect(shape.length).toBeCloseTo(60, 1);
    expect(shape.width).toBeCloseTo(60, 1);
    expect(shape.through).toBe(true);
    expect(proposeStock(shape)).toMatchObject({ form: 'plate', length: 70, width: 70, thickness: 12 });

    // #1099 — the drawing is drawn: the thumbnail sits in the outline's own field, with the blank
    // sentence under it, so a drawing and a mesh get the same treatment on the same step.
    const thumbnail = screen.getByTestId('wizard-thumbnail');
    expect(thumbnail.getAttribute('data-kind')).toBe('outline');
    expect(screen.getByTestId('wizard-thumbnail-outline')).toBeDefined();
    expect(screen.getByTestId('wizard-thumbnail-sentence').textContent).toContain('70 × 70 × 12');
  });

  it('an unknown file sets nothing and says what Case Maker reads', () => {
    const onChoice = renderStep();
    drop('notes.txt', 'hello', 'text/plain');
    expect(screen.getByTestId('start-wizard-drop-error').textContent).toContain(
      'Case Maker reads STL, 3MF, STEP, OBJ, SVG, DXF, PNG and Gerber files — this is a .txt.',
    );
    expect(lastChoice(onChoice)).toBeNull();
  });
});


// ---------------------------------------------------------------------------------------------------
// The remaining items of the analyst's 2026-11-11 audit.

// A 1 × 1 PNG: enough for the relief reader to call it a picture.
const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

describe('#1098 — the zone and its follow-ups say what they do', () => {
  it('the zone says "or choose what to make below"', () => {
    renderStep();
    expect(screen.getByTestId('start-wizard-drop-zone').textContent).toContain('or choose what to make below');
  });

  it('several .gbr/.drl chosen in the zone are read as one board: the zone’s input takes many files', () => {
    renderStep();
    expect((screen.getByTestId('start-wizard-drop-input') as HTMLInputElement).multiple).toBe(true);
  });

  it('a .jpg is refused with the kinds sentence (no new importer)', () => {
    const onChoice = renderStep();
    drop('photo.jpg', 'x', 'image/jpeg');
    expect(screen.getByTestId('start-wizard-drop-error').textContent).toContain(
      'Case Maker reads STL, 3MF, STEP, OBJ, SVG, DXF, PNG and Gerber files — this is a .jpg.',
    );
    expect(lastChoice(onChoice)).toBeNull();
  });

  it('a PNG offers Make the part only and says a picture has one side', async () => {
    renderStep();
    drop('relief.png', PNG_1X1, 'image/png');
    await waitFor(() => expect(screen.getByTestId('start-wizard-op-surface-picture-note')).toBeTruthy());
    expect(screen.getByTestId('start-wizard-op-surface-picture-note').textContent).toContain('a picture has one side');
    expect((screen.getByTestId('start-wizard-op-surface-make-part') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('start-wizard-op-surface-make-mold')).toBeNull();
  });
});

describe('#1098 — Carve it says which cutter carves', () => {
  it('selecting Carve it (V) shows the cutter note; the other uses do not', async () => {
    renderStep();
    drop('coaster-60.svg', readFileSync(COASTER), 'image/svg+xml');
    await waitFor(() => expect(screen.getByTestId('start-wizard-op-outline-carve')).toBeTruthy());
    expect(screen.queryByTestId('start-wizard-op-outline-carve-note')).toBeNull();
    fireEvent.click(screen.getByTestId('start-wizard-op-outline-carve'));
    expect(screen.getByTestId('start-wizard-op-outline-carve-note').textContent).toBe(
      "Carved with the job's cutter — choose a V bit in Cutters after Create.",
    );
    fireEvent.click(screen.getByTestId('start-wizard-op-outline-cut'));
    expect(screen.queryByTestId('start-wizard-op-outline-carve-note')).toBeNull();
  });
});
