/**
 * Manage › Tools › Feeds (#450 slice 6): the location's feeds table, listed in the Tools pane and
 * edited in its right rail.
 *
 * INSIDE TOOLS, BECAUSE A FEED IS PER CUTTER. The issue's placement decision (#450 comment,
 * 2026-10-16) is explicit: "feeds are per cutter and material, and the cutter is where you reach
 * them." So this is not a Manage scope of its own; it is a pane beside the cutter list, and the
 * right rail that shows a cutter's definition shows a feed row's editor instead while this pane is
 * active.
 *
 * THE SHAPE IS THE STOCK SHELF'S (#413, `MaterialsScope.tsx`): a list in the main pane, the selected
 * row (or a new one) in the right rail as an editable form, every write through the one store
 * (`feedTableStore`), which re-reads after a save and shows the service's own refusal sentence.
 *
 * PROVENANCE IS THE ROW, NOT A COMMENT. A seeded row is a starting value this app wrote; a chosen
 * row is one a person set; a measured row is one this shop's equipment settled. The source is drawn
 * on every row. A person typing numbers cannot leave a row claiming `seeded`: a new row starts
 * chosen, and changing any number on a seeded row turns it into a chosen row stamped with the time
 * (`setAt`), which is the same rule a `ShopDefault` carries — the Rust (`feeds.rs`) and Zod halves
 * both require a date on anything that is not seeded, and this form supplies it rather than letting
 * a hand-typed row lie about where it came from.
 *
 * TWO REFUSALS, BOTH SHOWN. The single-row schema (`FeedRowSchema`) and the cross-row rule
 * (`FeedsTableSchema` — two rows for one material and edge may touch but not overlap, because
 * `entryFor` takes the first match) are checked here before a write leaves the window, and the
 * offending field is marked. A refusal the service still makes (a race, a rule this window could
 * not see) arrives in the notice above the list, verbatim. Save never pretends: it stays open on a
 * failure, and the row keeps the values that were typed.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ZodError } from 'zod';
import { MATERIAL_LABELS, STOCK_MATERIALS } from '@/engine/cnc/materials';
import {
  FEED_EDGES,
  FEED_SOURCES,
  FeedRowSchema,
  FeedsTableSchema,
  effectiveEdge,
  type FeedEdge,
  type FeedRow,
  type FeedSource,
} from '@/platform/feedClient';
import { newFeedId, useFeedTableStore } from '@/store/feedTableStore';
import { formatStamp, mm } from './display';

/** What a source word means, for the row tag's tooltip and the editor's select. */
const SOURCE_TITLE: Record<FeedSource, string> = {
  seeded: 'the app’s own starting value — nobody measured it',
  chosen: 'a number a person set',
  measured: 'a number this shop’s own equipment settled',
};

/** How one row is described in the table: material and edge and the inclusive band it answers for. */
function bandLine(row: Pick<FeedRow, 'minDiameter' | 'maxDiameter'>): string {
  return `${mm(row.minDiameter)}–${mm(row.maxDiameter)}`;
}

/** A number column's text: fractions keep their places; a whole number stays whole. */
function count(value: number): string {
  return String(value);
}

/** The editor's working copy: text for every number, so a half-typed value is not a refusal. */
interface FeedDraft {
  material: FeedRow['material'];
  edge: FeedEdge;
  minDiameter: string;
  maxDiameter: string;
  rpm: string;
  feed: string;
  plungeFeed: string;
  stepDown: string;
  stepOverFraction: string;
  peckFraction: string;
  air: boolean;
  source: FeedSource;
  note: string;
  provenance: string;
}

function draftOf(row: FeedRow | null): FeedDraft {
  if (row === null) {
    return {
      material: 'pla',
      edge: 'flat',
      minDiameter: '',
      maxDiameter: '',
      rpm: '',
      feed: '',
      plungeFeed: '',
      stepDown: '',
      stepOverFraction: '',
      peckFraction: '',
      air: true,
      source: 'chosen',
      note: '',
      provenance: '',
    };
  }
  return {
    material: row.material,
    edge: effectiveEdge(row),
    minDiameter: String(row.minDiameter),
    maxDiameter: String(row.maxDiameter),
    rpm: String(row.params.rpm),
    feed: String(row.params.feed),
    plungeFeed: String(row.params.plungeFeed),
    stepDown: String(row.params.stepDown),
    stepOverFraction: String(row.params.stepOverFraction),
    peckFraction: String(row.params.peckFraction),
    air: row.params.air,
    source: row.source,
    note: row.note ?? '',
    provenance: row.provenance,
  };
}

/** A typed number, or NaN for one that is not — which the schema then names. */
function num(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/**
 * The NUMBERS a row claims, plus what they apply to. `note`, `provenance`, `source` and `setAt` are
 * not here: editing a sentence does not turn a seeded value into a chosen one, but moving a number
 * (or pointing it at another material, edge or band) does.
 */
function claimOf(row: FeedRow): string {
  return JSON.stringify({
    material: row.material,
    edge: effectiveEdge(row),
    minDiameter: row.minDiameter,
    maxDiameter: row.maxDiameter,
    params: row.params,
  });
}

function claimChanged(before: FeedRow, after: FeedRow): boolean {
  return claimOf(before) !== claimOf(after);
}

/**
 * The row a draft describes. Identity comes from the row being edited; the numbers, the words and
 * the source come from the draft. A `seeded` claim is only kept while the numbers are still the
 * seeded row's own — a new row is never seeded, and a moved number becomes `chosen` with `setAt`.
 */
function rowFromDraft(
  draft: FeedDraft,
  base: FeedRow | null,
  id: string,
  at: string,
): FeedRow {
  const row: FeedRow = {
    id: base?.id ?? id,
    material: draft.material,
    // The wire treats an absent edge as flat; the editor's `flat` is written as absence, which is
    // how every row before #405 is stored.
    edge: draft.edge === 'flat' ? null : 'v',
    minDiameter: num(draft.minDiameter),
    maxDiameter: num(draft.maxDiameter),
    params: {
      rpm: num(draft.rpm),
      feed: num(draft.feed),
      plungeFeed: num(draft.plungeFeed),
      stepDown: num(draft.stepDown),
      stepOverFraction: num(draft.stepOverFraction),
      peckFraction: num(draft.peckFraction),
      air: draft.air,
    },
    source: draft.source,
    setAt: null,
    note: draft.note.trim() === '' ? null : draft.note.trim(),
    provenance: draft.provenance.trim(),
  };

  const moved = base !== null && claimChanged(base, row);
  if (row.source === 'seeded') {
    // The app writes a seeded row; a person typing numbers does not. A new row, or one whose
    // numbers moved, is chosen, and says when it was chosen.
    if (base === null || moved) {
      row.source = 'chosen';
      row.setAt = at;
    }
  } else {
    const kept = moved || base === null || base.source !== row.source ? at : base.setAt;
    row.setAt = kept !== null && kept.trim() !== '' ? kept : at;
  }
  return row;
}

interface FeedProblem {
  message: string;
  field: string | null;
}

/** The first issue of a schema error, with the field it names (when it names one). */
function problemFrom(error: ZodError): FeedProblem {
  const issue = error.issues[0]!;
  const path = issue.path.filter((part): part is string => typeof part === 'string');
  return {
    message: issue.message,
    field: path.length > 0 ? (path[path.length - 1] ?? null) : null,
  };
}

/** Why a row would be refused, in the schema's own words — the row rule, then the table rule. */
function problemOf(row: FeedRow, others: readonly FeedRow[]): FeedProblem | null {
  const single = FeedRowSchema.safeParse(row);
  if (!single.success) return problemFrom(single.error);
  // The candidate goes LAST so any cross-row issue's path names the row being edited.
  const table = FeedsTableSchema.safeParse([...others, row]);
  if (!table.success) return problemFrom(table.error);
  return null;
}

/** The list in the Tools pane: rows, provenance, refusals and the last write's sentence. */
export function FeedsPane({ openId, onOpen }: { openId: string | null; onOpen: (id: string) => void }) {
  const status = useFeedTableStore((s) => s.status);
  const rows = useFeedTableStore((s) => s.rows);
  const unreadable = useFeedTableStore((s) => s.unreadable);
  const reason = useFeedTableStore((s) => s.reason);
  const notice = useFeedTableStore((s) => s.notice);
  const dismissNotice = useFeedTableStore((s) => s.dismissNotice);
  const refresh = useFeedTableStore((s) => s.refresh);

  // The pane is mounted only while it is the visible one, so opening it is the read. A remount
  // keeps the rows already held and re-reads in the background.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (status === 'unknown') {
    return (
      <div className="mscroll" data-testid="manage-feeds-pane">
        <p className="hint" data-testid="manage-feeds-loading">
          Reading the feeds table…
        </p>
      </div>
    );
  }

  if (status === 'absent' || status === 'error') {
    return (
      <div className="mscroll" data-testid="manage-feeds-pane">
        <div className="mempty" data-testid="manage-feeds-absent">
          <h4>{status === 'absent' ? 'This house service has no feeds table' : 'The feeds table could not be read'}</h4>
          <p>
            {status === 'absent'
              ? 'This service predates the table (#450). Jobs still cut with the compiled starting table, every row labelled unmeasured.'
              : 'The service answered, but its feeds table could not be used. Jobs fall back to the compiled starting table until it can be read.'}
          </p>
          {reason !== null && <div className="why">{reason}</div>}
          <div className="btn-row">
            <button type="button" className="btn" data-testid="manage-feeds-retry" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.source] += 1;
      return acc;
    },
    { seeded: 0, chosen: 0, measured: 0 } as Record<FeedSource, number>,
  );

  return (
    <div className="mscroll" data-testid="manage-feeds-pane">
      {notice !== null && (
        <div
          className={`mnotice mnotice--${notice.kind}`}
          data-testid="manage-feeds-notice"
          data-kind={notice.kind}
        >
          <span>{notice.text}</span>
          <button type="button" data-testid="manage-feeds-notice-dismiss" onClick={dismissNotice}>
            ×
          </button>
        </div>
      )}

      {unreadable.map((u, i) => (
        <p key={u.id ?? i} className="hint" data-testid="manage-feeds-unreadable" data-status="error">
          Row {u.id ?? '(no id)'} is in the table but this build cannot read it: {u.reason}. It is left as it
          is.
        </p>
      ))}

      <p className="hint" data-testid="manage-feeds-counts">
        {rows.length} row{rows.length === 1 ? '' : 's'} · {counts.seeded} seeded · {counts.chosen} chosen ·{' '}
        {counts.measured} measured
      </p>

      {rows.length === 0 ? (
        <div className="mempty" data-testid="manage-feeds-empty">
          <h4>The table is empty</h4>
          <p>
            Jobs fall back to the compiled starting table — every row labelled unmeasured — until a
            row is added here.
          </p>
        </div>
      ) : (
        <table className="tbl" data-testid="manage-feeds-table">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>Material</th>
              <th>Edge</th>
              <th className="num">⌀ band</th>
              <th className="num">rpm</th>
              <th className="num">feed</th>
              <th className="num">plunge</th>
              <th className="num">step ↓</th>
              <th className="num">step over</th>
              <th className="num">peck</th>
              <th className="num">air</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const edge = effectiveEdge(row);
              return (
                <tr
                  key={row.id}
                  className={openId === row.id ? 'sel' : undefined}
                  data-testid={`manage-feeds-row-${row.id}`}
                  onClick={() => onOpen(row.id)}
                >
                  <td className="nm">
                    <button
                      type="button"
                      className="tbl__rowbtn"
                      data-testid={`manage-feeds-pick-${row.id}`}
                      aria-current={openId === row.id ? 'true' : undefined}
                      onClick={() => onOpen(row.id)}
                    >
                      {MATERIAL_LABELS[row.material]}
                      <small>{row.provenance}</small>
                    </button>
                  </td>
                  <td>{edge}</td>
                  <td className="num">{bandLine(row)}</td>
                  <td className="num">{count(row.params.rpm)}</td>
                  <td className="num">{count(row.params.feed)}</td>
                  <td className="num">{count(row.params.plungeFeed)}</td>
                  <td className="num">{mm(row.params.stepDown)}</td>
                  <td className="num">{row.params.stepOverFraction.toFixed(2)}</td>
                  <td className="num">{row.params.peckFraction.toFixed(2)}</td>
                  <td className="num">{row.params.air ? 'on' : 'off'}</td>
                  <td>
                    <span
                      className="tag"
                      data-source={row.source}
                      data-testid={`manage-feeds-source-${row.id}`}
                      title={`${SOURCE_TITLE[row.source]}${row.setAt === null ? '' : ` — set ${formatStamp(row.setAt)}`}`}
                    >
                      {row.source}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** One numeric box in the editor, marked when the schema names it. */
function NumField({
  label,
  testid,
  value,
  field,
  problem,
  onChange,
}: {
  label: string;
  testid: string;
  value: string;
  field: string;
  problem: FeedProblem | null;
  onChange: (value: string) => void;
}) {
  const bad = problem?.field === field;
  return (
    <label className="lf">
      <span>{label}</span>
      <input
        className="fld fld--num"
        type="number"
        min={0}
        step="any"
        value={value}
        data-testid={testid}
        data-status={bad ? 'error' : undefined}
        aria-invalid={bad || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** The right rail for the feeds pane: a row's editor, or the add form. */
export function FeedEditor({
  item,
  onClose,
  onSaved,
}: {
  item: FeedRow | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const rows = useFeedTableStore((s) => s.rows);
  const busy = useFeedTableStore((s) => s.busy);
  const add = useFeedTableStore((s) => s.add);
  const replace = useFeedTableStore((s) => s.replace);
  const remove = useFeedTableStore((s) => s.remove);

  const [draft, setDraft] = useState<FeedDraft>(() => draftOf(item));
  // The row as it was when this draft was filled from it, as `MaterialsScope` does (#413 review):
  // a write from another window changes the row under an open form, and an untouched draft is
  // refilled while a touched one is refused until the user reloads it.
  const [seed, setSeed] = useState<FeedRow | null>(item);
  const [mintedId] = useState(() => (item === null ? newFeedId() : item.id));
  const [sessionAt] = useState(() => new Date().toISOString());

  const stale = item !== null && seed !== null && JSON.stringify(item) !== JSON.stringify(seed);
  const touched = JSON.stringify(draft) !== JSON.stringify(draftOf(seed));
  if (stale && !touched) {
    setDraft(draftOf(item));
    setSeed(item);
  }
  const reload = () => {
    setDraft(draftOf(item));
    setSeed(item);
  };

  const candidate = useMemo(
    () => rowFromDraft(draft, seed, mintedId, sessionAt),
    [draft, seed, mintedId, sessionAt],
  );
  const others = useMemo(() => rows.filter((r) => r.id !== seed?.id), [rows, seed?.id]);
  const problem = stale
    ? { message: 'this row changed since you opened it — load the current one before saving', field: null }
    : problemOf(candidate, others);
  const numbersMoved = seed !== null && claimChanged(seed, candidate);
  // The honesty warning: a seeded row whose numbers moved is saved as chosen, and its old
  // provenance sentence was about the seeded numbers. Say so; the user can rewrite it here.
  const demoted = seed !== null && seed.source === 'seeded' && numbersMoved;
  const demotedProvenanceUnchanged = demoted && seed !== null && draft.provenance === seed.provenance;

  const patch = (p: Partial<FeedDraft>) =>
    setDraft((d) => {
      const next = { ...d, ...p };
      // A seeded claim is only kept while the numbers are still the seeded row's own. Flip the
      // visible source as soon as a number moves, rather than saving a lie and correcting it after.
      if (next.source === 'seeded') {
        const row = rowFromDraft(next, seed, mintedId, sessionAt);
        if (row.source !== 'seeded') next.source = 'chosen';
      }
      return next;
    });

  const save = async () => {
    if (stale) return;
    // The date is the SAVE's, not the moment the form opened: `setAt` says when these numbers were
    // set, and this is the act that sets them.
    const row = rowFromDraft(draft, seed, mintedId, new Date().toISOString());
    if (problemOf(row, others) !== null) return;
    const ok = item === null ? await add(row) : await replace(row);
    if (!ok) return;
    const saved = useFeedTableStore.getState().rows.find((r) => r.id === row.id) ?? row;
    setSeed(saved);
    setDraft(draftOf(saved));
    onSaved(row.id);
  };

  const band = `${draft.minDiameter.trim() || '?'}–${draft.maxDiameter.trim() || '?'}`;

  return (
    <aside className="context-panel" data-testid="manage-feed-detail">
      <div className="panel-head">
        <h3>
          {item === null ? 'Add a feed row' : `${MATERIAL_LABELS[draft.material]} ${draft.edge} · ${band} mm`}
        </h3>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="grid2">
        <label className="lf">
          <span>material</span>
          <select
            className="fld"
            value={draft.material}
            data-testid="manage-feed-material"
            data-status={problem?.field === 'material' ? 'error' : undefined}
            onChange={(e) => patch({ material: e.target.value as FeedRow['material'] })}
          >
            {STOCK_MATERIALS.map((m) => (
              <option key={m} value={m}>
                {MATERIAL_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="lf">
          <span>cutter edge</span>
          <select
            className="fld"
            value={draft.edge}
            data-testid="manage-feed-edge"
            data-status={problem?.field === 'edge' ? 'error' : undefined}
            onChange={(e) => patch({ edge: e.target.value as FeedEdge })}
          >
            {FEED_EDGES.map((e) => (
              <option key={e} value={e}>
                {e === 'flat' ? 'flat end mill' : 'V-bit cone'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="panel-subhead">Diameter band, mm — inclusive at both ends</div>
      <div className="grid2">
        <NumField
          label="from"
          testid="manage-feed-min"
          value={draft.minDiameter}
          field="minDiameter"
          problem={problem}
          onChange={(minDiameter) => patch({ minDiameter })}
        />
        <NumField
          label="to"
          testid="manage-feed-max"
          value={draft.maxDiameter}
          field="maxDiameter"
          problem={problem}
          onChange={(maxDiameter) => patch({ maxDiameter })}
        />
      </div>

      <div className="panel-subhead">Cutting parameters</div>
      <div className="grid2">
        <NumField
          label="rpm"
          testid="manage-feed-param-rpm"
          value={draft.rpm}
          field="rpm"
          problem={problem}
          onChange={(rpm) => patch({ rpm })}
        />
        <NumField
          label="feed, mm/min"
          testid="manage-feed-param-feed"
          value={draft.feed}
          field="feed"
          problem={problem}
          onChange={(feed) => patch({ feed })}
        />
        <NumField
          label="plunge, mm/min"
          testid="manage-feed-param-plunge"
          value={draft.plungeFeed}
          field="plungeFeed"
          problem={problem}
          onChange={(plungeFeed) => patch({ plungeFeed })}
        />
        <NumField
          label="step-down, mm"
          testid="manage-feed-param-stepdown"
          value={draft.stepDown}
          field="stepDown"
          problem={problem}
          onChange={(stepDown) => patch({ stepDown })}
        />
        <NumField
          label="step-over, × ⌀"
          testid="manage-feed-param-stepover"
          value={draft.stepOverFraction}
          field="stepOverFraction"
          problem={problem}
          onChange={(stepOverFraction) => patch({ stepOverFraction })}
        />
        <NumField
          label="peck, × ⌀"
          testid="manage-feed-param-peck"
          value={draft.peckFraction}
          field="peckFraction"
          problem={problem}
          onChange={(peckFraction) => patch({ peckFraction })}
        />
        <label className="lf">
          <span>air</span>
          <input
            type="checkbox"
            checked={draft.air}
            data-testid="manage-feed-param-air"
            onChange={(e) => patch({ air: e.target.checked })}
          />
        </label>
      </div>

      <div className="panel-subhead">Where the numbers came from</div>
      <label className="lf">
        <span>
          source <em>seeded = the app wrote it</em>
        </span>
        <select
          className="fld"
          value={draft.source}
          data-testid="manage-feed-source"
          data-status={problem?.field === 'source' ? 'error' : undefined}
          onChange={(e) => patch({ source: e.target.value as FeedSource })}
        >
          {FEED_SOURCES.map((s) => (
            <option key={s} value={s} disabled={s === 'seeded' && seed === null} title={SOURCE_TITLE[s]}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <p className="hint" data-testid="manage-feed-setat">
        {candidate.source === 'seeded'
          ? 'No date: seeded means the app wrote these numbers; nobody measured them.'
          : `Set ${formatStamp(candidate.setAt) ?? 'just now'}. A number changed here re-dates the row.`}
      </p>
      <p className="hint" data-testid="manage-feed-provenance-rule">
        Change a number on a seeded row and it is saved as <b>chosen</b>, dated today — a hand-typed
        row never keeps a <b>seeded</b> claim.
      </p>

      <label className="lf">
        <span>
          provenance <em>required — where these numbers came from</em>
        </span>
        <input
          className="fld fld--text"
          type="text"
          value={draft.provenance}
          placeholder="ran this band on the bench on 2026-10-17, chip cleared…"
          data-testid="manage-feed-provenance"
          data-status={problem?.field === 'provenance' ? 'error' : undefined}
          aria-invalid={problem?.field === 'provenance' || undefined}
          onChange={(e) => patch({ provenance: e.target.value })}
        />
      </label>
      <label className="lf">
        <span>
          note <em>optional</em>
        </span>
        <input
          className="fld fld--text"
          type="text"
          value={draft.note}
          placeholder="a sentence about this row"
          data-testid="manage-feed-note"
          data-status={problem?.field === 'note' ? 'error' : undefined}
          onChange={(e) => patch({ note: e.target.value })}
        />
      </label>

      {demotedProvenanceUnchanged && (
        <p className="hint" data-testid="manage-feed-demoted">
          These numbers are no longer the starting values, so the row saves as <b>chosen</b>, dated
          today. The sentence above still says where the starting values came from — update it if it
          no longer fits.
        </p>
      )}

      {problem !== null && (
        <p
          className="hint"
          data-testid="manage-feed-problem"
          data-status="error"
          data-field={problem.field ?? undefined}
        >
          {problem.field !== null && <b>{problem.field}</b>}
          {problem.field !== null ? ': ' : ''}
          {problem.message}
        </p>
      )}

      {stale && (
        <div className="btn-row">
          <button type="button" className="btn btn--sm" data-testid="manage-feed-reload" onClick={reload}>
            Load the current row
          </button>
        </div>
      )}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="manage-feed-save"
          disabled={problem !== null || busy}
          onClick={() => void save()}
        >
          {item === null ? 'Add to the table' : 'Save'}
        </button>
        <span className="spacer" />
        {item !== null && (
          <button
            type="button"
            className="btn btn--sm btn--danger"
            data-testid="manage-feed-remove"
            disabled={busy}
            title="Take this row out of the location’s feeds table"
            onClick={() => void remove(item.id).then((ok) => ok && onClose())}
          >
            Remove
          </button>
        )}
      </div>
    </aside>
  );
}
