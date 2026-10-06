import { useState, type CSSProperties, type JSX } from 'react';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { KeepOutPatch } from '@/store/engraveJobStore';
import type { EngraveKeepOut } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * One under-surface VOID of an engrave job (#271): enabled, an optional name, the kind's own
 * footprint dimensions, position, rotation and the CEILING.
 *
 * This is the one row in the panel that edits something the cutter must not do. A void is not an
 * item — it is a pocket the blank already has, cut from the BOTTOM face — so it has no `depth`
 * and no `construction`, and it is never cut. What it has instead is `zCeiling`: how high the
 * void reaches, measured from the blank's BOTTOM face (z = 0 at the bottom, `thickness` at the
 * engraved face). That is a DIFFERENT datum from every `depth` in this panel, so the field is
 * labelled with both the datum and its consequence, and the row reads the consequence back:
 *
 *   membrane = thickness − zCeiling   (the solid left above the void)
 *   limit    = membrane − minFloor    (the deepest cut that keeps the job's floor)
 *
 * Both come from `keepOutMembrane` / `keepOutLimit` in `engrave/partPlan.ts` — the SAME two
 * functions `jobDepthLimit` composes and #174's verifier refuses against — so the number the row
 * shows and the number the run enforces cannot drift apart.
 *
 * The polygon editor keeps its text LOCAL and commits only a ring of 3–500 valid points, exactly
 * as the shape row does: a half-typed ring must never reach the job, or the schema would reject
 * the whole document on the next load.
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

const KIND_LABEL: Record<EngraveKeepOut['kind'], string> = {
  rect: 'Rectangle',
  circle: 'Circle',
  slot: 'Slot',
  polygon: 'Polygon',
};

/** The numeric fields a row can edit, across all kinds — the footprint's own numbers. */
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

export interface EngraveKeepOutRowProps {
  keepOut: EngraveKeepOut;
  /** Position of this row in `job.keepOuts`; only used for stable test ids. */
  index: number;
  /** The blank's thickness, mm — the far end of the `zCeiling` datum's scale. */
  thickness: Mm;
  /** `keepOutMembrane(job, zCeiling)`: solid left above this void, mm. */
  membrane: Mm;
  /** `keepOutLimit(job, membrane)`: the deepest cut over this void, mm. */
  limit: Mm;
  onChange: (patch: KeepOutPatch) => void;
  onRemove: () => void;
  /** Findings about THIS void (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveKeepOutRow({
  keepOut,
  index,
  thickness,
  membrane,
  limit,
  onChange,
  onRemove,
  findings,
}: EngraveKeepOutRowProps): JSX.Element {
  // A ceiling at or above the top face is not a deeper pocket — it is a void the blank does not
  // contain, and no cut over it can keep the floor. A non-positive one is below the bottom face.
  const ceilingInvalid = keepOut.zCeiling >= thickness || keepOut.zCeiling <= 0;
  const [pointsText, setPointsText] = useState(() => (keepOut.kind === 'polygon' ? pointsToText(keepOut.points) : ''));

  const numField = (key: NumField, label: string, title: string, invalid = false): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={(keepOut as unknown as Record<string, number>)[key]}
        data-testid={`engrave-keepout-${key}-${index}`}
        aria-label={`Void ${index + 1} ${label}`}
        title={title}
        style={{ ...NUM, ...(invalid ? INVALID : null) }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ [key]: v } as KeepOutPatch);
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
        value={keepOut.position[axis]}
        data-testid={`engrave-keepout-${axis}-${index}`}
        aria-label={`Void ${index + 1} ${axis.toUpperCase()}`}
        title={`Centre of the void's footprint, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...keepOut.position, [axis]: v } });
        }}
      />
    </label>
  );

  return (
    <div
      data-testid={`engrave-keepout-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={keepOut.enabled}
          data-testid={`engrave-keepout-enabled-${index}`}
          aria-label={`Void ${index + 1} enabled`}
          title="A disabled void reserves nothing: the depth limit ignores it, as if it were not there. The blank has not changed."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span style={TAG}>{KIND_LABEL[keepOut.kind]}</span>
        <input
          type="text"
          value={keepOut.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-keepout-name-${index}`}
          aria-label={`Void ${index + 1} name`}
          title="Optional name, shown on the run sheet and in findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
        <button
          type="button"
          data-testid={`engrave-keepout-remove-${index}`}
          aria-label={`Remove void ${index + 1}`}
          title="Remove this void. The blank still has it — only the job forgets."
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      <div style={ROW_INLINE}>
        {keepOut.kind === 'rect' && (
          <>
            {numField('width', 'width', 'Rectangle width in X, mm.')}
            {numField('height', 'height', 'Rectangle height in Y, mm.')}
            {numField(
              'cornerRadius',
              'corner r',
              'Corner radius, mm. 0 = sharp; never more than half the smaller side.',
              keepOut.cornerRadius > Math.min(keepOut.width, keepOut.height) / 2,
            )}
          </>
        )}
        {keepOut.kind === 'circle' && numField('diameter', 'diameter', 'Circle diameter, mm.')}
        {keepOut.kind === 'slot' && (
          <>
            {numField('length', 'length', 'Overall slot length (end to end), mm.')}
            {numField('width', 'width', 'Slot width, mm — the end radius is half of it.', keepOut.length < keepOut.width)}
          </>
        )}
      </div>

      {keepOut.kind === 'polygon' && (
        <label style={{ display: 'block', marginTop: 4 }}>
          <span style={{ ...MUTED, display: 'block' }}>points — one “x, y” per line, relative to the centre</span>
          <textarea
            value={pointsText}
            data-testid={`engrave-keepout-points-${index}`}
            aria-label={`Void ${index + 1} polygon points`}
            title="One x, y pair per line. A closed ring of 3 to 500 points."
            style={{ ...POINTS, ...(parsePoints(pointsText) && parsePoints(pointsText)!.length >= 3 ? null : INVALID) }}
            onChange={(e) => {
              const text = e.target.value;
              setPointsText(text);
              const pts = parsePoints(text);
              // Commit only a valid ring: an invalid one would make the whole job unloadable.
              if (pts && pts.length >= 3 && pts.length <= 500) onChange({ points: pts });
            }}
          />
          <span style={MUTED} data-testid={`engrave-keepout-point-count-${index}`}>
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
        {positionNum('x')}
        {positionNum('y')}
        {numField('rotation', 'rot', 'Degrees counter-clockwise about the footprint centre.')}
        <label style={FIELD_LABEL}>
          <span>ceiling</span>
          <input
            type="number"
            min={0}
            step="0.1"
            value={keepOut.zCeiling}
            data-testid={`engrave-keepout-zceiling-${index}`}
            aria-label={`Void ${index + 1} ceiling`}
            title={`How high the void reaches, measured UP from the blank's BOTTOM face — not down from the engraved face like a depth. The blank is ${thickness} mm thick.`}
            style={{ ...NUM, ...(ceilingInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ zCeiling: v });
            }}
          />
          <span>mm from the bottom</span>
        </label>
      </div>

      <p
        style={{ ...MUTED, ...(limit <= 0 ? { color: SEVERITY_COLOR.error } : null) }}
        data-testid={`engrave-keepout-membrane-${index}`}
      >
        {ceilingInvalid
          ? `A ceiling of ${keepOut.zCeiling} mm is not inside a ${thickness} mm blank — the void reaches the engraving face, so no cut over it can keep the minimum floor.`
          : `Leaves ${membrane.toFixed(2)} mm of material above it: a cut over this void may go ${limit.toFixed(2)} mm deep — the membrane less the minimum floor.`}
      </p>

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-keepout-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
