import type { CSSProperties, JSX } from 'react';
import { DEFAULT_INLAY_GLUE_GAP_MM, type InlayNumbers } from '@/engine/cnc/engrave/inlay';
import type { InlayMark } from '@/types/engraveJob';

/**
 * #673/#742 — THE FEMALE INLAY HALF'S FACTS, shared by every row kind that can carry the mark.
 *
 * An inlay is TWO JOBS, one per blank: the row that carries the FEMALE marker states the glue gap
 * the operator decides, the plug numbers the cone derives from it, and the action that saves the
 * matching male blank as its own job. #742 put the same marker on labels, so the block lives here
 * and both rows draw the SAME control instead of two copies that could drift.
 *
 * The refusal (#742) is the panel's: where the derivation cannot make a male from the job's
 * marked items — a label with no text, a cutaway whose island is gone — the sentence says why in
 * plain words and the save action is disabled rather than silently doing nothing.
 */

const NUM: CSSProperties = { width: 60 };
/** The panel's error colour, the same one `SEVERITY_COLOR.error` names in the row components. */
const ERROR_COLOR = '#f0b4ad';
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const ERROR: CSSProperties = { fontSize: 11, color: ERROR_COLOR, lineHeight: 1.5, margin: '2px 0' };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

/** `2` / `0.5` — a number as a sentence uses it. */
const fmt = (n: number): string => `${Number(n.toFixed(3))}`;

export interface EngraveInlayFactsProps {
  /**
   * The test-id stem the row already owns: `engrave-shape` or `engrave-label`. Keeping the prefix
   * per row kind is what lets a flow find "this item's inlay block" without knowing which kind it
   * is looking at.
   */
  prefix: 'engrave-shape' | 'engrave-label';
  /** Position of the row in its list; only used for stable test ids. */
  index: number;
  /** The word the aria labels use: `Shape` or `Label`. */
  noun: string;
  /** The marker itself. Callers pass it only for a FEMALE half. */
  mark: InlayMark;
  /** The derived numbers, or null when they do not derive (the note then says what to change). */
  numbers: InlayNumbers | null;
  /** Write a new glue gap onto the marker, mm. */
  onGlueGap: (mm: number) => void;
  /** Save the male blank as its own job, or null while the job cannot make one. */
  onSaveMale: (() => void) | null;
  /** #742 — why the male cannot be made, in a plain sentence, or null when it can. */
  refusal?: string | null;
}

export function EngraveInlayFacts({
  prefix,
  index,
  noun,
  mark,
  numbers,
  onGlueGap,
  onSaveMale,
  refusal = null,
}: EngraveInlayFactsProps): JSX.Element {
  return (
    <div data-testid={`${prefix}-inlay-${index}`} style={{ marginTop: 4 }}>
      <p style={MUTED}>
        The female half of a V-carve inlay: the design is the pocket, and a second blank is cut
        as its plug.
      </p>
      <label style={FIELD_LABEL}>
        <span>glue gap</span>
        <input
          type="number"
          min={0.01}
          step="0.05"
          value={fmt(mark.glueGapMm ?? DEFAULT_INLAY_GLUE_GAP_MM)}
          data-testid={`${prefix}-inlay-gap-${index}`}
          aria-label={`${noun} ${index + 1} inlay glue gap`}
          title="The vertical clearance between the plug's end and this pocket's floor, mm. The plug's edge sits in from the design by this gap times the V's half-angle tangent."
          style={NUM}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) onGlueGap(v);
          }}
        />
        <span>mm</span>
      </label>
      <p
        style={{ ...MUTED, ...(numbers === null ? { color: ERROR_COLOR } : null) }}
        data-testid={`${prefix}-inlay-note-${index}`}
      >
        {numbers === null
          ? 'The glue gap must be above zero and below the pocket depth for a plug to fit it.'
          : `Pocket ${fmt(numbers.pocketDepthMm)} mm · plug ${fmt(numbers.plugDepthMm)} mm · ` +
            `the plug's edge ${fmt(numbers.topInsetMm)} mm inside the design — the gap down the ` +
            `flank is ${fmt(numbers.wallClearanceMm)} mm.`}
      </p>
      {/* #742 — the mark is kept, and the refusal is SAID. A mark on an item no male can be made
          from must not look like a feature that quietly does nothing. */}
      {refusal !== null && (
        <p style={ERROR} data-testid={`${prefix}-inlay-refusal-${index}`}>
          {refusal}
        </p>
      )}
      <button
        type="button"
        data-testid={`${prefix}-inlay-male-${index}`}
        disabled={onSaveMale === null}
        title="Build the male blank — its own job, its own blank, the design mirrored — and save it as a file to open and cut next."
        onClick={() => onSaveMale?.()}
      >
        Save the male blank…
      </button>
    </div>
  );
}
