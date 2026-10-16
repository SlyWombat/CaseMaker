import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { jobMachine } from '@/engine/cnc/calibration';
import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import {
  JOB_STOCK_FORMS,
  facingDefault,
  formLabel,
  shelfFor,
  shelfItemFromMade,
  shelfPickProblem,
  stockFromFile,
  stockFromMade,
  stockFromShelf,
  type StockChoice,
} from '@/engine/cnc/stockStart';
import { readStockFile, type StockFileRead } from '@/engine/import/meshStock';
import { featureSim } from '@/platform/features';
import { SIZE_FIELDS, stockProblem, type StockItem } from '@/platform/stockClient';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { newStockId, useStockStore } from '@/store/stockStore';
import type { JobStockFinish, JobStockForm, StockMaterial } from '@/types/engraveJob';

/**
 * Step 2 of the start wizard (#418, §5.1): **the material first, then where the stock comes from.**
 *
 * Three doors, in §5.1's order: the shelf (#413), a piece typed here (optionally put on the shelf as
 * it goes), and an STL/3MF used as the stock. The fourth door — Makera's own sizes from the synced
 * catalogue — has nothing to read yet, and is not drawn rather than drawn empty.
 *
 * This component only DECIDES: it hands the wizard a {@link PendingStock} and the wizard applies it.
 * Every rule is in `engine/cnc/stockStart.ts` and `engine/import/meshStock.ts`.
 */

/** What the wizard applies when "Next: mount" is pressed. */
export type PendingStock =
  | { kind: 'choice'; choice: StockChoice; saveToShelf: StockItem | null }
  /** A PrusaSlicer project with negative volumes: the stock AND the design, through #410's reader. */
  | { kind: 'design'; file: File; sha256: string };

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const NOTE: CSSProperties = { ...MUTED, borderLeft: '2px solid #3a5a7a', paddingLeft: 6 };
const REFUSED: CSSProperties = { ...MUTED, color: '#f0b4ad' };
const ROW: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0' };
const NUM: CSSProperties = { width: 64 };

type Door = 'shelf' | 'make' | 'load';

const FINISH_LABELS: Record<JobStockFinish, string> = {
  rough: 'rough (sawn, as bought)',
  finished: 'finished face',
  printed: 'printed',
  unknown: 'not known',
};
const FINISHES: readonly JobStockFinish[] = ['rough', 'finished', 'printed', 'unknown'];

function mm(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : String(Number(v.toFixed(3)));
}

/** `plate 100 × 100 × 5` / `rod ⌀10 × 100` — an entry as the list names it. */
function entryLine(item: StockItem): string {
  const size = SIZE_FIELDS[item.form]
    .map((f) => (f === 'diameter' || f === 'innerDiameter' ? `⌀${mm(item.size[f])}` : mm(item.size[f])))
    .join(' × ');
  const free = item.quantity - item.reservations.reduce((a, r) => a + r.quantity, 0);
  return `${item.form} ${size} · ×${item.quantity}${free < item.quantity ? ` (${free} free)` : ''} · ${item.finish}`;
}

export function StartStockStep({
  onChange,
}: {
  /** The current answer, or null when there is none yet (or the one there is was refused). */
  onChange: (pending: PendingStock | null) => void;
}): JSX.Element {
  const machineId = useEngraveJobStore((s) => s.job.machineId);
  const jobMaterial = useEngraveJobStore((s) => s.job.stock.material);
  // Memoised on the id: a fresh profile object per render would re-run every rule below, and the
  // effect that tells the wizard would then fire on every render.
  const machine = useMemo(() => jobMachine({ machineId }), [machineId]);
  const shelfStatus = useStockStore((s) => s.status);
  const shelfReason = useStockStore((s) => s.reason);
  const items = useStockStore((s) => s.items);
  const refresh = useStockStore((s) => s.refresh);

  const materials = useMemo(() => materialOptionsFor(machine), [machine]);
  const [material, setMaterial] = useState<StockMaterial>(() =>
    materials.some((m) => m.value === jobMaterial) ? jobMaterial : (materials[0]?.value ?? 'softwood'),
  );
  const [door, setDoor] = useState<Door>('shelf');
  const [shelfId, setShelfId] = useState<string | null>(null);
  const [form, setForm] = useState<JobStockForm>('plate');
  const [dims, setDims] = useState({ length: '', width: '', thickness: '' });
  const [finish, setFinish] = useState<JobStockFinish>('unknown');
  const [save, setSave] = useState(false);
  // One id for the entry a kept piece becomes, drawn once — not on every recompute of the answer.
  const [newId] = useState(() => newStockId());
  const [fileRead, setFileRead] = useState<{ read: StockFileRead; file: File } | null>(null);
  const [reading, setReading] = useState(false);

  // The wizard reads the shelf itself: Manage › Materials is the only other reader, and it may never
  // have been opened in this window.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shelf = useMemo(() => shelfFor(items, material), [items, material]);
  const shelfOk = shelfStatus === 'present';

  // The answer, and the sentence it is refused with — recomputed from the inputs, never stored, so a
  // change of material or a shelf re-read cannot leave a stale choice standing.
  const outcome = useMemo((): { pending: PendingStock | null; problem: string | null; notes: string[]; finish: JobStockFinish | null } => {
    if (door === 'shelf') {
      const item = shelf.find((i) => i.id === shelfId);
      if (!item) return { pending: null, problem: null, notes: [], finish: null };
      const r = stockFromShelf(item, machine);
      return r.ok
        ? { pending: { kind: 'choice', choice: r.choice, saveToShelf: null }, problem: null, notes: r.choice.notes, finish: r.choice.entry.finish }
        : { pending: null, problem: r.reason, notes: [], finish: null };
    }
    if (door === 'make') {
      if (dims.length === '' && dims.width === '' && dims.thickness === '') {
        return { pending: null, problem: null, notes: [], finish: null };
      }
      const num = (t: string) => (t.trim() === '' ? Number.NaN : Number(t));
      const made = { form, material, finish, length: num(dims.length), width: num(dims.width), thickness: num(dims.thickness) };
      // A tick that cannot be honoured (no shelf in this instance) is not an answer.
      const id = save && shelfOk ? newId : null;
      const r = stockFromMade(made, machine, id);
      if (!r.ok) return { pending: null, problem: r.reason, notes: [], finish: null };
      let item: StockItem | null = null;
      if (id !== null) {
        item = shelfItemFromMade(made, id, new Date().toISOString());
        const why = stockProblem(item);
        if (why !== null) return { pending: null, problem: `it cannot go on the shelf: ${why}`, notes: [], finish: null };
      }
      return { pending: { kind: 'choice', choice: r.choice, saveToShelf: item }, problem: null, notes: r.choice.notes, finish };
    }
    if (fileRead === null) return { pending: null, problem: null, notes: [], finish: null };
    const { read, file } = fileRead;
    if (read.kind === 'refused') return { pending: null, problem: `${read.name}: ${read.reason}`, notes: [], finish: null };
    if (read.kind === 'design') {
      if (!featureSim) {
        return {
          pending: null,
          problem: `${read.name} is a PrusaSlicer project with ${read.negativeVolumes} cut volumes — reading a design needs the simulator, which is not enabled in this build`,
          notes: [],
          finish: null,
        };
      }
      return {
        pending: { kind: 'design', file, sha256: read.sha256 },
        problem: null,
        notes: [
          `${read.name} is a PrusaSlicer project with ${read.negativeVolumes} cut volume${read.negativeVolumes === 1 ? '' : 's'}: ` +
            'its blank becomes the stock (PLA) and its cut volumes the design, in one step.',
        ],
        finish: 'printed',
      };
    }
    const r = stockFromFile({ ...read, material, finish }, machine);
    return r.ok
      ? { pending: { kind: 'choice', choice: r.choice, saveToShelf: null }, problem: null, notes: r.choice.notes, finish }
      : { pending: null, problem: r.reason, notes: [], finish: null };
  }, [door, shelf, shelfId, machine, dims, form, material, finish, save, shelfOk, newId, fileRead]);

  // Tell the wizard. Keyed on the pending answer's identity: `outcome` is a fresh object on every
  // input change, which is exactly when the wizard should hear about it.
  useEffect(() => {
    onChange(outcome.pending);
  }, [outcome, onChange]);

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setReading(true);
    try {
      const read = await readStockFile(file);
      setFileRead({ read, file });
      // A printed blank is the usual reason to load a mesh as stock; say so as the default finish.
      if (read.kind === 'mesh' && finish === 'unknown' && (material === 'pla' || material === 'abs')) setFinish('printed');
    } finally {
      setReading(false);
    }
  }

  const facing = outcome.finish === null ? null : facingDefault(outcome.finish);

  return (
    <div data-testid="start-wizard-step-stock" style={{ marginTop: 8 }}>
      <label style={{ ...MUTED, display: 'block' }}>
        <span>Material — first, because it decides the feeds and which stock is on offer</span>
        <select
          data-testid="start-wizard-stock-material"
          aria-label="Stock material"
          value={material}
          onChange={(e) => {
            setMaterial(e.target.value as StockMaterial);
            setShelfId(null);
          }}
          style={{ display: 'block', width: '100%', marginTop: 2 }}
        >
          {materials.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div role="radiogroup" aria-label="Where the stock comes from" style={ROW}>
        {(
          [
            ['shelf', 'On the shelf'],
            ['make', 'Type a piece'],
            ['load', 'Load STL / 3MF'],
          ] as const
        ).map(([id, label]) => (
          <label key={id} style={{ ...MUTED, display: 'flex', gap: 3, alignItems: 'center' }}>
            <input
              type="radio"
              name="start-wizard-stock-door"
              data-testid={`start-wizard-stock-door-${id}`}
              checked={door === id}
              onChange={() => setDoor(id)}
            />
            {label}
          </label>
        ))}
      </div>

      {door === 'shelf' && (
        <div data-testid="start-wizard-shelf">
          {shelfStatus === 'unknown' && (
            <p style={MUTED} data-testid="start-wizard-shelf-state" data-state="loading">
              Reading the shelf…
            </p>
          )}
          {(shelfStatus === 'absent' || shelfStatus === 'error') && (
            <p style={NOTE} data-testid="start-wizard-shelf-state" data-state={shelfStatus}>
              {shelfStatus === 'absent'
                ? 'This instance has no shop service, so there is no shelf to pick from — type the piece instead, or load a file.'
                : `The shelf could not be read: ${shelfReason ?? 'no detail was given'}.`}
            </p>
          )}
          {shelfOk && shelf.length === 0 && (
            <p style={MUTED} data-testid="start-wizard-shelf-state" data-state="empty">
              Nothing in {MATERIAL_LABELS[material]} on the shelf. Type the piece, and tick "put it on the shelf" to keep it.
            </p>
          )}
          {shelfOk && shelf.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {shelf.map((item) => {
                const why = shelfPickProblem(item, machine);
                const picked = shelfId === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-testid={`start-wizard-shelf-item-${item.id}`}
                      data-state={why === null ? 'ok' : 'refused'}
                      aria-pressed={picked}
                      disabled={why !== null}
                      onClick={() => setShelfId(item.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: 4,
                        border: picked ? '1px solid #5a8abf' : undefined,
                        opacity: why === null ? 1 : 0.6,
                      }}
                    >
                      <div style={{ fontSize: 12, color: '#cfe' }}>{entryLine(item)}</div>
                      {item.notes && <div style={MUTED}>{item.notes}</div>}
                      {why !== null && (
                        <div style={REFUSED} data-testid={`start-wizard-shelf-item-${item.id}-reason`}>
                          {why}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {door === 'make' && (
        <div data-testid="start-wizard-make">
          <div style={ROW}>
            <select
              data-testid="start-wizard-make-form"
              aria-label="Stock form"
              value={form}
              onChange={(e) => setForm(e.target.value as JobStockForm)}
            >
              {JOB_STOCK_FORMS.map((f) => (
                <option key={f} value={f}>
                  {formLabel(f).toLowerCase()}
                </option>
              ))}
            </select>
            {(['length', 'width', 'thickness'] as const).map((key) => (
              <label key={key} style={{ ...MUTED, display: 'flex', gap: 3, alignItems: 'center' }}>
                {key === 'length' ? 'L (X)' : key === 'width' ? 'W (Y)' : 'T'}
                <input
                  type="number"
                  min={0}
                  step="any"
                  style={NUM}
                  data-testid={`start-wizard-make-${key}`}
                  aria-label={`Stock ${key}`}
                  value={dims[key]}
                  onChange={(e) => setDims((d) => ({ ...d, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <p style={MUTED}>
            Rod, tube and disc are not offered: a job here cuts a rectangular block held in the vise, and round stock
            needs the rotary (#238). Sphere stock is not offered at all.
          </p>
          <label style={{ ...MUTED, display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              data-testid="start-wizard-make-save"
              checked={save && shelfOk}
              disabled={!shelfOk}
              onChange={(e) => setSave(e.target.checked)}
            />
            also put it on the shelf
            {!shelfOk && <span> — no shelf in this instance</span>}
          </label>
        </div>
      )}

      {door === 'load' && (
        <div data-testid="start-wizard-load">
          <input
            type="file"
            accept=".stl,.3mf"
            data-testid="start-wizard-load-file"
            aria-label="Stock file"
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
            }}
          />
          <p style={MUTED}>
            A closed, prismatic, rectangular mesh is cut as a block of its size. A PrusaSlicer project with negative
            volumes is offered as the stock and the design in one step. A shaped (3D) blank is refused until #222.
          </p>
          {reading && (
            <p style={MUTED} data-testid="start-wizard-load-reading">
              Reading the file…
            </p>
          )}
        </div>
      )}

      {(door === 'make' || (door === 'load' && fileRead?.read.kind === 'mesh')) && (
        <label style={{ ...MUTED, display: 'flex', gap: 4, alignItems: 'center' }}>
          Finish
          <select
            data-testid="start-wizard-stock-finish"
            aria-label="Stock finish"
            value={finish}
            onChange={(e) => setFinish(e.target.value as JobStockFinish)}
          >
            {FINISHES.map((f) => (
              <option key={f} value={f}>
                {FINISH_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
      )}

      {outcome.problem !== null && (
        <p style={REFUSED} data-testid="start-wizard-stock-problem">
          {outcome.problem}
        </p>
      )}
      {outcome.notes.length > 0 && (
        <div data-testid="start-wizard-stock-summary">
          {outcome.notes.map((n, i) => (
            <p key={i} style={NOTE}>
              {n}
            </p>
          ))}
        </div>
      )}
      {facing !== null && (
        <p style={MUTED} data-testid="start-wizard-stock-facing" data-state={facing.on ? 'on' : 'off'}>
          Facing: {facing.on ? 'on' : 'off'} by default — {facing.reason}. The facing pass itself is still to come
          (#432).
        </p>
      )}
    </div>
  );
}
