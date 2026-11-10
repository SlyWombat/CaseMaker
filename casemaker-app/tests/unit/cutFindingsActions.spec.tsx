// @vitest-environment jsdom
/**
 * #1128 follow-up — EACH DO ROW CARRIES ITS OWN FIX.
 *
 * #1128 put the Cut step's findings in Do / Check / Know, but the Do band still only NAMED the
 * act: the machine-record banner, the cutter list and the clearance statement live elsewhere, and
 * the operator read the row, then hunted for the control. This follow-up gives a Do row the same
 * action its banner/card already offers: the preflight renders the button (it is a reader — the
 * parent supplies the handler), and the handler is the ONE the original control calls, never a
 * copy of its logic.
 *
 * The clearance codes are Do by band for that reason: they are a physical act to check before the
 * run, however the owner graded them (all four are warnings).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePreflight } from '@/components/panels/EngravePreflight';
import { runFindingAction, type FindingAction } from '@/engine/cnc/preflight/actions';
import { revealClearanceStatement } from '@/components/panels/clearanceStatement';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import type { PreflightRow } from '@/engine/cnc/preflight/types';

function row(
  setupIndex: number,
  severity: PreflightRow['severity'],
  code: string,
  message: string,
): PreflightRow {
  return {
    severity,
    code,
    message,
    owner: 'generate',
    cause: { setupIndex, toolKey: 'flat-6x25', hubTarget: null },
  };
}

const ROWS: PreflightRow[] = [
  row(0, 'error', 'mount-not-on-bed', 'The machine record says nothing is on the pins.'),
  row(0, 'error', 'tool-missing', 'The cutter this job names is not in the tool library.'),
  row(0, 'warning', 'vise-default', 'The vise is not measured here; the shipped defaults are used.'),
  // A Do row whose act has no in-app control: the row carries no button.
  row(0, 'error', 'through-needs-board', 'A through cut needs a sacrificial board under the blank.'),
  row(0, 'warning', 'sacrificial-default', 'The sacrificial defaults were used: 3 mm under the blank.'),
  row(0, 'info', 'goal-unreached', 'goal check: 57.5 % of the goal is reached.'),
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

describe('#1128 follow-up — the Do row is the fix', () => {
  it('renders the action on each Do row that has one, with the original control’s words', () => {
    render(<EngravePreflight report={reportOf(ROWS)} onFindingAction={() => {}} />);

    // The clearance code is Do by band even though its owner graded it a warning; the board row
    // is Do by its error and carries no button (no in-app act).
    expect(screen.getByTestId('engrave-preflight-summary').textContent).toBe(
      '4 to do · 1 to check · 1 to know',
    );
    expect(screen.getByTestId('engrave-preflight-action-0-mount-not-on-bed').textContent).toBe(
      'Change the machine…',
    );
    expect(screen.getByTestId('engrave-preflight-action-1-tool-missing').textContent).toBe(
      'Choose a cutter',
    );
    expect(screen.getByTestId('engrave-preflight-action-2-vise-default').textContent).toBe(
      'Read the clearance statement',
    );
  });

  it('a Do row with no in-app act carries no button, and Check/Know never do', () => {
    render(<EngravePreflight report={reportOf(ROWS)} onFindingAction={() => {}} />);
    expect(screen.queryByTestId('engrave-preflight-action-3-through-needs-board')).toBeNull();
    expect(screen.queryByTestId('engrave-preflight-action-4-sacrificial-default')).toBeNull();
    expect(screen.queryByTestId('engrave-preflight-action-5-goal-unreached')).toBeNull();
  });

  it('pressing a row’s button hands the parent the action and the code', () => {
    const seen: { action: FindingAction; code: string }[] = [];
    render(
      <EngravePreflight
        report={reportOf(ROWS)}
        onFindingAction={(action, code) => seen.push({ action, code })}
      />,
    );
    fireEvent.click(screen.getByTestId('engrave-preflight-action-0-mount-not-on-bed'));
    fireEvent.click(screen.getByTestId('engrave-preflight-action-1-tool-missing'));
    fireEvent.click(screen.getByTestId('engrave-preflight-action-2-vise-default'));
    expect(seen).toEqual([
      { action: 'change-machine', code: 'mount-not-on-bed' },
      { action: 'choose-cutter', code: 'tool-missing' },
      { action: 'clearance', code: 'vise-default' },
    ]);
  });

  it('the dispatcher calls the ONE handler the original control calls', () => {
    const hooks = { changeMachine: vi.fn(), openCutters: vi.fn(), showClearance: vi.fn() };
    runFindingAction('change-machine', hooks);
    expect(hooks.changeMachine).toHaveBeenCalledTimes(1);
    runFindingAction('choose-cutter', hooks);
    expect(hooks.openCutters).toHaveBeenCalledTimes(1);
    runFindingAction('clearance', hooks);
    expect(hooks.showClearance).toHaveBeenCalledTimes(1);
  });

  it('the clearance button reveals the statement and focuses its tick — it never writes it', () => {
    const before = useEngraveRunStore.getState();
    render(
      <>
        <details data-testid="engrave-cut-step-1">
          <div data-testid="engrave-cut-ack">
            <span>
              I am at the machine — the probe is fitted, the head is clear, and the stock is
              clamped — and I have checked clearance to the vise and the tool’s reach myself.
            </span>
            <input type="checkbox" data-testid="engrave-ack" />
          </div>
        </details>
        <EngravePreflight
          report={reportOf(ROWS)}
          onFindingAction={(action) =>
            runFindingAction(action, {
              changeMachine: () => {},
              openCutters: () => {},
              showClearance: () => revealClearanceStatement(),
            })
          }
        />
      </>,
    );
    const step = screen.getByTestId('engrave-cut-step-1') as HTMLDetailsElement;
    expect(step.open).toBe(false);

    fireEvent.click(screen.getByTestId('engrave-preflight-action-2-vise-default'));

    // The statement is on screen, its tick has the cursor, and the tick is still the operator’s.
    expect(step.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('engrave-ack'));
    expect(useEngraveRunStore.getState().acknowledged).toBe(before.acknowledged);
    expect(useEngraveRunStore.getState().acknowledgedFor).toBe(before.acknowledgedFor);
  });
});
