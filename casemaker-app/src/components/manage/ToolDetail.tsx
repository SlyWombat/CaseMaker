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
 *
 * AND A YOURS ROW IS WHERE THE CHANGE HAPPENS (#335, #311 decision 2). "Clone to change" used to
 * end at the clone: `updateTool` had no caller. A `user:` row now gets the definition editor — the
 * Type door's six fields and its rules (`registerCutter.specProblem` / `toolFromSpec`), a Save that
 * `PATCH`es the key with the tool list's validator — and nothing else does: catalogue, built-in and
 * owned rows keep the read-only table, because a possession's definition is the catalogue's or
 * the one it was typed with, and changing it is a clone.
 */

import { useState } from 'react';
import { catalogueIdOf, tierOf, TIER_TAG, type ToolTier } from '@/engine/cnc/toolTiers';
import {
  quantityOrOne,
  quantityProblem,
  specOfTool,
  specProblem,
  toolFromSpec,
  type CutterSpec,
} from '@/engine/cnc/registerCutter';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { InventoryItem } from '@/platform/houseClient';
import { useHouseStore } from '@/store/houseStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { formatDay, mm } from './display';
import { cloneOf, useSelectedEntry, useSelectedItem } from './selection';
import { CutterFields } from './doors/CutterFields';
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
  // registered from after that row is gone. Failing both, a definition may still carry Makera's own
  // `g_ID` on `tool.id` — the built-in `flat-3.175x12-metal` does — and that is a DIFFERENT id
  // (`OriginSchema` calls the catalogue's `cutterId`), so it is labelled as Makera's, not as the
  // catalogue's (#311 review).
  const catalogueId = catalogueIdOf(entry.key) ?? item?.origin?.id ?? null;
  const vendorId = catalogueId === null ? t.id : null;
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
      {/* Keyed on the fields it seeds from, like the inventory editor below: a save re-reads the
          list and the editor remounts on the saved values rather than keeping the draft. */}
      {tier === 'yours' && (
        <DefinitionEditor key={`${entry.key}\u0000${JSON.stringify(specOfTool(t))}`} entry={entry} />
      )}
      <table className="ro">
        <tbody>
          {tier !== 'yours' && (
            <>
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
            </>
          )}
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
          {vendorId !== null && (
            <tr>
              <th>Makera id</th>
              <td data-testid="manage-detail-makera-id">{vendorId}</td>
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
 * The definition editor for a Yours row (#335): the Type door's six fields over the user's own
 * `Tool`, and a Save that replaces it in place.
 *
 * THE RULES ARE THE TYPE DOOR'S, IMPORTED. Blank is null and never 0, a typed 0 or negative is
 * refused with its sentence, a non-flat shape's `diameter` is the shank alone — all of it is
 * `registerCutter.ts`, read through `specProblem` and `toolFromSpec`, so an edit and a registration
 * cannot disagree about what a blank box means. What the form has no box for (stick-out,
 * centre-cutting) is carried over from the row untouched, and shown below as the read-only rows
 * they still are.
 *
 * THE SAVE IS GUARDED BY THE TOOL LIST'S VALIDATOR (#321). `houseStore.updateTool` reads the
 * registry's `etag` at the moment of the write and sends it as `If-Match`; a 412 comes back as the
 * service's own sentence in the notice above the list, and the store re-reads behind it, exactly as
 * the inventory editor's save does. Nothing here has its own words for that.
 *
 * A draft until Save, for the same reason the inventory editor is: each keystroke writing a
 * definition to disk would make a typo a measurement.
 */
function DefinitionEditor({ entry }: { entry: ToolLibraryEntry }) {
  const updateTool = useHouseStore((s) => s.updateTool);
  const busy = useHouseStore((s) => s.busy);
  const [spec, setSpec] = useState<CutterSpec>(() => specOfTool(entry.tool));

  const problem = specProblem(spec);
  const next = problem === null ? toolFromSpec(spec, entry.tool) : null;
  // Dirty means the TOOL would change, read back through the same text the boxes show: `2.0`
  // typed over a stored 2 is not an edit.
  const dirty =
    next !== null && JSON.stringify(specOfTool(next)) !== JSON.stringify(specOfTool(entry.tool));
  const disabled = busy !== null;

  return (
    <div data-testid="manage-definition-editor">
      <CutterFields prefix="manage-def" spec={spec} onChange={setSpec} disabled={disabled} />
      <p className="hint">
        blank stays unknown — never 0. A blank shoulder is the depth it supports (#314).
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="manage-def-save"
          disabled={!dirty || disabled}
          title={problem ?? 'Save this definition'}
          onClick={() => next !== null && void updateTool({ ...entry, tool: next })}
        >
          Save
        </button>
      </div>
    </div>
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
