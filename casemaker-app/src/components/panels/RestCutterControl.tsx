import type { CSSProperties, JSX } from 'react';

/**
 * #667 — the REST PAIR's control, shared by every region row (a label, a shape, a combined shape,
 * a vector, a cuttable primitive).
 *
 * The engine's rest pass is per SETUP and measured from program 1's own simulated stock: the
 * second cutter cuts only what the first left, at each item's floor. The issue frames the choice
 * on the operation row, and the row's body is its technical layer; this control writes the
 * setup's second cutter — the model's own unit — and a multi-setup job names the setup the
 * row's choice belongs to.
 *
 * The summary is the sentence a person is looking for: "Finish the corners with a smaller cutter".
 * None is the default, and nothing here pretends the rest pass is free: the two programs are two
 * files, two probes and a cutter change.
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

/** A cutter a rest pass may use, and how it is named. */
export interface RestCutterOption {
  key: string;
  /** The cutter as the registry names it. */
  name: string;
  /** Cutting diameter, mm — positive by construction (the option list filters the rest). */
  diameter: number;
}

/** Everything the control shows and the one thing it writes. */
export interface RestChoice {
  /** The setup's FIRST cutter, the rough pass; null when the job names none yet. */
  rough: { key: string; name: string; diameter: number | null } | null;
  /** Whether the rough cutter is a V-bit: the rest bit then flat-bottoms the groove it opened. */
  roughIsV: boolean;
  /**
   * #677 — this row is a VARIABLE-depth V-carve, so the second cutter is not a rest pass at all:
   * it clears the core the V's width cannot reach, a flat bottom at the carve's own depth, in its
   * own program after the V-carve.
   */
  coreClearance: boolean;
  /** The cutters a rest pass may use: smaller than the rough, flat, not a V-bit or a drill. */
  options: readonly RestCutterOption[];
  /** The setup's chosen rest cutter, or null. */
  restKey: string | null;
  /** 1-based setup number when the job stores its setups; null for the single implicit setup. */
  setupNumber: number | null;
  /** The row's chip text, already worded (`rest ⌀1 mm`); null when no rest cutter is chosen. */
  chip: string | null;
  onPick: (key: string | null) => void;
}

/** `1` / `0.5` — a diameter in the words a chip or a sentence uses. */
function dia(d: number): string {
  return `${Number(d.toFixed(3))}`;
}

/** The chip on the operation's one line: `rest ⌀1 mm`, or `core ⌀1 mm` for a #677 clearance. */
export function restChipLabel(option: RestCutterOption, coreClearance = false): string {
  return `${coreClearance ? 'core' : 'rest'} ⌀${dia(option.diameter)} mm`;
}

export function RestCutterControl({
  rest,
  testidPrefix,
  index,
}: {
  rest: RestChoice;
  /** The row's testid stem (`engrave-label`), so the control's ids sit beside its fields. */
  testidPrefix: string;
  index: number;
}): JSX.Element {
  const chosen = rest.restKey === null ? null : (rest.options.find((o) => o.key === rest.restKey) ?? null);
  return (
    <details data-testid={`${testidPrefix}-rest-${index}`} style={{ marginTop: 6 }}>
      <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>
        {rest.coreClearance ? 'Clear the middle the V cannot reach' : 'Finish the corners with a smaller cutter'}
      </summary>
      <div style={{ marginTop: 4 }}>
        <label style={FIELD_LABEL}>
          <span>rest cutter</span>
          <select
            value={rest.restKey ?? ''}
            data-testid={`${testidPrefix}-rest-select-${index}`}
            aria-label="Rest cutter"
            title={
              rest.coreClearance
                ? "The setup's second cutter: it pockets the middle the V's width cannot reach, in its own program after the V-carve."
                : "The setup's second cutter: it cuts only what the rough cutter leaves."
            }
            disabled={rest.rough === null}
            onChange={(e) => rest.onPick(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">none — one cutter cuts this job</option>
            {rest.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name} — ⌀{dia(o.diameter)} mm
              </option>
            ))}
            {rest.restKey !== null && chosen === null && (
              <option value={rest.restKey}>{rest.restKey} (not in the library)</option>
            )}
          </select>
        </label>
        <p style={MUTED} data-testid={`${testidPrefix}-rest-note-${index}`}>
          {rest.rough === null
            ? 'Choose the job’s cutter first — the rest cutter is the setup’s second.'
            : rest.coreClearance
              ? chosen === null
                ? rest.options.length === 0
                  ? 'No flat end mill is in the library, so the core the V cannot reach would stand.'
                  : 'The flat end mill pockets the middle the V’s width cannot reach — a flat bottom at the carve’s own depth, in its own program after the V-carve.'
                : `${chosen.name} pockets the middle ${rest.rough.name}’s width cannot reach at the cap, in its own program after the V-carve.`
              : chosen === null
                ? rest.options.length === 0
                  ? 'No smaller flat cutter is in the library, so this job has no rest pair to offer.'
                  : `The rest pass is measured from the first program’s simulated stock: ${rest.rough.name} roughs, and the smaller cutter cuts only the corners and slivers it leaves.`
                : `${chosen.name} cuts only what ${rest.rough.name} leaves. The pass is measured from the first program’s simulated stock, so nothing already cleared is cut again except the band the two programs overlap.` +
                  (rest.roughIsV ? ' The rough cutter is a V-bit; the rest bit flat-bottoms the groove it opened.' : '')}
          {rest.setupNumber === null || chosen === null ? '' : ` Setup ${rest.setupNumber}’s second cutter.`}
        </p>
        {chosen === null && rest.restKey !== null && (
          <p style={MUTED} data-testid={`${testidPrefix}-rest-missing-${index}`}>
            The setup names “{rest.restKey}”, which is not a cutter in the library; choose another or none.
          </p>
        )}
      </div>
    </details>
  );
}
