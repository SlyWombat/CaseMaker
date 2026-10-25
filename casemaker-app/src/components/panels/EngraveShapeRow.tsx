import { useState, type CSSProperties, type JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { itemOperationName } from '@/engine/cnc/engrave/partPlan';
import { regionChipLabel, useRegionOperationType } from '@/components/panels/operationTypes';
import { rowSummary } from '@/components/panels/engraveRowText';
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
 *
 * #411 changed only the row's OUTER shape: `EngraveItemRow` owns the one-line head and draws the
 * editor below it while the row is open. The fields are the ones they were, moved one level in.
 */

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

const KIND_LABEL: Record<EngraveShape['kind'], string> = {
  rect: 'Rectangle',
  circle: 'Circle',
  slot: 'Slot',
  polygon: 'Polygon',
};

/**
 * The one-glyph-per-kind column of the collapsed line (#411). The design's own mockup draws ▭ for a
 * face and ▢ for a pocket; the rest follow it, and a shape reads as itself rather than as "Shape".
 */
const KIND_GLYPH: Record<EngraveShape['kind'], string> = {
  rect: '▭',
  circle: '◯',
  slot: '▬',
  polygon: '⬠',
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
  // #662 - the chip states what THIS cutter makes of a region.
  const region = useRegionOperationType();
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
    // #411 — one line per shape: remove, show/hide, chevron, the kind's own glyph, the name (or the
    // kind's word when it has none) and the depth; the editor below opens on the chevron.
    <EngraveItemRow
      id={shape.id}
      selectable
      prefix="engrave-shape"
      index={index}
      glyph={KIND_GLYPH[shape.kind]}
      kindWord={KIND_LABEL[shape.kind]}
      typeLabel={regionChipLabel(shape.through, region)}
      name={itemOperationName(shape)}
      summary={shape.through === true ? 'through' : rowSummary(shape.depth)}
      enabled={shape.enabled}
      enabledTitle="A disabled shape is kept in the job but not cut."
      removeTitle="Remove this shape."
      removeNoun="shape"
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      {/* The optional name lives in the editor rather than on the line: the line has no room for a
          text field beside the two controls and the summary, and a name nobody has set should read
          as the kind ("Circle"), not as an empty box. */}
      <label style={ROW_INLINE}>
        <span>name</span>
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
      </label>

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
        {/* #218 — a through region has no typed depth: its floor is the breakthrough rule. The
            toggle replaces the depth controls rather than sitting beside a dead input. */}
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={shape.through === true}
            data-testid={`engrave-shape-through-${index}`}
            aria-label={`Shape ${index + 1} through`}
            title="Cut this pocket through the blank into the under-board. Needs a sacrificial board; the depth comes from the breakthrough rule, so no depth is typed."
            onChange={(e) => onChange({ through: e.target.checked ? true : undefined })}
          />
          <span>through</span>
        </label>
        {shape.through !== true && (
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
        )}
      </div>

      {shape.through === true ? (
        <p style={MUTED} data-testid={`engrave-shape-maxdepth-${index}`}>
          Cuts through the blank into the board — the depth is the breakthrough rule, not a typed number.
        </p>
      ) : (
        <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-shape-maxdepth-${index}`}>
          Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
        </p>
      )}
    </EngraveItemRow>
  );
}
