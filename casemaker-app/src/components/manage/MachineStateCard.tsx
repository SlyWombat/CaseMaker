/**
 * The machine's state card (#1173A item 1) — the first thing the Machines page says.
 *
 * ONE LINE IN THE OPERATOR'S WORDS, from `machineStateWords.ts`'s reading of the live status line and
 * the heartbeat, and the three controls that belong to that state:
 *   - ready   → Stop disabled ("nothing running"), Unlock disabled ("no alarm"), Home live;
 *   - cutting → Stop live, switches locked (the program owns the output codes);
 *   - alarm   → Unlock live and primary, Stop disabled;
 *   - silent  → "Check again" and the plug sentence; every control that needs a socket is disabled.
 *
 * The colour is `data-state` on the card (index.css), so the CSS follows the same reading the words
 * do and there is no second copy of the rule. `MachinesScope` computes the facts once and hands the
 * same object to the switches, so the card and the lock cannot disagree.
 */

import { MachineStop } from './MachineStop';
import { MachineUnlock } from './MachineUnlock';
import type { LiveFacts } from './machineStateWords';

export function MachineStateCard({
  facts,
  host,
  port,
  onCheckAgain,
}: {
  facts: LiveFacts;
  host: string;
  port: number;
  /** A fresh discovery check — the card's own "Check again" when the machine is not answering. */
  onCheckAgain: () => void;
}) {
  return (
    <div className="mstate" data-testid="manage-state-card" data-state={facts.state}>
      <p className="mstate-headline" data-testid="manage-state-headline">
        {facts.headline}
      </p>
      <div className="btn-row">
        <MachineStop host={host} port={port} stopLive={facts.stopLive} canHome={facts.state === 'ready'} />
        <MachineUnlock host={host} port={port} alarmed={facts.alarmed} />
        {facts.state === 'silent' && (
          <button
            type="button"
            className="btn btn--sm"
            data-testid="manage-state-recheck"
            title="Search the network and ask the machine again"
            onClick={onCheckAgain}
          >
            Check again
          </button>
        )}
      </div>
      {facts.state === 'silent' && (
        <p className="hint" data-testid="manage-state-plug">
          Switch it on at the plug, then check again.
        </p>
      )}
    </div>
  );
}
