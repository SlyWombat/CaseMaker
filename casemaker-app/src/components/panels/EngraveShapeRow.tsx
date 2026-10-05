import { useState, type CSSProperties, type JSX } from 'react';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { ShapePatch } from '@/store/engraveJobStore';
import type { EngraveShape } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * One shape pocket of an engrave job (#214, work item 5): enabled, an optional name, the
 * kind's own dimensions, position, rotation, depth and its own findings.
 *
 * Each kind gets its OWN editor (the issue's rule) because the dimensions differ: a rect has
 * width/height/cornerRadius, a circle a diameter, a slot a length and width, a polygon a list
 * of points. Depth is a NUMERIC field with a slider BESIDE it, never a slider alone — the same
 * rule the label row follows, for the same reason (a slider cannot express "1.5 mm" reliably).
 *
 * The polygon editor keeps its text LOCAL and only commits points that parse to 3–500 of them:
 * a half-typed ring must never reach the job, or the schema would reject the whole document on
 * the next load.
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
const POINTS: CSSProperties = {
  width: '100%',
  minHeight: 54,
  fontFamily: 'monospace',
  fontSize: 11,
  boxSizing: 'border-box',
};

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a' };

const KIND_LABEL: Record<EngraveShape['kind'], string> = {
  rect: 'Rectangle',
  circle: 'Circle',
  slot: 'Slot',
  polygon: 'Polygon',
};

/** The numeric fields a row can edit, across all kinds. */
type NumField = 'width' | 'height' | 'cornerRadius' | 'diameter' | 'length' | 'rotation';

function pointsToText(points: readonly [Mm, Mm][]): string {
  return points.map(([x, y]) => `${x}, ${y}`).join('\n');
}

/** Parse "x, y" per line into points, or null when any line is not two finite numbers. */
function parsePoints(text: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 2) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out;
}

export interface EngraveShapeRowProps {
  shape: EngraveShape;
  /** Position of this row in `job.shapes`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: ShapePatch) => void;
  onRemove: () => void;
  /** Findings about THIS shape (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveShapeRow({
  shape,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
}: EngraveShapeRowProps): JSX.Element {
  const depthInvalid = shape.depth > maxDepth;
  const [pointsText, setPointsText] = useState(() => (shape.kind === 'polygon' ? pointsToText(shape.points) : ''));

  const numField = (key: NumField, label: string, title: string, invalid = false): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={(shape as unknown as Record<string, number>)[key]}
        data-testid={`engrave-shape-${key}-${index}`}
        aria-label={`Shape ${index + 1} ${label}`}
        title={title}
        style={{ ...NUM, ...(invalid ? INVALID : null) }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ [key]: v } as ShapePatch);
        }}
      />
    </label>
  );

  const positionNum = (axis: 'x' | 'y'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={shape.position[axis]}
        data-testid={`engrave-shape-${axis}-${index}`}
        aria-label={`Shape ${index + 1} ${axis.toUpperCase()}`}
        title={`Centre of the shape, mm from the stock's front-left corner. ${
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
      data-testid={`engrave-shape-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={shape.enabled}
          data-testid={`engrave-shape-enabled-${index}`}
          aria-label={`Shape ${index + 1} enabled`}
          title="A disabled shape is kept in the job but not cut."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span style={TAG}>{KIND_LABEL[shape.kind]}</span>
        <input
          type="text"
          value={shape.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-shape-name-${index}`}
          aria-label={`Shape ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
        <button
          type="button"
          data-testid={`engrave-shape-remove-${index}`}
          aria-label={`Remove shape ${index + 1}`}
          title="Remove this shape."
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      <div style={ROW_INLINE}>
        {shape.kind === 'rect' && (
          <>
            {numField('width', 'width', 'Rectangle width in X, mm.')}
            {numField('height', 'height', 'Rectangle height in Y, mm.')}
            {numField(
              'cornerRadius',
              'corner r',
              'Corner radius, mm. 0 = sharp — the cutter rounds it anyway; never more than half the smaller side.',
              shape.cornerRadius > Math.min(shape.width, shape.height) / 2,
            )}
          </>
        )}
        {shape.kind === 'circle' && numField('diameter', 'diameter', 'Circle diameter, mm. A hole larger than the cutter; a smaller one is item-empty.')}
        {shape.kind === 'slot' && (
          <>
            {numField('length', 'length', 'Overall slot length (end to end), mm.')}
            {numField('width', 'width', 'Slot width, mm — the end radius is half of it.', shape.length < shape.width)}
          </>
        )}
      </div>

      {shape.kind === 'polygon' && (
        <label style={{ display: 'block', marginTop: 4 }}>
          <span style={{ ...MUTED, display: 'block' }}>points — one “x, y” per line, relative to the centre</span>
          <textarea
            value={pointsText}
            data-testid={`engrave-shape-points-${index}`}
            aria-label={`Shape ${index + 1} polygon points`}
            title="One x, y pair per line. A closed ring of 3 to 500 points; a crossing ring is reported, not cut."
            style={{ ...POINTS, ...(parsePoints(pointsText) && parsePoints(pointsText)!.length >= 3 ? null : INVALID) }}
            onChange={(e) => {
              const text = e.target.value;
              setPointsText(text);
              const pts = parsePoints(text);
              // Commit only a valid ring: an invalid one would make the whole job unloadable.
              if (pts && pts.length >= 3 && pts.length <= 500) onChange({ points: pts });
            }}
          />
          <span style={MUTED} data-testid={`engrave-shape-point-count-${index}`}>
            {(() => {
              const pts = parsePoints(pointsText);
              if (!pts) return 'Not a list of x, y points.';
              if (pts.length < 3) return `${pts.length} point${pts.length === 1 ? '' : 's'} — a polygon needs at least 3.`;
              if (pts.length > 500) return `${pts.length} points — at most 500.`;
              return `${pts.length} points.`;
            })()}
          </span>
        </label>
      )}

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={shape.construction === true}
            data-testid={`engrave-shape-construction-${index}`}
            aria-label={`Shape ${index + 1} reference only`}
            title="Reference only: this shape is not cut. It can still be named by a frame or a cut-away — as a cut-away island it is left standing."
            onChange={(e) => onChange({ construction: e.target.checked ? true : undefined })}
          />
          <span>reference only</span>
        </label>
        {positionNum('x')}
        {positionNum('y')}
        {numField('rotation', 'rot', 'Degrees counter-clockwise about the shape centre.')}
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="range"
            min={0}
            max={maxDepth}
            step="0.1"
            value={Math.min(shape.depth, maxDepth)}
            aria-label={`Shape ${index + 1} depth slider`}
            title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
            onChange={(e) => onChange({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={shape.depth}
            data-testid={`engrave-shape-depth-${index}`}
            aria-label={`Shape ${index + 1} depth`}
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

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-shape-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
      </p>

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-shape-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
