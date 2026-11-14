import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { jobMachine } from '@/engine/cnc/calibration';
import { isShippedDemoLabelSet } from '@/engine/cnc/engrave/blankLabelSeed';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import { SEVERAL_HOLD_SENTENCE } from '@/engine/cnc/stockProposal';
import type { Mill } from '@/engine/cnc/machine';
import { MATERIAL_LABELS, isPrintedBlankMaterial, materialFamilyOf } from '@/engine/cnc/materials';
import {
  PCB_COPPER_MM,
  ROD_VISE_MAX_LENGTH_MM,
  STOCK_SIZE_FIELDS,
  boxForForm,
  formLabel,
  formSizeProblem,
  isJobForm,
  matchShelf,
  parseInches,
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
import { readDefault } from '@/platform/defaultsClient';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { SELECTED_FILL } from '@/components/selectionChip';
import { featureSim } from '@/platform/features';
import { stockProblem, type StockItem } from '@/platform/stockClient';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { newStockId, useStockStore } from '@/store/stockStore';
import type { JobStockFinish, JobStockForm, StockMaterial } from '@/types/engraveJob';
import { fmt } from './holdingMounts';
import { NARROW_QUERY } from './wizardLayout';
import { BlankWithPart } from './BlankWithPart';
import type { PartFootprint } from './workShape';
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
  /** The piece's material, or null — not chosen (#1263): the app assumes none. */
  material: StockMaterial | null;
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
/** #1105 — the "edit" beside the picked-blank summary: a link, not a second button in the row. */
const LINK_BUTTON: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  color: '#8fc7ff',
  textDecoration: 'underline',
  cursor: 'pointer',
  fontSize: 'inherit',
};
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

/** #1263 — the amber that marks what the ask is still waiting for (the question cards' colour). */
const NEEDED = '2px solid #f5a524';

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
/**
 * #1105 — THE FINISH HINT IS THE MATERIAL'S OWN. The old one said "plastic is cut as it is; wood
 * and metal are faced first" under a hardwood seed that was already `finished`, so it contradicted
 * the default. The family decides the sentence, and a board (#1066) is neither a wood nor a
 * plastic.
 */
function finishHintFor(material: StockMaterial): string {
  const family = materialFamilyOf(material);
  if (family === 'wood') {
    return `${MATERIAL_LABELS[material]}: faced first unless you say it is planed — facing takes the top skim before the design.`;
  }
  if (family === 'metal') {
    return `${MATERIAL_LABELS[material]}: faced first unless the face is already machined — facing takes the top skim before the design.`;
  }
  return `${MATERIAL_LABELS[material]} is cut as it is; no facing.`;
}

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

/**
 * #1263 — WHAT THE OPERATOR HAS TYPED OR CHOSEN ON THIS STEP, kept by the wizard beside the answer:
 * going Back to the question and returning would otherwise lose a size typed before a material was
 * chosen (an answer needs both). Only what the operator did is kept; a proposal is not a draft.
 */
export interface StockDraft {
  material: StockMaterial | null;
  form: JobStockForm;
  dims: Record<StockSizeKey, string>;
  materialTouched: boolean;
  dimsTouched: boolean;
}
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
 * THE MATERIAL THE STEP OPENS ON (#1263) — or null, NOT CHOSEN. The app assumes none. In order:
 * (a) the seed's material (the shelf piece that answered, a board's, the job's own on a re-entry);
 * (b) the material a job that STATES one carries (a dropped file, a saved job, a starter);
 * otherwise nothing, and the step asks. The untouched demo job is the app's own sample and states
 * nothing, so it never seeds the step.
 */
function openingMaterial(
  options: readonly { value: StockMaterial }[],
  job: { material: StockMaterial; labels: Parameters<typeof isShippedDemoLabelSet>[0]['labels'] },
  seed?: StartStockSeed,
): StockMaterial | null {
  const offered = (m: StockMaterial): boolean => options.some((o) => o.value === m);
  if (seed !== undefined && seed.material !== null && offered(seed.material)) return seed.material;
  if (seed !== undefined && seed.computed === true) return null;
  const shipped = defaultEngraveJob();
  const untouchedDemo = isShippedDemoLabelSet(job) && job.material === shipped.stock.material;
  if (!untouchedDemo && offered(job.material)) return job.material;
  return null;
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
  // #1105 — THE VOCABULARY IN THE ORDER A WOODWORKER READS IT: Woods first, then the cast boards
  // and foams (#1066's tooling board), then the plastics, metals and the copper-clad board. The
  // family is the material's own record (`materialFamilyOf`), not a set of predicates here.
  const order = [
    { family: 'wood' as const, label: 'Woods' },
    { family: 'board' as const, label: 'Boards & foams' },
    { family: 'plastic' as const, label: 'Plastics' },
    { family: 'metal' as const, label: 'Metals' },
    { family: 'pcb' as const, label: 'Circuit board' },
  ];
  return order
    .map(({ family, label }) => {
      const inFamily = options.filter((o) => materialFamilyOf(o.value) === family);
      if (family !== 'plastic') return { label, options: inFamily };
      // "plastic (unspecified)" goes LAST in Plastics — it is the bought laminate's material, the
      // one word that says nothing about what it is.
      const unspecified = inFamily.find((o) => o.value === 'plastic');
      return {
        label,
        options: [...inFamily.filter((o) => o.value !== 'plastic'), ...(unspecified === undefined ? [] : [unspecified])],
      };
    })
    .filter((g) => g.options.length > 0);
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

export function StartStockStep({
  onChange,
  seed,
  part = null,
  presetFile,
  several = null,
  draft = null,
  onDraft,
}: {
  /** #1098 item 6 — a file the question step recognised; read once on arrival, as if picked here. */
  presetFile?: File;
  /** The current answer, or null when there is none yet (or the one there is was refused). */
  onChange: (pending: PendingStock | null) => void;
  /** The job's own stock when the step is re-opened to edit it (#681); absent for a new job. */
  seed?: StartStockSeed;
  /** #1099 — the part the drawings show on this blank; null when the work has no footprint. */
  part?: PartFootprint | null;
  /** #1263 — the holding pieces (least waste first) when they span more than one material and the job states none. */
  several?: readonly string[] | null;
  /** #1263 — the operator's own typing from an earlier visit to this step (see {@link StockDraft}). */
  draft?: StockDraft | null;
  onDraft?: (draft: StockDraft) => void;
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
  const [material, setMaterial] = useState<StockMaterial | null>(() =>
    draft?.materialTouched === true
      ? draft.material
      : openingMaterial(materials, { material: jobMaterial, labels: jobLabels }, seed),
  );
  const [form, setForm] = useState<JobStockForm>(draft?.dimsTouched === true ? draft.form : (seed?.form ?? 'plate'));
  const [dims, setDims] = useState<DimState>(() => (draft?.dimsTouched === true ? draft.dims : dimsFromSeed(seed)));
  const [seedDims] = useState<DimState>(() => dimsFromSeed(seed));
  const [finish, setFinish] = useState<JobStockFinish>(seed?.finish ?? 'rough');
  // #743 P-1 — a PCB blank states its copper. 0.035 mm is 1 oz, Case Maker's default; the field is
  // on the screen so the number is read rather than hidden in this file.
  const [copper, setCopper] = useState(String(PCB_COPPER_MM));
  const [copperTouched, setCopperTouched] = useState(false);
  // #1105 — mm/in. The JOB stays in mm (the rule the issue states); inches are a typing unit and
  // the sentence under the fields states both numbers once a value is entered that way.
  const [unit, setUnit] = useState<'mm' | 'in'>('mm');
  const [lastInch, setLastInch] = useState<string | null>(null);
  // #1105 item 1 — the operator's own inch text while it is being typed: the field shows THIS, not
  // a conversion of the millimetres stored under it, so "1.2345" is not rewritten to "1.234" under
  // the cursor. The parser runs on blur; the draft is dropped once the value is committed.
  const [inchText, setInchText] = useState<Partial<Record<StockSizeKey, string>>>({});
  const [shelfId, setShelfId] = useState<string | null>(null);
  // #1105 item 6 — a PICKED blank is one summary line, not the fields; "edit" and "Other size…"
  // bring the fields back, seeded with the picked numbers (the entry becomes the operator's own).
  const [summaryOpen, setSummaryOpen] = useState(false);
  const shopDefaults = useShopDefaultsStore((s) => s.defaults);
  const arrivalMatched = useRef(false);
  // The operator chose the material themselves (never overwritten by a late proposal).
  const materialTouched = useRef(draft?.materialTouched === true);
  const dimsTouched = useRef(draft?.dimsTouched === true);
  // #1109 — the provenance sentence survives typing; it goes only when a DIFFERENT valid number is
  // committed on blur (or another source — a shelf entry, a file, a form — takes the numbers over).
  const [seedDropped, setSeedDropped] = useState(false);
  // #1109 — THE SENTENCE OUTLIVES THE SEED. Typing makes the numbers the operator's, so the
  // wizard's proposal stops being a seed; the sentence still says where they STARTED.
  const [seedSeen, setSeedSeen] = useState<{ sentence: string | null } | null>(() =>
    seed?.computed === true ? { sentence: seed.sentence ?? null } : null,
  );
  useEffect(() => {
    if (seed?.computed !== true) return;
    setSeedSeen({ sentence: seed.sentence ?? null });
    setSeedDropped(false);
  }, [seed?.computed, seed?.sentence]);
  // #1263 — THE PROPOSAL CAN CHANGE UNDER THE STEP: the shelf loads after the step opens, and the
  // blank the work proposes (a piece of the shelf, or none and a recommendation) follows it. While
  // the operator has taken nothing over, the step follows the proposal; a material they chose
  // themselves is never overwritten.
  useEffect(() => {
    // Several pieces of different materials hold the work: there is no proposal, so no size is
    // proposed either — the fields are empty until the operator picks a piece or types one.
    if (several !== null && several.length > 0 && !dimsTouched.current && shelfId === null && fileRead === null) {
      setDims(EMPTY_DIMS);
      setSeedSeen(null); // the early recommendation's sentence ("No stock is recorded…") no longer holds
      return;
    }
    if (seed?.computed !== true || seedDropped || shelfId !== null || fileRead !== null) return;
    if (!materialTouched.current) setMaterial(seed.material);
    // What the operator typed (this visit or an earlier one) is theirs: a proposal never overwrites it.
    if (dimsTouched.current) return;
    setForm(seed.form);
    setDims(dimsFromSeed(seed));
    setFinish(seed.finish);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the proposal's values only
  }, [seed?.computed, seed?.material, seed?.form, seed?.length, seed?.width, seed?.thickness, seed?.finish, several]);
  // Keep what the operator typed or chose, so Back and forward do not lose it (#1263).
  useEffect(() => {
    if (!materialTouched.current && !dimsTouched.current) return;
    onDraft?.({ material, form, dims, materialTouched: materialTouched.current, dimsTouched: dimsTouched.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reports on the values; onDraft is the wizard's setter
  }, [material, form, dims]);
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

  // #1098 item 6 — the question step already recognised this file: read it as the Stock step's own
  // loader would, once, so the step arrives settled on it.
  useEffect(() => {
    if (presetFile !== undefined) void pickFile(presetFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetFile]);

  const shelf = useMemo(() => (material === null ? [] : shelfFor(items, material)), [items, material]);
  const shelfOk = shelfStatus === 'present';
  // #1263 — the pieces that hold the work come first, least waste first (the wizard's order); the rest follow in the shelf's own.
  const orderedItems = useMemo(() => {
    if (several === null) return items;
    const first = several.map((id) => items.find((i) => i.id === id)).filter((i): i is StockItem => i !== undefined);
    return [...first, ...items.filter((i) => !several.includes(i.id))];
  }, [items, several]);
  // #1105 — the cards show EVERY shelf row; the ones in another material are greyed, not hidden.
  const shelfOther = useMemo(() => (material === null ? [] : items.filter((i) => i.material !== material)), [items, material]);

  // #1105 item 5 — THE SHELF BLANK THAT IS THE PROPOSAL IS PRE-SELECTED on arrival, once: the
  // selected material, its thickness and its length × width within `stock.shelfMatchMm` in either
  // orientation. No such blank leaves the proposal card selected, exactly as before.
  useEffect(() => {
    if (arrivalMatched.current || seed?.computed !== true || !shelfOk || items.length === 0 || material === null) return;
    arrivalMatched.current = true;
    const match = matchShelf(
      { length: seed.length, width: seed.width, thickness: seed.thickness },
      items,
      material,
      readDefault(shopDefaults ?? null, 'stock.shelfMatchMm').value,
    );
    if (match !== null) pickShelf(match);
    // pickShelf is a declaration in this component, not a dependency of the arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, shelfOk, items, material, shopDefaults]);
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
      // A file is a size, not a material: with none chosen the step waits for it (the ask says so).
      if (material === null) return { pending: null, problem: null, notes: [] };
      const r = stockFromFile({ ...read, material, finish }, machine);
      return r.ok
        ? { pending: { kind: 'choice', choice: r.choice, saveToShelf: null }, problem: null, notes: r.choice.notes }
        : { pending: null, problem: r.reason, notes: [] };
    }
    // Typed. Nothing filled in is not an answer and not a refusal: the step waits for one number.
    const filled = STOCK_SIZE_FIELDS[form].some((key) => dims[key].trim() !== '');
    if (!filled) return { pending: null, problem: null, notes: [] };
    // No material chosen is no answer (#1263): the ask above says which is missing.
    if (material === null) return { pending: null, problem: null, notes: [] };
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
      return { pending: null, problem: 'The copper thickness needs a size above 0 — 1 oz is 0.035 mm.', notes: [] };
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
    if (next !== form) setSeedDropped(true);
    setForm(next);
    setShelfId(null);
    setFileRead(null);
    // A form is an explicit edit: the fields open (there is no picked blank to summarise).
    setSummaryOpen(false);
  }

  /** Typing a number makes the piece the person's own, not the shelf entry's. */
  function editDim(key: StockSizeKey, value: string): void {
    dimsTouched.current = true;
    setDims((d) => ({ ...d, [key]: value }));
    setShelfId(null);
    setFileRead(null);
  }

  /** #1109 — the field's blur is where an edit is COMMITTED: the sentence stays while the operator
   *  types (a slip must not lose where the numbers came from) and goes only when a different, valid
   *  number is left in the field. */
  function commitDim(key: StockSizeKey): void {
    // #1105 item 1 — an inch entry is parsed HERE, once, from the text the operator typed; while it
    // was being typed the field held that text and the stored millimetres were left alone.
    const draft = inchText[key];
    if (unit === 'in' && draft !== undefined) {
      const mm = parseInches(draft);
      setInchText((t) => {
        const next = { ...t };
        delete next[key];
        return next;
      });
      if (mm === null) {
        editDim(key, draft);
        return;
      }
      setLastInch(`${draft} in = ${mm} mm`);
      editDim(key, String(mm));
      const seedValue = Number(seedDims[key]);
      if (!Number.isFinite(seedValue) || mm !== seedValue) setSeedDropped(true);
      return;
    }
    const value = dims[key].trim();
    const n = Number(value);
    if (value === '' || !Number.isFinite(n) || n <= 0) return;
    const seedValue = Number(seedDims[key]);
    if (!Number.isFinite(seedValue) || n !== seedValue) setSeedDropped(true);
  }

  /** #1105 — the field as the chosen unit shows it: the typed text while an inch entry is being
   *  typed, mm as stored, inches to 3 decimals otherwise. */
  function shownDim(key: StockSizeKey): string {
    const draft = inchText[key];
    if (unit === 'in' && draft !== undefined) return draft;
    const raw = dims[key];
    if (unit === 'mm' || raw.trim() === '') return raw;
    const mm = Number(raw);
    return Number.isFinite(mm) ? String(Number((mm / 25.4).toFixed(3))) : raw;
  }

  /** #1105 — typing in inches holds the operator's text; the parser runs on blur. mm is unchanged. */
  function editShownDim(key: StockSizeKey, value: string): void {
    if (unit === 'mm') {
      editDim(key, value);
      return;
    }
    setInchText((t) => ({ ...t, [key]: value }));
  }

  /** A shelf entry fills the form, its numbers and its finish; the fields stay editable. */
  function pickShelf(item: StockItem): void {
    setShelfId(item.id);
    // The piece carries its material (#1263): picking it answers the material too.
    setMaterial(item.material);
    setFileRead(null);
    setSeedDropped(true);
    setForm(item.form as JobStockForm);
    setDims(dimsFromItem(item));
    setFinish(item.finish);
    setSave(false);
    // #1105 item 6 — the row IS the answer: one summary line, the fields behind "edit".
    setSummaryOpen(true);
  }

  /** #1105 item 6 — the picked blank in one line: its name, its numbers and the material. */
  function selectionSummary(): string {
    const item = items.find((i) => i.id === shelfId) ?? null;
    const name =
      item === null
        ? 'From your design'
        : `${MATERIAL_LABELS[item.material]} ${isJobForm(item.form) ? formLabel(item.form).toLowerCase() : item.form}`;
    const d = item === null ? dims : dimsFromItem(item);
    const f = item === null ? form : item.form;
    const size =
      f === 'disc'
        ? `${d.diameter} Ø × ${d.thickness}`
        : f === 'rod'
          ? `${d.diameter} Ø × ${d.length}`
          : f === 'tube'
            ? `${d.diameter} Ø × ${d.wall} wall × ${d.length}`
            : `${d.length} × ${d.width} × ${d.thickness}`;
    return `${name} — ${size} mm${material === null ? '' : ` ${MATERIAL_LABELS[material]}`}`;
  }

  /** #1105 — the step-2 proposal is a card like a shelf row: picking it returns to the app's own
   *  numbers after an edit, so "From your design" is a choice and not only a starting point. */
  function pickProposal(): void {
    if (seed === undefined) return;
    setMaterial(seed.material);
    setForm(seed.form);
    setDims(dimsFromSeed(seed));
    setFinish(seed.finish);
    setShelfId(null);
    setSeedDropped(false);
    setFileRead(null);
    setSave(false);
  }

  async function pickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    // A file is its own answer; there is no picked blank to summarise.
    setSummaryOpen(false);
    setReading(true);
    try {
      const read = await readStockFile(file);
      setFileRead({ read, file });
      setShelfId(null);
      setSeedDropped(true);
      if (read.kind === 'mesh') {
        // The box IS the stock, so the fields show it. A printed blank is the usual reason to load
        // a mesh; the material answers whether it is one (#463). #743 D3 — a file whose outline is
        // a circle is a DISC: its form asks for the two numbers the rim has, not the square box.
        if (read.shape === 'disc') {
          setForm('disc');
          setDims({ ...EMPTY_DIMS, diameter: text(read.length), thickness: text(read.thickness) });
        } else {
          setForm(material !== null && isPrintedBlankMaterial(material) ? 'printed-blank' : 'block');
          setDims({ ...EMPTY_DIMS, length: text(read.length), width: text(read.width), thickness: text(read.thickness) });
        }
        if (material !== null && isPrintedBlankMaterial(material)) setFinish('printed');
      }
      if (read.kind === 'design') setFinish('printed');
    } finally {
      setReading(false);
    }
  }

  const selectedForm = FORM_DEFS.find((f) => f.id === form) ?? FORM_DEFS[0]!;
  const visibleSizeKeys = STOCK_SIZE_FIELDS[form];
  // #1109 — THE SENTENCE OUTLIVES THE SEED. Typing makes the numbers the operator's, so the
  // wizard's proposal stops being a seed; the sentence still says where they STARTED. It is kept
  // here until a different valid number is committed, or another source takes the numbers over.
  const seededNumbers = seedSeen !== null && !seedDropped;
  // The sentence lives in ONE place: the "From your design" card while it is on screen, and the
  // line under the fields once typing has taken that card away (#1109 — never twice on one step).
  const seedSentenceInCard = seed?.computed === true && seed.sentence !== undefined;
  const around = aroundLine(form, dims);
  // #1099 — the blank the drawing shows, once all three numbers are usable (mid-typing is not).
  const drawnBlank = useMemo(() => {
    const length = Number(dims.length);
    const width = Number(dims.width);
    const thickness = Number(dims.thickness);
    return [length, width, thickness].every((v) => Number.isFinite(v) && v > 0) ? { length, width, thickness } : null;
  }, [dims.length, dims.width, dims.thickness]);

  // #1263 — THE ASK: one prominent question at the top of the step while the piece is not yet
  // answered — what it is made of, and its size. It names only the ways this shop has, and its
  // chips are controls that take the operator to what is still missing.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const sizeEntered =
    shelfId !== null || fileRead !== null || STOCK_SIZE_FIELDS[form].some((key) => dims[key].trim() !== '');
  const materialMissing = material === null;
  const askShown = materialMissing || !sizeEntered;
  const shelfOffered = shelfOk && items.length > 0;
  const askSentence = (): string => {
    if (several !== null && several.length > 0) return SEVERAL_HOLD_SENTENCE;
    const needs = [...(materialMissing ? ['choose the material'] : []), ...(sizeEntered ? [] : ["enter the piece's size"])].join(' and ');
    if (shelfOffered && !sizeEntered) return `Pick a piece from your shelf, or ${needs}.`;
    return `${needs.charAt(0).toUpperCase()}${needs.slice(1)}.`;
  };
  const focusFirstEmptySize = (): void => {
    const keys = STOCK_SIZE_FIELDS[form];
    const empty = keys.find((key) => dims[key].trim() === '') ?? keys[0]!;
    rootRef.current?.querySelector<HTMLInputElement>(`[data-testid="start-wizard-make-${empty}"]`)?.focus();
  };

  return (
    <div data-testid="start-wizard-step-stock" style={{ marginTop: 8 }} ref={rootRef}>
      {askShown && (
        <div
          data-testid="start-wizard-stock-ask"
          role="group"
          aria-label="What this will be cut from"
          style={{ borderLeft: '5px solid #f5a524', background: '#201a0c', borderRadius: 6, padding: '10px 12px', marginBottom: 10 }}
        >
          <h3 style={{ margin: 0, font: '700 18px/1.3 var(--cm-font-display, inherit)', color: '#ffe2a8' }}>What will this be cut from?</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#c8d3de' }} data-testid="start-wizard-stock-ask-sentence">
            {askSentence()}
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {materialMissing && (
              <button
                type="button"
                className="sw-btn"
                data-testid="start-wizard-ask-chip-material"
                onClick={() => selectRef.current?.focus()}
                style={{ border: '1px solid #f5a524', color: '#ffe2a8', borderRadius: 12, padding: '2px 10px', fontSize: 11 }}
              >
                material — not chosen
              </button>
            )}
            {!sizeEntered && (
              <button
                type="button"
                className="sw-btn"
                data-testid="start-wizard-ask-chip-size"
                onClick={focusFirstEmptySize}
                style={{ border: '1px solid #f5a524', color: '#ffe2a8', borderRadius: 12, padding: '2px 10px', fontSize: 11 }}
              >
                size — not entered
              </button>
            )}
          </div>
        </div>
      )}
      {/* #1105 — PICK A BLANK FIRST. The step-2 proposal is a card; the shelf's rows are cards
          across ALL materials, the ones that do not match the selected material greyed rather than
          hidden (a PLA user still learns the shelf holds hardwood). */}
      {(seed?.computed === true || (shelfOk && items.length > 0)) && (
        <div data-testid="start-wizard-blank-cards" style={{ marginTop: 4, marginBottom: 8 }}>
          <p style={{ ...MUTED, margin: '0 0 3px' }}>Pick a blank</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
            {seed?.computed === true && (
              <li>
                <button
                className="sw-btn"
                  type="button"
                  data-testid="start-wizard-blank-card-design"
                  aria-pressed={shelfId === null && fileRead === null && seededNumbers}
                  onClick={() => {
                    pickProposal();
                    // #1105 item 6 — the card is picked: one summary line, the fields behind "edit".
                    setSummaryOpen(true);
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: 4,
                    border: shelfId === null && fileRead === null && seededNumbers ? '1px solid #5a8abf' : undefined,
                  }}
                >
                  <div style={{ fontSize: 12, color: '#cfe' }}>
                    <strong>From your design</strong> — {formLabel(seed.form).toLowerCase()}{' '}
                    {fmt(seed.length)} × {fmt(seed.width)} × {fmt(seed.thickness)} mm{' '}
                    {seed.material === null ? '' : MATERIAL_LABELS[seed.material]}
                  </div>
                  {seed.sentence !== undefined && (
                    // The card is a button, whose text does not wrap; the sentence carries the size the work
                    // needs (#1259), so it wraps and is read in full.
                    <div style={{ ...MUTED, whiteSpace: 'normal' }} data-testid="engrave-setup-stock-provenance">
                      {seed.sentence}
                    </div>
                  )}
                </button>
              </li>
            )}
            {shelfOk &&
              orderedItems.map((item) => {
                const matches = material === null || item.material === material;
                const why = matches
                  ? shelfPickProblem(item, machine)
                  : `a ${MATERIAL_LABELS[item.material]} blank — choose ${MATERIAL_LABELS[item.material]} above to use it`;
                const picked = shelfId === item.id;
                const held = item.quantity - item.reservations.reduce((a, r) => a + r.quantity, 0);
                return (
                  <li key={item.id}>
                    <button
                className="sw-btn"
                      type="button"
                      data-testid={`start-wizard-shelf-item-${item.id}`}
                      data-state={matches ? (why === null ? 'ok' : 'refused') : 'other'}
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
            {/* #1105 item 6 — the list's last row: the fields, seeded from the proposal. */}
            <li>
              <button
                className="sw-btn"
                type="button"
                data-testid="start-wizard-stock-other-size"
                onClick={() => {
                  pickProposal();
                  setSummaryOpen(false);
                }}
                style={{ width: '100%', textAlign: 'left', padding: 4 }}
              >
                <div style={{ fontSize: 12, color: '#cfe' }}>Other size…</div>
              </button>
            </li>
          </ul>
          {shelfOk && shelfOther.length > 0 && (
            <p style={MUTED} data-testid="start-wizard-shelf-other">
              The shelf also holds {shelfOther.length} blank{shelfOther.length === 1 ? '' : 's'} in other materials.
            </p>
          )}
        </div>
      )}
      <label style={{ ...MUTED, display: 'block' }}>
        <span>Material</span>
        <select
          data-testid="start-wizard-stock-material"
          aria-label="Stock material"
          value={material ?? ''}
          onChange={(e) => {
            materialTouched.current = true;
            setMaterial(e.target.value as StockMaterial);
            setShelfId(null);
            // A different material is an explicit edit: no picked blank remains to summarise.
            setSummaryOpen(false);
          }}
          ref={selectRef}
          style={{ display: 'block', width: '100%', marginTop: 2, ...(material === null ? { border: NEEDED } : {}) }}
        >
          {material === null && (
            <option value="" disabled>
              Choose a material
            </option>
          )}
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
                className="sw-btn"
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

      {!summaryOpen && (
        <>
      <p style={{ ...MUTED, margin: '8px 0 0' }}>Size</p>
      {/* #1105 — mm / in beside Size: the job stays mm, inches are a typing unit. */}
      <span
        data-testid="start-wizard-size-unit"
        role="group"
        aria-label="Size units"
        style={{ ...MUTED, display: 'inline-flex', alignItems: 'baseline', gap: 4, margin: '2px 0 0' }}
      >
        {/* The section label above already says Size (#1105 review): the toggle is only the unit. */}
        <button
                className="sw-btn"
          type="button"
          data-testid="start-wizard-size-mm"
          aria-pressed={unit === 'mm'}
          onClick={() => {
            setUnit('mm');
            setLastInch(null);
            setInchText({});
          }}
        >
          mm
        </button>
        <button
                className="sw-btn"
          type="button"
          data-testid="start-wizard-size-in"
          aria-pressed={unit === 'in'}
          onClick={() => {
            setUnit('in');
            setInchText({});
          }}
        >
          in
        </button>
      </span>
        </>
      )}
      {/* #1099 — the numbers get the picture beside them: the part's footprint on this blank, its
          margins, and the warning when a typed number no longer holds it. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          {summaryOpen ? (
            <p style={{ ...MUTED, margin: '8px 0 0' }} data-testid="start-wizard-stock-summary">
              {selectionSummary()}{' '}
              <button
                className="sw-btn"
                type="button"
                data-testid="start-wizard-stock-summary-edit"
                onClick={() => {
                  // The entry becomes the operator's own: the fields open on the picked numbers.
                  setShelfId(null);
                  setSummaryOpen(false);
                }}
                style={LINK_BUTTON}
              >
                edit
              </button>
            </p>
          ) : (
            <>
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
                    style={sizeEntered ? SIZE_INPUT : { ...SIZE_INPUT, border: NEEDED }}
                    data-testid={`start-wizard-make-${key}`}
                    aria-label={`Stock ${SIZE_LABELS[key]}`}
                    value={shownDim(key)}
                    onChange={(e) => editShownDim(key, e.target.value)}
                    onBlur={() => commitDim(key)}
                  />
                  {unit}
                </span>
              </label>
            ))}
          </div>
            </>
          )}
        </div>
        {part != null && drawnBlank !== null && (
          <div style={{ flex: '1 1 260px', maxWidth: 340 }}>
            <BlankWithPart blank={drawnBlank} part={part} />
          </div>
        )}
      </div>
      {/* #1105 — an inch entry states both numbers: the typed inches and the stored millimetres. */}
      {!summaryOpen && unit === 'in' && lastInch !== null && (
        <p style={MUTED} data-testid="start-wizard-stock-size-both">
          {lastInch}
        </p>
      )}
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
      {seededNumbers && !seedSentenceInCard && (
        <p style={MUTED} data-testid="engrave-setup-stock-provenance">
          {seedSeen.sentence ??
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
        {material === null ? null : finishHintFor(material)}
      </p>

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

      {/* #1098 — the model-as-blank loader moves UNDER TECHNICAL, renamed: it is not the design
          door (the question step is), and an accidental pick here must not read as one. */}
      <details data-testid="start-wizard-stock-technical" style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 12, cursor: 'pointer' }}>Technical</summary>
        <p style={MUTED} data-testid="start-wizard-load-hint">
          For a blank that is not a box — the design still comes from the question step.
        </p>
        <WizardFileField
          drop
          accept=".stl,.3mf,.obj,.step,.stp"
          inputTestId="start-wizard-load-file"
          inputLabel="Stock file"
          testId="start-wizard-load"
          nameTestId="start-wizard-load-name"
          errorTestId="start-wizard-load-error"
          chooseLabel="Use a model as the blank's shape (STL, 3MF, OBJ, STEP)…"
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
      </details>

      {outcome.notes.length > 0 && (
        <div data-testid="start-wizard-stock-notes">
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
