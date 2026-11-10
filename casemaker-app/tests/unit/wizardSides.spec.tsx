// @vitest-environment jsdom
// #723 P2-3 — the WIZARD'S SIDES SURFACE. A job cut from more than one saved setup shows its sides
// on the "What are you cutting?" step, and the mesh picked there is written to the CHOSEN side
// (`withSideGoal`), not over the job's single target. A one-side job keeps today's form.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { OperationStep, type OperationChoice } from '@/components/welcome/OperationStep';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(cleanup);

const TOP_UP = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

function goal(id: string, setupId: string): EngraveTargetObject {
  return {
    id,
    name: `${id}.stl`,
    format: 'stl',
    sha256: 'a'.repeat(64),
    size: { x: 20, y: 20, z: 5 },
    position: { x: 40, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    setupId,
  };
}

/** Two saved sides, each with its own goal. */
function twoSideJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [];
  job.shapes = [];
  job.toolKey = 'flat-1.0';
  const base = jobSetups(job)[0]!;
  job.setups = [
    { ...base, id: 'setup-1', orientation: { ...TOP_UP }, itemIds: [], tools: [job.toolKey] },
    { ...base, id: 'setup-2', orientation: { ...TOP_UP }, itemIds: [], tools: [job.toolKey] },
  ];
  job.targetObjects = [goal('shell-out', 'setup-1'), goal('shell-in', 'setup-2')];
  return job;
}

describe('#723 P2-3 — the wizard sides surface', () => {
  it('lists the sides with their goals, and the surface answer carries the chosen side', () => {
    const seen: (OperationChoice | null)[] = [];
    render(<OperationStep job={twoSideJob()} hasOperations onChoiceChange={(c) => seen.push(c)} />);

    expect(screen.getByTestId('start-wizard-op-sides')).toBeTruthy();
    expect(screen.getByTestId('start-wizard-op-side-0').textContent).toContain('shell-out');
    expect(screen.getByTestId('start-wizard-op-side-1').textContent).toContain('shell-in');

    // #1100 — the chips live under Something else…; the surface flow is behind that card now.
    fireEvent.click(screen.getByTestId('start-wizard-preset-something-else'));
    fireEvent.click(screen.getByTestId('engrave-setup-what-surface'));
    fireEvent.click(screen.getByTestId('start-wizard-op-side-1'));

    const last = seen.at(-1);
    expect(last?.type).toBe('surface');
    expect(last?.type === 'surface' ? last.setupId : undefined).toBe('setup-2');
    // The pick is on the side the operator chose, so the panel and the sheet can count it there.
    expect(screen.getByTestId('start-wizard-op-side-1').getAttribute('aria-checked')).toBe('true');
  });

  it('a one-side job shows no sides list: the single-goal form is unchanged', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    render(<OperationStep job={job} hasOperations={false} onChoiceChange={() => {}} />);
    expect(screen.queryByTestId('start-wizard-op-sides')).toBeNull();
  });
});
