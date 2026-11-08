/**
 * #1073 — THE FLIP CHOICE, as the Setups row shows it: the method, the axis, the graphic with
 * both costs, the defaults' reasons, and — follow-up (b) — the vendor method's availability,
 * which the registration planner decides from the PART's outline (its front straight run).
 *
 * Writing is the row's: `onReplace` receives the setup with the chosen `flip` and the orientation
 * the axis implies. Nothing here writes; the proposal is pre-selected and the operator commits.
 */

import type { CSSProperties, JSX } from 'react';

import { FlipDiagram } from '@/components/ui/FlipDiagram';
import { flipOrientation } from '@/engine/cnc/engrave/flipChoice';
import { defaultFlip } from '@/engine/cnc/engrave/flipDefaults';
import type { PartSilhouette, VendorOffer } from '@/engine/cnc/engrave/flipSilhouette';
import type { JobSetup, SetupFlip, StockCorner } from '@/types/engraveJob';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const WARN = '#e0c07a';

export interface FlipChoiceProps {
  /** 1-based setup number, for the testids. */
  n: number;
  setup: JobSetup;
  editable: boolean;
  /** The seated blank's extents and stated square corners. */
  stock: { length: number; width: number; squareCorners?: StockCorner[] };
  /** The job's breakthrough rule, mm: the vendor method's groove past the outline. */
  breakthroughMm?: number;
  /** The part's measured outline, for the vendor view and its availability. */
  partSilhouette?: PartSilhouette | null;
  /** The planner's verdict on the vendor method for this part. */
  vendorOffer?: VendorOffer;
  onReplace: (next: JobSetup) => void;
}

export function FlipChoice(props: FlipChoiceProps): JSX.Element {
  const { n, setup, editable } = props;
  const def = defaultFlip({ squareCorners: props.stock.squareCorners });
  const flip = setup.flip ?? { method: def.method, axis: def.axis };
  const commit = (method: SetupFlip['method'], axis: SetupFlip['axis']): void => {
    props.onReplace({ ...setup, flip: { method, axis }, orientation: flipOrientation(axis) });
  };
  const vendorUnavailable = props.vendorOffer?.available === false;
  return (
    <div data-testid={`engrave-setup-flip-${n}`} style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
        <label style={MUTED}>
          Flip method{' '}
          <select
            data-testid={`engrave-setup-flip-method-${n}`}
            value={flip.method}
            disabled={!editable}
            onChange={(e) => commit(e.target.value as SetupFlip['method'], flip.axis)}
          >
            <option value="tabs-in-blank">Keep the part in the blank on tabs</option>
            <option value="free-then-flip" disabled={vendorUnavailable}>
              Free the part, then flip it
            </option>
          </select>
        </label>
        <label style={MUTED}>
          Flip axis{' '}
          <select
            data-testid={`engrave-setup-flip-axis-${n}`}
            value={flip.axis}
            disabled={!editable}
            onChange={(e) => commit(flip.method, e.target.value as SetupFlip['axis'])}
          >
            <option value="left-right">Left ↔ right</option>
            <option value="front-back">Front ↔ back</option>
          </select>
        </label>
        {setup.flip === undefined ? (
          <button type="button" data-testid={`engrave-setup-flip-use-${n}`} disabled={!editable} onClick={() => commit(flip.method, flip.axis)}>
            Use this flip
          </button>
        ) : null}
      </div>
      {vendorUnavailable ? (
        <p style={{ ...MUTED, color: WARN }} data-testid={`engrave-setup-flip-vendor-unavailable-${n}`}>
          The vendor method is unavailable — {props.vendorOffer!.reason}
        </p>
      ) : null}
      <FlipDiagram
        lengthMm={props.stock.length}
        widthMm={props.stock.width}
        flip={flip}
        squareCorners={props.stock.squareCorners}
        pins={setup.pins?.at}
        breakthroughMm={props.breakthroughMm}
        part={props.partSilhouette?.box ?? null}
      />
      <p style={MUTED} data-testid={`engrave-setup-flip-default-method-${n}`}>
        Default: {def.methodReason}.
      </p>
      <p style={MUTED} data-testid={`engrave-setup-flip-default-axis-${n}`}>
        Default axis: {def.axisReason}.
      </p>
    </div>
  );
}
