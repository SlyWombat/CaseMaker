// @vitest-environment jsdom
// #802 — the Cut panel's rows name their severity in the SAME words the Design footer uses
// ("Error" / "Warning" / "Note"), instead of a coloured dot the reader has to learn.
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EngravePreflight } from '@/components/panels/EngravePreflight';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import type { PreflightRow } from '@/engine/cnc/preflight/types';

function row(severity: PreflightRow['severity'], code: string, message: string): PreflightRow {
  return { severity, code, message, owner: 'run', cause: { setupIndex: 0, toolKey: 'flat-1.0', hubTarget: null } };
}

function reportOf(rows: PreflightRow[]): PreflightHubReport {
  const errors = rows.filter((r) => r.severity === 'error');
  return {
    policyRows: rows,
    scopes: [],
    rows,
    firstBlocking: errors[0] ?? null,
    errorCount: errors.length,
    warningCount: rows.filter((r) => r.severity === 'warning').length,
  };
}

afterEach(() => cleanup());

describe('#802 — severity words in the Cut panel', () => {
  it('names each row’s severity in the Design footer’s words, not a dot', () => {
    render(
      <EngravePreflight
        report={reportOf([
          row('error', 'bad-ending', 'the program has no ending'),
          row('warning', 'vise-default', 'the vise is not measured'),
          row('info', 'vise-seat', 'the blank seats on the ledge'),
        ])}
        onBackToDesign={() => {}}
      />,
    );
    expect(screen.getByTestId('engrave-preflight-row-0-bad-ending').textContent).toContain('Error');
    expect(screen.getByTestId('engrave-preflight-row-1-vise-default').textContent).toContain('Warning');
    // The old legend-building dot is gone.
    expect(screen.getByTestId('engrave-preflight').textContent).not.toContain('●');
  });
});
