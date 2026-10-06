import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  TRACE_DEFAULTS,
  scaleOutlineToWidth,
  type OutlineImport,
  type TraceOptions,
} from '@/engine/import/outlineImport';
import type { Mm } from '@/types/units';

/**
 * The import dialog for a vector outline (#217): the file has been picked and parsed, and this
 * is the "before it is accepted" step the issue insists on — the FINAL SIZE is always on screen,
 * the assumed units are called out, and the target width can be set, keeping the aspect ratio.
 *
 * The two things that make an imported logo come out wrong are both here: a fallback scale the
 * parser assumed (96 px/inch for an SVG with no physical size, mm for a DXF with no `$INSUNITS`),
 * and a file that is the wrong size for the job. The first is shown in its own warning, never
 * buried in the notes; the second is fixed by the width control.
 *
 * Lost detail (#201) is named here as the RULE — a flat cutter of diameter d cannot cut a feature
 * narrower than d — and the dialog says the measured loss appears under the item once it is
 * added. It is measured in the preview worker (a real morphological opening), not guessed here.
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };

/**
 * The overlay is PORTAL'd to `document.body` for the same reason the setup flow and run sheet
 * are: the context rail that mounts this is a fixed, sometimes-transformed drawer, and a fixed
 * overlay inside it is trapped in the rail's column instead of covering the window.
 */
const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'rgba(8, 11, 15, 0.72)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const BOX: CSSProperties = {
  width: 'min(400px, 100%)',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  background: '#14181d',
  border: '1px solid #2a2f36',
  borderRadius: 6,
  padding: 12,
  color: '#d1d5db',
};
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };
const NOTE: CSSProperties = {
  fontSize: 11,
  color: '#c8d3de',
  lineHeight: 1.5,
  margin: '2px 0',
  paddingLeft: 12,
  position: 'relative',
};
const WARN: CSSProperties = {
  border: '1px solid #7a6a28',
  background: '#2a2414',
  borderRadius: 4,
  padding: 6,
  margin: '6px 0',
  fontSize: 11,
  color: '#e0c07a',
  lineHeight: 1.5,
};
const ERROR: CSSProperties = {
  border: '1px solid #7a2828',
  background: '#2a1416',
  borderRadius: 4,
  padding: 6,
  margin: '6px 0',
  fontSize: 11,
  color: '#f0b4ad',
  lineHeight: 1.5,
};

/** Points drawn in the thumbnail before contours are decimated — a preview, not the geometry. */
const PREVIEW_MAX_POINTS = 4000;

/** The trace controls' frame (#252) — its own colour, so it reads as the picture's settings. */
const TRACE_BOX: CSSProperties = {
  border: '1px solid #2a3d4a',
  background: '#141c22',
  borderRadius: 4,
  padding: 6,
  margin: '6px 0',
  color: '#c8d3de',
  lineHeight: 1.5,
};

/** "12.5" for 12.5, "12.00" for 12 — two decimals is enough to spot a 3 mm-vs-3 m mistake. */
function fmtMm(n: number): string {
  return n.toFixed(2);
}

/** A whole number of pixels from a field; a bad entry keeps the last good value. */
function wholePx(text: string, fallback: number): number {
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/** A pixel tolerance from a field; a bad entry keeps the last good value. */
function px(text: string, fallback: number): number {
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * One ring as an SVG path in the dialog's display frame. The job's Y is up and SVG's is down, so
 * Y is negated (the same flip the parser applied on the way in, undone only for drawing).
 */
function ringToPath(ring: readonly [Mm, Mm][], stride: number): string {
  let d = '';
  for (let i = 0; i < ring.length; i += stride) {
    const [x, y] = ring[i]!;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(3)} ${(-y).toFixed(3)}`;
  }
  return `${d}Z`;
}

/**
 * The tracer's controls, present only for a traced bitmap (#252). The panel owns the options and
 * the pixels; this dialog only shows them and calls back, so the preview and the final size below
 * always describe the CURRENT trace — a control that changed the numbers but not the picture would
 * be worse than no control at all.
 */
export interface TracePanel {
  options: Required<TraceOptions>;
  onChange: (patch: Partial<TraceOptions>) => void;
  /** Source pixels, so the scale line the controls are read against can be shown. */
  imageWidth: number;
  imageHeight: number;
  /** A re-trace the tracer refused (a cap exceeded) — shown, not swallowed. */
  error: string | null;
}

export interface EngraveImportDialogProps {
  /** The accepted parse; its contours are mm, its bounding-box centre already at the origin. */
  outline: OutlineImport;
  /** Cutting diameter of the current cutter (mm), or null when the job has none yet. */
  cutterDiameter: number | null;
  /** Trace controls, for a raster source. Absent for an SVG or DXF. */
  trace?: TracePanel | null;
  /** Called with the final (possibly rescaled) outline when the user adds it. */
  onAccept: (outline: OutlineImport) => void;
  onClose: () => void;
}

export function EngraveImportDialog({
  outline,
  cutterDiameter,
  trace = null,
  onAccept,
  onClose,
}: EngraveImportDialogProps): JSX.Element {
  // `null` means "follow whatever the source measured", so a re-trace from the controls updates
  // the target width with the new geometry. Typing in the field pins it, which is what a user who
  // typed a number expects.
  //
  // Untyped, the scale is the identity on the outline's OWN width — not on the two-decimal string
  // shown — so adding an untouched import keeps the geometry to the last bit rather than snapping
  // it to 0.01 mm.
  const [typedWidth, setTypedWidth] = useState<string | null>(null);
  const targetWidth = typedWidth ?? fmtMm(outline.width);

  const parsedTarget = typedWidth === null ? outline.width : Number(typedWidth);
  const targetValid =
    typedWidth === null
      ? outline.width > 0
      : typedWidth.trim() !== '' && Number.isFinite(parsedTarget) && parsedTarget > 0;
  const scaled = useMemo(
    () => (targetValid ? scaleOutlineToWidth(outline, parsedTarget) : outline),
    [outline, targetValid, parsedTarget],
  );

  // The parser emits a note when it falls back on units; those are the ones that change the
  // size, so they get their own warning. Everything else is a normal out-of-scope note.
  const unitNotes = outline.notes.filter((n) => n.includes('assuming'));
  const otherNotes = outline.notes.filter((n) => !n.includes('assuming'));

  const hasGeometry = outline.contours.length > 0 && scaled.width > 0 && scaled.height > 0;
  const addable = hasGeometry && targetValid;

  const points = useMemo(() => {
    let n = 0;
    for (const ring of scaled.contours) n += ring.length;
    return n;
  }, [scaled]);
  const stride = Math.max(1, Math.ceil(points / PREVIEW_MAX_POINTS));
  const pad = Math.max(scaled.width, scaled.height, 1) * 0.05;
  const viewBox =
    scaled.width > 0 && scaled.height > 0
      ? `${-scaled.width / 2 - pad} ${-scaled.height / 2 - pad} ${scaled.width + 2 * pad} ${scaled.height + 2 * pad}`
      : '0 0 10 10';

  return createPortal(
    <div data-testid="engrave-import-dialog" role="dialog" aria-label="Import or trace an outline" style={OVERLAY}>
      <div style={BOX}>
        {/* The title names what the user did: a traced picture is not an imported drawing, and
            the two arrive at the same outline by different routes. */}
        <h3 style={{ margin: '0 0 6px', fontSize: 13, color: '#c8d3de' }}>
          {outline.format === 'raster' ? 'Trace image' : 'Import outline'} — {outline.sourceName}
        </h3>
        <p style={MUTED}>
          {outline.format.toUpperCase()} · {outline.contours.length} closed shape
          {outline.contours.length === 1 ? '' : 's'} · {points} point{points === 1 ? '' : 's'} ·{' '}
          {outline.fillRule === 'EvenOdd' ? 'even-odd' : 'non-zero'} fill
        </p>

        {/* The preview: the contours as they will be cut. Decimated above 4000 points so a
            complex logo does not put 200 000 nodes in the DOM; the cut uses every point. */}
        <div style={{ background: '#0d1013', border: '1px solid #2a2f36', borderRadius: 4, padding: 4 }}>
          <svg
            data-testid="engrave-import-preview"
            viewBox={viewBox}
            preserveAspectRatio="xMidYMid meet"
            style={{ width: '100%', height: 150, display: 'block' }}
            role="img"
            aria-label={`Preview of ${outline.sourceName}`}
          >
            <path
              d={scaled.contours.map((ring) => ringToPath(ring, stride)).join(' ')}
              fillRule={outline.fillRule === 'EvenOdd' ? 'evenodd' : 'nonzero'}
              fill="#4a6a8a"
              stroke="#8fb3d9"
              strokeWidth={Math.max(scaled.width, scaled.height, 1) * 0.006}
            />
          </svg>
        </div>

        {/* The trace controls (#252). Everything above this line — the ring count, the preview —
            redraws as they move, because the panel re-traces and hands the result back down. */}
        {trace && (
          <div data-testid="engrave-trace-controls" style={TRACE_BOX}>
            <b style={{ fontSize: 11 }}>Trace — what counts as ink</b>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <label style={{ ...FIELD_LABEL, flex: '0 0 auto' }} htmlFor="engrave-trace-threshold">
                threshold
              </label>
              <input
                id="engrave-trace-threshold"
                type="range"
                min={0}
                max={255}
                step={1}
                value={trace.options.threshold}
                data-testid="engrave-trace-threshold"
                aria-label="Trace threshold"
                title={`Pixels darker than this become the cut region (default ${TRACE_DEFAULTS.threshold}).`}
                style={{ flex: 1 }}
                onChange={(e) => trace.onChange({ threshold: Number(e.target.value) })}
              />
              <b data-testid="engrave-trace-threshold-value" style={{ fontSize: 12, minWidth: 24, textAlign: 'right' }}>
                {trace.options.threshold}
              </b>
            </div>
            <label style={{ ...FIELD_LABEL, marginTop: 4, display: 'flex' }}>
              <input
                type="checkbox"
                checked={trace.options.invert}
                data-testid="engrave-trace-invert"
                onChange={(e) => trace.onChange({ invert: e.target.checked })}
              />
              <span>the light pixels are the ink — white artwork on a dark background</span>
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
              <label style={FIELD_LABEL}>
                <span>despeckle</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={trace.options.despeckle}
                  data-testid="engrave-trace-despeckle"
                  aria-label="Despeckle: smallest blob to keep, in pixels"
                  title="Blobs — and pinholes — smaller than this many pixels are dropped before tracing."
                  style={{ width: 56 }}
                  onChange={(e) => trace.onChange({ despeckle: wholePx(e.target.value, trace.options.despeckle) })}
                />
                <span>px</span>
              </label>
              <label style={FIELD_LABEL}>
                <span>corner simplify</span>
                <input
                  type="number"
                  min={0}
                  step={0.25}
                  value={trace.options.simplify}
                  data-testid="engrave-trace-simplify"
                  aria-label="Corner simplification tolerance in pixels"
                  title="Straightens the pixel staircase. Higher is smoother and rounds off fine corners."
                  style={{ width: 56 }}
                  onChange={(e) => trace.onChange({ simplify: px(e.target.value, trace.options.simplify) })}
                />
                <span>px</span>
              </label>
            </div>
            <p style={MUTED} data-testid="engrave-trace-scale">
              {trace.imageWidth} × {trace.imageHeight} px source, at 0.26 mm per pixel.
            </p>
            {trace.error && (
              <p style={{ ...MUTED, color: '#f0b4ad' }} data-testid="engrave-trace-error">
                {trace.error}
              </p>
            )}
          </div>
        )}

        {/* Units — the failure this dialog exists to prevent. */}
        {unitNotes.length > 0 && (
          <div data-testid="engrave-import-unit-warning" style={WARN}>
            <b>Size assumed from the file — check it before you cut.</b>
            {unitNotes.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
            <div>If the size below is wrong, set the target width explicitly.</div>
          </div>
        )}

        {!hasGeometry && (
          <div data-testid="engrave-import-empty" style={ERROR}>
            Nothing to cut — this file has no closed, filled shapes. A stroked line has no area
            (that is the single-line trace feature); convert text to outlines in the drawing
            program first.
            {outline.format === 'raster' && (
              <div style={{ marginTop: 4 }}>
                For a traced picture that means the threshold found no ink: move it towards the
                artwork's ink, or turn on the light-pixels switch for white artwork on dark.
              </div>
            )}
          </div>
        )}

        {/* Size — always shown, and the control that fixes a wrong one. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <span style={MUTED}>Imported size</span>
          <b data-testid="engrave-import-source-size" style={{ fontSize: 12, color: '#d1d5db' }}>
            {fmtMm(outline.width)} × {fmtMm(outline.height)} mm
          </b>
        </div>
        <label style={{ ...FIELD_LABEL, marginTop: 6 }}>
          <span>target width</span>
          <input
            type="number"
            min={0}
            step="any"
            value={targetWidth}
            data-testid="engrave-import-target-width"
            aria-label="Target width in millimetres"
            title="The outline is scaled uniformly to this width, keeping its aspect ratio."
            style={{ width: 90 }}
            onChange={(e) => setTypedWidth(e.target.value)}
          />
          <span>mm — keeps the aspect ratio</span>
        </label>
        {targetValid ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={MUTED}>Final size</span>
            <b data-testid="engrave-import-final-size" style={{ fontSize: 12, color: '#d1d5db' }}>
              {fmtMm(scaled.width)} × {fmtMm(scaled.height)} mm
            </b>
          </div>
        ) : (
          <p style={{ ...MUTED, color: '#e0c07a' }} data-testid="engrave-import-target-invalid">
            Enter a target width greater than 0.
          </p>
        )}

        {/* Lost detail (#201) — the rule, and where the measurement will appear. */}
        {cutterDiameter !== null ? (
          <div data-testid="engrave-import-lost-detail" style={WARN}>
            With the current Ø {fmtMm(cutterDiameter)} mm cutter, any part of this outline narrower
            than {fmtMm(cutterDiameter)} mm is lost — the cutter opens it away. The measured loss
            for this outline appears under the item once it is added, where it gates the cut.
          </div>
        ) : (
          <p style={MUTED} data-testid="engrave-import-lost-detail">
            Choose a cutter in the panel; the outline is then measured for lost detail and the
            result is shown under the item.
          </p>
        )}

        {otherNotes.length > 0 && (
          <div style={{ marginTop: 6 }} data-testid="engrave-import-notes">
            <p style={{ ...MUTED, margin: '4px 0' }}>From the file:</p>
            {otherNotes.map((n, i) => (
              <p key={i} style={NOTE}>
                <span style={{ position: 'absolute', left: 0, color: '#66707a' }}>•</span>
                {n}
              </p>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
          <button type="button" data-testid="engrave-import-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="engrave-import-accept"
            disabled={!addable}
            title={addable ? 'Add this outline to the job.' : 'This outline cannot be added.'}
            onClick={() => onAccept(scaled)}
          >
            Add outline
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
