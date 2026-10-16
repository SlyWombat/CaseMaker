/**
 * The copies of an owned cutter, as the operator describes them (#415, decision Q4): each one's
 * condition (new / used / worn / broken) and where it is (its box, or a machine of the location), an
 * optional per-cutter runtime-warning threshold, and which of the location's machines this cutter's
 * shank fits a collet of.
 *
 * A COPY NOBODY DESCRIBED HAS NO CONDITION. Only the copies listed here carry one; the rest of the
 * `quantity` are "not set, in the box" — the editor says so rather than showing them as new.
 * Runtime is #381's: the threshold is shown and can be overridden, the warning is
 * `toolCondition.runtimeWarning`.
 */

import { useState } from 'react';
import {
  CONDITIONS,
  MAX_WARN_MINUTES,
  copiesProblem,
  itemConditionSummary,
  type Condition,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import type { InventoryItem } from '@/platform/houseClient';
import type { MachineRecord } from '@/platform/locationClient';
import { useHouseStore } from '@/store/houseStore';
import { useLocationStore } from '@/store/locationStore';
import { useShopDefault } from '@/store/shopDefaultsStore';
import { newId } from '@/utils/id';

/** One stable empty list: a fresh `[]` from a selector re-renders without end. */
const NO_MACHINES: readonly MachineRecord[] = [];

export function ToolCopies({ item }: { item: InventoryItem }) {
  const updateItem = useHouseStore((s) => s.updateItem);
  const busy = useHouseStore((s) => s.busy);
  const machines = useLocationStore((s) => s.location?.machines ?? NO_MACHINES);
  const threshold = useShopDefault('tools.runtimeWarnMinutes');
  // A draft, seeded from the record; the caller keys this component on the record's copies, so a
  // save (or another window's) remounts it with the stored ones.
  const [copies, setCopies] = useState<ToolCopy[]>(item.copies);
  const [fits, setFits] = useState<string[] | null>(item.colletFits);

  const problem = copiesProblem(item.quantity, copies, fits);
  const dirty = JSON.stringify(copies) !== JSON.stringify(item.copies) || JSON.stringify(fits) !== JSON.stringify(item.colletFits);
  const undescribed = Math.max(0, item.quantity - copies.length);
  const summary = itemConditionSummary({ ...item, copies });
  const machineName = (id: string) => {
    const m = machines.find((x) => x.id === id);
    return m ? (m.name ?? m.profileId ?? m.id) : `${id} (not in this location)`;
  };
  const patch = (i: number, p: Partial<ToolCopy>) => setCopies((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));

  return (
    <>
      <div className="panel-subhead">Copies</div>
      <p className="hint" data-testid="manage-copies-summary">
        {summary.note ??
          `${summary.usable} of ${item.quantity} usable${summary.best !== null && summary.best !== 'broken' ? ` · best: ${summary.best}` : ''}`}
      </p>
      {copies.map((c, i) => (
        <div className="grid2" key={c.id} data-testid={`manage-copy-${i}`}>
          <label className="lf">
            <span>copy {i + 1} — condition</span>
            <select
              className="fld"
              value={c.condition}
              data-testid={`manage-copy-condition-${i}`}
              onChange={(e) => patch(i, { condition: e.target.value as Condition })}
            >
              {CONDITIONS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="lf">
            <span>where</span>
            <select
              className="fld"
              value={c.whereabouts.kind === 'box' ? 'box' : c.whereabouts.machineId}
              data-testid={`manage-copy-where-${i}`}
              onChange={(e) =>
                patch(i, {
                  whereabouts: e.target.value === 'box' ? { kind: 'box' } : { kind: 'machine', machineId: e.target.value },
                })
              }
            >
              <option value="box">in its box</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  in {m.name ?? m.profileId ?? m.id}
                </option>
              ))}
              {/* A machine this location does not hold (an import, a removed machine) is shown as
                  ITSELF, not silently as "in its box" (#415 review). */}
              {c.whereabouts.kind === 'machine' && !machines.some((m) => m.id === (c.whereabouts as { machineId: string }).machineId) && (
                <option value={c.whereabouts.machineId}>in {machineName(c.whereabouts.machineId)}</option>
              )}
            </select>
          </label>
          <label className="lf">
            <span>
              check after, min <em>blank: the shop’s {threshold.value} ({threshold.source})</em>
            </span>
            <input
              className="fld fld--num"
              type="number"
              min={0}
              max={MAX_WARN_MINUTES}
              step="any"
              value={c.runtimeWarnMinutes ?? ''}
              data-testid={`manage-copy-warn-${i}`}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch(i, {
                  runtimeWarnMinutes: e.target.value.trim() === '' || !(v > 0) ? null : Math.min(v, MAX_WARN_MINUTES),
                });
              }}
            />
          </label>
          <button type="button" className="btn btn--sm" onClick={() => setCopies((cs) => cs.filter((_, j) => j !== i))}>
            Forget this copy’s details
          </button>
        </div>
      ))}
      {undescribed > 0 && (
        <p className="hint" data-testid="manage-copies-undescribed">
          {undescribed} {undescribed === 1 ? 'copy has' : 'copies have'} no condition set and {undescribed === 1 ? 'is' : 'are'} in the box.
        </p>
      )}
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm"
          data-testid="manage-copy-add"
          disabled={undescribed === 0}
          onClick={() =>
            setCopies((cs) => [
              ...cs,
              { id: newId('copy'), condition: 'used', whereabouts: { kind: 'box' }, runtimeWarnMinutes: null, notes: null },
            ])
          }
        >
          ＋ Describe a copy
        </button>
      </div>

      <div className="panel-subhead">Collet fits</div>
      {machines.length === 0 ? (
        <p className="hint">No machine is recorded in this location yet.</p>
      ) : (
        <>
          {machines.map((m) => (
            <label className="lf" key={m.id}>
              <span>{machineName(m.id)}</span>
              <input
                type="checkbox"
                checked={fits?.includes(m.id) ?? false}
                data-testid={`manage-collet-${m.id}`}
                onChange={(e) =>
                  setFits((f) => {
                    const base = (f ?? []).filter((x) => x !== m.id);
                    return e.target.checked ? [...base, m.id] : base;
                  })
                }
              />
            </label>
          ))}
          <p className="hint" data-testid="manage-collet-state">
            {fits === null ? 'Not stated — tick the machines this shank fits.' : fits.length === 0 ? 'Fits none of these machines.' : `Fits ${fits.map(machineName).join(', ')}.`}
          </p>
          {fits !== null && (
            <div className="btn-row">
              <button type="button" className="btn btn--sm" data-testid="manage-collet-unstate" onClick={() => setFits(null)}>
                Back to “not stated”
              </button>
            </div>
          )}
        </>
      )}

      {problem !== null && (
        <p className="hint" data-status="error" data-testid="manage-copies-problem">
          {problem}
        </p>
      )}
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="manage-copies-save"
          disabled={!dirty || problem !== null || busy !== null}
          onClick={() => void updateItem({ ...item, copies, colletFits: fits })}
        >
          Save copies
        </button>
      </div>
    </>
  );
}
