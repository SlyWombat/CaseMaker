import type { CSSProperties, JSX } from 'react';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { VectorPatch } from '@/store/engraveJobStore';
import type { EngraveVectorShape } from '@/types/engraveJob';

/**
 * One imported vector outline (#217): an SVG or DXF traced to contours at import time.
 *
 * Unlike the hand-built shape rows, there is NO geometry editor here. The contours are the
 * flattened file — immutable once imported — so this row edits placement, rotation, depth, the
 * name and the flags, and SHOWS the imported size. Resizing is the import dialog's job
 * (`scaleOutlineToWidth`), before the item exists: a scale box here would have to rescale every
 * ring, which is a different item, not an edit.
 *
 * The findings under the row are the measured engravability losses (#201) — `item-detail-lost`
 * when the cutter opens away part of the outline, `item-empty` when it opens away all of it —
 * produced by the preview worker from the same opening the cut uses, not guessed here.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };
const TAG: CSSProperties = {
  fontSize: 10,
  color: '#9aa4b0',
  border: '1px solid #2a2f36',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
};

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a' };

export interface EngraveVectorRowProps {
  shape: EngraveVectorShape;
  /** Position of this row in `job.vectors`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: VectorPatch) => void;
  onRemove: () => void;
  /** Findings about THIS vector (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveVectorRow({
  shape,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
}: EngraveVectorRowProps): JSX.Element {
  const depthInvalid = shape.depth > maxDepth;

  const positionNum = (axis: 'x' | 'y'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={shape.position[axis]}
        data-testid={`engrave-vector-${axis}-${index}`}
        aria-label={`Imported outline ${index + 1} ${axis.toUpperCase()}`}
        title={`Centre of the outline, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...shape.position, [axis]: v } });
        }}
      />
    </label>
  );

  return (
    <div
      data-testid={`engrave-vector-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={shape.enabled}
          data-testid={`engrave-vector-enabled-${index}`}
          aria-label={`Imported outline ${index + 1} enabled`}
          title="A disabled outline is kept in the job but not cut."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span style={TAG}>Imported outline</span>
        <input
          type="text"
          value={shape.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-vector-name-${index}`}
          aria-label={`Imported outline ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
        <button
          type="button"
          data-testid={`engrave-vector-remove-${index}`}
          aria-label={`Remove imported outline ${index + 1}`}
          title="Remove this outline."
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      <p style={MUTED} data-testid={`engrave-vector-source-${index}`}>
        {shape.sourceName} · {shape.width} × {shape.height} mm — the size was set at import; remove
        and re-import to resize.
      </p>

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={shape.construction === true}
            data-testid={`engrave-vector-construction-${index}`}
            aria-label={`Imported outline ${index + 1} reference only`}
            title="Reference only: this outline is not cut. It can still be named by a frame or a cut-away."
            onChange={(e) => onChange({ construction: e.target.checked ? true : undefined })}
          />
          <span>reference only</span>
        </label>
        {positionNum('x')}
        {positionNum('y')}
        <label style={FIELD_LABEL}>
          <span>rot</span>
          <input
            type="number"
            step="any"
            value={shape.rotation}
            data-testid={`engrave-vector-rotation-${index}`}
            aria-label={`Imported outline ${index + 1} rotation`}
            title="Degrees counter-clockwise about the outline’s centre."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ rotation: v });
            }}
          />
        </label>
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="range"
            min={0}
            max={maxDepth}
            step="0.1"
            value={Math.min(shape.depth, maxDepth)}
            aria-label={`Imported outline ${index + 1} depth slider`}
            title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
            onChange={(e) => onChange({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={shape.depth}
            data-testid={`engrave-vector-depth-${index}`}
            aria-label={`Imported outline ${index + 1} depth`}
            title="Depth of this pocket's floor below the top face, mm."
            style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ depth: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-vector-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
      </p>

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-vector-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
