import { useState, type CSSProperties, type JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { traceOperationName } from '@/engine/cnc/engrave/partPlan';
import { fluteNumbers, fluteOperationName } from '@/engine/cnc/engrave/flute';
import { rowSummary } from '@/components/panels/engraveRowText';
import { STROKE_FONTS } from '@/engine/fonts/stroke/strokeFont';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { TracePatch } from '@/store/engraveJobStore';
import { MAX_LINE_POINTS, type EngraveTraceItem } from '@/types/engraveJob';
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

/** A line item's path length, mm: its segments plus the closing one for a ring (#674). */
function lineLength(points: readonly (readonly [number, number])[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  if (closed && points.length >= 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    total += Math.hypot(first[0] - last[0], first[1] - last[1]);
  }
  return total;
}

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };
const POINTS: CSSProperties = {
  width: '100%',
  minHeight: 54,
  fontFamily: 'monospace',
  fontSize: 11,
  boxSizing: 'border-box',
};

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

/** The schema's cap, ONE definition (#664): the editor commits only a loadable path (#219). */
const MAX_POINTS = MAX_LINE_POINTS;

/**
 * The schema's #409 bounds, mirrored for the same reason: the editor commits only a stroke label
 * the job document will load again. `weight` is a positive cut width; `widthScale` condenses x.
 */
const MIN_WIDTH_SCALE = 0.5;
const MAX_WIDTH_SCALE = 2;
const MAX_STROKE_WEIGHT = 20;

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
  /**
   * #724 W4 — the words after "Max depth N mm here —": the stock thickness on a plate, the
   * rod's radius (or the tube's wall) on a rotary job. Omitted, the plate's words stand.
   */
  maxDepthWhy?: string;
  onChange: (patch: TracePatch) => void;
  onRemove: () => void;
  /** Findings about THIS trace (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveTraceRow({
  trace,
  index,
  maxDepth,
  maxDepthWhy = 'the stock thickness less the minimum floor',
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
      {/* #726 P6 — cap height is millimetres, rotation degrees. */}
      <span>{key === 'rotation' ? '°' : 'mm'}</span>
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
      <span>mm</span>
    </label>
  );

  return (
    // #411 — the collapsed line. A trace's kind is its glyph on the line and its word in the
    // tooltip, so "Line" and "Single-line text" stay distinguishable while both read as one line.
    <EngraveItemRow
      id={trace.id}
      selectable
      prefix="engrave-trace"
      index={index}
      glyph={trace.kind === 'line' ? '∿' : '𝑡'}
      kindWord={kindLabel}
      typeLabel={trace.kind === 'line' && trace.flute !== undefined ? 'Flute' : 'Engrave'}
      name={trace.kind === 'line' && trace.flute !== undefined ? fluteOperationName(trace) : traceOperationName(trace)}
      summary={rowSummary(trace.depth)}
      enabled={trace.enabled}
      enabledTitle="A disabled trace is kept in the job but not cut."
      removeTitle="Remove this trace."
      removeNoun="trace"
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
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
      </label>

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

      {/* #409 — the stroke model, for a LABEL item. All three are OPT-IN and absent by default,
          so a stored job that states none of them lays out exactly as before. The first two need
          a V-bit: bold offsets a cone's depth-dependent groove, and the gap rule measures "a
          groove's width"; a flat end mill's cut is its diameter at every depth, and the engine
          ignores both fields rather than inventing a width. */}
      {trace.kind === 'stroke-label' && (
        <div style={ROW_INLINE}>
          <label style={FIELD_LABEL}>
            <span>bold</span>
            <input
              type="number"
              min={0}
              step="any"
              value={trace.weight ?? ''}
              placeholder="off"
              data-testid={`engrave-trace-weight-${index}`}
              aria-label={`${kindLabel} ${index + 1} bold target cut width`}
              title="Bold: the cut width this stroke's parallel passes must reach, mm. Needs a V-bit — a flat end mill's cut is its diameter. Blank is one cutter width."
              style={NUM}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') return onChange({ weight: undefined });
                const v = Number(raw);
                // Commit only a loadable number; a half-typed or out-of-bound value keeps the
                // stored one, exactly as the points editor refuses an invalid path.
                if (Number.isFinite(v) && v > 0 && v <= MAX_STROKE_WEIGHT) onChange({ weight: v });
              }}
            />
            <span>mm</span>
          </label>
          <label style={FIELD_LABEL}>
            <span>condense</span>
            <input
              type="number"
              min={MIN_WIDTH_SCALE}
              max={MAX_WIDTH_SCALE}
              step="any"
              value={trace.widthScale ?? ''}
              placeholder="1"
              data-testid={`engrave-trace-widthscale-${index}`}
              aria-label={`${kindLabel} ${index + 1} horizontal condense`}
              title="Condense: multiply x only, 0.5–2, so the line gets shorter without losing cap height. Blank is the font's own widths."
              style={NUM}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') return onChange({ widthScale: undefined });
                const v = Number(raw);
                if (Number.isFinite(v) && v >= MIN_WIDTH_SCALE && v <= MAX_WIDTH_SCALE) {
                  onChange({ widthScale: v });
                }
              }}
            />
            <span>×</span>
          </label>
          <label style={FIELD_LABEL}>
            <input
              type="checkbox"
              checked={trace.spacing === 'cut-width'}
              data-testid={`engrave-trace-spacing-${index}`}
              aria-label={`${kindLabel} ${index + 1} keep a groove between letters`}
              title="Keep at least one groove's width of clear, uncut surface between neighbouring letters. Needs a V-bit, because it measures the groove the cone opens at this depth. Off by default."
              onChange={(e) => onChange({ spacing: e.target.checked ? 'cut-width' : undefined })}
            />
            <span>keep a groove between letters</span>
          </label>
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
        {/* #674 — a FLUTE: the groove ramps in and out along the line's ends instead of plunging.
            The depth above is the groove's deepest point; the ramp is its own number. */}
        {trace.kind === 'line' && (
          <label style={FIELD_LABEL}>
            <input
              type="checkbox"
              checked={trace.flute !== undefined}
              data-testid={`engrave-trace-flute-${index}`}
              aria-label={`${kindLabel} ${index + 1} ramped ends`}
              title="Cut this line as a flute: the groove ramps down from the surface along its ends, so there is no plunge dimple and no retract out of the groove."
              onChange={(e) => onChange({ flute: e.target.checked ? {} : undefined })}
            />
            <span>ramped ends</span>
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
        Max depth {maxDepth} mm here — {maxDepthWhy}.
      </p>

      {/* #674 — THE FLUTE'S numbers: the ramp the profile runs with, and the path length it has to
          share. Derived by `fluteNumbers`, the same call the plan makes. */}
      {trace.kind === 'line' && trace.flute !== undefined && (() => {
        const n = fluteNumbers(trace.flute, trace.depth);
        const length = lineLength(trace.points, trace.closed);
        const peak = 2 * n.rampMm >= length ? (length > 0 ? (trace.depth * length) / (2 * n.rampMm) : 0) : trace.depth;
        return (
          <div data-testid={`engrave-trace-flute-note-${index}`} style={{ marginTop: 4 }}>
            <div style={ROW_INLINE}>
              <label style={FIELD_LABEL}>
                <span>ramp</span>
                <input
                  type="number"
                  min={0.1}
                  step="0.5"
                  value={Number(n.rampMm.toFixed(3))}
                  data-testid={`engrave-trace-flute-ramp-${index}`}
                  aria-label={`${kindLabel} ${index + 1} flute ramp`}
                  title="The ramp's length along the path, mm. Three times the depth is the default: the ramp then runs at about 18°."
                  style={NUM}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) onChange({ flute: { ...trace.flute, rampMm: v } });
                  }}
                />
                <span>mm</span>
              </label>
            </div>
            <p style={{ ...MUTED, ...(peak < trace.depth - 1e-9 ? { color: SEVERITY_COLOR.warning } : null) }}>
              {`A ramped groove: it fades in and out over ${Number(n.rampMm.toFixed(3))} mm at each end (${n.rampSource}) and is ${Number(
                peak.toFixed(3),
              )} mm deep along the middle. The tool starts on the surface and feeds down, so there is no plunge dimple.` +
                (peak < trace.depth - 1e-9
                  ? ` The path is only ${Number(length.toFixed(1))} mm long and shorter than its two ramps, so the groove never reaches the full depth — shorten the ramp or lengthen the line.`
                  : '')}
            </p>
          </div>
        );
      })()}
    </EngraveItemRow>
  );
}
