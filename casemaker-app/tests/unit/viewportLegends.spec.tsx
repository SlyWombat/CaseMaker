// @vitest-environment jsdom
// #349 (review of ebf38c5) — WHICH legend is up follows the SCENE, not the section.
//
// `EngraveLegend` is DOM beside the canvas, and `Viewport` gated it on the Engrave SECTION alone.
// But opening that section does not take the viewport from a loaded simulation: `SceneMeshes` keeps
// the sim's meshes (a sim is disposed only from cancel/close), so the Depth legend painted over a
// scene it does not describe — on top of `SimLegend` at the same `top:8; right:8`. While the legend
// lived inside `EngravePreview` it followed the scene for free; as DOM it has to be told. This
// mounts the real component and asserts the pair.
//
// The canvas, the renderer and three's own components are mocked out: the subject here is which
// legend `Viewport` COMPOSES, and a WebGL context under jsdom could only make this fail for
// reasons that are not the gate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Only the CANVAS is swapped: it is the one thing that would want a WebGL context, and nothing
// inside it is rendered, so three's own components (and the canvas's own children) never run.
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  Canvas: (): null => null,
}));

import { Viewport } from '@/components/viewport/Viewport';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useViewportStore } from '@/store/viewportStore';
import { DEFAULT_SIM_LAYERS, useSimStore } from '@/store/simStore';
import { createEngravePreviewer } from '@/workers/sim/engravePreview';
import { tl } from './helpers/manifoldExec';
import { preview as previewOf } from './helpers/engravePipeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const previewer = createEngravePreviewer(tl);
let gen = 0;

beforeEach(() => {
  cleanup();
  // A real preview, so "the legend is absent" can only be the gate — not an empty store.
  const p = previewOf(previewer, defaultEngraveJob(), ++gen);
  if (p === null) throw new Error('a fresh generation must produce a preview');
  useEngravePreviewStore.setState({ preview: p });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
  useSimStore.setState({ status: 'idle', pathOnly: false, layers: DEFAULT_SIM_LAYERS });
});

afterEach(cleanup);

describe('#349 — the two CNC legends follow the scene', () => {
  it('shows the depth legend while the Engrave section owns the viewport', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<Viewport />);
    expect(screen.getByTestId('engrave-preview-legend')).toBeDefined();
    expect(screen.queryByTestId('sim-transport')).toBeNull();
  });

  it('keeps it down while a LOADED simulation owns the viewport, section open or not', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    useSimStore.setState({ status: 'ready' });
    render(<Viewport />);
    // The simulation is what owns the scene in this render — the witness that the gate, and not
    // a missing preview, is what took the depth legend away.
    expect(screen.getByTestId('sim-transport')).toBeDefined();
    expect(screen.queryByTestId('engrave-preview-legend')).toBeNull();
  });
});
