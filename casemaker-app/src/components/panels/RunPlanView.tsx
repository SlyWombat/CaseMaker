/**
 * #421 — the run plan (§5.8) as a table: every phase in order, its time, WHERE THAT TIME CAME FROM, and
 * the wall clock it took last run beside it (never in place of it). Presentational: the plan is
 * `engine/cnc/plan`'s `planRun`, and the job flow (#419) mounts this with the machine strip.
 */

import type { CSSProperties, JSX } from 'react';
import { formatDuration, type RunPlan, type TimeSource } from '@/engine/cnc/plan';

const CELL: CSSProperties = { fontSize: 11, padding: '2px 6px', verticalAlign: 'top', textAlign: 'left' };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };

const SOURCE_WORD: Record<TimeSource, string> = {
  measured: 'measured',
  chosen: 'chosen',
  fallback: 'fallback (no location)',
  estimated: 'estimated',
};

export interface RunPlanViewProps {
  plan: RunPlan;
}

export function RunPlanView({ plan }: RunPlanViewProps): JSX.Element {
  return (
    <div data-testid="run-plan">
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <caption style={{ ...MUTED, textAlign: 'left', captionSide: 'top' }}>
          The run, phase by phase: each time says where it came from; last run is shown beside it.
        </caption>
        <thead>
          <tr>
            <th scope="col" style={CELL}>Phase</th>
            <th scope="col" style={CELL}>Who</th>
            <th scope="col" style={CELL}>Time</th>
            <th scope="col" style={CELL}>Source</th>
            <th scope="col" style={CELL}>Last run</th>
          </tr>
        </thead>
        <tbody>
          {plan.phases.map((p) => (
            <tr key={p.id} data-testid={`run-plan-phase-${p.id}`} data-kind={p.kind} data-source={p.source}>
              <td style={CELL}>
                {p.title}
                {p.needsDone ? ' · needs your “done”' : ''}
                {p.parts.length > 1 && (
                  <div style={{ ...MUTED, margin: 0 }}>
                    {p.parts.map((q) => `${q.label}: ${q.seconds === null ? '—' : formatDuration(q.seconds)} (${SOURCE_WORD[q.source]})`).join(' · ')}
                  </div>
                )}
              </td>
              <td style={CELL}>{p.who}</td>
              <td style={CELL} data-testid={`run-plan-phase-${p.id}-time`}>
                {p.seconds === null ? '—' : formatDuration(p.seconds)}
              </td>
              <td style={CELL} title={p.parts.map((q) => q.from).join('; ')}>
                {SOURCE_WORD[p.source]}
              </td>
              <td style={CELL} data-testid={`run-plan-phase-${p.id}-last`}>
                {p.lastRun === null ? '—' : `${formatDuration(p.lastRun.seconds)} (${p.lastRun.at.slice(0, 10)})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={MUTED} data-testid="run-plan-total">
        Total {plan.totalIsLowerBound ? 'at least ' : ''}
        {formatDuration(plan.totalSeconds)}
        {plan.totalIsLowerBound ? ' — a phase has no estimate yet' : ''}.
      </p>
      {plan.findings.length > 0 && (
        <ul style={{ ...MUTED, paddingLeft: 16 }} data-testid="run-plan-findings">
          {plan.findings.map((f, i) => (
            <li key={i} data-code={f.code}>
              {f.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
