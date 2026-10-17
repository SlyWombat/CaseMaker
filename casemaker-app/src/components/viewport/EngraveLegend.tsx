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
// cannot drift apart — including the #170 choice of WHICH colouring is in force: the depth ramp, or
// the two-colour reading a blank that states its split gets.

import { useMemo, type CSSProperties, type JSX } from 'react';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { mm } from '@/engine/cnc/engrave/depthBounds';
import { SACRIFICIAL_COLOR } from './simGeometry';
import { depthColor, LOST_COLOR, REGISTRATION_COLOR, splitColor, VOID_COLOR } from './engraveRamp';
import { scrubStateAt, scrubWords } from './engraveScrub';

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

/**
 * §5.7 — the design ↔ as-cut range. The BOX must stay `pointer-events: none` (#229: the legend may
 * never swallow the toolbar's or the canvas's clicks), so the interactive row turns pointer events
 * back on for itself — a descendant may opt in under a `none` ancestor.
 */
const SCRUB_ROW: CSSProperties = { ...ROW, marginTop: 2, pointerEvents: 'auto' };
const SCRUBBER: CSSProperties = { width: 92, margin: 0, accentColor: '#4d8eff' };

export function EngraveLegend(): JSX.Element | null {
  const preview = useEngravePreviewStore((s) => s.preview);
  // §5.7 — the design ↔ as-cut slider. View state only: moving it writes this store and nothing
  // else, so the job, its findings and the worker's next preview are untouched.
  const scrubStage = useEngravePreviewStore((s) => s.scrubStage);
  const setScrubStage = useEngravePreviewStore((s) => s.setScrubStage);
  const stock = useEngraveJobStore((s) => s.job.stock);
  const minFloor = useEngraveJobStore((s) => s.job.minFloor);

  // Distinct depths, shallowest first — the same order and the same ramp the floors are drawn on
  // when the blank states no split. Computed unconditionally (a hook); in the split case the ramp
  // rows are not drawn, but the COUNT still answers whether anything is cut at all.
  const depths = useMemo(() => {
    if (!preview) return [];
    return [...new Set(preview.floors.map((f) => f.depth))].sort((a, b) => a - b);
  }, [preview]);

  // Before the first preview lands there is nothing to say — and `EngravePreview` draws nothing
  // either, so an empty box would be the only thing on screen.
  if (!preview) return null;
  const scrub = scrubStateAt(preview, scrubStage);
  const maxDepth = stock.thickness - minFloor;
  // #170 — on a blank that states its colour split the floors are NOT drawn on the depth ramp
  // (`floorColor`), so a ramp of depth swatches here would name colours the meshes are not in. The
  // two rows below are the two things the eye has to tell apart, and they say "stand-in" out loud:
  // nothing in the app maps an extruder to a colour, so `SPLIT_TOP_COLOR` is not a claim about the
  // blank. Both come from the same module the meshes were coloured from, so they cannot drift.
  const split = preview.colourBoundaryDepth;
  // §5.7 — the lost layer is a COUNT, not a colour key: the row states the area of the design the
  // cutter does not reach, summed over the items the preview measured. It shows on either colour
  // reading, because it answers a different question from both.
  const lostArea = preview.lost.reduce((sum, l) => sum + l.area, 0);

  return (
    <div data-testid="engrave-preview-legend" style={BOX}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{split === null ? 'Depth' : 'Colour'}</div>
      {/* §5.7 — design ↔ as cut. One step per cut depth (plus the uncut design), because the
          program cuts those depths and no others; the readout says which state is on screen. The
          control is absent when there is no cut at all: every position would draw the same blank. */}
      {scrub.max > 0 && (
        <>
          <div data-testid="engrave-scrub-row" style={SCRUB_ROW}>
            <span style={{ color: '#9aa4b0' }}>design</span>
            <input
              data-testid="engrave-scrub"
              type="range"
              min={0}
              max={scrub.max}
              step={1}
              value={scrub.index}
              aria-label="Design to as-cut depth"
              aria-valuetext={scrubWords(scrub)}
              onChange={(e) => setScrubStage(Number(e.currentTarget.value))}
              style={SCRUBBER}
            />
            <span style={{ color: '#9aa4b0' }}>as cut</span>
          </div>
          <div data-testid="engrave-scrub-state" style={{ color: '#9aa4b0', marginBottom: 2 }}>
            {scrubWords(scrub)}
          </div>
        </>
      )}
      {split !== null ? (
        <>
          <div data-testid="engrave-legend-top" style={ROW}>
            <span style={{ ...SWATCH, background: splitColor('top') }} />
            top colour (stand-in)
          </div>
          <div data-testid="engrave-legend-bottom" style={ROW}>
            <span style={{ ...SWATCH, background: splitColor('bottom') }} />
            bottom colour (stand-in)
          </div>
          {/* The plane the two rows are read against, stated as the depth it sits at rather than
              drawn as a third colour: it is not a colour a floor lands IN, it is where they part.

              `mm` and not `toFixed(2)` (#170 review): the split is a depth, and every other depth
              the app prints goes through the one formatter — `split 1 mm down`, not `1.00`. */}
          <div data-testid="engrave-legend-split" style={{ color: '#9aa4b0' }}>
            split {mm(split)} mm down
          </div>
          {/* This branch is taken on the BLANK's own print, not on anything being cut, so it is
              reached by a two-colour job with no enabled label — where the two rows above describe a
              blank and nothing is on the face at all. Said out loud rather than left to read as a
              picture that failed to draw (#170 review). */}
          {depths.length === 0 && (
            <div data-testid="engrave-legend-nothing-cut" style={{ color: '#9aa4b0' }}>
              nothing cut
            </div>
          )}
        </>
      ) : depths.length === 0 ? (
        <div style={{ color: '#9aa4b0' }}>nothing cut</div>
      ) : (
        depths.map((d) => (
          <div key={d} data-testid={`engrave-legend-${d}`} style={ROW}>
            <span style={{ ...SWATCH, background: depthColor(d, maxDepth) }} />
            {d.toFixed(1)} mm
          </div>
        ))
      )}
      {/* §5.7 — the lost layer: an amber swatch and the area the cutter could not reach. Only at
          the as-cut end, matching the picture: part-way through, a not-yet-cut glyph is not lost. */}
      {scrub.atCut && preview.lost.length > 0 && (
        <div data-testid="engrave-legend-lost" style={{ ...ROW, marginTop: 2 }}>
          <span style={{ ...SWATCH, background: LOST_COLOR }} />
          lost detail · {Number(lostArea.toFixed(2))} mm²
        </div>
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
      {/* §5.4 — the registration band. The row gives the WIDEST tolerance drawn, so a setup whose
          edges carry different residuals cannot read as one number; each edge's own value is on
          its label in the scene. */}
      {preview.registration.length > 0 && (
        <div data-testid="engrave-legend-registration" style={{ ...ROW, marginTop: 2 }}>
          <span
            style={{
              ...SWATCH,
              background: `${REGISTRATION_COLOR}33`,
              border: `2px solid ${REGISTRATION_COLOR}`,
            }}
          />
          registration ±{mm(Math.max(...preview.registration.map((b) => b.uncertainty)))} mm
        </div>
      )}
    </div>
  );
}
