// @vitest-environment jsdom
// #349 — the engrave depth legend is DOM, not scene content.
//
// It used to be a drei `<Html fullscreen>`: the wrapper is translated to the scene origin's
// PROJECTED screen position and the inner div is offset back, which cancels only while the
// projection is finite and the canvas clips it. Orbit until the origin leaves the frustum and the
// legend lands over the app chrome. Nothing here builds a canvas, a renderer or a WebGL context —
// that is the point of the test: a legend that needs none cannot be misplaced by a camera.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngraveLegend } from '@/components/viewport/EngraveLegend';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

// #516 item 5 — the default job no longer seeds a cutter; the recommendation names `flat-1.0`.
// These engine tests need the job to name its cutter, so `dj()` applies that recommendation.
function dj(...args: Parameters<typeof defaultEngraveJob>): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob(...args);
  job.toolKey = 'flat-1.0';
  return job;
}
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
function previewFor(job: EngraveJob = dj()): NonNullable<ReturnType<typeof previewOf>> {
  const p = previewOf(previewer, job, ++gen);
  if (p === null) throw new Error('a fresh generation must produce a preview');
  return p;
}

beforeEach(() => {
  useEngravePreviewStore.setState({ preview: null, scrubStage: null });
  // The sacrificial/void test leaves its own job in the store; reset it so these three do not
  // depend on running in this order (review of ebf38c5).
  useEngraveJobStore.setState({ job: dj() });
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

  it('states the registration band’s widest tolerance with its own swatch (§5.4)', () => {
    const p = previewFor();
    useEngravePreviewStore.setState({ preview: p });
    render(<EngraveLegend />);

    const widest = Math.max(...p.registration.map((b) => b.uncertainty));
    expect(p.registration.length).toBeGreaterThan(0);
    expect(screen.getByTestId('engrave-legend-registration').textContent).toContain(`registration ±${widest} mm`);
  });

  it('gives the sacrificial material and a declared void their own swatches', () => {
    const job: EngraveJob = {
      ...dj(),
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

// #170 — a blank that states its colour split is not drawn on the depth ramp (`floorColor`), so a
// ramp of depth swatches would name colours the meshes are NOT in. The legend says which two colours
// the floors are drawn in instead, where they part, and that the colours are stand-ins.
describe('the engrave legend on a blank that states its split (#170)', () => {
  /** The shipped job, printed: a 1 mm top colour on a 12 mm blank puts the boundary 1 mm down. */
  function printed(capMm = 1): EngraveJob {
    const job = dj();
    job.stock.colour = { kind: 'printed', capMm, layerHeight: 0.2, firstLayerHeight: 0.2 };
    useEngraveJobStore.setState({ job });
    return job;
  }

  it('names the two colours and the plane they part at, instead of a ramp of depths', () => {
    // Split 11 mm up from the back face → 1.0 mm down from the engraved face, which is a layer line
    // exactly, so the 0.5 mm floor is top colour and the 1.0 and 2.0 mm floors are through it.
    const job = printed();
    useEngravePreviewStore.setState({ preview: previewFor(job) });
    render(<EngraveLegend />);

    const top = screen.getByTestId('engrave-legend-top');
    const bottom = screen.getByTestId('engrave-legend-bottom');
    // The two things the eye has to tell apart, and the word "stand-in" out loud: nothing in the app
    // maps an extruder to a colour (the swatches themselves are `splitColor`'s, and `floorColor`'s
    // tests in engravePreview.spec.ts pin that the floors came from the same pair).
    expect(top.textContent).toContain('top colour (stand-in)');
    expect(bottom.textContent).toContain('bottom colour (stand-in)');
    // …and the plane they are read against, as the depth it sits at — it is not a colour a floor
    // lands IN. Written through the app's own depth formatter (`mm`), so the split reads like every
    // other depth: `1`, not `1.00` (#170 review).
    expect(screen.getByTestId('engrave-legend-split').textContent).toContain('split 1 mm down');

    // The ramp's rows are gone — 0.5/1/2 mm are depths the floors have, and naming them here would
    // be naming colours the picture is not drawn in.
    expect(screen.queryByTestId('engrave-legend-0.5')).toBeNull();
    expect(screen.queryByTestId('engrave-legend-1')).toBeNull();
    expect(screen.queryByTestId('engrave-legend-2')).toBeNull();
    // The header says which of the two readings is in force.
    const box = screen.getByTestId('engrave-preview-legend');
    expect(box.textContent).toContain('Colour');
    expect(box.textContent).not.toContain('Depth');
  });

  it('keeps the ramp for a blank that states none — the two readings do not leak into each other', () => {
    useEngravePreviewStore.setState({ preview: previewFor(dj()) });
    render(<EngraveLegend />);

    expect(screen.queryByTestId('engrave-legend-top')).toBeNull();
    expect(screen.queryByTestId('engrave-legend-split')).toBeNull();
    expect(screen.getByTestId('engrave-legend-2').textContent).toContain('2.0 mm');
  });

  it('states the lost layer’s area with its own swatch (§5.7)', () => {
    const p = previewFor(dj());
    useEngravePreviewStore.setState({ preview: p });
    render(<EngraveLegend />);

    const total = p.lost.reduce((sum, l) => sum + l.area, 0);
    expect(p.lost.length).toBeGreaterThan(0);
    // The row totals the per-item areas the meshes were drawn from, at the sheet's precision.
    expect(screen.getByTestId('engrave-legend-lost').textContent).toContain(`${Number(total.toFixed(2))} mm²`);
  });

  it('shows no lost row when nothing is lost', () => {
    const job = dj();
    job.labels.forEach((l) => {
      l.enabled = false;
    });
    useEngraveJobStore.setState({ job });
    useEngravePreviewStore.setState({ preview: previewFor(job) });
    render(<EngraveLegend />);

    expect(screen.queryByTestId('engrave-legend-lost')).toBeNull();
  });

  // §5.7 — the slider is viewport chrome, and moving it is a VIEW act: it must not reach the job
  // store, so the panel's document cannot become dirty and the worker is not asked to rebuild.
  describe('the design ↔ as-cut slider (§5.7)', () => {
    it('renders one step per cut depth, starting at as cut, and only the control takes pointers', () => {
      const p = previewFor();
      useEngravePreviewStore.setState({ preview: p });
      render(<EngraveLegend />);

      const slider = screen.getByTestId('engrave-scrub') as HTMLInputElement;
      expect(slider.type).toBe('range');
      expect(slider.min).toBe('0');
      expect(slider.max).toBe(String(p.stages.length));
      // The default preview is the finished one: no edit, no scrub, the picture the panel shipped.
      expect(slider.value).toBe(String(p.stages.length));
      expect(screen.getByTestId('engrave-scrub-state').textContent).toBe('as cut');
      // #229 still holds for the legend box; only the control's own row opts back in.
      expect((screen.getByTestId('engrave-preview-legend') as HTMLElement).style.pointerEvents).toBe('none');
      expect((screen.getByTestId('engrave-scrub-row') as HTMLElement).style.pointerEvents).toBe('auto');
    });

    it('writes only the preview store — never the job — and withholds the lost layer mid-scrub', () => {
      const p = previewFor();
      useEngravePreviewStore.setState({ preview: p, scrubStage: null });
      const jobBefore = useEngraveJobStore.getState().job;
      render(<EngraveLegend />);
      expect(screen.getByTestId('engrave-legend-lost')).not.toBeNull();

      fireEvent.change(screen.getByTestId('engrave-scrub'), { target: { value: '0' } });

      // Position 0 is the uncut design: no floor has been cut yet, so the lost layer is not a claim
      // about anything on screen and its row is withheld with the amber mesh.
      expect(useEngravePreviewStore.getState().scrubStage).toBe(0);
      expect(screen.getByTestId('engrave-scrub-state').textContent).toBe('design (uncut)');
      expect(screen.queryByTestId('engrave-legend-lost')).toBeNull();
      // The one rule that matters for the control: no job write. Identity, not deep equality —
      // any `set` on the document would replace the object and trigger a preview rebuild.
      expect(useEngraveJobStore.getState().job).toBe(jobBefore);
      expect(useEngravePreviewStore.getState().preview).toBe(p);
    });

    it('is absent when the job cuts nothing, because there is no second state to show', () => {
      const job = dj();
      job.labels.forEach((l) => {
        l.enabled = false;
      });
      useEngraveJobStore.setState({ job });
      useEngravePreviewStore.setState({ preview: previewFor(job) });
      render(<EngraveLegend />);

      expect(screen.queryByTestId('engrave-scrub')).toBeNull();
    });
  });

  it('still says nothing is cut when the blank has a split and no label is on (#170 review)', () => {
    // The split branch is taken on the BLANK's own print, not on anything being cut — so it is
    // reached with nothing on the face at all, where the two colour rows describe a blank and could
    // otherwise read as a picture that failed to draw. The note comes from the same emptiness the
    // ramp branch reports, so the two readings answer this question identically.
    const job = printed();
    job.labels.forEach((l) => {
      l.enabled = false;
    });
    useEngraveJobStore.setState({ job });
    useEngravePreviewStore.setState({ preview: previewFor(job) });
    render(<EngraveLegend />);

    // The colours and the plane are still stated — they are facts about the blank.
    expect(screen.getByTestId('engrave-legend-top')).not.toBeNull();
    expect(screen.getByTestId('engrave-legend-split').textContent).toContain('split 1 mm down');
    expect(screen.getByTestId('engrave-legend-nothing-cut').textContent).toContain('nothing cut');
  });
});
