import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { scaleOutlineToWidth, type OutlineImport } from '@/engine/import/outlineImport';
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

/** "12.5" for 12.5, "12.00" for 12 — two decimals is enough to spot a 3 mm-vs-3 m mistake. */
function fmtMm(n: number): string {
  return n.toFixed(2);
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

export interface EngraveImportDialogProps {
  /** The accepted parse; its contours are mm, its bounding-box centre already at the origin. */
  outline: OutlineImport;
  /** Cutting diameter of the current cutter (mm), or null when the job has none yet. */
  cutterDiameter: number | null;
  /** Called with the final (possibly rescaled) outline when the user adds it. */
  onAccept: (outline: OutlineImport) => void;
  onClose: () => void;
}

export function EngraveImportDialog({
  outline,
  cutterDiameter,
  onAccept,
  onClose,
}: EngraveImportDialogProps): JSX.Element {
  const [targetWidth, setTargetWidth] = useState<string>(() => fmtMm(outline.width));

  const parsedTarget = Number(targetWidth);
  const targetValid = targetWidth.trim() !== '' && Number.isFinite(parsedTarget) && parsedTarget > 0;
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
    <div data-testid="engrave-import-dialog" role="dialog" aria-label="Import a vector outline" style={OVERLAY}>
      <div style={BOX}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, color: '#c8d3de' }}>
          Import outline — {outline.sourceName}
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
            onChange={(e) => setTargetWidth(e.target.value)}
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
