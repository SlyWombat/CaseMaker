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
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
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
  // `frame`/`meshes` too: the #361 test below puts a sacrificial body in the sim store, and a
  // leftover would make the sim swatch render in a test that is about the engRAVE legend.
  useSimStore.setState({
    status: 'idle',
    pathOnly: false,
    layers: DEFAULT_SIM_LAYERS,
    frame: null,
    meshes: null,
  });
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

/**
 * #361 — the two legends share ONE anchor.
 *
 * They occupy the same corner and never show at once (`Viewport` gates each on the scene), so an
 * edit that moved one and left the other would go unnoticed until someone opened the other scene at
 * the width where the toolbar wraps. Both read the single variable `Viewport` publishes off the
 * measured toolbar; the assertion is that the rendered `top` is the same expression, driven by that
 * variable and not by a number either file could drift to on its own.
 *
 * jsdom has no layout and no `ResizeObserver`, so nothing is measured here and the variable is
 * unset — which is exactly the case the fallback exists for: both legends still resolve their `top`
 * from the same expression, and it is the pre-#361 `8px` (the fallback is `0px` plus the same
 * `8px` gutter), so the mouse-level unit tests around this one keep seeing the layout they always
 * saw. The browser numbers are `viewportEngraveToolbar.spec.ts`'s job.
 */
describe('#361 — both CNC legends clear the toolbar by one rule', () => {
  /** A sacrificial body only has to EXIST for `SimLegend` to render; nothing reads its triangles. */
  const anyBody: NodeMeshOutput = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    triangleCount: 1,
    vertexCount: 3,
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    componentCount: 1,
  };

  it('renders the same top for the depth legend and the sacrificial swatch', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    const view = render(<Viewport />);
    const engraveTop = (screen.getByTestId('engrave-preview-legend') as HTMLElement).style.top;
    view.unmount();

    useViewportStore.setState({ activeSidebarSection: 'cnc-sim' });
    useSimStore.setState({
      status: 'ready',
      frame: { k: 0, stock: anyBody, removalSoFar: null, sacrificial: anyBody },
    });
    render(<Viewport />);
    const simTop = (screen.getByTestId('sim-legend-sacrificial') as HTMLElement).style.top;

    expect(engraveTop, 'the depth legend is anchored to the measured toolbar').toContain(
      '--cm-viewport-toolbar-bottom',
    );
    expect(simTop, 'the swatch takes the same anchor').toBe(engraveTop);
    // The pre-#361 value, from the fallback: a legend that lost the variable by accident would land
    // here too, so the assertion above is what pins the pair, and this pins the fallback itself.
    expect(engraveTop.startsWith('calc(var(--cm-viewport-toolbar-bottom, 0px)')).toBe(true);
  });
});
