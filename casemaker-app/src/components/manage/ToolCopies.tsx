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
  runtimeWarning,
  type Condition,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import type { InventoryItem } from '@/platform/houseClient';
import { CASE_SWATCH } from '@/engine/cnc/caseColour';
import { MILL_MODELS } from '@/engine/cnc/machine';
import { machineDisplayName, type MachineRecord } from '@/platform/locationClient';
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
    if (m === undefined) return `${id} (not in this location)`;
    const profile = m.profileId != null ? MILL_MODELS[m.profileId] : undefined;
    return machineDisplayName(m, profile) ?? m.profileId ?? m.id;
  };
  const patch = (i: number, p: Partial<ToolCopy>) => setCopies((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  /** A copy's case, or null — a function because the union does not narrow inside callbacks. */
  const boxCase = (c: ToolCopy) => (c.whereabouts.kind === 'box' ? (c.whereabouts.case ?? null) : null);

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
              value={c.condition ?? ''}
              data-testid={`manage-copy-condition-${i}`}
              onChange={(e) => patch(i, { condition: e.target.value === '' ? null : (e.target.value as Condition) })}
            >
              {/* #491 — a copy may be recorded only to say which case it lives in. "not set" is
                  the explicit answer, not a missing one: nothing here guesses "new". */}
              <option value="">not set</option>
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
                  whereabouts:
                    e.target.value === 'box'
                      ? { kind: 'box', case: c.whereabouts.kind === 'box' ? (c.whereabouts.case ?? null) : null }
                      : { kind: 'machine', machineId: e.target.value },
                })
              }
            >
              <option value="box">in its box</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  in {machineName(m.id)}
                </option>
              ))}
              {/* A machine this location does not hold (an import, a removed machine) is shown as
                  ITSELF, not silently as "in its box" (#415 review). */}
              {c.whereabouts.kind === 'machine' && !machines.some((m) => m.id === (c.whereabouts as { machineId: string }).machineId) && (
                <option value={c.whereabouts.machineId}>in {machineName(c.whereabouts.machineId)}</option>
              )}
            </select>
          </label>
          {c.whereabouts.kind === 'box' && (
            <>
              {/* #491 — the case is a property of the BOXED copy. Blank means nobody recorded one:
                  it is never filled from the cutter's other copies, and the instruction and drawing
                  then show no colour. The label is the full descriptor ("yellow base, clear tube")
                  and is optional. */}
              <label className="lf">
                <span>case colour <em>blank: not recorded</em></span>
                <input
                  className="fld fld--text"
                  list="manage-case-colours"
                  placeholder="yellow"
                  value={boxCase(c)?.colour ?? ''}
                  data-testid={`manage-copy-case-${i}`}
                  onChange={(e) => {
                    const colour = e.target.value.trim();
                    patch(i, {
                      whereabouts: {
                        kind: 'box',
                        case:
                          colour === ''
                            ? null
                            : { colour, label: boxCase(c)?.label ?? null },
                      },
                    });
                  }}
                />
              </label>
              <label className="lf">
                <span>case label <em>optional — what the case says</em></span>
                <input
                  className="fld fld--text"
                  placeholder="yellow base, clear tube"
                  value={boxCase(c)?.label ?? ''}
                  disabled={boxCase(c) == null}
                  data-testid={`manage-copy-case-label-${i}`}
                  onChange={(e) => {
                    const current = boxCase(c);
                    if (current == null) return;
                    const label = e.target.value.trim();
                    patch(i, {
                      whereabouts: {
                        kind: 'box',
                        case: { colour: current.colour, label: label === '' ? null : label },
                      },
                    });
                  }}
                />
              </label>
            </>
          )}
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
          <p className="hint" data-testid={`manage-copy-runtime-${i}`}>
            {c.runtimeMinutes === null
              ? 'runtime: none counted yet (counted by Case Maker; runs from Makera Studio are not)'
              : `runtime: ${Math.round(c.runtimeMinutes)} min, counted by Case Maker${(() => {
                  const w = runtimeWarning(c.runtimeMinutes, c.runtimeWarnMinutes, threshold.value);
                  return w === null ? '' : ` — ${w}`;
                })()}`}
          </p>
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
              {
                id: newId('copy'),
                condition: null,
                whereabouts: { kind: 'box', case: null },
                runtimeWarnMinutes: null,
                notes: null,
                runtimeMinutes: null,
              },
            ])
          }
        >
          ＋ Describe a copy
        </button>
      </div>
      <datalist id="manage-case-colours">
        {Object.keys(CASE_SWATCH).map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

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
