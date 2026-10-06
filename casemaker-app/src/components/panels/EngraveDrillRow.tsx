import type { CSSProperties, JSX } from 'react';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { DrillPatch } from '@/store/engraveJobStore';
import type { EngraveDrill } from '@/types/engraveJob';

/**
 * One plunge drill of an engrave job (#220, panel work #260): a single hole or a rectangular
 * array of the same hole.
 *
 * There is deliberately NO diameter field — the hole IS the cutter's (a bigger hole is a circle
 * pocket, #214) — so the row edits placement, depth, the through flag and, for an array, the
 * lattice. The `through` toggle is present but its finding (`drill-through-unavailable`) refuses
 * it until #218 rules land, so the row does not hide a field the model carries.
 *
 * `count` fields commit only whole numbers ≥ 1, because the schema refuses a fractional count
 * outright (a silently floored lattice is not what the user typed) and a bad value would make the
 * whole job unloadable. `pitch` is any positive number.
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

export interface EngraveDrillRowProps {
  drill: EngraveDrill;
  /** Position of this row in `job.drills`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: DrillPatch) => void;
  onRemove: () => void;
  /** Findings about THIS drill (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveDrillRow({
  drill,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
}: EngraveDrillRowProps): JSX.Element {
  const isArray = drill.kind === 'drill-array';
  const kindLabel = isArray ? 'Hole array' : 'Hole';
  const depthInvalid = drill.depth > maxDepth;

  const positionNum = (axis: 'x' | 'y'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={drill.position[axis]}
        data-testid={`engrave-drill-${axis}-${index}`}
        aria-label={`${kindLabel} ${index + 1} ${axis.toUpperCase()}`}
        title={`${
          isArray ? 'Centre of the lattice — the first hole sits here, the rest step out from it' : 'Centre of the hole'
        }, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...drill.position, [axis]: v } });
        }}
      />
    </label>
  );

  /** A lattice field. `count` commits only whole numbers ≥ 1; `pitch` any positive number. */
  const latticeNum = (group: 'count' | 'pitch', axis: 'x' | 'y', title: string): JSX.Element => {
    const values = isArray ? drill[group] : { x: 1, y: 1 };
    return (
      <label style={FIELD_LABEL}>
        <span>
          {group === 'count' ? '' : 'pitch '}
          {axis.toUpperCase()}
        </span>
        <input
          type="number"
          min={group === 'count' ? 1 : undefined}
          step={group === 'count' ? 1 : 'any'}
          value={values[axis]}
          data-testid={`engrave-drill-${group}-${axis}-${index}`}
          aria-label={`${kindLabel} ${index + 1} ${group} ${axis.toUpperCase()}`}
          title={title}
          style={NUM}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!isArray) return;
            if (group === 'count') {
              if (Number.isInteger(v) && v >= 1) onChange({ count: { ...drill.count, [axis]: v } });
            } else if (Number.isFinite(v) && v > 0) {
              onChange({ pitch: { ...drill.pitch, [axis]: v } });
            }
          }}
        />
      </label>
    );
  };

  return (
    <div
      data-testid={`engrave-drill-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={drill.enabled}
          data-testid={`engrave-drill-enabled-${index}`}
          aria-label={`${kindLabel} ${index + 1} enabled`}
          title="A disabled drill is kept in the job but not cut."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span style={TAG}>{kindLabel}</span>
        <input
          type="text"
          value={drill.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-drill-name-${index}`}
          aria-label={`${kindLabel} ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
        <button
          type="button"
          data-testid={`engrave-drill-remove-${index}`}
          aria-label={`Remove ${kindLabel} ${index + 1}`}
          title="Remove this drill."
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      <p style={MUTED}>
        The hole is exactly the cutter&rsquo;s diameter — for a bigger hole, add a circle pocket instead.
      </p>

      <div style={ROW_INLINE}>
        {positionNum('x')}
        {positionNum('y')}
        {isArray && (
          <>
            {latticeNum('count', 'x', 'Holes across, X. A whole number, at least 1.')}
            {latticeNum('count', 'y', 'Holes across, Y. A whole number, at least 1.')}
            {latticeNum('pitch', 'x', 'Hole spacing in X, mm.')}
            {latticeNum('pitch', 'y', 'Hole spacing in Y, mm.')}
            <label style={FIELD_LABEL}>
              <span>rot</span>
              <input
                type="number"
                step="any"
                value={drill.rotation}
                data-testid={`engrave-drill-rotation-${index}`}
                aria-label={`${kindLabel} ${index + 1} rotation`}
                title="Degrees counter-clockwise the lattice is turned about its centre."
                style={NUM}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) onChange({ rotation: v });
                }}
              />
            </label>
          </>
        )}
      </div>

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={drill.through}
            data-testid={`engrave-drill-through-${index}`}
            aria-label={`${kindLabel} ${index + 1} through`}
            title="Cut all the way through the blank. Needs a sacrificial board (#213) and the through-cut rules (#218), so it is refused until those land."
            onChange={(e) => onChange({ through: e.target.checked })}
          />
          <span>through</span>
        </label>
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="range"
            min={0}
            max={maxDepth}
            step="0.1"
            value={Math.min(drill.depth, maxDepth)}
            aria-label={`${kindLabel} ${index + 1} depth slider`}
            title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
            onChange={(e) => onChange({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={drill.depth}
            data-testid={`engrave-drill-depth-${index}`}
            aria-label={`${kindLabel} ${index + 1} depth`}
            title="Depth of the hole below the top face, mm."
            style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ depth: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-drill-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
      </p>

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-drill-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
