/**
 * The Makera cutter an owned row physically is (#732, maintainer decision 2026-10-28).
 *
 * An owned cutter registered from its printed label carries no Makera id, so no catalogue feed row
 * can name it (`feeds.catalogueCoverageFor` → `no-vendor-id`) and every job on a material the
 * starting table does not cover is refused. The decision is not to guess from the label in the
 * feeds path: the app SUGGESTS a match from the cutter's own evidence, the operator confirms it
 * once, and the id is stored on the inventory row (`item.tool.id`, through `withMakeraId`).
 *
 * THE LIST IS DRAWN, NEVER APPLIED. Nothing here writes on render, on selection or on a single
 * candidate: the radio and the Confirm press are two acts, and the sentence says the match is a
 * suggestion. Until that press the feeds answer is unchanged — the cutter carries no Makera id.
 *
 * WHAT IT SHOWS IS WHAT IT READ. The reading is the box code's (or the record's) own vocabulary,
 * rendered by the Scan door's `describeReading`, so a code read here cannot say something different
 * from the same code scanned at the register frame. A confirmed row shows the id alone when the
 * catalogue has no row for it (a partial sync, or a row removed since).
 */

import { useMemo, useState } from 'react';
import { suggestMakeraMatch, withMakeraId } from '@/engine/cnc/registerCutter';
import { vendorId } from '@/engine/cnc/tool';
import type { InventoryItem } from '@/platform/houseClient';
import { useHouseStore } from '@/store/houseStore';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { mm } from './display';
import { describeReading } from './doors/reading';

const rowsFit = (count: number): string => `${count} catalogue row${count === 1 ? '' : 's'} fit`;

export function MakeraMatch({ item }: { item: InventoryItem }) {
  const entries = useToolRegistry();
  const updateItem = useHouseStore((s) => s.updateItem);
  const busy = useHouseStore((s) => s.busy);
  const [picked, setPicked] = useState<string | null>(null);

  const suggestion = useMemo(() => suggestMakeraMatch(item, entries), [item, entries]);
  const confirmedId = vendorId(item.tool);
  const confirmedEntry: ToolLibraryEntry | null =
    confirmedId === null ? null : (entries.find((entry) => vendorId(entry.tool) === confirmedId) ?? null);
  const disabled = busy !== null;

  return (
    <>
      <div className="panel-subhead">Makera match</div>

      {confirmedId !== null ? (
        <>
          <p className="hint" data-testid="manage-makera-confirmed">
            Makera cutter id <b>{confirmedId}</b> is on this row
            {confirmedEntry ? ` — the catalogue lists it as ${confirmedEntry.tool.name}` : ''}. The
            feeds for this cutter use Makera's rows for it.
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--sm"
              data-testid="manage-makera-clear"
              disabled={disabled}
              title="Forget the match. Jobs go back to being refused where the cutter has no row of its own."
              onClick={() => void updateItem(withMakeraId(item, null))}
            >
              Remove the match
            </button>
          </div>
        </>
      ) : suggestion === null ? (
        <p className="hint" data-testid="manage-makera-no-evidence">
          No Makera match is suggested: this cutter carries no readable box code, and its record
          states no shape or tip to match on.
        </p>
      ) : (
        <>
          <p className="hint" data-testid="manage-makera-reading">
            {suggestion.from === 'code' ? (
              <>
                Read from the box code <span className="mono">{suggestion.code}</span>:{' '}
              </>
            ) : (
              'Read from this cutter’s own record: '
            )}
            <b>{describeReading(suggestion.reading)}</b>.{' '}
            {suggestion.matches.length === 0 ? 'No catalogue row fits it.' : `${rowsFit(suggestion.matches.length)}, the same Makera line first. Pick the one on the box.`}
          </p>
          {suggestion.matches.length > 0 ? (
            <>
              <div className="card">
                {suggestion.matches.map((match) => (
                  <label className="cand--radio" key={match.cutterId}>
                    <input
                      type="radio"
                      name="manage-makera-candidate"
                      checked={picked === match.cutterId}
                      data-testid={`manage-makera-candidate-${match.cutterId}`}
                      disabled={disabled}
                      onChange={() => setPicked(match.cutterId)}
                    />
                    <span>{match.entry.tool.name}</span>
                    <small>
                      {match.sameLine ? 'same line · ' : ''}Makera id {match.cutterId}
                      {match.entry.tool.fluteLength !== null ? ` · flute ${mm(match.entry.tool.fluteLength)} mm` : ''}
                    </small>
                  </label>
                ))}
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  data-testid="manage-makera-confirm"
                  disabled={picked === null || disabled}
                  title="Save this Makera cutter id on the inventory row"
                  onClick={() => picked !== null && void updateItem(withMakeraId(item, picked))}
                >
                  Confirm this Makera cutter
                </button>
              </div>
              <p className="hint">
                The match is suggested from the cutter’s own label and record. Nothing is saved until
                you confirm it.
              </p>
            </>
          ) : (
            <p className="hint" data-testid="manage-makera-no-match">
              Until a match is confirmed, the feeds say this cutter carries no Makera id.
            </p>
          )}
        </>
      )}
    </>
  );
}
