import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  MATERIAL_OPTIONS,
  SETUP_STEPS,
  defaultSetupAnswers,
  sacrificialChoice,
  stepFindings,
  stockProudFix,
  withSacrificialChoice,
  withStockAnswer,
  withToolAnswer,
  withWorkholding,
  withVise,
  type SacrificialChoice,
  type SetupAnswers,
  type SetupStepId,
} from '@/engine/cnc/engrave/setupFlow';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { StockMaterial } from '@/types/engraveJob';

/**
 * The guided job setup (#254) — the input side of the run sheet. A path INTO the Engrave panel,
 * never a gate in front of it: it asks workholding, material, blank and cutter in order, then
 * writes the answers through `applyAnswers` so every value carries a source.
 *
 * It is portal'd to `document.body` for the same reason the run sheet is: the context rail that
 * mounts it is a fixed, sometimes-transformed drawer, and a fixed overlay inside it would be
 * trapped in the rail's column.
 *
 * Pure logic — the questions' answers, the fixes and the document write — lives in
 * `@/engine/cnc/engrave/setupFlow`; this component only holds React state and renders it.
 */

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'rgba(8, 11, 15, 0.72)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const BOX: CSSProperties = {
  width: 'min(420px, 100%)',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  background: '#141a21',
  border: '1px solid #2a2f36',
  borderRadius: 6,
  padding: 12,
  color: '#d1d5db',
};
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0' };
const FIELD: CSSProperties = { width: 80 };
const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a' };

/** Cutting diameter of a library entry, best effort (`tipDiameter ?? diameter`). */
function entryDiameter(e: ToolLibraryEntry): number | null {
  return e.tool.tipDiameter ?? e.tool.diameter;
}

function FindingRow({ finding, testid }: { finding: JobFinding; testid: string }): JSX.Element {
  return (
    <div data-testid={testid} style={{ fontSize: 12, lineHeight: 1.45, margin: '3px 0' }}>
      <span style={{ color: SEVERITY_COLOR[finding.severity] }}>● </span>
      <code style={{ color: SEVERITY_COLOR[finding.severity] }}>{finding.code}</code> {finding.message}
    </div>
  );
}

export function EngraveSetupFlow({ onClose }: { onClose: () => void }): JSX.Element {
  const job = useEngraveJobStore((s) => s.job);
  const applySetup = useEngraveJobStore((s) => s.applySetup);
  // #305 — the resolved list, not `TOOL_LIBRARY`. `body()` is a plain function called from this
  // render, so the hook has to be here rather than beside the select it feeds.
  const tools = useToolRegistry();

  // The answers are seeded once, from the job as it stands, so the flow is re-enterable and
  // "same as last job" is a no-op. They are a draft until Finish writes them.
  const [answers, setAnswers] = useState<SetupAnswers>(() => defaultSetupAnswers(job));
  const [index, setIndex] = useState(0);

  const step = SETUP_STEPS[index]!;
  const last = index === SETUP_STEPS.length - 1;
  const stepId: SetupStepId = step.id;

  // What the current answers would cause, on the exact document the flow would write. The blank
  // step's checks include `validateVise`, so the #231 refusal appears here with its fix.
  const findings = useMemo(() => stepFindings(stepId, job, answers), [stepId, job, answers]);
  const fix = useMemo(() => (stepId === 'blank' ? stockProudFix(answers) : null), [stepId, answers]);

  function finish(): void {
    applySetup(answers);
    onClose();
  }

  function sameAsLast(): void {
    // The seeded answers already ARE the last job; applying them confirms it and stamps sources.
    finish();
  }

  function next(): void {
    if (last) finish();
    else setIndex((i) => i + 1);
  }

  function body(): JSX.Element {
    switch (stepId) {
      case 'holding':
        return (
          <>
            <label style={FIELD_LABEL}>
              <input
                type="radio"
                name="engrave-setup-holding"
                checked
                onChange={() => setAnswers((a) => withWorkholding(a, 'vise'))}
                data-testid="engrave-setup-holding-vise"
              />{' '}
              Vise
            </label>
            <label style={{ ...FIELD_LABEL, opacity: 0.5 }}>
              <input type="radio" disabled data-testid="engrave-setup-holding-rotary" /> Rotary chuck
            </label>
            <p style={MUTED}>A rotary chuck is CNC-5 (#237); it is asked here but not yet offered.</p>
            <label style={FIELD_LABEL}>
              <span>Sacrificial material</span>
              <select
                value={sacrificialChoice(answers.sacrificial)}
                data-testid="engrave-setup-sacrificial"
                aria-label="Sacrificial material"
                title="Material the cutter may run onto, never onto air."
                onChange={(e) =>
                  setAnswers((a) => withSacrificialChoice(a, e.target.value as SacrificialChoice))
                }
              >
                <option value="none">none</option>
                <option value="board">a board under the part</option>
                <option value="strips">strips between the jaws</option>
                {sacrificialChoice(answers.sacrificial) === 'custom' && (
                  <option value="custom">the setup this job already has</option>
                )}
              </select>
            </label>
          </>
        );
      case 'material':
        return (
          <label style={FIELD_LABEL}>
            <span>Material</span>
            <select
              value={answers.stock.material}
              data-testid="engrave-setup-material"
              aria-label="Stock material"
              title="Selects the row of the feeds table."
              onChange={(e) => setAnswers((a) => withStockAnswer(a, 'material', e.target.value as StockMaterial))}
            >
              {MATERIAL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        );
      case 'blank':
        return (
          <>
            {(['length', 'width', 'thickness'] as const).map((key) => (
              <label key={key} style={FIELD_LABEL}>
                <span>{key === 'length' ? 'length X' : key === 'width' ? 'width Y' : 'thickness'}</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={answers.stock[key]}
                  data-testid={`engrave-setup-stock-${key}`}
                  aria-label={`Stock ${key}`}
                  style={FIELD}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setAnswers((a) => withStockAnswer(a, key, v));
                  }}
                />
              </label>
            ))}
            {fix && (
              <div
                data-testid="engrave-setup-fix-slot"
                style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 4 }}
              >
                <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>
                  The vise holds the stock {answers.vise.stockProud} mm proud, taller than this{' '}
                  {answers.stock.thickness} mm blank.
                </p>
                <button
                  type="button"
                  data-testid="engrave-setup-fix-proud"
                  onClick={() => setAnswers((a) => withVise(a, { stockProud: fix.stockProud, source: fix.source }))}
                >
                  Set stock proud to {fix.stockProud} mm
                </button>
              </div>
            )}
          </>
        );
      case 'cutter':
        return (
          <label style={FIELD_LABEL}>
            <span>Cutter</span>
            <select
              value={answers.toolKey}
              data-testid="engrave-setup-tool"
              aria-label="Tool"
              title="The cutter this job is written for."
              style={{ width: '100%' }}
              onChange={(e) => setAnswers((a) => withToolAnswer(a, e.target.value))}
            >
              {tools.map((e) => {
                const d = entryDiameter(e);
                return (
                  <option key={e.key} value={e.key} title={e.provenance}>
                    {d === null ? e.tool.name : `${e.tool.name} — Ø ${d} mm cutting`}
                  </option>
                );
              })}
            </select>
          </label>
        );
    }
  }

  return createPortal(
    <div style={OVERLAY} data-testid="engrave-setup-flow">
      <div style={BOX} role="dialog" aria-label="Guided job setup">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ flex: 1, fontSize: 13 }}>Set up this job</b>
          <span style={MUTED} data-testid="engrave-setup-progress">
            {index + 1} / {SETUP_STEPS.length}
          </span>
          <button type="button" data-testid="engrave-setup-close" onClick={onClose}>
            Close
          </button>
        </div>

        <p style={{ ...MUTED, marginTop: 8 }} data-testid="engrave-setup-step-title">
          {step.title}
        </p>

        <div data-testid={`engrave-setup-step-${stepId}`}>
          {body()}
          {findings.length > 0 && (
            <div data-testid="engrave-setup-findings" style={{ marginTop: 6 }}>
              {findings.map((f, i) => (
                <FindingRow key={`${f.code}-${i}`} finding={f} testid={`engrave-setup-step-finding-${f.code}`} />
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" data-testid="engrave-setup-same" onClick={sameAsLast}>
            Same as last job
          </button>
          <button
            type="button"
            data-testid="engrave-setup-back"
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            Back
          </button>
          <button
            type="button"
            data-testid="engrave-setup-next"
            style={{ padding: '3px 12px' }}
            onClick={next}
          >
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
