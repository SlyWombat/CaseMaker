// @vitest-environment jsdom
/**
 * #743 P-4b review — A BOARD LAID ON A NON-PCB BLANK IS STATED, NEVER REFUSED.
 *
 * A practice cut in PLA is a legitimate thing to do, so the import says the fact in one sentence
 * and offers the one-click fix; the operator may ignore it. The fix restates the stock's material
 * as PCB, gives it copper's own cap (Case Maker's 1 oz default, so its provenance is `assumed`,
 * not the operator's assertion) and drops the printed filament's fibre — a PCB is not that blank.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { PCB_COPPER_MM, pcbStockNotice } from '@/engine/cnc/stockStart';
import { useEngraveJobStore } from '@/store/engraveJobStore';

describe('a board on a non-PCB blank (#743 P-4b review)', () => {
  beforeEach(() => useEngraveJobStore.getState().reset());

  it('states the blank fact in one sentence, and nothing when the blank IS PCB', () => {
    expect(pcbStockNotice('pcb')).toBeNull();
    expect(pcbStockNotice('pla')).toBe(
      "This job's stock is PLA; a circuit board is cut from copper-clad PCB.",
    );
    expect(pcbStockNotice('softwood')).toContain("This job's stock is");
  });

  it('fixes the stock in one click: PCB, copper cap, no filament fibre', () => {
    const store = useEngraveJobStore.getState();
    store.setStock({ material: 'petg', fibre: 'cf', colour: { kind: 'laminate', capMm: 0.4 } });
    expect(useEngraveJobStore.getState().job.stock.material).toBe('petg');

    useEngraveJobStore.getState().usePcbStock();

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.material).toBe('pcb');
    expect(job.stock.colour).toEqual({ kind: 'laminate', capMm: PCB_COPPER_MM });
    expect(job.stock.fibre).toBeUndefined();
    // The dimensions are the blank the board is already on; the fix never re-sizes it.
    expect([job.stock.length, job.stock.width, job.stock.thickness]).toEqual([100, 60, 12]);
    // The material is the operator's choice; the 1 oz number is the default, not theirs.
    expect(job.sources?.stock?.material).toBe('user');
    expect(job.sources?.stock?.colour).toBe('assumed');
    expect(pcbStockNotice(job.stock.material)).toBeNull();
  });
});
