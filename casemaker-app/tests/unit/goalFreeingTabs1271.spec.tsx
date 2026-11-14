// @vitest-environment jsdom
// #1271 — "TABS HOLDING THE PART": the goal row's group. It follows the shop until the operator
// types; the job stores ONLY the typed fields; "Use the shop's" clears them; one sentence says what
// the planner did from the plan's own counts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { GoalFreeingTabs, freeingTabsSentence, type FreeingTabsShop } from '@/components/panels/GoalFreeingTabs';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { EngraveJob } from '@/types/engraveJob';
import { blockJob } from './helpers/tabChoiceBlock1258';

afterEach(cleanup);

const SHOP: FreeingTabsShop = { count: 4, widthMm: 6, heightMm: 1, limitMm: 80 };

describe('#1271 the group follows the shop and stores only what is typed', () => {
  it('nothing typed: the shop’s numbers show, "the shop’s values" is said, nothing is stored', () => {
    const onChange = vi.fn();
    render(<GoalFreeingTabs target={{}} index={0} shop={SHOP} counts={null} onChange={onChange} />);
    expect((screen.getByTestId('engrave-goal-tabs-count') as HTMLInputElement).value).toBe('4');
    expect((screen.getByTestId('engrave-goal-tabs-width') as HTMLInputElement).value).toBe('6');
    expect((screen.getByTestId('engrave-goal-tabs-height') as HTMLInputElement).value).toBe('1');
    expect(screen.getByTestId('engrave-goal-tabs-follows').textContent).toBe("the shop's values");
    expect(screen.queryByTestId('engrave-goal-tabs-reset')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('typing the count stores ONLY the count; width and height keep following the shop', () => {
    const onChange = vi.fn();
    render(<GoalFreeingTabs target={{}} index={0} shop={SHOP} counts={null} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('engrave-goal-tabs-count'), { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith({ count: 2 });
  });

  it('a typed field is the job’s own and "Use the shop’s" clears them all', () => {
    const onChange = vi.fn();
    render(<GoalFreeingTabs target={{ tabs: { count: 2, widthMm: 8 } }} index={0} shop={SHOP} counts={null} onChange={onChange} />);
    expect((screen.getByTestId('engrave-goal-tabs-count') as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('engrave-goal-tabs-width') as HTMLInputElement).value).toBe('8');
    expect((screen.getByTestId('engrave-goal-tabs-height') as HTMLInputElement).value).toBe('1');
    expect(screen.getByTestId('engrave-goal-tabs-reset').textContent).toBe("Use the shop's (4 × 6 × 1)");
    fireEvent.click(screen.getByTestId('engrave-goal-tabs-reset'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('emptying one typed field returns just that field to the shop', () => {
    const onChange = vi.fn();
    render(<GoalFreeingTabs target={{ tabs: { count: 2, widthMm: 8 } }} index={0} shop={SHOP} counts={null} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('engrave-goal-tabs-width'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ count: 2 });
  });
});

describe('#1271 the sentence says what the planner did, from its counts', () => {
  it('placed as asked: just "4 tabs placed."', () => {
    expect(freeingTabsSentence({ asked: 4, placed: 4, added: 0, unplaceable: 0 }, false, 80, 4)).toBe('4 tabs placed.');
    expect(freeingTabsSentence({ asked: 1, placed: 1, added: 0, unplaceable: 0 }, true, 80, 1)).toBe('1 tab placed.');
  });
  it('added to meet the limit: who asked, the shop’s limit, how many were added', () => {
    expect(freeingTabsSentence({ asked: 2, placed: 4, added: 2, unplaceable: 0 }, true, 40, 2)).toBe(
      "You asked for 2 tabs; the shop's limit is 40 mm, so the planner placed 4 (2 added).",
    );
    expect(freeingTabsSentence({ asked: 2, placed: 4, added: 2, unplaceable: 0 }, false, 40, 2)).toContain('The shop asks for 2 tabs');
  });
  it('fewer than asked, and none', () => {
    expect(freeingTabsSentence({ asked: 8, placed: 4, added: 0, unplaceable: 4 }, true, 80, 8)).toBe(
      '8 asked, 4 placed — the remaining edges are too short for another tab clear of the corners.',
    );
    expect(freeingTabsSentence(null, false, 80, 0)).toBe('No tabs: the part is cut free and needs tape, glue or screws to keep it from moving.');
    expect(freeingTabsSentence(null, false, 80, 4)).toBeNull();
  });
});

describe('#1271 the job stores only the typed fields, and the document round-trips', () => {
  const goalJob = (): EngraveJob =>
    ({
      ...defaultEngraveJob(),
      targetObject: { id: 'goal-1', name: 'p.stl', format: 'stl', sha256: 'a'.repeat(64), data: '', size: { x: 1, y: 1, z: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: 0, enabled: true, role: 'goal' },
    }) as unknown as EngraveJob;

  it('updateTargetObject stores the typed block, and removes it when none is typed', () => {
    useEngraveJobStore.setState({ job: goalJob() });
    useEngraveJobStore.getState().updateTargetObject({ tabs: { count: 2 } });
    expect(useEngraveJobStore.getState().job.targetObject?.tabs).toEqual({ count: 2 });
    useEngraveJobStore.getState().updateTargetObject({ tabs: undefined });
    expect(useEngraveJobStore.getState().job.targetObject).not.toHaveProperty('tabs');
    useEngraveJobStore.getState().updateTargetObject({ tabs: { count: undefined } });
    expect(useEngraveJobStore.getState().job.targetObject).not.toHaveProperty('tabs');
  });

  it('the schema accepts the block and refuses a stray key', () => {
    const doc = JSON.parse(JSON.stringify(blockJob())) as { targetObject: Record<string, unknown> };
    expect(parseEngraveJob(doc).ok).toBe(true);
    doc.targetObject.tabs = { count: 2, widthMm: 8 };
    expect(parseEngraveJob(doc).ok).toBe(true);
    doc.targetObject.tabs = { count: 2, wide: 8 };
    expect(parseEngraveJob(doc).ok).toBe(false);
  });
});
