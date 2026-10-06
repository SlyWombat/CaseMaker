// @vitest-environment jsdom
// Tracing a bitmap in the Engrave panel (#252): the Add-menu entry, the dialog's live trace
// controls, the accepted item.
//
// Two seams only, both at the browser edge: the file PICKER (`openBinaryFile`, #196) and the
// image DECODER (there is no `createImageBitmap` in jsdom). The tracer, the outline finalizer,
// the size control and the store all run for real, so what this exercises is the whole path a
// user takes — including that moving a control re-traces the picture rather than only its label.

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
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { setRasterDecodeLoader } from '@/engine/import/imageDecode';
import { MM_PER_PX, type RasterImage } from '@/engine/import/rasterOutline';
import { openBinaryFile, openTextFile } from '@/utils/openTextFile';
import type { EngraveVectorShape } from '@/types/engraveJob';

vi.mock('@/utils/openTextFile', () => ({
  openTextFile: vi.fn(),
  openBinaryFile: vi.fn(),
  MAX_TEXT_FILE_BYTES: 64 * 1024 * 1024,
  MAX_IMAGE_FILE_BYTES: 32 * 1024 * 1024,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

/** An RGBA bitmap from a per-pixel luminance, so a fixture reads as the picture it stands for. */
function raster(w: number, h: number, lum: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = lum(x, y);
      const p = (y * w + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const inRect = (x: number, y: number, x0: number, x1: number, y0: number, y1: number): boolean =>
  x >= x0 && x < x1 && y >= y0 && y < y1;

/** A 32 px black square on white — the simplest thing to cut. */
const BLACK_SQUARE = raster(64, 64, (x, y) => (inRect(x, y, 16, 48, 16, 48) ? 0 : 255));
/** The same square with one stray black pixel — a speck only despeckle removes. */
const SQUARE_AND_SPECK = raster(64, 64, (x, y) =>
  inRect(x, y, 16, 48, 16, 48) || (x === 2 && y === 2) ? 0 : 255,
);
/** A dark square left and a mid-grey square right: the threshold decides how WIDE the picture is. */
const TWO_GREYS = raster(64, 64, (x, y) => {
  if (inRect(x, y, 4, 24, 20, 44)) return 0;
  if (inRect(x, y, 40, 60, 20, 44)) return 200;
  return 255;
});

let decoded: RasterImage = BLACK_SQUARE;

/** Open the dialog on a picked, decoded image and wait for it. */
async function openImage(name = 'logo.png', image: RasterImage = BLACK_SQUARE): Promise<HTMLElement> {
  decoded = image;
  vi.mocked(openBinaryFile).mockResolvedValue({ name, size: 1234 } as unknown as File);
  render(<EngravePanel />);
  fireEvent.click(screen.getByTestId('engrave-add-trace-image'));
  return await screen.findByTestId('engrave-import-dialog');
}

/** The dialog's own header line — the format, the shape count and the point count. */
function dialogMeta(): string {
  return screen.getByTestId('engrave-import-dialog').textContent ?? '';
}

function theVector(): EngraveVectorShape {
  const vectors = useEngraveJobStore.getState().job.vectors ?? [];
  if (vectors.length !== 1) throw new Error(`expected 1 vector, found ${vectors.length}`);
  return vectors[0]!;
}

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  setRasterDecodeLoader(async () => async () => decoded);
  useSettingsStore.getState().resetSettings();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose();
  vi.mocked(openTextFile).mockReset();
  vi.mocked(openBinaryFile).mockReset();
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

describe('EngravePanel — tracing a bitmap (#252)', () => {
  it('offers “Trace image…” and opens the dialog on a traced bitmap, with its controls', async () => {
    const dialog = await openImage();
    expect(dialog).toBeTruthy();
    expect(dialogMeta()).toContain('RASTER · 1 closed shape');

    // The 32 px square, at 96 px/inch, with the scale called out as an assumption.
    expect(screen.getByTestId('engrave-import-source-size').textContent).toContain(
      (32 * MM_PER_PX).toFixed(2),
    );
    const warn = screen.getByTestId('engrave-import-unit-warning');
    expect(warn.textContent).toContain('96 px/inch');

    // The controls, at their defaults, and the source size they are read against.
    expect((screen.getByTestId('engrave-trace-threshold') as HTMLInputElement).value).toBe('128');
    expect((screen.getByTestId('engrave-trace-despeckle') as HTMLInputElement).value).toBe('8');
    expect((screen.getByTestId('engrave-trace-simplify') as HTMLInputElement).value).toBe('1');
    expect(screen.getByTestId('engrave-trace-scale').textContent).toContain('64 × 64 px');

    // And the preview really drew the traced rings.
    const path = screen.getByTestId('engrave-import-preview').querySelector('path');
    expect(path?.getAttribute('d') ?? '').toContain('M');
  });

  it('re-traces live as the threshold moves', async () => {
    await openImage();
    // Nothing is darker than 0, so the picture traces to no ink at all — and the dialog says so
    // instead of offering an empty region to add.
    fireEvent.change(screen.getByTestId('engrave-trace-threshold'), { target: { value: '0' } });
    expect(screen.getByTestId('engrave-import-empty')).toBeTruthy();
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(true);

    // Back above the ink's luminance, and the square is there again.
    fireEvent.change(screen.getByTestId('engrave-trace-threshold'), { target: { value: '200' } });
    expect(screen.queryByTestId('engrave-import-empty')).toBeNull();
    expect(dialogMeta()).toContain('RASTER · 1 closed shape');
    expect((screen.getByTestId('engrave-import-accept') as HTMLButtonElement).disabled).toBe(false);
  });

  it('despeckle drops the stray pixel, and turning it off brings it back', async () => {
    await openImage('dirty.png', SQUARE_AND_SPECK);
    expect(dialogMeta()).toContain('1 closed shape');
    // 1 px is below the 8 px default, so it is gone; the note says what was dropped.
    expect(screen.getByTestId('engrave-import-notes').textContent).toContain('speck');

    fireEvent.change(screen.getByTestId('engrave-trace-despeckle'), { target: { value: '0' } });
    expect(dialogMeta()).toContain('2 closed shapes');
  });

  it('inverting traces the light artwork instead', async () => {
    await openImage('negative.png', raster(64, 64, (x, y) => (inRect(x, y, 16, 48, 16, 48) ? 255 : 0)));
    // Dark ink first: the black field, so the ring count includes the hole the square punches.
    expect(dialogMeta()).toContain('2 closed shapes');
    fireEvent.click(screen.getByTestId('engrave-trace-invert'));
    expect(dialogMeta()).toContain('1 closed shape');
  });

  it('keeps the target width following the trace until the user types one', async () => {
    await openImage('greys.png', TWO_GREYS);
    const sourceW = 20 * MM_PER_PX; // the dark square alone, at the default threshold
    expect(screen.getByTestId('engrave-import-target-width').getAttribute('value')).toBe(
      sourceW.toFixed(2),
    );

    // A threshold that also catches the grey square widens the picture — and the untouched target
    // width follows it, so the two numbers never disagree.
    fireEvent.change(screen.getByTestId('engrave-trace-threshold'), { target: { value: '220' } });
    const wider = 56 * MM_PER_PX;
    expect(screen.getByTestId('engrave-import-target-width').getAttribute('value')).toBe(
      wider.toFixed(2),
    );

    // Typed, it pins — a user who set a width expects to keep it.
    fireEvent.change(screen.getByTestId('engrave-import-target-width'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('engrave-trace-threshold'), { target: { value: '128' } });
    expect(screen.getByTestId('engrave-import-target-width').getAttribute('value')).toBe('30');
    expect(screen.getByTestId('engrave-import-final-size').textContent).toContain('30.00');
  });

  it('adds the accepted trace as an ordinary vector item', async () => {
    await openImage('logo.png');
    fireEvent.click(screen.getByTestId('engrave-import-accept'));
    expect(screen.queryByTestId('engrave-import-dialog')).toBeNull();

    const v = theVector();
    expect(v.sourceName).toBe('logo.png');
    expect(v.fillRule).toBe('EvenOdd');
    expect(v.contours).toHaveLength(1);
    expect(v.width).toBeCloseTo(32 * MM_PER_PX, 5);
    expect(screen.getByTestId('engrave-vector-row-0')).toBeTruthy();
  });

  it('does nothing when the picker is cancelled, and shows no trace controls for an SVG', async () => {
    vi.mocked(openBinaryFile).mockResolvedValue(null);
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-trace-image'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('engrave-import-dialog')).toBeNull();
    expect(useEngraveJobStore.getState().job.vectors ?? []).toHaveLength(0);

    // The vector path is untouched: the same dialog, no trace panel.
    vi.mocked(openTextFile).mockResolvedValue({
      name: 'square.svg',
      text: '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><path d="M0 0 H10 V10 H0 Z"/></svg>',
    });
    fireEvent.click(screen.getByTestId('engrave-add-import-outline'));
    await screen.findByTestId('engrave-import-dialog');
    expect(dialogMeta()).toContain('SVG · 1 closed shape');
    expect(screen.queryByTestId('engrave-trace-controls')).toBeNull();
  });
});
