import type { CSSProperties, JSX, ReactNode } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { threadOperationName } from '@/engine/cnc/engrave/partPlan';
import { rowSummary } from '@/components/panels/engraveRowText';
import {
  METRIC_THREAD_SIZES,
  UNIFIED_THREAD_SIZES,
  fmtPitch,
  threadOptionLabel,
  threadSpec,
  type ThreadSize,
  type ThreadStandard,
} from '@/engine/cnc/threadTable';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { ThreadPatch } from '@/store/engraveJobStore';
import type { EngraveThreadItem } from '@/types/engraveJob';

/**
 * One milled thread of an engrave job (#445, the row half of #434 phase 2).
 *
 * A thread is a drill's sibling with two differences the row has to carry honestly:
 *
 *   1. **The thread is the ITEM's, not the cutter's.** `size` selects a size from the thread table
 *      (ISO 261 metric, ASME B1.1 UNC/UNF since #841), and its pitch and minors come from there —
 *      so the select is labelled `M5 × 0.8 mm` or `1/4-20 UNC (20 TPI, P 1.27 mm)`,
 *      pitch on screen, rather than leaving the number for the findings to explain. The catalogue's
 *      own pitch/thread-angle extras are not consulted (D2).
 *   2. **The pilot is assumed, never cut (D1).** A thread mill cannot enter solid stock, so the
 *      row says so in its own words and names the pilot's diameter from the same table the CAM
 *      reads (`threadSpec(size).minor`, ISO 68-1's `D1 = D − 1.0825P`). An EXTERNAL thread (#841)
 *      names its boss instead, and offers to state one when none stands at the axis.
 *
 * The `through` toggle is present and refused by its finding (`thread-through-unavailable`) until
 * #213/#218 land, exactly as the drill row's is: the row does not hide a field the model carries.
 * `rotation` is absent because a round feature has none, and `standard`/`classFit` are fixed (D5) —
 * a control for a union of one would be a lie about what can be chosen.
 *
 * #411 put the row on `EngraveItemRow`: the glyph `⌗` and the depth are the collapsed line, and
 * everything here is the editor below it.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

/** #841 — the picker's sizes per system: ISO 261 metric coarse, and ASME B1.1 UNC/UNF. */
const SIZES: Record<ThreadStandard, readonly ThreadSize[]> = { metric: METRIC_THREAD_SIZES, imperial: UNIFIED_THREAD_SIZES };

export interface EngraveThreadRowProps {
  thread: EngraveThreadItem;
  /** Position of this row in `job.threads`; only used for stable test ids. */
  index: number;
  /** Largest thread depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  /**
   * #724 W4 — the words after "Max depth N mm here —": the stock thickness on a plate, the
   * rod's radius (or the tube's wall) on a rotary job. Omitted, the plate's words stand.
   */
  maxDepthWhy?: string;
  onChange: (patch: ThreadPatch) => void;
  onRemove: () => void;
  /** Findings about THIS thread (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
  /**
   * #841 — an external thread's boss as the panel found it (`threadBoss`): its words, or null when
   * none stands at the axis. Absent on an internal thread.
   */
  boss?: { what: string } | null;
  /** #841 — the one press that states a boss at the axis (a reference circle of the major). */
  onAddBoss?: () => void;
  /** #841 — a one-press control beside a finding (the nearest owned thread mill). */
  findingAction?: (finding: JobFinding) => ReactNode;
}

export function EngraveThreadRow({
  thread,
  index,
  maxDepth,
  maxDepthWhy = 'the stock thickness less the minimum floor',
  onChange,
  onRemove,
  findings,
  boss,
  onAddBoss,
  findingAction,
}: EngraveThreadRowProps): JSX.Element {
  const spec = threadSpec(thread.size);
  const external = thread.side === 'external';
  const depthInvalid = thread.depth > maxDepth;
  const standardWords = spec.standard === 'metric' ? 'ISO 261 basic minor' : 'ASME B1.1 basic minor';

  const positionNum = (axis: 'x' | 'y'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={thread.position[axis]}
        data-testid={`engrave-thread-${axis}-${index}`}
        aria-label={`Thread ${index + 1} ${axis.toUpperCase()}`}
        title={`Axis of the hole, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...thread.position, [axis]: v } });
        }}
      />
      <span>mm</span>
    </label>
  );

  return (
    <EngraveItemRow
      id={thread.id}
      selectable
      prefix="engrave-thread"
      index={index}
      glyph="⌗"
      kindWord="Thread"
      typeLabel="Thread"
      name={threadOperationName(thread)}
      summary={rowSummary(thread.depth)}
      enabled={thread.enabled}
      enabledTitle="A disabled thread is kept in the job but not cut."
      removeTitle="Remove this thread."
      removeNoun="Thread"
      findings={findings}
      {...(findingAction === undefined ? {} : { findingAction })}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
        <input
          type="text"
          value={thread.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-thread-name-${index}`}
          aria-label={`Thread ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
      </label>

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <span>side</span>
          <select
            value={external ? 'external' : 'internal'}
            data-testid={`engrave-thread-side-${index}`}
            aria-label={`Thread ${index + 1} side`}
            title="Internal: a threaded hole, milled inside a pilot. External: a threaded boss, milled around the outside of a boss or rod."
            onChange={(e) => onChange({ side: e.target.value === 'external' ? 'external' : undefined })}
          >
            <option value="internal">Internal (a hole)</option>
            <option value="external">External (a boss)</option>
          </select>
        </label>
        <label style={FIELD_LABEL}>
          <span>system</span>
          <select
            value={spec.standard}
            data-testid={`engrave-thread-standard-${index}`}
            aria-label={`Thread ${index + 1} system`}
            title="Metric (ISO 261 coarse) or imperial (UNC/UNF, ASME B1.1). Switching keeps the thread about the same size."
            onChange={(e) => onChange({ standard: e.target.value === 'imperial' ? 'imperial' : 'metric' })}
          >
            <option value="metric">Metric</option>
            <option value="imperial">Imperial (UNC/UNF)</option>
          </select>
        </label>
        <label style={FIELD_LABEL}>
          <span>size</span>
          <select
            value={thread.size}
            data-testid={`engrave-thread-size-${index}`}
            aria-label={`Thread ${index + 1} size`}
            title={
              spec.standard === 'metric'
                ? 'ISO 261 metric coarse. The item states the thread: the pitch comes with the size, not from the cutter.'
                : 'UNC/UNF from ASME B1.1, as size-TPI. The pitch in mm is 25.4 ÷ TPI. The item states the thread, not the cutter.'
            }
            onChange={(e) => onChange({ size: e.target.value as ThreadSize })}
          >
            {SIZES[spec.standard].map((size) => (
              <option key={size} value={size}>
                {threadOptionLabel(size)}
              </option>
            ))}
          </select>
        </label>
        {positionNum('x')}
        {positionNum('y')}
      </div>

      {spec.tpi !== null ? (
        <p style={MUTED} data-testid={`engrave-thread-pitch-${index}`}>
          {thread.size} {spec.series}: {spec.tpi} TPI = <strong>{fmtPitch(spec.pitch)} mm</strong> pitch (25.4 mm ÷ {spec.tpi}), ⌀
          {spec.major} mm major.
        </p>
      ) : null}

      {external ? (
        <>
          <p style={MUTED} data-testid={`engrave-thread-boss-note-${index}`}>
            The program cuts the thread only — it never cuts the boss. The boss must already stand at{' '}
            <strong>⌀{spec.major} mm</strong>, at least the threaded length plus a pitch tall; the tooth tip lands on the ⌀
            {spec.externalMinor} mm external minor (ISO 965-1 d3).
          </p>
          <p style={MUTED} data-testid={`engrave-thread-boss-${index}`}>
            {boss === undefined || boss === null ? (
              <>
                No boss is centred here.{' '}
                {onAddBoss !== undefined ? (
                  <button type="button" data-testid={`engrave-thread-add-boss-${index}`} onClick={onAddBoss}>
                    Add a ⌀{spec.major} mm boss here
                  </button>
                ) : null}
              </>
            ) : (
              <>Cut on {boss.what}.</>
            )}
          </p>
        </>
      ) : (
        <p style={MUTED}>
          The program cuts the thread only — it never drills. The pilot must already be{' '}
          <strong>⌀{spec.minor} mm</strong> ({standardWords} for {thread.size} × {fmtPitch(spec.pitch)} mm pitch), through at
          least the threaded length plus the entry ramp.
        </p>
      )}

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={thread.through}
            data-testid={`engrave-thread-through-${index}`}
            aria-label={`Thread ${index + 1} through`}
            title="Thread all the way through the blank and into the board under it. It needs a sacrificial board under the part; without one the job refuses it."
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
            value={Math.min(thread.depth, maxDepth)}
            aria-label={`Thread ${index + 1} depth slider`}
            title={`Threaded length below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
            onChange={(e) => onChange({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={thread.depth}
            data-testid={`engrave-thread-depth-${index}`}
            aria-label={`Thread ${index + 1} depth`}
            title="Threaded length below the top face, mm. The tool tip runs a pitch past it, so the pilot must be deeper still."
            style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ depth: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-thread-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — {maxDepthWhy}.
      </p>
    </EngraveItemRow>
  );
}
