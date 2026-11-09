/**
 * #1127 — THE CUTTER CHECKLIST, interactive.
 *
 * The bench note (promoted from #1123 item 5): the run's bits were a paragraph; the operator needs
 * a checklist that says whether each bit is IN HAND before the machine is warm. One row per
 * DISTINCT cutter in program order — cam's `postedCuttersFor` rows (#1123 item 5, `CutterList.tsx`:
 * registry key as identity only, display name, the program numbers it serves) — with:
 *
 *   - the operator's state: LOCATED (tick) or REPLACED with another owned cutter of the same class;
 *   - the shank it needs when it is not the machine's ⌀3.175 standard ("6 mm shank"): from the
 *     registry record's handle diameter. A collet is named only when a record states one; no record
 *     does today, so the shank is what is printed (the gap is on #1127);
 *   - the gate sentence the Cut step prints while rows are unresolved.
 *
 * THE STATE IS NOT A BYTE INPUT (the Manager's ruling): it lives on the job as
 * `job.cutterChecklist`, keyed by the frozen package's hash (one checklist per run), and is outside
 * `jobFingerprint` and every staleness compare — ticking a box never stales a program and never
 * calls a worker. A replacement changes the CUTTER, which is a byte input: the caller re-generates
 * the whole run and shows its cost before the press.
 */
import type { JSX } from 'react';

import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { benchCutterFor, getTools } from '@/engine/cnc/toolRegistry';
import { cutterSettled, settledCutterEntry } from '@/engine/cnc/engrave/cutterChecklist';
import type { CutterChecklistEntry } from '@/types/engraveJob';
import { postedCuttersFor, type PostedCutter } from './CutterList';

/** The machine's standard shank (the Z1's collets) — anything else states its shank. */
const STANDARD_SHANK_MM = 3.175;

/** One row of the checklist: a distinct cutter, its programs, and the shank it needs. */
export interface CutterChecklistRow extends PostedCutter {
  /** The shank diameter, mm, from the registry record; null when no record states it. */
  shankMm: number | null;
}

/** The rows: cam's list, plus each cutter's stated shank diameter. */
export function cutterChecklistRows(programs: readonly { toolKey: string }[]): CutterChecklistRow[] {
  return postedCuttersFor(programs).map((row) => {
    const tool = benchCutterFor(row.key);
    const shank = tool === null ? null : (tool.handleDiameter ?? null);
    return { ...row, shankMm: typeof shank === 'number' && Number.isFinite(shank) ? shank : null };
  });
}

/** Every row settled? The Cut step's gate reads this. */
export function cutterChecklistComplete(
  rows: readonly CutterChecklistRow[],
  entries: Record<string, CutterChecklistEntry> | undefined,
): boolean {
  // `settledCutterEntry` also finds the row through the replacement that stands in for it — the
  // checklist follows a replacement across the whole-run regenerate it asks for.
  return rows.every((row) => cutterSettled(settledCutterEntry(entries, row.key)));
}

/** The gate's sentence while rows are unresolved, in the operator's words; null when complete. */
export function missingCuttersWords(
  rows: readonly CutterChecklistRow[],
  entries: Record<string, CutterChecklistEntry> | undefined,
): string | null {
  if (rows.length === 0) return null;
  const missing = rows.filter((row) => !cutterSettled(settledCutterEntry(entries, row.key)));
  if (missing.length === 0) return null;
  const settled = rows.length - missing.length;
  return `${settled} of ${rows.length} cutters located — fit: ${missing.map((row) => row.name).join(', ')}`;
}

/** The replacement candidates: owned cutters of the SAME class (shape and cutting diameter). */
function replacementsFor(row: CutterChecklistRow): { key: string; name: string }[] {
  const source = benchCutterFor(row.key);
  if (source === null) return [];
  const diameter = source.diameter ?? source.tipDiameter ?? null;
  return getTools()
    .filter((entry) => entry.key.startsWith('inv:') && entry.key !== row.key)
    .filter((entry) => entry.tool.shape === source.shape)
    .filter((entry) => diameter === null || Math.abs((entry.tool.diameter ?? entry.tool.tipDiameter ?? 0) - diameter) <= 0.01)
    .map((entry) => ({ key: entry.key, name: toolDisplayName(entry.tool) }));
}

const ROW: React.CSSProperties = { display: 'grid', gridTemplateColumns: '56px 1fr auto auto auto', gap: 8, alignItems: 'center', fontSize: 12 };
const MUTED_ROW = { color: '#9aa4b0', fontSize: 11 } as const;

/**
 * The interactive rows. `onSet` writes one row's state on the job (via the store action); a
 * replacement ALSO asks the caller to re-generate the whole run — the caller shows the estimate
 * before the press. Rendering only; all writes go through `onSet`.
 */
export function CutterChecklist({
  rows,
  entries,
  onSet,
  disabled = false,
}: {
  rows: readonly CutterChecklistRow[];
  entries: Record<string, CutterChecklistEntry> | undefined;
  onSet: (key: string, entry: CutterChecklistEntry | null) => void;
  disabled?: boolean;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  const missing = missingCuttersWords(rows, entries);
  return (
    <div data-testid="engrave-cutter-checklist" style={{ display: 'grid', gap: 6 }}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 3 }}>
        {rows.map((row) => {
          const entry = settledCutterEntry(entries, row.key);
          const located = entry?.state === 'located';
          // The replacement, when this row is the one that was asked for; `replaced === row.key`
          // means the row IS the substitute after the regenerate (the entry stands in for it).
          const replaced = entry?.state === 'replaced' ? entry.replacedWith : undefined;
          const isTheSubstitute = replaced === row.key;
          const replacements = replacementsFor(row);
          const shankWords = row.shankMm !== null && Math.abs(row.shankMm - STANDARD_SHANK_MM) > 1e-6 ? `${row.shankMm} mm shank` : null;
          return (
            <li key={row.key} data-testid="engrave-cutter-row" style={ROW}>
              <span style={{ color: '#9aa4b0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>
                {row.programs.map((n) => `p${String(n).padStart(2, '0')}`).join(', ')}
              </span>
              <span>
                {row.name}
                {shankWords !== null && <span style={MUTED_ROW} data-testid={`engrave-cutter-shank-${row.key}`}> · {shankWords}</span>}
              </span>
              <label style={{ ...MUTED_ROW, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  data-testid={`engrave-cutter-locate-${row.key}`}
                  checked={located}
                  disabled={disabled}
                  onChange={(e) => onSet(row.key, e.target.checked ? { state: 'located', at: new Date().toISOString() } : null)}
                />
                located
              </label>
              <select
                data-testid={`engrave-cutter-replace-${row.key}`}
                value={isTheSubstitute ? '' : (replaced ?? '')}
                disabled={disabled || replacements.length === 0}
                onChange={(e) => {
                  const next = e.target.value;
                  onSet(row.key, next === '' ? null : { state: 'replaced', replacedWith: next, at: new Date().toISOString() });
                }}
                title={replacements.length === 0 ? 'No other owned cutter of this class' : 'Replace with another owned cutter'}
              >
                <option value="">replace…</option>
                {replacements.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              {replaced !== undefined && (
                <span style={MUTED_ROW} data-testid={`engrave-cutter-state-${row.key}`}>
                  {isTheSubstitute ? 'replaced' : `replaced: ${replacements.find((c) => c.key === replaced)?.name ?? replaced}`}
                </span>
              )}
              {located && (
                <span style={MUTED_ROW} data-testid={`engrave-cutter-state-${row.key}`}>
                  located
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {missing !== null && (
        <p style={{ ...MUTED_ROW, margin: 0 }} data-testid="engrave-cutter-missing">
          {missing}
        </p>
      )}
    </div>
  );
}
