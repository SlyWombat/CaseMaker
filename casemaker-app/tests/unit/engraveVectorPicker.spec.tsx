// @vitest-environment jsdom
// The vector-outline picker (#217) in the Engrave panel: the Add-menu entry, the import dialog
// (size shown, units warning, target width, lost-detail rule), the accepted item and its row.
//
// Only the file PICKER is mocked (#196's `openTextFile`); the SVG parser, `scaleOutlineToWidth`,
// `toVectorShape` and the store all run for real, so this is the whole path a user takes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore, ENGRAVE_JOB_KEY, NEW_ITEM_DEPTH_KEY } from '@/store/engraveJobStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { openTextFile } from '@/utils/openTextFile';
import { resetShopDefaultsStore, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { MAX_LINE_POINTS, type EngraveVectorShape } from '@/types/engraveJob';

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
  // #451 — one case below puts a shop default in place, and it would otherwise leak into the rest.
  resetShopDefaultsStore();
  act(() => {
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-1.0' } }); // #516 item 5 — the default job no longer seeds a cutter
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

  it('#678 — a stroke-only CLOSED shape imports as a closed line, not an empty file', async () => {
    await openImport('ring.svg', STROKE_ONLY);
    // It is no longer "empty": the ring is addable and the header counts it as a closed line.
    expect(screen.queryByTestId('engrave-import-empty')).toBeNull();
    const header = screen.getByTestId('engrave-import-dialog').textContent ?? '';
    expect(header).toContain('1 closed line');
    expect(header).not.toContain('open line');
    expect(screen.getByTestId('engrave-import-notes').textContent).toContain('1 closed path imported as line');
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    const traces = useEngraveJobStore.getState().job.traces ?? [];
    expect(traces).toHaveLength(1);
    const line = traces[0]!;
    expect(line.kind).toBe('line');
    if (line.kind !== 'line') return;
    expect(line.closed).toBe(true);
    expect(line.points.length).toBeGreaterThanOrEqual(3);
    // The document round trip: what the import wrote is what the job loads again.
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(useEngraveJobStore.getState().job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const kept = parsed.job.traces![0]!;
    expect(kept.kind).toBe('line');
    if (kept.kind !== 'line') return;
    expect(kept.closed).toBe(true);
    expect(kept.points).toEqual(line.points);
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

  it('starts the accepted outline at the shop’s own new-item depth (#451)', async () => {
    // The panel writes this one itself (`acceptOutline`), so it is the one starting depth the store
    // cannot supply: it has to go through the same reader, or an imported outline would begin at a
    // number the location has nothing to do with.
    useShopDefaultsStore.setState({
      status: 'present',
      defaults: ShopDefaultsSchema.parse({
        [NEW_ITEM_DEPTH_KEY]: { value: 3, source: 'chosen', setAt: '2026-10-16', unit: 'mm', note: null },
      }),
    });
    await openImport('square.svg', MM_SQUARE);
    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    expect(theVector().depth).toBe(3);
  });
});

describe('#664 — open paths import as Engrave (line) operations', () => {
  const OPEN_LINE = svg(
    '<path d="M0 0 L10 0" fill="none" stroke="#000"/>',
    'width="10mm" viewBox="0 0 10 10"',
  );
  /** A filled square at x 0–10 and an open stroke at x 20–30: one frame, union centre x 15. */
  const MIXED = svg(
    '<path d="M0 0 H10 V10 H0 Z"/><path d="M20 0 L30 0" fill="none" stroke="#000"/>',
    'width="30mm" viewBox="0 0 30 10"',
  );

  it('a lines-only drawing is addable, and accepting it adds one line item', async () => {
    await openImport('stroke.svg', OPEN_LINE);
    expect(screen.queryByTestId('engrave-import-empty')).toBeNull();
    expect(screen.getByTestId('engrave-import-dialog').textContent).toContain('1 open line');
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    expect(screen.queryByTestId('engrave-import-dialog')).toBeNull();
    const traces = useEngraveJobStore.getState().job.traces ?? [];
    expect(traces).toHaveLength(1);
    const line = traces[0]!;
    expect(line.kind).toBe('line');
    if (line.kind !== 'line') return;
    expect(line.closed).toBe(false);
    expect(line.position).toEqual({ x: 50, y: 30 }); // stock centre, like every add
    expect(line.depth).toBeGreaterThan(0);
    expect(line.name).toBe('stroke.svg');
    // No empty vector row: the drawing is its lines.
    expect(useEngraveJobStore.getState().job.vectors ?? []).toHaveLength(0);
    expect(screen.getByTestId('engrave-trace-row-0')).toBeTruthy();
  });

  it('a mixed drawing adds the filled shape AND the line, in one frame', async () => {
    await openImport('mixed.svg', MIXED);
    fireEvent.click(screen.getByTestId('engrave-import-accept'));

    const vectors = useEngraveJobStore.getState().job.vectors ?? [];
    const traces = useEngraveJobStore.getState().job.traces ?? [];
    expect(vectors).toHaveLength(1);
    expect(traces).toHaveLength(1);
    const line = traces[0]!;
    if (line.kind !== 'line') throw new Error('expected a line');
    // The same position and rotation keep the stroke on the fill it was drawn with.
    expect(line.position).toEqual(vectors[0]!.position);
    expect(line.rotation).toBe(0);
    expect(line.depth).toBe(vectors[0]!.depth);
    // The stroke sits to the RIGHT of the square, as drawn.
    expect(Math.min(...line.points.map(([x]) => x))).toBeCloseTo(5, 6);
    expect(Math.max(...vectors[0]!.contours[0]!.map(([x]) => x))).toBeCloseTo(-5, 6);
  });

  it('two open paths import as two lines, each named', async () => {
    const two = svg(
      '<path d="M0 0 L10 0" fill="none" stroke="#000"/><path d="M0 5 L10 5" fill="none" stroke="#000"/>',
      'width="10mm" height="10mm" viewBox="0 0 10 10"',
    );
    await openImport('two.svg', two);
    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    const traces = useEngraveJobStore.getState().job.traces ?? [];
    expect(traces).toHaveLength(2);
    expect(traces.map((t) => t.name)).toEqual(['two.svg — line 1', 'two.svg — line 2']);
  });
});

describe('#664 — a long imported stroke stays a loadable job', () => {
  it('splits a path past the line cap into consecutive items and round-trips through the schema', async () => {
    // A freehand stroke flattens to thousands of points; this one is 6 001 — past the 5 000 a
    // `line` item may carry. The import must split it, because a job the app writes that the
    // schema refuses is a job lost to a default on the next start.
    const n = 6001;
    const d = ['M0 0', ...Array.from({ length: n - 1 }, (_, i) => `L${i + 1} 0`)].join(' ');
    const LONG = svg(`<path d="${d}" fill="none" stroke="#000"/>`, 'width="6000mm" viewBox="0 0 6000 1"');
    await openImport('long.svg', LONG);
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('engrave-import-accept'));

    const traces = useEngraveJobStore.getState().job.traces ?? [];
    expect(traces).toHaveLength(2);
    for (const trace of traces) {
      expect(trace.kind).toBe('line');
      if (trace.kind !== 'line') return;
      expect(trace.points.length).toBeGreaterThanOrEqual(2);
      expect(trace.points.length).toBeLessThanOrEqual(MAX_LINE_POINTS);
    }
    // The items concatenate back to the source path: each later item shares the seam vertex with
    // the one before it, so dropping that repeated point restores the stroke exactly.
    const restored = traces.flatMap((trace, i) =>
      trace.kind === 'line' ? (i === 0 ? trace.points : trace.points.slice(1)) : [],
    );
    expect(restored).toHaveLength(n);
    expect(restored.map(([x]) => x)).toEqual(Array.from({ length: n }, (_, i) => i - 3000));

    // THE assertion: the document the app just wrote parses — the next start keeps the job.
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(useEngraveJobStore.getState().job)));
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    if (!parsed.ok) return;
    const saved = (parsed.job.traces ?? []).filter((t) => t.kind === 'line');
    expect(saved).toHaveLength(2);
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

  it('#786 slice 1 — a depth past the preferred floor posts under the row and leaves Generate open', async () => {
    await addVector();
    // 12 mm stock, 1 mm minimum floor -> 11 mm is preferred; 11.5 leaves half a millimetre.
    fireEvent.change(screen.getByTestId('engrave-vector-depth-0'), { target: { value: '11.5' } });
    const row = screen.getByTestId('engrave-vector-finding-0-depth-exceeds-stock');
    expect(row.textContent).toContain('only 0.5 mm of floor would remain');
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(false);
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

// #678 — the dialog's count line and empty state, truthful in every mix: fills only, open lines
// only, closed lines only, and the two together.
describe('#678 — the import dialog counts open and closed lines separately', () => {
  const CLOSED_RING = svg('<rect x="0" y="0" width="10" height="6" fill="none" stroke="#000"/>', 'width="10mm" viewBox="0 0 10 6"');
  const BOTH = svg(
    '<rect x="0" y="0" width="10" height="6" fill="none" stroke="#000"/><path d="M0 8 L10 8" fill="none" stroke="#000"/>',
    'width="10mm" viewBox="0 0 10 10"',
  );
  const TEXT_ONLY = svg('<text x="0" y="5">Hi</text>', 'width="10mm" viewBox="0 0 10 10"');

  it('a closed-lines-only file reads "1 closed line" and adds a closed item', async () => {
    await openImport('ring.svg', CLOSED_RING);
    const header = screen.getByTestId('engrave-import-dialog').textContent ?? '';
    expect(header).toContain('1 closed line');
    expect(header).not.toContain('open line');
    expect(header).not.toContain('closed shape');
    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    const line = (useEngraveJobStore.getState().job.traces ?? [])[0]!;
    expect(line.kind === 'line' ? line.closed : null).toBe(true);
  });

  it('a mixed file names each kind', async () => {
    await openImport('both.svg', BOTH);
    const header = screen.getByTestId('engrave-import-dialog').textContent ?? '';
    expect(header).toContain('1 open line');
    expect(header).toContain('1 closed line');
    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    const traces = useEngraveJobStore.getState().job.traces ?? [];
    expect(traces).toHaveLength(2);
    expect(traces.map((t) => (t.kind === 'line' ? t.closed : null)).sort()).toEqual([false, true]);
  });

  it('a fills-only file still reads as it did, with no line clause', async () => {
    await openImport('square.svg', MM_SQUARE);
    const header = screen.getByTestId('engrave-import-dialog').textContent ?? '';
    expect(header).toContain('1 closed shape');
    expect(header).not.toContain(' open line');
    expect(header).not.toContain(' closed line');
  });

  it('the empty state survives — and no longer claims a stroked ring needs a fill', async () => {
    await openImport('text.svg', TEXT_ONLY);
    const empty = screen.getByTestId('engrave-import-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).not.toContain('still needs its fill');
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(true);
  });
});
