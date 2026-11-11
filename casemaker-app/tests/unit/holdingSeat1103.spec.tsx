// @vitest-environment jsdom
// #1103 items 5 and 6 (the analyst's remaining-work comment) — THE REASON SITS UNDER THE
// RECOMMENDED ROW, and a vise seat the rule refused says why on its OWN row: how far down the cut
// goes and how high the jaws stand above its floor on that seat. HoldingStep is rendered directly
// with the work facts the question step would hand it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { HoldingStep } from '@/components/welcome/HoldingStep';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultSetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetLocationStore } from '@/store/locationStore';
import { resetMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(stock: { length: number; width: number; thickness: number }, work: { deepestCutMm: number; through: boolean; reachesEdgeWithinMm: number | null }): void {
  const job = defaultEngraveJob();
  job.stock = { ...job.stock, ...stock };
  act(() => {
    useEngraveJobStore.setState({ job });
  });
  const noop = (): void => undefined;
  render(
    <HoldingStep
      job={job}
      answers={defaultSetupAnswers(job)}
      work={work}
      onAnswers={noop}
      onRotary={noop}
      onBedHold={noop}
      onHold={noop}
      onMoveItemsToTop={noop}
    />,
  );
}

beforeEach(() => {
  cleanup();
  caps.drive = true;
  resetLocationStore();
  resetMachineStore();
  useSettingsStore.getState().resetSettings();
});
afterEach(() => cleanup());

describe('#1103 item 5 — the reason sits under the recommended row', () => {
  it('the recommendation reason is inside the recommended row, not one line under all rows', () => {
    // 30 mm block, 10 mm pocket reaching the edge: the block seat is refused, the ledge wins.
    draw({ length: 60, width: 40, thickness: 30 }, { deepestCutMm: 10, through: false, reachesEdgeWithinMm: 0 });
    const reason = screen.getByTestId('engrave-setup-recommendation-reason');
    const row = screen.getByTestId('engrave-setup-mount-row-ledge');
    expect(row.contains(reason)).toBe(true);
    expect(reason.textContent).toContain('Recommended: on the jaw ledge — the cut goes 10 mm down and reaches the blank’s edge');
    // …and no other row carries it.
    expect(screen.getByTestId('engrave-setup-mount-row-block').contains(reason)).toBe(false);
  });
});

describe('#1103 item 6 — a refused seat states the jaws’ height on its row', () => {
  it('the block seat the rule refused says how far the cut goes and how high the jaws stand there', () => {
    draw({ length: 60, width: 40, thickness: 30 }, { deepestCutMm: 10, through: false, reachesEdgeWithinMm: 0 });
    const text = screen.getByTestId('engrave-setup-mount-row-block').textContent ?? '';
    expect(text).toContain('The cut goes 10 mm down and reaches the blank’s edge; on this seat the jaws stand');
    // The refused row stays selectable (a hint, not a refusal).
    expect((screen.getByTestId('engrave-setup-mount-block') as HTMLInputElement).disabled).toBe(false);
  });

  it('a seat the rule accepted carries no such line', () => {
    draw({ length: 60, width: 40, thickness: 30 }, { deepestCutMm: 10, through: false, reachesEdgeWithinMm: 0 });
    expect(screen.getByTestId('engrave-setup-mount-row-ledge').textContent ?? '').not.toContain('the jaws stand');
  });
});
