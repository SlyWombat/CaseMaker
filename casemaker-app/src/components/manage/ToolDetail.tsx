/**
 * The right rail of House → Tools (#311, tracking #212): the selected row, and the only place any
 * of it is edited.
 *
 * THE RAIL SHOWS THE DEFINITION, NOT THE ROW. A cutter is two documents — the definition a job
 * resolves (`cat:` / `user:` / built-in) and, for something the user physically owns, a possession
 * (`inv:`) carrying a count, codes and notes. Selecting an owned row therefore shows both: the
 * definition it was registered from, and the inventory record about the object in the drawer.
 * That split is the whole reason the two tiers exist, so the rail keeps them visually apart with
 * two subheads rather than merging them into one form.
 *
 * A MEASUREMENT THE SOURCE DID NOT STATE IS `—`, WITH A REASON. Every length in a `Tool` is null
 * when nobody stated it, and the table says which kind of unknown each one is: a null stick-out is
 * "unset; the machine probes the tip", a null centre-cutting is "unknown", and a missing shoulder
 * is the depth the cutter cannot be proven to support (#314). `display.mm` never prints 0 for any
 * of them, because 0 is a claim.
 *
 * READ-ONLY IS A POLICY AND IT IS STATED, NOT IMPLIED. Makera's catalogue rows belong to Studio's
 * library on this PC; a change made here would be overwritten by the next sync. So the only write
 * a catalogue row offers is `Clone to change`, exactly as the mockup has it — and the clone is a
 * `user:` definition that never edits the row it came from (`selection.cloneOf`).
 */

import { useState } from 'react';
import { catalogueIdOf, tierOf, TIER_TAG, type ToolTier } from '@/engine/cnc/toolTiers';
import { quantityOrOne, quantityProblem } from '@/engine/cnc/registerCutter';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { InventoryItem } from '@/platform/houseClient';
import { useHouseStore } from '@/store/houseStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { formatDay, mm } from './display';
import { cloneOf, useSelectedEntry, useSelectedItem } from './selection';
import { RegisterDoor } from './RegisterDoor';

/** The `tag` modifier for a tier. One class per tier id, so no mapping table has to stay in step. */
function tagClassFor(tier: ToolTier): string {
  return `tag--${tier}`;
}

export function ToolDetail() {
  const registerOpen = useManageModeStore((s) => s.registerOpen);
  const entry = useSelectedEntry();
  const item = useSelectedItem();
  // The register frame replaces the rail, rather than opening beside it: there is one rail, and a
  // door half-drawn under a detail table is a form nobody can finish.
  if (registerOpen) return <RegisterDoor />;
  if (entry === null) return <NothingSelected />;
  return <Detail entry={entry} item={item} />;
}

/** Nothing picked yet. Says what the rail is for rather than leaving a blank column. */
function NothingSelected() {
  return (
    <aside className="context-panel" data-testid="manage-detail-empty">
      <div className="empty">
        <h3>Nothing selected</h3>
        <p>
          Pick a row and its definition appears here — every dimension the source stated, and what
          it did not. Catalogue rows are read-only; a clone is yours to change.
        </p>
      </div>
    </aside>
  );
}

function Detail({ entry, item }: { entry: ToolLibraryEntry; item: InventoryItem | null }) {
  const select = useManageModeStore((s) => s.select);
  const registerTool = useHouseStore((s) => s.registerTool);
  const removeTool = useHouseStore((s) => s.removeTool);
  const busy = useHouseStore((s) => s.busy);
  const catalogueSyncedAt = useToolRegistryStore((s) => s.health?.catalogueSyncedAt ?? null);

  const tier = tierOf(entry.key);
  const t = entry.tool;
  const disabled = busy !== null;
  // The definition's own origin, which for an owned cutter is a different question from the
  // possession's: a cutter can sit in the inventory with no definition of yours behind it.
  const definition: { cls: string; label: string } =
    tier === 'owned'
      ? item?.origin
        ? { cls: 'tag--catalogue', label: 'catalogue' }
        : { cls: 'tag--yours', label: 'typed here' }
      : { cls: tagClassFor(tier), label: TIER_TAG[tier] };

  // Where this cutter came from, in the catalogue's own vocabulary. A `cat:` row IS its cutterId; an
  // owned row carries it on the possession's `origin` (`house.rs` keeps the catalogue id there and
  // deliberately not the key), which is the only way a physical cutter can name the row it was
  // registered from after that row is gone.
  const catalogueId = catalogueIdOf(entry.key) ?? item?.origin?.id ?? t.id;
  const synced = formatDay(catalogueSyncedAt);

  return (
    <aside className="context-panel" data-testid="manage-detail">
      <div className="panel-head">
        <h3>{t.name}</h3>
        <button
          type="button"
          className="x"
          aria-label="Close"
          data-testid="manage-detail-close"
          onClick={() => select(null)}
        >
          ×
        </button>
      </div>

      <div className="badge-row">
        {tier === 'owned' && item !== null && (
          <span className="tag tag--owned">
            owned · ×{item.quantity}
          </span>
        )}
        {item?.codes.map((c) => (
          <span className="code" key={`${c.symbology}:${c.value}`}>
            <i>{c.symbology.toUpperCase()}</i>
            {c.value}
          </span>
        ))}
      </div>

      <p className="hint">
        {tier === 'owned' ? (
          <>
            A physical cutter. Its definition is{' '}
            {item?.origin ? 'the catalogue row it was registered from' : 'its own, typed at the register frame'}
            {item?.origin && synced !== null ? `, as synced ${synced}` : ''} — read-only here. Clone it
            to rename it or to record a measured stick-out.
          </>
        ) : (
          entry.provenance
        )}
      </p>

      <div className="panel-subhead">
        Definition <span className={`tag ${definition.cls}`}>{definition.label}</span>
      </div>
      <table className="ro">
        <tbody>
          <tr>
            <th>shape</th>
            <td>{t.shape}</td>
          </tr>
          <tr>
            <th>tip ⌀</th>
            <td>{mm(t.tipDiameter ?? t.diameter)} mm</td>
          </tr>
          <tr>
            <th>shank ⌀</th>
            <td>{mm(t.handleDiameter)} mm</td>
          </tr>
          <tr>
            <th>flute length</th>
            <td>{mm(t.fluteLength)} mm</td>
          </tr>
          <tr>
            <th>shoulder length</th>
            <td>
              {mm(t.shoulderLength)} mm{' '}
              {t.shoulderLength === null && <span className="dim">— the depth it supports (#314)</span>}
            </td>
          </tr>
          <tr>
            <th>stick-out</th>
            <td>
              {mm(t.stickout)}{' '}
              {t.stickout === null && <span className="dim">unset; the machine probes the tip</span>}
            </td>
          </tr>
          <tr>
            <th>centre-cutting</th>
            <td>
              {t.centreCutting === null ? '—' : t.centreCutting ? 'yes' : 'no'}{' '}
              {t.centreCutting === null && <span className="dim">unknown (#220)</span>}
            </td>
          </tr>
          {t.number !== null && (
            <tr>
              <th>T number</th>
              <td>T{t.number}</td>
            </tr>
          )}
          {catalogueId !== null && (
            <tr>
              <th>catalogue id</th>
              <td>{catalogueId}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm"
          data-testid="manage-clone-here"
          disabled={disabled}
          title="Copy this definition into your own tier, to rename it or to record what you measured"
          onClick={() => void registerTool(cloneOf(entry, new Date().toISOString()))}
        >
          Clone to change
        </button>
      </div>

      {/* Keyed on the record the fields are seeded from, so a save or a sync that moves the quantity
          or the notes remounts the editor and re-seeds it. A plain re-render would leave the draft
          showing the old values. */}
      {item !== null && (
        <InventoryEditor
          key={`${item.id}\u0000${item.quantity}\u0000${item.notes ?? ''}`}
          item={item}
        />
      )}

      {tier === 'yours' && (
        <div className="btn-row">
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--sm btn--danger"
            data-testid="manage-remove-definition"
            disabled={disabled}
            title="Drop this definition. Jobs that named it keep the cutter they were written with."
            onClick={() => void removeTool(entry.key)}
          >
            Remove this definition
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * The possession's own record: how many, when it was added, what the user wrote about it, and the
 * codes that identify it. A SEPARATE DOCUMENT from the definition, which is why it is a separate
 * block and a separate save — `PATCH /inventory/<id>` touches nothing about the cutter's shape.
 *
 * The fields are local until Save because they are a draft: typing a quantity is not a statement
 * about how many cutters exist, and each keystroke writing to disk would make a typo durable.
 */
function InventoryEditor({ item }: { item: InventoryItem }) {
  const updateItem = useHouseStore((s) => s.updateItem);
  const removeItem = useHouseStore((s) => s.removeItem);
  const busy = useHouseStore((s) => s.busy);
  // Seeded from the record, and re-seeded only when the SERVICE changes the record: the caller keys
  // this component on its id, quantity and notes, so a save or a re-sync remounts it with the new
  // values. The obvious alternative — an effect that setStates on a changed prop — is a cascading
  // render, and `react-hooks/set-state-in-effect` refuses it.
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [notes, setNotes] = useState(item.notes ?? '');

  // The count rule is the register doors' rule, imported rather than re-derived (#331): blank means
  // one at both ends, and the sentence a refusal shows is the one sentence, in `registerCutter.ts`.
  const qty = quantityOrOne(quantity);
  const qtyProblem = quantityProblem(quantity);
  const nextNotes = notes.trim().length === 0 ? null : notes;
  const dirty = qtyProblem === null && (qty !== item.quantity || nextNotes !== item.notes);
  const disabled = busy !== null;

  return (
    <>
      <div className="panel-subhead">Inventory</div>
      <div className="grid2">
        <label className="lf">
          <span>quantity</span>
          <input
            className="fld fld--num"
            type="number"
            min={1}
            step={1}
            value={quantity}
            placeholder="1"
            data-testid="manage-item-quantity"
            aria-label="How many of this cutter are owned"
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label className="lf">
          <span>added</span>
          <input
            className="fld"
            type="text"
            value={formatDay(item.addedAt) ?? item.addedAt}
            readOnly
            data-testid="manage-item-added"
            aria-label="When this cutter was registered"
          />
        </label>
      </div>
      <label className="lf">
        <span>
          notes <em>optional</em>
        </span>
        <input
          className="fld fld--text"
          type="text"
          value={notes}
          placeholder="where it lives, what it is for"
          data-testid="manage-item-notes"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="manage-item-save"
          disabled={!dirty || disabled}
          title={qtyProblem ?? 'Save the count and the notes'}
          onClick={() => void updateItem({ ...item, quantity: qty, notes: nextNotes })}
        >
          Save
        </button>
      </div>

      <div className="panel-subhead">Codes</div>
      {item.codes.length === 0 ? (
        <p className="hint">
          No code on record. A code is what a scan matches against, and it is only ever written when
          a cutter is registered.
        </p>
      ) : (
        <div className="row row--wrap">
          {item.codes.map((c) => (
            <span className="code" key={`${c.symbology}:${c.value}`}>
              <i>{c.symbology.toUpperCase()}</i>
              {c.value}
            </span>
          ))}
        </div>
      )}
      <p className="hint">Codes are local to this house; nothing is looked up online.</p>

      <div className="btn-row">
        <span className="spacer" />
        <button
          type="button"
          className="btn btn--sm btn--danger"
          data-testid="manage-item-remove"
          disabled={disabled}
          title="Take this cutter out of the inventory. Any definition it was registered from stays."
          onClick={() => void removeItem(item.id)}
        >
          Remove from inventory
        </button>
      </div>
    </>
  );
}
