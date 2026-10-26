import type { CSSProperties, JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { chamferOperationName } from '@/engine/cnc/engrave/partPlan';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { ChamferPatch } from '@/store/engraveJobStore';
import type { EngraveChamfer } from '@/types/engraveJob';

/**
 * One CHAMFER of an engrave job (#669): a flat bevel along a profile's part edge or a pocket's
 * rim, cut by the job's cone's flank.
 *
 * The row owns the two things the operator decides — WHICH rim, and HOW WIDE the bevel is on the
 * top face. Everything else is derived and stated rather than asked for: the tip plane is
 * `width / tan(halfAngle)` below the top face, the tool runs one tip radius from the edge on the
 * air side, and the widest chamfer the cutter can cut in one pass is its cone's own reach. A
 * width past that reach is refused by name (`chamfer-too-wide`), not silently stepped.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

/** `2` / `0.5` — a number as a sentence uses it. */
const fmt = (n: number): string => `${Number(n.toFixed(3))}`;

/** One rim the `of` picker can name: an item whose own outline is a closed edge. */
export interface ChamferRimOption {
  id: string;
  label: string;
}

/** What the panel resolved about the job's cutter for this row: the cone and its reach. */
export interface ChamferFacts {
  /** The cutter as the row names it; null when the job names none. */
  cutterName: string | null;
  /** The cone's half angle, degrees — 45 on a 90° chamfer bit. */
  halfAngleDeg: number | null;
  /** The widest chamfer this cone reaches in one pass, mm; null when it states no diameter. */
  reachMm: number | null;
  /** The cutter's tip diameter, mm, and where it came from — null with no cone. */
  tipDiameterMm: number | null;
  tipSource: 'stated' | 'point, by kind' | null;
}

export interface EngraveChamferRowProps {
  chamfer: EngraveChamfer;
  /** Position of this row in `job.chamfers`; only used for stable test ids. */
  index: number;
  /** Every rim a chamfer can follow. */
  rims: readonly ChamferRimOption[];
  /**
   * The word for a named rim this list does NOT hold — `disabled` or `not in the job` — or null
   * when the name resolves. The select renders it as its own option, so a row whose `of` points at
   * a dead rim never shows the FIRST rim as if it had chosen it.
   */
  missingRimLabel?: string | null;
  /** The job's cutter as a cone, or null facts when it has none. */
  facts: ChamferFacts;
  onChange: (patch: ChamferPatch) => void;
  onRemove: () => void;
  /** Findings about THIS chamfer (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveChamferRow({
  chamfer,
  index,
  rims,
  missingRimLabel = null,
  facts,
  onChange,
  onRemove,
  findings,
}: EngraveChamferRowProps): JSX.Element {
  const rim = rims.find((r) => r.id === chamfer.of) ?? null;
  const depth =
    facts.halfAngleDeg === null ? null : chamfer.width / Math.tan((facts.halfAngleDeg * Math.PI) / 180);
  return (
    <EngraveItemRow
      id={chamfer.id}
      selectable
      prefix="engrave-chamfer"
      index={index}
      glyph="◺"
      kindWord="Chamfer"
      typeLabel="Chamfer"
      name={chamferOperationName(chamfer, rim?.label ?? null)}
      summary={`${fmt(chamfer.width)} mm`}
      enabled={chamfer.enabled}
      enabledTitle="A disabled chamfer is kept in the job but not cut."
      removeTitle="Remove this chamfer."
      removeNoun="chamfer"
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
        <input
          type="text"
          value={chamfer.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-chamfer-name-${index}`}
          aria-label={`Chamfer ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
      </label>

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <span>of</span>
          <select
            value={chamfer.of ?? ''}
            data-testid={`engrave-chamfer-of-${index}`}
            aria-label={`Chamfer ${index + 1} rim`}
            title="The edge this bevel breaks: a cut-out's part edge, or a pocket's rim."
            onChange={(e) => onChange({ of: e.target.value })}
          >
            {chamfer.of === undefined && <option value="">choose a rim</option>}
            {chamfer.of !== undefined && missingRimLabel !== null && (
              <option value={chamfer.of}>{`${chamfer.of} (${missingRimLabel})`}</option>
            )}
            {rims.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label style={FIELD_LABEL}>
          <span>side</span>
          <select
            value={chamfer.side}
            data-testid={`engrave-chamfer-side-${index}`}
            aria-label={`Chamfer ${index + 1} side`}
            title="Which side of the outline the cutter runs: outside breaks a part's edge (before its cut-out); inside breaks a pocket's rim (after the pocket)."
            onChange={(e) => onChange({ side: e.target.value as EngraveChamfer['side'] })}
          >
            <option value="outside">outside (a part’s edge)</option>
            <option value="inside">inside (a pocket’s rim)</option>
          </select>
        </label>
        <label style={FIELD_LABEL}>
          <span>width</span>
          <input
            type="number"
            min={0}
            step="0.1"
            value={chamfer.width}
            data-testid={`engrave-chamfer-width-${index}`}
            aria-label={`Chamfer ${index + 1} width`}
            title="The chamfer's width on the top face, mm. The bevel's depth follows from the cutter's angle."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) onChange({ width: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={MUTED} data-testid={`engrave-chamfer-derived-${index}`}>
        {facts.cutterName === null
          ? 'Choose the job’s cutter first — a chamfer is a cone’s flank, and its depth and reach come from that cutter.'
          : facts.halfAngleDeg === null
            ? `${facts.cutterName} has no usable cone, so a chamfer cannot be cut with it; use a V-bit or a chamfer bit.`
            : `A ${fmt(chamfer.width)} mm chamfer reaches ${fmt(depth as number)} mm below the top face — the width over ` +
              `tan(${fmt(facts.halfAngleDeg)}°) — with the cutter ${chamfer.side === 'outside' ? 'outside the part' : 'inside the pocket'} ` +
              (facts.reachMm === null
                ? '; the cutter states no cutting diameter, so its reach is unknown.'
                : `; ${facts.cutterName} reaches ${fmt(facts.reachMm)} mm in one pass.`) +
              (facts.tipDiameterMm === null || facts.tipSource === null
                ? ''
                : ` Tip ${fmt(facts.tipDiameterMm)} mm (${facts.tipSource}).`)}
      </p>
    </EngraveItemRow>
  );
}
