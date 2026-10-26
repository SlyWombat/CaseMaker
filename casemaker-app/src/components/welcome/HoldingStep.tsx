/**
 * #681 — step 3 of the one cutting-job wizard: Holding.
 *
 * The setup answers and their rules live in `@/engine/cnc/engrave/setupFlow`; this component is
 * the step's body and nothing else. It writes as the answers change (not at a Finish button that
 * no longer exists), so an edit from the panel's Hold `edit` is kept when the operator closes.
 *
 * Two carry-overs from the retired second modal, both audit findings this shell must not keep:
 *   - the disabled Rotary option and the sentence explaining it are GONE (A10): a control that
 *     cannot act is hidden, not narrated. Wave 2's holding step (#684) adds the real mount
 *     choices with their cost and their way out.
 *   - finding CODES are not operator text (A10, D1): a row shows its sentence and keeps the code
 *     only in its test id.
 *
 * The blank/material findings used to live on their own setup steps. Those steps are step 2 now,
 * so the checks that depend on the mount — the #231 proud-vs-thickness case among them — are shown
 * HERE, where the operator can act on them.
 */

import { useMemo, type CSSProperties, type JSX } from 'react';
import {
  sacrificialChoice,
  stepFindings,
  stockProudFix,
  withSacrificialChoice,
  withVise,
  type SacrificialChoice,
  type SetupAnswers,
} from '@/engine/cnc/engrave/setupFlow';
import { dedupeFindings, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0' };
const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };
/** Operator numbers: at most 3 decimals, trailing zeros dropped (§4). */
const fmt = (n: number): string => `${Number(n.toFixed(3))}`;

/** One finding as the operator reads it: the sentence, never the code. */
function FindingRow({ finding, testid }: { finding: JobFinding; testid: string }): JSX.Element {
  return (
    <div data-testid={testid} style={{ fontSize: 12, lineHeight: 1.45, margin: '3px 0' }}>
      <span style={{ color: SEVERITY_COLOR[finding.severity] }}>● </span>
      {finding.message}
    </div>
  );
}

export interface HoldingStepProps {
  job: EngraveJob;
  answers: SetupAnswers;
  /** Apply the answer immediately: there is no later Finish to collect it. */
  onAnswers: (answers: SetupAnswers) => void;
}

export function HoldingStep({ job, answers, onAnswers }: HoldingStepProps): JSX.Element {
  // The mount's own checks plus the ones that depend on the stock being in it. `dedupeFindings`
  // is the same net the old step used: two validators can answer one code.
  const findings = useMemo(
    () =>
      dedupeFindings([
        ...stepFindings('holding', job, answers),
        ...stepFindings('blank', job, answers),
      ]),
    [job, answers],
  );
  const fix = useMemo(() => stockProudFix(answers), [answers]);

  return (
    <div data-testid="engrave-setup-step-holding" style={{ marginTop: 8 }}>
      <label style={FIELD_LABEL}>
        <input
          type="radio"
          name="start-wizard-holding"
          checked
          onChange={() => undefined}
          data-testid="engrave-setup-holding-vise"
          readOnly
        />{' '}
        Vise
      </label>

      <label style={FIELD_LABEL}>
        <span>Waste board</span>
        <select
          value={sacrificialChoice(answers.sacrificial)}
          data-testid="engrave-setup-sacrificial"
          aria-label="Waste board"
          onChange={(e) => onAnswers(withSacrificialChoice(answers, e.target.value as SacrificialChoice))}
        >
          <option value="none">none</option>
          <option value="board">a board under the part</option>
          <option value="strips">strips between the jaws</option>
          {sacrificialChoice(answers.sacrificial) === 'custom' && (
            <option value="custom">the setup this job already has</option>
          )}
        </select>
      </label>

      {fix !== null && (
        <div
          data-testid="engrave-setup-fix-slot"
          style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 4 }}
        >
          <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>
            The vise holds the stock {fmt(answers.vise.stockProud)} mm proud, taller than this{' '}
            {fmt(answers.stock.thickness)} mm blank. Seated on the jaws' ledge it stands{' '}
            {fmt(fix.stockProud)} mm proud.
          </p>
          <button
            type="button"
            data-testid="engrave-setup-fix-proud"
            onClick={() => onAnswers(withVise(answers, { stockProud: fix.stockProud, source: fix.source }))}
          >
            Set stock proud to {fmt(fix.stockProud)} mm
          </button>
        </div>
      )}

      {findings.length > 0 && (
        <div data-testid="engrave-setup-findings" style={{ marginTop: 6 }}>
          {findings.map((f, i) => (
            <FindingRow key={`${f.code}-${i}`} finding={f} testid={`engrave-setup-step-finding-${f.code}`} />
          ))}
        </div>
      )}
    </div>
  );
}
