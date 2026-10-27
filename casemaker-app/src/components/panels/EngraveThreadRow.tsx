import type { CSSProperties, JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { threadOperationName } from '@/engine/cnc/engrave/partPlan';
import { rowSummary } from '@/components/panels/engraveRowText';
import { FASTENERS, type FastenerSize } from '@/engine/compiler/fasteners';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { ThreadPatch } from '@/store/engraveJobStore';
import type { EngraveThreadItem } from '@/types/engraveJob';

/**
 * One milled thread of an engrave job (#445, the row half of #434 phase 2).
 *
 * A thread is a drill's sibling with two differences the row has to carry honestly:
 *
 *   1. **The thread is the ITEM's, not the cutter's.** `size` selects an ISO 261 coarse size, and
 *      its pitch and basic minor come from `FASTENERS` — so the select is labelled `M5 × 0.8`,
 *      pitch on screen, rather than leaving the number for the findings to explain. The catalogue's
 *      own pitch/thread-angle extras are not consulted (D2).
 *   2. **The pilot is assumed, never cut (D1).** A thread mill cannot enter solid stock, so the
 *      row says so in its own words and names the pilot's diameter from the same table the CAM
 *      reads (`FASTENERS[size].minor`, ISO 61's `D1 = D − 1.0825P`).
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

/** Every size the ISO 261 coarse table carries, in ascending order. */
const SIZES = Object.keys(FASTENERS) as FastenerSize[];

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
}

export function EngraveThreadRow({
  thread,
  index,
  maxDepth,
  maxDepthWhy = 'the stock thickness less the minimum floor',
  onChange,
  onRemove,
  findings,
}: EngraveThreadRowProps): JSX.Element {
  const spec = FASTENERS[thread.size];
  const depthInvalid = thread.depth > maxDepth;

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
          <span>size</span>
          <select
            value={thread.size}
            data-testid={`engrave-thread-size-${index}`}
            aria-label={`Thread ${index + 1} size`}
            title="ISO 261 metric coarse. The item states the thread: the pitch comes with the size, not from the cutter."
            onChange={(e) => onChange({ size: e.target.value as FastenerSize })}
          >
            {SIZES.map((size) => (
              <option key={size} value={size}>
                {size} × {FASTENERS[size].pitch} mm
              </option>
            ))}
          </select>
        </label>
        {positionNum('x')}
        {positionNum('y')}
      </div>

      <p style={MUTED}>
        The program cuts the thread only — it never drills. The pilot must already be{' '}
        <strong>⌀{spec.minor} mm</strong> (ISO 261 basic minor for {thread.size} × {spec.pitch}), through at
        least the threaded length plus the entry ramp.
      </p>

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
