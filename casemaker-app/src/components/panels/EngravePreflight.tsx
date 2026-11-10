/**
 * #419 §3, slice 1 — THE PREFLIGHT PAGE. #1128 — THE FINDINGS ARE TRIAGED.
 *
 * What Cut shows: the gate's rows in three bands, in the order the operator needs them. Every row
 * still prints its owner's own `code` and `message`, and its severity word; this component adds no
 * judgement of its own beyond the band the triage table already assigned. Do and Check are open;
 * Know is a fold with its count, because information is not an instruction.
 *
 * THE PAGE IS A READER. It does not freeze, reserve, plan, upload or start anything. The release
 * step, the package line and the plan ride on this page over the same report.
 *
 * The page has no controls of its own: leaving Cut is the panel's `‹ Design` header link (#795),
 * beside the mode switch, and it is never dead — when the first red row names an item it expands
 * that item's row through #411's `expandEngraveRow`.
 */

import { useMemo, type CSSProperties, type JSX } from 'react';
import type { PreflightRow } from '@/engine/cnc/preflight';
import { entryFor } from '@/engine/cnc/toolRegistry';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import { triagePreflight, type TriagedRow } from '@/engine/cnc/preflight/triage';
import { findingActionFor, type FindingAction } from '@/engine/cnc/preflight/actions';
import type { FindingBand } from '@/engine/cnc/preflight/types';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const SUBHEAD: CSSProperties = { margin: '12px 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' };
const SEVERITY_COLOR: Record<PreflightRow['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };
/** #802 — the same severity words the Design footer uses; a dot asked the reader to learn a legend. */
const SEVERITY_WORD: Record<PreflightRow['severity'], string> = { error: 'Error', warning: 'Warning', info: 'Note' };

/** The band headings. Do first, with nothing folded; Know last, folded. */
const BAND_TITLE: Record<FindingBand, string> = {
  do: 'Do',
  check: 'Check before cutting',
  know: 'Know',
};

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

/** "1 and 2" / "1, 2 and 3" — the setups a merged line came from. */
function setupsWords(setups: readonly number[]): string {
  if (setups.length <= 1) return String(setups[0] ?? 1);
  return `${setups.slice(0, -1).join(', ')} and ${setups.at(-1)!}`;
}

export interface EngravePreflightProps {
  /** The hub's aggregate — one `collect()` per scope, plus the two run-policy rows. */
  report: PreflightHubReport;
  /**
   * #1128 follow-up — the Do row's act. The page is a reader: it renders the button and hands the
   * parent the named action and the code; the Cut surface supplies the handler its own banner/card
   * already uses. Absent in a context with no actions to run (a spec, the docs), and then no
   * button is drawn.
   */
  onFindingAction?: (action: FindingAction, code: string) => void;
}

/**
 * One row: the severity's word and the collector's own sentence, in operator words (#690). The
 * owner and the item id stay off the screen — the owner is `data-owner`, and the item is addressed
 * by the Fix, not named by an id. A line that identical rows from several setups collapsed into
 * names them ("setups 1 and 2"). The expanded cause names the cutter in its display form, and says
 * "Setup N" only when there is more than one scope to tell apart.
 */
function Row({
  triaged,
  index,
  expanded,
  singleSetup,
  onFindingAction,
}: {
  triaged: TriagedRow;
  index: number;
  expanded: boolean;
  singleSetup: boolean;
  onFindingAction?: (action: FindingAction, code: string) => void;
}): JSX.Element {
  const { row, setups } = triaged;
  const color = SEVERITY_COLOR[row.severity];
  // #1128 follow-up — a Do row whose act the surface can run carries its own button, in the
  // original control's words. Check/Know rows never do; a Do row with no in-app act has none.
  const act =
    triaged.band === 'do' && onFindingAction !== undefined ? findingActionFor(row) : null;
  return (
    <div
      data-testid={`engrave-preflight-row-${index}-${row.code}`}
      data-severity={row.severity}
      data-owner={row.owner}
      data-code={row.code}
      data-band={triaged.band}
      data-expanded={expanded ? 'true' : 'false'}
      style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.45, margin: '3px 0', color: '#d1d5db' }}
    >
      <span style={{ color, flexShrink: 0, fontWeight: 600 }} data-severity={row.severity}>
        {SEVERITY_WORD[row.severity]}
      </span>
      <span>
        {row.message}
        {setups.length > 1 && (
          <>
            {' · '}
            <span style={MUTED} data-testid={`engrave-preflight-setups-${index}`}>
              setups {setupsWords(setups)}
            </span>
          </>
        )}
        {act !== null && (
          <button
            type="button"
            className="btn btn--sm"
            data-testid={`engrave-preflight-action-${index}-${row.code}`}
            style={{ marginLeft: 8 }}
            onClick={() => onFindingAction!(act.action, row.code)}
          >
            {act.label}
          </button>
        )}
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

/** One band's rows; Know is a fold, because information is not an instruction. */
function Band({
  band,
  rows,
  startIndex,
  expandedIndex,
  singleSetup,
  onFindingAction,
}: {
  band: FindingBand;
  rows: TriagedRow[];
  startIndex: number;
  expandedIndex: number;
  singleSetup: boolean;
  onFindingAction?: (action: FindingAction, code: string) => void;
}): JSX.Element {
  const rowsEls = rows.map((triaged, i) => (
    <Row
      key={`${triaged.row.code}-${i}`}
      triaged={triaged}
      index={startIndex + i}
      expanded={startIndex + i === expandedIndex}
      singleSetup={singleSetup}
      onFindingAction={onFindingAction}
    />
  ));
  const heading = `${BAND_TITLE[band]} · ${rows.length}`;
  if (band === 'know') {
    return (
      <details data-testid="engrave-preflight-know" data-count={rows.length} style={{ marginTop: 10 }}>
        <summary style={{ ...SUBHEAD, cursor: 'pointer' }}>{heading}</summary>
        {rows.length === 0 ? <p style={MUTED}>Nothing.</p> : rowsEls}
      </details>
    );
  }
  return (
    <section data-testid={`engrave-preflight-${band}`} data-count={rows.length}>
      <h3 style={SUBHEAD}>{heading}</h3>
      {rows.length === 0 ? <p style={MUTED}>Nothing.</p> : rowsEls}
    </section>
  );
}

export function EngravePreflight({ report, onFindingAction }: EngravePreflightProps): JSX.Element {
  const blocking = report.firstBlocking;
  // #1128 — the one reading of the report: bands, cross-setup duplicates merged, planner facts
  // kept out. Every row index below is a position in this triaged list.
  const triaged = useMemo(() => triagePreflight(report), [report]);
  // One setup and one cutter is the ordinary case; naming it adds a distinction the operator
  // cannot act on (#690).
  const singleSetup = report.scopes.length <= 1;
  const flat = [...triaged.do, ...triaged.check, ...triaged.know];
  const expandedIndex = blocking === null ? -1 : flat.findIndex((row) => row.row === blocking);

  return (
    <div data-testid="engrave-preflight" data-state={blocking === null ? 'clear' : 'blocked'}>
      <p
        style={{ ...MUTED, fontWeight: 600, color: blocking === null ? '#9fd19b' : SEVERITY_COLOR.error }}
        data-testid="engrave-preflight-summary"
      >
        {triaged.counts.do} to do · {triaged.counts.check} to check · {triaged.counts.know} to know
      </p>

      <Band
        band="do"
        rows={triaged.do}
        startIndex={0}
        expandedIndex={expandedIndex}
        singleSetup={singleSetup}
        onFindingAction={onFindingAction}
      />
      <Band
        band="check"
        rows={triaged.check}
        startIndex={triaged.do.length}
        expandedIndex={expandedIndex}
        singleSetup={singleSetup}
        onFindingAction={onFindingAction}
      />
      <Band
        band="know"
        rows={triaged.know}
        startIndex={triaged.do.length + triaged.check.length}
        expandedIndex={expandedIndex}
        singleSetup={singleSetup}
        onFindingAction={onFindingAction}
      />

      {blocking !== null && (
        <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-preflight-first-blocking">
          First blocking: {blocking.message}
        </p>
      )}
    </div>
  );
}
