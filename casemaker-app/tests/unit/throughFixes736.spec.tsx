// @vitest-environment jsdom
// #736 — A THROUGH CUT IN THE VISE WITH NO BOARD. The sweep finds the jaws' open centre, so the
// cut is stated (an info) instead of refused, and the row offers both precautions with the
// finding's own numbers: a board under the part, or a membrane left by stopping short. The
// buttons write the ordinary job fields — the sacrificial under, and the shape's through/depth.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngravePanel } from '@/components/panels/EngravePanel';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetEngraveRows, useEngraveRowStore } from '@/store/engraveRowStore';
import type { EngraveShape } from '@/types/engraveJob';

const SHAPE: EngraveShape = {
  kind: 'rect',
  id: 'cut-through',
  name: 'Cut-out',
  enabled: true,
  position: { x: 50, y: 30 },
  rotation: 0,
  width: 40,
  height: 20,
  cornerRadius: 2,
  depth: 2,
  through: true,
};

describe('#736 the through cut’s one-click fixes', () => {
  beforeEach(() => {
    useEngraveJobStore.getState().reset();
    resetEngraveRows();
    const base = defaultEngraveJob();
    useEngraveJobStore.setState({ job: { ...base, toolKey: 'flat-1.0', shapes: [SHAPE] } });
    useEngraveRowStore.getState().expand(SHAPE.id);
  });
  afterEach(cleanup);

  it('states the air and offers a board or a membrane, named with the finding’s numbers', () => {
    render(<EngravePanel />);
    const sentence = screen.getByTestId('engrave-shape-finding-0-through-into-air');
    expect(sentence.textContent).toContain('open centre between the jaws');
    // The board is breakthrough + 1 mm; the membrane is the job's own floor.
    expect(screen.getByTestId('engrave-through-add-board').textContent).toContain('1.3 mm board');
    expect(screen.getByTestId('engrave-through-stop-short').textContent).toContain('1 mm');
  });

  it('stop short clears the through flag and leaves the job’s floor as a membrane', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-through-stop-short'));
    const after = useEngraveJobStore.getState().job;
    expect(after.shapes?.[0]?.through).toBe(false);
    expect(after.shapes?.[0]?.depth).toBe(after.stock.thickness - after.minFloor);
    // The finding is about a through cut; a cut short of the bottom is not one any more.
    expect(screen.queryByTestId('engrave-shape-finding-0-through-into-air')).toBeNull();
  });

  it('the board button writes the board the sentence names, and the finding goes', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-through-add-board'));
    const after = useEngraveJobStore.getState().job;
    expect(after.sacrificial.under?.thickness).toBe(after.breakthrough + 1);
    expect(after.sacrificial.source).toBe('saved');
    expect(screen.queryByTestId('engrave-shape-finding-0-through-into-air')).toBeNull();
  });
});
