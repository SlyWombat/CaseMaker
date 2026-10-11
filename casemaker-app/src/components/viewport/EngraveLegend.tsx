// The engrave preview's depth legend (#205, #349).
//
// It is APP CHROME, not scene content: a plain DOM element over the canvas, a sibling of it in
// `Viewport.tsx` — the same shape `SimTransport` uses. It used to be a drei `<Html fullscreen>`,
// which anchors its wrapper to the scene ORIGIN's projected screen position and then offsets the
// inner div back by the same amount. That cancels only while the projection is finite and the
// wrapper is clipped by the canvas; orbit the camera until the origin projects off-screen (or
// behind it) and the legend lands wherever the arithmetic puts it — over the header, in the report
// that filed this. Nothing about a legend is spatial, so nothing about it should be projected.
//
// Being DOM also retires #229's workaround: a non-`transform` `Html` renders an inner div sized to
// the canvas with `pointer-events: auto` (drei's own `pointerEvents` prop applies only in the
// transform branch), and `fullscreen` lifts that div to the toolbar's z-index, so the legend
// swallowed the Top/Fit/zoom clicks. Here `pointer-events: none` is simply a CSS property.
//
// It reads the same two stores `EngravePreview.tsx` does, so the swatches and the mesh colours
// cannot drift apart.

import { useMemo, type CSSProperties, type JSX } from 'react';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { SACRIFICIAL_COLOR } from './simGeometry';
import { depthColor, VOID_COLOR } from './engraveRamp';

/**
 * Top-right, below the top-left `ViewportToolbar` and above the bottom `SimTransport` (#198).
 *
 * #361 — the toolbar WRAPS, so its height is one row at 1440 and three at 1024 in the rail layout,
 * and a fixed `top: 8` sat the legend on top of it there: "Fit" was covered and "Side" was cut to
 * "Si". `Viewport` measures the toolbar's bottom edge and publishes it as
 * `--cm-viewport-toolbar-bottom` on `.viewport-wrapper`; the fallback is 0, so an unmeasured pane
 * (jsdom — no layout, no `ResizeObserver` — and the first paint before the measurement) renders
 * exactly today's `top: 8px`.
 */
const BOX: CSSProperties = {
  position: 'absolute',
  top: 'calc(var(--cm-viewport-toolbar-bottom, 0px) + 8px)',
  right: 8,
  zIndex: 'var(--cm-z-viewport-chrome)', // the one stacking scale (#348), src/styles/tokens.css
  background: 'rgba(20,25,30,0.82)',
  border: '1px solid #2a2f36',
  borderRadius: 4,
  padding: '6px 8px',
  color: '#d1d5db',
  fontSize: 11,
  lineHeight: 1.6,
  pointerEvents: 'none',
};

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 5 };

const SWATCH: CSSProperties = {
  width: 10,
  height: 10,
  border: '1px solid #00000055',
  display: 'inline-block',
  boxSizing: 'border-box',
};

export function EngraveLegend(): JSX.Element | null {
  const preview = useEngravePreviewStore((s) => s.preview);
  const stock = useEngraveJobStore((s) => s.job.stock);
  const minFloor = useEngraveJobStore((s) => s.job.minFloor);

  // Distinct depths, shallowest first — the same order and the same ramp the floors are drawn on.
  const depths = useMemo(() => {
    if (!preview) return [];
    return [...new Set(preview.floors.map((f) => f.depth))].sort((a, b) => a - b);
  }, [preview]);

  // Before the first preview lands there is nothing to say — and `EngravePreview` draws nothing
  // either, so an empty box would be the only thing on screen.
  if (!preview) return null;
  const maxDepth = stock.thickness - minFloor;

  return (
    <div data-testid="engrave-preview-legend" style={BOX}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Depth</div>
      {depths.length === 0 ? (
        <div style={{ color: '#9aa4b0' }}>nothing cut</div>
      ) : (
        depths.map((d) => (
          <div key={d} data-testid={`engrave-legend-${d}`} style={ROW}>
            <span style={{ ...SWATCH, background: depthColor(d, maxDepth) }} />
            {d.toFixed(1)} mm
          </div>
        ))
      )}
      {/* #213 — the sacrificial material is not a depth; it gets its own swatch. */}
      {preview.sacrificial.length > 0 && (
        <div data-testid="engrave-legend-sacrificial" style={{ ...ROW, marginTop: 2 }}>
          <span style={{ ...SWATCH, background: SACRIFICIAL_COLOR }} />
          sacrificial
        </div>
      )}
      {/* #271 — a void is not a depth either: it is a region of the face the cut must respect. */}
      {preview.voids.length > 0 && (
        <div data-testid="engrave-legend-void" style={{ ...ROW, marginTop: 2 }}>
          <span style={{ ...SWATCH, border: `2px solid ${VOID_COLOR}` }} />
          void under the face
        </div>
      )}
    </div>
  );
}
