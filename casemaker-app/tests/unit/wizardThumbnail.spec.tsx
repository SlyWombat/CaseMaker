// @vitest-environment jsdom
// #1099 — the file, drawn: a mesh thumbnail painted from the stored STL, a drawing's rings and
// paths, and the facts line beside each.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WizardThumbnail } from '@/components/welcome/WizardThumbnail';
import type { OutlineImport } from '@/engine/import/outlineImport';

const HERE = dirname(fileURLToPath(import.meta.url));
const STL = join(HERE, '..', 'fixtures', 'goals', 'thin-wall-box.stl');
// The house's own meshes: the sample set the acceptance names (STL, both encodings). A missing
// samples/ folder (a flattened copy) is a skip, not a green pass dressed as one.
const SAMPLES = join(HERE, '..', '..', '..', 'samples');
const SAMPLE_MESHES = existsSync(SAMPLES)
  ? readdirSync(SAMPLES)
      .filter((f) => f.toLowerCase().endsWith('.stl'))
      .sort()
  : [];

const draw = vi.hoisted(() => ({ fills: 0, strokes: 0, contexts: 0 }));

beforeAll(() => {
  // jsdom has no 2D canvas backend; the component's contract is that it DRAWS, so the context is
  // recorded. Every method the painter uses is here (the painter adds no new ones silently).
  const context = {
    clearRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    fill: () => {
      draw.fills++;
    },
    stroke: () => {
      draw.strokes++;
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    draw.contexts++;
    return context as unknown as CanvasRenderingContext2D;
  } as never;
});

afterEach(cleanup);

describe('#1099 — the thumbnail', () => {
  it('a mesh paints from its stored STL and states its box, triangle count and file', async () => {
    const data = readFileSync(STL).toString('base64');
    render(
      <WizardThumbnail
        source={{ kind: 'mesh', name: 'thin-wall-box.stl', data, size: { x: 20, y: 20, z: 10 } }}
      />,
    );
    expect(screen.getByTestId('wizard-thumbnail-canvas')).toBeDefined();
    // The paint runs in an effect, before the frame is presented: the fill lands at once.
    await waitFor(() => expect(draw.fills).toBeGreaterThan(0));
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toContain('20 × 20 × 10 mm');
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toContain('triangles');
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toContain('from thin-wall-box.stl');
  });

  // #1099 item 9 — every mesh the house ships as a sample paints, with no wall-clock assertion:
  // the draw call completes, which is what a thumbnail must do for a STEP/3MF/OBJ converted at
  // the door (all of them arrive here as STL).
  it('every mesh file in samples/ paints its thumbnail', async () => {
    expect(SAMPLE_MESHES.length).toBeGreaterThan(0);
    for (const name of SAMPLE_MESHES) {
      draw.fills = 0;
      const data = readFileSync(join(SAMPLES, name)).toString('base64');
      // The painter reads the mesh's own positions; the size prop only feeds the facts line.
      render(<WizardThumbnail source={{ kind: 'mesh', name, data, size: { x: 1, y: 1, z: 1 } }} />);
      await waitFor(() => expect(draw.fills, name).toBeGreaterThan(0));
      cleanup();
    }
  });

  it('a drawing draws every path and says how many are open', () => {
    const outline: OutlineImport = {
      format: 'svg',
      sourceName: 'sign.svg',
      contours: [[[0, 0], [40, 0], [40, 40], [0, 40]]],
      paths: [
        { points: [[0, 0], [40, 0], [40, 40], [0, 40]], closed: true },
        { points: [[5, 5], [35, 5]], closed: false },
      ],
      fillRule: 'NonZero',
      width: 60,
      height: 60,
      notes: [],
    };
    render(<WizardThumbnail source={{ kind: 'outline', outline }} />);
    const svg = screen.getByTestId('wizard-thumbnail-outline');
    expect(svg.querySelectorAll('path').length).toBe(3); // one contour + two paths
    // #1099 item 4 — the facts count SHAPES (the filled rings) and name the open lines, never "paths".
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toBe('60 × 60 mm · 1 shape · 1 open line');
  });

  // #1099 item 4 — a filled two-ring drawing is two shapes, and a zero open term is omitted.
  it('a filled two-ring drawing reads 2 shapes', () => {
    const outline: OutlineImport = {
      format: 'svg',
      sourceName: 'washer.svg',
      contours: [
        [[0, 0], [60, 0], [60, 60], [0, 60]],
        [[20, 20], [40, 20], [40, 40], [20, 40]],
      ],
      paths: [],
      fillRule: 'NonZero',
      width: 60,
      height: 60,
      notes: [],
    };
    render(<WizardThumbnail source={{ kind: 'outline', outline }} />);
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toBe('60 × 60 mm · 2 shapes');
  });

  // #1099 item 3 — a picture states what was read: its pixels, its millimetres and the scale.
  it('a picture states its pixels, millimetres and mm/px', () => {
    render(
      <WizardThumbnail
        source={{ kind: 'picture', name: 'relief.png', data: '', size: { x: 51.2, y: 51.2, z: 0.1 } }}
      />,
    );
    const img = screen.getByTestId('wizard-thumbnail-picture') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 512, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 512, configurable: true });
    fireEvent.load(img);
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toBe(
      '512 × 512 px → 51.2 × 51.2 mm at 0.1 mm/px',
    );
  });

  // #1099 item 2 — the board's outline thumbnail and the set's file count.
  it('a read board shows its outline thumbnail and its facts', () => {
    render(<WizardThumbnail source={{ kind: 'board', board: { length: 80, width: 60 }, files: 5 }} />);
    expect(screen.getByRole('img', { name: 'The board outline' })).toBeDefined();
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toBe('80 × 60 mm · 5 Gerber files');
  });

  it('carries the stock proposal sentence when the caller has one', () => {
    const outline: OutlineImport = {
      format: 'svg',
      sourceName: 'coaster.svg',
      contours: [[[0, 0], [60, 0], [60, 60], [0, 60]]],
      fillRule: 'NonZero',
      width: 60,
      height: 60,
      notes: [],
    };
    render(
      <WizardThumbnail
        source={{ kind: 'outline', outline }}
        sentence="Will cut on a 70 × 70 × 12 mm plate — change on the next step."
      />,
    );
    expect(screen.getByTestId('wizard-thumbnail-sentence').textContent).toContain('70 × 70 × 12');
  });
});
