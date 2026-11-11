/**
 * #681 — the stock step of the one cutting-job wizard.
 *
 * The step's questions and every rule stay with `StartStockStep` (and the engine behind it); this
 * wrapper is the seam wave 2's stock-step slice (#683) rewrote. It holds no template list: #680
 * put the starters on the welcome door, and a starter opens this wizard with its blank already the
 * stock — this step is only the stock the job will be cut from.
 */

import type { JSX } from 'react';
import { StartStockStep, type PendingStock, type StartStockSeed } from './StartStockStep';
import type { PartFootprint } from './workShape';

export interface StockStepProps {
  /** The job's own stock when the step is re-opened to edit it (#681). */
  seed?: StartStockSeed;
  /** The answer, or null when there is none. No form blocks since #713: a long rod is the rotary's. */
  onPending: (pending: PendingStock | null) => void;
  /** #1099 — the part drawn on the blank. */
  part?: PartFootprint | null;
  /** #1098 item 6 — a file the question step already recognised: the step opens settled on it. */
  presetFile?: File;
}

export function StockStep({ seed, onPending, part = null, presetFile }: StockStepProps): JSX.Element {
  return <StartStockStep onChange={onPending} seed={seed} part={part} presetFile={presetFile} />;
}
