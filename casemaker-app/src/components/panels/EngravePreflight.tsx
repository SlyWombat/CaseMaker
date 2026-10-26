/**
 * #419 §3, slice 1 — THE PREFLIGHT PAGE.
 *
 * What Cut shows: the gate's rows, grouped by the (setup, tool) scope that produced them, in the
 * collector's order. Every row prints its owner's own `code` and `message`; this component adds no
 * judgement of its own beyond the two the row already carries (severity, and "first blocking" from
 * the hub's page order).
 *
 * The page is deliberately a READER. It does not freeze, reserve, plan, upload or start anything —
 * slice 1 stops at "the gate was asked and this is what it said". The release step, the package line
 * and the plan ride on this page in the next slice, over the same report.
 *
 * "Back to Design" is the only control, and it is never dead: it leaves Cut, and when the first red
 * row names an item it expands that item's row through #411's `expandEngraveRow`. Scrolling to the
 * row waits for §7's `hubTarget`; until then the expansion is the whole of the address.
 */

import type { CSSProperties, JSX } from 'react';
import type { PreflightCause, PreflightRow } from '@/engine/cnc/preflight';
import { entryFor } from '@/engine/cnc/toolRegistry';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const SUBHEAD: CSSProperties = { margin: '12px 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' };
const SEVERITY_COLOR: Record<PreflightRow['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

/**
 * #690 — the collector's owner is an internal tag (`engraveRunGate`, `fixture`, …). It stays on
 * the row as `data-owner`, which routes the Fix and which the tests read; it is not printed.
 */

/** The cutter a scope names, in the operator's one display form. A key the registry does not hold
 *  (a job naming a cutter the house no longer has) is not printed as a key either: an internal
 *  token is not operator text. */
function cutterWords(toolKey: string): string {
  const entry = entryFor(toolKey);
  return entry === null ? 'the cutter this job names' : toolDisplayName(entry.tool);
}

export interface EngravePreflightProps {
  /** The hub's aggregate — one `collect()` per scope, plus the two run-policy rows. */
  report: PreflightHubReport;
  /**
   * Leave Cut. The cause is the first blocking row's address when there is one, so the Design
   * surface can expand the row that sent the operator back; null on a green page.
   */
  onBackToDesign: (cause: PreflightCause | null) => void;
}

/**
 * One row: the severity's dot and the collector's own sentence, in operator words (#690). The
 * owner and the item id stay off the screen — the owner is `data-owner`, and the item is addressed
 * by the Fix, not named by an id. The expanded cause names the cutter in its display form, and
 * says "Setup N" only when there is more than one scope to tell apart.
 */
function Row({
  row,
  index,
  expanded,
  singleSetup,
}: {
  row: PreflightRow;
  index: number;
  expanded: boolean;
  singleSetup: boolean;
}): JSX.Element {
  const color = SEVERITY_COLOR[row.severity];
  return (
    <div
      data-testid={`engrave-preflight-row-${index}-${row.code}`}
      data-severity={row.severity}
      data-owner={row.owner}
      data-code={row.code}
      data-expanded={expanded ? 'true' : 'false'}
      style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.45, margin: '3px 0', color: '#d1d5db' }}
    >
      <span style={{ color, flexShrink: 0 }}>●</span>
      <span>
        {row.message}
        {expanded && (
          <span style={{ ...MUTED, display: 'block' }} data-testid={`engrave-preflight-cause-${index}`}>
            {singleSetup ? '' : `Setup ${row.cause.setupIndex + 1} · `}
            {cutterWords(row.cause.toolKey)}
            {row.cause.line === undefined || row.cause.line === null ? '' : ` · line ${row.cause.line}`}
          </span>
        )}
      </span>
    </div>
  );
}

/** One scope's group. An empty group says so rather than vanishing: "asked, nothing to report". */
function ScopeGroup({
  scopeIndex,
  toolKey,
  rows,
  startIndex,
  expandedIndex,
  singleSetup,
}: {
  scopeIndex: number;
  toolKey: string;
  rows: PreflightRow[];
  startIndex: number;
  expandedIndex: number;
  singleSetup: boolean;
}): JSX.Element {
  return (
    <section
      data-testid={`engrave-preflight-scope-${scopeIndex}`}
      data-setup-index={scopeIndex}
      data-tool={toolKey}
      data-state={rows.some((r) => r.severity === 'error') ? 'blocked' : 'clear'}
    >
      {/* #690 — the cutter in its display form, never the internal key; one setup is not a
          distinction, so only a job with several says "Setup N". */}
      <h3 style={SUBHEAD}>{singleSetup ? cutterWords(toolKey) : `Setup ${scopeIndex + 1} · ${cutterWords(toolKey)}`}</h3>
      {rows.length === 0 ? (
        <p style={MUTED} data-testid={`engrave-preflight-scope-${scopeIndex}-clear`}>
          No findings from this setup and cutter.
        </p>
      ) : (
        rows.map((row, i) => (
          <Row
            key={`${row.code}-${i}`}
            row={row}
            index={startIndex + i}
            expanded={startIndex + i === expandedIndex}
            singleSetup={singleSetup}
          />
        ))
      )}
    </section>
  );
}

export function EngravePreflight({ report, onBackToDesign }: EngravePreflightProps): JSX.Element {
  const blocking = report.firstBlocking;
  // One setup and one cutter is the ordinary case; naming it adds a distinction the operator
  // cannot act on (#690).
  const singleSetup = report.scopes.length <= 1;
  const expandedIndex = blocking === null ? -1 : report.rows.indexOf(blocking);

  // Each scope group's first row position in `report.rows`: the policy rows come first, then the
  // scopes in order. Computed rather than accumulated while rendering, so the render mutates
  // nothing (and React's immutability rule stays satisfied).
  const scopeStarts = report.scopes.map(
    (_, index) =>
      report.policyRows.length +
      report.scopes.slice(0, index).reduce((count, group) => count + group.rows.length, 0),
  );

  return (
    <div data-testid="engrave-preflight" data-state={blocking === null ? 'clear' : 'blocked'}>
      <p
        style={{ ...MUTED, color: blocking === null ? '#9fd19b' : SEVERITY_COLOR.error }}
        data-testid="engrave-preflight-summary"
      >
        {blocking === null
          ? `The gate found nothing blocking${report.warningCount === 0 ? '.' : ` — ${report.warningCount} warning${report.warningCount === 1 ? '' : 's'} carried.`}`
          : `${report.errorCount} blocking finding${report.errorCount === 1 ? '' : 's'}${report.warningCount === 0 ? '' : `, ${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}`}.`}
      </p>

      {report.policyRows.length > 0 && (
        <section data-testid="engrave-preflight-policy">
          <h3 style={SUBHEAD}>The run</h3>
          {report.policyRows.map((row, i) => (
            <Row key={`${row.code}-${i}`} row={row} index={i} expanded={i === expandedIndex} singleSetup={singleSetup} />
          ))}
        </section>
      )}

      {report.scopes.map((group, scopePosition) => {
        return (
          <ScopeGroup
            key={`${group.scope.setupIndex}-${group.scope.toolKey}`}
            scopeIndex={group.scope.setupIndex}
            toolKey={group.scope.toolKey}
            rows={group.rows}
            startIndex={scopeStarts[scopePosition] ?? 0}
            expandedIndex={expandedIndex}
            singleSetup={singleSetup}
          />
        );
      })}

      {blocking !== null && (
        <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-preflight-first-blocking">
          First blocking: {blocking.message}
        </p>
      )}

      <button
        type="button"
        data-testid="engrave-back-to-design"
        style={{ width: '100%', padding: 7, marginTop: 8 }}
        onClick={() => onBackToDesign(blocking?.cause ?? null)}
      >
        Back to Design
      </button>
    </div>
  );
}
