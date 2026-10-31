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

import { PCB_COPPER_MM, PCB_STANDARD_THICKNESS_MM, pcbBlankPatch, pcbStockNotice } from '@/engine/cnc/stockStart';
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

  it('states the blank a board asks for: the standard thickness, and a fit when it cannot hold the board', () => {
    // A plank is not a board's thickness: the standard 1.6 mm is ASSUMED, and the operator edits it.
    expect(pcbBlankPatch({ length: 100, width: 60, thickness: 12 })).toEqual({
      stock: { thickness: PCB_STANDARD_THICKNESS_MM },
      sources: { thickness: 'assumed' },
      notes: [expect.stringContaining('the standard board thickness — assumed, not measured')],
    });
    // A blank that is already a board keeps everything, and so does one that holds the board.
    expect(pcbBlankPatch({ length: 100, width: 60, thickness: 1.6 })).toBeNull();
    expect(pcbBlankPatch({ length: 60, width: 40, thickness: 1.6 }, { width: 32, height: 10 })).toBeNull();
    // A board the blank cannot hold is laid on its outline plus 2 mm of scrap each side — computed.
    expect(pcbBlankPatch({ length: 60, width: 40, thickness: 1.6 }, { width: 80, height: 50 })).toEqual({
      stock: { length: 84, width: 54 },
      sources: { length: 'computed', width: 'computed' },
      notes: [expect.stringContaining("the board's outline plus 2 mm of scrap each side")],
    });
  });

  it('fixes the stock in one click: PCB, the board’s standard thickness, copper cap, no filament fibre', () => {
    const store = useEngraveJobStore.getState();
    store.setStock({ material: 'petg', fibre: 'cf', colour: { kind: 'laminate', capMm: 0.4 } });
    expect(useEngraveJobStore.getState().job.stock.material).toBe('petg');

    useEngraveJobStore.getState().usePcbStock();

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.material).toBe('pcb');
    expect(job.stock.colour).toEqual({ kind: 'laminate', capMm: PCB_COPPER_MM });
    expect(job.stock.fibre).toBeUndefined();
    // The length and width are the blank the board is already on; the 12 mm plank is not a
    // board's thickness, so the press states the standard 1.6 mm — assumed, and editable.
    expect([job.stock.length, job.stock.width, job.stock.thickness]).toEqual([100, 60, PCB_STANDARD_THICKNESS_MM]);
    // The material is the operator's choice; the copper and the thickness are defaults, not theirs.
    expect(job.sources?.stock?.material).toBe('user');
    expect(job.sources?.stock?.colour).toBe('assumed');
    expect(job.sources?.stock?.thickness).toBe('assumed');
    expect(pcbStockNotice(job.stock.material)).toBeNull();
  });
});
