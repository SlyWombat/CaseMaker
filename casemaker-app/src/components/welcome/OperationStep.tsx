/**
 * #681/#685 — the question step of the one cutting-job wizard: the operation.
 *
 * The picker is the SHARED grouped one (`OperationPicker`, `operationTypes.ts`): the fourteen
 * operations in the mockup's four groups, the same words the panel's "+ Add operation" uses. The
 * chosen operation shows the one thing it cannot start without, under the grid — the text for an
 * engraving (with its recommended depth and font beside it, as the mockup draws them), the FILE
 * for Surface a mesh, nothing for a Pocket (it gets its size in the panel) (#685).
 *
 * It never creates the placeholder "New text" the old flow did (#679 §3.5, E3): an engraving with
 * no text is not a job, so Create waits and the sentence beside it says what to type. Surface a
 * mesh is a WHOLE-JOB operation, so on a job that already holds items its card is disabled with
 * its reason, not replaced by a sentence (B6).
 *
 * The store actions are the shell's (`onCreate`): this component decides WHAT was asked for, and
 * the shell makes it, opens its row and lands in Design — the one place that knows the wizard's
 * exit.
 */

import { useLayoutEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { newItemDepthFor, newTargetObjectId, useEngraveJobStore } from '@/store/engraveJobStore';
import type { PcbAlignmentOffer } from '@/engine/import/pcbAlignment';
import { pcbReHoldNote } from '@/engine/import/pcbHold';
import { readGoalObjectFile } from '@/engine/import/targetObject';
import { parseOutlineFile, type OutlineImport } from '@/engine/import/outlineImport';
import { shopDefault } from '@/store/shopDefaultsStore';
import { proposeStock } from '@/engine/cnc/stockProposal';
import { FontPicker } from '@/components/panels/FontPicker';
import { OperationPicker } from '@/components/panels/OperationPicker';
import { SELECTED_FILL, useSelectionChipGrid } from '@/components/selectionChip';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { RotaryOperationPicker } from './RotaryOperationPicker';
import { PresetArt } from './PresetArt';
import {
  LETTER_SIZES,
  WIZARD_PRESETS,
  defaultPresetAnswers,
  letterSizeMm,
  presetChoice,
  type PresetAnswers,
  type PresetId,
} from './presets';
import { WizardDropZone } from './WizardDropZone';
import { WizardFileField } from './WizardFileField';
import { WizardThumbnail } from './WizardThumbnail';
import { workShapeFor } from './workShape';
import { operationCreateBlocked } from './operationCreate';
import { isSideGoal, jobHasItems, jobSetups, jobTargetObjects, jobTool, sideSetupIdOf } from '@/engine/cnc/engrave/jobSetup';
import { defaultFaceOperation } from '@/engine/cnc/rotary/faceOps';
import { cuttingDiameter } from '@/engine/cnc/tool';
import type { RotaryOperationId } from './rotaryOperations';
import { operationType, type OperationTypeId } from '@/components/panels/operationTypes';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { TextFont } from '@/types/textLabel';

/**
 * #1098 — THE FILE DOOR'S KINDS. The question step accepts every file the app reads and lets the
 * format choose the operation; the list lives here, once, for the drop zone and the fields.
 */
const MESH_FILE_EXTENSIONS = ['.stl', '.3mf', '.obj', '.step', '.stp'];
const OUTLINE_FILE_EXTENSIONS = ['.svg', '.dxf'];
const GERBER_FILE_EXTENSIONS = [
  '.gbr', '.gtl', '.gbl', '.gko', '.gm1', '.gto', '.gbo', '.gts', '.gbs', '.gtp', '.gbp', '.drl', '.xln', '.zip',
];
export const WIZARD_FILE_ACCEPT = [
  ...MESH_FILE_EXTENSIONS,
  ...OUTLINE_FILE_EXTENSIONS,
  '.png',
  ...GERBER_FILE_EXTENSIONS,
].join(',');
/** The grey kinds line, in the mockup's words. */
export const WIZARD_FILE_KINDS = 'STL · 3MF · STEP · OBJ · SVG · DXF · PNG · Gerber zip';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const FIELD_HEADING: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#c8d3de' };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0' };
const FIELD: CSSProperties = { width: 72 };
const FIELDS: CSSProperties = { display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' };
const FIELD_BOX: CSSProperties = { borderTop: '1px solid #2a2f36', marginTop: 10, paddingTop: 8 };
/** #870 — the engrave box's grid: Text across the box, Depth and Font side by side, labels above. */
const ENGRAVE_FIELDS: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'end' };
const FIELD_STACK: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2, fontSize: 12, margin: 0 };
const FIELD_UNIT_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4 };

/** The job's cutter diameter, mm — the size a cross-hole starts at, so the seed is a hole it cuts. */
function toolDiameterMm(job: EngraveJob): number {
  const tool = jobTool(job);
  const d = tool === null ? null : cuttingDiameter(tool);
  return d !== null && d > 0 ? d : 3.175;
}
/** #1098 — a read drawing's one fact: its size, rings and paths (open ones named). */
function outlineFact(outline: OutlineImport): string {
  const n = (v: number): string => String(Number(v.toFixed(2)));
  const paths = outline.paths ?? [];
  const open = paths.filter((p) => !p.closed).length;
  const contours = `${outline.contours.length} contour${outline.contours.length === 1 ? '' : 's'}`;
  const lines = paths.length === 0 ? '' : ` · ${paths.length} path${paths.length === 1 ? '' : 's'}${open === 0 ? '' : ` · ${open} open`}`;
  return `${n(outline.width)} × ${n(outline.height)} mm · ${contours}${lines}`;
}

/** #870 — a read mesh's one fact beside its name: the box it measures. */
function boxFact(size: { x: number; y: number; z: number }): string {
  const n = (v: number): string => String(Number(v.toFixed(2)));
  return `${n(size.x)} × ${n(size.y)} × ${n(size.z)} mm`;
}
const UNBLOCK: CSSProperties = { fontSize: 11, color: '#e0c07a', margin: '6px 0 0' };
/** #1183 — a secondary action at LINK weight: never a second primary, never a card. */
const LINK: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 12,
  color: '#8ab4f8',
  textDecoration: 'underline',
  cursor: 'pointer',
};
/** #1100 — the preset cards: a picture, a title, and a blurb that is never a tooltip. */
const PRESET: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 3,
  textAlign: 'left',
  padding: '7px 9px',
  borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#2a2f36',
  background: '#121a24',
  color: '#c8d3de',
  cursor: 'pointer',
  font: 'inherit',
};
const PRESET_ON: CSSProperties = { ...PRESET, borderColor: '#4f8ef7', background: '#152238' };

/** #1107 — the three rod intents, as cards in the question's own list. */
const ROD_INTENTS: readonly { id: string; pick: RotaryOperationId; art: PresetId; title: string; blurb: string }[] = [
  { id: 'dowel', pick: 'engrave', art: 'rod-dowel', title: 'Name on a dowel', blurb: 'Text around or along a rod' },
  { id: 'faces', pick: 'faces-all-round', art: 'rod-faces', title: 'Faces on a rod', blurb: 'Evenly spaced flats, indexed' },
  { id: 'relief', pick: 'relief', art: 'rod-relief', title: 'A relief on a rod', blurb: 'A mesh wrapped on the surface' },
];
/** #723 P2-3 — one side of a part cut from several sides, as a choice. */
// Longhands, not the `border` shorthand: the ON fill names `borderColor` (#874).
const SIDE_CHIP: CSSProperties = { fontSize: 11, padding: '4px 8px', borderRadius: 4, borderWidth: 1, borderStyle: 'solid', borderColor: '#2a2f36', background: 'transparent', color: '#c8d3de', cursor: 'pointer' };
/** #874 — the same ON fill every selected control uses (chips, form buttons, sides). */
const SIDE_CHIP_ON: CSSProperties = { ...SIDE_CHIP, ...SELECTED_FILL };

/**
 * What Create asks the shell to make; `null` = nothing new (the job already has its operation).
 *
 * #752 — the rotary step widens two members rather than adding new types: `engrave` carries Reads
 * (along / around), and a `v-carve` may carry text (a V-cut line) with an empty text meaning "a
 * region to draw in the panel"; a `flute` may carry the length its wizard field states. A flat
 * step creates the same members without those fields and behaves exactly as before.
 *
 * #241 slice 2 — the FACE group's three operations are their own members, each carrying the index
 * (A) it is cut at and its one field. The shell writes them as the job's face operations, in the
 * order they were made.
 */
export type OperationChoice =
  | {
      type: 'engrave';
      text: string;
      depth: number;
      font: TextFont;
      reads?: 'along' | 'around';
      /** #1100 — the sign preset's letter size (cap height, mm), which sizes the blank. */
      sizeMm?: number;
      /** #1107 — the answer is for a ROD: the blank is proposed as one and the chuck pre-selected. */
      frame?: 'rotary';
    }
  /** #1100 — Cut out a shape: a rectangle or circle through the blank, held by tabs. */
  | { type: 'cutout'; shape: 'rect' | 'circle'; length: number; width: number; radius: number }
  | {
      type: 'surface';
      target: EngraveTargetObject | null;
      /** #723 P2-3 — the side it is written to. */
      setupId?: string;
      /** #1107 — a relief ON A ROD (a rotary intent from the question step). */
      frame?: 'rotary';
    }
  /**
   * #874 — a circuit board, from its Gerber and drill files. `imported` is whether the set has
   * READ: the files write the job's items themselves, so Create adds nothing and waits only for
   * them to be in.
   */
  | {
      type: 'pcb';
      imported: boolean;
      /** #897 — the board's outline, when the set read: the stock step sizes a blank from it. */
      board?: { length: number; width: number };
    }
  /** #241 slice 2 — a flat on a face: the index and the depth. */
  | { type: 'flat'; a: number; depth: number }
  /** #241 slice 2 — evenly spaced flats: the first index, the count, and the across-flats. */
  | { type: 'faces-all-round'; a: number; count: number; acrossFlats: number; frame?: 'rotary' }
  /** #241 slice 2 — a cross-hole: the index and the diameter. */
  | { type: 'cross-hole'; a: number; diameter: number }
  /**
   * #1098 — a DRAWING read on the question step (SVG/DXF). `use` is what to do with it: Cut it
   * out (a profile with the shop's tabs), Pocket it (a flat floor at `depth`), or Carve it (a V
   * region — the job's cutter decides the V, exactly as the panel's own chips do).
   */
  | { type: 'outline'; outline: OutlineImport; use: 'profile' | 'pocket' | 'v-carve'; depth?: number }
  | {
      type: Exclude<OperationTypeId, 'engrave' | 'surface' | 'pcb'>;
      text?: string;
      lengthMm?: number;
      /**
       * #1100 — A pocket or tray, when the preset card's numbers ride on the choice. A bare
       * `{ type: 'pocket' }` is still the picker's chip (an unplaced rect the panel sizes).
       */
      length?: number;
      width?: number;
      depth?: number;
      radius?: number;
    };

export interface OperationStepProps {
  job: EngraveJob;
  /** Whether the job already has an operation: a template's seeded line, or an imported design. */
  hasOperations: boolean;
  /**
   * #897 — this run has not started its job yet: the shipped demo lines are not this job's work,
   * and the stock step replaces them. The step opens on Engrave text and offers Surface a mesh,
   * exactly as it did when it came after the stock step.
   */
  fresh?: boolean;
  /**
   * #897 — the answer the shell already holds, when the step is re-mounted (Back from the stock
   * step). Its fields seed the step, so going back to change one does not lose the rest — the
   * picked file, the typed text, or the board already read into the job.
   */
  initial?: OperationChoice | null;
  /** The step's current answer; the SHELL owns the footer, so the step reports rather than acts. */
  onChoiceChange: (choice: OperationChoice | null) => void;
  /**
   * #1107 — WHAT THE ROTARY IS, from the shell: whether the house OWNS one (the intents are
   * offered) and whether it is on the pins now (the intents are listed first). A new run used to
   * meet the rotary only after step 4, so the rod path was unreachable.
   */
  rotaryFacts?: { owned: boolean; onPins: boolean };
  /**
   * #1183 — THE EMPTY JOB'S OWN DOOR. A secondary, link-weight action under the presets and the
   * file zone, on a NEW run only (`fresh`): the shell creates the empty job (asking first when
   * the open job carries work) and walks on to Stock exactly as a pick does. It is not the
   * primary: the primary keeps #1107's refusal when nothing is picked.
   */
  onStartEmptyJob?: () => void;
}

/** A flat-job picker id, or null for a choice only the rotary picker draws (or no choice). */
function flatPickOf(choice: OperationChoice | null): OperationTypeId | null {
  if (choice === null) return null;
  switch (choice.type) {
    case 'engrave':
    case 'surface':
    case 'pcb':
    case 'v-carve':
    case 'pocket':
    case 'flute':
    case 'v-carve-variable':
    case 'inlay':
    case 'profile':
    case 'chamfer':
    case 'hole':
    case 'bore':
    case 'thread':
    case 'thread-external':
    case 'texture':
    case 'prism':
      return choice.type;
    case 'outline':
      // #1098 — a drawing has no chip in the picker; it IS the operation the format chose.
      return null;
    default:
      return null;
  }
}

export function OperationStep({
  job,
  hasOperations,
  fresh = false,
  initial = null,
  onChoiceChange,
  rotaryFacts = { owned: false, onPins: false },
  onStartEmptyJob,
}: OperationStepProps): JSX.Element {
  // #897 — a re-mounted step starts from the answer the shell holds: Back is an edit, not a reset.
  const seed = initial;
  // #897 — on a run that has not started its job, the job's shipped demo lines are not its work:
  // the step opens the way it did when it came after the stock step, on Engrave text.
  const workExists = hasOperations && !fresh;
  // The mockup's default: Engrave text is on for a job that has nothing to cut yet. A job that
  // already has an operation starts with nothing selected, so Create finishes without adding a
  // duplicate — a template's seeded line IS the item the last step would otherwise make.
  const [picked, setPicked] = useState<OperationTypeId | null>(() =>
    seed === null ? (workExists ? null : 'engrave') : flatPickOf(seed),
  );
  // #752 R-UI-4 — on a rod in the chuck the step is the rotary one (§3.6): its own three groups,
  // and each operation's one field. `rotaryPicked` is null on a job that already has work, so
  // Create finishes without adding a duplicate — the same rule the flat picker follows.
  //
  // #1107 — AND A NEW FLAT RUN CAN CHOOSE THE ROD: picking a rod intent turns the same step into
  // the rotary one, so the answer states its frame and the blank/Holding follow it.
  const rotaryJob = rotaryMapOf(job) !== null;
  const [frameRotary, setFrameRotary] = useState(seed !== null && 'frame' in seed && seed.frame === 'rotary');
  /** #1107 — the named sentence a FRAME CHANGE leaves when the pick does not exist in the other. */
  const [droppedPick, setDroppedPick] = useState<string | null>(null);
  const rotary = rotaryJob || frameRotary;
  /** #1107 — the rod intents: an entry to the rotary step from a job that is not one yet. */
  const startRotary = (pick: RotaryOperationId): void => {
    // A flat pick that the rotary step does not know is dropped BY NAME, never silently.
    const ROTARY_COMPATIBLE: readonly OperationTypeId[] = ['engrave', 'surface', 'pocket', 'v-carve', 'flute'];
    const flatLabel = picked === null ? null : operationType(picked).label;
    setDroppedPick(
      picked !== null && !ROTARY_COMPATIBLE.includes(picked) && flatLabel !== null
        ? `${flatLabel} is a flat-stock operation — on a rod, choose again.`
        : outline !== null
          ? 'Your drawing is a flat-stock operation — on a rod, choose again.'
          : null,
    );
    setFrameRotary(true);
    setRotaryPicked(pick);
    setPickedByOperator(true);
    setPicked(null);
    setOutline(null);
    setOutlineFileName(null);
    setOutlineError(null);
    setDropError(null);
  };
  const rotaryPickOf = (choice: OperationChoice | null): RotaryOperationId | null => {
    if (choice === null) return null;
    switch (choice.type) {
      case 'engrave':
      case 'v-carve':
      case 'pocket':
      case 'flute':
      case 'flat':
      case 'faces-all-round':
      case 'cross-hole':
        return choice.type;
      case 'surface':
        return 'relief';
      default:
        return null;
    }
  };
  const [rotaryPicked, setRotaryPicked] = useState<RotaryOperationId | null>(() =>
    seed === null ? (workExists ? null : 'engrave') : rotaryPickOf(seed),
  );
  // #1123 item 3 — PICKED BY THE OPERATOR. The mockup highlights Engrave text for a job with no
  // work; that highlight is a default, not an answer. Until a chip is clicked (or the step is
  // re-opened with the answer it had), an empty Engrave text is "nothing picked": the primary
  // finishes with the empty job instead of waiting for invented text. Picking the chip keeps the
  // amber sentence and the hold.
  const [pickedByOperator, setPickedByOperator] = useState(seed !== null);
  // #1100 — WHAT ARE YOU MAKING? The eight preset cards are the step's first question; the
  // sixteen chip picker lives under *Something else…*.
  const [preset, setPreset] = useState<PresetId | null>(() =>
    seed?.type === 'engrave' ? 'sign' : seed?.type === 'cutout' ? 'cutout' : seed?.type === 'pocket' ? 'pocket' : null,
  );
  const [answers, setAnswers] = useState<PresetAnswers>(() => ({
    ...defaultPresetAnswers(),
    ...(seed?.type === 'engrave' ? { text: seed.text, font: seed.font } : {}),
    ...(seed?.type === 'cutout'
      ? { shape: seed.shape, lengthMm: seed.length, widthMm: seed.width, radiusMm: seed.radius }
      : {}),
    ...(seed?.type === 'pocket' && seed.length !== undefined
      ? { lengthMm: seed.length, widthMm: seed.width ?? 0, depthMm: seed.depth ?? 6, radiusMm: seed.radius ?? 0 }
      : {}),
  }));
  const choosePreset = (id: PresetId): void => {
    setPreset(id);
    setDropError(null);
    if (id === 'part-3d') pickFlat('surface');
    else if (id === 'pcb') pickFlat('pcb');
    else if (id === 'dowel') setRotaryPicked('engrave');
    else setPicked(null);
    // The card's own selection lands after any picker reset the branch above performed.
    setPreset(id);
  };
  // #1098 — THE FILE FIRST. An SVG/DXF read here is the step's answer even though the picker has
  // no chip for it: the format chose the operation. A chip click puts the drawing away again.
  // #897's rule applies to the drawing too: Back from the stock step is an edit, not a reset.
  const [outline, setOutline] = useState<OutlineImport | null>(seed?.type === 'outline' ? seed.outline : null);
  const [outlineFileName, setOutlineFileName] = useState<string | null>(
    seed?.type === 'outline' ? seed.outline.sourceName : null,
  );
  const [outlineUse, setOutlineUse] = useState<'profile' | 'pocket' | 'v-carve'>(
    seed?.type === 'outline' ? seed.use : 'profile',
  );
  const [outlineDepth, setOutlineDepth] = useState(() =>
    seed?.type === 'outline' && seed.depth !== undefined ? seed.depth : newItemDepthFor(job),
  );
  const [outlineReading, setOutlineReading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  /** #1098 — the drop zone's one-sentence refusal for a file the app does not read. */
  const [dropError, setDropError] = useState<string | null>(null);
  const pickFlat = (id: OperationTypeId, keepFold = false): void => {
    // #1100 — a FILE (or a card) is an alternative to the fold; a chip clicked INSIDE the fold
    // keeps it open, so the picker does not disappear under the operator's next click.
    if (!keepFold) setPreset(null);
    // #1107 — a flat chip is the way back to flat stock; a rod pick it cannot carry is named.
    if (frameRotary) {
      const ROD_LABEL: Partial<Record<RotaryOperationId, string>> = {
        flat: 'The flat on a face',
        'faces-all-round': 'Faces all round',
        'cross-hole': 'The cross-hole',
      };
      const carried = rotaryPicked === 'engrave' || rotaryPicked === 'v-carve' || rotaryPicked === 'pocket' || rotaryPicked === 'flute' || rotaryPicked === 'relief';
      setDroppedPick(
        !carried && rotaryPicked !== null
          ? `${ROD_LABEL[rotaryPicked] ?? 'Your rod answer'} is a rod operation — on flat stock, choose again.`
          : null,
      );
    }
    setFrameRotary(false);
    // #1098 — the picker is the alternative to the file; clicking a chip clears the drawing.
    setOutline(null);
    setOutlineFileName(null);
    setOutlineError(null);
    setDropError(null);
    setPicked(id);
    setPickedByOperator(true);
  };
  const pickRotary = (id: RotaryOperationId): void => {
    setRotaryPicked(id);
    setPickedByOperator(true);
  };
  const [reads, setReads] = useState<'along' | 'around'>(
    seed?.type === 'engrave' && seed.reads !== undefined ? seed.reads : 'along',
  );
  const [vcarveText, setVcarveText] = useState(seed?.type === 'v-carve' ? (seed.text ?? '') : '');
  const [fluteLengthMm, setFluteLengthMm] = useState(
    seed?.type === 'flute' && seed.lengthMm !== undefined ? seed.lengthMm : 20,
  );
  // #241 slice 2 — THE FACE GROUP'S one field each, seeded by `defaultFaceOperation` (§5): a Flat
  // at 0° and 1 mm; a hex whose across-flats is the largest inside the stock; a cross-hole at 0°
  // on the job's own cutter. The angle is the FIRST face for a ring.
  const faceRadiusMm = rotaryMapOf(job)?.radius ?? 0;
  const faceDefaults = defaultFaceOperation('flat', faceRadiusMm, toolDiameterMm(job));
  const faceAngleOf = (choice: OperationChoice | null): number =>
    choice !== null && (choice.type === 'flat' || choice.type === 'faces-all-round' || choice.type === 'cross-hole')
      ? choice.a
      : 0;
  const [faceAngle, setFaceAngle] = useState(() => faceAngleOf(seed));
  const [faceDepth, setFaceDepth] = useState(seed?.type === 'flat' ? seed.depth : (faceDefaults.depth ?? 1));
  const [facesCount, setFacesCount] = useState(seed?.type === 'faces-all-round' ? seed.count : 6);
  const [facesAcross, setFacesAcross] = useState(() =>
    seed?.type === 'faces-all-round'
      ? seed.acrossFlats
      : (defaultFaceOperation('faces-all-round', faceRadiusMm, toolDiameterMm(job)).acrossFlats ?? 0),
  );
  const [holeDiameter, setHoleDiameter] = useState(() =>
    seed?.type === 'cross-hole'
      ? seed.diameter
      : (defaultFaceOperation('cross-hole', faceRadiusMm, toolDiameterMm(job)).diameter ?? 0),
  );
  const [text, setText] = useState(seed?.type === 'engrave' ? seed.text : '');
  // The blank's recommended depth (the stock kind decides it), editable here; never a hidden 0.5.
  const [depth, setDepth] = useState(seed?.type === 'engrave' ? seed.depth : newItemDepthFor(job));
  const [font, setFont] = useState<TextFont>(seed?.type === 'engrave' ? seed.font : DEFAULT_FONT_ID);
  // The Surface a mesh pick's one field: the file, read here into the job's GOAL (#685).
  const [surface, setSurface] = useState<EngraveTargetObject | null>(seed?.type === 'surface' ? seed.target : null);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  /** #825 — the unit the picked OBJ's numbers were read as, stated beside the picker. */
  const [surfaceNote, setSurfaceNote] = useState<string | null>(null);
  const [surfaceReading, setSurfaceReading] = useState(false);
  /** #870 — the name of the file last picked, read or refused: the file field shows it either way. */
  const [surfaceFileName, setSurfaceFileName] = useState<string | null>(
    seed?.type === 'surface' && seed.target !== null ? seed.target.name : null,
  );
  // #721 — what the goal makes: the part itself, or a mold to cast it in.
  const [makeMold, setMakeMold] = useState(
    seed?.type === 'surface' && seed.target !== null && seed.target.goalMode === 'mold',
  );
  // #743 P-4b — the circuit-board door, a chip in "From a file" since #874. The set writes its
  // items through the store's one import action; the step reads the files, reports the outcome,
  // and its `pcb` choice blocks Create only until the set has read (the files ARE the design, so
  // Create adds no placeholder).
  const [pcbReading, setPcbReading] = useState(false);
  /** Whether the last picked set READ; the summary may be replaced by a notice, this may not. */
  const [pcbImported, setPcbImported] = useState(seed?.type === 'pcb' ? seed.imported : false);
  /** #897 — the board's outline the set read, for the stock step's proposal. */
  const [pcbBoard, setPcbBoard] = useState<{ length: number; width: number } | null>(
    seed?.type === 'pcb' && seed.board !== undefined ? seed.board : null,
  );
  const [pcbSummary, setPcbSummary] = useState<string | null>(
    // #897 — coming Back to the step keeps the board's own fact; the file names it came from are
    // the import's to keep, and they are in the job's source files.
    seed?.type === 'pcb' && seed.board !== undefined
      ? `The board is in: ${String(Number(seed.board.length.toFixed(2)))} × ${String(Number(seed.board.width.toFixed(2)))} mm.`
      : null,
  );
  /** #870 — the picked set, named for the file field, and its refusal when the set did not read. */
  const [pcbFilesName, setPcbFilesName] = useState<string | null>(null);
  const [pcbError, setPcbError] = useState<string | null>(null);
  // #743 P-4b review — the board-on-a-non-PCB-blank fact and its one-click fix; never a refusal.
  const [pcbStockFix, setPcbStockFix] = useState<string | null>(null);
  // #743 P-6 — a board on a holding of the operator's (the vise): stated with its one-click fix.
  const [pcbHoldingFix, setPcbHoldingFix] = useState<string | null>(null);
  // #723 P2-3 — THE WIZARD'S SIDES SURFACE. A job cut from more than one saved setup shows its
  // sides here, and the mesh picked below is written to the chosen side (`withSideGoal`), never
  // over the job's single target. One side (the ordinary job) keeps today's behaviour.
  const savedSides = job.setups !== undefined && job.setups.length > 1 ? jobSetups(job) : [];
  const sideGoals = jobTargetObjects(job).filter(isSideGoal);
  const [sideId, setSideId] = useState<string | null>(savedSides[0]?.id ?? null);
  const selectedSide = savedSides.some((s) => s.id === sideId) ? sideId : (savedSides[0]?.id ?? null);
  const goalForSide = (id: string): EngraveTargetObject | null =>
    sideGoals.find((g) => sideSetupIdOf(job, g) === id) ?? null;
  // #743 P-8 — a two-sided board whose holes the fitted probe cannot read, with its one-click offer.
  const [pcbAlignment, setPcbAlignment] = useState<PcbAlignmentOffer | null>(null);

  // #1107 — the answer's frame, when the rod intents chose it.
  const frame = frameRotary ? ({ frame: 'rotary' } as const) : {};
  const surfaceChoice: OperationChoice = {
    type: 'surface',
    target:
      surface === null || !makeMold || surface.format === 'png' ? surface : { ...surface, goalMode: 'mold' },
    ...(selectedSide === null ? {} : { setupId: selectedSide }),
    ...frame,
  };
  const choice: OperationChoice | null = rotary
    ? rotaryPicked === 'engrave'
      ? { type: 'engrave', text, depth, font, reads, ...frame }
      : rotaryPicked === 'v-carve'
        ? { type: 'v-carve', text: vcarveText }
        : rotaryPicked === 'pocket'
          ? { type: 'pocket' }
          : rotaryPicked === 'flute'
            ? { type: 'flute', lengthMm: fluteLengthMm }
            : rotaryPicked === 'relief'
              ? surfaceChoice
              : rotaryPicked === 'flat'
                ? { type: 'flat', a: faceAngle, depth: faceDepth }
                : rotaryPicked === 'faces-all-round'
                  ? { type: 'faces-all-round', a: faceAngle, count: facesCount, acrossFlats: facesAcross, ...frame }
                  : rotaryPicked === 'cross-hole'
                    ? { type: 'cross-hole', a: faceAngle, diameter: holeDiameter }
                    : null
    : preset === 'sign'
      ? // #1100 — the sign's depth is the job's stock-aware default, as every engrave entry's is.
        { type: 'engrave', text: answers.text, depth: newItemDepthFor(job), font: answers.font, sizeMm: letterSizeMm(answers.letterSize) }
      : preset === 'cutout' || preset === 'pocket'
      ? presetChoice(preset, answers)
      : outline !== null
      ? { type: 'outline', outline, use: outlineUse, ...(outlineUse === 'pocket' ? { depth: outlineDepth } : {}) }
      : picked === 'engrave'
      ? { type: 'engrave', text, depth, font }
      : picked === 'surface'
        ? surfaceChoice
        : picked === 'pcb'
          ? { type: 'pcb', imported: pcbImported, ...(pcbBoard === null ? {} : { board: pcbBoard }) }
          : picked === null
            ? null
            : { type: picked };
  // #1123 item 3 — the highlighted-but-untouched Engrave text is nothing picked: report null, so
  // the shell's primary creates the empty job and no amber sentence is drawn.
  const untouchedEngrave =
    !pickedByOperator &&
    (rotary ? rotaryPicked === 'engrave' : picked === 'engrave') &&
    text.trim() === '';
  const reportedChoice = untouchedEngrave ? null : choice;
  // #1099 — the blank this file will be cut from, stated under its thumbnail. The Stock step
  // still carries the full provenance sentence; this is the promise of the numbers to come.
  const proposalSentence = useMemo(() => {
    if (reportedChoice === null) return null;
    const proposal = proposeStock(workShapeFor(reportedChoice, job));
    if (proposal === null) return null;
    const n = (v: number): string => String(Number(v.toFixed(2)));
    return `Will cut on a ${n(proposal.length)} × ${n(proposal.width)} × ${n(proposal.thickness)} mm ${
      proposal.form === 'plate' ? 'plate' : proposal.form
    } — change on the next step.`;
  }, [reportedChoice, job]);
  // #1107 — a NULL choice is the SHELL's rule (a new run is refused, a re-entry's Done is not),
  // so its sentence belongs in the footer, not in a field that does not exist.
  const unblock = reportedChoice === null ? null : operationCreateBlocked(reportedChoice);
  // #874 — the sentence names the FIELD it is about, so it renders in that chip's own field box,
  // directly under the field, never at the foot of the step 300 px away from the Text input.
  const unblockLine =
    unblock === null ? null : (
      <p style={UNBLOCK} data-testid="start-wizard-create-unblock">
        {unblock}
      </p>
    );

  // Report on every input change: the footer's Create is the shell's, and it enables the moment the
  // answer is one that can be made. Keyed on the fields, not the object, so it does not re-fire.
  //
  // #745 — a LAYOUT effect, not a passive one. The shell's Create is disabled from the answer it
  // was last told, while the sentence beside the field is drawn from `choice` right here. With a
  // passive effect there is a commit — long enough to be painted, and to be caught by a page
  // evaluation, under load — where the text has arrived (so this sentence is gone) but the shell
  // still holds the empty answer (so Create is disabled with no words). The layout effect hands the
  // answer over in the same commit, before paint, so the button and its sentence never disagree.
  useLayoutEffect(() => {
    onChoiceChange(reportedChoice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, pickedByOperator, text, depth, font, surface, makeMold, pcbImported, pcbBoard, rotary, rotaryPicked, reads, vcarveText, fluteLengthMm, selectedSide, faceAngle, faceDepth, facesCount, facesAcross, holeDiameter, outline, outlineUse, outlineDepth, preset, answers, onChoiceChange]);

  async function readPcbSet(files: File[]): Promise<void> {
    setPcbSummary(null);
    setPcbImported(false);
    setPcbStockFix(null);
    setPcbHoldingFix(null);
    setPcbAlignment(null);
    setPcbError(null);
    setPcbFilesName(files.length === 1 ? files[0]!.name : `${files.length} files · ${files[0]!.name}`);
    setPcbReading(true);
    try {
      const out = await useEngraveJobStore.getState().importPcbFiles(files);
      if (!out.ok) {
        setPcbError(out.reason);
        setPcbBoard(null);
      } else {
        setPcbImported(true);
        setPcbBoard({ length: out.board.width, width: out.board.height });
      }
      setPcbSummary(
        out.ok
          ? `The board is in: ${out.itemCount} items from ${out.fileCount} files${out.twoSided ? ', cut on both faces' : ''}${out.warnings.length > 0 ? ` — ${out.warnings.map((w) => w.message).join(' ')}` : ''}`
          : null,
      );
      if (out.ok) {
        setPcbStockFix(out.stockNotice);
        setPcbHoldingFix(out.holdingNotice);
        setPcbAlignment(out.alignment);
      }
    } finally {
      setPcbReading(false);
    }
  }

  async function chooseGoal(file: File): Promise<void> {
    setSurfaceError(null);
    setSurfaceNote(null);
    setSurfaceFileName(file.name);
    setSurfaceReading(true);
    try {
      const result = await readGoalObjectFile(file, newTargetObjectId(), job.stock);
      if (result.ok) {
        setSurface(result.target);
        setSurfaceNote(result.note ?? null);
      } else {
        // The refused file is the one named in the field, so the mesh before it is no longer the
        // answer: Create waits for a file that reads.
        setSurface(null);
        setSurfaceError(result.error);
      }
    } catch (e) {
      setSurface(null);
      setSurfaceError(e instanceof Error ? e.message : String(e));
    } finally {
      setSurfaceReading(false);
    }
  }

  /**
   * #1098 — THE FORMAT CHOOSES THE OPERATION. One door for every kind the app reads: a mesh or a
   * picture is today's Surface a mesh, an SVG/DXF the outline choice, a Gerber set the board. An
   * unknown file changes nothing and says what the app does read.
   */
  async function acceptFiles(files: File[]): Promise<void> {
    const file = files[0];
    if (file === undefined) return;
    setDropError(null);
    const dot = file.name.lastIndexOf('.');
    const ext = dot < 0 ? '' : file.name.slice(dot).toLowerCase();
    if (MESH_FILE_EXTENSIONS.includes(ext) || ext === '.png') {
      pickFlat('surface');
      await chooseGoal(file);
      return;
    }
    if (OUTLINE_FILE_EXTENSIONS.includes(ext)) {
      await readOutline(file);
      return;
    }
    if (GERBER_FILE_EXTENSIONS.includes(ext)) {
      pickFlat('pcb');
      await readPcbSet(files);
      return;
    }
    setDropError(
      `Case Maker reads STL, 3MF, STEP, OBJ, SVG, DXF, PNG and Gerber files — this is ${
        ext === '' ? 'a file with no extension' : `a ${ext}`
      }.`,
    );
  }

  /** #1098 — read a drawing with the panel's own parser; its size proposes the blank. */
  async function readOutline(file: File): Promise<void> {
    setDropError(null);
    setOutlineError(null);
    setOutlineFileName(file.name);
    setOutlineReading(true);
    try {
      const result = parseOutlineFile(await file.text(), file.name, {
        // #451 — the arc chord error is the shop's, read exactly where the panel reads it.
        dxfChordToleranceMm: shopDefault('import.dxfChordToleranceMm').value,
      });
      if (result.ok) {
        setPreset(null);
        setOutline(result.outline);
        setOutlineUse('profile');
        setOutlineDepth(newItemDepthFor(job));
        // The drawing IS the answer: no picker chip is selected beside it.
        setPicked(null);
        setPickedByOperator(false);
      } else {
        setOutline(null);
        setOutlineError(result.error);
      }
    } catch (e) {
      setOutline(null);
      setOutlineError(e instanceof Error ? e.message : String(e));
    } finally {
      setOutlineReading(false);
    }
  }

  // #1100 — on a flat job the sign CARD owns the text question; the raw chip's field belongs to
  // the *Something else…* fold (a rotary job keeps its own engrave field as before).
  const engraveField = rotary ? rotaryPicked === 'engrave' : preset === 'something-else' && picked === 'engrave';
  const surfaceField = rotary ? rotaryPicked === 'relief' : picked === 'surface';
  // #874 — the board is the second file chip, so its field is the chosen chip's box like any other.
  const pcbField = !rotary && picked === 'pcb';
  const vcarveField = rotary && rotaryPicked === 'v-carve';
  const pocketField = rotary && rotaryPicked === 'pocket';
  const fluteField = rotary && rotaryPicked === 'flute';
  // #241 slice 2 — the face group: each operation's one field, and the index it is cut at.
  const faceField = rotary && (rotaryPicked === 'flat' || rotaryPicked === 'faces-all-round' || rotaryPicked === 'cross-hole');
  const sideGrid = useSelectionChipGrid();
  // #1107 — the rod intents as cards in the question's own list.
  const rodCards = (
    <div data-testid="start-wizard-rotary-intents" role="group" aria-label="On a rod" style={{ margin: '0 0 8px' }}>
      <div style={FIELD_HEADING}>On a rod</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 4 }}>
        {ROD_INTENTS.map((intent) => (
          <button
            key={intent.id}
            type="button"
            data-testid={`start-wizard-rotary-intent-${intent.id}`}
            onClick={() => startRotary(intent.pick)}
            style={PRESET}
          >
            <span style={{ color: '#c9d4e2', lineHeight: 0 }}>
              <PresetArt id={intent.art} />
            </span>
            <b style={{ fontSize: 12, fontWeight: 600 }}>{intent.title}</b>
            <span style={{ fontSize: 11, color: '#9aa4b0', lineHeight: 1.35 }}>{intent.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div
      data-testid="engrave-setup-step-what"
      style={{ marginTop: 8 }}
      // #1098 — the whole step is a drop target, not only the zone: a file dropped anywhere on the
      // question is the same answer. A field inside that already took the drop has prevented it.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        const files = [...(e.dataTransfer.files ?? [])];
        if (files.length > 0) void acceptFiles(files);
      }}
    >
      {!rotary && (
        <WizardDropZone
          accept={WIZARD_FILE_ACCEPT}
          kinds={WIZARD_FILE_KINDS}
          reading={surfaceReading || pcbReading || outlineReading}
          // A refused file — an unknown kind, or a drawing the parser would not read — is said
          // once, under the zone that took it.
          error={dropError ?? outlineError}
          onFiles={(files) => void acceptFiles(files)}
          testId="start-wizard-drop-zone"
          inputTestId="start-wizard-drop-input"
          errorTestId="start-wizard-drop-error"
        />
      )}
      {!rotary && outline !== null && (
        <div data-testid="start-wizard-op-outline-field" style={FIELD_BOX}>
          {/* #1099 (with #1098) — the drawing gets the same thumbnail as a mesh: its rings and
              open paths, and the blank this file will be cut from. */}
          <WizardThumbnail source={{ kind: 'outline', outline }} sentence={proposalSentence} />
          <div style={FIELD_HEADING}>{outlineFileName}</div>
          <p style={MUTED} data-testid="start-wizard-op-outline-fact">
            {outlineFact(outline)}
          </p>
          <div style={FIELDS} role="radiogroup" aria-label="What to do with the drawing">
            <label style={FIELD_LABEL}>
              <input
                type="radio"
                name="start-wizard-op-outline-use"
                checked={outlineUse === 'profile'}
                data-testid="start-wizard-op-outline-cut"
                onChange={() => setOutlineUse('profile')}
              />
              <span>Cut it out</span>
            </label>
            <label style={FIELD_LABEL}>
              <input
                type="radio"
                name="start-wizard-op-outline-use"
                checked={outlineUse === 'pocket'}
                data-testid="start-wizard-op-outline-pocket"
                onChange={() => setOutlineUse('pocket')}
              />
              <span>Pocket it</span>
            </label>
            <label style={FIELD_LABEL}>
              <input
                type="radio"
                name="start-wizard-op-outline-use"
                checked={outlineUse === 'v-carve'}
                data-testid="start-wizard-op-outline-carve"
                onChange={() => setOutlineUse('v-carve')}
              />
              <span>Carve it (V)</span>
            </label>
          </div>
          {outlineUse === 'pocket' && (
            <label style={FIELD_LABEL}>
              <span>Depth</span>
              <input
                type="number"
                min={0}
                step="any"
                data-testid="start-wizard-op-outline-depth"
                aria-label="Pocket depth"
                style={FIELD}
                value={outlineDepth}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setOutlineDepth(v);
                }}
              />
              <span style={MUTED}>mm</span>
            </label>
          )}
          <p style={MUTED}>
            Cut it out profiles the drawing with the shop&apos;s tabs; Pocket and Carve bite into the plate.
          </p>
          {unblockLine}
        </div>
      )}
      {savedSides.length > 0 && (
        <div data-testid="start-wizard-op-sides" style={{ marginBottom: 10 }}>
          <div style={FIELD_HEADING}>Sides</div>
          <p style={MUTED} data-testid="start-wizard-op-sides-note">
            This job is cut from {savedSides.length} sides. A mesh picked below is attached to the
            side you choose; the other sides keep theirs.
          </p>
          <div style={sideGrid} role="radiogroup" aria-label="Which side this mesh is for">
            {savedSides.map((setup, i) => {
              const goal = goalForSide(setup.id);
              return (
                <button
                  key={setup.id}
                  type="button"
                  role="radio"
                  aria-checked={selectedSide === setup.id}
                  data-testid={`start-wizard-op-side-${i}`}
                  onClick={() => setSideId(setup.id)}
                  style={selectedSide === setup.id ? SIDE_CHIP_ON : SIDE_CHIP}
                >
                  Side {i + 1} · {goal === null ? 'no goal yet' : goal.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* #1107 — a frame change's dropped pick is named here, in amber, whichever frame follows. */}
      {droppedPick !== null && (
        <p style={UNBLOCK} data-testid="start-wizard-rotary-dropped">
          {droppedPick}
        </p>
      )}
      {rotary ? (
        <RotaryOperationPicker
          selected={rotaryPicked}
          onPick={pickRotary}
          testidFor={(id) => `start-wizard-op-rotary-${id}`}
        />
      ) : (
        <>
          {/* #1107 — the rod intents are CARDS IN THE SAME LIST: first when the rotary is on the
              pins, after the flat intents otherwise. One door into the question, not two. */}
          {rotaryFacts.owned && rotaryFacts.onPins && rodCards}
          {/* #1100 — WHAT ARE YOU MAKING? Eight intents, each with a visible blurb; the sixteen
              engine chips are under Something else…, where the panel's vocabulary belongs. */}
          <div
            data-testid="start-wizard-presets"
            role="group"
            aria-label="What are you making?"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, margin: '4px 0 8px' }}
          >
            {WIZARD_PRESETS.filter((p) => p.rotaryOnly !== true).map((p) => (
              <button
                key={p.id}
                type="button"
                data-testid={`start-wizard-preset-${p.id}`}
                aria-pressed={preset === p.id}
                onClick={() => choosePreset(p.id)}
                style={preset === p.id ? PRESET_ON : PRESET}
              >
                <span style={{ color: preset === p.id ? '#8ab4f8' : '#c9d4e2', lineHeight: 0 }}>
                  <PresetArt id={p.id} />
                </span>
                <b style={{ fontSize: 12, fontWeight: 600 }}>{p.title}</b>
                <span style={{ fontSize: 11, color: '#9aa4b0', lineHeight: 1.35 }}>{p.blurb}</span>
              </button>
            ))}
          </div>
          {rotaryFacts.owned && !rotaryFacts.onPins && rodCards}
          {preset === 'something-else' && (
            <OperationPicker
              mode="select"
              testidFor={(id) => `engrave-setup-what-${id}`}
              onPick={(id) => pickFlat(id, true)}
              surfaceAllowed={fresh || !jobHasItems(job)}
              selected={picked}
            />
          )}
        </>
      )}

      {/* #1100 — the selected card's questions, in place under its picture. */}
      {!rotary && preset === 'sign' && (
        <div data-testid="start-wizard-preset-questions" style={FIELD_BOX}>
          <label style={{ ...FIELD_STACK, marginBottom: 4 }}>
            <span>Text</span>
            <input
              type="text"
              data-testid="start-wizard-preset-text"
              aria-label="Sign text"
              value={answers.text}
              onChange={(e) => setAnswers({ ...answers, text: e.target.value })}
            />
          </label>
          <div style={FIELDS} role="radiogroup" aria-label="Letter size">
            {LETTER_SIZES.map((s) => (
              <label key={s.id} style={FIELD_LABEL}>
                <input
                  type="radio"
                  name="start-wizard-preset-letter"
                  checked={answers.letterSize === s.id}
                  data-testid={`start-wizard-preset-letter-${s.id}`}
                  onChange={() => setAnswers({ ...answers, letterSize: s.id })}
                />
                <span>
                  {s.label} · {s.mm} mm
                </span>
              </label>
            ))}
          </div>
          <label style={FIELD_STACK} data-testid="start-wizard-preset-font">
            <span>Font</span>
            <FontPicker value={answers.font} onChange={(font) => setAnswers({ ...answers, font })} aria-label="Font" />
          </label>
          {unblockLine}
        </div>
      )}
      {!rotary && preset === 'cutout' && (
        <div data-testid="start-wizard-preset-questions" style={FIELD_BOX}>
          <div style={FIELDS} role="radiogroup" aria-label="Shape">
            <label style={FIELD_LABEL}>
              <input
                type="radio"
                name="start-wizard-preset-shape"
                checked={answers.shape === 'rect'}
                data-testid="start-wizard-preset-shape-rect"
                onChange={() => setAnswers({ ...answers, shape: 'rect' })}
              />
              <span>Rectangle</span>
            </label>
            <label style={FIELD_LABEL}>
              <input
                type="radio"
                name="start-wizard-preset-shape"
                checked={answers.shape === 'circle'}
                data-testid="start-wizard-preset-shape-circle"
                onChange={() => setAnswers({ ...answers, shape: 'circle' })}
              />
              <span>Circle</span>
            </label>
          </div>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>{answers.shape === 'circle' ? 'Diameter' : 'Length'}</span>
              <input
                type="number"
                min={0}
                step="any"
                style={FIELD}
                data-testid="start-wizard-preset-length"
                aria-label="Shape length"
                value={answers.lengthMm}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setAnswers({ ...answers, lengthMm: v });
                }}
              />
              <span style={MUTED}>mm</span>
            </label>
            {answers.shape === 'rect' && (
              <>
                <label style={FIELD_LABEL}>
                  <span>Width</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    style={FIELD}
                    data-testid="start-wizard-preset-width"
                    aria-label="Shape width"
                    value={answers.widthMm}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setAnswers({ ...answers, widthMm: v });
                    }}
                  />
                  <span style={MUTED}>mm</span>
                </label>
                <label style={FIELD_LABEL}>
                  <span>Corner radius</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    style={FIELD}
                    data-testid="start-wizard-preset-radius"
                    aria-label="Corner radius"
                    value={answers.radiusMm}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setAnswers({ ...answers, radiusMm: v });
                    }}
                  />
                  <span style={MUTED}>mm</span>
                </label>
              </>
            )}
          </div>
          {unblockLine}
        </div>
      )}
      {!rotary && preset === 'pocket' && (
        <div data-testid="start-wizard-preset-questions" style={FIELD_BOX}>
          <div style={FIELDS}>
            {(
              [
                ['lengthMm', 'Length', 'start-wizard-preset-length'],
                ['widthMm', 'Width', 'start-wizard-preset-width'],
                ['depthMm', 'Depth', 'start-wizard-preset-depth'],
                ['radiusMm', 'Corner radius', 'start-wizard-preset-radius'],
              ] as const
            ).map(([key, label, testid]) => (
              <label key={key} style={FIELD_LABEL}>
                <span>{label}</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  style={FIELD}
                  data-testid={testid}
                  aria-label={label}
                  value={answers[key]}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setAnswers({ ...answers, [key]: v });
                  }}
                />
                <span style={MUTED}>mm</span>
              </label>
            ))}
          </div>
          {unblockLine}
        </div>
      )}

      {engraveField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={ENGRAVE_FIELDS}>
            <label style={{ ...FIELD_STACK, gridColumn: '1 / -1' }}>
              <span>Text</span>
              <input
                type="text"
                data-testid="start-wizard-op-text"
                aria-label="Engrave text"
                // #1107 — the dowel starter opens here to be typed into.
                autoFocus={seed?.type === 'engrave' && seed.frame === 'rotary'}
                style={{ width: '100%', boxSizing: 'border-box' }}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <label style={FIELD_STACK}>
              <span>Depth</span>
              <span style={FIELD_UNIT_ROW}>
                <input
                  type="number"
                  min={0}
                  step="any"
                  data-testid="start-wizard-op-depth"
                  aria-label="Engrave depth"
                  style={FIELD}
                  value={depth}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setDepth(v);
                  }}
                />
                <span style={MUTED}>mm</span>
              </span>
            </label>
            <label style={FIELD_STACK} data-testid="start-wizard-op-font">
              <span>Font</span>
              <FontPicker value={font} onChange={setFont} aria-label="Font" />
            </label>
            {rotary && (
              // #752 — §3.6's one field for text on a round stock: which way the line reads,
              // along the rod by default (like a pencil's lettering).
              <label style={FIELD_STACK} data-testid="start-wizard-op-reads">
                <span>Reads</span>
                <span style={FIELD_UNIT_ROW}>
                  <select
                    data-testid="start-wizard-op-reads-select"
                    aria-label="Reads"
                    style={FIELD}
                    value={reads}
                    onChange={(e) => setReads(e.target.value === 'around' ? 'around' : 'along')}
                  >
                    <option value="along">along</option>
                    <option value="around">around</option>
                  </select>
                  <span style={MUTED}>the rod</span>
                </span>
              </label>
            )}
          </div>
          {unblockLine}
        </div>
      )}

      {vcarveField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>Text</span>
              <input
                type="text"
                data-testid="start-wizard-op-vcarve-text"
                aria-label="V-carve text"
                style={{ width: 180 }}
                value={vcarveText}
                onChange={(e) => setVcarveText(e.target.value)}
              />
            </label>
            <span style={MUTED}>Leave it empty to draw a region in the panel.</span>
          </div>
          {unblockLine}
        </div>
      )}

      {pocketField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <p style={MUTED} data-testid="start-wizard-op-pocket-note">
            The pocket’s size and place come in the panel — Create adds it, ready to drag.
          </p>
          {unblockLine}
        </div>
      )}

      {fluteField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>Length along</span>
              <input
                type="number"
                min={0}
                step="any"
                data-testid="start-wizard-op-flute-length"
                aria-label="Flute length"
                style={FIELD}
                value={fluteLengthMm}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setFluteLengthMm(v);
                }}
              />
              <span style={MUTED}>mm</span>
            </label>
          </div>
          {unblockLine}
        </div>
      )}

      {faceField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>{rotaryPicked === 'faces-all-round' ? 'First face' : 'Angle'}</span>
              <input
                type="number"
                step="any"
                data-testid="start-wizard-op-face-angle"
                aria-label="Index angle"
                style={FIELD}
                value={faceAngle}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setFaceAngle(v);
                }}
              />
              <span style={MUTED}>°</span>
            </label>
            {rotaryPicked === 'flat' && (
              <label style={FIELD_LABEL}>
                <span>Depth</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  data-testid="start-wizard-op-face-depth"
                  aria-label="Flat depth"
                  style={FIELD}
                  value={faceDepth}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setFaceDepth(v);
                  }}
                />
                <span style={MUTED}>mm</span>
              </label>
            )}
            {rotaryPicked === 'faces-all-round' && (
              <>
                <label style={FIELD_LABEL}>
                  <span>Count</span>
                  <input
                    type="number"
                    min={3}
                    max={24}
                    step={1}
                    data-testid="start-wizard-op-faces-count"
                    aria-label="How many faces"
                    style={FIELD}
                    value={facesCount}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setFacesCount(v);
                    }}
                  />
                </label>
                <label style={FIELD_LABEL}>
                  <span>Across flats</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    data-testid="start-wizard-op-faces-across"
                    aria-label="Across flats"
                    style={FIELD}
                    value={facesAcross}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setFacesAcross(v);
                    }}
                  />
                  <span style={MUTED}>mm</span>
                </label>
              </>
            )}
            {rotaryPicked === 'cross-hole' && (
              <label style={FIELD_LABEL}>
                <span>Diameter</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  data-testid="start-wizard-op-hole-diameter"
                  aria-label="Cross-hole diameter"
                  style={FIELD}
                  value={holeDiameter}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setHoleDiameter(v);
                  }}
                />
                <span style={MUTED}>mm</span>
              </label>
            )}
          </div>
          <p style={MUTED} data-testid="start-wizard-op-face-note">
            {rotaryPicked === 'flat'
              ? `Turned to A ${faceAngle}° and held while the face is cut; the flat is ${faceDepth} mm deep.`
              : rotaryPicked === 'faces-all-round'
                ? `${facesCount} faces, evenly spaced from A ${faceAngle}°, leaving ${facesAcross} mm across flats.`
                : `Turned to A ${faceAngle}° and drilled across; the hole comes out at the cutter's own diameter.`}
          </p>
          {unblockLine}
        </div>
      )}

      {surfaceField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <WizardFileField
            accept={WIZARD_FILE_ACCEPT}
            inputTestId="start-wizard-op-surface-file"
            inputLabel="Mesh to surface"
            testId="start-wizard-op-surface-picker"
            nameTestId="start-wizard-op-surface-name"
            errorTestId="start-wizard-op-surface-error"
            kinds="STL, 3MF, STEP, OBJ, SVG, DXF, PNG or Gerber"
            reading={surfaceReading}
            chosen={
              surfaceFileName === null
                ? null
                : { name: surfaceFileName, fact: surface === null ? null : boxFact(surface.size) }
            }
            error={surfaceError}
            thumbnail={
              surface !== null && surface.data !== undefined ? (
                <WizardThumbnail
                  source={
                    surface.format === 'png'
                      ? { kind: 'picture', name: surface.name, data: surface.data, size: surface.size }
                      : { kind: 'mesh', name: surface.name, data: surface.data, size: surface.size }
                  }
                  sentence={proposalSentence}
                />
              ) : undefined
            }
            onFiles={(files) => {
              // #1098 — a drawing or a Gerber set picked here switches the format; a mesh or a
              // picture is read as before, and an unknown file is refused by this field's own
              // reader, so the sentence lands under the field that took it.
              const file = files[0];
              if (file === undefined) return;
              const dot = file.name.lastIndexOf('.');
              const ext = dot < 0 ? '' : file.name.slice(dot).toLowerCase();
              if (OUTLINE_FILE_EXTENSIONS.includes(ext) || GERBER_FILE_EXTENSIONS.includes(ext)) {
                void acceptFiles(files);
              } else {
                void chooseGoal(file);
              }
            }}
          >
            {surfaceNote !== null && (
              <p style={MUTED} data-testid="start-wizard-op-surface-note">
                {surfaceNote}
              </p>
            )}
          </WizardFileField>
          {/* Part or mould is a question about a MESH: a picture has only the part, and says why. */}
          {surface !== null && (
            <div style={FIELDS} role="radiogroup" aria-label="What to make">
              <label style={FIELD_LABEL}>
                <input
                  type="radio"
                  name="start-wizard-op-surface-make"
                  checked={surface.format === 'png' || !makeMold}
                  data-testid="start-wizard-op-surface-make-part"
                  onChange={() => setMakeMold(false)}
                />
                <span>Make the part</span>
              </label>
              {surface.format !== 'png' && (
                <label style={FIELD_LABEL}>
                  <input
                    type="radio"
                    name="start-wizard-op-surface-make"
                    checked={makeMold}
                    data-testid="start-wizard-op-surface-make-mold"
                    onChange={() => setMakeMold(true)}
                  />
                  <span>Make a mould of it</span>
                </label>
              )}
              {surface.format === 'png' && (
                <p style={MUTED} data-testid="start-wizard-op-surface-picture-note">
                  a picture has one side
                </p>
              )}
            </div>
          )}
          {makeMold && surface !== null && surface.format !== 'png' && (
            <p style={MUTED} data-testid="start-wizard-op-surface-mold-note">
              The part's shape is cut as a cavity from the top, turned over so a casting reads the
              right way round. One side only: a part with undercuts needs a two-part mould.
            </p>
          )}
          {/* #1107 / #1164 — the reliefs' depth limit, stated plainly until the fix lands.
              (Delete this block in one line when #1164 is in.) */}
          {rotary && rotaryPicked === 'relief' && (
            <p style={MUTED} data-testid="start-wizard-rotary-relief-depth-note">
              A relief on the rod can be planned and previewed here, but do not cut it yet. Where
              the shape goes deep towards the rod&apos;s centre, this build can take the cutter up
              to about 1 mm into the design; a fix is on its way.
            </p>
          )}
          {unblockLine}
        </div>
      )}

      {pcbField && (
        <div data-testid="start-wizard-op-pcb" style={FIELD_BOX}>
          <WizardFileField
            accept=".gbr,.gtl,.gbl,.gko,.gm1,.gto,.gbo,.gts,.gbs,.gtp,.gbp,.drl,.xln,.zip"
            multiple
            inputTestId="start-wizard-op-pcb-files"
            inputLabel="Gerber and drill files"
            testId="start-wizard-op-pcb-picker"
            nameTestId="start-wizard-op-pcb-name"
            errorTestId="start-wizard-op-pcb-error"
            kinds="Gerber and drill files, or the board's .zip"
            reading={pcbReading}
            chosen={pcbFilesName === null ? null : { name: pcbFilesName }}
            error={pcbError}
            onFiles={(files) => void readPcbSet(files)}
          />
          <p style={MUTED}>
            The copper, holes and outline become items. A board is cut from copper-clad PCB.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {pcbSummary !== null && !pcbReading && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-summary">
                {pcbSummary}
              </span>
            )}
            {pcbHoldingFix !== null && !pcbReading && job.workholding.kind !== 'tape' && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-holding-notice">
                {pcbHoldingFix}{' '}
                <button
                  type="button"
                  data-testid="start-wizard-op-pcb-use-holding"
                  onClick={() => {
                    const reheld = useEngraveJobStore.getState().usePcbHolding();
                    setPcbHoldingFix(null);
                    // #814 — say what the re-hold did to the turned-over side, if anything.
                    const note = pcbReHoldNote(reheld);
                    if (note !== null) setPcbSummary(note);
                  }}
                >
                  Tape it to the bed
                </button>
              </span>
            )}
            {pcbAlignment !== null && !pcbReading && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-alignment-notice">
                {pcbAlignment.message}{' '}
                {pcbAlignment.holes.length > 0 && (
                  <button
                    type="button"
                    data-testid="start-wizard-op-pcb-add-alignment"
                    onClick={() => {
                      useEngraveJobStore
                        .getState()
                        .addPcbAlignmentHoles(pcbAlignment.holes, pcbAlignment.diameterMm);
                      setPcbAlignment(null);
                    }}
                  >
                    Add two {pcbAlignment.diameterMm} mm alignment holes
                  </button>
                )}
              </span>
            )}
            {pcbStockFix !== null && !pcbReading && job.stock.material !== 'pcb' && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-stock-notice">
                {pcbStockFix}{' '}
                <button
                  type="button"
                  data-testid="start-wizard-op-pcb-use-stock"
                  onClick={() => {
                    useEngraveJobStore.getState().usePcbStock();
                    setPcbStockFix(null);
                  }}
                >
                  Use PCB stock
                </button>
              </span>
            )}
          </div>
          {unblockLine}
        </div>
      )}

      {/* #1183 — THE EMPTY JOB'S DOOR. Under everything the question offers, at link weight:
          starting from nothing is deliberate, never the default press. A NEW run only — a
          re-entry's Done already finishes an existing job. */}
      {fresh && !rotary && onStartEmptyJob !== undefined && (
        <p style={{ margin: '12px 0 2px' }} data-testid="start-wizard-empty-job-row">
          <button type="button" data-testid="start-wizard-empty-job" onClick={onStartEmptyJob} style={LINK}>
            Start with an empty job
          </button>
        </p>
      )}
    </div>
  );
}
