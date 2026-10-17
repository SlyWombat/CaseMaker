// @vitest-environment jsdom
// #471 — the remount page. The engine writes the steps and the one landmark question; the page
// refuses the mirror answer with the engine's reason, enables Done only once the question is
// answered, and reports "it is mounted" exactly once. The mirror-check case has no question, says
// so, and does not pretend a confirmation took place.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveRemountPage } from '@/components/panels/EngraveRemountPage';
import {
  buildSetups,
  checkRemountAnswer,
  describeRemount,
  setupsSettings,
  type Removal,
  type SetupsInput,
} from '@/engine/cnc/setups';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A: Removal = {
  id: 'a-through',
  name: 'a first through hole',
  volume: 400,
  box: { min: [10, 10, 0], max: [14, 14, 12] },
  opensTo: ['top', 'bottom'],
  connected: true,
};
const B: Removal = {
  id: 'b-through',
  name: 'a second through hole',
  volume: 400,
  box: { min: [60, 30, 0], max: [64, 34, 12] },
  opensTo: ['top', 'bottom'],
  connected: true,
};

const INPUT: SetupsInput = {
  stock: { x: 100, y: 60, z: 12 },
  removals: [A, B],
  mount: { kind: 'vise' },
};

afterEach(cleanup);

describe('#471 the remount page', () => {
  it('shows the engine’s steps in order and refuses the mirror answer without reporting done', () => {
    const plan = buildSetups(
      INPUT,
      [
        { face: 'top', items: [A] },
        { face: 'bottom', items: [B] },
      ],
      setupsSettings(null),
    );
    expect(plan.setups).toHaveLength(2);
    const setup = plan.setups[1]!;
    const described = describeRemount(setup, 2, setup.mount)!;
    expect(described.confirm).not.toBeNull();
    const correct = described.confirm!.correct;
    const wrong = (correct + 1) % described.confirm!.options.length;

    const onClose = vi.fn();
    const onMounted = vi.fn();
    render(<EngraveRemountPage setup={setup} total={2} mount={setup.mount} onClose={onClose} onMounted={onMounted} />);

    expect(screen.getByTestId('engrave-remount-title').textContent).toBe(described.title);
    for (const [i, line] of described.steps.entries()) {
      expect(screen.getByTestId(`engrave-remount-step-${i + 1}`).textContent).toBe(line);
    }
    expect(screen.queryByTestId(`engrave-remount-step-${described.steps.length + 1}`)).toBeNull();

    const done = screen.getByTestId('engrave-remount-done') as HTMLButtonElement;
    expect(done.disabled).toBe(true);

    fireEvent.click(screen.getByTestId(`engrave-remount-option-${wrong}`));
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    const check = checkRemountAnswer(setup.remount!, wrong);
    expect(check.ok).toBe(false);
    expect(screen.getByTestId('engrave-remount-refusal').textContent).toBe(!check.ok ? check.reason : '');
    expect(onMounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`engrave-remount-option-${correct}`));
    expect(screen.queryByTestId('engrave-remount-refusal')).toBeNull();
    fireEvent.click(done);
    expect(onMounted).toHaveBeenCalledTimes(1);
    expect(onMounted).toHaveBeenCalledWith({ instruction: described.steps, confirm: described.confirm });

    // "Done" belongs to a directed step: pressing it again must not report a second mount.
    fireEvent.click(done);
    expect(onMounted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with no landmark question, says the mirror cannot be caught and enables Done', () => {
    // A first mount turned face-down: nothing is cut yet, so the engine can ask nothing.
    const plan = buildSetups(INPUT, [{ face: 'bottom', items: [B] }], setupsSettings(null));
    expect(plan.setups).toHaveLength(1);
    const setup = plan.setups[0]!;
    const described = describeRemount(setup, 1, setup.mount)!;
    expect(described.confirm).toBeNull();
    expect(described.mirrorCheck).not.toBeNull();

    const onMounted = vi.fn();
    const onClose = vi.fn();
    render(<EngraveRemountPage setup={setup} total={1} mount={setup.mount} onClose={onClose} onMounted={onMounted} />);

    expect(screen.getByTestId('engrave-remount-mirror').textContent).toBe(described.mirrorCheck);
    expect(screen.queryByTestId('engrave-remount-question')).toBeNull();
    const done = screen.getByTestId('engrave-remount-done') as HTMLButtonElement;
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    expect(onMounted).toHaveBeenCalledTimes(1);
    expect(onMounted).toHaveBeenCalledWith({ instruction: described.steps, confirm: null });

    fireEvent.click(screen.getByTestId('engrave-remount-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMounted).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the setup is mounted as supplied (no remount step)', () => {
    const plan = buildSetups(INPUT, [{ face: 'top', items: [A] }], setupsSettings(null));
    const setup = plan.setups[0]!;
    expect(setup.remount).toBeNull();
    const { container } = render(
      <EngraveRemountPage setup={setup} total={1} mount={setup.mount} onClose={vi.fn()} onMounted={vi.fn()} />,
    );
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByTestId('engrave-remount-page')).toBeNull();
  });
});
