// @vitest-environment jsdom
/**
 * #1073 — THE GRAPHIC IS THE DELIVERABLE (the maintainer, 2026-11-07): a top view of the blank
 * before and after, the bracket's two arms, the corner in the fence and whether it is the blank's
 * square corner, the bores (frame) or the freed part (vendor), and BOTH methods' costs on the
 * choice.
 *
 * RED at 9512a7fc5: the component does not exist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { FlipDiagram } from '@/components/ui/FlipDiagram';

afterEach(() => cleanup());

const BLANK = { lengthMm: 100, widthMm: 60 };

describe('#1073 the flip graphic', () => {
  it('frame method: the bores on both views, the fenced corner marked not square, both costs', () => {
    render(
      <FlipDiagram
        {...BLANK}
        flip={{ method: 'tabs-in-blank', axis: 'left-right' }}
        squareCorners={['FL']}
        pins={[{ x: 30, y: 56 }, { x: 70, y: 56 }]}
        breakthroughMm={0.3}
      />,
    );
    // The bores are drawn on the before view AND the after view: two each.
    expect(screen.getAllByTestId('flip-hole')).toHaveLength(4);
    // The after panel names the corner that lands in the fence and that it is not square.
    const labels = screen.getAllByTestId('flip-fence-label').map((n) => n.textContent ?? '');
    expect(labels.some((t) => t.includes('FR in the fence — not square'))).toBe(true);
    // The blank's one stated square corner is marked.
    expect(screen.getAllByTestId('flip-square-FL')).toHaveLength(2);
    // BOTH methods' costs print, the chosen one emphatic.
    expect(screen.getByTestId('flip-cost-frame').textContent).toContain('the part stays in the blank on tabs');
    expect(screen.getByTestId('flip-cost-vendor').textContent).toContain('0.3 mm through the outline into the board');
    expect(screen.getByTestId('flip-cost-frame').style.fontWeight).toBe('600');
    expect(screen.getByTestId('flip-cost-vendor').style.fontWeight).toBe('400');
    expect(screen.getByTestId('flip-axis-arrow')).toBeTruthy();
  });

  it('vendor method: no bores, the freed part drawn, its groove cost emphatic', () => {
    render(
      <FlipDiagram
        {...BLANK}
        flip={{ method: 'free-then-flip', axis: 'front-back' }}
        squareCorners={['FL']}
        breakthroughMm={0.3}
        part={{ minX: 20, minY: 10, maxX: 80, maxY: 50 }}
      />,
    );
    expect(screen.queryAllByTestId('flip-hole')).toHaveLength(0);
    // The part's outline is drawn on the before view and the reflected after view.
    expect(screen.getAllByTestId('flip-part')).toHaveLength(2);
    expect(screen.getByTestId('flip-cost-vendor').style.fontWeight).toBe('600');
    // Front↔back: the fenced corner is BL, and the one-right-angle blank says it is not square.
    const labels = screen.getAllByTestId('flip-fence-label').map((n) => n.textContent ?? '');
    expect(labels.some((t) => t.includes('BL in the fence — not square'))).toBe(true);
  });

  it('a dimensioned blank reads its fenced corner as square', () => {
    render(<FlipDiagram {...BLANK} flip={{ method: 'tabs-in-blank', axis: 'left-right' }} />);
    const labels = screen.getAllByTestId('flip-fence-label').map((n) => n.textContent ?? '');
    expect(labels.some((t) => t.includes('FR in the fence — square'))).toBe(true);
  });
});
