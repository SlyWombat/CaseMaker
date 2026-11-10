/**
 * #1128 — THE CUT STEP'S TRIAGE: Do / Check / Know.
 *
 * The gate's report is unchanged — every row is still the owner's own sentence, code and severity.
 * This module only decides how the Cut step READS it, and it does so once, for the one renderer:
 *
 *  - the three bands, from `bandFor` (a table beside the codes with the severity fallback);
 *  - byte-identical rows from more than one setup collapsed into ONE line that names the setups
 *    ("setups 1 and 2"). Only the text has to be identical; the per-setup specifics (a coverage
 *    percent that differs) stay apart;
 *  - the planner facts that are not the operator's to read with the machine warm — a cutter that
 *    was never a candidate, instruments are not cutters — kept OUT of the Cut list. They are not
 *    deleted: the plan dump and the Design cutter advice still carry them.
 *
 * The count line the operator reads is the three counts, not the raw row count.
 */

import type { PreflightHubReport } from './hub';
import { bandFor, type FindingBand, type PreflightRow } from './types';

/**
 * The planner's own facts, out of the Cut list. They are true and useful where a cutter is chosen
 * (the plan dump, the Design panel's cutter advice, #1051); they are not an operator instruction.
 */
export const CUT_HIDDEN_CODES: ReadonlySet<string> = new Set([
  'goal-cutter-unfeedable',
  'goal-cutter-instrument',
]);

/** One row as the Cut step reads it. */
export interface TriagedRow {
  row: PreflightRow;
  band: FindingBand;
  /**
   * Every setup the identical row appeared in, 1-based and ascending — `[1, 2]` prints
   * "setups 1 and 2". One entry for a row one setup raised.
   */
  setups: number[];
}

export interface TriagedPreflight {
  do: TriagedRow[];
  check: TriagedRow[];
  know: TriagedRow[];
  /** The rows kept out of the Cut list (see {@link CUT_HIDDEN_CODES}). */
  hidden: PreflightRow[];
  counts: Readonly<Record<FindingBand, number>>;
}

/** The setups of one merged line, in the operator's 1-based numbering, deduped and sorted. */
function addSetup(setups: number[], setupIndex: number | undefined): void {
  const one = (setupIndex ?? 0) + 1;
  if (!setups.includes(one)) setups.push(one);
  setups.sort((a, b) => a - b);
}

/**
 * Trie the gate's report for the Cut step. `report.rows` is the page order the hub already states
 * (policy rows, then the scopes); the relative order inside a band is that order, so two reports of
 * the same job read the same way.
 */
export function triagePreflight(report: PreflightHubReport): TriagedPreflight {
  const byKey = new Map<string, TriagedRow>();
  const hidden: PreflightRow[] = [];

  for (const row of report.rows) {
    if (CUT_HIDDEN_CODES.has(row.code)) {
      hidden.push(row);
      continue;
    }
    // Byte-identical is the issue's own key: same severity, code and text. Different text with the
    // same code (two coverage percents, two substitutions) is two findings, not a duplicate.
    const key = `${row.severity}|${row.code}|${row.message}`;
    const seen = byKey.get(key);
    if (seen !== undefined) {
      addSetup(seen.setups, row.cause.setupIndex);
      continue;
    }
    byKey.set(key, {
      row,
      band: bandFor(row),
      setups: [],
    });
    addSetup(byKey.get(key)!.setups, row.cause.setupIndex);
  }

  const doRows: TriagedRow[] = [];
  const checkRows: TriagedRow[] = [];
  const knowRows: TriagedRow[] = [];
  for (const row of byKey.values()) {
    if (row.band === 'do') doRows.push(row);
    else if (row.band === 'check') checkRows.push(row);
    else knowRows.push(row);
  }

  return {
    do: doRows,
    check: checkRows,
    know: knowRows,
    hidden,
    counts: { do: doRows.length, check: checkRows.length, know: knowRows.length },
  };
}
