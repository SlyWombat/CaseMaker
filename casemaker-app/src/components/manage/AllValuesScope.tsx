/**
 * #1207 — MANAGE › ADVANCED › ALL VALUES. Every shop default, generated from the registry.
 *
 * The page is a view OF THE REGISTRY, never a hand-built list: `KNOWN_DEFAULTS` supplies the key,
 * its meaning, its unit, its bounds and its recommendation, and `MEASURED_ONLY` the keys that only
 * mean something once they are measured. The shop's own copy comes from `useShopDefaultsStore`,
 * which writes one key at a time through the house service and re-reads; a refusal is shown in the
 * service's own words.
 *
 * THE CHIPS MARK EXCEPTIONS ONLY. A row is plain unless it is CHANGED from its recommendation or
 * MEASURED on this machine — "chosen, not measured" is the registry's normal state, not a badge.
 * The label leads and the key follows, so an operator reads what the value does before its name.
 * Each area heading carries its own count of changed values; there is no second filter.
 *
 * THE DETAIL SAYS WHAT THE VALUE DECIDES (not where it came from), and the record it names is
 * "this shop's record". A measured value may be replaced here by hand, with its provenance — the
 * record then says "entered by hand" — and it has no reset, because the way back is to measure
 * again (the detail links to the measuring procedure).
 *
 * FOUR STATES, EACH DRAWN: an empty search, a value just saved, a save the house service refuses,
 * and a shop with no record to edit (read-only, showing the recommendations). On a phone the row
 * opens in place; on the desktop the detail sits in its own pane.
 */
import { useMemo, useState } from 'react';
import { z } from 'zod';
import {
  KNOWN_DEFAULTS,
  KNOWN_FLAGS,
  MEASURED_ONLY,
  type KnownDefault,
  type ShopDefaults,
} from '@/platform/defaultsClient';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { NARROW_QUERY } from '@/components/welcome/wizardLayout';
import { DocsModal } from '@/components/docs/DocsModal';
import { timeOfDayWords } from './display';

type Area =
  | 'Registration'
  | 'Probing'
  | 'Planning'
  | 'Tabs'
  | 'Safety'
  | 'Timing'
  | 'Simulation'
  | 'UI'
  | 'Other'
  | 'Measured only';

const AREAS: Area[] = [
  'Registration',
  'Probing',
  'Planning',
  'Tabs',
  'Safety',
  'Timing',
  'Simulation',
  'UI',
  'Other',
  'Measured only',
];

const AREA_BLURB: Record<Area, string> = {
  Registration: 'How the datum is measured and trusted on this machine.',
  Probing: 'The probe unit, its fittings, and the footprints the safe-Z guard allows.',
  Planning: 'What the planner chooses, and what it says the plan costs.',
  Tabs: 'The holding tabs a cut-out leaves.',
  Safety: 'The floors and keep-outs no value may cross.',
  Timing: 'The clock the estimate and the run report use.',
  Simulation: 'The grids, speeds and limits the sweep runs on.',
  UI: 'What the screens keep, show and count.',
  Other: 'Registry entries whose area is not classified yet.',
  'Measured only': 'Values that mean something only once they are measured on this machine.',
};

/** Which area a registry key belongs to. The page's one mapping, so a key cannot fall between two. */
function areaOf(key: string): Area {
  if (
    key.startsWith('rotary.') ||
    key.startsWith('clean.') ||
    key.startsWith('wasteboard.') ||
    key.startsWith('margins.') ||
    key.startsWith('registration.guarded') ||
    key.startsWith('registration.mountTap')
  ) {
    return 'Safety';
  }
  if (
    key.startsWith('probe.') ||
    key.startsWith('registration.probe') ||
    key.startsWith('registration.cutter') ||
    key.startsWith('registration.tip') ||
    key.startsWith('registration.faceAngle') ||
    key.startsWith('registration.surface') ||
    key.startsWith('registration.scan') ||
    key.startsWith('registration.coarse') ||
    key.startsWith('registration.fine') ||
    key.startsWith('registration.park') ||
    key.startsWith('registration.cap') ||
    key.startsWith('registration.touchFeed') ||
    key.startsWith('registration.idle') ||
    key.startsWith('registration.reading') ||
    key.startsWith('registration.*Residual')
  ) {
    return 'Probing';
  }
  if (key.startsWith('registration.')) return 'Registration';
  if (key.startsWith('tabs.')) return 'Tabs';
  if (
    key.startsWith('run.') ||
    key.startsWith('stop.') ||
    key.startsWith('power.') ||
    key.startsWith('console.') ||
    key.startsWith('machine.') ||
    key.startsWith('house.')
  ) {
    return 'Timing';
  }
  if (key.startsWith('sim.') || key.startsWith('goal.') || key.startsWith('efficiency.')) return 'Simulation';
  if (
    key.startsWith('plan.') ||
    key.startsWith('toolChange.') ||
    key.startsWith('bitChange.') ||
    key.startsWith('setups.') ||
    key.startsWith('reach.') ||
    key.startsWith('facing.') ||
    key.startsWith('rest.') ||
    key.startsWith('finish.') ||
    key.startsWith('vcarve.') ||
    key.startsWith('target.') ||
    key.startsWith('flip.') ||
    key.startsWith('stock.') ||
    key.startsWith('adaptive.') ||
    key.startsWith('bracket.') ||
    key.startsWith('vise.') ||
    key.startsWith('clamp.') ||
    key.startsWith('tools.') ||
    key.startsWith('drill.') ||
    key.startsWith('thread.') ||
    key.startsWith('bore.') ||
    key.startsWith('laser.') ||
    key.startsWith('relief.') ||
    key.startsWith('offcut.') ||
    key.startsWith('routines.')
  ) {
    return 'Planning';
  }
  if (
    key.startsWith('report.') ||
    key.startsWith('clamps.') ||
    key.startsWith('tape.') ||
    key.startsWith('caseColour') ||
    key.startsWith('engrave.') ||
    key.startsWith('import.') ||
    key.startsWith('runSheet.')
  ) {
    return 'UI';
  }
  return 'Other';
}

interface Row {
  key: string;
  label: string;
  unit: string;
  /** The registry's recommendation, or null for a measured-only key. */
  recommendation: number | boolean | null;
  /** The numeric bound; null for a yes/no key, which has no range. */
  rule: KnownDefault['rule'] | null;
  /** A yes/no key (`KNOWN_FLAGS`), edited with a switch rather than a number. */
  flag: boolean;
  measuredOnly: boolean;
  value: number | string | boolean | null;
  source: string | null;
  setAt: string | null;
  note: string | null;
  /** The shop's copy is a real entry, not the recommendation. */
  fromShop: boolean;
  /** Differs from its recommendation. A measured value is never "changed": it is measured. */
  changed: boolean;
  /** The shop's own measurement is what is in force (or the key only exists measured). */
  measured: boolean;
}

function rowsFrom(defaults: ShopDefaults | null): Row[] {
  const rows: Row[] = [];
  for (const [key, known] of Object.entries(KNOWN_DEFAULTS)) {
    const entry = defaults?.[key];
    const fromShop = entry !== undefined && entry.source !== 'seeded';
    const value = entry === undefined ? known.fallback : entry.value;
    const numeric = typeof value === 'number' ? value : null;
    const measured = entry?.source === 'measured';
    rows.push({
      key,
      label: displayLabel(known.label),
      unit: known.unit,
      recommendation: known.fallback,
      rule: known.rule,
      flag: false,
      measuredOnly: false,
      value,
      source: entry === undefined ? null : entry.source,
      setAt: entry === undefined ? null : entry.setAt,
      note: entry === undefined ? null : entry.note,
      fromShop,
      changed: !measured && numeric !== null && Math.abs(numeric - known.fallback) > 1e-9,
      measured,
    });
  }
  // The yes/no keys are registry entries too: the page lists them, so none is editable only
  // elsewhere (#1207 acceptance).
  for (const [key, known] of Object.entries(KNOWN_FLAGS)) {
    const entry = defaults?.[key];
    const fromShop = entry !== undefined && entry.source !== 'seeded';
    const value = entry === undefined || typeof entry.value !== 'boolean' ? known.fallback : entry.value;
    rows.push({
      key,
      label: displayLabel(known.label),
      unit: '',
      recommendation: known.fallback,
      rule: null,
      flag: true,
      measuredOnly: false,
      value,
      source: entry === undefined ? null : entry.source,
      setAt: entry === undefined ? null : entry.setAt,
      note: entry === undefined ? null : entry.note,
      fromShop,
      changed: value !== known.fallback,
      measured: false,
    });
  }
  for (const [key, known] of Object.entries(MEASURED_ONLY)) {
    const entry = defaults?.[key];
    rows.push({
      key,
      label: displayLabel(known.label),
      unit: known.unit,
      recommendation: null,
      rule: known.rule,
      flag: false,
      measuredOnly: true,
      value: entry === undefined ? null : entry.value,
      source: entry === undefined ? null : entry.source,
      setAt: entry === undefined ? null : entry.setAt,
      note: entry === undefined ? null : entry.note,
      fromShop: entry !== undefined,
      changed: false,
      measured: entry !== undefined,
    });
  }
  return rows;
}

/**
 * A registry label as an operator reads it. The registry's own labels carry provenance wording
 * ("(chosen)", "(chosen, not measured)") because the registry states where a number comes from;
 * on this page the provenance is the row's chips and the detail's record line, so the wording is
 * stripped HERE, never in the registry. Honest limitations — "(measured)", "(not measured)",
 * "(provisional)", "(assumed)", "(placeholder)" — stay: they are what the value IS, not where it
 * came from.
 */
function displayLabel(label: string): string {
  return label.replace(/\s*\((?:chosen|chosen,\s*not measured)\)\s*$/i, '');
}

function fmt(value: number | string | boolean | null, unit: string): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return `${String(value)}${unit === '' ? '' : ` ${unit}`}`;
}

/** A label's first letter, lowered for mid-sentence use — but never an acronym's. */
function midSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** The rule's bounds, read from its JSON Schema (Zod 4), for the detail's "Allowed range" line. */
function boundsOf(rule: KnownDefault['rule']): string {
  try {
    const schema = z.toJSONSchema(rule) as { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number };
    const parts: string[] = [];
    if (schema.minimum !== undefined) parts.push(String(schema.minimum));
    if (schema.exclusiveMinimum !== undefined) parts.push(`> ${schema.exclusiveMinimum}`);
    if (schema.maximum !== undefined) parts.push(String(schema.maximum));
    if (schema.exclusiveMaximum !== undefined) parts.push(`< ${schema.exclusiveMaximum}`);
    return parts.length === 0 ? 'any number' : parts.join(' to ');
  } catch {
    return 'see the refusal';
  }
}

type ChipFilter = 'all' | 'changed' | 'measured';

export function AllValuesScope() {
  const status = useShopDefaultsStore((s) => s.status);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const reason = useShopDefaultsStore((s) => s.reason);
  const setDefault = useShopDefaultsStore((s) => s.set);
  const resetDefault = useShopDefaultsStore((s) => s.reset);
  const narrow = useMediaQuery(NARROW_QUERY);

  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<ChipFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);

  const rows = useMemo(() => rowsFrom(defaults), [defaults]);
  const readOnly = status !== 'present';
  const changedRows = rows.filter((r) => r.changed);
  const measuredRows = rows.filter((r) => r.measured);
  const selected = selectedKey === null ? null : rows.find((r) => r.key === selectedKey) ?? null;

  const q = query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (chip === 'changed' && !row.changed) return false;
    if (chip === 'measured' && !row.measured) return false;
    if (q === '') return true;
    return `${row.key} ${row.label} ${areaOf(row.key)}`.toLowerCase().includes(q);
  });

  function select(row: Row) {
    setSelectedKey((current) => (current === row.key ? null : row.key));
    setDraft(
      row.flag
        ? row.value === true
          ? 'on'
          : 'off'
        : row.value === null
          ? ''
          : String(row.value),
    );
    setSavedAt(null);
    setRefusal(null);
  }

  async function save() {
    if (selected === null) return;
    // The yes/no keys carry no range: the value IS the answer.
    if (selected.flag) {
      const value = draft === 'on';
      setSaving(true);
      setRefusal(null);
      const ok = await setDefault(selected.key, {
        value,
        source: 'chosen',
        setAt: new Date().toISOString(),
        unit: null,
        note: null,
      });
      setSaving(false);
      if (ok) setSavedAt(new Date().toLocaleTimeString());
      else setRefusal(useShopDefaultsStore.getState().reason ?? 'the shop’s record refused the value');
      return;
    }
    const text = draft.trim();
    const value = Number(text === '' ? Number.NaN : text);
    if (!Number.isFinite(value)) {
      setRefusal('Type a number for this value.');
      return;
    }
    const rule = selected.rule;
    if (rule === null) return;
    if (!rule.safeParse(value).success) {
      setRefusal(
        `${text} is outside what this value may be (${boundsOf(rule)} ${selected.unit}). The recommendation is ${fmt(selected.recommendation, selected.unit)}.`,
      );
      return;
    }
    setSaving(true);
    setRefusal(null);
    // A measured-only key is a measurement even before one exists: the first value entered here IS
    // the measurement, entered by hand.
    const replacesMeasurement = selected.measured || selected.measuredOnly;
    const ok = await setDefault(selected.key, {
      value,
      source: replacesMeasurement ? 'measured' : 'chosen',
      setAt: new Date().toISOString(),
      unit: selected.unit,
      note: replacesMeasurement ? 'entered by hand' : null,
    });
    setSaving(false);
    if (ok) {
      setSavedAt(new Date().toLocaleTimeString());
      setDraft(String(value));
    } else {
      setRefusal(useShopDefaultsStore.getState().reason ?? 'the shop’s record refused the value');
    }
  }

  async function resetOne(key: string) {
    const ok = await resetDefault(key);
    if (!ok) setRefusal(useShopDefaultsStore.getState().reason ?? 'the shop’s record refused the reset');
    else setSavedAt(new Date().toLocaleTimeString());
  }

  async function resetAllChanged() {
    for (const row of changedRows) await resetDefault(row.key);
    setConfirmReset(false);
    setSavedAt(new Date().toLocaleTimeString());
  }

  const detailBody =
    selected === null ? (
      <p className="allvalues-hint">
        Choose a value to see what it decides, its recommendation and this shop’s record.
      </p>
    ) : (
      <>
        <div className="allvalues-eyebrow">
          {areaOf(selected.key)}
          {selected.measured ? ' · measured' : selected.measuredOnly ? ' · measured only' : ''}
        </div>
        <div className="allvalues-detailkey mono">{selected.key}</div>
        <h4 className="allvalues-title">
          This value decides {midSentence(selected.label).replace(/[.\s]+$/, '')}.
        </h4>
        <div className="lf">
          <span>Value in this shop’s record</span>
          <div className="allvalues-inputrow">
            {selected.flag ? (
              <select
                className="fld allvalues-switch"
                data-testid="all-values-input"
                value={draft}
                disabled={readOnly}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setRefusal(null);
                }}
              >
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            ) : (
              <>
                <input
                  className="fld fld--num"
                  data-testid="all-values-input"
                  value={draft}
                  disabled={readOnly}
                  aria-invalid={refusal !== null}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setRefusal(null);
                  }}
                />
                <span className="allvalues-unit">{selected.unit || '×'}</span>
              </>
            )}
          </div>
        </div>
        {refusal !== null && (
          <div className="allvalues-refusal" data-testid="all-values-refusal" role="alert">
            {refusal}
          </div>
        )}
        {savedAt !== null && (
          <div className="allvalues-saved" data-testid="all-values-saved">
            Saved · {savedAt}
          </div>
        )}
        <dl className="allvalues-facts">
          <div>
            <dt>Recommendation</dt>
            <dd>
              {selected.recommendation === null
                ? 'none — this value is measured'
                : fmt(selected.recommendation, selected.unit)}
            </dd>
          </div>
          <div>
            <dt>Allowed range</dt>
            <dd>
              {selected.rule === null ? 'on or off' : `${boundsOf(selected.rule)} ${selected.unit}`}
            </dd>
          </div>
          <div>
            <dt>This shop’s record</dt>
            <dd>
              {selected.measuredOnly
                ? selected.fromShop
                  ? `${selected.note ?? 'measured'} · ${timeOfDayWords(selected.setAt) ?? 'recorded'}`
                  : 'not measured yet'
                : selected.fromShop
                  ? `${selected.note ?? selected.source ?? 'saved'} · ${timeOfDayWords(selected.setAt) ?? 'recorded'}`
                  : 'the recommendation is in force'}
            </dd>
          </div>
        </dl>
        <div className="row btn-row btn-row--wrap">
          <button
            className="btn btn--primary btn--sm"
            data-testid="all-values-save"
            disabled={readOnly || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn btn--sm"
            data-testid="all-values-reset"
            disabled={readOnly || selected.measured || selected.recommendation === null}
            onClick={() => void resetOne(selected.key)}
          >
            Reset to {selected.recommendation === null ? '—' : fmt(selected.recommendation, selected.unit)}
          </button>
        </div>
        {selected.measured && (
          <p className="allvalues-hint allvalues-hint--measured">
            Replacing a measurement: the record will say <b>entered by hand</b>. There is no reset — the
            way back is to measure again.{' '}
            <button type="button" className="allvalues-linklike" onClick={() => setDocsOpen(true)}>
              Measuring procedure →
            </button>
          </p>
        )}
        {selected.measuredOnly && !selected.measured && (
          <p className="allvalues-hint allvalues-hint--measured">
            This value does not exist until it is measured on the machine.{' '}
            <button type="button" className="allvalues-linklike" onClick={() => setDocsOpen(true)}>
              Measuring procedure →
            </button>
          </p>
        )}
      </>
    );

  return (
    <section className="mmain allvalues-mainpane" data-testid="manage-all-values" data-narrow={narrow ? 'true' : undefined}>
      <div className="mhead">
        <div>
          <h3>All values</h3>
          <p>
            Every shop default, generated from the registry. Edits write this shop’s record; a plan
            that read a changed value asks for Generate again.
          </p>
        </div>
        <div className="row btn-row">
          <button
            className="btn btn--sm"
            data-testid="all-values-reset-changed"
            disabled={readOnly || changedRows.length === 0}
            onClick={() => setConfirmReset(true)}
          >
            Reset changed… ({changedRows.length})
          </button>
        </div>
      </div>

      {status === 'absent' && (
        <div className="allvalues-banner" data-testid="all-values-readonly">
          No shop record at this origin — the registry’s recommendations are shown. Connect the shop’s
          service to edit them.
        </div>
      )}

      <div className="mfilter allvalues-toolbar">
        <input
          className="fld fld--text"
          data-testid="all-values-search"
          placeholder="Search keys, meaning or area…"
          aria-label="Search values"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="allvalues-chips" role="group" aria-label="Filter values">
          {(
            [
              ['all', 'All', rows.length],
              ['changed', 'Changed', changedRows.length],
              ['measured', 'Measured', measuredRows.length],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className={`chip${chip === id ? ' chip--on' : ''}`}
              data-testid={`all-values-chip-${id}`}
              aria-pressed={chip === id}
              onClick={() => setChip(id)}
            >
              {label} <span className="allvalues-chipn">{count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={`mscroll allvalues-layout${narrow ? ' allvalues-layout--narrow' : ''}`}>
        <div className="allvalues-list">
          {filtered.length === 0 && (
            <p className="allvalues-empty" data-testid="all-values-empty">
              No values match {query.trim() === '' ? 'this filter' : `“${query.trim()}”`}.
            </p>
          )}
          {AREAS.map((area) => {
            const inArea = filtered.filter((row) => areaOf(row.key) === area);
            if (inArea.length === 0) return null;
            const areaChanged = inArea.filter((row) => row.changed).length;
            return (
              <div key={area} className="allvalues-group">
                <div className="allvalues-grouphead">
                  <h4>{area}</h4>
                  <span className="allvalues-count">
                    {inArea.length} values
                    {areaChanged > 0 ? ` · ${areaChanged} changed` : ''}
                  </span>
                </div>
                <p className="allvalues-blurb">{AREA_BLURB[area]}</p>
                {inArea.map((row) => (
                  <div key={row.key}>
                    <button
                      type="button"
                      className={`allvalues-row${row.key === selectedKey ? ' allvalues-row--sel' : ''}`}
                      data-testid={`all-values-row-${row.key}`}
                      aria-expanded={narrow ? row.key === selectedKey : undefined}
                      onClick={() => select(row)}
                    >
                      <span className="allvalues-main">
                        <span className="allvalues-label">{row.label}</span>
                        <span className="allvalues-key mono">{row.key}</span>
                      </span>
                      <span className="allvalues-figures">
                        <span className="allvalues-rec">
                          rec. {row.recommendation === null ? '—' : fmt(row.recommendation, row.unit)}
                        </span>
                        <span className="allvalues-value mono">{fmt(row.value, row.unit)}</span>
                        {row.changed && (
                          <span className="allvalues-chip allvalues-chip--changed" data-kind="changed">
                            changed
                          </span>
                        )}
                        {row.measured && (
                          <span className="allvalues-chip allvalues-chip--measured" data-kind="measured">
                            measured
                          </span>
                        )}
                        {row.measuredOnly && !row.measured && (
                          <span className="allvalues-note">not measured yet</span>
                        )}
                      </span>
                    </button>
                    {narrow && row.key === selectedKey && (
                      <div className="allvalues-detail allvalues-detail--inline" data-testid="all-values-detail">
                        {detailBody}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {!narrow && (
          <aside className="allvalues-detail" data-testid="all-values-detail" aria-live="polite">
            {detailBody}
          </aside>
        )}
      </div>

      {confirmReset && (
        <div className="allvalues-confirm" data-testid="all-values-reset-confirm">
          <h4>Reset these {changedRows.length} changed values to their recommendations?</h4>
          <ul>
            {changedRows.map((row) => (
              <li key={row.key}>
                <span>{row.label}</span>{' '}
                <span className="mono">
                  {fmt(row.value, row.unit)} → {fmt(row.recommendation, row.unit)}
                </span>
              </li>
            ))}
          </ul>
          <p>Measured values are never touched.</p>
          <div className="row btn-row">
            <button
              className="btn btn--primary btn--sm"
              data-testid="all-values-reset-confirm-yes"
              onClick={() => void resetAllChanged()}
            >
              Reset {changedRows.length}
            </button>
            <button
              className="btn btn--sm"
              data-testid="all-values-reset-confirm-no"
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {docsOpen && <DocsModal initialId="cnc-guide" onClose={() => setDocsOpen(false)} />}
      {reason !== null && status === 'error' && <p className="allvalues-hint">{reason}</p>}
    </section>
  );
}
