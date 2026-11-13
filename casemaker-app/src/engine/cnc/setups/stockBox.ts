/**
 * #1246 slice 2 — THE ONE STOCK RESOLVER.
 *
 * `stockForSetup` (the verifier side) and `setupStockOf` (the planner's) both answer "what box is
 * this setup cut from"; they took the setup's own statement from two different documents (the
 * job's `JobSetup.stock` and the model input's `SetupSpec.stock`). Both now call this, so the
 * answer cannot drift: the stated box when there is one, else the blank's three numbers.
 *
 * A DEPENDENCY-FREE MODULE ON PURPOSE: the planner (`cam/model/plan.ts`) must be able to import
 * it without pulling `setups/perSetupStock.ts` (which reaches the registration session) into the
 * planner's graph. Numbers only — the stock's kind is a separate fact, stated by the record.
 */
export interface StockBox {
  length: number;
  width: number;
  thickness: number;
}

export function resolveSetupStock(own: StockBox | null | undefined, blank: StockBox): StockBox {
  return own === null || own === undefined
    ? { length: blank.length, width: blank.width, thickness: blank.thickness }
    : { length: own.length, width: own.width, thickness: own.thickness };
}
