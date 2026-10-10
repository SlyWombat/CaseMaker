/**
 * The two fields every door ends on (#309, tracking #212): how many, and anything worth writing
 * down. Shared because the Scan and Catalogue doors ask the same question about the same object —
 * the one difference is the row it was identified by, which is the panel's business, not the form's.
 *
 * QUANTITY IS TYPED, NOT DEFAULTED SILENTLY. Blank means one (a user holding the box has at least
 * one), but a count the service would refuse — 0, a fraction — is left in the field and the submit
 * is disabled with the reason, rather than being rewritten to 1 behind the user's back. The same
 * rule `ToolDetail`'s inventory editor applies, because it is the same `InventoryItemSchema` at the
 * other end.
 */

export interface InventoryFieldsProps {
  /** Test-id stem: `<prefix>-quantity`, `<prefix>-notes`. */
  prefix: string;
  quantity: string;
  notes: string;
  onQuantity: (value: string) => void;
  onNotes: (value: string) => void;
  disabled: boolean;
}

export function InventoryFields({
  prefix,
  quantity,
  notes,
  onQuantity,
  onNotes,
  disabled,
}: InventoryFieldsProps) {
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
            data-testid={`${prefix}-quantity`}
            aria-label="How many of this cutter are owned"
            disabled={disabled}
            onChange={(e) => onQuantity(e.target.value)}
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
          data-testid={`${prefix}-notes`}
          disabled={disabled}
          onChange={(e) => onNotes(e.target.value)}
        />
      </label>
    </>
  );
}
