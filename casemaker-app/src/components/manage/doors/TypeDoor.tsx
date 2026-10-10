/**
 * The Type door (#309, tracking #212): the cutter nobody's table has — a one-off from a drawer, or
 * a box whose code reads as nothing this build knows.
 *
 * EVERY LENGTH IS OPTIONAL AND BLANK MEANS UNKNOWN, NEVER 0 (`registerCutter.itemFromForm`). That
 * is not politeness: a `0` is a CLAIM, and the cut planner treats one differently from an absent
 * number — a 0 mm stick-out would put the collet nut at the tool tip (#305). So a field the user
 * leaves alone records nothing, and the panel says so rather than leaving them to guess.
 *
 * WHAT THIS DOOR DOES NOT ASK FOR IS DELIBERATE. No stick-out (the machine probes the tip), no
 * centre-cutting (a question about grinding that nobody knows off a box), no numbers. A definition
 * with no Makera row behind it has `id: null` and `number: null`, and both stay that way.
 */

import { useState, type ChangeEvent } from 'react';
import { useHouseStore } from '@/store/houseStore';
import { itemFromForm, quantityProblem, type CutterForm } from '@/engine/cnc/registerCutter';
import { useManageModeStore } from '@/store/manageModeStore';
import { InventoryFields } from './InventoryFields';
import { SHAPE_LABELS, TYPABLE_SHAPES } from './reading';

export function TypeDoor() {
  const registerItem = useHouseStore((s) => s.registerItem);
  const busy = useHouseStore((s) => s.busy);
  const setDoor = useManageModeStore((s) => s.setDoor);

  const [form, setForm] = useState<CutterForm>({
    name: '',
    shape: 'flat',
    tipDiameter: '',
    handleDiameter: '',
    fluteLength: '',
    shoulderLength: '',
    quantity: '1',
    notes: '',
  });

  const field = (key: keyof CutterForm) => ({
    value: form[key],
    disabled: busy !== null,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const named = form.name.trim().length > 0;
  const qtyProblem = quantityProblem(form.quantity);
  const blocked = !named ? 'a cutter needs a name' : (qtyProblem ?? null);

  return (
    <>
      <label className="lf">
        <span>name</span>
        <input
          className="fld fld--text"
          type="text"
          placeholder="1 mm ball nose — green box"
          data-testid="manage-type-name"
          {...field('name')}
        />
      </label>

      <label className="lf">
        <span>shape</span>
        <select className="fld fld--text" data-testid="manage-type-shape" {...field('shape')}>
          {TYPABLE_SHAPES.map((shape) => (
            <option key={shape} value={shape}>
              {SHAPE_LABELS[shape]}
            </option>
          ))}
        </select>
      </label>

      {/* `tip ⌀` and `shank ⌀` are held together: this rail is narrow, and a break between a word
          and its symbol leaves a stray glyph alone on a line. */}
      <div className="grid2">
        <label className="lf">
          <span>tip&nbsp;⌀ mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid="manage-type-tip"
            {...field('tipDiameter')}
          />
        </label>
        <label className="lf">
          <span>shank&nbsp;⌀ mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid="manage-type-shank"
            {...field('handleDiameter')}
          />
        </label>
        <label className="lf">
          <span>flute mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid="manage-type-flute"
            {...field('fluteLength')}
          />
        </label>
        <label className="lf">
          <span>shoulder mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid="manage-type-shoulder"
            {...field('shoulderLength')}
          />
        </label>
      </div>

      <InventoryFields
        prefix="manage-type"
        quantity={form.quantity}
        notes={form.notes}
        onQuantity={(v) => setForm((f) => ({ ...f, quantity: v }))}
        onNotes={(v) => setForm((f) => ({ ...f, notes: v }))}
        disabled={busy !== null}
      />

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="manage-type-register"
          disabled={blocked !== null || busy !== null}
          title={blocked ?? 'Register this cutter'}
          onClick={() => void registerItem(itemFromForm(form, new Date().toISOString()))}
        >
          Add to inventory
        </button>
        <span className="hint" style={{ margin: 0 }}>
          blank stays unknown — never 0
        </span>
      </div>

      <p className="hint">
        Looking for a row Makera already has?{' '}
        <button type="button" className="linkish" data-testid="manage-type-to-catalogue" onClick={() => setDoor('catalogue')}>
          Search the catalogue
        </button>
        .
      </p>
    </>
  );
}
