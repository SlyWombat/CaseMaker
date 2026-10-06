// @vitest-environment jsdom
// The vector-outline picker (#217) in the Engrave panel: the Add-menu entry, the import dialog
// (size shown, units warning, target width, lost-detail rule), the accepted item and its row.
//
// Only the file PICKER is mocked (#196's `openTextFile`); the SVG parser, `scaleOutlineToWidth`,
// `toVectorShape` and the store all run for real, so this is the whole path a user takes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore, ENGRAVE_JOB_KEY } from '@/store/engraveJobStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { openTextFile } from '@/utils/openTextFile';
import type { EngraveVectorShape } from '@/types/engraveJob';

vi.mock('@/utils/openTextFile', () => ({ openTextFile: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client that answers every request with "no new preview", which the panel must survive. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const svg = (body: string, attrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

/** A 10 × 10 mm square: physical width/height AND a matching viewBox. */
const MM_SQUARE = svg('<path d="M0 0 H10 V10 H0 Z"/>', 'width="10mm" height="10mm" viewBox="0 0 10 10"');
/** The same square with only a viewBox — the parser falls back to 96 px/inch. */
const PX_SQUARE = svg('<path d="M0 0 H10 V10 H0 Z"/>', 'viewBox="0 0 10 10"');
/** A 20 × 10 mm rectangle, for the aspect-ratio check. */
const MM_RECT = svg('<path d="M0 0 H20 V10 H0 Z"/>', 'width="20mm" height="10mm" viewBox="0 0 20 10"');
/** A closed but STROKED path: no fill, so there is no area to cut. */
const STROKE_ONLY = svg(
  '<path d="M0 0 H10 V10 H0 Z" fill="none" stroke="#000"/>',
  'width="10mm" viewBox="0 0 10 10"',
);

function pickFile(name: string, text: string): void {
  vi.mocked(openTextFile).mockResolvedValue({ name, text });
}

/** The one vector in the job, or a thrown error naming what is there instead. */
function theVector(): EngraveVectorShape {
  const vectors = useEngraveJobStore.getState().job.vectors ?? [];
  if (vectors.length !== 1) throw new Error(`expected 1 vector, found ${vectors.length}`);
  return vectors[0]!;
}

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose();
  vi.mocked(openTextFile).mockReset();
  try {
    localStorage.clear();
  } catch {
    // no localStorage in some environments
  }
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
});

/** Open the import dialog on `name`/`text` and wait for it. */
async function openImport(name: string, text: string): Promise<HTMLElement> {
  pickFile(name, text);
  render(<EngravePanel />);
  fireEvent.click(screen.getByTestId('engrave-add-import-outline'));
  return await screen.findByTestId('engrave-import-dialog');
}

describe('EngravePanel — the import entry (#217)', () => {
  it('offers “Import outline…” in the Add menu and opens the dialog on a parsed file', async () => {
    const dialog = await openImport('square.svg', MM_SQUARE);
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId('engrave-import-source-size').textContent).toContain('10.00 × 10.00');
    expect(screen.getByTestId('engrave-import-final-size').textContent).toContain('10.00 × 10.00');
    // Units came from the file, so no assumed-size warning.
    expect(screen.queryByTestId('engrave-import-unit-warning')).toBeNull();
    // Lost detail (#201) is named as the rule, with the current cutter.
    expect(screen.getByTestId('engrave-import-lost-detail').textContent).toContain('1.00 mm');
  });

  it('surfaces the assumed-unit note prominently and shows the fallback size', async () => {
    await openImport('square.svg', PX_SQUARE);
    const warn = screen.getByTestId('engrave-import-unit-warning');
    expect(warn.textContent).toContain('96 px/inch');
    // 10 px at 96 dpi is 2.65 mm, not 10 — the classic wrong-size import.
    expect(screen.getByTestId('engrave-import-final-size').textContent).toContain('2.65');
  });

  it('reports an unsupported extension without opening the dialog', async () => {
    pickFile('logo.txt', 'not a drawing');
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-import-outline'));
    const err = await screen.findByTestId('engrave-import-error');
    expect(err.textContent).toContain('Unsupported outline format');
    expect(screen.queryByTestId('engrave-import-dialog')).toBeNull();
  });

  it('does nothing when the picker is cancelled', async () => {
    vi.mocked(openTextFile).mockResolvedValue(null);
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-import-outline'));
    // Let the promise settle; no dialog, no error, no item.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('engrave-import-dialog')).toBeNull();
    expect(screen.queryByTestId('engrave-import-error')).toBeNull();
    expect(useEngraveJobStore.getState().job.vectors ?? []).toHaveLength(0);
  });
});

describe('EngravePanel — the import dialog size control (#217)', () => {
  it('rescales uniformly and stores the scaled contours on accept', async () => {
    await openImport('square.svg', MM_SQUARE);
    fireEvent.change(screen.getByTestId('engrave-import-target-width'), { target: { value: '20' } });
    expect(screen.getByTestId('engrave-import-final-size').textContent).toContain('20.00 × 20.00');

    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    expect(screen.queryByTestId('engrave-import-dialog')).toBeNull();

    const v = theVector();
    expect(v.width).toBe(20);
    expect(v.height).toBe(20);
    expect(v.sourceName).toBe('square.svg');
    // The contours ARE the accepted geometry: a 20 mm square ring reaches ±10 mm.
    const maxX = Math.max(...v.contours[0]!.map(([x]) => x));
    expect(maxX).toBeCloseTo(10, 5);
    // …and the item is on screen.
    expect(screen.getByTestId('engrave-vector-row-0')).toBeTruthy();
  });

  it('keeps the aspect ratio for a non-square outline', async () => {
    await openImport('rect.svg', MM_RECT);
    expect(screen.getByTestId('engrave-import-source-size').textContent).toContain('20.00 × 10.00');
    fireEvent.change(screen.getByTestId('engrave-import-target-width'), { target: { value: '40' } });
    expect(screen.getByTestId('engrave-import-final-size').textContent).toContain('40.00 × 20.00');
  });

  it('refuses an empty (strokes-only) file and names the reason', async () => {
    await openImport('line.svg', STROKE_ONLY);
    expect(screen.getByTestId('engrave-import-empty')).toBeTruthy();
    expect(screen.getByTestId('engrave-import-notes').textContent).toContain('stroke');
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    expect(useEngraveJobStore.getState().job.vectors ?? []).toHaveLength(0);
  });

  it('disables accept while the target width is invalid', async () => {
    await openImport('square.svg', MM_SQUARE);
    fireEvent.change(screen.getByTestId('engrave-import-target-width'), { target: { value: '' } });
    expect(screen.getByTestId('engrave-import-target-invalid')).toBeTruthy();
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Cancel adds nothing', async () => {
    await openImport('square.svg', MM_SQUARE);
    fireEvent.click(screen.getByTestId('engrave-import-cancel'));
    expect(screen.queryByTestId('engrave-import-dialog')).toBeNull();
    expect(useEngraveJobStore.getState().job.vectors ?? []).toHaveLength(0);
  });
});

describe('EngravePanel — the imported vector row (#217)', () => {
  async function addVector(): Promise<void> {
    await openImport('square.svg', MM_SQUARE);
    fireEvent.click(screen.getByTestId('engrave-import-accept'));
  }

  it('counts the vector as an item and shows it as a frame candidate', async () => {
    await addVector();
    expect(screen.getByTestId('engrave-item-count').textContent).toBe('4');
    expect(screen.getByTestId('engrave-vector-source-0').textContent).toContain('square.svg');

    // A frame may name the imported outline (it is an `EngraveAnyItem`).
    fireEvent.click(screen.getByTestId('engrave-add-frame'));
    const select = screen.getByTestId('engrave-combined-around-0') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain(theVector().id);
  });

  it('edits placement, rotation and depth, and removes the item', async () => {
    await addVector();
    fireEvent.change(screen.getByTestId('engrave-vector-x-0'), { target: { value: '30' } });
    expect(theVector().position.x).toBe(30);
    fireEvent.change(screen.getByTestId('engrave-vector-rotation-0'), { target: { value: '45' } });
    expect(theVector().rotation).toBe(45);
    fireEvent.change(screen.getByTestId('engrave-vector-depth-0'), { target: { value: '3.5' } });
    expect(theVector().depth).toBe(3.5);

    fireEvent.click(screen.getByTestId('engrave-vector-remove-0'));
    expect(useEngraveJobStore.getState().job.vectors).toEqual([]);
  });

  it('shows the depth-past-floor finding under the row and gates Generate', async () => {
    await addVector();
    // 12 mm stock, 1 mm minimum floor -> at most 11 mm.
    fireEvent.change(screen.getByTestId('engrave-vector-depth-0'), { target: { value: '11.5' } });
    expect(screen.getByTestId('engrave-vector-finding-0-depth-exceeds-stock')).toBeTruthy();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('engraveJobStore — imported vectors (#217)', () => {
  const vector: EngraveVectorShape = {
    kind: 'vector',
    id: 'v1',
    sourceName: 'logo.svg',
    contours: [
      [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
    ],
    fillRule: 'NonZero',
    width: 10,
    height: 10,
    position: { x: 5, y: 5 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
  };

  it('adds, updates and removes a vector', () => {
    const store = useEngraveJobStore.getState();
    expect(store.addVector(vector)).toBe('v1');
    expect(useEngraveJobStore.getState().job.vectors).toHaveLength(1);

    store.updateVector('v1', { depth: 1.5, position: { x: 8, y: 5 } });
    // A partial position is merged, not replaced.
    expect(theVector().depth).toBe(1.5);
    expect(theVector().position).toEqual({ x: 8, y: 5 });

    useEngraveJobStore.getState().removeVector('v1');
    expect(useEngraveJobStore.getState().job.vectors).toEqual([]);
  });

  it('persists a loadable document (schema round-trip)', () => {
    useEngraveJobStore.getState().addVector(vector);
    const stored = localStorage.getItem(ENGRAVE_JOB_KEY);
    expect(stored).not.toBeNull();
    const parsed = parseEngraveJob(JSON.parse(stored!));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.job.vectors?.[0]?.sourceName).toBe('logo.svg');
  });
});
