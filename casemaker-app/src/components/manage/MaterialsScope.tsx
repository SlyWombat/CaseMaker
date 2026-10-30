/**
 * Manage › Materials (#413): the stock shelf — what material is on hand at the location.
 *
 * LIST, DETAIL, EDIT, as the Tools scope is laid out: the shelf in the main pane, the selected entry
 * (or a new one) in the right rail as an editable form. Every save goes through `stockStore`, which
 * writes to the house service's guarded `/stock` endpoints and re-reads; the sentence a refusal
 * carries is shown as it came.
 *
 * WHAT THE FORM OFFERS IS WHAT THE SHELF ACCEPTS. The size fields are the ones the chosen form
 * needs (a rod has a diameter and a length, a plate three sides); layers are offered only on a form
 * with a flat top; a dome height only for domed stock; and a sphere is not among the forms at all
 * (decision Q20) — the schema refuses one by name if it ever arrives. Conductive is defaulted from
 * the material (metals yes) when the material is picked, and stays the user's to change.
 *
 * RESERVATIONS ARE SHOWN, NOT EDITED. A job reserves and consumes (#419, #414 will call the store's
 * `reserve` / `consume`); this screen says how many are held and by which job, and an entry that a
 * run used up stays listed at 0 — "consumed by job 12" — until it is removed.
 */

import { useEffect, useMemo, useState } from 'react';
import { MATERIAL_LABELS, STOCK_MATERIALS, isConductiveMaterial } from '@/engine/cnc/materials';
import type { StockMaterial } from '@/types/engraveJob';
import {
  SIZE_FIELDS,
  STOCK_FINISHES,
  STOCK_FLATNESS,
  STOCK_FORMS,
  STOCK_SOURCES,
  STOCK_CAP_SOURCES,
  formIsFlat,
  stockProblem,
  type SizeField,
  type StockCapSource,
  type StockForm,
  type StockItem,
} from '@/platform/stockClient';
import {
  houseMaterialSpecs,
  type MaterialSpec,
  type MaterialSpecsRead,
} from '@/platform/materialSpecsClient';
import { available, newStockId, useStockStore } from '@/store/stockStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { formatDay, mm } from './display';
import { specSizeFields } from './vendorSizes';

const FORM_LABELS: Record<StockForm, string> = {
  sheet: 'sheet',
  plate: 'plate',
  block: 'block',
  rod: 'rod',
  tube: 'tube',
  disc: 'disc',
  'printed-blank': 'printed blank',
};

const SIZE_LABELS: Record<SizeField, string> = {
  length: 'length',
  width: 'width',
  thickness: 'thickness',
  diameter: '⌀',
  wall: 'wall',
};

/** `100 × 100 × 5` / `⌀10 × 100` / `⌀20 × 2 × 100` — the size in the order the form names it. */
function sizeLine(item: Pick<StockItem, 'form' | 'size'>): string {
  return SIZE_FIELDS[item.form]
    .map((f) => {
      const v = item.size[f];
      const n = v === null || v === undefined ? '—' : mm(v);
      return f === 'diameter' ? `⌀${n}` : n;
    })
    .join(' × ');
}

/** The count column: what is on the shelf, what is held, and who used the last one. */
function countLine(item: StockItem): string {
  if (item.quantity === 0) {
    const last = item.consumed[item.consumed.length - 1];
    return last ? `0 — consumed by ${last.jobId}` : '0';
  }
  const held = item.quantity - available(item);
  return held > 0 ? `×${item.quantity}, ${held} reserved` : `×${item.quantity}`;
}

/** The editor's working copy: text for every number, so a half-typed value is not a refusal. */
interface Draft {
  material: StockMaterial;
  form: StockForm;
  size: Record<SizeField, string>;
  layers: { name: string; thickness: string }[];
  /** #492 — a purchased laminate's cap, text so a half-typed value is not a refusal. */
  capMm: string;
  capSource: StockCapSource;
  finish: StockItem['finish'];
  flatness: StockItem['flatness'];
  domeHeight: string;
  conductive: boolean;
  quantity: string;
  source: StockItem['source'];
  notes: string;
}

const EMPTY_SIZE: Record<SizeField, string> = { length: '', width: '', thickness: '', diameter: '', wall: '' };

function draftOf(item: StockItem | null): Draft {
  if (item === null) {
    return {
      material: 'aluminium-6061',
      form: 'plate',
      size: { ...EMPTY_SIZE },
      layers: [],
      capMm: '',
      capSource: 'assumed',
      finish: 'rough',
      flatness: 'flat',
      domeHeight: '',
      conductive: true,
      quantity: '1',
      source: 'purchased',
      notes: '',
    };
  }
  const size = { ...EMPTY_SIZE };
  for (const f of SIZE_FIELDS[item.form]) size[f] = item.size[f] == null ? '' : String(item.size[f]);
  return {
    material: item.material,
    form: item.form,
    size,
    layers: item.layers.map((l) => ({ name: l.name, thickness: String(l.thickness) })),
    capMm: item.capMm == null ? '' : String(item.capMm),
    capSource: item.capSource ?? 'assumed',
    finish: item.finish,
    flatness: item.flatness,
    domeHeight: item.domeHeight == null ? '' : String(item.domeHeight),
    conductive: item.conductive,
    quantity: String(item.quantity),
    source: item.source,
    notes: item.notes ?? '',
  };
}

/** A typed number, or NaN for one that is not — which the schema then names. */
function num(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/** The entry a draft describes. Identity, claims and `addedAt` come from the entry being edited. */
function itemFromDraft(d: Draft, base: StockItem | null, now: string): StockItem {
  const size: StockItem['size'] = {};
  for (const f of SIZE_FIELDS[d.form]) size[f] = num(d.size[f]);
  return {
    id: base?.id ?? newStockId(),
    material: d.material,
    form: d.form,
    size,
    layers: formIsFlat(d.form) ? d.layers.map((l) => ({ name: l.name.trim(), thickness: num(l.thickness) })) : [],
    capMm: formIsFlat(d.form) && d.capMm.trim() !== '' ? num(d.capMm) : null,
    capSource:
      formIsFlat(d.form) && d.capMm.trim() !== '' ? d.capSource : null,
    finish: d.finish,
    flatness: d.flatness,
    domeHeight: d.flatness === 'domed' ? num(d.domeHeight) : null,
    conductive: d.conductive,
    quantity: num(d.quantity),
    reservations: base?.reservations ?? [],
    consumed: base?.consumed ?? [],
    source: d.source,
    notes: d.notes.trim() === '' ? null : d.notes.trim(),
    addedAt: base?.addedAt ?? now,
  };
}

export function MaterialsScope() {
  const houseStatus = useToolRegistryStore((s) => s.status);
  const status = useStockStore((s) => s.status);
  const items = useStockStore((s) => s.items);
  const unreadable = useStockStore((s) => s.unreadable);
  const reason = useStockStore((s) => s.reason);
  const notice = useStockStore((s) => s.notice);
  const dismissNotice = useStockStore((s) => s.dismissNotice);
  const refresh = useStockStore((s) => s.refresh);
  // `null` = nothing open; `'new'` = the add form; otherwise the selected entry's id.
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (houseStatus === 'present') void refresh();
  }, [houseStatus, refresh]);

  const selected = open !== null && open !== 'new' ? (items.find((i) => i.id === open) ?? null) : null;
  // An entry removed under an open editor (another window): shown as nothing open, never as "add".
  const gone = open !== null && open !== 'new' && status === 'present' && selected === null;

  // Still asking (#413 review): neither "no service" nor "empty" is true yet.
  if (houseStatus === 'checking' || (houseStatus === 'present' && status === 'unknown')) {
    return (
      <>
        <section className="mmain" data-testid="manage-materials-loading">
          <p className="hint">Reading the shelf…</p>
        </section>
        <aside className="context-panel" />
      </>
    );
  }

  if (houseStatus !== 'present' || status === 'absent' || status === 'error') {
    return (
      <>
        <section className="mmain">
          <div className="mhead">
            <div>
              <h3>Materials</h3>
              <p>The stock shelf: the material on hand at this location.</p>
            </div>
          </div>
          <div className="mempty" data-testid="manage-materials-absent">
            <h4>{status === 'error' ? 'The shelf could not be read' : 'No house service here'}</h4>
            <p>
              The shelf is kept in the location file the <b>desktop build</b>’s service holds. A page
              served from a web host has no such service.
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
            <h3>Materials</h3>
            <p>
              The stock shelf: what is on hand, how much, and what each piece is — its layers, its
              finish (which decides whether a job faces it first) and its flatness. A job reserves
              what it will cut and uses it up when the run finishes.
            </p>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="manage-stock-add"
              onClick={() => setOpen('new')}
            >
              ＋ Add to the shelf
            </button>
          </div>
        </div>

        {notice !== null && (
          <div className={`mnotice mnotice--${notice.kind}`} data-testid="manage-stock-notice" data-kind={notice.kind}>
            <span>{notice.text}</span>
            <button type="button" onClick={dismissNotice}>
              ×
            </button>
          </div>
        )}

        {unreadable.map((u, i) => (
          <p key={u.id ?? i} className="hint" data-testid="manage-stock-unreadable" data-status="error">
            Entry {u.id ?? '(no id)'} is on the shelf but this build cannot read it: {u.reason}. It is left
            as it is.
          </p>
        ))}

        {items.length === 0 ? (
          <div className="mempty" data-testid="manage-stock-empty">
            <h4>The shelf is empty</h4>
            <p>Add the plates, blocks, rods and printed blanks you have, so a job can start from them.</p>
          </div>
        ) : (
          <table className="tbl" data-testid="manage-stock-table">
            <thead>
              <tr>
                <th style={{ width: '30%' }}>Stock</th>
                <th>Size (mm)</th>
                <th>Colour</th>
                <th>Finish</th>
                <th>Flatness</th>
                <th className="num">On hand</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={open === item.id ? 'sel' : undefined}
                  data-testid={`manage-stock-row-${item.id}`}
                  onClick={() => setOpen(item.id)}
                >
                  <td className="nm">
                    <button
                      type="button"
                      className="tbl__rowbtn"
                      data-testid={`manage-stock-pick-${item.id}`}
                      aria-current={open === item.id ? 'true' : undefined}
                      onClick={() => setOpen(item.id)}
                    >
                      {MATERIAL_LABELS[item.material]} {FORM_LABELS[item.form]}
                      <small>
                        {item.source}
                        {item.conductive ? ' · conductive' : ''} · added {formatDay(item.addedAt) ?? item.addedAt}
                      </small>
                    </button>
                  </td>
                  <td>{sizeLine(item)}</td>
                  <td>{item.layers.length === 0 ? (item.capMm == null ? '—' : `cap ${mm(item.capMm)} (${item.capSource})`) : item.layers.map((l) => `${l.name} ${mm(l.thickness)}`).join(' / ')}</td>
                  <td>{item.finish}</td>
                  <td>{item.flatness === 'domed' ? `domed ${mm(item.domeHeight)}` : item.flatness}</td>
                  <td className={item.quantity === 0 ? 'num dim' : 'num'}>{countLine(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {open === null || gone ? (
        <aside className="context-panel" data-testid="manage-stock-detail-empty">
          <div className="empty">Pick an entry to edit it, or add one to the shelf.</div>
        </aside>
      ) : (
        <StockEditor
          key={open}
          item={selected}
          onClose={() => setOpen(null)}
          onSaved={(id) => setOpen(id)}
        />
      )}
    </>
  );
}

/**
 * The vendor's purchasable sizes as a picker on the ADD form (#466), grouped by the vendor's own
 * material word and labelled with the vendor's own name. Choosing a row calls `onPick` with it; the
 * form then fills the dimensions the row states and NOTHING else — the material, form, finish and
 * quantity stay the user's own choices, because no vendor word is mapped onto `STOCK_MATERIALS` yet.
 *
 * ABSENT IS NOT AN ERROR. A service from before #446 answers 404 and this renders nothing at all:
 * the add form is exactly the one that shipped with #413. A row this build cannot read is set aside
 * with its reason while the readable rows are still offered — the same posture the shelf itself has
 * for an entry it cannot parse. An error on the read is a hint, never a broken form.
 */
function VendorSizePicker({
  form,
  onPick,
}: {
  form: StockForm;
  onPick: (spec: MaterialSpec) => void;
}) {
  const [read, setRead] = useState<MaterialSpecsRead | null>(null);
  const [picked, setPicked] = useState('');

  useEffect(() => {
    // Held so a reply that lands after the editor closed does not set state on an unmounted form.
    let live = true;
    void houseMaterialSpecs().then((next) => {
      if (live) setRead(next);
    });
    return () => {
      live = false;
    };
  }, []);

  if (read === null || read.kind === 'absent') return null;
  if (read.kind === 'error') {
    return (
      <p className="hint" data-testid="manage-stock-vendor-error" data-status="error">
        The vendor’s sizes could not be read: {read.detail}. Type the size in below.
      </p>
    );
  }

  // Grouped in the order the service sent them, under the vendor's word verbatim — the word is a
  // LABEL here, not a claim about which shelf material this is.
  const groups = new Map<string, MaterialSpec[]>();
  for (const spec of read.specs) {
    const rows = groups.get(spec.material);
    if (rows) rows.push(spec);
    else groups.set(spec.material, [spec]);
  }
  const specById = new Map(read.specs.map((spec) => [spec.id, spec]));
  if (groups.size === 0 && read.unreadable.length === 0) return null;

  const pickedSpec = specById.get(picked) ?? null;
  const unstated = pickedSpec === null
    ? []
    : (Object.keys(specSizeFields(pickedSpec)) as SizeField[]).filter((f) => !SIZE_FIELDS[form].includes(f));

  return (
    <>
      {groups.size > 0 && (
        <>
          <div className="panel-subhead">Vendor sizes</div>
          <label className="lf">
            <span>
              pick a size <em>fills its dimensions below</em>
            </span>
            <select
              className="fld"
              value={picked}
              data-testid="manage-stock-vendor-size"
              onChange={(e) => {
                setPicked(e.target.value);
                const spec = specById.get(e.target.value);
                if (spec !== undefined) onPick(spec);
              }}
            >
              <option value="">type the size yourself…</option>
              {[...groups].map(([material, rows]) => (
                <optgroup key={material} label={material}>
                  {rows.map((spec) => (
                    <option
                      key={spec.id}
                      value={spec.id}
                      data-testid={`manage-stock-vendor-option-${spec.id}`}
                    >
                      {spec.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {pickedSpec !== null && unstated.length > 0 && (
            <p className="hint" data-testid="manage-stock-vendor-form-hint">
              This is a {pickedSpec.shape === 'R' ? 'rectangular' : 'round'} size, but the{' '}
              {FORM_LABELS[form]} form has no {unstated.map((f) => SIZE_LABELS[f]).join(' or ')}. Its
              dimensions were filled in — choose a form that carries them to use them.
            </p>
          )}
        </>
      )}
      {read.unreadable.map((u, i) => (
        <p
          key={u.id ?? i}
          className="hint"
          data-testid="manage-stock-vendor-unreadable"
          data-status="error"
        >
          Vendor size {u.id ?? '(no id)'} cannot be offered here: {u.reason}.
        </p>
      ))}
    </>
  );
}

function StockEditor({
  item,
  onClose,
  onSaved,
}: {
  item: StockItem | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const busy = useStockStore((s) => s.busy);
  const add = useStockStore((s) => s.add);
  const replace = useStockStore((s) => s.replace);
  const remove = useStockStore((s) => s.remove);
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  // The entry as it was when this draft was filled from it (#413 review). The draft only carries the
  // fields the form edits, and the rest (reservations, the consumed log) comes from the entry — so a
  // save after the entry changed underneath (a job consumed one, another window edited it, a 412
  // re-read) would pair this window's OLD quantity with the NEW log: a used plate back on the shelf.
  // When that happens an untouched draft is simply refilled, and a touched one is refused until the
  // user reloads it.
  const [seed, setSeed] = useState<StockItem | null>(item);
  const [addedAt] = useState(() => new Date().toISOString());
  const stale = item !== null && seed !== null && JSON.stringify(item) !== JSON.stringify(seed);
  const touched = JSON.stringify(draft) !== JSON.stringify(draftOf(seed));
  // Adjusted during render, React's own pattern for state derived from a changed prop.
  if (stale && !touched) {
    setDraft(draftOf(item));
    setSeed(item);
  }
  const reload = () => {
    setDraft(draftOf(item));
    setSeed(item);
  };
  const candidate = useMemo(() => itemFromDraft(draft, seed, addedAt), [draft, seed, addedAt]);
  const problem = stale
    ? 'this entry changed since you opened it — load the current one before saving'
    : stockProblem(candidate);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  /** A vendor row fills the dimensions it states; every other field of the draft stays the user's. */
  const pickVendorSize = (spec: MaterialSpec) => {
    const fields = specSizeFields(spec);
    setDraft((d) => {
      const size = { ...d.size };
      for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined) size[field as SizeField] = String(value);
      }
      return { ...d, size };
    });
  };

  const save = async () => {
    const ok = item === null ? await add(candidate) : await replace(candidate);
    if (ok) onSaved(candidate.id);
  };

  return (
    <aside className="context-panel" data-testid="manage-stock-detail">
      <div className="panel-head">
        <h3>{item === null ? 'Add to the shelf' : `${MATERIAL_LABELS[item.material]} ${FORM_LABELS[item.form]}`}</h3>
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
            data-testid="manage-stock-material"
            onChange={(e) => {
              const material = e.target.value as StockMaterial;
              // Conductive follows the material when it is picked (metals and a copper-clad PCB yes);
              // still editable below.
              patch({ material, conductive: isConductiveMaterial(material) });
            }}
          >
            {STOCK_MATERIALS.map((m) => (
              <option key={m} value={m}>
                {MATERIAL_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="lf">
          <span>form</span>
          <select
            className="fld"
            value={draft.form}
            data-testid="manage-stock-form"
            onChange={(e) => {
              const form = e.target.value as StockForm;
              patch({ form, layers: formIsFlat(form) ? draft.layers : [] });
            }}
          >
            {STOCK_FORMS.map((f) => (
              <option key={f} value={f}>
                {FORM_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {item === null && <VendorSizePicker form={draft.form} onPick={pickVendorSize} />}

      <div className="panel-subhead">Size, mm</div>
      <div className="grid2">
        {SIZE_FIELDS[draft.form].map((f) => (
          <label className="lf" key={f}>
            <span>{SIZE_LABELS[f]}</span>
            <input
              className="fld fld--num"
              type="number"
              min={0}
              step="any"
              value={draft.size[f]}
              data-testid={`manage-stock-size-${f}`}
              onChange={(e) => patch({ size: { ...draft.size, [f]: e.target.value } })}
            />
          </label>
        ))}
      </div>

      {formIsFlat(draft.form) && (
        <>
          <div className="panel-subhead">Layers, from the top</div>
          {draft.layers.length === 0 && <p className="hint">One material all through. Add layers for a colour stack.</p>}
          {draft.layers.map((l, i) => (
            <div className="grid2" key={i}>
              <label className="lf">
                <span>layer {i + 1}</span>
                <input
                  className="fld fld--text"
                  type="text"
                  value={l.name}
                  placeholder="white"
                  data-testid={`manage-stock-layer-name-${i}`}
                  onChange={(e) =>
                    patch({ layers: draft.layers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                  }
                />
              </label>
              <label className="lf">
                <span>thickness</span>
                <input
                  className="fld fld--num"
                  type="number"
                  min={0}
                  step="any"
                  value={l.thickness}
                  data-testid={`manage-stock-layer-thickness-${i}`}
                  onChange={(e) =>
                    patch({ layers: draft.layers.map((x, j) => (j === i ? { ...x, thickness: e.target.value } : x)) })
                  }
                />
              </label>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => patch({ layers: draft.layers.filter((_, j) => j !== i) })}
              >
                Remove layer
              </button>
            </div>
          ))}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--sm"
              data-testid="manage-stock-layer-add"
              onClick={() => patch({ layers: [...draft.layers, { name: '', thickness: '' }] })}
            >
              ＋ Layer
            </button>
          </div>
          <div className="panel-subhead">Laminate cap</div>
          <p className="hint">
            A bought two-colour sheet states one cap thickness, not printed layers. Leave the cap
            empty for ordinary stock; if you state one, remove the layers above — a laminate has no
            printer grid.
          </p>
          <div className="grid2">
            <label className="lf">
              <span>cap, from the top face (mm)</span>
              <input
                className="fld fld--num"
                type="number"
                min={0}
                step="any"
                value={draft.capMm}
                data-testid="manage-stock-cap-mm"
                onChange={(e) => patch({ capMm: e.target.value })}
              />
            </label>
            <label className="lf">
              <span>cap came from</span>
              <select
                className="fld"
                value={draft.capSource}
                data-testid="manage-stock-cap-source"
                onChange={(e) => patch({ capSource: e.target.value as StockCapSource })}
              >
                {STOCK_CAP_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}

      <div className="panel-subhead">Surface</div>
      <div className="grid2">
        <label className="lf">
          <span>finish</span>
          <select
            className="fld"
            value={draft.finish}
            data-testid="manage-stock-finish"
            title="Rough or unknown: a job faces it first. Finished or printed: it does not."
            onChange={(e) => patch({ finish: e.target.value as Draft['finish'] })}
          >
            {STOCK_FINISHES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="lf">
          <span>flatness</span>
          <select
            className="fld"
            value={draft.flatness}
            data-testid="manage-stock-flatness"
            onChange={(e) => patch({ flatness: e.target.value as Draft['flatness'] })}
          >
            {STOCK_FLATNESS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        {draft.flatness === 'domed' && (
          <label className="lf">
            <span>dome height, mm</span>
            <input
              className="fld fld--num"
              type="number"
              min={0}
              step="any"
              value={draft.domeHeight}
              data-testid="manage-stock-dome"
              onChange={(e) => patch({ domeHeight: e.target.value })}
            />
          </label>
        )}
        <label className="lf">
          <span>conductive</span>
          <input
            type="checkbox"
            checked={draft.conductive}
            data-testid="manage-stock-conductive"
            onChange={(e) => patch({ conductive: e.target.checked })}
          />
        </label>
      </div>

      <div className="panel-subhead">On the shelf</div>
      <div className="grid2">
        <label className="lf">
          <span>quantity</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step={1}
            value={draft.quantity}
            data-testid="manage-stock-quantity"
            onChange={(e) => patch({ quantity: e.target.value })}
          />
        </label>
        <label className="lf">
          <span>from</span>
          <select
            className="fld"
            value={draft.source}
            data-testid="manage-stock-source"
            onChange={(e) => patch({ source: e.target.value as Draft['source'] })}
          >
            {STOCK_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="lf">
        <span>
          notes <em>optional</em>
        </span>
        <input
          className="fld fld--text"
          type="text"
          value={draft.notes}
          placeholder="where it is, what it is for"
          data-testid="manage-stock-notes"
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </label>

      {item !== null && item.reservations.length > 0 && (
        <p className="hint" data-testid="manage-stock-reservations">
          Held for {item.reservations.map((r) => `${r.jobId} (${r.quantity})`).join(', ')}. Only a job
          releases its reservation.
        </p>
      )}

      {problem !== null && (
        <p className="hint" data-testid="manage-stock-problem" data-status="error">
          {problem}
        </p>
      )}
      {stale && (
        <div className="btn-row">
          <button type="button" className="btn btn--sm" data-testid="manage-stock-reload" onClick={reload}>
            Load the current entry
          </button>
        </div>
      )}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="manage-stock-save"
          disabled={problem !== null || busy}
          onClick={() => void save()}
        >
          {item === null ? 'Put on the shelf' : 'Save'}
        </button>
        <span className="spacer" />
        {item !== null && (
          <button
            type="button"
            className="btn btn--sm btn--danger"
            data-testid="manage-stock-remove"
            disabled={busy || item.reservations.length > 0}
            title={item.reservations.length > 0 ? 'A job has reserved this — release it from the job first' : 'Take this entry off the shelf'}
            onClick={() => void remove(item.id).then((ok) => ok && onClose())}
          >
            Remove
          </button>
        )}
      </div>
    </aside>
  );
}
