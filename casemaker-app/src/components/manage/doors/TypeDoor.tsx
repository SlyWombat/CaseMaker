/**
 * The Type door (#309, tracking #212): the cutter nobody's table has — a one-off from a drawer, or
 * a box whose code reads as nothing this build knows.
 *
 * EVERY LENGTH IS OPTIONAL AND BLANK MEANS UNKNOWN, NEVER 0 (`registerCutter.itemFromForm`). That
 * is not politeness: a `0` is a CLAIM, and the cut planner treats one differently from an absent
 * number — a 0 mm stick-out would put the collet nut at the tool tip (#305). So a field the user
 * leaves alone records nothing, and the panel says so rather than leaving them to guess. A typed
 * 0 or a negative is the other case — a typo, not an unknown — and the submit is refused with the
 * sentence rather than the number being quietly dropped (#334, `specProblem`).
 *
 * WHAT THIS DOOR DOES NOT ASK FOR IS DELIBERATE. No stick-out (the machine probes the tip), no
 * centre-cutting (a question about grinding that nobody knows off a box), no numbers. A definition
 * with no Makera row behind it has `id: null` and `number: null`, and both stay that way.
 *
 * THE FORM EMPTIES WHEN THE CUTTER LANDS (#337). A door that kept its fields armed after a
 * registration would register the same cutter twice on a second click, with no code for the
 * service to catch it by. So a successful write resets every box and points the list at the new
 * row; the frame stays open, because the next box is already in the user's other hand.
 */

import { useState } from 'react';
import { useHouseStore } from '@/store/houseStore';
import {
  itemFromForm,
  quantityProblem,
  specProblem,
  type CutterForm,
} from '@/engine/cnc/registerCutter';
import { useManageModeStore } from '@/store/manageModeStore';
import { selectRegistered } from '../selection';
import { CutterFields } from './CutterFields';
import { InventoryFields } from './InventoryFields';

const BLANK_FORM: CutterForm = {
  name: '',
  shape: 'flat',
  tipDiameter: '',
  handleDiameter: '',
  fluteLength: '',
  shoulderLength: '',
  quantity: '1',
  notes: '',
};

export function TypeDoor() {
  const registerItem = useHouseStore((s) => s.registerItem);
  const busy = useHouseStore((s) => s.busy);
  const setDoor = useManageModeStore((s) => s.setDoor);

  const [form, setForm] = useState<CutterForm>(BLANK_FORM);

  const blocked = specProblem(form) ?? quantityProblem(form.quantity);

  async function register() {
    const item = itemFromForm(form, new Date().toISOString());
    if (await registerItem(item)) {
      setForm(BLANK_FORM);
      selectRegistered(item.id);
    }
  }

  return (
    <>
      <CutterFields
        prefix="manage-type"
        spec={form}
        onChange={(spec) => setForm((f) => ({ ...f, ...spec }))}
        disabled={busy !== null}
      />

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
          onClick={() => void register()}
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
