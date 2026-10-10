/**
 * House → Tools (#311, tracking #212): every definition a job can name, grouped by tier.
 *
 * THE GROUPING IS THE FEATURE. One built-in is literally "1 mm flat end (assumed)" — a shipped
 * assumption — and the catalogue's 129 rows are Makera's, not the user's. In one flat list the only
 * thing separating an assumption from a cutter the user owns is a small tag; grouped with headings,
 * each row is read inside a statement about where it came from (`engine/cnc/toolTiers.ts`).
 *
 * THE ACTIONS ARE THE WRITES, AND THEY ALL END IN THE SAME SLOT. Register / Clone / Sync catalogue /
 * Export / Import go through `store/houseStore.ts`, which shows what the service said — its own
 * refusal sentence included — in one banner above the list. Nothing here decides a status; this is
 * the surface, and the store is the one place a write concludes.
 *
 * THE CATALOGUE GROUP IS CAPPED IN THE VIEW AND NOT IN THE DATA. 129 rows is more than a screen, so
 * the untouched list draws the first few and says how many it is not drawing — but the moment there
 * is a search or a tier chip the cap is off, because then the list is an answer to a question and
 * hiding part of it would be hiding the thing that was asked for.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  groupByTier,
  matchesSearch,
  tierCounts,
  tierNote,
  toolSearchText,
  TIER_HEADING,
  TIER_ORDER,
  TIER_TAG,
  type ToolTier,
} from '@/engine/cnc/toolTiers';
import { inventoryKey } from '@/engine/cnc/toolRegistry';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { InventoryItem } from '@/platform/houseClient';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { useHouseStore, useLastSync } from '@/store/houseStore';
import { useManageModeStore, type TierFilter } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { DocsModal } from '@/components/docs/DocsModal';
import { formatStamp, mm, NOT_APPLICABLE } from './display';
import { cloneOf, useSelectedEntry } from './selection';
import { ToolDetail } from './ToolDetail';

/** How many catalogue rows the untouched list draws before it says how many it is not drawing. */
const CATALOGUE_PREVIEW = 8;

const CHIPS: Array<{ id: TierFilter; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'owned', label: 'owned' },
  { id: 'yours', label: 'yours' },
  { id: 'catalogue', label: 'catalogue' },
  { id: 'builtin', label: 'built-in' },
];

/** A definition's own sentence about where it came from — what the row's second line shows. */
function provenanceLine(entry: ToolLibraryEntry, item: InventoryItem | null): ReactNode {
  if (item === null) return entry.provenance;
  const codes = item.codes.map((c) => (
    <span className="code" key={`${c.symbology}:${c.value}`}>
      <i>{c.symbology.toUpperCase()}</i>
      {c.value}
    </span>
  ));
  const notes = item.notes ?? null;
  if (notes === null && codes.length === 0) return 'registered here — no notes and no code';
  return (
    <>
      {notes}
      {notes !== null && codes.length > 0 ? ' · ' : null}
      {codes}
    </>
  );
}

export function ToolsScope() {
  const status = useToolRegistryStore((s) => s.status);
  const error = useToolRegistryStore((s) => s.error);
  const items = useToolRegistryStore((s) => s.items);
  const refresh = useToolRegistryStore((s) => s.refresh);
  const tools = useToolRegistry();

  const search = useManageModeStore((s) => s.search);
  const tier = useManageModeStore((s) => s.tier);
  const setSearch = useManageModeStore((s) => s.setSearch);
  const setTier = useManageModeStore((s) => s.setTier);
  const select = useManageModeStore((s) => s.select);
  const selectedKey = useManageModeStore((s) => s.selectedKey);
  const openRegister = useManageModeStore((s) => s.openRegister);

  const busy = useHouseStore((s) => s.busy);
  const notice = useHouseStore((s) => s.notice);
  /** The last sync — read here for its `notes` alone (#328); its counts are in the notice. */
  const lastSync = useLastSync();
  const dismissNotice = useHouseStore((s) => s.dismissNotice);
  const registerTool = useHouseStore((s) => s.registerTool);
  const syncCatalogue = useHouseStore((s) => s.syncCatalogue);
  const exportHouse = useHouseStore((s) => s.exportHouse);
  const importHouse = useHouseStore((s) => s.importHouse);

  const selected = useSelectedEntry();
  const [docsOpen, setDocsOpen] = useState(false);
  const importInput = useRef<HTMLInputElement | null>(null);

  /** The possession behind each `inv:` row — a different document, keyed by the same id. */
  const itemsByKey = useMemo(() => {
    const map = new Map<string, InventoryItem>();
    for (const item of items) map.set(inventoryKey(item.id), item);
    return map;
  }, [items]);

  // The tiers, then the filter. Both the counts line and the table read the same filtered list, so
  // what the line says and what is drawn underneath it cannot disagree.
  const counts = tierCounts(tools);
  const query = search.trim();
  const narrowing = query.length > 0 || tier !== 'all';
  const groups = useMemo(() => {
    const text = (e: ToolLibraryEntry) =>
      toolSearchText(
        e,
        (itemsByKey.get(e.key)?.codes ?? []).map((c) => c.value),
      );
    return groupByTier(tools)
      .filter((g) => tier === 'all' || g.tier === tier)
      .map((g) => ({
        ...g,
        entries: query.length === 0 ? g.entries : g.entries.filter((e) => matchesSearch(text(e), query)),
      }))
      .filter((g) => g.entries.length > 0);
  }, [tools, itemsByKey, tier, query]);

  const shown = groups.reduce((n, g) => n + g.entries.length, 0);

  const onClone = () => {
    if (selected === null) return;
    void registerTool(cloneOf(selected, new Date().toISOString()));
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // Verbatim, byte for byte: the service decides what a house file is, and it is the only
      // thing that can refuse it (`houseStore.importHouse`).
      await importHouse(await file.text());
    } finally {
      if (importInput.current) importInput.current.value = '';
    }
  };

  if (status === 'checking') {
    return (
      <>
        <section className="mmain" data-testid="manage-tools-checking">
          <p className="hint">Asking this origin for a house service…</p>
        </section>
        <BuiltInsAside />
      </>
    );
  }

  if (status !== 'present') {
    // G3: absent, not broken. The reason sentence is the probe's own, verbatim from the store — a
    // re-worded one would be a second opinion about why a socket did not answer.
    return (
      <>
        <section className="mmain">
          <div className="mhead">
            <div>
              <h3>Tools</h3>
              <p>Every cutter a job can name, and where each definition came from.</p>
            </div>
          </div>
          <div className="mempty" data-testid="manage-absent">
            <h4>No house service here</h4>
            <p>
              The house — your own cutters, the inventory and the Makera catalogue — lives in a
              small service the <b>desktop build</b> runs on the machine it is installed on. A page
              served from a web host has no such service, and it cannot reach one running on your
              computer either.
            </p>
            <div className="why" data-testid="manage-absent-reason">
              {error ?? 'nothing answered, and no reason was given'}
            </div>
            <p>
              Nothing is lost. The <b>two built-in cutters</b> are in every picker, and a job can be
              written, verified and simulated with them.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                data-testid="manage-check-again"
                onClick={() => void refresh()}
              >
                Check again
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                data-testid="manage-what-desktop-adds"
                onClick={() => setDocsOpen(true)}
              >
                What the desktop build adds →
              </button>
            </div>
          </div>
          {docsOpen && <DocsModal initialId="cnc-guide" onClose={() => setDocsOpen(false)} />}
        </section>
        <BuiltInsAside />
      </>
    );
  }

  const actionsDisabled = busy !== null;

  return (
    <>
      <section className="mmain">
        <div className="mhead">
          <div>
            <h3>Tools</h3>
            <p>
              Every cutter a job can name, and where each definition came from. Makera’s rows are
              read-only — clone one to rename it or to record what you measured. The built-ins are
              always here, service or not.
            </p>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="manage-register-open"
              title="Register a physical cutter — scan its box, find it in the catalogue, or type it"
              onClick={openRegister}
            >
              ＋ Register ▾
            </button>
            <button
              type="button"
              className="btn"
              data-testid="manage-clone"
              disabled={selected === null || actionsDisabled}
              title={
                selected === null
                  ? 'Pick a row first'
                  : 'Copy this definition into your own tier, to rename it or to record what you measured'
              }
              onClick={onClone}
            >
              Clone
            </button>
            <button
              type="button"
              className="btn"
              data-testid="manage-sync"
              disabled={actionsDisabled}
              title="Re-read Makera Studio’s own library on this PC into the catalogue tier"
              onClick={() => void syncCatalogue()}
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync catalogue'}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="manage-export"
              disabled={actionsDisabled}
              title="Save the house — your definitions and the inventory — as one JSON file"
              onClick={() => void exportHouse()}
            >
              {busy === 'export' ? 'Saving…' : 'Export'}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="manage-import"
              disabled={actionsDisabled}
              title="Load a house file over the service’s own"
              onClick={() => importInput.current?.click()}
            >
              {busy === 'import' ? 'Loading…' : 'Import'}
            </button>
            <input
              ref={importInput}
              type="file"
              accept=".json,application/json"
              data-testid="manage-import-input"
              style={{ display: 'none' }}
              onChange={(e) => {
                void onImportFile(e);
              }}
            />
          </div>
        </div>

        {notice !== null && (
          <div
            className={`mnotice mnotice--${notice.kind}`}
            data-testid="manage-notice"
            data-kind={notice.kind}
          >
            <span>{notice.text}</span>
            <button type="button" data-testid="manage-notice-dismiss" onClick={dismissNotice}>
              ×
            </button>
          </div>
        )}

        {/* #328 — the sync's own NOTES, which the notice's counts sentence never carried. A sync that
            succeeded can still have replaced a catalogue file it could not read, dropped feed rows
            whose cells Studio left empty, or emptied the feed matrix; all three used to look exactly
            like a clean sync. Deliberately NOT part of the notice: dismissing that must not take the
            record of what the sync did with it, and these stay until the next sync replaces them.
            Each note carries its weight (decision 1): a LOSS is drawn in the warning colour, an
            `info` plain. And they outlive a reload (decision 2): the service keeps the last report
            on `/health`, so a record read from there is drawn too, dated, before any sync here. */}
        {lastSync !== null && lastSync.summary.notes.length > 0 && (
          <div
            className="mnotes"
            data-testid="manage-sync-notes"
            data-count={lastSync.summary.notes.length}
            data-from={lastSync.fromHealth ? 'health' : 'session'}
          >
            <p className="mnotes__head">
              {lastSync.fromHealth
                ? `The last sync (${formatStamp(lastSync.summary.syncedAt) ?? 'date unknown'}) reported:`
                : 'Besides the counts, that sync reported:'}
            </p>
            <ul>
              {lastSync.summary.notes.map((note, i) => (
                <li key={`${i}-${note.text}`} data-kind={note.kind} data-testid={`manage-sync-note-${i}`}>
                  {note.text}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mfilter">
          <input
            className="fld fld--text"
            type="text"
            placeholder="Search name, code or size…"
            aria-label="Search the tool list"
            data-testid="manage-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chip${tier === c.id ? ' chip--on' : ''}`}
              data-testid={`manage-chip-${c.id}`}
              aria-pressed={tier === c.id}
              onClick={() => setTier(c.id)}
            >
              {c.label}
            </button>
          ))}
          <span className="mcount" data-testid="manage-counts">
            {tools.length} definition{tools.length === 1 ? '' : 's'}
            {TIER_ORDER.map((t) => ` · ${counts[t]} ${TIER_TAG[t]}`).join('')}
            {narrowing ? ` · showing ${shown}` : ''}
          </span>
        </div>

        <div className="mscroll">
          <table className="tbl" data-testid="manage-tools-table">
            <thead>
              <tr>
                <th style={{ width: '34%' }}>Name</th>
                <th>Shape</th>
                <th className="num">Tip ⌀</th>
                <th className="num">Shank</th>
                <th className="num">Flute</th>
                <th className="num">Shoulder</th>
                <th className="num">Stick-out</th>
                <th className="num">Qty</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                // Only the untouched catalogue group is capped: see the module doc.
                const capped =
                  g.tier === 'catalogue' && !narrowing && g.entries.length > CATALOGUE_PREVIEW;
                const drawn = capped ? g.entries.slice(0, CATALOGUE_PREVIEW) : g.entries;
                return (
                  <Rows
                    key={g.tier}
                    tier={g.tier}
                    count={g.entries.length}
                    entries={drawn}
                    item={itemsByKey}
                    selectedKey={selectedKey}
                    onSelect={select}
                    more={capped ? g.entries.length - drawn.length : 0}
                  />
                );
              })}
              {groups.length === 0 && (
                <tr className="more">
                  <td colSpan={9} data-testid="manage-no-matches">
                    nothing matches “{query}”
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {docsOpen && <DocsModal initialId="cnc-guide" onClose={() => setDocsOpen(false)} />}
      </section>
      <ToolDetail />
    </>
  );
}

/** One tier: its heading row, its rows, and (for the capped catalogue) the line saying so. */
function Rows({
  tier,
  count,
  entries,
  item,
  selectedKey,
  onSelect,
  more,
}: {
  tier: ToolTier;
  count: number;
  entries: readonly ToolLibraryEntry[];
  item: Map<string, InventoryItem>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  more: number;
}) {
  return (
    <>
      <tr className="grp" data-testid={`manage-group-${tier}`}>
        <td colSpan={9}>
          {TIER_HEADING[tier]} <small>{tierNote(tier, count)}</small>
        </td>
      </tr>
      {entries.map((entry) => {
        const possession = item.get(entry.key) ?? null;
        const t = entry.tool;
        const tip = t.tipDiameter ?? t.diameter;
        const dim = (v: number | null) => (v === null ? 'num dim' : 'num');
        return (
          <tr
            key={entry.key}
            className={selectedKey === entry.key ? 'sel' : undefined}
            data-testid={`manage-tools-row-${entry.key}`}
            onClick={() => onSelect(entry.key)}
          >
            {/* The name is a BUTTON (#340): the row's click is a convenience for the mouse, and a
                `<tr onClick>` is reachable by nothing else. The button puts every row in the tab
                order and gives Enter and Space the same meaning as the click, which is what makes
                the detail rail, Clone and the editors reachable from the keyboard at all. */}
            <td className="nm">
              <button
                type="button"
                className="tbl__rowbtn"
                data-testid={`manage-tools-pick-${entry.key}`}
                aria-current={selectedKey === entry.key ? 'true' : undefined}
                onClick={() => onSelect(entry.key)}
              >
                {t.name}
                <small>{provenanceLine(entry, possession)}</small>
              </button>
            </td>
            <td>{t.shape}</td>
            <td className={dim(tip)}>{mm(tip)}</td>
            <td className={dim(t.handleDiameter)}>{mm(t.handleDiameter)}</td>
            <td className={dim(t.fluteLength)}>{mm(t.fluteLength)}</td>
            <td className={dim(t.shoulderLength)}>{mm(t.shoulderLength)}</td>
            <td className={dim(t.stickout)}>{mm(t.stickout)}</td>
            <td className={possession === null ? 'num dim' : 'num'}>
              {possession === null ? NOT_APPLICABLE : possession.quantity}
            </td>
            <td>
              <span className={`tag tag--${tier}`}>{TIER_TAG[tier]}</span>
            </td>
          </tr>
        );
      })}
      {more > 0 && (
        <tr className="more">
          <td colSpan={9} data-testid={`manage-more-${tier}`}>
            … {more} more catalogue {more === 1 ? 'row' : 'rows'} — search or scroll
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The rail beside an absent service (G3): the two definitions that need no service at all, so the
 * one sentence the pane says most loudly — nothing is lost — is immediately checkable. One of them
 * is a shipped assumption, and it says so; the alternative is a user reading "built-in" as "the
 * cutter this job will actually use".
 */
function BuiltInsAside() {
  return (
    <aside className="context-panel" data-testid="manage-builtins-aside">
      <div className="empty">
        <h3>Built-in</h3>
        <p>The two definitions that need no service. Read-only; one is literally an assumption.</p>
      </div>
      <table className="tbl">
        <tbody>
          {TOOL_LIBRARY.map((entry) => (
            <tr key={entry.key}>
              <td className="nm">
                {entry.tool.name}
                <small>{entry.key === 'flat-1.0' ? 'no lengths stated' : entry.provenance}</small>
              </td>
              <td>
                <span className="tag tag--builtin">built-in</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}
