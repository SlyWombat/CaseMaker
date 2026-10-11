// The simulation's sacrificial swatch (#213 §4) — app chrome, not scene content.
//
// It was the same drei `<Html fullscreen>` the engrave legend was (#349): the wrapper tracks the
// scene ORIGIN's projected screen position and the inner div is offset back, which cancels only
// while that projection is finite and the canvas clips it — orbit past that and the label lands
// somewhere else entirely. A swatch keyed to a layer toggle has no position in the scene, so it is
// DOM beside the canvas, like `SimTransport` and `EngraveLegend`.
//
// The "is there anything to draw" test is the same one `SimMeshes` makes (`drawsSacrificial`), read
// off the same store, so the swatch cannot appear while the material is absent from the scene.

import type { CSSProperties, JSX } from 'react';
import { drawsSacrificial, SACRIFICIAL_COLOR, sacrificialMesh } from './simGeometry';
import { useSimStore } from '@/store/simStore';

/** Top-right, under the engrave legend's own corner — the two never show at once (#197, #205). */
const BOX: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 'var(--cm-z-viewport-chrome)', // the one stacking scale (#348), src/styles/tokens.css
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  background: 'rgba(20,25,30,0.82)',
  border: '1px solid #2a2f36',
  borderRadius: 4,
  padding: '3px 6px',
  color: '#d1d5db',
  fontSize: 11,
  lineHeight: 1.6,
  pointerEvents: 'none',
};

const SWATCH: CSSProperties = {
  width: 10,
  height: 10,
  background: SACRIFICIAL_COLOR,
  border: '1px solid #00000055',
  display: 'inline-block',
};

export function SimLegend(): JSX.Element | null {
  const layers = useSimStore((s) => s.layers);
  const frame = useSimStore((s) => s.frame);
  const meshes = useSimStore((s) => s.meshes);

  if (!drawsSacrificial(layers, sacrificialMesh(frame, meshes) !== null)) return null;

  return (
    <div data-testid="sim-legend-sacrificial" style={BOX}>
      <span style={SWATCH} />
      sacrificial
    </div>
  );
}
