/**
 * The Catalogue door (#309, tracking #212): find the row Makera already wrote, and register the
 * physical cutter against it.
 *
 * THE SEARCH IS THE HOUSE'S OWN SEARCH. Several catalogue shapes hold the same bit — Makera sells a
 * `3.175*1*4mm` and a `3.175*1*3mm` — so the field takes words and every one must appear
 * (`toolTiers.matchesSearch`), the same rule the list above this rail uses. Reusing it is the point:
 * two search boxes that disagree about what "1mm ball" means would be worse than one.
 *
 * REGISTERING DOES NOT COPY THE ROW INTO `user:`. It creates an owned row whose definition is
 * Makera's, read-only, with `origin` naming the row it came from — #311 decision 2. A user who
 * wants to CHANGE the definition clones it, which is a different act and lives in the detail rail.
 *
 * THE PICK IS DROPPED WHEN THE CUTTER LANDS (#337). A row registered from here carries no code, so
 * the service's one-code-one-item rule cannot catch a second click on the same pick; the only
 * guard is that there is no pick left to click. The search stays — the next cutter is often the
 * row beside the last one — and the new `inv:` row is highlighted in the list behind the frame.
 */

import { useState } from 'react';
import { useHouseStore } from '@/store/houseStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { matchesSearch, tierOf, toolSearchText } from '@/engine/cnc/toolTiers';
import {
  itemFromEntry,
  quantityOrOne,
  quantityProblem,
} from '@/engine/cnc/registerCutter';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { mm } from '../display';
import { useManageModeStore } from '@/store/manageModeStore';
import { selectRegistered } from '../selection';
import { InventoryFields } from './InventoryFields';

export function CatalogueDoor() {
  const entries = useToolRegistry();
  const health = useToolRegistryStore((s) => s.health);
  const registerItem = useHouseStore((s) => s.registerItem);
  const busy = useHouseStore((s) => s.busy);
  const setDoor = useManageModeStore((s) => s.setDoor);

  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');

  const catalogue = entries.filter((e) => tierOf(e.key) === 'catalogue');
  const shown = query.trim().length === 0 ? catalogue : catalogue.filter((e) => matchesSearch(toolSearchText(e), query));
  const pickedEntry = picked ? (catalogue.find((e) => e.key === picked) ?? null) : null;
  const qtyProblem = quantityProblem(quantity);
  const disabled = busy !== null;

  async function register(entry: ToolLibraryEntry) {
    const item = itemFromEntry(entry, {
      quantity: quantityOrOne(quantity),
      code: null,
      notes,
      now: new Date().toISOString(),
      health,
    });
    if (await registerItem(item)) {
      setPicked(null);
      setQuantity('1');
      setNotes('');
      selectRegistered(item.id);
    }
  }

  if (catalogue.length === 0) {
    return (
      <>
        <p className="hint" data-testid="manage-catalogue-empty">
          No catalogue is synced on this house, so there is nothing to search. Makera’s own rows come
          from Studio’s library on this PC — sync them, or{' '}
          <button type="button" className="linkish" data-testid="manage-catalogue-to-type" onClick={() => setDoor('type')}>
            type the cutter in
          </button>
          .
        </p>
      </>
    );
  }

  return (
    <>
      <label className="lf">
        <span>
          search the catalogue <em>{catalogue.length} rows</em>
        </span>
        <input
          className="fld fld--text"
          type="text"
          value={query}
          placeholder="name, size or shape…"
          data-testid="manage-catalogue-search"
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setPicked(null);
          }}
        />
      </label>

      <div className="card">
        {shown.length === 0 ? (
          <p className="hint" data-testid="manage-catalogue-nomatch" style={{ margin: 0 }}>
            Nothing matches. Try fewer words, or{' '}
            <button type="button" className="linkish" data-testid="manage-catalogue-nomatch-type" onClick={() => setDoor('type')}>
              type it
            </button>
            .
          </p>
        ) : (
          shown.map((row) => (
            <label className="cand--radio" key={row.key}>
              <input
                type="radio"
                name="manage-catalogue-row"
                checked={picked === row.key}
                data-testid={`manage-catalogue-row-${row.key}`}
                disabled={disabled}
                onChange={() => setPicked(row.key)}
              />
              <span>{row.tool.name}</span>
              <small>
                tip {mm(row.tool.tipDiameter)} · flute {mm(row.tool.fluteLength)}
              </small>
            </label>
          ))
        )}
      </div>

      {pickedEntry !== null && (
        <>
          <InventoryFields
            prefix="manage-catalogue"
            quantity={quantity}
            notes={notes}
            onQuantity={setQuantity}
            onNotes={setNotes}
            disabled={disabled}
          />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="manage-catalogue-register"
              disabled={qtyProblem !== null || disabled}
              title={qtyProblem ?? 'Register this cutter'}
              onClick={() => void register(pickedEntry)}
            >
              Add to inventory
            </button>
            <span className="hint" style={{ margin: 0 }}>
              creates an <b>owned</b> row; the definition stays Makera’s
            </span>
          </div>
        </>
      )}
    </>
  );
}
