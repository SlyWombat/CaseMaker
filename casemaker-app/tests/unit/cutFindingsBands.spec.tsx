// @vitest-environment jsdom
/**
 * #1128 — THE CUT STEP'S FINDINGS ARE TRIAGED, NOT A PAGE OF NOTES.
 *
 * At the bench the tray flip job's details fold held 119 warnings and notes: the same block once
 * per setup, six "not a candidate" planner notes per setup, and the one line that needed an act
 * sat above a list nobody could read. The report the gate already returns is unchanged; the Cut
 * step now reads it in three bands — Do first (blocks the run or needs a physical act), Check
 * before cutting (a warning that changes what happens on the bed), Know (information, collapsed
 * with a count) — with identical rows across setups collapsed to one line naming the setups, and
 * planner facts (a cutter that was never a candidate; instruments are not cutters) out of the
 * operator list.
 *
 * The report below is the tray job's shape, synthetic: two setups, the same block in each, the
 * planner's six not-a-candidate notes and two instrument notes, and the machine-record row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePreflight } from '@/components/panels/EngravePreflight';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import type { PreflightRow } from '@/engine/cnc/preflight/types';

function row(
  setupIndex: number,
  severity: PreflightRow['severity'],
  code: string,
  message: string,
  extra: Partial<PreflightRow> = {},
): PreflightRow {
  return {
    severity,
    code,
    message,
    owner: 'generate',
    cause: { setupIndex, toolKey: 'flat-6x25', hubTarget: null },
    ...extra,
  };
}

/** The two-setup tray block: identical rows in both setups where the bench saw duplicates. */
const BLOCK = (s: number): PreflightRow[] => [
  row(s, 'warning', 'sacrificial-default', 'The sacrificial defaults were used: 3 mm under the blank.'),
  row(s, 'warning', 'goal-fixture-unmodelled', 'The plan does not model the fixture envelope.'),
  row(
    s,
    'warning',
    'goal-cutter-substituted',
    "The ⌀6 flat's feeds: hardwood's largest covered row (3.2 mm) answered, the conservative side.",
    { feedsProxyMm: 3.2 },
  ),
  row(s, 'info', 'goal-plan-tradeoff', 'The measured pick saves 4 min and leaves one more bit change.'),
  row(s, 'info', 'goal-pocket-floor-rest', 'The pocket floor strip is finished by the ball nose.'),
  row(s, 'info', 'goal-cutter-unfeedable', 'TiN drill: no cutting parameters in hardwood — not a candidate'),
  row(s, 'info', 'goal-cutter-unfeedable', 'Thread bit: no cutting parameters in hardwood — not a candidate'),
  row(s, 'info', 'goal-cutter-unfeedable', 'TiN thread mill: no cutting parameters in hardwood — not a candidate'),
  row(s, 'info', 'goal-cutter-instrument', 'The wired probe is an instrument — instruments are not cutters'),
];

const ROWS: PreflightRow[] = [
  // The one thing to do, above everything: the machine record says nothing holds the blank.
  row(0, 'error', 'mount-not-on-bed', 'The machine record says nothing is on the pins.'),
  ...BLOCK(0),
  ...BLOCK(1),
  // Per-setup specifics stay per setup (the coverage differs, so the rows do not merge).
  row(0, 'info', 'goal-unreached', 'goal check: 57.5 % of the goal is reached.'),
  row(1, 'info', 'goal-unreached', 'goal check: 58.1 % of the goal is reached.'),
  // #1123 item 8's sentence — a substitution, NOT a borrowed feeds row: a warning by severity,
  // Know by band.
  row(0, 'warning', 'goal-cutter-substituted', 'Your ⌀2 ball nose has no feeds for hardwood; the ⌀3.175 flat is used instead.'),
];

function reportOf(rows: PreflightRow[]): PreflightHubReport {
  const errors = rows.filter((r) => r.severity === 'error');
  return {
    policyRows: [],
    scopes: [],
    rows,
    firstBlocking: errors[0] ?? null,
    errorCount: errors.length,
    warningCount: rows.filter((r) => r.severity === 'warning').length,
  };
}

afterEach(() => cleanup());

describe('#1128 — Do / Check / Know on the Cut step', () => {
  it('bands the report, counts what matters, and puts Do first', () => {
    render(<EngravePreflight report={reportOf(ROWS)} />);

    // 1 Do (the machine record), 3 Check (sacrificial, fixture envelope, borrowed feeds), 5 Know
    // (two coverage lines, the tradeoff, the finish note, the substitution).
    expect(screen.getByTestId('engrave-preflight-summary').textContent).toBe(
      '1 to do · 3 to check · 5 to know',
    );
    const doBand = screen.getByTestId('engrave-preflight-do');
    const checkBand = screen.getByTestId('engrave-preflight-check');
    const knowBand = screen.getByTestId('engrave-preflight-know');
    expect(doBand.getAttribute('data-count')).toBe('1');
    expect(checkBand.getAttribute('data-count')).toBe('3');
    expect(knowBand.getAttribute('data-count')).toBe('5');
    // Document order: Do, then Check, then Know.
    expect(doBand.compareDocumentPosition(checkBand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checkBand.compareDocumentPosition(knowBand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The Do row is the first row, and it is the one to act on.
    expect(screen.getByTestId('engrave-preflight-row-0-mount-not-on-bed')).toBeTruthy();
    expect(doBand.textContent).toContain('nothing is on the pins');
  });

  it('collapses the identical per-setup rows to one line naming both setups', () => {
    render(<EngravePreflight report={reportOf(ROWS)} />);

    // The sacrificial and fixture-envelope rows exist once each, not once per setup.
    expect(screen.getAllByText(/The sacrificial defaults were used/)).toHaveLength(1);
    expect(screen.getAllByText(/does not model the fixture envelope/)).toHaveLength(1);
    // Five merged lines name both setups (the three Check rows and the tradeoff and finish Knows).
    expect(screen.getAllByText('setups 1 and 2')).toHaveLength(5);
    // The borrowed-feeds line is Check (it changes what happens on the bed), and it is merged too.
    expect(screen.getAllByText(/largest covered row \(3.2 mm\)/)).toHaveLength(1);
    // The coverage lines differ (57.5 % vs 58.1 %), so both stay, per setup.
    expect(screen.getByText(/57\.5 % of the goal/)).toBeTruthy();
    expect(screen.getByText(/58\.1 % of the goal/)).toBeTruthy();
  });

  it('keeps the planner facts out of the operator list', () => {
    render(<EngravePreflight report={reportOf(ROWS)} />);
    expect(screen.queryByText(/not a candidate/i)).toBeNull();
    expect(screen.queryByText(/instruments are not cutters/i)).toBeNull();
    // Ten rows at most for this report, not one per finding occurrence.
    expect(screen.getAllByTestId(/^engrave-preflight-row-/).length).toBeLessThanOrEqual(20);
  });

  it('Know is collapsed by default with its count, and opens on demand', () => {
    render(<EngravePreflight report={reportOf(ROWS)} />);
    const know = screen.getByTestId('engrave-preflight-know') as HTMLDetailsElement;
    expect(know.tagName).toBe('DETAILS');
    expect(know.open).toBe(false);
    expect(know.querySelector('summary')?.textContent).toContain('5');
    fireEvent.click(know.querySelector('summary')!);
    expect(know.open).toBe(true);
  });
});
