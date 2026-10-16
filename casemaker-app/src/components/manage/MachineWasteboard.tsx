/**
 * The machine's wasteboard on the Machines card (#417, decision Q7): its thickness and where that
 * came from, when it was last resurfaced, its scars, and the shop's depth limit (a location default,
 * `wasteboard.depthLimitMm`). A small editor records a thickness, or marks the board resurfaced —
 * which clears the scars, since a resurfaced board has none.
 */

import { useState } from 'react';
import type { MachineRecord } from '@/platform/locationClient';
import { houseSetWasteboard } from '@/platform/wasteboardClient';
import { markResurfaced, type Wasteboard } from '@/engine/cnc/wasteboard';
import { useLocationStore } from '@/store/locationStore';
import { useShopDefault } from '@/store/shopDefaultsStore';
import { formatDay, mm } from './display';

export function MachineWasteboard({ machine }: { machine: MachineRecord }) {
  const board = machine.wasteboard;
  const limit = useShopDefault('wasteboard.depthLimitMm');
  const [thickness, setThickness] = useState(board === null ? '' : String(board.thickness));
  const [note, setNote] = useState<string | null>(null);
  const n = Number(thickness);
  const usable = thickness.trim() !== '' && Number.isFinite(n) && n > 0;

  const record = async (resurfaced: boolean) => {
    const at = new Date().toISOString();
    const next: Wasteboard =
      board === null
        ? { thickness: n, thicknessSource: 'measured', measuredAt: at, lastResurfacedAt: resurfaced ? at : null, scars: [] }
        : resurfaced
          ? markResurfaced(board, n, 'measured', at)
          : { ...board, thickness: n, thicknessSource: 'measured', measuredAt: at };
    const res = await houseSetWasteboard(machine.id, next, useLocationStore.getState().etag);
    await useLocationStore.getState().refresh();
    setNote(res.kind === 'ok' ? 'Saved.' : res.kind === 'refused' ? res.message : res.kind === 'absent' ? res.reason : res.detail);
  };

  return (
    <>
      <span>wasteboard</span>
      <b data-testid="manage-wasteboard">
        {board === null ? (
          <span data-testid="manage-wasteboard-none">— not recorded</span>
        ) : (
          <span data-testid="manage-wasteboard-summary">
            {mm(board.thickness)} mm ({board.thicknessSource}
            {board.measuredAt ? ` ${formatDay(board.measuredAt) ?? ''}` : ''}) · resurfaced{' '}
            {board.lastResurfacedAt ? formatDay(board.lastResurfacedAt) : '— not recorded'} ·{' '}
            {board.scars.length} {board.scars.length === 1 ? 'scar' : 'scars'}
          </span>
        )}{' '}
        <span className="dim" data-testid="manage-wasteboard-limit">
          warn past {mm(limit.value)} mm into it ({limit.source === 'fallback' ? 'fallback — no location' : limit.source})
        </span>
        <span className="btn-row">
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="any"
            value={thickness}
            placeholder="mm"
            aria-label="Wasteboard thickness, measured, mm"
            data-testid="manage-wasteboard-thickness"
            onChange={(e) => setThickness(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-wasteboard-save"
            disabled={!usable}
            onClick={() => void record(false)}
          >
            Save thickness
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-wasteboard-resurfaced"
            disabled={!usable}
            title="The board was faced flat: its scars are gone and this is its new thickness"
            onClick={() => void record(true)}
          >
            Resurfaced now
          </button>
        </span>
        {note !== null && (
          <span className="hint" data-testid="manage-wasteboard-note">
            {' '}
            {note}
          </span>
        )}
      </b>
    </>
  );
}
