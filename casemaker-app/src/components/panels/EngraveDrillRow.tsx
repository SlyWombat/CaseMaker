import type { CSSProperties, JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { drillOperationName } from '@/engine/cnc/engrave/partPlan';
import { rowSummary } from '@/components/panels/engraveRowText';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { DrillPatch } from '@/store/engraveJobStore';
import type { EngraveDrill } from '@/types/engraveJob';

/**
 * One plunge drill of an engrave job (#220, panel work #260): a single hole or a rectangular
 * array of the same hole.
 *
 * There is deliberately NO diameter field on a drill — the hole IS the cutter's (a bigger hole is
 * a circle pocket, #214) — so the row edits placement, depth, the through flag and, for an array,
 * the lattice. The `through` toggle cuts to the sacrificial board instead of to a typed depth; the
 * job's findings refuse it when no board is fitted (`through-needs-board`) or the bit's flutes do
 * not reach the breakthrough (`through-tool-reach`), so the row does not hide a field the model
 * carries (#218).
 *
 * #668 — A BORE TO SIZE is the same item with `mode: 'bore'`: the cutter helixes down a hole wider
 * than itself, so the row gains the one field a bore owns (the hole's ⌀) and states the helix's
 * pitch, which the panel resolves from the SAME feeds row and shop ramp angle the CAM cuts with.
 * Everything else — placement, depth, through, the array lattice — is the drill row's, unchanged.
 *
 * #675 — a plunge drill's PECK lives behind the row's Technical fold: the number in force (the
 * job's own, or the source that binds — a drill bit's shop setting, or the feeds row), that
 * source's provenance, and a reset. A bore is helixed, not pecked, and offers none.
 *
 * `count` fields commit only whole numbers ≥ 1, because the schema refuses a fractional count
 * outright (a silently floored lattice is not what the user typed) and a bad value would make the
 * whole job unloadable. `pitch` is any positive number.
 *
 * #411 changed only the row's OUTER shape: `EngraveItemRow` owns the one-line head — where the
 * kind used to be a `TAG` span beside a full-width name field, it is now the glyph `⌖` and, for an
 * unnamed hole, the word "Hole" — and draws the editor below while the row is open.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

/** `2` / `0.5` — a number as a sentence or a chip uses it. */
const fmt = (n: number): string => `${Number(n.toFixed(3))}`;

/**
 * #668 — a bore's helix numbers as the panel resolves them: the same feeds row and the same shop
 * ramp angle the CAM reads, put through the same `borePitchMm`. The row prints them; it never
 * computes a second pitch of its own.
 */
export interface BorePitchFacts {
  /** The helix's descent per revolution, mm. */
  pitchMm: number;
  /** The feeds row's step-down cap, mm — one of the pitch's two sources. */
  stepDownMm: number;
  /** The shop's `bore.rampAngleDeg`, degrees — the other source. */
  rampAngleDeg: number;
  /** Where the ramp angle came from (`seeded`, `chosen`, `fallback`). */
  rampSource: string;
  /** Whether the floor spiral runs: false when the wall lap already reaches the hole's centre. */
  spirals: boolean;
}

/**
 * #675 — the peck a plunge drill would cut with, as the panel resolved it: the job's own number
 * when it states one, otherwise the source that binds (a drill bit's shop setting, or the feeds
 * row) — and that source's word either way, so a typed value still says what it overrides.
 */
export interface DrillPeckFacts {
  /** The peck length in force, mm. */
  mm: number;
  /** True when the job states it. */
  typed: boolean;
  /** Where the number would come from otherwise. */
  source: string;
}

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
  /** #668 — a bore's helix pitch, resolved by the panel; null when the job's feeds did not resolve. */
  borePitch?: BorePitchFacts | null;
  /** #675 — the plunge drill's peck, resolved by the panel; null on a bore or with no cutter. */
  peck?: DrillPeckFacts | null;
}

export function EngraveDrillRow({
  drill,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
  borePitch = null,
  peck = null,
}: EngraveDrillRowProps): JSX.Element {
  const isArray = drill.kind === 'drill-array';
  const isBore = drill.mode === 'bore';
  const kindLabel = isBore ? (isArray ? 'Bore array' : 'Bore') : isArray ? 'Hole array' : 'Hole';
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
    // #411 — the collapsed line, and the editor below it. The kind is the glyph `⌖` on the line and
    // its word in the tooltip; a drilled hole has no name of its own, so an unnamed one reads "Hole"
    // / "Hole array" rather than as a blank field, exactly as the shape rows read their kind.
    // #668 — a bore wears `⌾` and says "Bore", because it is the one hole whose width is not the
    // cutter's.
    <EngraveItemRow
      id={drill.id}
      selectable
      prefix="engrave-drill"
      index={index}
      glyph={isBore ? '⌾' : '⌖'}
      kindWord={kindLabel}
      typeLabel={isBore ? 'Bore' : 'Hole'}
      name={drillOperationName(drill)}
      summary={rowSummary(drill.depth)}
      enabled={drill.enabled}
      enabledTitle="A disabled drill is kept in the job but not cut."
      removeTitle={`Remove this ${isBore ? 'bore' : 'drill'}.`}
      removeNoun={kindLabel}
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
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
      </label>

      <p style={MUTED}>
        {isBore
          ? 'A hole to size: the cutter helixes down the wall, laps it at full depth and spirals the floor clean, so the hole may be wider than the cutter.'
          : 'The hole is exactly the cutter’s diameter — for a bigger hole, add a circle pocket instead.'}
      </p>

      {isBore && (
        <div style={ROW_INLINE}>
          <label style={FIELD_LABEL}>
            <span>hole ⌀</span>
            <input
              type="number"
              min={0}
              step="0.1"
              value={drill.diameter ?? ''}
              data-testid={`engrave-drill-diameter-${index}`}
              aria-label={`${kindLabel} ${index + 1} hole diameter`}
              title="The hole's diameter, mm — the size this bore makes, which may be wider than the cutter."
              style={NUM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) onChange({ diameter: v });
              }}
            />
            <span>mm</span>
          </label>
        </div>
      )}
      {isBore && (
        <p style={MUTED} data-testid={`engrave-drill-bore-pitch-${index}`}>
          {borePitch === null
            ? 'The helix pitch is resolved once the job’s cutter and the feeds row are known.'
            : `The helix drops ${fmt(borePitch.pitchMm)} mm per turn — the feeds row’s ` +
              `${fmt(borePitch.stepDownMm)} mm step-down or the shop’s ${fmt(borePitch.rampAngleDeg)}° ramp ` +
              `(${borePitch.rampSource}), whichever is tighter — ` +
              (borePitch.spirals
                ? 'clearing the disc at each level, then laps the wall at full depth.'
                : 'then laps the wall at full depth, a lap that reaches the hole’s centre.')}
        </p>
      )}

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
            title="Cut all the way through the blank and into the board under it. It needs a sacrificial board under the part; without one the job refuses it."
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

      {/* #675 — THE PECK, behind the row's Technical fold: the number in force, where it came
          from, and a reset to the source. A bore is helixed, not pecked, so the fold is not
          offered there; a job with no cutter has no peck to prefill and hides it too. */}
      {peck !== null && (
        <details data-testid={`engrave-drill-technical-${index}`} style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>Technical</summary>
          <div style={{ marginTop: 4, ...ROW_INLINE }}>
            <label style={FIELD_LABEL}>
              <span>peck every</span>
              <input
                type="number"
                min={0.05}
                step="0.5"
                value={fmt(peck.mm)}
                data-testid={`engrave-drill-peck-${index}`}
                aria-label={`${kindLabel} ${index + 1} peck length`}
                title="How deep each peck goes before the drill retracts to clear its chips, mm."
                style={NUM}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) onChange({ peckMm: v });
                }}
              />
              <span>mm</span>
            </label>
            <span data-testid={`engrave-drill-peck-source-${index}`} style={{ ...MUTED, margin: 0 }}>
              {peck.typed ? 'typed in this job' : peck.source}
            </span>
            {peck.typed && (
              <button
                type="button"
                data-testid={`engrave-drill-peck-reset-${index}`}
                title={`Back to ${peck.source}.`}
                onClick={() => onChange({ peckMm: undefined })}
              >
                reset
              </button>
            )}
          </div>
        </details>
      )}
    </EngraveItemRow>
  );
}
