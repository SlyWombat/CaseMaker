/**
 * #662 — a request from the WIZARD to the PANEL, for the one operation the wizard cannot create.
 *
 * Every other type is a store action. "Surface a mesh" needs a FILE, and the file input and its
 * reader belong to the panel (`EngravePanel`'s target import). The wizard is a portal that the
 * panel may also mount from elsewhere (the welcome hand-off), so it cannot hold that input — it
 * asks, and the panel that is on screen answers.
 *
 * One listener by construction: the panel registers while it is mounted and clears on unmount.
 */

import type { OperationTypeId } from './operationTypes';

type Intake = (type: OperationTypeId) => void;

let intake: Intake | null = null;

/** The panel registers here for as long as it is mounted. */
export function setOperationIntake(fn: Intake | null): void {
  intake = fn;
}

/** Ask the panel for an operation it owns the input for. False when no panel is mounted. */
export function requestOperation(type: OperationTypeId): boolean {
  if (intake === null) return false;
  intake(type);
  return true;
}
