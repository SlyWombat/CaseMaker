import type { CSSProperties, JSX } from 'react';
import { FontPicker, WeightPicker } from '@/components/panels/FontPicker';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { mm } from '@/engine/cnc/engrave/depthBounds';
import type { LabelDepthRecommendation } from '@/engine/cnc/engrave/depthBounds';
import { depthForIntent, type LabelSplit } from '@/engine/cnc/engrave/depthIntent';
import type { CustomFont } from '@/types/textLabel';
import type { EngraveLabel } from '@/types/engraveJob';

/**
 * One label of an engrave job (#205): enabled, text, font, weight, cap height, position,
 * rotation, depth, and its own findings.
 *
 * Depth is a NUMERIC field, and the number is the control that is never taken away — a slider
 * cannot express "11.5 mm" reliably, and depth is the one number a user has a reason to type
 * exactly. The field is marked when the depth leaves less than `minFloor` under the cut.
 *
 * #170 adds a two-state control BESIDE that field — but only on a blank that states its colour
 * split (`split`), because only there are there two outcomes to choose between (decision 20):
 * *surface* stays in the top colour, *reveal* comes through to the bottom one, and each writes the
 * depth its state means (`depthForIntent`) — one printed layer clear of the split, or the margin in
 * force where that is further, so a job carrying a margin of its own still gets a depth its own
 * checker accepts. On a one-colour blank depth
 * is a free number and the field stands alone, which is also what retires the slider this row used
 * to carry: a continuous control is exactly the wrong shape for a choice that has two answers.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const LABEL_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a' };

export interface EngraveLabelRowProps {
  label: EngraveLabel;
  /** Position of this row in `job.labels`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: Partial<EngraveLabel>) => void;
  onRemove: () => void;
  /** Findings about THIS label (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
  /** The project's embedded fonts, for the font picker. */
  customFonts?: readonly CustomFont[];
  /**
   * What `recommendLabelDepth` works out for this label on this blank, with its arithmetic (#362).
   *
   * `null` when there is nothing to recommend (a construction label, a label stating its own intent,
   * a blank with no depth left): the row then says only what it always said. Omitted entirely by a
   * caller that has no recommendation to offer — the row does not go looking for one, because the
   * void limit it needs is `partPlan`'s arithmetic and this component must not guess at it.
   */
  recommended?: LabelDepthRecommendation | null;
  /**
   * This job's colour split, as the two-state control needs it (#170) — or `null`/absent when the
   * blank states no print, which is when the row shows the depth field alone.
   *
   * Passed in rather than looked up: the split is `splitDepthOf(job)` and the step is that blank's
   * own layer height against the margin in force, so a row that went and found them itself would be a
   * second opinion about which blank is in the vise and how far off its plane a floor has to stay. Omitted entirely by a caller with no job in hand (the row does not guess).
   */
  split?: LabelSplit | null;
}

export function EngraveLabelRow({
  label,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
  customFonts = [],
  recommended,
  split = null,
}: EngraveLabelRowProps): JSX.Element {
  const depthInvalid = label.depth > maxDepth;

  /**
   * One state of the two-colour control. Pressing either writes the intent AND the depth it means
   * in one patch — `updateLabel` stamps both as the user's own, which is what stops the badge route
   * re-depthing a label a person has placed (#362).
   *
   * The button is `aria-pressed`, so the state says itself to a screen reader; the COLOUR side of
   * the claim is the preview's, and its legend names the two stand-ins.
   */
  const intentButton = (
    at: LabelSplit,
    intent: 'surface' | 'reveal',
    words: string,
    title: string,
  ): JSX.Element => (
    <button
      type="button"
      aria-pressed={label.depthIntent === intent}
      data-testid={`engrave-label-${intent}-${index}`}
      title={title}
      onClick={() => onChange({ depthIntent: intent, depth: depthForIntent(intent, at) })}
    >
      {words}
    </button>
  );

  const num = (
    key: 'size' | 'rotation',
    aria: string,
    title: string,
    step = 'any',
  ): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{aria}</span>
      <input
        type="number"
        step={step}
        value={label[key]}
        data-testid={`engrave-label-${key}-${index}`}
        aria-label={`Label ${index + 1} ${aria}`}
        title={title}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ [key]: v } as Partial<EngraveLabel>);
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
        value={label.position[axis]}
        data-testid={`engrave-label-${axis}-${index}`}
        aria-label={`Label ${index + 1} ${axis.toUpperCase()}`}
        title={`Centre of the text, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...label.position, [axis]: v } });
        }}
      />
    </label>
  );

  return (
    <div
      data-testid={`engrave-label-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      {/* #350 — the text gets the line to itself. Sharing one with the font picker and the weight
          toggle collapsed it to a sliver: `flex: 1` gives the input a flex-basis of 0, so it is the
          first thing to give up its width when the siblings do not shrink, and in the 320 px rail
          the select alone takes most of the line. `min-width: 0` does not save it — it ALLOWS the
          collapse rather than preventing it. Its own line is the only arrangement where the
          label's most important field cannot lose that fight. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={label.enabled}
          data-testid={`engrave-label-enabled-${index}`}
          aria-label={`Label ${index + 1} enabled`}
          title="A disabled label is kept in the job but not cut."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <input
          type="text"
          value={label.text}
          data-testid={`engrave-label-text-${index}`}
          aria-label={`Label ${index + 1} text`}
          title="The text to engrave."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>

      {/* The font picker, the weight toggle and the remove button are three fixed-width controls
          with no shrink between them, so at the 320 px rail they overrun the row rather than wrap.
          `flexWrap` (as on the field line below) lets them take a second line instead. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <FontPicker
          value={label.font}
          onChange={(font) => onChange({ font })}
          customFonts={customFonts}
          aria-label={`Label ${index + 1} font`}
          title="Typeface for the label."
        />
        <WeightPicker
          value={label.weight}
          onChange={(weight) => onChange({ weight })}
          aria-label={`Label ${index + 1} weight`}
          title="Regular or bold (bundled fonts only; an embedded font is used as-is)."
        />
        <button
          type="button"
          data-testid={`engrave-label-remove-${index}`}
          aria-label={`Remove label ${index + 1}`}
          title="Remove this label."
          style={{ marginLeft: 'auto' }}
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      <div style={LABEL_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={label.construction === true}
            data-testid={`engrave-label-construction-${index}`}
            aria-label={`Label ${index + 1} reference only`}
            title="Reference only: this label is not cut. It can still be named by a frame, or left as a cut-away island — that is how raised text is made."
            onChange={(e) => onChange({ construction: e.target.checked ? true : undefined })}
          />
          <span>reference only</span>
        </label>
        {num('size', 'cap', 'Cap height, mm — the size the cutter has to reach through.')}
        {positionNum('x')}
        {positionNum('y')}
        {num('rotation', 'rot', 'Degrees counter-clockwise about the text centre.')}
        {/* #170 — the two states, on a blank that has two. On a one-colour blank there is nothing
            to choose and the depth field below stands alone. */}
        {split !== null && (
          <span role="group" aria-label={`Label ${index + 1} colour`} style={FIELD_LABEL}>
            {intentButton(
              split,
              'surface',
              'surface',
              `Keep this label's floor in the top colour: ${mm(split.step)} mm above the colour split, ${mm(split.depth)} mm below the face.`,
            )}
            {intentButton(
              split,
              'reveal',
              'reveal',
              `Cut through to the bottom colour: ${mm(split.step)} mm below the colour split, ${mm(split.depth)} mm below the face.`,
            )}
          </span>
        )}
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="number"
            min={0}
            step="0.1"
            value={label.depth}
            data-testid={`engrave-label-depth-${index}`}
            aria-label={`Label ${index + 1} depth`}
            title={`Depth of this label's floor below the top face, mm.`}
            style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              // #170 — typing a depth IS the advanced override (decision 20), and this row is the
              // one place that knows whether there were two states to override. `'custom'` rather
              // than a cleared key: the label did mean something, and the document should say the
              // person has taken the number over instead of letting the split's intent linger
              // (there is no third state to press — a lit state with a number that betrays it is a
              // contradiction the row would be drawing).
              //
              // Only where the control exists. On a blank with no split the field writes its number
              // and nothing else — plus the CLEARING of an intent, which is the one thing it must
              // still do there: a blank that lost its print (or a job that never had one) can carry
              // an intent from the printed job it came from, and an intent no control is drawn for
              // is invisible. Left standing it would go on claiming a colour the blank does not have
              // and, being a stated intent, take the label out of `recommendLabelDepth`'s reach
              // (#362) with nothing on screen to say why (#170 review).
              onChange(split === null ? { depth: v, depthIntent: undefined } : { depth: v, depthIntent: 'custom' });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-label-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor. That is the
        ceiling this blank allows, not the depth the app recommends.
      </p>

      {/* #362 — where the number came from (#345's rule). The recommendation is arithmetic on THIS
          blank, so it goes under the field it filled in rather than in a panel elsewhere; without
          it the row shows a depth with no reason and the ceiling above reads like the reason. */}
      {recommended !== null && recommended !== undefined && (
        <p style={MUTED} data-testid={`engrave-label-recommended-${index}`}>
          Recommended {mm(recommended.depth)} mm — {recommended.basis[0]}.
          {label.depth === recommended.depth ? '' : ` This label is at ${mm(label.depth)} mm.`}
        </p>
      )}

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-label-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
