// @vitest-environment jsdom
// #349 — the engrave depth legend is DOM, not scene content.
//
// It used to be a drei `<Html fullscreen>`: the wrapper is translated to the scene origin's
// PROJECTED screen position and the inner div is offset back, which cancels only while the
// projection is finite and the canvas clips it. Orbit until the origin leaves the frustum and the
// legend lands over the app chrome. Nothing here builds a canvas, a renderer or a WebGL context —
// that is the point of the test: a legend that needs none cannot be misplaced by a camera.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { EngraveLegend } from '@/components/viewport/EngraveLegend';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { EngraveJob } from '@/types/engraveJob';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { createEngravePreviewer } from '@/workers/sim/engravePreview';
import { tl } from './helpers/manifoldExec';
import { preview as previewOf } from './helpers/engravePipeline';

const previewer = createEngravePreviewer(tl);
let gen = 0;

/** `job`'s own preview, on a fresh generation so nothing is ever stale (#205). */
function previewFor(job: EngraveJob = defaultEngraveJob()): NonNullable<ReturnType<typeof previewOf>> {
  const p = previewOf(previewer, job, ++gen);
  if (p === null) throw new Error('a fresh generation must produce a preview');
  return p;
}

beforeEach(() => {
  useEngravePreviewStore.setState({ preview: null });
});

afterEach(cleanup);

describe('the engrave depth legend (#349)', () => {
  it('renders nothing at all until a preview has landed', () => {
    const { container } = render(<EngraveLegend />);
    expect(container.querySelector('[data-testid="engrave-preview-legend"]')).toBeNull();
  });

  it('lists the job’s distinct depths with no canvas, and takes no pointer events', () => {
    useEngravePreviewStore.setState({ preview: previewFor() });
    render(<EngraveLegend />);

    const box = screen.getByTestId('engrave-preview-legend');
    // The shipped job's three labels, shallowest first — the order the floors are ramped in.
    for (const [d, words] of [['0.5', '0.5 mm'], ['1', '1.0 mm'], ['2', '2.0 mm']] as const) {
      expect(screen.getByTestId(`engrave-legend-${d}`).textContent).toContain(words);
    }
    // A depth the job does not cut gets no row.
    expect(screen.queryByTestId('engrave-legend-3.5')).toBeNull();
    // #229 — the legend must never swallow the toolbar's clicks, and here that is one CSS
    // property rather than a workaround for drei's internal wrapper div.
    expect(box.style.pointerEvents).toBe('none');
  });

  it('gives the sacrificial material and a declared void their own swatches', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      sacrificial: presetPartOnBoard(),
      keepOuts: [
        {
          id: 'ko-1',
          name: 'Magnet pocket',
          kind: 'rect',
          position: { x: 50, y: 30 },
          rotation: 0,
          enabled: true,
          zCeiling: 8,
          width: 20,
          height: 10,
          cornerRadius: 0,
        },
      ],
    };
    // The preview comes from the job that carries them — the legend reads the preview, not the job.
    useEngraveJobStore.setState({ job });
    useEngravePreviewStore.setState({ preview: previewFor(job) });
    render(<EngraveLegend />);

    expect(screen.getByTestId('engrave-legend-sacrificial').textContent).toContain('sacrificial');
    expect(screen.getByTestId('engrave-legend-void').textContent).toContain('void under the face');
  });
});
