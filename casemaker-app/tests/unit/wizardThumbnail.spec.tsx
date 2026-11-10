// @vitest-environment jsdom
// #1099 — the file, drawn: a mesh thumbnail painted from the stored STL, a drawing's rings and
// paths, and the facts line beside each.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { WizardThumbnail } from '@/components/welcome/WizardThumbnail';
import type { OutlineImport } from '@/engine/import/outlineImport';

const HERE = dirname(fileURLToPath(import.meta.url));
const STL = join(HERE, '..', 'fixtures', 'goals', 'thin-wall-box.stl');

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
    await waitFor(() => expect(draw.fills).toBeGreaterThan(0), { timeout: 300 });
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toContain('20 × 20 × 10 mm');
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toContain('triangles');
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toContain('from thin-wall-box.stl');
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
    expect(screen.getByTestId('wizard-thumbnail-facts').textContent).toBe('60 × 60 mm · 2 paths · 1 open');
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
