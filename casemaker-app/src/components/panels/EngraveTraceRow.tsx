import { useState, type CSSProperties, type JSX } from 'react';
import { STROKE_FONTS } from '@/engine/fonts/stroke/strokeFont';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { TracePatch } from '@/store/engraveJobStore';
import type { EngraveTraceItem } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * One single-line trace of an engrave job (#219): a free polyline or a single-stroke text label.
 *
 * A trace is NOT a pocket: the cutter's centre follows the drawn path, so the groove is exactly
 * the cutter's width and there is no step-over to set. The two kinds therefore get different
 * editors — a `line` is a list of points and a close flag, a `stroke-label` is text, a
 * single-stroke face and a cap height. Neither shows the pocket-only fields (a stroke width, a
 * step-over), because a traced stroke HAS the cutter's width rather than a width of its own.
 *
 * The points editor keeps its text LOCAL and only commits a path the schema accepts (≥2 points,
 * ≥3 when closed, ≤5000) so a half-typed line never lands the whole job unloadable. The `closed`
 * checkbox is disabled until there are three committed points for the same reason.
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

/** The schema's caps, mirrored here so the editor commits only a loadable path (#219). */
const MAX_POINTS = 5000;

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

export interface EngraveTraceRowProps {
  trace: EngraveTraceItem;
  /** Position of this row in `job.traces`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: TracePatch) => void;
  onRemove: () => void;
  /** Findings about THIS trace (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveTraceRow({
  trace,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
}: EngraveTraceRowProps): JSX.Element {
  const depthInvalid = trace.depth > maxDepth;
  const kindLabel = trace.kind === 'line' ? 'Line' : 'Single-line text';
  const [pointsText, setPointsText] = useState(() => (trace.kind === 'line' ? pointsToText(trace.points) : ''));

  const numField = (key: 'size' | 'rotation', label: string, title: string): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={(trace as unknown as Record<string, number>)[key] ?? 0}
        data-testid={`engrave-trace-${key}-${index}`}
        aria-label={`${kindLabel} ${index + 1} ${label}`}
        title={title}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ [key]: v } as TracePatch);
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
        value={trace.position[axis]}
        data-testid={`engrave-trace-${axis}-${index}`}
        aria-label={`${kindLabel} ${index + 1} ${axis.toUpperCase()}`}
        title={`${
          trace.kind === 'line' ? 'Origin the points are measured from' : 'Centre of the text'
        }, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...trace.position, [axis]: v } });
        }}
      />
    </label>
  );

  return (
    <div
      data-testid={`engrave-trace-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={trace.enabled}
          data-testid={`engrave-trace-enabled-${index}`}
          aria-label={`${kindLabel} ${index + 1} enabled`}
          title="A disabled trace is kept in the job but not cut."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span style={TAG}>{kindLabel}</span>
        <input
          type="text"
          value={trace.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-trace-name-${index}`}
          aria-label={`${kindLabel} ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
        <button
          type="button"
          data-testid={`engrave-trace-remove-${index}`}
          aria-label={`Remove ${kindLabel} ${index + 1}`}
          title="Remove this trace."
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      {trace.kind === 'line' && (
        <label style={{ display: 'block', marginTop: 4 }}>
          <span style={{ ...MUTED, display: 'block' }}>points — one “x, y” per line, relative to the origin</span>
          <textarea
            value={pointsText}
            data-testid={`engrave-trace-points-${index}`}
            aria-label={`${kindLabel} ${index + 1} points`}
            title="One x, y pair per line. The cutter follows the centre of this polyline; an open path needs 2 points, a closed ring 3."
            style={{ ...POINTS, ...(parsePoints(pointsText) ? null : INVALID) }}
            onChange={(e) => {
              const text = e.target.value;
              setPointsText(text);
              const pts = parsePoints(text);
              const min = trace.closed ? 3 : 2;
              // Commit only a path the schema accepts: an invalid one would make the whole job unloadable.
              if (pts && pts.length >= min && pts.length <= MAX_POINTS) onChange({ points: pts });
            }}
          />
          <span style={MUTED} data-testid={`engrave-trace-point-count-${index}`}>
            {(() => {
              const pts = parsePoints(pointsText);
              if (!pts) return 'Not a list of x, y points.';
              const min = trace.closed ? 3 : 2;
              if (pts.length > MAX_POINTS) return `${pts.length} points — at most ${MAX_POINTS}.`;
              if (pts.length < min) {
                return `${pts.length} point${pts.length === 1 ? '' : 's'} — ${trace.closed ? 'a closed ring needs at least 3' : 'a line needs at least 2'}.`;
              }
              return `${pts.length} point${pts.length === 1 ? '' : 's'}${trace.closed ? ', closed' : ''}.`;
            })()}
          </span>
        </label>
      )}

      {trace.kind === 'stroke-label' && (
        <div style={ROW_INLINE}>
          <label style={FIELD_LABEL}>
            <span>text</span>
            <input
              type="text"
              value={trace.text}
              data-testid={`engrave-trace-text-${index}`}
              aria-label={`${kindLabel} ${index + 1} text`}
              title="Text to engrave as a single cutter-wide line (a single-stroke font, not an outline)."
              style={{ width: 140 }}
              onChange={(e) => onChange({ text: e.target.value })}
            />
          </label>
          <label style={FIELD_LABEL}>
            <span>font</span>
            <select
              value={trace.font}
              data-testid={`engrave-trace-font-${index}`}
              aria-label={`${kindLabel} ${index + 1} stroke font`}
              title="Single-stroke fonts only: tracing an outline font would engrave the outline of each letter."
              style={{ maxWidth: 220 }}
              onChange={(e) => onChange({ font: e.target.value })}
            >
              {STROKE_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {numField('size', 'cap', 'Cap height, mm — the height of a capital letter, as for an outline label.')}
        </div>
      )}

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={trace.construction === true}
            data-testid={`engrave-trace-construction-${index}`}
            aria-label={`${kindLabel} ${index + 1} reference only`}
            title="Reference only: this trace is not cut."
            onChange={(e) => onChange({ construction: e.target.checked ? true : undefined })}
          />
          <span>reference only</span>
        </label>
        {trace.kind === 'line' && (
          <label style={FIELD_LABEL}>
            <input
              type="checkbox"
              checked={trace.closed}
              disabled={trace.points.length < 3}
              data-testid={`engrave-trace-closed-${index}`}
              aria-label={`${kindLabel} ${index + 1} closed`}
              title={
                trace.points.length < 3
                  ? 'A closed ring needs at least 3 points.'
                  : 'Feed back to the first point with no retract — for borders and outlines.'
              }
              onChange={(e) => onChange({ closed: e.target.checked })}
            />
            <span>closed</span>
          </label>
        )}
        {positionNum('x')}
        {positionNum('y')}
        {numField('rotation', 'rot', `Degrees counter-clockwise about the ${trace.kind === 'line' ? 'origin' : 'text centre'}.`)}
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="range"
            min={0}
            max={maxDepth}
            step="0.1"
            value={Math.min(trace.depth, maxDepth)}
            aria-label={`${kindLabel} ${index + 1} depth slider`}
            title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
            onChange={(e) => onChange({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={trace.depth}
            data-testid={`engrave-trace-depth-${index}`}
            aria-label={`${kindLabel} ${index + 1} depth`}
            title="Depth of the traced groove below the top face, mm."
            style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ depth: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-trace-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
      </p>

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-trace-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
