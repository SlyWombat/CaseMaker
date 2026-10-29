/**
 * #716 — MAP | STOCK, and the map's read-out, as app chrome over the canvas (design
 * `rotary-flow.md` §3.7, R-UI-5).
 *
 * A plain DOM control, sibling of the canvas like `EngraveLegend` (#349): nothing about a view
 * switch is spatial, and a projected one would follow the camera it is trying to describe. It
 * renders itself null for a flat job, so the flat preview keeps exactly the chrome it had. The
 * two labels' millimetres come from `rotaryMapView`/`wrap.ts`, the same call the drawn ruler uses.
 *
 * #716 review — at 390 px the one-line chip ran under the Depth panel's top-left corner, putting
 * "Stock" on the panel's border. Like the map's camera (`RotaryViewCamera`), the chip now measures
 * the panel's DOM box: if one row would not clear it, the read-out stacks above the switch. The
 * measured width is the children's, not the chip's current one, so stacking cannot feed back into
 * the decision and flip it back.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useRotaryViewStore } from '@/store/rotaryViewStore';
import { rotaryReadout } from './rotaryMapView';

const BOX: CSSProperties = {
  position: 'absolute',
  top: 'calc(var(--cm-viewport-toolbar-bottom, 0px) + 8px)',
  left: 8,
  zIndex: 'var(--cm-z-viewport-chrome)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(20,25,30,0.82)',
  border: '1px solid #2a2f36',
  borderRadius: 4,
  padding: '4px 6px',
  color: '#d1d5db',
  fontSize: 11,
};

const READOUT: CSSProperties = {
  font: '600 11px ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'nowrap',
};

const GROUP: CSSProperties = { display: 'flex', border: '1px solid #3a4552', borderRadius: 3, overflow: 'hidden' };

/** The chip's own gap and frame, px — what its single-row width adds around the two children. */
const CHIP_GAP_PX = 8;
const CHIP_FRAME_PX = 14; // 6 px padding each side + 1 px border each side
/** The clearance the chip keeps from the Depth panel when they share the top line, px. */
const PANEL_GAP_PX = 8;

function seg(on: boolean): CSSProperties {
  return {
    font: '600 11px ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '2px 8px',
    border: 0,
    cursor: 'pointer',
    background: on ? '#2f5da8' : '#1b2027',
    color: on ? '#ffffff' : '#9aa4b0',
  };
}

export function RotaryViewControls(): JSX.Element | null {
  const job = useEngraveJobStore((s) => s.job);
  const design = useRotaryViewStore((s) => s.design);
  const setDesign = useRotaryViewStore((s) => s.setDesign);
  const map = useMemo(() => rotaryMapOf(job), [job]);
  const readout = map === null ? '' : rotaryReadout(map);
  // The Depth panel exists only once a preview does; its arrival is when the chip can measure it.
  const previewReady = useEngravePreviewStore((s) => s.preview !== null);
  const boxRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const readoutEl = readoutRef.current;
    const group = groupRef.current;
    if (box === null || readoutEl === null || group === null) return;
    const decide = (): void => {
      const panel = document.querySelector('[data-testid="engrave-preview-legend"]');
      const panelRect = panel === null ? null : panel.getBoundingClientRect();
      if (panelRect === null || panelRect.width <= 0) {
        setStacked(false);
        return;
      }
      // The one-line width from the children themselves — not the chip's current width, which the
      // stack changes — so the decision is stable once taken.
      const rowWidth = readoutEl.offsetWidth + group.offsetWidth + CHIP_GAP_PX + CHIP_FRAME_PX;
      const free = panelRect.left - box.getBoundingClientRect().left - PANEL_GAP_PX;
      setStacked(rowWidth > free);
    };
    decide();
    window.addEventListener('resize', decide);
    // The pane's width (the rail and drawer layouts change it without a window resize) and the
    // panel's own box are what move; observing both re-decides on either.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(decide);
    if (ro !== null) {
      if (box.parentElement !== null) ro.observe(box.parentElement);
      const panel = document.querySelector('[data-testid="engrave-preview-legend"]');
      if (panel instanceof HTMLElement) ro.observe(panel);
    }
    return () => {
      window.removeEventListener('resize', decide);
      ro?.disconnect();
    };
  }, [previewReady, readout]);

  if (map === null) return null;
  const boxStyle: CSSProperties = stacked
    ? { ...BOX, flexDirection: 'column', alignItems: 'flex-start' }
    : BOX;
  return (
    <div ref={boxRef} style={boxStyle} data-testid="rotary-view-controls">
      <span ref={readoutRef} style={READOUT} data-testid="rotary-view-readout">
        {readout}
      </span>
      <div ref={groupRef} style={GROUP} role="group" aria-label="Map or stock">
        <button
          type="button"
          style={seg(design === 'map')}
          aria-pressed={design === 'map'}
          data-testid="rotary-view-map"
          onClick={() => setDesign('map')}
        >
          Map
        </button>
        <button
          type="button"
          style={seg(design === 'stock')}
          aria-pressed={design === 'stock'}
          data-testid="rotary-view-stock"
          onClick={() => setDesign('stock')}
        >
          Stock
        </button>
      </div>
    </div>
  );
}
