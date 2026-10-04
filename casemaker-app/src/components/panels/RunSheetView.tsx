import type { JSX } from 'react';
import {
  runSheetDiagramSvg,
  type RunSheet,
  type RunSheetStep,
} from '@/engine/cnc/engrave/runSheet';
import './runSheet.css';

/**
 * Renders an operator run sheet (#207) — the printable, job-specific checklist `buildRunSheet`
 * produces. It is a plain renderer: no state, no stores, no fetching. The sheet data is passed
 * in; the caller decides which generated job it belongs to.
 *
 * The mount is a follow-up (#207): slot 1 owns `EngravePanel.tsx`, so the one-line "Run sheet"
 * button is NOT added here. This component is what that button will open.
 *
 * EVERY `unverified` STEP SHOWS ITS TAG. An operator must be able to tell a confirmed step from an
 * assumption, so the marker is rendered from the data, never left to prose.
 */

/** The visible note for a step whose issue will confirm it on a real machine. */
function unverifiedNote(issue: string): string {
  return `Not yet confirmed on the machine (${issue}).`;
}

function StepBody({ step }: { step: RunSheetStep }): JSX.Element {
  return (
    <>
      <span className="run-sheet-step-text">{step.text}</span>
      {step.value !== undefined && <b className="run-sheet-step-value">{step.value}</b>}
      {step.record !== undefined && (
        <span className="run-sheet-record">
          <span className="run-sheet-record-label">{step.record}</span>
          <span className="run-sheet-record-blank" aria-hidden="true" />
        </span>
      )}
      {step.unverified !== undefined && (
        <em className="run-sheet-unverified">{unverifiedNote(step.unverified)}</em>
      )}
    </>
  );
}

export function RunSheetView({ sheet, onClose }: { sheet: RunSheet; onClose?: () => void }): JSX.Element {
  return (
    <div className="run-sheet-overlay" data-testid="run-sheet">
      <div className="run-sheet-toolbar">
        <button type="button" data-testid="run-sheet-print" onClick={() => window.print()}>
          Print
        </button>
        {onClose && (
          <button type="button" data-testid="run-sheet-close" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      <article className="run-sheet">
        <header className="run-sheet-header">
          <h1>{sheet.header.jobName}</h1>
          <dl className="run-sheet-meta">
            <div>
              <dt>Generated</dt>
              <dd>{sheet.header.generatedOn}</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd>{sheet.header.fileName}</dd>
            </div>
            <div>
              <dt>Hash</dt>
              <dd>{sheet.header.fileHash}</dd>
            </div>
            <div>
              <dt>Estimated cutting time</dt>
              <dd>
                {sheet.header.estimatedTime} <em>({sheet.header.estimatedTimeNote})</em>
              </dd>
            </div>
          </dl>
        </header>

        {sheet.sections.map((section) => (
          <section key={section.id} className="run-sheet-section" data-section-id={section.id}>
            <h2>{section.title}</h2>
            <ol className="run-sheet-steps">
              {section.steps.map((step, i) => (
                <li
                  key={`${section.id}-${i}`}
                  className={`run-sheet-step${step.bold ? ' run-sheet-step-bold' : ''}`}
                >
                  <StepBody step={step} />
                </li>
              ))}
            </ol>
            {section.id === 'origin' && (
              <div
                className="run-sheet-diagram"
                data-testid="run-sheet-diagram"
                // Pure string output from `runSheet.ts`; no user HTML, only generated geometry.
                dangerouslySetInnerHTML={{ __html: runSheetDiagramSvg(sheet.diagram) }}
              />
            )}
          </section>
        ))}
      </article>
    </div>
  );
}
