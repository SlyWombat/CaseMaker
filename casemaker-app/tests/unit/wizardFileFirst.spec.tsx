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
