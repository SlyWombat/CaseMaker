/**
 * Manage › Accessories (#601): the mounts and probes the house owns, with their measured records,
 * provenance, check-out/return and a register door.
 *
 * THE LIST IS THE HOUSE'S, NOT A MACHINE'S (#597). Every accessory lives on the location's
 * `accessories[]`; `whereabouts` on each record says whether it is in the box or checked out to one
 * machine since a date. The machine's bed profile places one BY ID — the hoist that moved the old
 * per-machine fixtures up into the location ran once (#597), and this scope is where the rest of
 * their lives are read and edited.
 *
 * SHOWS PER ITEM, as the issue asks: kind, product/variant, whereabouts (box / machine, since), the
 * measured record with its provenance, and the history. The four actions are a register (a Type
 * door with kind-specific fields — a probe carries variant, tip Ø and rim offset ±), check out to a
 * machine / return to the box, edit the label, and retire.
 *
 * TWO OWNED PROBES (maintainer, 2026-10-23). "Makera Wired Probe V2" (variant `wired-touch`) is
 * checked out to the Z1 with its measured tip/rim unit; "Makera 3D Wired Probe" (variant `3d`) is
 * in its box, never used — tip values null, no provenance line, history "owned; not yet tested".
 * The register door must be able to create both records exactly as the fixture has them, so the
 * probe door's unit carries `tipDiameterMm`, `rimOffsetMm`, `rimOffsetUncertaintyMm` plus the two
 * registration keys `lastM491`/`lastM119Rest` as nulls, and an unmeasured probe's first history
 * line is "owned; not yet tested".
 */

import { useState } from 'react';
import type { FixtureRecord } from '@/platform/locationClient';
import { useLocationStore } from '@/store/locationStore';
import { newId } from '@/utils/id';
import { formatDay, mm } from './display';

/** The accessory kinds the door offers. `probe` is first — it is the one this scope exists for. */
const REGISTERABLE_KINDS = ['probe', 'vise', 'bracket', 'top-clamp', 'side-clamp', 'rotary-module', 'vacuum-bed'] as const;

const KIND_WORDS: Record<string, string> = {
  probe: 'probe',
  vise: 'vise',
  bracket: 'bracket',
  'top-clamp': 'top clamps',
  'side-clamp': 'side clamp',
  'rotary-module': '4th-axis module',
  'vacuum-bed': 'vacuum bed',
};

function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? kind;
}

/** The probe variants the card names (#601); an accessory of another kind has no variant list. */
const PROBE_VARIANTS = ['wired-touch', '3d', 'tool-setter'] as const;

/** The machine's short name for the whereabouts sentence: its profile id (`Z1`) first, then its broadcast name. */
function machineShortName(machines: readonly { id: string; profileId: string | null; name: string | null }[], id: string): string {
  const m = machines.find((x) => x.id === id);
  if (m === undefined) return id;
  return m.profileId ?? m.name ?? id;
}

/** "in its box" / "in the Z1 since 2026-10-23". */
function whereaboutsLine(
  record: FixtureRecord,
  machines: readonly { id: string; profileId: string | null; name: string | null }[],
): string {
  if (record.whereabouts.kind === 'box') return 'in its box';
  const name = machineShortName(machines, record.whereabouts.machineId);
  return `in the ${name} since ${formatDay(record.whereabouts.since) ?? record.whereabouts.since}`;
}

/** The probe's measured line — `tip ⌀ 2.0 · rim 0.70 ± 0.25` — or null when nothing is measured. */
function probeLine(record: FixtureRecord): string | null {
  const tip = record.unit['tipDiameterMm'];
  const rim = record.unit['rimOffsetMm'];
  const unc = record.unit['rimOffsetUncertaintyMm'];
  const bits: string[] = [];
  if (typeof tip === 'number') bits.push(`tip ⌀ ${mm(tip)}`);
  if (typeof rim === 'number') bits.push(`rim ${mm(rim)}${typeof unc === 'number' ? ` ± ${mm(unc)}` : ''}`);
  return bits.length === 0 ? null : bits.join(' · ');
}

/** The measured cell: the probe's line, or a count of the measured numbers a mount carries. */
function measuredLine(record: FixtureRecord): string {
  if (record.kind === 'probe') return probeLine(record) ?? 'not measured';
  let n = 0;
  for (const value of Object.values(record.unit)) if (typeof value === 'number') n += 1;
  return n === 0 ? 'not measured' : `${n} measured`;
}

/** The accessory's display name: its product, or the kind word when nobody named it. */
function displayName(record: FixtureRecord): string {
  return record.product ?? kindWord(record.kind);
}

/** The record a probe draft describes. Identity and the registration keys come from here alone. */
function probeFromDraft(
  d: ProbeDraft,
  id: string,
  now: string,
): FixtureRecord {
  const tip = d.tip.trim() === '' ? null : Number(d.tip);
  const rim = d.rim.trim() === '' ? null : Number(d.rim);
  const unc = d.unc.trim() === '' ? null : Number(d.unc);
  const unit: FixtureRecord['unit'] = {
    tipDiameterMm: tip,
    rimOffsetMm: rim,
    rimOffsetUncertaintyMm: unc,
    lastM491: null,
    lastM119Rest: null,
  };
  const provenance: FixtureRecord['provenance'] = {};
  if (tip !== null) provenance.tipDiameterMm = `measured:${now}`;
  if (rim !== null) provenance.rimOffsetMm = `measured:${now}`;
  if (unc !== null) provenance.rimOffsetUncertaintyMm = `measured:${now}`;
  const measuredBits: string[] = [];
  if (tip !== null) measuredBits.push(`tip ${mm(tip)}`);
  if (rim !== null) measuredBits.push(`rim ${mm(rim)}${unc !== null ? ` +/- ${mm(unc)}` : ''}`);
  return {
    id,
    kind: 'probe',
    product: d.product.trim() === '' ? null : d.product.trim(),
    variant: d.variant === '' ? null : d.variant,
    constants: {},
    unit,
    provenance,
    whereabouts: { kind: 'box' },
    history: [{ at: now, what: measuredBits.length === 0 ? 'owned; not yet tested' : `measured ${measuredBits.join(' / ')}` }],
  };
}

interface ProbeDraft {
  product: string;
  variant: string;
  tip: string;
  rim: string;
  unc: string;
}

const BLANK_PROBE: ProbeDraft = { product: '', variant: 'wired-touch', tip: '', rim: '', unc: '' };

/** A probe draft that failed its numbers is refused with this sentence, or null when it is sendable. */
function probeProblem(d: ProbeDraft): string | null {
  for (const [label, text] of [['tip ⌀', d.tip], ['rim offset', d.rim], ['rim spread', d.unc]] as const) {
    if (text.trim() === '') continue;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return `${label} must be a number, 0 or above`;
  }
  if (d.product.trim() === '') return 'name the probe';
  return null;
}

/** A generic (non-probe) accessory draft — a name and a variant, nothing measured. */
interface GenericDraft {
  product: string;
  variant: string;
}

const BLANK_GENERIC: GenericDraft = { product: '', variant: '' };

export function AccessoriesScope() {
  const status = useLocationStore((s) => s.status);
  const location = useLocationStore((s) => s.location);
  const reason = useLocationStore((s) => s.reason);
  const note = useLocationStore((s) => s.accessoryNote);
  const dismissNote = useLocationStore((s) => s.clearAccessoryNote);

  const accessories = location?.accessories ?? [];
  const machines = location?.machines ?? [];

  // `null` = nothing open in the rail; `'new'` = the register form; otherwise the selected id.
  const [open, setOpen] = useState<string | null>(null);
  const selected = open !== null && open !== 'new' ? (accessories.find((a) => a.id === open) ?? null) : null;
  // An accessory removed under an open rail (another window): shown as nothing open, never as "add".
  const gone = open !== null && open !== 'new' && status === 'present' && selected === null;

  if (status === 'unknown') {
    return (
      <>
        <section className="mmain" data-testid="manage-accessories-loading">
          <p className="hint">Reading the location…</p>
        </section>
        <aside className="context-panel" />
      </>
    );
  }

  if (status !== 'present') {
    return (
      <>
        <section className="mmain">
          <div className="mhead">
            <div>
              <h3>Accessories</h3>
              <p>The mounts and probes the house owns, and where each one is.</p>
            </div>
          </div>
          <div className="mempty" data-testid="manage-accessories-absent">
            <h4>{status === 'error' ? 'The location could not be read' : 'No house service here'}</h4>
            <p>
              The accessories live in the location file the <b>desktop build</b>’s service holds. A
              page served from a web host has no such service.
            </p>
            {reason !== null && <div className="why">{reason}</div>}
          </div>
        </section>
        <aside className="context-panel" />
      </>
    );
  }

  return (
    <>
      <section className="mmain">
        <div className="mhead">
          <div>
            <h3>Accessories</h3>
            <p>
              The mounts and probes the house owns, with their measured records and where each one
              is — in its box, or checked out to a machine. The vise and the wired probe are the two
              the bed profile places by id; a probe’s tip and rim are what the registration runs
              measure with.
            </p>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="manage-accessories-register-open"
              onClick={() => setOpen('new')}
            >
              ＋ Register
            </button>
          </div>
        </div>

        {note !== null && (
          <div className="mnotice mnotice--error" data-testid="manage-accessories-notice">
            <span>{note}</span>
            <button type="button" data-testid="manage-accessories-notice-dismiss" onClick={dismissNote}>
              ×
            </button>
          </div>
        )}

        {accessories.length === 0 ? (
          <div className="mempty" data-testid="manage-accessories-empty">
            <h4>No accessories</h4>
            <p>Register the vise, the probes and the mounts the house owns, so a bed can place them.</p>
          </div>
        ) : (
          <div className="mscroll">
            <table className="tbl" data-testid="manage-accessories-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>Accessory</th>
                  <th>Kind</th>
                  <th>Where</th>
                  <th>Measured</th>
                  <th>Last note</th>
                </tr>
              </thead>
              <tbody>
                {accessories.map((a) => {
                  const last = a.history[a.history.length - 1];
                  return (
                    <tr
                      key={a.id}
                      className={open === a.id ? 'sel' : undefined}
                      data-testid={`manage-accessories-row-${a.id}`}
                      onClick={() => setOpen(a.id)}
                    >
                      <td className="nm">
                        <button
                          type="button"
                          className="tbl__rowbtn"
                          data-testid={`manage-accessories-pick-${a.id}`}
                          aria-current={open === a.id ? 'true' : undefined}
                          onClick={() => setOpen(a.id)}
                        >
                          <span className="tbl__name">{displayName(a)}</span>
                          {a.variant !== null && <small>{a.variant}</small>}
                        </button>
                      </td>
                      <td>
                        <span className="tag tag--muted">{kindWord(a.kind)}</span>
                      </td>
                      <td>{whereaboutsLine(a, machines)}</td>
                      <td>{measuredLine(a)}</td>
                      <td>{last === undefined ? '' : last.what}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {open === null || gone ? (
        <aside className="context-panel" data-testid="manage-accessories-detail-empty">
          <div className="empty">Pick an accessory to see its record, or register one.</div>
        </aside>
      ) : open === 'new' ? (
        <AccessoryRegister onSaved={(id) => setOpen(id)} onClose={() => setOpen(null)} />
      ) : selected !== null ? (
        <AccessoryDetail
          key={selected.id}
          item={selected}
          machines={machines}
          onClose={() => setOpen(null)}
          onSaved={(id) => setOpen(id)}
        />
      ) : null}
    </>
  );
}

/** The register door: a Type door with kind-specific fields. A probe carries variant, tip and rim. */
function AccessoryRegister({ onSaved, onClose }: { onSaved: (id: string) => void; onClose: () => void }) {
  const saveAccessory = useLocationStore((s) => s.saveAccessory);
  const [kind, setKind] = useState<string>('probe');
  const [probe, setProbe] = useState<ProbeDraft>(BLANK_PROBE);
  const [generic, setGeneric] = useState<GenericDraft>(BLANK_GENERIC);

  const busy = false; // the store's write is awaited by the button's handler; no in-flight flag needed
  const problem = kind === 'probe' ? probeProblem(probe) : generic.product.trim() === '' ? 'name the accessory' : null;

  const register = async () => {
    const now = new Date().toISOString();
    const id = newId('fx');
    let record: FixtureRecord;
    if (kind === 'probe') {
      record = probeFromDraft(probe, id, now);
    } else {
      record = {
        id,
        kind,
        product: generic.product.trim() === '' ? null : generic.product.trim(),
        variant: generic.variant.trim() === '' ? null : generic.variant.trim(),
        constants: {},
        unit: {},
        provenance: {},
        whereabouts: { kind: 'box' },
        history: [{ at: now, what: 'registered' }],
      };
    }
    if ((await saveAccessory(record)) === 'ok') {
      setProbe(BLANK_PROBE);
      setGeneric(BLANK_GENERIC);
      onSaved(id);
    }
  };

  return (
    <aside className="context-panel" data-testid="manage-acc-register">
      <div className="panel-head">
        <h3>Register an accessory</h3>
        <button type="button" className="x" aria-label="Close" data-testid="manage-acc-register-close" onClick={onClose}>
          ×
        </button>
      </div>

      <label className="lf">
        <span>kind</span>
        <select
          className="fld"
          value={kind}
          data-testid="manage-acc-kind"
          onChange={(e) => setKind(e.target.value)}
        >
          {REGISTERABLE_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindWord(k)}
            </option>
          ))}
        </select>
      </label>

      {kind === 'probe' ? (
        <>
          <label className="lf">
            <span>product</span>
            <input
              className="fld fld--text"
              type="text"
              placeholder="Makera Wired Probe V2"
              value={probe.product}
              data-testid="manage-acc-product"
              onChange={(e) => setProbe((p) => ({ ...p, product: e.target.value }))}
            />
          </label>
          <label className="lf">
            <span>variant</span>
            <select
              className="fld"
              value={probe.variant}
              data-testid="manage-acc-variant"
              onChange={(e) => setProbe((p) => ({ ...p, variant: e.target.value }))}
            >
              {PROBE_VARIANTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
              <option value="">—</option>
            </select>
          </label>
          <div className="panel-subhead">Measured, mm — blank stays unknown</div>
          <div className="grid2">
            <label className="lf">
              <span>tip ⌀</span>
              <input
                className="fld fld--num"
                type="number"
                min={0}
                step="any"
                placeholder="—"
                value={probe.tip}
                data-testid="manage-acc-tip"
                onChange={(e) => setProbe((p) => ({ ...p, tip: e.target.value }))}
              />
            </label>
            <label className="lf">
              <span>rim offset</span>
              <input
                className="fld fld--num"
                type="number"
                min={0}
                step="any"
                placeholder="—"
                value={probe.rim}
                data-testid="manage-acc-rim"
                onChange={(e) => setProbe((p) => ({ ...p, rim: e.target.value }))}
              />
            </label>
            <label className="lf">
              <span>rim spread ±</span>
              <input
                className="fld fld--num"
                type="number"
                min={0}
                step="any"
                placeholder="—"
                value={probe.unc}
                data-testid="manage-acc-rim-unc"
                onChange={(e) => setProbe((p) => ({ ...p, unc: e.target.value }))}
              />
            </label>
          </div>
          <p className="hint">A blank box stays unknown, never 0 — an unmeasured probe is registered untested.</p>
        </>
      ) : (
        <>
          <label className="lf">
            <span>product</span>
            <input
              className="fld fld--text"
              type="text"
              placeholder="makera-z1-low-profile-vise"
              value={generic.product}
              data-testid="manage-acc-product"
              onChange={(e) => setGeneric((g) => ({ ...g, product: e.target.value }))}
            />
          </label>
          <label className="lf">
            <span>variant</span>
            <input
              className="fld fld--text"
              type="text"
              placeholder="thin / thick"
              value={generic.variant}
              data-testid="manage-acc-variant"
              onChange={(e) => setGeneric((g) => ({ ...g, variant: e.target.value }))}
            />
          </label>
          <p className="hint">A mount’s product constants come from the shipped tier, read-only; measure them after.</p>
        </>
      )}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="manage-acc-register-submit"
          disabled={problem !== null || busy}
          title={problem ?? 'Register this accessory'}
          onClick={() => void register()}
        >
          Add to the house
        </button>
      </div>
    </aside>
  );
}

/** The detail rail: the record read-only, the label and variant editable, and the three moves. */
function AccessoryDetail({
  item,
  machines,
  onClose,
  onSaved,
}: {
  item: FixtureRecord;
  machines: readonly { id: string; profileId: string | null; name: string | null }[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const saveAccessory = useLocationStore((s) => s.saveAccessory);
  const removeAccessory = useLocationStore((s) => s.removeAccessory);
  const [product, setProduct] = useState(item.product ?? '');
  const [variant, setVariant] = useState(item.variant ?? '');
  const [checkoutTo, setCheckoutTo] = useState(machines[0]?.id ?? '');

  const productChanged = product !== (item.product ?? '');
  const variantChanged = variant !== (item.variant ?? '');
  const touched = productChanged || variantChanged;

  const save = async (record: FixtureRecord): Promise<boolean> => {
    const ok = (await saveAccessory(record)) === 'ok';
    if (ok) onSaved(record.id);
    return ok;
  };

  const saveLabel = () =>
    void save({
      ...item,
      product: product.trim() === '' ? null : product.trim(),
      variant: variant.trim() === '' ? null : variant.trim(),
    });

  const checkout = () =>
    void save({
      ...item,
      whereabouts: { kind: 'machine', machineId: checkoutTo, since: new Date().toISOString() },
      history: [...item.history, { at: new Date().toISOString(), what: `checked out to ${machineShortName(machines, checkoutTo)}` }],
    });

  const returnToBox = () =>
    void save({
      ...item,
      whereabouts: { kind: 'box' },
      history: [...item.history, { at: new Date().toISOString(), what: 'returned to the box' }],
    });

  const retire = () => void removeAccessory(item.id).then((ok) => ok && onClose());

  return (
    <aside className="context-panel" data-testid="manage-acc-detail">
      <div className="panel-head">
        <h3>{displayName(item)}</h3>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <p className="hint">
        <span className="tag tag--muted">{kindWord(item.kind)}</span> · {whereaboutsLine(item, machines)}
      </p>

      <label className="lf">
        <span>label</span>
        <input
          className="fld fld--text"
          type="text"
          value={product}
          data-testid="manage-acc-label"
          onChange={(e) => setProduct(e.target.value)}
        />
      </label>
      <label className="lf">
        <span>variant</span>
        {item.kind === 'probe' ? (
          <select className="fld" value={variant} data-testid="manage-acc-variant" onChange={(e) => setVariant(e.target.value)}>
            {PROBE_VARIANTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            <option value="">—</option>
          </select>
        ) : (
          <input
            className="fld fld--text"
            type="text"
            value={variant}
            data-testid="manage-acc-variant"
            onChange={(e) => setVariant(e.target.value)}
          />
        )}
      </label>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="manage-acc-save"
          disabled={!touched}
          title={touched ? 'Save the label and variant' : 'Nothing to save yet'}
          onClick={saveLabel}
        >
          Save
        </button>
      </div>

      <div className="panel-subhead">Measured record</div>
      {item.kind === 'probe' ? (
        <p className="hint" data-testid="manage-acc-measured">
          {probeLine(item) ?? 'not measured — nothing recorded for the tip or the rim'}
        </p>
      ) : (
        <ul className="hint" data-testid="manage-acc-measured">
          {Object.entries(item.unit)
            .filter(([, v]) => typeof v === 'number')
            .map(([key, v]) => (
              <li key={key}>
                {key}: {mm(v as number)}{' '}
                <span className="dim">({item.provenance[key] ?? 'no provenance'})</span>
              </li>
            ))}
          {Object.entries(item.unit).every(([, v]) => typeof v !== 'number') && <li>not measured</li>}
        </ul>
      )}

      <div className="panel-subhead">Where</div>
      {item.whereabouts.kind === 'box' ? (
        <div className="btn-row">
          <label className="lf">
            <span>check out to</span>
            <select
              className="fld"
              value={checkoutTo}
              data-testid="manage-acc-checkout-select"
              onChange={(e) => setCheckoutTo(e.target.value)}
            >
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {machineShortName(machines, m.id)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn--sm" data-testid="manage-acc-checkout" disabled={machines.length === 0} onClick={checkout}>
            Check out
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--sm" data-testid="manage-acc-return" onClick={returnToBox}>
          Return to the box
        </button>
      )}

      <div className="panel-subhead">History</div>
      <ul className="hint" data-testid="manage-acc-history">
        {item.history.length === 0 && <li>no history</li>}
        {item.history.map((h, i) => (
          <li key={i}>
            {h.what} <span className="dim">({formatDay(h.at) ?? h.at})</span>
          </li>
        ))}
      </ul>

      <div className="btn-row">
        <button type="button" className="btn btn--sm btn--danger" data-testid="manage-acc-retire" onClick={retire}>
          Retire
        </button>
      </div>
    </aside>
  );
}
