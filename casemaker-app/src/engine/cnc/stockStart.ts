/**
 * The material-first start (#418, `docs/design/cnc-job-workflow.md` §5.1): what a picked piece of
 * stock does to a new job, or the sentence it is refused with.
 *
 * Three doors lead here, and each one is a pure function from what was chosen to the job's stock:
 *
 *   - **the shelf** (#413) — {@link stockFromShelf}: an entry the location holds;
 *   - **made** — {@link stockFromMade}: a plate, block or sheet typed in the wizard, which can be put
 *     on the shelf as it goes ({@link shelfItemFromMade});
 *   - **a file** — `engine/import/meshStock.ts` reads an STL/3MF; {@link stockFromFile} takes its size.
 *
 * WHAT A JOB'S STOCK CAN BE. `EngraveJob.stock` is a rectangle held in the vise: length × width ×
 * thickness. A sheet, plate, block or printed blank IS that. A rod, tube or disc is not, and its
 * bounding box would plan cuts into air off its edge — so those are refused by name, with where they
 * belong (the rotary), rather than approximated. A sphere is not offered at all (decision Q20); the
 * shelf already refuses one (`SPHERE_REFUSAL`).
 *
 * WHAT IS NOT CARRIED. A shelf entry's `layers` carry a name and a thickness but no layer height, and
 * its `domeHeight` has no direction; the job's `print` and `flatness` need both. Neither is invented:
 * they stay absent and the notes say so. (The two-colour badge is ~1 % of jobs, §8.)
 *
 * The facing default (decision Q6) is {@link facingDefault}; the facing operation itself is #432.
 */

import type { StockItem } from '@/platform/stockClient';
import { isShippedDemoLabelSet } from './engrave/blankLabelSeed';
import type { MillProfile } from './machine';
import { isMetalMaterial, MATERIAL_LABELS } from './materials';
import type { EngraveJob, JobStockEntry, JobStockFinish, JobStockForm, StockMaterial } from '@/types/engraveJob';

/** The rectangular forms a job's stock can take, in the order the wizard offers them. */
export const JOB_STOCK_FORMS: readonly JobStockForm[] = ['plate', 'block', 'sheet', 'printed-blank'];

/** The size of a rectangular stock, mm: length = X, width = Y, thickness = Z. */
export interface StockBox {
  length: number;
  width: number;
  thickness: number;
}

/** What a choice does to the new job: its stock, where it came from, and what to tell the user. */
export interface StockChoice {
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness' | 'material'>;
  entry: JobStockEntry;
  notes: string[];
}

export type StockChoiceResult = { ok: true; choice: StockChoice } | { ok: false; reason: string };

function mm(v: number): string {
  return String(Number(v.toFixed(3)));
}

function isJobForm(form: string): form is JobStockForm {
  return (JOB_STOCK_FORMS as readonly string[]).includes(form);
}

/**
 * Why a form cannot be a job's stock, or null. Round stock is named with where it would go — not
 * "unsupported", which would read as a bug.
 */
export function formProblem(form: string): string | null {
  if (isJobForm(form)) return null;
  if (form === 'rod' || form === 'tube' || form === 'disc') {
    return (
      `a ${form} is round stock — a job here cuts a rectangular block held in the vise, and round ` +
      'stock needs the rotary (not characterised yet, #238), so it is not offered'
    );
  }
  if (form === 'sphere') return 'sphere stock is not offered — nothing at the location holds one and nothing here cuts one';
  return `"${form}" is not a stock form a job can start from`;
}

/** The machine's travel on each axis, mm. */
function travel(machine: MillProfile): StockBox {
  const e = machine.envelope;
  return {
    length: Number((e.x.max - e.x.min).toFixed(3)),
    width: Number((e.y.max - e.y.min).toFixed(3)),
    thickness: Number((e.z.max - e.z.min).toFixed(3)),
  };
}

/**
 * Why a box will not go on this machine, naming the axis, or null (§5.1 validation). A dimension that
 * is not a positive number is named first: it is the one a typed draft gets wrong.
 */
export function boxProblem(box: StockBox, machine: MillProfile): string | null {
  const names = { length: 'length', width: 'width', thickness: 'thickness' } as const;
  for (const key of ['length', 'width', 'thickness'] as const) {
    const v = box[key];
    if (!Number.isFinite(v) || v <= 0) return `the ${names[key]} needs a number in mm, above 0`;
  }
  const t = travel(machine);
  if (box.length > t.length) {
    return `${mm(box.length)} mm long is more than the ${machine.name}'s ${mm(t.length)} mm X travel`;
  }
  if (box.width > t.width) {
    return `${mm(box.width)} mm wide is more than the ${machine.name}'s ${mm(t.width)} mm Y travel`;
  }
  if (box.thickness > t.thickness) {
    return `${mm(box.thickness)} mm thick is more than the ${machine.name}'s ${mm(t.thickness)} mm Z travel`;
  }
  return null;
}

/** How many of an entry are free — on the shelf and not held for another job. */
function free(item: StockItem): number {
  return item.quantity - item.reservations.reduce((a, r) => a + r.quantity, 0);
}

/**
 * Why a shelf entry cannot start this job, or null. Shown beside the entry, which stays listed: a
 * piece that is used up or held is a fact about the shelf the operator should see, not a gap (§5.1).
 */
export function shelfPickProblem(item: StockItem, machine: MillProfile): string | null {
  if (item.quantity === 0) {
    const last = item.consumed[item.consumed.length - 1];
    return last ? `none left — consumed by ${last.jobId}` : 'none left on the shelf';
  }
  if (free(item) <= 0) return `all ${item.quantity} held for other jobs`;
  const form = formProblem(item.form);
  if (form !== null) return form;
  return boxProblem(
    { length: item.size.length ?? Number.NaN, width: item.size.width ?? Number.NaN, thickness: item.size.thickness ?? Number.NaN },
    machine,
  );
}

/** A shelf entry as this job's stock, or why not. */
export function stockFromShelf(item: StockItem, machine: MillProfile): StockChoiceResult {
  const problem = shelfPickProblem(item, machine);
  if (problem !== null) return { ok: false, reason: problem };
  const form = item.form as JobStockForm;
  const notes = [
    `${formLabel(form)} ${mm(item.size.length!)} × ${mm(item.size.width!)} × ${mm(item.size.thickness!)} mm of ` +
      `${MATERIAL_LABELS[item.material]}, from the shelf (${item.id}). Cut mode reserves it; nothing is held until then.`,
  ];
  if (item.layers.length > 0) {
    notes.push(
      `Its ${item.layers.length} layers (${item.layers.map((l) => l.name).join(', ')}) are not carried onto the job: ` +
        'the shelf records no layer height, and the job will not invent one.',
    );
  }
  if (item.flatness === 'domed') {
    notes.push(
      `It is recorded as domed ${item.domeHeight ?? '?'} mm; the job does not carry the dome yet (the shelf does not say across which side).`,
    );
  }
  return {
    ok: true,
    choice: {
      stock: {
        length: item.size.length!,
        width: item.size.width!,
        thickness: item.size.thickness!,
        material: item.material,
      },
      entry: { kind: 'shelf', shelfId: item.id, file: null, form, finish: item.finish, conductive: item.conductive },
      notes,
    },
  };
}

/** A piece typed in the wizard. */
export interface MadeStock extends StockBox {
  form: JobStockForm;
  material: StockMaterial;
  finish: JobStockFinish;
}

/** A typed piece as this job's stock, or why not. `shelfId` is the entry it was also saved as. */
export function stockFromMade(made: MadeStock, machine: MillProfile, shelfId: string | null = null): StockChoiceResult {
  const problem = formProblem(made.form) ?? boxProblem(made, machine);
  if (problem !== null) return { ok: false, reason: problem };
  return {
    ok: true,
    choice: {
      stock: { length: made.length, width: made.width, thickness: made.thickness, material: made.material },
      entry: {
        kind: 'made',
        shelfId,
        file: null,
        form: made.form,
        finish: made.finish,
        conductive: isMetalMaterial(made.material),
      },
      notes: [
        `${formLabel(made.form)} ${mm(made.length)} × ${mm(made.width)} × ${mm(made.thickness)} mm of ` +
          `${MATERIAL_LABELS[made.material]}, as typed${shelfId ? `, and put on the shelf (${shelfId})` : ''}.`,
      ],
    },
  };
}

/**
 * The shelf entry a typed piece becomes when "also put it on the shelf" is ticked. Quantity 1, and
 * flatness `unknown`: nobody has said how flat it is, and `unknown` is its own answer (#345).
 * Conductive follows the material — a metal is, a plastic or wood is not — as the shelf's own
 * editor seeds it.
 */
export function shelfItemFromMade(made: MadeStock, id: string, now: string): StockItem {
  return {
    id,
    material: made.material,
    form: made.form,
    size: { length: made.length, width: made.width, thickness: made.thickness },
    layers: [],
    finish: made.finish,
    flatness: 'unknown',
    domeHeight: null,
    conductive: isMetalMaterial(made.material),
    quantity: 1,
    reservations: [],
    consumed: [],
    source: made.form === 'printed-blank' ? 'printed' : 'purchased',
    notes: null,
    addedAt: now,
  };
}

/** A file read as stock (`meshAsStock`), with the material the operator chose. */
export interface FileStock extends StockBox {
  name: string;
  sha256: string;
  material: StockMaterial;
  finish: JobStockFinish;
}

/** A mesh's box as this job's stock, or why not. Its form is a block (a printed one when printed). */
export function stockFromFile(file: FileStock, machine: MillProfile): StockChoiceResult {
  const problem = boxProblem(file, machine);
  if (problem !== null) return { ok: false, reason: problem };
  const form: JobStockForm = file.finish === 'printed' ? 'printed-blank' : 'block';
  return {
    ok: true,
    choice: {
      stock: { length: file.length, width: file.width, thickness: file.thickness, material: file.material },
      entry: {
        kind: 'file',
        shelfId: null,
        file: { name: file.name, sha256: file.sha256 },
        form,
        finish: file.finish,
        conductive: isMetalMaterial(file.material),
      },
      notes: [
        `${mm(file.length)} × ${mm(file.width)} × ${mm(file.thickness)} mm, read from ${file.name} — its bounding box, ` +
          `in ${MATERIAL_LABELS[file.material]}.`,
      ],
    },
  };
}

/**
 * Whether the job should face the stock first, from its finish (decision Q6): rough or unknown → on;
 * a finished sheet or a printed blank → off. Always overridable — this is the DEFAULT, and the reason
 * is part of the answer so the screen can say why.
 */
export function facingDefault(finish: JobStockFinish): { on: boolean; reason: string } {
  switch (finish) {
    case 'rough':
      return { on: true, reason: 'rough stock is faced first, so the top is flat and Z0 is on a cut surface' };
    case 'unknown':
      return { on: true, reason: 'the finish is not known, so it is faced first' };
    case 'finished':
      return { on: false, reason: 'a finished face is cut as it is' };
    case 'printed':
      return { on: false, reason: 'a printed blank is cut as printed — facing would cut into its top layer' };
  }
}

const FORM_LABELS: Record<JobStockForm, string> = {
  plate: 'Plate',
  block: 'Block',
  sheet: 'Sheet',
  'printed-blank': 'Printed blank',
};

/** `Plate`, `Printed blank` — the form as a sentence starts it. */
export function formLabel(form: JobStockForm): string {
  return FORM_LABELS[form];
}

/** The shelf entries for this material, in shelf order — the list the wizard's shelf door shows. */
export function shelfFor(items: readonly StockItem[], material: StockMaterial): StockItem[] {
  return items.filter((i) => i.material === material);
}

/**
 * How many items the job holds that a person put there — what starting a new job would throw away
 * (#418 review). The shipped demo lines are the app's own, not the person's, so they do not count.
 */
export function jobItemCount(job: EngraveJob): number {
  const labels = isShippedDemoLabelSet(job) ? 0 : job.labels.length;
  return (
    labels +
    job.shapes.length +
    (job.combined?.length ?? 0) +
    (job.traces?.length ?? 0) +
    (job.vectors?.length ?? 0) +
    (job.drills?.length ?? 0) +
    (job.keepOuts?.length ?? 0)
  );
}

/**
 * Does `next` still hold the stock `prev` named an entry for? (#418 review) The entry describes a
 * size and a material; an edit to any of the four means the job's stock is no longer that entry.
 * Provenance, print and flatness are not the piece's identity and do not count.
 */
export function stockStillNamed(prev: EngraveJob['stock'], next: EngraveJob['stock']): boolean {
  return (
    prev.length === next.length &&
    prev.width === next.width &&
    prev.thickness === next.thickness &&
    prev.material === next.material
  );
}
