import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { jobMachine } from '@/engine/cnc/calibration';
import { isShippedDemoLabelSet } from '@/engine/cnc/engrave/blankLabelSeed';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import type { Mill } from '@/engine/cnc/machine';
import {
  MATERIAL_LABELS,
  isCompositeMaterial,
  isMetalMaterial,
  isPlasticMaterial,
  isPrintedBlankMaterial,
  isWoodMaterial,
} from '@/engine/cnc/materials';
import {
  PCB_COPPER_MM,
  ROD_VISE_MAX_LENGTH_MM,
  STOCK_SIZE_FIELDS,
  boxForForm,
  facingShopFrom,
  formLabel,
  formSizeProblem,
  isJobForm,
  rodGripProblem,
  rotaryEnvelopeOf,
  shelfFor,
  shelfItemFromMade,
  shelfPickProblem,
  stockFromFile,
  stockFromMade,
  stockFromShelf,
  type StockChoice,
  type StockSize,
  type StockSizeKey,
} from '@/engine/cnc/stockStart';
import { readStockFile, type StockFileRead } from '@/engine/import/meshStock';
import { SELECTED_FILL } from '@/components/selectionChip';
import { featureSim } from '@/platform/features';
import { stockProblem, type StockItem } from '@/platform/stockClient';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { newStockId, useStockStore } from '@/store/stockStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import type { JobStockFinish, JobStockForm, StockMaterial } from '@/types/engraveJob';
import { facingForSeat, fmt } from './holdingMounts';
import { NARROW_QUERY } from './wizardLayout';
import { WizardFileField } from './WizardFileField';

/**
 * The stock step of the one cutting-job wizard (#683): **the stock, in one screen.**
 *
 * Material first — the house's own by default, grouped Plastics / Woods / Metals. The form is a
 * picture with one defining sentence; the size is the panel's `length X · width Y · thickness Z`,
 * with `mm` on every field. Finish is one line. The shelf is drawn only when it holds something for
 * this material, and "keep this piece on the shelf" is a tick beside the size. A file is a drop
 * target with one sentence.
 *
 * This component only DECIDES: it hands the wizard a {@link PendingStock} and the wizard applies it.
 * Every rule is in `engine/cnc/stockStart.ts` and `engine/import/meshStock.ts`.
 *
 * Copy is the mockup's (`docs/design/first-job-flow-mockups.html`, station 2), including the
 * wording correction of 2026-10-26: a sheet is thin stock held on a waste board between the jaws or
 * taped to the bed — how it is held is Holding's answer, worked out from the numbers.
 */

/** What the wizard applies when the stock step is left. */
export type PendingStock =
  | { kind: 'choice'; choice: StockChoice; saveToShelf: StockItem | null }
  /** A PrusaSlicer project with negative volumes: the stock AND the design, through #410's reader. */
  | { kind: 'design'; file: File; sha256: string };

/**
 * #681 — where the stock step STARTS, when the wizard was re-opened from the panel's Stock `edit`.
 * The current job's own numbers, so an edit is an edit and not a retype; an absent seed is the
 * new-job flow (nothing chosen).
 *
 * A round form's seed carries the form's STANDING box: a disc's diameter is its `length` and its
 * thickness is its `thickness`; a rod or tube stands on its end, so its diameter is its `length`
 * (and its `width`) and its own length is its `thickness` (`stockStart.ts`'s `boxForForm`). The
 * wizard normalises a job's axis-frame rod to that box before seeding. {@link dimsFromSeed} reads
 * the numbers back into the form's own fields; a tube's wall is the job's own `stock.wall`.
 */
export interface StartStockSeed {
  form: JobStockForm;
  material: StockMaterial;
  length: number;
  width: number;
  thickness: number;
  /** A tube's wall, mm (#713); absent for every other form. */
  wall?: number;
  finish: JobStockFinish;
  /**
   * All three dims are the app's own derivation (`computed`), not a typed or measured answer — the
   * template hand-off's stamp. The step says so until one of them is edited (#352's sentence).
   */
  computed?: boolean;
  /**
   * #897 — where a proposed blank came from, in the work's own terms ("Sized from the mesh: …").
   * Shown where the template sentence is, and gone the moment a number is edited, for the same
   * reason: after that the numbers are the operator's.
   */
  sentence?: string;
}

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const NOTE: CSSProperties = { ...MUTED, borderLeft: '2px solid #3a5a7a', paddingLeft: 6 };
const REFUSED: CSSProperties = { ...MUTED, color: '#f0b4ad' };
const NUM: CSSProperties = { width: 72 };
// #875 — equal-width form buttons: four columns on the phone (4 + 3), one row on a desktop.
const FORMS: CSSProperties = { display: 'grid', gap: 6, margin: '4px 0', alignItems: 'stretch' };
const FORM_BUTTON: CSSProperties = {
  display: 'grid',
  justifyItems: 'center',
  gap: 2,
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 2px 4px',
  fontSize: 10,
  lineHeight: 1.2,
  color: '#cfe',
  background: 'transparent',
  // Longhands: the shared ON fill names `borderColor` (#874).
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#2a2f36',
  borderRadius: 4,
  cursor: 'pointer',
};
// #874 — the same ON fill every selected chip uses; the button keeps its own icon-and-word shape.
const FORM_BUTTON_ON: CSSProperties = { ...FORM_BUTTON, ...SELECTED_FILL };
// #875 — the size fields: label above the field, three columns on a desktop; on the phone two
// columns with the thickness spanning the row, so every field and its `mm` is fully visible.
const SIZE_FIELDS: CSSProperties = { display: 'grid', gap: 10, margin: '6px 0', alignItems: 'end' };
const SIZE_FIELD: CSSProperties = { ...MUTED, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2 };
const SIZE_UNIT_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4 };
const SIZE_INPUT: CSSProperties = { width: '100%', boxSizing: 'border-box' };

/** #870 — a stock file's one fact beside its name: the box (or rim) it measures. */
function fileFact(read: StockFileRead): string | null {
  if (read.kind !== 'mesh') return null;
  return read.shape === 'disc'
    ? `⌀${fmt(read.length)} × ${fmt(read.thickness)} mm`
    : `${fmt(read.length)} × ${fmt(read.width)} × ${fmt(read.thickness)} mm`;
}

/** The finish as the step offers it: "as bought" first, because it is the default (#683, A8). */
const FINISH_OPTIONS: readonly { value: JobStockFinish; label: string }[] = [
  { value: 'rough', label: 'as bought' },
  { value: 'finished', label: 'finished face' },
  { value: 'printed', label: 'printed' },
  { value: 'unknown', label: 'not known' },
];
const FINISH_HINT = 'plastic is cut as it is; wood and metal are faced first';

interface FormDef {
  id: JobStockForm;
  /** The word under the picture. */
  word: string;
}

/** The seven forms, in the mockup's order (`docs/design/rotary-flow-mockups.html`, station 2). */
const FORM_DEFS: readonly FormDef[] = [
  { id: 'plate', word: 'Plate' },
  { id: 'block', word: 'Block' },
  { id: 'sheet', word: 'Sheet' },
  { id: 'printed-blank', word: 'Printed blank' },
  { id: 'disc', word: 'Disc' },
  { id: 'rod', word: 'Rod' },
  { id: 'tube', word: 'Tube' },
];

/**
 * The one sentence under the pictures when a form is picked — the mockup's words, character for
 * character (`docs/design/rotary-flow.md` §3.3). The block and the envelope refusals carry the
 * module's OWN numbers, so a different rotary states its own; the Z1's ⌀80 × 150 is the profile's.
 */
function formSentence(form: JobStockForm, machine: Mill): string {
  switch (form) {
    case 'plate':
      return 'Plate — flat stock cut from the top; thicker than a sheet, lower than it is wide. How it is held is worked out in the next step from its numbers.';
    case 'block': {
      const env = rotaryEnvelopeOf(machine);
      return `Block — squared stock: in the vise as today, or in the chuck when its diagonal fits ⌀${fmt(env.diameter)} × ${fmt(env.length)}.`;
    }
    case 'sheet':
      return 'Sheet — thin stock; in the vise on a waste board between the jaws, or taped to the bed.';
    case 'printed-blank':
      return 'Printed blank — from a printer; layers known.';
    case 'disc':
      return 'Disc — round stock. A short disc sits in the vise or on tape for a face job; a disc cut around needs the rotary (step 4 will offer it).';
    case 'rod':
      return `Rod — round stock: a dowel, a rod. A rod up to ${fmt(ROD_VISE_MAX_LENGTH_MM)} mm long stands on its end in the vise; a longer one is held in the rotary chuck and cut around (step 4 offers it).`;
    case 'tube':
      return 'Tube — round stock with a bore. Held in the rotary chuck and cut around; no cut goes deeper than its wall.';
  }
}

/** The field word beside each input — the panel's words, with the axis and the round case. */
const SIZE_LABELS: Readonly<Record<StockSizeKey, string>> = {
  length: 'length X',
  width: 'width Y',
  thickness: 'thickness Z',
  diameter: 'diameter ⌀',
  wall: 'wall',
};

const SIZE_KEYS: readonly StockSizeKey[] = ['length', 'width', 'thickness', 'diameter', 'wall'];
type DimState = Record<StockSizeKey, string>;
const EMPTY_DIMS: DimState = { length: '', width: '', thickness: '', diameter: '', wall: '' };

function text(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(Number(v.toFixed(3)));
}

/** A seed's numbers as the form's own fields. A round form's numbers are in the seed's box. */
function dimsFromSeed(seed?: StartStockSeed): DimState {
  if (seed === undefined) return EMPTY_DIMS;
  if (seed.form === 'disc') return { ...EMPTY_DIMS, diameter: text(seed.length), thickness: text(seed.thickness) };
  if (seed.form === 'rod' || seed.form === 'tube') {
    return {
      ...EMPTY_DIMS,
      diameter: text(seed.length),
      wall: text(seed.wall),
      length: text(seed.thickness),
    };
  }
  return { ...EMPTY_DIMS, length: text(seed.length), width: text(seed.width), thickness: text(seed.thickness) };
}

/** A shelf entry's numbers as the form's own fields. */
function dimsFromItem(item: StockItem): DimState {
  const s = item.size;
  if (item.form === 'disc') return { ...EMPTY_DIMS, diameter: text(s.diameter), thickness: text(s.thickness) };
  if (item.form === 'rod' || item.form === 'tube') {
    return { ...EMPTY_DIMS, diameter: text(s.diameter), wall: text(s.wall), length: text(s.length) };
  }
  return { ...EMPTY_DIMS, length: text(s.length), width: text(s.width), thickness: text(s.thickness) };
}

/** The typed fields as numbers; a blank field is absent, a refused one is NaN (and so refused). */
function toSize(dims: DimState): StockSize {
  const size: StockSize = {};
  for (const key of SIZE_KEYS) {
    const t = dims[key].trim();
    if (t !== '') size[key] = Number(t);
  }
  return size;
}

/** `plate 76.2 × 38.1 × 3.81 mm` / `disc ⌀50 × 5 mm` / `tube ⌀25 × 120 mm, wall 3 mm` — a shelf row. */
function sizeText(item: StockItem): string {
  const s = item.size;
  if (item.form === 'disc') return `⌀${text(s.diameter)} × ${text(s.thickness)} mm`;
  if (item.form === 'tube') return `⌀${text(s.diameter)} × ${text(s.length)} mm, wall ${text(s.wall)} mm`;
  if (item.form === 'rod') return `⌀${text(s.diameter)} × ${text(s.length)} mm`;
  return `${text(s.length)} × ${text(s.width)} × ${text(s.thickness)} mm`;
}

/**
 * The circumference of a round form's surface, mm (#713): the map's height in §3.7 and the number
 * the operator lays text against. `Around: 62.832 mm at the surface` for ⌀20. Null until a
 * positive diameter is typed.
 */
function aroundLine(form: JobStockForm, dims: DimState): string | null {
  if (form !== 'rod' && form !== 'tube') return null;
  const diameter = Number(dims.diameter);
  if (dims.diameter.trim() === '' || !Number.isFinite(diameter) || diameter <= 0) return null;
  return `Around: ${fmt(2 * Math.PI * (diameter / 2))} mm at the surface`;
}

/**
 * The house's material, as the step opens (#683, A4). A fresh profile must not open on some
 * other shop's last choice: the house's own material is hardwood — the app's flagship blank is a
 * hardwood name plate and cutting printed plastic is not where a person starts. A job the person
 * has actually made states the house's last material; the untouched demo does not.
 */
function houseMaterial(
  options: readonly { value: StockMaterial }[],
  job: { material: StockMaterial; labels: Parameters<typeof isShippedDemoLabelSet>[0]['labels'] },
  seed?: StartStockSeed,
): StockMaterial {
  const offered = (m: StockMaterial): boolean => options.some((o) => o.value === m);
  if (seed !== undefined && offered(seed.material)) return seed.material;
  const shipped = defaultEngraveJob();
  const untouchedDemo = isShippedDemoLabelSet(job) && job.material === shipped.stock.material;
  if (!untouchedDemo && offered(job.material)) return job.material;
  if (offered('hardwood')) return 'hardwood';
  return options[0]?.value ?? shipped.stock.material;
}

interface MaterialGroup {
  label: string;
  options: { value: StockMaterial; label: string }[];
}

/**
 * The material list in three families (#683, A5). "plastic (unspecified)" goes LAST in Plastics —
 * it is the bought laminate's material, the one word that says nothing about what it is.
 */
function groupMaterials(options: readonly { value: StockMaterial; label: string }[]): MaterialGroup[] {
  const plastics = options.filter((o) => isPlasticMaterial(o.value) && o.value !== 'plastic');
  const unspecified = options.find((o) => o.value === 'plastic');
  if (unspecified !== undefined) plastics.push(unspecified);
  const groups: MaterialGroup[] = [
    { label: 'Plastics', options: plastics },
    { label: 'Woods', options: options.filter((o) => isWoodMaterial(o.value)) },
    { label: 'Metals', options: options.filter((o) => isMetalMaterial(o.value)) },
    // #743 P-1 — the copper-clad board, which is none of the three above.
    { label: 'Circuit board', options: options.filter((o) => isCompositeMaterial(o.value)) },
  ];
  return groups.filter((g) => g.options.length > 0);
}

/** The picture under each form: the mockup's own seven drawings, one line each. */
function FormPicture({ form }: { form: JobStockForm }): JSX.Element {
  const common = { width: 40, height: 28, viewBox: '0 0 40 28', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 } as const;
  switch (form) {
    case 'plate':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 16 L18 8 L36 12 L22 20 Z" />
          <path d="M4 16 v4 L22 24 v-4 M22 20 L36 12 v4 L22 24" />
        </svg>
      );
    case 'block':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M8 10 L20 4 L32 10 L20 16 Z" />
          <path d="M8 10 v12 L20 28 v-12 M20 16 L32 10 v12 L20 28" />
        </svg>
      );
    case 'sheet':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 15 L19 8 L37 11 L21 18 Z" />
          <path d="M3 15 v1.5 L21 19.5 v-1.5 M21 18 L37 11 v1.5 L21 19.5" />
        </svg>
      );
    case 'printed-blank':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 16 L18 8 L36 12 L22 20 Z" />
          <path d="M4 16 v4 L22 24 v-4 M22 20 L36 12 v4 L22 24" />
          <path d="M8 17 l12-6 M8 19 l12-6" strokeDasharray="1.5 1.5" />
        </svg>
      );
    case 'disc':
      return (
        <svg {...common} aria-hidden="true">
          <ellipse cx="20" cy="12" rx="15" ry="6" />
          <path d="M5 12 v4 a15 6 0 0 0 30 0 v-4" />
        </svg>
      );
    case 'rod':
      return (
        <svg {...common} aria-hidden="true">
          <ellipse cx="8" cy="14" rx="4" ry="8" />
          <path d="M8 6 h26 a4 8 0 0 1 0 16 H8" />
        </svg>
      );
    case 'tube':
      return (
        <svg {...common} aria-hidden="true">
          <ellipse cx="8" cy="14" rx="4" ry="8" />
          <ellipse cx="8" cy="14" rx="2" ry="4" />
          <path d="M8 6 h26 a4 8 0 0 1 0 16 H8" />
        </svg>
      );
  }
}

/**
 * #934 review — THE MILESTONE'S ONE PROCEDURE, REFUSED WHERE IT IS CHOSEN. Two stock answers the
 * wizard used to accept and the run refused LATER — after the job was planned, placed, frozen and
 * registered:
 *
 *  - A DISC: its rim registration is planned but has not run on this machine, and the milestone
 *    registers exactly one procedure (a rectangular blank in the vise, found with the wired V2
 *    probe). The Stock step is the first place that can say so.
 *  - "AS BOUGHT" ON WOOD OR METAL: the finish seeds a facing pass (decision Q6), and the
 *    post-facing re-touch is hidden until its bench run — the milestone cuts the shelf's planed
 *    stock as it is. The finish is chosen here, so the refusal belongs here.
 *
 * The late refusals (the planner's disc branch, the release step's facing blocker) stay as the
 * safety net for a job written before this.
 */
const DISC_ENTRY_REFUSAL =
  'a disc’s rim registration has not been run on this machine yet — this milestone registers one procedure: ' +
  'a rectangular blank in the vise, found with the wired V2 probe; use a rectangular blank';
const FACING_ENTRY_REFUSAL =
  '“as bought” would face this blank, and the post-facing re-touch has not been run on this machine yet — ' +
  'this milestone registers and cuts the shelf’s planed stock as it is; choose “finished face”';

/**
 * Why this stock answer cannot start the milestone's procedure at all, or null. The facing test is
 * the SEAT-AWARE one (`facingForSeat`, the same function Create writes the job from): a thin blank
 * whose pass cannot clear the jaws is seeded facing OFF, so "as bought" is a perfectly good answer
 * there — only a finish that would really put a facing pass on the job is refused.
 */
function entryRefusal(choice: StockChoice, finish: JobStockFinish): string | null {
  if (choice.stock.shape === 'disc') return DISC_ENTRY_REFUSAL;
  // A rod or a tube is the ROTARY's stock: its top face is the chuck's question, not facing's.
  if (choice.stock.shape === 'cylinder') return null;
  const facing = facingForSeat(
    finish,
    choice.stock.material,
    { thickness: choice.stock.thickness },
    facingShopFrom(useShopDefaultsStore.getState().defaults),
  );
  return facing.enabled ? FACING_ENTRY_REFUSAL : null;
}

export function StartStockStep({
  onChange,
  seed,
}: {
  /** The current answer, or null when there is none yet (or the one there is was refused). */
  onChange: (pending: PendingStock | null) => void;
  /** The job's own stock when the step is re-opened to edit it (#681); absent for a new job. */
  seed?: StartStockSeed;
}): JSX.Element {
  // #875 — the step's phone layout: four form columns and the thickness on its own size row.
  const narrow = useMediaQuery(NARROW_QUERY);
  const machineId = useEngraveJobStore((s) => s.job.machineId);
  const jobMaterial = useEngraveJobStore((s) => s.job.stock.material);
  const jobLabels = useEngraveJobStore((s) => s.job.labels);
  // Memoised on the id: a fresh profile object per render would re-run every rule below.
  const machine = useMemo(() => jobMachine({ machineId }), [machineId]);
  const shelfStatus = useStockStore((s) => s.status);
  const items = useStockStore((s) => s.items);
  const refresh = useStockStore((s) => s.refresh);

  const materials = useMemo(() => materialOptionsFor(machine), [machine]);
  const groups = useMemo(() => groupMaterials(materials), [materials]);
  const [material, setMaterial] = useState<StockMaterial>(() =>
    houseMaterial(materials, { material: jobMaterial, labels: jobLabels }, seed),
  );
  const [form, setForm] = useState<JobStockForm>(seed?.form ?? 'plate');
  const [dims, setDims] = useState<DimState>(() => dimsFromSeed(seed));
  const [seedDims] = useState<DimState>(() => dimsFromSeed(seed));
  const [finish, setFinish] = useState<JobStockFinish>(seed?.finish ?? 'rough');
  // #743 P-1 — a PCB blank states its copper. 0.035 mm is 1 oz, Case Maker's default; the field is
  // on the screen so the number is read rather than hidden in this file.
  const [copper, setCopper] = useState(String(PCB_COPPER_MM));
  const [copperTouched, setCopperTouched] = useState(false);
  const [shelfId, setShelfId] = useState<string | null>(null);
  const [save, setSave] = useState(false);
  const [fileRead, setFileRead] = useState<{ read: StockFileRead; file: File } | null>(null);
  const [reading, setReading] = useState(false);
  // One id for the entry a kept piece becomes, drawn once — not on every recompute of the answer.
  const [newId] = useState(() => newStockId());

  // The wizard reads the shelf itself: Manage › Materials is the only other reader, and it may never
  // have been opened in this window.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shelf = useMemo(() => shelfFor(items, material), [items, material]);
  const shelfOk = shelfStatus === 'present';
  // A pick that is already on the shelf is not "kept" again; a loaded file is not typed either.
  const canKeep = shelfOk && shelfId === null && fileRead === null;

  /**
   * What the step hands the wizard on every input. `sentence` is the form's line under the picture
   * when the numbers change it — a rod past the vise's grip is the rotary's, and the line says so
   * (`rodGripProblem`). It is NOT a block: the answer stands, and Next goes on to Holding, which
   * writes the chuck (#713).
   */
  const outcome = useMemo((): {
    pending: PendingStock | null;
    problem: string | null;
    notes: string[];
    sentence?: string | null;
  } => {
    if (shelfId !== null) {
      const item = shelf.find((i) => i.id === shelfId);
      if (!item) return { pending: null, problem: null, notes: [] };
      const r = stockFromShelf(item, machine);
      if (r.ok) {
        const refused = entryRefusal(r.choice, finish);
        if (refused !== null) return { pending: null, problem: refused, notes: [] };
      }
      return r.ok
        ? {
            pending: { kind: 'choice', choice: r.choice, saveToShelf: null },
            problem: null,
            notes: r.choice.notes,
            sentence: item.form === 'rod' ? rodGripProblem(item.size) : null,
          }
        : { pending: null, problem: r.reason, notes: [] };
    }
    if (fileRead !== null) {
      const { read, file } = fileRead;
      if (read.kind === 'refused') return { pending: null, problem: `${read.name}: ${read.reason}`, notes: [] };
      if (read.kind === 'design') {
        if (!featureSim) {
          return {
            pending: null,
            problem: `${read.name} is a PrusaSlicer project with ${read.negativeVolumes} cut volumes — reading a design needs the simulator, which is not enabled in this build`,
            notes: [],
          };
        }
        return {
          pending: { kind: 'design', file, sha256: read.sha256 },
          problem: null,
          notes: [
            `${read.name} is a PrusaSlicer project with ${read.negativeVolumes} cut volume${read.negativeVolumes === 1 ? '' : 's'}: ` +
              'its blank becomes the stock (PLA) and its cut volumes the design, in one step.',
          ],
        };
      }
      const r = stockFromFile({ ...read, material, finish }, machine);
      if (r.ok) {
        const refused = entryRefusal(r.choice, finish);
        if (refused !== null) return { pending: null, problem: refused, notes: [] };
      }
      return r.ok
        ? { pending: { kind: 'choice', choice: r.choice, saveToShelf: null }, problem: null, notes: r.choice.notes }
        : { pending: null, problem: r.reason, notes: [] };
    }
    // Typed. Nothing filled in is not an answer and not a refusal: the step waits for one number.
    const filled = STOCK_SIZE_FIELDS[form].some((key) => dims[key].trim() !== '');
    if (!filled) return { pending: null, problem: null, notes: [] };
    const size = toSize(dims);
    // A rod past the vise's grip is the rotary's (§3.3). The form's own sentence says so; the
    // answer still stands, so Next goes on.
    const sentence = form === 'rod' ? rodGripProblem(size) : null;
    const sizeProblem = formSizeProblem(form, size, machine);
    if (sizeProblem !== null) return { pending: null, problem: sizeProblem, notes: [] };
    const box = boxForForm(form, size);
    if (box === null) return { pending: null, problem: null, notes: [] };
    const copperMm = material === 'pcb' ? Number(copper) : undefined;
    if (material === 'pcb' && !(Number.isFinite(copperMm) && (copperMm as number) > 0)) {
      return { pending: null, problem: 'the copper thickness needs a number in mm, above 0', notes: [] };
    }
    const made = {
      ...box,
      form,
      material,
      finish,
      wall: size.wall ?? undefined,
      ...(copperMm !== undefined
        ? { copperMm, copperSource: copperTouched ? ('user' as const) : ('assumed' as const) }
        : {}),
    };
    // A tick that cannot be honoured (no shelf in this instance) is not on screen at all.
    const id = save && canKeep ? newId : null;
    const r = stockFromMade(made, machine, id);
    if (!r.ok) return { pending: null, problem: r.reason, notes: [] };
    const refused = entryRefusal(r.choice, finish);
    if (refused !== null) return { pending: null, problem: refused, notes: [] };
    let item: StockItem | null = null;
    if (id !== null) {
      item = shelfItemFromMade(made, id, new Date().toISOString());
      const why = stockProblem(item);
      if (why !== null) return { pending: null, problem: `it cannot go on the shelf: ${why}`, notes: [] };
    }
    return {
      pending: { kind: 'choice', choice: r.choice, saveToShelf: item },
      problem: null,
      notes: r.choice.notes,
      sentence,
    };
  }, [shelfId, shelf, machine, fileRead, dims, form, material, finish, save, canKeep, newId, copper, copperTouched]);

  // Tell the wizard. Keyed on the pending answer's identity: `outcome` is a fresh object on every
  // input change, which is exactly when the wizard should hear about it.
  useEffect(() => {
    onChange(outcome.pending);
  }, [outcome, onChange]);

  /** The form's picture: it sets the size fields, and the sentence says what the word means. */
  function chooseForm(next: JobStockForm): void {
    setForm(next);
    setShelfId(null);
    setFileRead(null);
  }

  /** Typing a number makes the piece the person's own, not the shelf entry's. */
  function editDim(key: StockSizeKey, value: string): void {
    setDims((d) => ({ ...d, [key]: value }));
    setShelfId(null);
    setFileRead(null);
  }

  /** A shelf entry fills the form, its numbers and its finish; the fields stay editable. */
  function pickShelf(item: StockItem): void {
    setShelfId(item.id);
    setFileRead(null);
    setForm(item.form as JobStockForm);
    setDims(dimsFromItem(item));
    setFinish(item.finish);
    setSave(false);
  }

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setReading(true);
    try {
      const read = await readStockFile(file);
      setFileRead({ read, file });
      setShelfId(null);
      if (read.kind === 'mesh') {
        // The box IS the stock, so the fields show it. A printed blank is the usual reason to load
        // a mesh; the material answers whether it is one (#463). #743 D3 — a file whose outline is
        // a circle is a DISC: its form asks for the two numbers the rim has, not the square box.
        if (read.shape === 'disc') {
          setForm('disc');
          setDims({ ...EMPTY_DIMS, diameter: text(read.length), thickness: text(read.thickness) });
        } else {
          setForm(isPrintedBlankMaterial(material) ? 'printed-blank' : 'block');
          setDims({ ...EMPTY_DIMS, length: text(read.length), width: text(read.width), thickness: text(read.thickness) });
        }
        if (isPrintedBlankMaterial(material)) setFinish('printed');
      }
      if (read.kind === 'design') setFinish('printed');
    } finally {
      setReading(false);
    }
  }

  const selectedForm = FORM_DEFS.find((f) => f.id === form) ?? FORM_DEFS[0]!;
  const visibleSizeKeys = STOCK_SIZE_FIELDS[form];
  const seededNumbers =
    seed?.computed === true && visibleSizeKeys.every((key) => dims[key] === seedDims[key]);
  const around = aroundLine(form, dims);

  return (
    <div data-testid="start-wizard-step-stock" style={{ marginTop: 8 }}>
      <label style={{ ...MUTED, display: 'block' }}>
        <span>Material</span>
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
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <p style={{ ...MUTED, margin: '8px 0 0' }}>Form</p>
      <div
        data-testid="start-wizard-make-form"
        role="group"
        aria-label="Stock form"
        style={{ ...FORMS, gridTemplateColumns: narrow ? 'repeat(4, 1fr)' : `repeat(${FORM_DEFS.length}, minmax(0, 1fr))` }}
      >
        {FORM_DEFS.map((f) => (
          <button
            key={f.id}
            type="button"
            data-testid={`start-wizard-form-${f.id}`}
            aria-pressed={form === f.id}
            onClick={() => chooseForm(f.id)}
            style={form === f.id ? FORM_BUTTON_ON : FORM_BUTTON}
          >
            <FormPicture form={f.id} />
            <span>{f.word}</span>
          </button>
        ))}
      </div>
      <p style={MUTED} data-testid="start-wizard-form-sentence">
        {outcome.sentence ?? formSentence(selectedForm.id, machine)}
      </p>

      <p style={{ ...MUTED, margin: '8px 0 0' }}>Size</p>
      <div
        style={{ ...SIZE_FIELDS, gridTemplateColumns: narrow ? '1fr 1fr' : 'repeat(3, minmax(0, 1fr))' }}
        data-testid="start-wizard-make"
      >
        {visibleSizeKeys.map((key) => (
          <label
            key={key}
            style={narrow && key === 'thickness' ? { ...SIZE_FIELD, gridColumn: '1 / -1' } : SIZE_FIELD}
          >
            {SIZE_LABELS[key]}
            <span style={SIZE_UNIT_ROW}>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="0"
                style={SIZE_INPUT}
                data-testid={`start-wizard-make-${key}`}
                aria-label={`Stock ${SIZE_LABELS[key]}`}
                value={dims[key]}
                onChange={(e) => editDim(key, e.target.value)}
              />
              mm
            </span>
          </label>
        ))}
      </div>
      {/* #743 P-1 — a PCB's copper: the cap every depth rule reads (D2). */}
      {material === 'pcb' && (
        <label style={{ ...MUTED, display: 'flex', gap: 4, alignItems: 'center', marginTop: 6 }}>
          Copper
          <input
            type="number"
            min={0}
            step="any"
            style={NUM}
            data-testid="start-wizard-stock-copper"
            aria-label="Copper thickness"
            value={copper}
            onChange={(e) => {
              setCopperTouched(true);
              setCopper(e.target.value);
            }}
          />
          mm on the top face (1 oz)
        </label>
      )}
      {material === 'pcb' && (
        <p style={MUTED} data-testid="start-wizard-stock-copper-source">
          {copperTouched ? 'As you stated it.' : 'Case Maker’s default — check the blank’s label.'}{' '}
          The copper is the stock’s colour cap, so the depth rules read it as one.
        </p>
      )}
      {/* #713 — the round form's derived line: the circumference of its surface, the map's height. */}
      {around !== null && (
        <p style={MUTED} data-testid="start-wizard-stock-around">
          {around}
        </p>
      )}
      {/* #352 — where seeded numbers came from. It goes the moment one of them is edited, because
          then the number IS the operator's and the sentence would be a lie. #897 — a blank the
          work proposed says what it was sized from, in the same place and under the same rule. */}
      {seededNumbers && (
        <p style={MUTED} data-testid="engrave-setup-stock-provenance">
          {seed?.sentence ??
            'These numbers came from the template you picked, not from a bench measurement — change any you measured.'}
        </p>
      )}

      {/* #713 — the stock's own refusal, at the size field it is about: a rod or tube outside the
          rotary's envelope, or a number that is not one. */}
      {outcome.problem !== null && fileRead === null && (
        <p style={REFUSED} data-testid="start-wizard-stock-problem">
          {outcome.problem}
        </p>
      )}

      {/* #875 — Finish on its own row, its hint on the line below in grey: beside the select the
          sentence wrapped mid-phrase. */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
        <span style={MUTED}>Finish</span>
        <select
          data-testid="start-wizard-stock-finish"
          aria-label="Stock finish"
          value={finish}
          onChange={(e) => {
            setFinish(e.target.value as JobStockFinish);
            setShelfId(null);
          }}
        >
          {FINISH_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <p style={MUTED} data-testid="start-wizard-stock-finish-hint">
        {FINISH_HINT}
      </p>

      {shelfOk && shelf.length > 0 && (
        <div data-testid="start-wizard-shelf" style={{ marginTop: 8 }}>
          <p style={{ ...MUTED, margin: '0 0 3px' }}>Shelf</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
            {shelf.map((item) => {
              const why = shelfPickProblem(item, machine);
              const picked = shelfId === item.id;
              const held = item.quantity - item.reservations.reduce((a, r) => a + r.quantity, 0);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`start-wizard-shelf-item-${item.id}`}
                    data-state={why === null ? 'ok' : 'refused'}
                    aria-pressed={picked}
                    disabled={why !== null}
                    onClick={() => pickShelf(item)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: 4,
                      border: picked ? '1px solid #5a8abf' : undefined,
                      opacity: why === null ? 1 : 0.6,
                    }}
                  >
                    <div style={{ fontSize: 12, color: '#cfe' }}>
                      {`${MATERIAL_LABELS[item.material]} ${
                        isJobForm(item.form) ? formLabel(item.form).toLowerCase() : item.form
                      } `}
                      {sizeText(item)}
                      {item.quantity > 0 &&
                        ` · ${item.quantity} on the shelf${held < item.quantity ? ` (${held} free)` : ''}`}
                      {item.capMm != null && ` · cap ${text(item.capMm)} (${item.capSource})`}
                    </div>
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
        </div>
      )}

      {canKeep && (
        <label style={{ ...MUTED, display: 'flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
          <input
            type="checkbox"
            data-testid="start-wizard-make-save"
            checked={save}
            onChange={(e) => setSave(e.target.checked)}
          />
          keep this piece on the shelf
        </label>
      )}

      <WizardFileField
        drop
        accept=".stl,.3mf,.obj,.step,.stp"
        inputTestId="start-wizard-load-file"
        inputLabel="Stock file"
        testId="start-wizard-load"
        nameTestId="start-wizard-load-name"
        errorTestId="start-wizard-load-error"
        chooseLabel="Load an STL, 3MF, OBJ or STEP as the stock…"
        reading={reading}
        chosen={fileRead === null ? null : { name: fileRead.read.name, fact: fileFact(fileRead.read) }}
        // A loaded file's refusal is said at the file, once: the read's own reason, or the stock's.
        error={fileRead === null ? null : fileRead.read.kind === 'refused' ? fileRead.read.reason : outcome.problem}
        onFiles={(files) => void pickFile(files[0])}
      >
        {/* #825 — an OBJ states no unit of its own; the door says which reading it got. */}
        {fileRead?.read.kind === 'mesh' && fileRead.read.note !== undefined && (
          <p style={MUTED} data-testid="start-wizard-load-note">
            {fileRead.read.note}
          </p>
        )}
      </WizardFileField>

      {outcome.notes.length > 0 && (
        <div data-testid="start-wizard-stock-summary">
          {outcome.notes.map((n, i) => (
            <p key={i} style={NOTE}>
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
