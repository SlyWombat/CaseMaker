/**
 * #681 — step 2 of the one cutting-job wizard: the stock.
 *
 * The step's questions and every rule stay with `StartStockStep` (and the engine behind it); this
 * wrapper is the seam wave 2's stock-step slice (#683) rewrote. It holds no template list: #680
 * put the starters on the welcome door, and a starter opens this wizard with its blank already the
 * stock — step 2 is only the stock the job will be cut from.
 */

import type { JSX } from 'react';
import { StartStockStep, type PendingStock, type StartStockSeed } from './StartStockStep';

export interface StockStepProps {
  /** The job's own stock when the step is re-opened to edit it (#681). */
  seed?: StartStockSeed;
  /** The answer, or null when there is none; `block` is the sentence that stops this form. */
  onPending: (pending: PendingStock | null, block: string | null) => void;
}

export function StockStep({ seed, onPending }: StockStepProps): JSX.Element {
  return <StartStockStep onChange={onPending} seed={seed} />;
}
