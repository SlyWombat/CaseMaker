import { featureSim } from '@/platform/features';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react';
import { newItemDepthFor, useEngraveJobStore } from '@/store/engraveJobStore';
import { useProjectStore } from '@/store/projectStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { expandEngraveRow, useEngraveRowStore } from '@/store/engraveRowStore';
import { useEngraveRunStore, requiredAckCodes, releaseBlocker, runErrorCodes, saveBlocker, uploadBlocker } from '@/store/engraveRunStore';
import { useMachineStore } from '@/store/machineStore';
import { useSimStore } from '@/store/simStore';
import { useCncModeStore } from '@/store/cncModeStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import { useStockStore } from '@/store/stockStore';
import { preflightHub } from '@/engine/cnc/preflight';
import type { PreflightCause } from '@/engine/cnc/preflight';
import { runContextFor } from '@/store/machineRunStore';
import { stepAtLine } from '@/engine/cnc/playbackClock';
import { canDriveMachine } from '@/platform/capabilities';
import { EngraveMachineUpload } from './EngraveMachineUpload';
import { EngraveReleaseStep } from './EngraveReleaseStep';
import { EngravePreflight } from './EngravePreflight';
import { EngraveRegistrationStep } from './EngraveRegistrationStep';
import { saveEngraveProgram } from '@/engine/exportTrigger';
import { useSettingsStore } from '@/store/settingsStore';
import {
  effectiveMargins,
  houseBoundaryMargin,
  marginSourceWords,
  mm as mmText,
  recommendLabelDepth,
  recommendMargins,
  voidMarginWords,
  zBudgetInputsFor,
} from '@/engine/cnc/engrave/depthBounds';
import type { LabelDepthRecommendation } from '@/engine/cnc/engrave/depthBounds';
import { jobSplit } from '@/engine/cnc/engrave/depthIntent';
import { jobMachine } from '@/engine/cnc/calibration';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { caseWordsForKey } from '@/engine/cnc/toolCondition';
import { dedupeFindings, jobTool, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import {
  hasRegionItems,
  itemName,
  V_BIT_CARVE_SENTENCE,
  type ToolCandidate,
} from '@/engine/cnc/engrave/recommendTool';
import { vCone } from '@/engine/cnc/vProfile';
import {
  vCarvePlane,
  vCarveStepover,
  vCarveStepoverClampNote,
} from '@/engine/cnc/vCarveGeometry';
import { validateVise } from '@/engine/cnc/fixture';
import { keepOutLimitParts, keepOutMembrane, labelGlyphMeasure, labelJawReach, voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import { ensureLabelFontsLoaded, ensureSeedFontsLoaded, labelFontsLoaded } from '@/engine/fonts/registry';
import { buildRunSheet, runSheetFileName, type RunSheet } from '@/engine/cnc/engrave/runSheet';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { buildRunRecord, isMeasuredRun, serializeRunRecord } from '@/engine/cnc/engrave/runRecord';
import { allRuns, lastTimedRun } from '@/engine/cnc/engrave/runHistory';
import { useRunRecordStore } from '@/store/runRecordStore';
import { openTextFile } from '@/utils/openTextFile';
import { feedCatalogueSnapshot, feedsFor, type CutParams } from '@/engine/cnc/feeds';
import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import {
  TRACE_DEFAULTS,
  importOutlineFromDisk,
  importRasterFromDisk,
  toVectorShape,
  traceRaster,
  type OutlineImport,
  type RasterImage,
  type TraceOptions,
} from '@/engine/import/outlineImport';
import { newEngraveShapeId } from '@/engine/cnc/engrave/defaults';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import {
  FACING_DEPTH_MAX_MM,
  facingDefault,
  facingDepthDefault,
  facingRefusal,
  facingShopFrom,
  finishOf,
  measuredTopSpreadMm,
} from '@/engine/cnc/stockStart';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { blankStockFor } from '@/engine/cnc/engrave/fromBlank';
import { readDesignFile } from '@/engine/import/designImport';
import {
  defaultSacrificialSide,
  defaultSacrificialUnder,
  hasSacrificial,
  noneSacrificial,
  presetJawStrips,
  presetPartOnBoard,
} from '@/engine/cnc/sacrificial';
import { EngraveJobFileBar } from './EngraveJobFileBar';
import { EngraveLabelRow } from './EngraveLabelRow';
import { EngraveKeepOutRow } from './EngraveKeepOutRow';
import { EngraveShapeRow } from './EngraveShapeRow';
import { EngraveCombinedRow } from './EngraveCombinedRow';
import { EngraveDrillRow } from './EngraveDrillRow';
import { EngraveThreadRow } from './EngraveThreadRow';
import { EngraveTraceRow } from './EngraveTraceRow';
import { EngraveVectorRow } from './EngraveVectorRow';
import { EngraveImportDialog } from './EngraveImportDialog';
import { EngraveSetupFlow } from './EngraveSetupFlow';
import { EngraveSetupsSection } from './EngraveSetupsSection';
import { RunSheetView } from './RunSheetView';
import { coverageDisclaimer, type SimRunOutcome } from './simCoverage';
import { viseEnvelope } from '@/engine/cnc/fixture';
import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveJob,
  EngraveKeepOut,
  EngraveLabel,
  EngraveShape,
  FieldSource,
  JobStockFinish,
  Sacrificial,
  SacrificialSide,
  SacrificialUnder,
  StockMaterial,
  ViseParams,
} from '@/types/engraveJob';

/**
 * The Engrave panel (#205): stock, labels, tool, vise, cutting parameters, findings, generate.
 *
 * The preview is NOT built here — `engravePreviewStore` rebuilds it on a debounce whenever the
 * job changes, and this panel only reads it (findings, the tool recommendation) and asks for
 * the first one on mount. Without a preview the panel still works: the pure `validateJob`
 * findings and `feedsFor` are computed locally, so the form is never blank while the worker
 * thinks (#205's "the stock never disappears" applies to the viewport half as well).
 *
 * The viewport half — the layers, the toolbar, and this section's registration in
 * `Sidebar`/`ContextPanel` — is #197's, not this issue's; see the note on #205.
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const SUBHEAD: CSSProperties = { margin: '12px 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' };
/** A heading under one of the numbered sections — the voids live under Stock (#271). */
const SUBSUB: CSSProperties = { margin: '10px 0 2px', fontSize: 11, fontWeight: 600, color: '#9aa4b0' };
const FIELD: CSSProperties = { width: 74 };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

/**
 * A value as a field should PRINT it (#406). Binary float noise a person should never read —
 * `3.2 − 3.1` is `0.10000000000000009`, and a thin blank's `stockProud` can be its negative — is
 * removed at six decimals, four below the 0.001 mm the controller moves in, so anything typed on
 * purpose survives. The stored value is untouched: this is the display only.
 */
const shownNumber = (v: number): number => Number(v.toFixed(6));
const TAG: CSSProperties = {
  fontSize: 10,
  color: '#9aa4b0',
  border: '1px solid #2a2f36',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
  fontWeight: 400,
};
const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a' };

/** A leading letter, uppercased — the engine's reasons are clauses, the panel prints sentences. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A finish as the sentence “The stock is …” finishes (#413's four values). */
const FINISH_WORD: Record<JobStockFinish, string> = {
  rough: 'rough',
  finished: 'finished',
  printed: 'a printed blank',
  unknown: 'of unknown finish',
};

/**
 * The feeds diagnostics that mean THE MACHINE MOVED A NUMBER (#317): the clamp half of
 * `FeedsDiagnostic`, which is the union of these with the catalogue's own `catalogue-ignored`.
 *
 * The distinction is the whole point of the tag. A clamp is a value the resolver changed on the way
 * past the machine's ceiling and must be shown; a `catalogue-ignored` is a row that YIELDED a field
 * to the tier below (#325), and that one is already told in the provenance sentence with the field
 * named. Counting both together would make "clamped to this machine (2)" a lie about one of them.
 */
const CLAMP_CODES: ReadonlySet<string> = new Set(['feed-clamped', 'rpm-clamped']);

/**
 * The visible word for a value's source (#246/#254): a typed number reads "typed", never looking
 * like a bench reading, and a computed feed says so. `measured` is the one that gets a colour.
 */
const SOURCE_LABEL: Record<FieldSource, string> = {
  computed: 'computed',
  // Makera's own number for a cutter they sell (#310). Short, because it sits in a row of tags.
  catalogue: 'Makera',
  user: 'typed',
  measured: 'measured',
  // #492 — the laminate cap the maintainer told us to assume until the sheet is measured. It is
  // neither a bench reading nor a typed number, and the word says so.
  assumed: 'assumed',
};
const SOURCE_COLOR: Record<FieldSource, string> = {
  computed: '#9aa4b0',
  // Amber, deliberately neither the grey of a computed value nor the green of a bench reading: a
  // vendor's starting number is a third thing (#310).
  catalogue: '#d0b26a',
  user: '#9aa4b0',
  measured: '#9fd19b',
  assumed: '#d0b26a',
};

/** The tag that shows a field's provenance (#246/#254), or null when nothing was asserted. */
function SourceTag({ source, testid }: { source: FieldSource; testid: string }): JSX.Element {
  return (
    <span
      style={{
        ...TAG,
        color: SOURCE_COLOR[source],
        borderColor: source === 'measured' ? '#3a5a3a' : source === 'catalogue' ? '#5a4a28' : '#2a2f36',
      }}
      data-testid={testid}
      data-source={source}
      title={
        source === 'computed'
          ? 'Computed from the feeds table — no one typed this.'
          : source === 'catalogue'
            ? "Makera's catalogue (#310) — their starting number for this cutter, not a measurement of this machine."
            : source === 'measured'
              ? 'Taken at the bench (#208).'
              : 'Typed here — not more trustworthy for that.'
      }
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

/** The kinds the panel can add with its "Add" control (#214): a label plus the four shapes. */
const ADD_KINDS: readonly { value: EngraveShape['kind'] | 'label'; label: string }[] = [
  { value: 'label', label: 'Label' },
  { value: 'rect', label: 'Rectangle' },
  { value: 'circle', label: 'Circle' },
  { value: 'slot', label: 'Slot' },
  { value: 'polygon', label: 'Polygon' },
];

/**
 * The three COMBINED kinds (#215, work item 3), added from the same menu but to `job.combined`.
 * A frame and a cut-away name another item, so they cannot be added to an empty job (the schema
 * rejects an empty reference id) — the button is disabled until there is one to reference.
 */
const ADD_COMBINED_KINDS: readonly { value: EngraveCombinedShape['kind']; label: string; needsRef: boolean }[] = [
  { value: 'border', label: 'Border', needsRef: false },
  { value: 'frame', label: 'Frame', needsRef: true },
  { value: 'cutaway', label: 'Cut-away', needsRef: true },
];

/**
 * The two TRACE kinds (#219), added from the same menu but to `job.traces`. A trace is a
 * single-line cut — the cutter's centre follows the path, so the groove is exactly the cutter's
 * width — which is how fine script and hairlines are engraved. It needs no reference, so both
 * entries are always available.
 */
const ADD_TRACE_KINDS: readonly { value: 'line' | 'stroke-label'; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'stroke-label', label: 'Single-line text' },
];

/**
 * The two DRILL kinds (#220, added by the panel in #260), added from the same menu but to
 * `job.drills`. A drill is its own list, like `traces`: it is not a region, so it never reaches
 * the shape editor or the `engraves` pipeline. Neither entry needs a reference.
 */
const ADD_DRILL_KINDS: readonly { value: 'drill' | 'drill-array'; label: string }[] = [
  { value: 'drill', label: 'Hole' },
  { value: 'drill-array', label: 'Hole array' },
];

/**
 * The four VOID kinds (#271), added to `job.keepOuts` from the Stock section — NOT from the
 * Items "+ Add…" menu. A void is a fact about the blank, not something the cutter makes: the
 * menu's other entries all become cut operations, and putting a void among them would invite
 * exactly the reading this row exists to prevent. So the voids have their own list, their own
 * label, and their own add buttons, next to the stock dimensions they are a fact about.
 */
const ADD_KEEPOUT_KINDS: readonly { value: EngraveKeepOut['kind']; label: string }[] = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'circle', label: 'Circle' },
  { value: 'slot', label: 'Slot' },
  { value: 'polygon', label: 'Polygon' },
];

/** Every item of the job, in the order `toPartPlan` walks them (#214/#215/#217). Imported
 *  vector outlines are `EngraveAnyItem`s too, so a frame or a cut-away may name one. */
function allItems(job: EngraveJob): EngraveAnyItem[] {
  return [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])];
}

/**
 * Every id the ITEM list of §2 draws (#411), which is wider than `allItems`: a trace and a drill
 * each have a line there even though no combined shape may reference one. The header's "expand all"
 * has to open exactly the rows that are on screen, so it reads this rather than `allItems`.
 */
function itemRowIds(job: EngraveJob): string[] {
  return [
    ...job.labels.map((i) => i.id),
    ...job.shapes.map((i) => i.id),
    ...(job.combined ?? []).map((i) => i.id),
    ...(job.traces ?? []).map((i) => i.id),
    ...(job.drills ?? []).map((i) => i.id),
    ...(job.threads ?? []).map((i) => i.id),
    ...(job.vectors ?? []).map((i) => i.id),
  ];
}

const ATTACH_METHODS: readonly { value: SacrificialUnder['attach']; label: string }[] = [
  { value: 'tape', label: 'tape' },
  { value: 'glue', label: 'glue' },
  { value: 'screws', label: 'screws' },
  { value: 'loose', label: 'loose (a warning)' },
];

const STRIP_SIDES: readonly (keyof Sacrificial['sides'])[] = ['left', 'right', 'front', 'back'];

/** 1 -> "1.0", 3.175 -> "3.175". The same formatting `recommendTool` uses in its reasons. */
function fmtDiameter(d: number): string {
  return Number.isInteger(d) ? d.toFixed(1) : String(d);
}

/**
 * #454/#458 — a built-in or catalogue key borrows the condition of the shop's copies that
 * correspond to it, so a summarised condition on it is a statement about THOSE copies, not about
 * the shipped definition. The `Why?` row's short suffix has to say so, or it reads exactly like a
 * condition the operator set. An owned key's summary IS its own copies and carries no attribution.
 */
function conditionSourceWord(c: ToolCandidate): string {
  return c.condition?.adopted ? ' (the shop’s copies)' : '';
}

/** A V-carve fact to the micron, as the sheet and the finding print it (`0.052`, `0.242`). */
function mm3(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

function toolOptionLabel(e: ToolLibraryEntry): string {
  const d = cuttingDiameter(e.tool);
  return d === null ? `${e.tool.name} — cutting diameter unknown` : `${e.tool.name} — Ø ${d} mm cutting`;
}

/**
 * The badge that says where the vise numbers came from (decision 28: a default is not a
 * measurement). The shipped set is calipered as of 2026-10-15 (#208), so 'default' no longer means
 * "nobody measured it" — it means nobody measured THIS machine's vise, and the badge says that.
 */
function viseBadge(v: ViseParams): string {
  if (v.source === 'default') return 'shipped · reference unit';
  if (v.source === 'saved') return v.measuredAt ? `saved · ${v.measuredAt}` : 'saved';
  return 'measured · this setup';
}

/**
 * Where the sacrificial numbers came from (#213, the same provenance rule as the vise). There
 * is no `measuredAt` on `Sacrificial` — the type carries only `source` — so the badge names the
 * source without a date.
 */
function sacrificialBadge(s: Sacrificial): string {
  if (!hasSacrificial(s)) return 'none';
  if (s.source === 'default') return 'default · unmeasured';
  if (s.source === 'saved') return 'saved';
  return 'measured · this setup';
}

/** The four run rows' states (#206): a tick, a cross, a spinner, or nothing yet. */
type RowState = 'tick' | 'cross' | 'pending' | 'idle';

const ROW_MARK: Record<RowState, string> = { tick: '✓', cross: '✗', pending: '…', idle: '·' };
const ROW_COLOR: Record<RowState, string> = { tick: '#8fd694', cross: '#f0b4ad', pending: '#c8d3de', idle: '#66707a' };

/** "0:12" for a duration in seconds; the CAM's estimate is a rough number, not a promise. */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One of the four status rows (tick / cross / spinner + text). */
function RunRow({ testid, state, text }: { testid: string; state: RowState; text: string }): JSX.Element {
  return (
    <div data-testid={testid} data-state={state} style={{ display: 'flex', gap: 6, fontSize: 12, color: '#c8d3de' }}>
      <span aria-hidden style={{ color: ROW_COLOR[state], width: 12, textAlign: 'center', flexShrink: 0 }}>
        {ROW_MARK[state]}
      </span>
      <span>{text}</span>
    </div>
  );
}

const OVERRIDE_FIELDS: readonly { key: keyof Omit<CutParams, 'air'>; label: string; unit: string }[] = [
  { key: 'rpm', label: 'spindle', unit: 'rpm' },
  { key: 'feed', label: 'feed', unit: 'mm/min' },
  { key: 'plungeFeed', label: 'plunge', unit: 'mm/min' },
  { key: 'stepDown', label: 'step-down', unit: 'mm' },
  { key: 'stepOver', label: 'step-over', unit: 'mm' },
];

/**
 * A list header's fold controls (#411): "collapse all" folds every row of THAT list back to its one
 * line, "expand all" opens the rows it is handed.
 *
 * They write to `engraveRowStore` and never to the job — how a list is folded is where the person
 * left the panel, not a fact about the part (see that store's own note). Both are handed this
 * list's own ids: the header of "Items" folds items, not the voids list above it (#411 review).
 */
function RowFolds({
  testidPrefix,
  ids,
  firstButtonRef,
}: {
  testidPrefix: string;
  ids: readonly string[];
  /**
   * Where focus goes when the undo strip in THIS list unmounts under the cursor (#411 review).
   * The strip's own button is the focus holder and it disappears with the strip, so the section
   * needs somewhere stable to hand it to — and the list's own header is the nearest thing that is
   * always there and always belongs to the same list.
   */
  firstButtonRef?: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  const collapseAll = useEngraveRowStore((s) => s.collapseAll);
  const expandAll = useEngraveRowStore((s) => s.expandAll);
  return (
    <span style={{ display: 'inline-flex', gap: 4, marginLeft: 6, verticalAlign: 'middle' }}>
      <button
        ref={firstButtonRef}
        type="button"
        data-testid={`${testidPrefix}-collapse-all`}
        title="Fold every row in this list to its single line."
        onClick={() => collapseAll(ids)}
      >
        collapse all
      </button>
      <button
        type="button"
        data-testid={`${testidPrefix}-expand-all`}
        title="Open every row in this list at once."
        onClick={() => expandAll(ids)}
      >
        expand all
      </button>
    </span>
  );
}

/**
 * The take-back for a removal, drawn at the REMOVAL SITE (#411) — under the header of the list the
 * item came out of, not in an app-wide toast.
 *
 * The maintainer's decision was "undoable, no dialog": remove is the one destructive press in this
 * panel and #411 moved it to the FRONT of every row, where a slip is easy. It is not the app's
 * Ctrl-Z target by default (project undo is) — but while a removal is pending it takes precedence,
 * because it is the more recent, more local thing (see `AppShell`'s shortcut). The strip says which.
 *
 * It appears only for the section the removal happened in — a void's undo offered under the item
 * list below it would be about the wrong thing — and it shows the TOP of the stack, so undoing one
 * reveals the next (`engraveJobStore`'s `removalUndo`). The stack retires on the next edit of any
 * kind, or after `REMOVAL_UNDO_MS`.
 */
function UndoRemoval({
  section,
  fallbackRef,
}: {
  section: 'items' | 'voids';
  /** The list's header control, to hand focus to when this strip goes (see the effect below). */
  fallbackRef?: RefObject<HTMLButtonElement | null>;
}): JSX.Element | null {
  const stack = useEngraveJobStore((s) => s.removalUndo);
  const undoRemove = useEngraveJobStore((s) => s.undoRemove);
  const button = useRef<HTMLButtonElement | null>(null);
  const top = stack[stack.length - 1];
  const mine = top !== undefined && top.section === section ? top : null;
  // Whether THIS strip is what took the focus. Without it the "give it back" half below would fire
  // on the panel's first render, when nothing has been removed and focus is legitimately nowhere.
  const tookFocus = useRef(false);
  // The press that removed the item took the control with it — the row is gone — so focus would
  // otherwise fall to `<body>` and a keyboard user would have to hunt along the panel for the way
  // back (#411 review). It goes to the Undo this removal just produced, once per removal.
  //
  // …AND IT HAS TO COME BACK (#411 review). The Undo button is INSIDE the strip, so every way the
  // strip can go — the person takes the undo, the 8 s window runs out, or another edit retires the
  // stack — removes the focused element from the document and drops focus to `<body>`, which loses
  // a keyboard user's place in the panel entirely. The test is `activeElement`, not "was the strip
  // on screen": if the person has since clicked into a field, focus is on that field and it is not
  // this effect's to move.
  useEffect(() => {
    if (mine !== null) {
      tookFocus.current = true;
      button.current?.focus();
      return undefined;
    }
    if (!tookFocus.current) return undefined;
    tookFocus.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) fallbackRef?.current?.focus();
    return undefined;
  }, [mine, fallbackRef]);
  if (mine === null) return null;
  return (
    <p className="engrave-undo-strip" data-testid="engrave-undo-strip">
      <span data-testid="engrave-undo-what">{mine.what} removed.</span>
      <button ref={button} type="button" data-testid="engrave-undo" title="Put it back where it was." onClick={undoRemove}>
        Undo
      </button>
    </p>
  );
}

/**
 * What a removal is announced as (#411 review: a `role="status"` region that arrives already filled
 * is silent — a live region has to be in the DOM, and EMPTY, before the text is written into it).
 *
 * So this one is always here and never seen, and the visible strip above it carries no live role at
 * all. Hidden with a clip rather than `display: none`, which would take it out of the accessibility
 * tree and leave nothing to announce into.
 */
function RemovalAnnouncement(): JSX.Element {
  const stack = useEngraveJobStore((s) => s.removalUndo);
  const top = stack[stack.length - 1];
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="engrave-undo-announce">
      {top === undefined ? '' : `${top.what} removed. Undo is available.`}
    </p>
  );
}

export function EngravePanel(): JSX.Element {
  const job = useEngraveJobStore((s) => s.job);
  const setJobMargins = useEngraveJobStore((s) => s.setJobMargins);
  const setStock = useEngraveJobStore((s) => s.setStock);
  const addLabel = useEngraveJobStore((s) => s.addLabel);
  const updateLabel = useEngraveJobStore((s) => s.updateLabel);
  const removeLabel = useEngraveJobStore((s) => s.removeLabel);
  const addShape = useEngraveJobStore((s) => s.addShape);
  const updateShape = useEngraveJobStore((s) => s.updateShape);
  const removeShape = useEngraveJobStore((s) => s.removeShape);
  const addCombined = useEngraveJobStore((s) => s.addCombined);
  const updateCombined = useEngraveJobStore((s) => s.updateCombined);
  const removeCombined = useEngraveJobStore((s) => s.removeCombined);
  const addTrace = useEngraveJobStore((s) => s.addTrace);
  const updateTrace = useEngraveJobStore((s) => s.updateTrace);
  const removeTrace = useEngraveJobStore((s) => s.removeTrace);
  const addDrill = useEngraveJobStore((s) => s.addDrill);
  const updateDrill = useEngraveJobStore((s) => s.updateDrill);
  const removeDrill = useEngraveJobStore((s) => s.removeDrill);
  const addThread = useEngraveJobStore((s) => s.addThread);
  const updateThread = useEngraveJobStore((s) => s.updateThread);
  const removeThread = useEngraveJobStore((s) => s.removeThread);
  const addKeepOut = useEngraveJobStore((s) => s.addKeepOut);
  const updateKeepOut = useEngraveJobStore((s) => s.updateKeepOut);
  const removeKeepOut = useEngraveJobStore((s) => s.removeKeepOut);
  const takeBadgeBlank = useEngraveJobStore((s) => s.takeBadgeBlank);
  const takeBlankStock = useEngraveJobStore((s) => s.takeBlankStock);
  const takeDesign = useEngraveJobStore((s) => s.takeDesign);
  const addVector = useEngraveJobStore((s) => s.addVector);
  const updateVector = useEngraveJobStore((s) => s.updateVector);
  const removeVector = useEngraveJobStore((s) => s.removeVector);
  const setTool = useEngraveJobStore((s) => s.setTool);
  const setVise = useEngraveJobStore((s) => s.setVise);
  const setSacrificial = useEngraveJobStore((s) => s.setSacrificial);
  const setCutOverride = useEngraveJobStore((s) => s.setCutOverride);
  const setCutOverrideSource = useEngraveJobStore((s) => s.setCutOverrideSource);
  const setFacing = useEngraveJobStore((s) => s.setFacing);

  const preview = useEngravePreviewStore((s) => s.preview);
  const previewStatus = useEngravePreviewStore((s) => s.status);
  const previewError = useEngravePreviewStore((s) => s.error);

  // The first preview. Later edits reach the store through its own subscription to the job
  // store, so the panel never has to ask after this.
  useEffect(() => {
    useEngravePreviewStore.getState().request(useEngraveJobStore.getState().job);
  }, []);

  // #365 review — the rows MEASURE, so the faces they measure with have to be up before the render
  // that shows a number. The sim worker loads its own (per-realm) cache and this thread only did so
  // inside `openRunSheet`/save, so every row read the fallback's sentence — "its face is not parsed
  // yet" — until the run sheet had been opened once. Load the job's faces here, on mount and whenever
  // the line set changes, and bump a counter so `measure` below is rebuilt once they land:
  // `labelGlyphMeasure` is synchronous and reads the registry, so a re-render is the whole of it. The
  // seed paths (`useBadgeBlank`/`useBlankStock`) await the same call, so neither relies on this race.
  const [, bumpFacesLoaded] = useState(0);
  useEffect(() => {
    // The ordinary case is that they are already up (every render after the first, and every test),
    // and then this render's numbers are final: no fetch, no bump, no second render. Only a cold
    // cache pays, and only once.
    if (labelFontsLoaded(job.labels, job.customFonts ?? [])) return;
    let live = true;
    void ensureLabelFontsLoaded(job.labels, job.customFonts ?? [])
      .then(() => {
        if (live) bumpFacesLoaded((n) => n + 1);
      })
      // Swallowed, not rethrown: a face that plainly fails to fetch leaves the rows reading the
      // fallback's sentence, which is exactly what they showed before this effect existed. Letting
      // it reject would be an unhandled rejection — re-raised on every keystroke that redraws the
      // label list. `openRunSheet`/`save` stay loud; they must not write numbers nobody measured.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [job.labels, job.customFonts]);

  // Findings: the worker's list (validateJob + validateVise + the geometry findings, deduped)
  // once it has one, otherwise the same two pure validators without the geometry half, merged the
  // same way (#353) — so the form is never blank. Findings raised inside `engraveRegions` and
  // nowhere else (`tool-metal-line`, #407; the engravability ones) appear when the preview lands;
  // the fallback does not attempt them.
  const findings: JobFinding[] =
    preview?.findings ??
    dedupeFindings([...validateJob(job), ...validateVise(job.stock, job.workholding.vise, job.sacrificial)]);
  const jobFindings = findings.filter((f) => f.labelId === undefined);
  const findingsFor = (labelId: string): JobFinding[] => findings.filter((f) => f.labelId === labelId);

  // #305 — the snapshot the resolver reads, so the list here and the tool everything else uses
  // can never come from two different places.
  const tools = useToolRegistry();
  const tool = jobTool(job);
  const toolEntry = tools.find((e) => e.key === job.toolKey) ?? null;
  const diameter = toolEntry ? cuttingDiameter(toolEntry.tool) : null;
  // The rows are the main thread's own catalogue snapshot (#324) — read here so the numbers on
  // screen are the same resolution the worker is handed at Generate, not a module state only this
  // side of the boundary can see.
  // The rows AND their sync date (#366): the panel shows the catalogue's provenance sentence, so it
  // is the caller that has to hand `feedsFor` the age. The worker passes rows alone and gets the
  // sentence without it — it never renders one.
  const feeds = tool ? feedsFor(feedCatalogueSnapshot(), job.stock.material, tool, jobMachine(job), job.cutOverride) : null;
  const params: CutParams | null = feeds && feeds.ok ? feeds.params : null;
  // #221 — the V-carve strategy's facts, all READ from the engine: the cone from the cutter, the
  // colour plane the preview resolved from the print (the same `colourBoundaryDepth` the sheet and
  // the CAM use), and the pass spacing from `vCarveStepover` at the feeds row's own ratio. None of
  // this is re-derived here; the panel only places the numbers the CAM already states.
  const cone = tool ? vCone(tool) : null;
  const hasRegions = hasRegionItems(job);
  const vCarveJob = cone !== null && hasRegions;
  // The preview may still be resolving. If the blank is a PRINT and no preview has landed yet, the
  // plane is UNKNOWN — showing the no-film arithmetic here would be a wrong number, not a
  // placeholder. A laminate (#492) needs no preview: its plane is the cap the stock states, which is
  // the same value the sheet's `colourPlaneFor` reads.
  const filmPending = job.stock.colour?.kind === 'printed' && preview === null;
  const film =
    job.stock.colour?.kind === 'laminate'
      ? job.stock.colour.capMm
      : filmPending
        ? null
        : (preview?.colourBoundaryDepth ?? null);
  const vCarveRatio =
    cone !== null && cone.tipRadius > 0 && params !== null ? params.stepOver / (2 * cone.tipRadius) : null;
  const vCarveItems = vCarveJob
    ? [
        ...job.labels.filter((i) => i.enabled),
        ...job.shapes.filter((i) => i.enabled),
        ...(job.combined ?? []).filter((i) => i.enabled),
        ...(job.vectors ?? []).filter((i) => i.enabled),
      ]
    : [];
  // Only the clamps (#317): an `ok: false` result carries `-refused` diagnostics, which the refusal
  // box below already states, and a `catalogue-ignored` is not the machine's doing at all.
  const clamps = feeds?.ok ? feeds.diagnostics.filter((d) => CLAMP_CODES.has(d.code)) : [];

  const maxDepth = job.stock.thickness - job.minFloor;
  // The declared under-surface voids (#271). One row each, under the stock they are a fact about.
  const keepOuts = job.keepOuts ?? [];

  // #345 — the depth margins. `effectiveMargins` is the SAME call the run store and the sheet make,
  // so the row, the printout and the verifier cannot state three different numbers. The
  // recommendation is per-job arithmetic on THIS blank over the inputs the job itself supplies
  // (`zBudgetInputsFor`), raised to `max(setting, zTolerance)`: the house setting is a floor under
  // the advice, and the margin the job happens to be running on is not part of the sum — feeding a
  // job's own past recommendation back in would let it raise its own advice.
  const houseMargins = useSettingsStore((s) => s.margins);
  const margins = effectiveMargins(job, houseMargins);
  // #170 — everything the two-state depth control needs, worked out ONCE for the job: where the
  // colour split lands and how far off it a state's floor has to stop. `null` on a blank that states
  // no print, which is when a label row has no two outcomes to offer. The same call the preview draws
  // its colours from, so a row's `reveal` and the colour the floor is painted cannot disagree.
  //
  // The MARGIN in force is handed in rather than a bare layer height (its own review): the row writes
  // a depth onto the document and `checkBounds` holds it to `margins.boundaryMargin`, so a control
  // stepping by the layer alone writes a depth the app's own checker refuses the moment a job carries
  // a margin of its own — and `margins` is computed ABOVE this line for exactly that reason.
  const split = jobSplit(job, margins.boundaryMargin);
  const recommendation = recommendMargins(job, houseMargins, zBudgetInputsFor(job));
  // The house number AS THIS JOB runs it (#345 review): one printed layer of this blank while the
  // setting is still the shipped default, not the 0.2 the settings box shows. The same resolver
  // `effectiveMargins` and `recommendMargins` use, so the title below and both of their numbers
  // agree.
  const houseBoundary = houseBoundaryMargin(job, houseMargins);

  // #432 slice 4 — the facing choice. The finish is the ONE input (decision Q6): `finishOf` reads
  // the named entry's answer, or a printed blank's implied one, and null means nothing says — the
  // panel then prints that rather than guessing from the material. The depth's filled-in number and
  // the sentence under it come from the same `facingDepthDefault` call the wizard's seed makes; the
  // panel adds the one input the wizard cannot have at stock-choice time — a measured top (R9).
  const shopDefaults = useShopDefaultsStore((s) => s.defaults);
  const finish = finishOf(job);
  // #474/#493 — no plastic is faced (wood and metal only), so the material refuses it whatever the
  // finish says; the panel withholds the choice rather than merely seeding it off.
  const facingRefused = facingRefusal(job.stock.material) !== null;
  const facingDef = facingDefault(finish ?? 'unknown', job.stock.material);
  const facing = job.facing ?? null;
  const facingOn = facing?.enabled ?? false;
  // #432 review R9 — the aimed-for default is the MEASURED top's high-to-low spread plus the
  // shop's margin. The job carries a measured top only as `stock.flatness` with
  // `source: 'measured'`; a badge's stated dome is not a measurement, and `measuredTopSpreadMm`
  // returns null on any plastic, so the wood/metal-only rule holds here too.
  const facingDepthFill = facingDepthDefault(finish ?? 'unknown', {
    probedSpreadMm: measuredTopSpreadMm(job),
    shop: facingShopFrom(shopDefaults),
  });
  const facingDepthReason =
    facing !== null && Math.abs(facing.depth - facingDepthFill.depthMm) < 1e-9
      ? sentenceCase(facingDepthFill.reason) + '.'
      : `Your number, not the ${mmText(facingDepthFill.depthMm)} filled in for this finish.`;
  /** Turn facing on or off, FILLING IN the depth's default when the job had not chosen one. */
  function chooseFacing(on: boolean): void {
    const depth = facing?.depth ?? facingDepthFill.depthMm;
    setFacing({ enabled: on, depth, ...(facing?.toolKey ? { toolKey: facing.toolKey } : {}) });
  }
  // "Recommends more" is the only case worth a button: a recommendation that ties or loses to what
  // is already in force has nothing to offer, and two numbers that agree do not need a control.
  //
  // #345 review — and neither does a recommendation that only RE-STATES the house number on a job
  // that already carries its own. When the house margin sits at or above the blank's own arithmetic
  // (`max(setting, zTolerance)`), "Use it" would stamp that number onto the job as `'recommended'`
  // while "Follow the house setting" beside it hands back the same number by dropping the override:
  // one outcome, two buttons, so the redundant one goes.
  const recommendMore =
    recommendation.boundaryMargin > margins.boundaryMargin + 1e-9 &&
    !(job.margins && recommendation.boundaryMargin <= houseBoundary + 1e-9);

  // #362 — why each label is as deep as it is, in the row that holds the number (#345's rule: the
  // number says where it came from). Before this the row showed `0.51` with the only explanation
  // under it being the CEILING — "max depth 2.81 mm here" — which reads as the reason for it.
  //
  // The same call the store's seeding makes (`redepthLabelsForBlank`), on the same two inputs, so
  // the number in the row and the number the badge route writes cannot disagree. The store still
  // owns the WRITE; this is only the sentence beside the field.
  //
  // #365 — the void bound is asked about THIS LINE's own extent, not the whole blank: the rows used
  // to read as if every line sat over the blank's shallowest void, so the badge's seeded line was
  // advised the magnet pocket's 0.51 mm from the free band beside it. Both the box and the answer
  // come from `voidLimitForItem`, and the measure is the one implementation the seed and the walk
  // use, so a row can never test a line against a void the line was placed clear of.
  const measure = labelGlyphMeasure(job.customFonts ?? []);
  const depthRecommendation = (label: EngraveLabel): LabelDepthRecommendation | null => {
    // A label's OWN past intent does not lock it out of its own recommendation — `'computed'` means
    // "ours to rewrite" (#362 review). Anything else, or a hand-written intent with no provenance,
    // is a person's statement and the recommendation has nothing to say about it.
    const intent = job.sources?.labels?.[label.id]?.depthIntent;
    return recommendLabelDepth(job, label, {
      voidLimit: voidLimitForItem(job, label, margins.boundaryMargin, measure),
      // #369 — the jaw bound is charged to this line only where a jaw can reach it, on the same
      // box the void bound above reads (#394 measures it inside `labelJawReach`, off the job's own
      // faces). The clearance the floor holds is the `Math.max` `recommendLabelDepth` itself applies
      // (`job.jawClearance` against the margin), so the reach and the clause cannot quote two
      // different clearances.
      jawReach: labelJawReach(job, label),
      boundaryMargin: margins.boundaryMargin,
      ...(intent === undefined ? {} : { intent }),
    });
  };

  // #271 route 1 — the blank this job is for is usually already in the project as `case.badge`,
  // and the one void V1 needs (the magnet pocket) is the badge's own. Reading it here cannot get
  // it wrong; retyping 45 × 13 × 2.3 into a keep-out row can. `badgeBlankFor` is pure and only
  // describes what the badge IS — the writes below are the store's.
  const badge = useProjectStore((s) => s.project.case.badge);
  const badgeUsable = badge !== undefined && badge.enabled;
  const [blankNotes, setBlankNotes] = useState<string[] | null>(null);

  async function useBadgeBlank(): Promise<void> {
    if (!badge) return;
    const blank = badgeBlankFor(badge);
    // #365 review — the store's seed MEASURES the line it lays out, so the face it borrows has to be
    // parsed before the write. Pressed before the faces were up (the header effect above usually wins
    // that race, but a button may not depend on it) the seeded line came out at the estimate's 5 mm
    // cap while the row right beside it said 8. Best-effort: a face that will not load leaves the
    // seed the estimate, which is what it had before this wait.
    await ensureSeedFontsLoaded(job.labels, job.customFonts ?? []);
    // #352 — the write itself lives in the store, because the wizard's hand-off seed makes the same
    // one. The panel owns only what it shows.
    takeBadgeBlank(blank);
    setBlankNotes(blank.notes);
  }

  // Issue #280 — the bare-blank archetype's twin of the badge button. A `case.blank` is the
  // stock itself, so taking it across is dimensions only: the material is the user's answer and
  // a blank cannot know it (#280's "a machine we have no profile for is never given another's
  // numbers" rule, applied to the material). No void handling — a blank declares none.
  const blankPart = useProjectStore((s) => s.project.case.blank);
  const blankPartUsable = blankPart !== undefined && blankPart.enabled;
  const [blankPartNotes, setBlankPartNotes] = useState<string[] | null>(null);

  async function useBlankStock(): Promise<void> {
    if (!blankPart) return;
    // The same wait as the badge button's, for the same reason and with the same best-effort
    // reading: `takeBlankStock` seeds its line from a MEASUREMENT of the face it borrows (#364,
    // #365 review).
    await ensureSeedFontsLoaded(job.labels, job.customFonts ?? []);
    // #364 — one store method owns the whole write, the panel only shows what it did. It takes the
    // stock AND the lines (the seed and the re-depth walk), so "Use the blank" no longer leaves the
    // demo words laid out for a plank on a blank that is not one.
    takeBlankStock(blankPart);
    setBlankPartNotes(blankStockFor(blankPart).notes);
  }

  // Issue #410 item 4 — the third way a blank gets into this job, and the only one that brings the
  // ITEMS with it: a PrusaSlicer project (`.3mf`). The file is read in the sim worker (it needs a
  // ManifoldToplevel to slice the volumes) and what comes back is the same kind of patch the badge
  // route builds; `takeDesign` owns the write.
  //
  // The value here is not typing three widths and four depths correctly: it is that the blank, its
  // magnet pocket, every footprint and every floor come off the file's own mesh, in the operator's
  // frame — the top face's depth is measured from the top face, not from a nominal height.
  //
  // No direction control: the shipped quarter turn is what this route uses and the first of the
  // notes states it in words, so a job cannot be built without the operator being able to read
  // which way it went.
  const designInputRef = useRef<HTMLInputElement>(null);
  // The one place each list's undo strip can hand focus back to when it goes (#411 review). One per
  // list, because a void's strip must not drop the cursor into the item list below it.
  const voidsFoldRef = useRef<HTMLButtonElement | null>(null);
  const itemsFoldRef = useRef<HTMLButtonElement | null>(null);
  const [designNotes, setDesignNotes] = useState<string[] | null>(null);
  const [designError, setDesignError] = useState<string | null>(null);
  const [designReading, setDesignReading] = useState(false);

  async function readDesign(file: File): Promise<void> {
    setDesignError(null);
    setDesignNotes(null);
    setDesignReading(true);
    try {
      const result = await readDesignFile(file);
      if (!result.ok) {
        setDesignError(result.error);
        return;
      }
      // The same wait the two blank routes do and for the same reason: this patch sets the stock,
      // and the store's own walks MEASURE what they lay out against it (#364, #365 review).
      await ensureSeedFontsLoaded(job.labels, job.customFonts ?? []);
      takeDesign(result.patch);
      setDesignNotes([`Read ${result.filename}.`, ...result.patch.notes]);
    } catch (e) {
      setDesignError(e instanceof Error ? e.message : String(e));
    } finally {
      setDesignReading(false);
    }
  }
  const errors = findings.filter((f) => f.severity === 'error');
  const blockedByFeeds = feeds !== null && !feeds.ok;
  const blocked = errors.length > 0 || blockedByFeeds;

  const rec = preview?.recommendation ?? null;
  const recPick = rec?.key ? rec.candidates.find((c) => c.key === rec.key) ?? null : null;
  // #221 — a V-bit pick is a V-carve, and the box says so rather than calling every recommendation
  // a flat end. The shape comes from the cutter the key names, never from the candidate's diameter.
  const recPickCone =
    recPick === null ? null : (() => {
        const entry = tools.find((e) => e.key === recPick.key);
        return entry === undefined ? null : vCone(entry.tool);
      })();

  // ---- the run (#206) ----------------------------------------------------------------------

  const run = useEngraveRunStore();
  const simEnabled = featureSim;
  const running = run.phase === 'generating' || run.phase === 'simulating' || run.phase === 'checking';

  // ---- #419 §3: the mode, and the cut gate --------------------------------------------------

  // The mode is view state (store/cncModeStore.ts): the CNC surface is this right-rail panel, so
  // the [Design][Cut] header lives at the top of it rather than in a new chrome bar. `jobId` keeps
  // the mode with its document — opening another job starts at Design, because Cut is a statement
  // about THIS job's package. Selecting the same job leaves the mode alone.
  const mode = useCncModeStore((s) => s.mode);
  const showMode = useCncModeStore((s) => s.show);
  const syncJob = useCncModeStore((s) => s.syncJob);
  useEffect(() => {
    syncJob(job.id);
  }, [job.id, syncJob]);

  const calibration = useSettingsStore((s) => s.machineCalibration) ?? null;
  const shelfItems = useStockStore((s) => s.items);
  // Read through the store API, not localStorage directly: R8 moves the package into the job
  // document with #425, and this line must not have to change with it.
  const jobPackage = useEngravePackageStore((s) => s.packages.find((p) => p.jobId === job.id) ?? null);
  // Only a stock entry actually taken off the shelf is handed to the stock owner. A piece typed in
  // (or a file) that was later ALSO put on the shelf is still not this job's shelf pick.
  const shelfEntryId = job.stockEntry?.kind === 'shelf' ? job.stockEntry.shelfId : null;
  const shelfItem = shelfEntryId === null ? null : (shelfItems.find((item) => item.id === shelfEntryId) ?? null);

  // PRESSING CUT IS WHAT ASKS THE GATE. The report is built only while Cut is up, so Design's
  // render pays nothing for a verification pass it does not show; pressing the tab changes `mode`,
  // which rebuilds this on the next render. Nothing is stored: every visit re-runs `collect()`,
  // rather than replaying a verdict from an edit ago.
  const preflight = useMemo(
    () =>
      mode === 'cut'
        ? preflightHub({
            job,
            generated: run.generated,
            staleSince: run.staleSince,
            package: jobPackage,
            calibration,
            shelfItem,
            // No honest reachability table is available synchronously in this slice — the preview
            // holds a recommendation, not the measured table. Null leaves `recommendTool`'s verdict
            // unstated rather than guessing it, so `no-cutter` stays unwired here.
            reach: null,
          })
        : null,
    [mode, job, run.generated, run.staleSince, jobPackage, calibration, shelfItem],
  );

  const backToDesign = (cause: PreflightCause | null): void => {
    // §5.6's "Back to Design" lands on the row the owner named (through #411's expand seam), then
    // leaves Cut. `hubTarget` is still the unresolved placeholder, so there is no scroll yet; a
    // cause naming no item (a run-policy row, say) simply returns to the form.
    if (cause?.labelId !== undefined) expandEngraveRow(cause.labelId);
    showMode('design');
  };

  // The run sheet is built on demand from the current job and the last generated result, and
  // shown as an overlay (#207). A stale result is not offered: the sheet would describe a job the
  // user has since changed.
  const [sheet, setSheet] = useState<RunSheet | null>(null);
  // The guided job setup (#254) is a path into this panel, not a gate in front of it.
  const [setupOpen, setSetupOpen] = useState(false);
  // #277 — the last measured run of THIS job's program, out of the record files this browser has
  // been handed (the panel's own "Open run record…", plus whatever the readback committed).
  const importedRecords = useRunRecordStore((s) => s.imported);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const lastMeasured = lastTimedRun(job.name, allRuns(importedRecords));
  const runSheetReady = run.generated !== null && run.generated.verify !== null && run.generated.nc !== null;
  const runSheetBlocked = run.staleSince !== null;

  async function openRunSheet(): Promise<void> {
    const generated = useEngraveRunStore.getState().generated;
    if (!generated || !generated.verify || generated.nc === null) return;
    // `buildRunSheet` typesets every label to lay out the origin diagram, and `resolveFont`
    // throws unless the bundled faces are already parsed (#180). The sim worker loads them, but
    // that cache is per-realm — the main thread must load the job's faces itself first, exactly
    // as `JobScheduler` does before its compile.
    await ensureLabelFontsLoaded(job.labels, job.customFonts ?? []);
    // #345 — the house setting the run was gated to, handed over rather than a pre-resolved margin:
    // the sheet resolves it the same way `engraveRunStore` did at Generate, so its depth notes are
    // the numbers the verifier enforced and its recommendation is made from the SETTING.
    setSheet(
      buildRunSheet(
        job,
        generated,
        // #408 — the band the prediction was judged to, so the sheet states the tolerance behind its
        // "matches prediction" claim next to the engine sentence. Undefined until the check ran, and
        // the sheet then claims nothing about a comparison.
        { diagnostics: run.simDiagnostics, engine: run.simEngine ?? undefined, oracleBand: run.oracle?.band },
        new Date(),
        houseMargins,
        // #475 — the surface touches are the shop's own `registration.surfaceTouchCount`, resolved
        // by the same reader the registration planner uses; the labelled fallback is the seed (5).
        // #491 — the chosen copy's case, or both when the pick is indifferent; null leaves the
        // colourless sentence. Read here from the registry's copy pool (this thread), never in the
        // pure sheet module.
        {
          surfaceTouchCount: registrationSettings(shopDefaults).settings.surfaceTouchCount,
          toolCase: caseWordsForKey(job.toolKey) ?? undefined,
          // #472 — the two-tool facts the generator measured, so the sheet's second-program section
          // prints the files and numbers this run actually produced rather than re-deriving them.
          restPass: generated.restPass ?? undefined,
        },
      ),
    );
  }

  const verifyFindings = run.generated?.verify?.findings ?? [];
  const verifyErrors = verifyFindings.filter((f) => f.severity === 'error').length;
  const verifyWarnings = verifyFindings.filter((f) => f.severity === 'warning').length;
  const simErrors = run.simDiagnostics.filter((d) => d.severity === 'error').length;
  const simWarnings = run.simDiagnostics.filter((d) => d.severity === 'warning').length;
  const runErrors = runErrorCodes(run);
  const ackCodes = requiredAckCodes(run);
  const saveBlockerText = saveBlocker(run);
  // #255 — the machine upload. `uploadBlocker` is never weaker than `saveBlocker` (see its own
  // note), so Save and Upload state one rule between them rather than two that agree by luck.
  const uploadBlockerText = uploadBlocker(run);
  // #469 / #419 §3 — a job that produced MORE THAN ONE program is played by the release step,
  // which owns the whole list (upload all, play in order, pause for the bit change). The
  // single-file upload below keeps its own refusal for such a job; the panel therefore renders
  // one or the other, never both run panels.
  const releaseGenerated = run.generated !== null && run.generated.programs.length > 1 ? run.generated : null;
  const releaseBlockerText = releaseBlocker(run);
  const machine = useMachineStore((s) => s.machine);
  const noteLiveStatus = useMachineStore((s) => s.noteLiveStatus);
  // Both halves or neither: the gate is a statement about the report, so a `nc` without one is not
  // a program this panel may offer to send.
  const uploadable =
    run.generated !== null && run.generated.nc !== null && run.generated.verify !== null
      ? { nc: run.generated.nc, verify: run.generated.verify }
      : null;
  const cam = run.generated?.cam ?? null;

  // #442 (#414) — what the run's end is told about the job, built in ONE place
  // (`runContextFor`), so the panel and its unit test cannot disagree about it.
  const runContext = runContextFor(job, tool);

  // #442's #423 item — the viewport follows the line the machine reports. The step is looked up in
  // the path the simulation loaded (the same program Generate posted and Upload sent), so the tool
  // marker lands where the controller says it is rather than where a wall clock thinks it should
  // be. A path with no line data, or a line before the first vertex, moves nothing.
  const followProgramLine = (line: number | null): void => {
    if (line === null) return;
    const sim = useSimStore.getState();
    const step = sim.path === null ? null : stepAtLine(sim.path, line);
    if (step !== null) sim.setStep(step);
  };

  // #243 (§14.2 A2) — the blind-spot half of the Simulated row. The SAME pure builder the
  // Simulate panel uses, fed from THIS run rather than re-written: the fixture the setup
  // modelled, whether sacrificial material was included, and the codes the sweep raised — the
  // unmeasured collet nut among them, but only where the sweep actually needed it (#314).
  // Importing it is what keeps the two panels from disagreeing about what the sweep saw.
  const simCoverage: string[] =
    run.simStatus === null
      ? []
      : coverageDisclaimer({
          outcome: (run.simStatus === 'ready' ? 'swept' : run.pathOnly ? 'path-only' : 'refused') as SimRunOutcome,
          fixtureLabels: viseEnvelope(job.stock, job.workholding.vise, job.sacrificial).boxes.map((b) => b.label),
          fixtureSource: job.workholding.vise.source,
          sacrificialModelled: hasSacrificial(job.sacrificial),
          toolName: toolEntry?.tool.name ?? null,
          codes: run.simDiagnostics.map((d) => d.code),
        });

  const rowToolpath: RowState = cam ? 'tick' : run.phase === 'generating' ? 'pending' : run.generated ? 'cross' : 'idle';
  const rowToolpathText = `Toolpath generated${
    cam
      ? ` (${cam.operations} operation${cam.operations === 1 ? '' : 's'}, ${cam.cuttingMoves} move${cam.cuttingMoves === 1 ? '' : 's'}, ~${formatDuration(cam.estimatedSeconds)})`
      : run.phase === 'generating'
        ? ' — working…'
        : run.generated
          ? ` — stopped at ${run.generated.stage}`
          : ''
  }`;

  const rowVerified: RowState = run.generated?.verify
    ? verifyErrors > 0
      ? 'cross'
      : 'tick'
    : run.phase === 'generating'
      ? 'pending'
      : 'idle';
  const rowVerifiedText = `Verified — ${
    run.generated?.verify
      ? `${verifyErrors} error${verifyErrors === 1 ? '' : 's'}, ${verifyWarnings} warning${verifyWarnings === 1 ? '' : 's'}`
      : 'not verified yet'
  }`;

  const rowSimulated: RowState =
    run.simStatus === 'ready' ? (simErrors > 0 ? 'cross' : 'tick') : run.phase === 'simulating' ? 'pending' : run.simStatus ? 'cross' : 'idle';
  const rowSimulatedText = `Simulated — ${
    run.simStatus === 'ready'
      ? `${simErrors} error${simErrors === 1 ? '' : 's'}, ${simWarnings} warning${simWarnings === 1 ? '' : 's'}`
      : run.simStatus
        ? `the simulation was ${run.simStatus}`
        : 'not simulated yet'
  }`;

  const rowOracle: RowState = run.oracle ? (run.oracle.ok ? 'tick' : 'cross') : run.phase === 'checking' ? 'pending' : 'idle';
  const rowOracleText = `Matches prediction — ${
    run.oracle
      ? `worst under-cut ${run.oracle.worst.underCut.toFixed(4)} mm², over-cut ${run.oracle.worst.overCut.toFixed(4)} mm² (band ${run.oracle.band.toFixed(3)} mm)`
      : 'not checked yet'
  }`;

  // #432 review R11 — a FACING job has a second program, and a withheld facing file must not be
  // invisible: Save writes one file fewer than the sheet says, and the sheet's own sentence is the
  // explanation. The row mirrors `facingSteps`' vocabulary ("the facing program was not produced"),
  // and the cutter named is the one the file was cut with (`facingCam.toolName`), never the job's
  // engraving tool. Facing off adds no row at all — nothing was asked for, so nothing is missing.
  const facingJob = job.facing !== undefined && job.facing.enabled && job.facing.depth > 0;
  const rowFacing: RowState = !facingJob
    ? 'idle'
    : run.generated === null
      ? run.phase === 'generating'
        ? 'pending'
        : 'idle'
      : run.generated.facingNc !== null
        ? 'tick'
        : 'cross';
  const facingCam = run.generated?.facingCam ?? null;
  const rowFacingText = `Facing — ${
    run.generated === null
      ? run.phase === 'generating'
        ? 'working…'
        : 'not generated yet'
      : run.generated.facingNc === null
        ? 'the facing program was not produced' +
          (run.generated.facingError === null ? '' : `: ${run.generated.facingError}`) +
          '. The engraving program can still be run, but the top will not be skimmed — clear the reason and generate again.'
        : facingCam !== null
          ? `${facingCam.toolName}, ⌀ ${facingCam.diameterMm} mm flat, ${facingCam.passes} × ${facingCam.stepDown} mm passes`
          : `${run.generated.facingToolKey ?? 'its own cutter'}`
  }`;

  async function generate(): Promise<void> {
    await run.generate();
  }

  async function saveProgram(): Promise<void> {
    const generated = run.generated;
    if (!generated?.nc || saveBlockerText !== null) return;
    // BOTH files, through the one helper that names them (#207, #244): the run sheet's dry run
    // sends the operator to `<job>-frame.nc`, so the frame has to be written here or §6 is a
    // dead step. The frame is the verified generate output — never re-derived (#244).
    //
    // #277 — and the run record that goes with them, `buildRunRecord`'s own file: the §9 rows as
    // data with the measured half blank. The app does not drive the machine (decision 10), so it
    // cannot know a wall clock or a measured floor depth, and it writes `null` for both rather
    // than a guess dressed as a reading.
    //
    // The record reads §9 off `toPartPlan`, which typesets every label — so the main thread's font
    // cache has to be seeded first, exactly as `openRunSheet` does above (#180). The two `.nc`s do
    // not need it, but they are written in the same breath.
    await ensureLabelFontsLoaded(job.labels, job.customFonts ?? []);
    await saveEngraveProgram(
      generated.nc,
      generated.frameNc,
      job.name,
      serializeRunRecord(buildRunRecord(job, generated)),
      // #432 slice 3 — the facing file goes with them when the worker produced one: the run sheet's
      // facing section sends the operator to `<job>-face.nc`, so it has to be written here.
      generated.facingNc,
    );
  }

  /**
   * #277 — open a filled run record and keep it for this browser. The same `parseRunRecord` the
   * readback script uses, so the panel and the script accept and refuse exactly the same files; a
   * record whose readings carry no date is refused here with the reason the script would print.
   */
  async function openRunRecord(): Promise<void> {
    const file = await openTextFile({ description: 'Run record', extensions: ['.json'] });
    if (!file) return;
    const result = useRunRecordStore.getState().openText(file.text);
    if (!result.ok) {
      setRecordMessage(`${file.name} was not opened — ${result.reason}`);
      return;
    }
    // A record with nothing measured in it is a legitimate file — it is the one Save writes — but
    // saying "cut null" would read as a bug rather than as "you have not filled this in yet".
    setRecordMessage(
      isMeasuredRun(result.run)
        ? `Opened the record for ${result.run.ncFile}, cut ${result.run.cutOn}.`
        : `Opened the record for ${result.run.ncFile} — nothing measured in it yet.`,
    );
  }

  function saveAsMyVise(source: ViseParams['source']): void {
    setVise(source === 'default' ? {} : { source });
    // Keep the measured numbers for the next job too ("Save as my vise", #203).
    useSettingsStore.getState().setVise(useEngraveJobStore.getState().job.workholding.vise);
  }

  // ---- sacrificial material (#213) ---------------------------------------------------------

  const sac = job.sacrificial;
  const under = sac.under;

  /** Apply a whole sacrificial model. An edit is the user asserting a setup: it is `'saved'`,
   *  never a shipped `'default'` (decision 28) — a preset already carries `'saved'`. */
  function applySacrificial(next: Sacrificial): void {
    setSacrificial(next.source === 'default' && hasSacrificial(next) ? { ...next, source: 'saved' } : next);
  }

  function setUnder(under: SacrificialUnder | null): void {
    applySacrificial({ ...sac, under });
  }

  function patchUnder(patch: Partial<SacrificialUnder>): void {
    if (sac.under) applySacrificial({ ...sac, under: { ...sac.under, ...patch } });
  }

  function setSide(pos: keyof Sacrificial['sides'], strip: SacrificialSide | null): void {
    applySacrificial({ ...sac, sides: { ...sac.sides, [pos]: strip } });
  }

  function patchSide(pos: keyof Sacrificial['sides'], patch: Partial<SacrificialSide>): void {
    const strip = sac.sides[pos];
    if (strip) setSide(pos, { ...strip, ...patch });
  }

  function saveAsMySacrificial(): void {
    const stamped: Sacrificial = sac.source === 'default' ? { ...sac, source: 'saved' } : sac;
    setSacrificial(stamped);
    useSettingsStore.getState().setSacrificial(stamped);
  }

  // ---- imported vector outlines (#217) -----------------------------------------------------
  //
  // The SVG/DXF parsers live in the engine and are reached through `openTextFile` (#196); this
  // is the panel end of it. A parsed outline is held until the user accepts it, so the size the
  // dialog shows is the size that lands in the job — the assumed-unit warning and the width
  // control exist precisely so an outline does not arrive at 3 mm or 3 m unremarked.

  const [pendingOutline, setPendingOutline] = useState<OutlineImport | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // Traced bitmaps (#252) keep their PIXELS, not just the parsed outline: every trace control
  // re-traces from them. The options are held here rather than in the dialog so they survive a
  // re-render of it, and they stay as the user last set them for the next picture.
  const [pendingImage, setPendingImage] = useState<RasterImage | null>(null);
  const [traceOptions, setTraceOptions] = useState<Required<TraceOptions>>(() => ({ ...TRACE_DEFAULTS }));
  const [traceError, setTraceError] = useState<string | null>(null);

  function closeImport(): void {
    setPendingOutline(null);
    setPendingImage(null);
    setTraceError(null);
  }

  async function importOutline(): Promise<void> {
    setImportError(null);
    setImporting(true);
    try {
      const result = await importOutlineFromDisk();
      if (result === null) return; // the picker was cancelled
      if (!result.ok) {
        setImportError(result.error);
        return;
      }
      setPendingImage(null);
      setPendingOutline(result.outline);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  async function importImage(): Promise<void> {
    setImportError(null);
    setImporting(true);
    try {
      const result = await importRasterFromDisk(traceOptions);
      if (result === null) return; // the picker was cancelled
      if (!result.ok) {
        setImportError(result.error);
        return;
      }
      setPendingImage(result.image);
      setPendingOutline(result.outline);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  /** A trace control moved: re-trace the pixels the user already picked and redraw the dialog. */
  function retrace(patch: Partial<TraceOptions>): void {
    const next = { ...traceOptions, ...patch };
    setTraceOptions(next);
    if (!pendingImage) return;
    const result = traceRaster(pendingImage, next, pendingOutline?.sourceName ?? 'image');
    if (result.ok) {
      setPendingOutline(result.outline);
      setTraceError(null);
    } else {
      setTraceError(result.error);
    }
  }

  /** The dialog's accepted (possibly rescaled) outline becomes a job item centred on the stock. */
  function acceptOutline(outline: OutlineImport): void {
    // #411 — like every other add, it arrives open: an imported outline's placement and depth are
    // exactly what the import dialog could not settle.
    expandEngraveRow(
      addVector(
        toVectorShape(outline, {
          id: newEngraveShapeId(),
          position: { x: job.stock.length / 2, y: job.stock.width / 2 },
          // #451/#492 — the same starting depth the store's own "Add…" entries use, read from the
          // one stock-aware reader so an imported outline and a drawn shape cannot begin at
          // different numbers, and a laminate's field arrives at its cap + margin.
          depth: newItemDepthFor(job),
          name: outline.sourceName,
        }),
      ),
    );
    closeImport();
  }

  // ---- item naming (labels, shapes and combined shapes are one list downstream, #214/#215) ---

  /** A short name for an item id, for the recommendation's "worst item" line. */
  function itemDisplay(id: string): string {
    const item = allItems(job).find((it) => it.id === id);
    if (item) return 'kind' in item ? item.name ?? item.kind : item.text;
    const trace = (job.traces ?? []).find((t) => t.id === id);
    if (trace) return trace.name ?? (trace.kind === 'line' ? 'Line' : `Text "${trace.text}"`);
    return id;
  }

  // ---- combined shapes (#215 work item 3) --------------------------------------------------
  //
  // `combined` is its own list on the job and now has its own store actions (#215 gap 2), so a
  // mutation is an ordinary job change: persistence and the run's staleness subscription see it.

  /** Every item a combined shape could name, except itself. A bad pick is an `item-reference`
   *  finding (#215), not something the picker hides. */
  function referenceableItems(selfId: string): EngraveAnyItem[] {
    return allItems(job).filter((it) => it.id !== selfId);
  }

  const combinedCount = job.combined?.length ?? 0;
  const traceCount = job.traces?.length ?? 0;
  const drillCount = job.drills?.length ?? 0;
  const threadCount = job.threads?.length ?? 0;
  const vectorCount = job.vectors?.length ?? 0;
  const hasReferenceable = job.labels.length + job.shapes.length + combinedCount + vectorCount > 0;

  const stockNum = (key: 'length' | 'width' | 'thickness', label: string, title: string): JSX.Element => {
    const src = job.sources?.stock?.[key];
    return (
      <label style={FIELD_LABEL}>
        <span>{label}</span>
        <input
          type="number"
          min={0}
          step="any"
          value={job.stock[key]}
          data-testid={`engrave-stock-${key}`}
          aria-label={`Stock ${label}`}
          title={title}
          style={FIELD}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setStock({ [key]: v } as Partial<EngraveJob['stock']>);
          }}
        />
        {src && <SourceTag source={src} testid={`engrave-stock-${key}-source`} />}
      </label>
    );
  };

  const viseNum = (
    key: 'stockProud' | 'fixedJawThickness' | 'movingJawThickness' | 'jawLength' | 'jawStartY' | 'uncertainty',
    label: string,
    title: string,
  ): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={shownNumber(job.workholding.vise[key])}
        data-testid={`engrave-vise-${key}`}
        aria-label={`Vise ${label}`}
        title={title}
        style={FIELD}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) setVise({ [key]: v } as Partial<ViseParams>);
        }}
      />
    </label>
  );

  const feedRow = (key: string, label: string, value: string): JSX.Element => (
    <div key={key} data-testid={`engrave-feeds-${key}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, lineHeight: 1.6 }}>
      <span style={MUTED}>{label}</span>
      <b style={{ color: '#d1d5db', fontWeight: 600 }}>{value}</b>
    </div>
  );

  /**
   * The source of one cutting value (#246): with no override, where the RESOLVED number came from —
   * the feeds table, a coupon's measurement, or Makera's catalogue (#310); with an override, the tag
   * the value was stamped with. Only a stamped value gets the toggle: a typed value can be declared
   * a bench measurement and back, so a measured feed is visible and reversible, while a value nobody
   * asserted has nothing to toggle.
   */
  const overrideSourceTag = (key: keyof Omit<CutParams, 'air'>): JSX.Element => {
    const asserted = job.cutOverride?.[key] !== undefined;
    if (!asserted) {
      const resolved: FieldSource = feeds?.ok ? feeds.sources[key] : 'computed';
      return <SourceTag source={resolved} testid={`engrave-override-${key}-source`} />;
    }
    const src: FieldSource = job.sources?.cut?.[key] ?? 'user';
    if (src === 'computed') return <SourceTag source="computed" testid={`engrave-override-${key}-source`} />;
    return (
      <button
        type="button"
        data-testid={`engrave-override-${key}-source`}
        data-source={src}
        aria-pressed={src === 'measured'}
        title="Click to mark this value as a bench measurement (#208), or back to typed."
        style={{
          ...TAG,
          cursor: 'pointer',
          color: SOURCE_COLOR[src],
          borderColor: src === 'measured' ? '#3a5a3a' : '#2a2f36',
        }}
        onClick={() => setCutOverrideSource(key, src === 'measured' ? 'user' : 'measured')}
      >
        {SOURCE_LABEL[src]}
      </button>
    );
  };

  const overrideNum = (key: keyof Omit<CutParams, 'air'>, label: string, unit: string): JSX.Element => (
    <label key={key} style={FIELD_LABEL}>
      <span>
        {label} <em style={{ color: '#6b7280', fontStyle: 'normal' }}>{unit}</em>
      </span>
      <input
        type="number"
        step="any"
        value={job.cutOverride?.[key] ?? params?.[key] ?? ''}
        data-testid={`engrave-override-${key}`}
        aria-label={`Override ${label}`}
        title="Leave empty to use the computed value. A value that would leave uncut material is refused, not clamped."
        style={FIELD}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') setCutOverride({ [key]: undefined } as Partial<CutParams>);
          else {
            const v = Number(raw);
            if (Number.isFinite(v)) setCutOverride({ [key]: v } as Partial<CutParams>);
          }
        }}
      />
      {overrideSourceTag(key)}
    </label>
  );

  /** A sacrificial number field (#213): the same shape as the stock and vise inputs. */
  const sacNum = (
    testid: string,
    label: string,
    value: number,
    title: string,
    onCommit: (v: number) => void,
  ): JSX.Element => (
    <label key={testid} style={FIELD_LABEL}>
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step="any"
        value={value}
        data-testid={testid}
        aria-label={`Sacrificial ${label}`}
        title={title}
        style={FIELD}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onCommit(v);
        }}
      />
    </label>
  );

  return (
    <div className="panel-stack" data-testid="engrave-panel">
      {/* Empty, unseen and ALWAYS here, so there is a live region to write a removal into (#411
          review). See `RemovalAnnouncement` for why the visible strip cannot be the live one. */}
      <RemovalAnnouncement />

      {/* #419 §3 — the CNC mode switch. A header inside the panel, not a new chrome bar: the CNC
          screen IS this right rail. Cut is never disabled: pressing it always re-asks the gate, so
          a red job still reaches the page that says what is red. Design is today's stack below,
          unchanged. */}
      <div
        data-testid="cnc-mode-switch"
        role="group"
        aria-label="CNC mode"
        style={{ display: 'flex', gap: 4, marginBottom: 8 }}
      >
        <button
          type="button"
          data-testid="cnc-mode-design"
          aria-pressed={mode === 'design'}
          style={{ flex: 1, padding: 6 }}
          onClick={() => showMode('design')}
        >
          Design
        </button>
        <button
          type="button"
          data-testid="cnc-mode-cut"
          aria-pressed={mode === 'cut'}
          title="Ask every preflight owner about this job and show what they say."
          style={{ flex: 1, padding: 6 }}
          onClick={() => showMode('cut')}
        >
          Cut
        </button>
      </div>

      {mode === 'design' ? (
        <>

      {/* #425 §6 — the document's Save/Open surface. Design only: the file owns the job, and the
          Cut branch is #419's. */}
      <EngraveJobFileBar />

      {/* The guided job setup (#254): a path INTO this panel. A new job can be set up from here
          without hunting through the fields below; skipping it leaves every field as it was. */}
      <button
        type="button"
        data-testid="engrave-setup-open"
        title="Answer workholding, material, blank and cutter in order — then return here."
        style={{ width: '100%', padding: 6 }}
        onClick={() => setSetupOpen(true)}
      >
        Set up this job…
      </button>

      {/* #410 item 4 — the design file's way in, beside the guided setup because it is a whole-job
          entry and not a stock field: it brings the blank, the void AND the items. Its own button
          rather than a step of the wizard, because the file answers questions the wizard would
          otherwise ask and then have to be corrected.
          #437 — behind `featureSim` like every other route that reads a project file: the reader
          refuses in a build without the simulator (`designImport`), so the button would only take
          the operator to that refusal. */}
      {featureSim && (
        <>
          <button
            type="button"
            data-testid="engrave-design-import"
            disabled={designReading}
            title="Read a PrusaSlicer project (.3mf): its blank, its magnet pocket and every volume it cuts become this job. The cutter, the vise and the margins are left as they are."
            style={{ width: '100%', padding: 6 }}
            onClick={() => designInputRef.current?.click()}
          >
            {designReading ? 'Reading the design…' : 'Import a design (.3mf)…'}
          </button>
          {/* A plain file input, hidden, rather than the File System Access picker `openTextFile` uses:
              the picker is Chrome-only, and this route needs the BYTES, not a decoded string. */}
          <input
            ref={designInputRef}
            type="file"
            accept=".3mf,model/3mf"
            style={{ display: 'none' }}
            data-testid="engrave-design-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void readDesign(file);
            }}
          />
          {designError && (
            <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-design-error">
              {designError}
            </p>
          )}
        </>
      )}
      {designNotes && (
        // Closed by default, unlike the two blank routes' notes: this patch describes a whole
        // printed badge, and `designJobFor` says everything it settled — the blank, the turn, the
        // colour split, the dome, the void and every volume's own depth. As an open block that is
        // forty lines between the button and the Stock fields, which pushes the cutter and Generate
        // below the fold of a job that has just been read successfully. The first note names the
        // file, so the summary is where the operator is told what happened and the rest is one
        // press away (#410 review).
        <details data-testid="engrave-design-notes" style={{ marginTop: 2 }}>
          <summary data-testid="engrave-design-summary" style={{ ...MUTED, cursor: 'pointer' }}>
            {designNotes[0]} {designNotes.length - 1} notes on what the file settled.
          </summary>
          {designNotes.slice(1).map((note, i) => (
            <p key={i} style={MUTED} data-testid={`engrave-design-note-${i}`}>
              {note}
            </p>
          ))}
        </details>
      )}

      {/* 1 — stock */}
      <h3 style={SUBHEAD}>Stock</h3>
      {/* #271 route 1 — take the blank from the project's badge rather than typing it. Sets the
          stock and declares the magnet pocket in one press; every other field is left alone, so a
          label that no longer fits the smaller blank is reported (not silently moved). */}
      <button
        type="button"
        data-testid="engrave-stock-from-badge"
        disabled={!badgeUsable}
        title={
          badgeUsable
            ? 'Set the stock to the badge’s blank and declare its magnet pocket. Nothing else in the job changes.'
            : 'This project has no enabled badge, so there is no blank to take.'
        }
        style={{ width: '100%', padding: 4 }}
        onClick={useBadgeBlank}
      >
        Use the badge blank
      </button>
      {blankNotes && (
        <div data-testid="engrave-badge-notes">
          {blankNotes.map((note, i) => (
            <p key={i} style={MUTED} data-testid={`engrave-badge-note-${i}`}>
              {note}
            </p>
          ))}
        </div>
      )}
      {/* #280 — the blank archetype's twin of the badge button above. Dimensions only: a blank
          does not know its material, so this leaves `stock.material` exactly as it is. */}
      <button
        type="button"
        data-testid="engrave-stock-from-blank"
        disabled={!blankPartUsable}
        title={
          blankPartUsable
            ? 'Set the stock to the blank’s size. The material stays as you set it — a blank does not know what it is made of.'
            : 'This project has no enabled blank, so there is no blank to take.'
        }
        style={{ width: '100%', padding: 4 }}
        onClick={useBlankStock}
      >
        Use the blank
      </button>
      {blankPartNotes && (
        <div data-testid="engrave-blank-notes">
          {blankPartNotes.map((note, i) => (
            <p key={i} style={MUTED} data-testid={`engrave-blank-note-${i}`}>
              {note}
            </p>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {stockNum('length', 'length X', 'Stock X — it runs between the vise jaws.')}
        {stockNum('width', 'width Y', 'Stock Y — away from the operator.')}
        {stockNum('thickness', 'thickness', 'Stock Z — the blank’s thickness. Max depth per label is this less the minimum floor.')}
        <label style={FIELD_LABEL}>
          <span>material</span>
          <select
            value={job.stock.material}
            data-testid="engrave-stock-material"
            aria-label="Stock material"
            title="Selects the row of the feeds table."
            style={FIELD}
            onChange={(e) => setStock({ material: e.target.value as StockMaterial })}
          >
            {materialOptionsFor(jobMachine(job)).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          {job.sources?.stock?.material && (
            <SourceTag source={job.sources.stock.material} testid="engrave-stock-material-source" />
          )}
        </label>
      </div>
      <p style={MUTED}>X runs between the vise jaws. The fixed jaw is on the left.</p>

      {/* 1a — the skim of the top (#432 slice 4, decision Q6). A two-state choice, not a slider:
          the stock's finish carries the default and the sentence says what that default is, so the
          honest number does the work and the control only reports it. The depth is ASKED once
          facing is on, arriving filled in (`facingDepthDefault`) — the maintainer's decision was
          that the skim is never taken without someone seeing how far.

          An absent `facing` key is the pre-#432 job: nothing has chosen, and the job does not
          face. The line under the toggle says what the finish says, so the default is advice the
          operator can take with one press rather than a state they were put in silently. */}
      <h4 style={SUBSUB}>Facing</h4>
      <p style={MUTED} data-testid="engrave-facing-why">
        {facingRefused ? (
          <>
            {MATERIAL_LABELS[job.stock.material]} — {facingDef.reason}.
            {facingOn ? ' This job still turns facing on; turn it off before it is generated.' : ''}
          </>
        ) : (
          <>
            {finish === null
              ? 'The stock’s finish is not recorded, so the skim is the finish-unknown default'
              : `The stock is ${FINISH_WORD[finish]}`}
            {' — '}
            {facingDef.reason}.
            {facing === null
              ? ' Nothing has been chosen, so the top is not skimmed.'
              : facingOn && facing.depth === 0
                ? ' Facing is on with a zero depth, so nothing is taken off.'
                : ''}
          </>
        )}
      </p>
      {(!facingRefused || facingOn) && (
        <div role="group" aria-label="Facing" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {!facingRefused && (
            <button
              type="button"
              data-testid="engrave-facing-on"
              aria-pressed={facingOn}
              title="Skim the whole top before engraving, then re-touch Z0 on the new surface."
              onClick={() => chooseFacing(true)}
            >
              Face the top
            </button>
          )}
          <button
            type="button"
            data-testid="engrave-facing-off"
            aria-pressed={!facingOn}
            title="Engrave the top as it arrives."
            onClick={() => chooseFacing(false)}
          >
            Leave it
          </button>
          <span style={TAG} data-testid="engrave-facing-state">
            {facing === null ? 'not chosen' : facingOn ? 'facing on' : 'facing off'}
          </span>
        </div>
      )}
      {facingOn && !facingRefused && (
        <>
          <label style={FIELD_LABEL}>
            <span>depth</span>
            <input
              type="number"
              data-testid="engrave-facing-depth"
              aria-label="Facing depth, mm off the whole top"
              title="The TOTAL material taken off the top face. The passes are the feeds row's step-down."
              style={FIELD}
              min={0}
              max={FACING_DEPTH_MAX_MM}
              step={0.05}
              value={facing?.depth ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v) || v < 0) return;
                setFacing({
                  enabled: true,
                  depth: Math.min(v, FACING_DEPTH_MAX_MM),
                  ...(facing?.toolKey ? { toolKey: facing.toolKey } : {}),
                });
              }}
            />
            <span style={{ ...MUTED, margin: 0 }}>mm off the whole top</span>
          </label>
          <p style={MUTED} data-testid="engrave-facing-depth-why">
            {facingDepthReason} The skim is its own program (.nc) with its own flat cutter; the
            engraving file is posted from the surface it leaves.
          </p>
        </>
      )}

      {/* 1b — the voids the blank already has (#271). These are what `jobDepthLimit` reads, so
          the depth limit, the `item-over-void` warning and the run sheet's §1 list all speak of
          a void only if it is declared here. */}
      <h4 style={SUBSUB}>
        Voids under the face{' '}
        <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-keepout-count">
          {keepOuts.length}
        </span>
        <RowFolds testidPrefix="engrave-keepout" ids={keepOuts.map((ko) => ko.id)} firstButtonRef={voidsFoldRef} />
      </h4>
      <p style={MUTED}>
        A pocket the blank already has, cut into its <strong>bottom</strong> face. The ceiling is
        measured up from that face — the opposite direction from every depth in this panel. The
        job refuses any cut that would break through the material left over one.
      </p>
      <UndoRemoval section="voids" fallbackRef={voidsFoldRef} />
      {keepOuts.map((ko, i) => (
        <EngraveKeepOutRow
          key={ko.id}
          keepOut={ko}
          index={i}
          thickness={job.stock.thickness}
          // #351 — the WHOLE answer, from the one function the run sheet and the preview also read:
          // the declared membrane, the layer-aligned roof, the void's own number, the blank's floor
          // and the `min` of the last two. Passing the parts rather than a bare number is what lets
          // the row say which of them set the limit instead of attributing every number to the void.
          depth={keepOutLimitParts(job, keepOutMembrane(job, ko.zCeiling), margins.boundaryMargin)}
          // #345 — which rule set that margin, from the same `voidMargin` arithmetic
          // `keepOutLimitParts` ran, so the sentence under the number cannot name a rule the number
          // is not on.
          limitBasis={voidMarginWords(job, margins.boundaryMargin)}
          findings={findingsFor(ko.id)}
          onChange={(patch) => updateKeepOut(ko.id, patch)}
          onRemove={() => removeKeepOut(ko.id)}
        />
      ))}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
        <span style={{ ...MUTED, margin: 0 }}>add a void:</span>
        {ADD_KEEPOUT_KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            data-testid={`engrave-add-keepout-${k.value}`}
            title={`Declare a ${k.label.toLowerCase()} pocket in the blank's bottom face — the depth limit will respect it.`}
            onClick={() => expandEngraveRow(addKeepOut(k.value))}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* 2 — items: labels, shape pockets and combined shapes, one list (#214/#215) */}
      <h3 style={SUBHEAD}>
        Items{' '}
        <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-item-count">
          {job.labels.length + job.shapes.length + combinedCount + traceCount + drillCount + threadCount + vectorCount}
        </span>
        <RowFolds testidPrefix="engrave-item" ids={itemRowIds(job)} firstButtonRef={itemsFoldRef} />
      </h3>
      <UndoRemoval section="items" fallbackRef={itemsFoldRef} />
      {job.labels.map((label, i) => (
        <EngraveLabelRow
          key={label.id}
          label={label}
          index={i}
          maxDepth={maxDepth}
          findings={findingsFor(label.id)}
          customFonts={job.customFonts}
          recommended={depthRecommendation(label)}
          split={split}
          onChange={(patch) => updateLabel(label.id, patch)}
          onRemove={() => removeLabel(label.id)}
        />
      ))}
      {job.shapes.map((shape, i) => (
        <EngraveShapeRow
          key={shape.id}
          shape={shape}
          index={i}
          maxDepth={maxDepth}
          findings={findingsFor(shape.id)}
          onChange={(patch) => updateShape(shape.id, patch)}
          onRemove={() => removeShape(shape.id)}
        />
      ))}
      {(job.combined ?? []).map((shape, i) => (
        <EngraveCombinedRow
          key={shape.id}
          shape={shape}
          index={i}
          maxDepth={maxDepth}
          candidates={referenceableItems(shape.id)}
          findings={findingsFor(shape.id)}
          onChange={(patch) => updateCombined(shape.id, patch)}
          onRemove={() => removeCombined(shape.id)}
        />
      ))}
      {(job.traces ?? []).map((trace, i) => (
        <EngraveTraceRow
          key={trace.id}
          trace={trace}
          index={i}
          maxDepth={maxDepth}
          findings={findingsFor(trace.id)}
          onChange={(patch) => updateTrace(trace.id, patch)}
          onRemove={() => removeTrace(trace.id)}
        />
      ))}
      {(job.drills ?? []).map((drill, i) => (
        <EngraveDrillRow
          key={drill.id}
          drill={drill}
          index={i}
          maxDepth={maxDepth}
          findings={findingsFor(drill.id)}
          onChange={(patch) => updateDrill(drill.id, patch)}
          onRemove={() => removeDrill(drill.id)}
        />
      ))}
      {(job.threads ?? []).map((thread, i) => (
        <EngraveThreadRow
          key={thread.id}
          thread={thread}
          index={i}
          maxDepth={maxDepth}
          findings={findingsFor(thread.id)}
          onChange={(patch) => updateThread(thread.id, patch)}
          onRemove={() => removeThread(thread.id)}
        />
      ))}
      {(job.vectors ?? []).map((shape, i) => (
        <EngraveVectorRow
          key={shape.id}
          shape={shape}
          index={i}
          maxDepth={maxDepth}
          findings={findingsFor(shape.id)}
          onChange={(patch) => updateVector(shape.id, patch)}
          onRemove={() => removeVector(shape.id)}
        />
      ))}
      {/* The one "Add" control (#214 work item 5): a menu with the five kinds. The label entry
          keeps the historic `engrave-add-label` test id (#205) as its own menu item, so the
          pre-#214 label flow is still one click. #215 adds the three combined kinds, which need
          another item to reference unless they are a border. */}
      <details data-testid="engrave-add-menu" style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#c8d3de' }} data-testid="engrave-add-summary">
          + Add…
        </summary>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {ADD_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              data-testid={`engrave-add-${k.value}`}
              title={k.value === 'label' ? 'Add a text label.' : `Add a ${k.label.toLowerCase()} pocket.`}
              // #411 — a NEW item arrives open: it is a default until its fields are set, and the
              // person who just asked for it is looking for exactly those fields.
              onClick={() => (k.value === 'label' ? expandEngraveRow(addLabel()) : expandEngraveRow(addShape(k.value as EngraveShape['kind'])))}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
          <span style={{ ...MUTED, margin: 0 }}>combined:</span>
          {ADD_COMBINED_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              data-testid={`engrave-add-${k.value}`}
              disabled={k.needsRef && !hasReferenceable}
              title={
                k.needsRef && !hasReferenceable
                  ? `A ${k.label.toLowerCase()} follows another item; add a label or a shape first.`
                  : `Add a ${k.label.toLowerCase()} built from other items.`
              }
              // #411 — open on arrival, like every other add. A frame/cut-away can refuse (no
              // reference), and then there is no row to open.
              onClick={() => {
                const id = addCombined(k.value);
                if (id) expandEngraveRow(id);
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
          <span style={{ ...MUTED, margin: 0 }}>single-line:</span>
          {ADD_TRACE_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              data-testid={`engrave-add-${k.value}`}
              title={
                k.value === 'line'
                  ? 'Add a polyline the cutter traces — the groove is exactly the cutter’s width.'
                  : 'Add text in a single-stroke font, traced as a line rather than pocketed.'
              }
              onClick={() => expandEngraveRow(addTrace(k.value))}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
          <span style={{ ...MUTED, margin: 0 }}>holes:</span>
          {ADD_DRILL_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              data-testid={`engrave-add-${k.value}`}
              title={
                k.value === 'drill'
                  ? 'Add one plunge-drilled hole, exactly the cutter’s diameter.'
                  : 'Add a rectangular array of plunge-drilled holes.'
              }
              onClick={() => expandEngraveRow(addDrill(k.value))}
            >
              {k.label}
            </button>
          ))}
        </div>
        {/* #445 — a milled internal thread. Its pilot is NOT cut by this item: the row and the run
            sheet say the hole has to exist first (D1), and the CAM orbits inside it. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
          <span style={{ ...MUTED, margin: 0 }}>threads:</span>
          <button
            type="button"
            data-testid="engrave-add-thread"
            title="Add a milled internal thread — the pilot must already be drilled; the program cuts the thread only."
            onClick={() => expandEngraveRow(addThread())}
          >
            Thread
          </button>
        </div>
        {/* #217: import an SVG or DXF as a filled cut region. The file is parsed once; the
            contour list is what the job keeps. #252: trace a bitmap to the same kind of thing —
            the picture is thresholded and its boundaries become the contours. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
          <span style={{ ...MUTED, margin: 0 }}>from a file:</span>
          <button
            type="button"
            data-testid="engrave-add-import-outline"
            disabled={importing}
            title="Import a closed, filled SVG or DXF outline as a pocket. Strokes, text and images are reported, not dropped."
            onClick={() => void importOutline()}
          >
            {importing ? 'Reading…' : 'Import outline…'}
          </button>
          <button
            type="button"
            data-testid="engrave-add-trace-image"
            disabled={importing}
            title="Trace a bitmap — PNG, JPEG, GIF, WebP or BMP — into a cut region. Threshold, despeckle and corner smoothing are live in the dialog."
            onClick={() => void importImage()}
          >
            {importing ? 'Reading…' : 'Trace image…'}
          </button>
        </div>
        {importError && (
          <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-import-error">
            {importError}
          </p>
        )}
      </details>
      <p style={MUTED}>Depth keeps the {job.minFloor} mm minimum floor — at most {maxDepth} mm on this stock.</p>

      {/* #345 — what every floor keeps clear of, and where that number came from. The tag names the
          source ("the house default", "this job's recommendation", "set for this job"); when the
          job states no margins of its own it follows the house setting, which is what lets a later
          change to the setting reach a job nobody has overridden. The recommendation is this
          blank's own arithmetic, taken in one click. No slider: a margin nobody can reason about is
          worse than the honest default, so the only controls are "take the recommendation" and
          "go back to the house's". */}
      <div data-testid="engrave-margins" style={{ marginTop: 6, borderTop: '1px solid #2a2f36', paddingTop: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <span style={{ color: '#c8d3de', fontWeight: 600 }}>Depth margins</span>
          <span>
            <b data-testid="engrave-margins-value">{mmText(margins.boundaryMargin)} mm</b>{' '}
            <span style={TAG} data-testid="engrave-margins-source">
              {marginSourceWords(margins.source)}
            </span>
          </span>
        </div>
        <p style={MUTED} data-testid="engrave-margins-note">
          How far every floor stays clear of a plane it must not cross — a void’s ceiling, the colour
          split. Z tolerance {mmText(margins.zTolerance)} mm; a job with no stated margins follows
          the house setting.
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
          <span style={{ ...MUTED, margin: 0 }} data-testid="engrave-margins-recommended">
            For this blank: <b>{mmText(recommendation.boundaryMargin)} mm</b> — {recommendation.basis.join('; ')}.
          </span>
          {recommendMore && (
            <button
              type="button"
              data-testid="engrave-margins-use"
              title={`Run this job on ${mmText(recommendation.boundaryMargin)} mm — the margin this blank's own arithmetic argues for`}
              onClick={() =>
                setJobMargins({
                  boundaryMargin: recommendation.boundaryMargin,
                  zTolerance: recommendation.zTolerance,
                  source: 'recommended',
                })
              }
            >
              Use it
            </button>
          )}
          {job.margins && (
            <button
              type="button"
              data-testid="engrave-margins-house"
              title={`Drop this job's own margins and follow the house setting (${mmText(houseBoundary)} mm on this blank)`}
              onClick={() => setJobMargins(null)}
            >
              Follow the house setting
            </button>
          )}
        </div>
      </div>

      {/* 3 — tool */}
      <h3 style={SUBHEAD}>
        Tool
        {rec && recPick && (
          <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-tool-recommended-tag">
            recommended: {fmtDiameter(recPick.diameter)} mm
          </span>
        )}
      </h3>
      <select
        value={job.toolKey}
        data-testid="engrave-tool"
        aria-label="Tool"
        title="The cutter this job is written for."
        style={{ width: '100%' }}
        onChange={(e) => setTool(e.target.value)}
      >
        <option value="" disabled>
          Choose a cutter…
        </option>
        {tools.map((e) => (
          <option key={e.key} value={e.key} title={e.provenance}>
            {toolOptionLabel(e)}
          </option>
        ))}
      </select>
      {job.sources?.tool && <SourceTag source={job.sources.tool} testid="engrave-tool-source" />}
      {diameter !== null && !vCarveJob && (
        <p style={MUTED} data-testid="engrave-thin-strokes">
          Strokes thinner than {fmtDiameter(diameter)} mm cannot be cut — the cutter opens them away entirely.
        </p>
      )}
      {/* #221 — the V-carve strategy. On a region job the V-bit IS the cutter; the typed depth is
          the FLOOR, and the design is correct at the colour plane. Every number below comes from
          the engine (`vCarvePlane`, `vCarveStepover`, the preview's resolved film, the feeds row's
          own step-over), so the panel cannot state a pitch the CAM does not run. */}
      {vCarveJob && cone !== null && (
        <div
          data-testid="engrave-vcarve"
          style={{ margin: '6px 0', border: '1px solid #3a4a5a', background: '#16202a', borderRadius: 4, padding: 6 }}
        >
          <p style={{ ...MUTED, color: '#c8d3de', margin: 0 }} data-testid="engrave-vcarve-depth-note">
            <b>V-carve.</b> The depth you type is the pocket floor; the design is correct at the{' '}
            <b>colour plane</b>
            {filmPending
              ? ' — resolving it from the print…'
              : film !== null
                ? `, ${mm3(film)} mm below the top, resolved from the print.`
                : ' — this blank states no film, so the plane is the floor.'}{' '}
            The tip is {fmtDiameter(cone.tipRadius * 2)} mm wide and its flank is{' '}
            {fmtDiameter(cone.halfAngleDeg)}° from the axis.
          </p>
          {!filmPending &&
            vCarveItems.map((item) => {
              const plane = vCarvePlane(cone, item.depth, film);
              const stepover =
                vCarveRatio !== null && Number.isFinite(vCarveRatio) && vCarveRatio > 0 && vCarveRatio <= 1
                  ? vCarveStepover(plane.planeRadius, cone, vCarveRatio)
                  : null;
              const name = itemName(item);
              return (
                <p
                  key={item.id}
                  style={MUTED}
                  data-testid={`engrave-vcarve-item-${item.id}`}
                >
                  {name} at {mm3(item.depth)} mm: {mm3(plane.grooveWidth)} mm groove at the plane —
                  floor {mm3(plane.floorInset)} mm narrower per side, top opening{' '}
                  {mm3(plane.surfaceOutset)} mm wider per side;{' '}
                  {stepover === null
                    ? 'the pass pitch was not resolved for this job'
                    : `pass pitch ${mm3(stepover.effective)} mm beside the requested ${mm3(stepover.requested)} mm`}
                  {'.'}
                </p>
              );
            })}
          {!filmPending &&
            vCarveItems.map((item) => {
              const plane = vCarvePlane(cone, item.depth, film);
              const stepover =
                vCarveRatio !== null && Number.isFinite(vCarveRatio) && vCarveRatio > 0 && vCarveRatio <= 1
                  ? vCarveStepover(plane.planeRadius, cone, vCarveRatio)
                  : null;
              // The finding's own sentence, not a paraphrase: this is a note about a correct cut,
              // and the panel must not invent a second wording (or a second severity).
              if (stepover === null || !stepover.clamped) return null;
              return (
                <p
                  key={`clamp-${item.id}`}
                  style={{ ...MUTED, color: '#e0c07a' }}
                  data-testid={`engrave-vcarve-clamp-${item.id}`}
                >
                  {vCarveStepoverClampNote(itemName(item), stepover, cone.tipRadius)}
                </p>
              );
            })}
        </div>
      )}
      {rec && (
        <div
          data-testid="engrave-recommendation"
          style={{ margin: '6px 0', border: '1px solid #3a4a5a', background: '#16202a', borderRadius: 4, padding: 6 }}
        >
          <p style={{ ...MUTED, color: '#c8d3de', margin: 0 }}>
            {recPick ? (
              <>
                <b>
                  Recommended: {fmtDiameter(recPick.diameter)} mm{' '}
                  {recPickCone === null ? 'flat end' : 'V-bit'}
                </b>{' '}
                — {rec.reason}{' '}
                <button
                  type="button"
                  data-testid="engrave-use-recommended"
                  onClick={() => rec.key && setTool(rec.key)}
                >
                  Use it
                </button>
              </>
            ) : (
              rec.reason
            )}
          </p>
          {/* #442 — what the pick's condition asks the operator to do. Its own line, not folded into
              the sentence above: "check this bit" is a different claim from why this cutter. */}
          {rec.conditionNote && (
            <p
              data-testid="engrave-recommendation-condition"
              style={{ ...MUTED, color: '#e0c07a', margin: '4px 0 0' }}
            >
              {rec.conditionNote}
            </p>
          )}
          {/* #455/#458 — what the catalogue itself says. Its own line for the same reason the
              condition note has one: "what Makera lists it for" is a third claim, and the mapping
              note ("its ABS row standing in") has to be visible as a mapping, not as a fact. */}
          {rec.catalogueNote && (
            <p
              data-testid="engrave-recommendation-catalogue"
              style={{ ...MUTED, margin: '4px 0 0' }}
            >
              {rec.catalogueNote}
            </p>
          )}
          {/* #455/#458 — the job's OWN cutter, named by hand, when the catalogue does not
              recommend it for this material. The rule warns and does not block, so this sentence
              is what makes "warn by name" true in the UI: the decision is the operator's. */}
          {rec.selectedNote && (
            <p
              data-testid="engrave-recommendation-selected"
              style={{ ...MUTED, color: '#e0c07a', margin: '4px 0 0' }}
            >
              {rec.selectedNote}
            </p>
          )}
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>
              Why? — {rec.candidates.length} cutters considered
            </summary>
            <div style={{ marginTop: 4 }}>
              {rec.candidates.map((c) => {
                const candidateEntry = tools.find((e) => e.key === c.key);
                const candidateCone = candidateEntry === undefined ? null : vCone(candidateEntry.tool);
                const detail = c.excluded
                  ? c.excluded === 'not-flat'
                    ? // A ball or bull nose, or a V-bit whose file states no usable cone. Since
                      // #221 a V-bit WITH a cone is offered as a V-carve, not excluded.
                      'not a flat end mill'
                    : c.excluded === 'broken'
                      ? // #454/#458 — whose copies said so. Without the attribution a built-in
                        // reading "every copy is marked broken" sounds like the operator's own
                        // verdict on the shipped definition.
                        'every copy is marked broken' + conditionSourceWord(c)
                      : c.excluded === 'no-catalogue-row'
                        ? // #455/#458 — the catalogue's own words. "No cutting parameters" is
                          // the opposite of true here: the starting table answers these cutters
                          // and it is the catalogue that named the materials it is listed for.
                          (c.catalogueNote ?? 'not listed by the catalogue for this material')
                        : 'no cutting parameters for this material'
                  : c.vCarve
                    ? // #221 — the strategy sentence: the design is the cone's width at the plane.
                      V_BIT_CARVE_SENTENCE
                    : c.worst
                      ? `worst item "${itemDisplay(c.worst.labelId)}" · ${Math.round(c.worst.ratio * 100)} % kept${c.condition?.best === 'worn' ? ` · worn${conditionSourceWord(c)}` : ''}`
                      : c.condition?.best === 'worn'
                        ? 'worn' + conditionSourceWord(c)
                        : 'not measured';
                return (
                  <div
                    key={c.key}
                    data-testid={`engrave-candidate-${c.key}`}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, lineHeight: 1.6 }}
                  >
                    <span style={MUTED}>
                      {fmtDiameter(c.diameter)} mm {candidateCone === null ? 'flat end' : 'V-bit'}
                    </span>
                    <span style={{ color: c.qualifies ? '#9fd19b' : '#e0a19b' }}>{detail}</span>
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      )}
      {!rec && previewStatus === 'loading' && (
        <p style={MUTED} data-testid="engrave-recommendation-pending">
          Measuring which cutter keeps every item intact…
        </p>
      )}

      {/* 4 — vise */}
      <h3 style={SUBHEAD}>
        Vise{' '}
        <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-vise-badge">
          {viseBadge(job.workholding.vise)}
        </span>
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {viseNum('stockProud', 'stock proud', 'How far the stock’s top face stands above the jaw tops, mm.')}
        {viseNum('fixedJawThickness', 'fixed jaw', 'Fixed jaw (left) thickness in X, mm.')}
        {viseNum('movingJawThickness', 'moving jaw', 'Moving jaw thickness in X, mm.')}
        {viseNum('jawLength', 'jaw length', 'Jaw length in Y, mm.')}
        {viseNum('jawStartY', 'jaw start Y', 'Where the jaws start relative to the stock’s front edge, mm.')}
        {viseNum('uncertainty', 'uncertainty', 'How far the real jaws may differ, mm. Obstacles are grown by it.')}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" data-testid="engrave-vise-save" onClick={() => saveAsMyVise('saved')}>
          Save as my vise
        </button>
        <button type="button" data-testid="engrave-vise-measured" onClick={() => saveAsMyVise('measured')}>
          I just measured these
        </button>
      </div>

      {/* 5 — sacrificial material (#213): a board under the part and/or strips beside it. */}
      <h3 style={SUBHEAD}>
        Sacrificial material{' '}
        <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-sac-badge">
          {sacrificialBadge(sac)}
        </span>
      </h3>
      <p style={MUTED}>
        Extra material the cutter may run onto, never onto air. The origin and Z0 stay on the
        part’s top face, so a board under it cannot change a cut depth.
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="engrave-sac-preset-board"
          title="A 12 mm board under the part, 10 mm proud all round, taped down."
          onClick={() => applySacrificial(presetPartOnBoard())}
        >
          Part on a larger board
        </button>
        <button
          type="button"
          data-testid="engrave-sac-preset-strips"
          title="6 mm strips between the jaws, left and right, flush with the part."
          onClick={() => applySacrificial(presetJawStrips())}
        >
          Strips between the jaws
        </button>
      </div>

      <label style={{ ...FIELD_LABEL, marginTop: 6 }}>
        <input
          type="checkbox"
          checked={under !== null}
          data-testid="engrave-sac-under"
          aria-label="Board under the part"
          title="A board the part sits on; the cutter may run into it."
          onChange={(e) => setUnder(e.target.checked ? defaultSacrificialUnder() : null)}
        />
        <span>Board under the part</span>
      </label>
      {under && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {sacNum('engrave-sac-under-thickness', 'thickness', under.thickness, 'Board thickness, mm. A breakthrough may not exceed this less 1 mm.', (v) => patchUnder({ thickness: v }))}
          {sacNum('engrave-sac-under-overhang-left', 'overhang left', under.overhang.left, 'How far the board extends past the part on the fixed-jaw side, mm. 0 = flush.', (v) => patchUnder({ overhang: { ...under.overhang, left: v } }))}
          {sacNum('engrave-sac-under-overhang-right', 'overhang right', under.overhang.right, 'How far the board extends past the part on the moving-jaw side, mm.', (v) => patchUnder({ overhang: { ...under.overhang, right: v } }))}
          {sacNum('engrave-sac-under-overhang-front', 'overhang front', under.overhang.front, 'How far the board extends past the part toward the operator, mm.', (v) => patchUnder({ overhang: { ...under.overhang, front: v } }))}
          {sacNum('engrave-sac-under-overhang-back', 'overhang back', under.overhang.back, 'How far the board extends past the part away from the operator, mm.', (v) => patchUnder({ overhang: { ...under.overhang, back: v } }))}
          <label style={FIELD_LABEL}>
            <span>attach</span>
            <select
              value={under.attach}
              data-testid="engrave-sac-under-attach"
              aria-label="How the part is fixed to the board"
              title="Recorded for the run sheet; “loose” is a warning."
              style={FIELD}
              onChange={(e) => patchUnder({ attach: e.target.value as SacrificialUnder['attach'] })}
            >
              {ATTACH_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        {STRIP_SIDES.map((pos) => {
          const strip = sac.sides[pos];
          return (
            <div key={pos} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <label style={FIELD_LABEL}>
                <input
                  type="checkbox"
                  checked={strip !== null}
                  data-testid={`engrave-sac-side-${pos}`}
                  aria-label={`${pos} strip`}
                  title={
                    pos === 'left' || pos === 'right'
                      ? 'A strip between the jaw and the part, clamped with it.'
                      : 'A strip resting on the board at the front/back; needs the board.'
                  }
                  onChange={(e) => setSide(pos, e.target.checked ? defaultSacrificialSide() : null)}
                />
                <span>{pos} strip</span>
              </label>
              {strip && (
                <>
                  {sacNum(`engrave-sac-side-${pos}-thickness`, 'thickness', strip.thickness, 'Strip thickness away from the part, mm.', (v) => patchSide(pos, { thickness: v }))}
                  <label style={FIELD_LABEL}>
                    <input
                      type="checkbox"
                      checked={strip.height === 'flush'}
                      data-testid={`engrave-sac-side-${pos}-flush`}
                      aria-label={`${pos} strip flush with the part`}
                      title="Same height as the part, or a height you set."
                      onChange={(e) => patchSide(pos, { height: e.target.checked ? 'flush' : 6 })}
                    />
                    <span>flush</span>
                  </label>
                  {strip.height !== 'flush' &&
                    sacNum(`engrave-sac-side-${pos}-height`, 'height', strip.height, 'Strip height from the part’s bottom, mm.', (v) => patchSide(pos, { height: v }))}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" data-testid="engrave-sac-save" onClick={saveAsMySacrificial}>
          Save as my setup
        </button>
        {hasSacrificial(sac) && (
          <button type="button" data-testid="engrave-sac-clear" onClick={() => setSacrificial(noneSacrificial())}>
            Remove all
          </button>
        )}
      </div>

      <EngraveSetupsSection />

      {/* 6 — cutting parameters */}
      <h3 style={SUBHEAD}>
        Cutting
        {feeds?.ok && (
          <span
            style={{
              ...TAG,
              marginLeft: 4,
              // The row's own colours, so "Makera's numbers" never reads as a bench reading and a
              // measured row never reads as a starting point (#310, the same rule as field tags).
              color: SOURCE_COLOR[feeds.catalogue ? 'catalogue' : feeds.entry.status === 'measured' ? 'measured' : 'computed'],
            }}
            title={feeds.provenance}
            data-testid="engrave-feeds-status"
            data-source={feeds.catalogue ? 'catalogue' : feeds.entry.status}
          >
            {feeds.catalogue
              ? "Makera's catalogue — not measured"
              : feeds.entry.status === 'unmeasured'
                ? 'starting values — unmeasured'
                : 'measured'}
          </span>
        )}
        {/* A number the machine moved said nothing before this (#317): the row kept its own
            provenance tag and the panel showed 13 000 rpm where the source said 15 000. The tag
            carries no count of its own beyond the clamps, and no finding — a clamp is the machine's
            limit applied correctly, not a reason to refuse a job (decision on #317). */}
        {clamps.length > 0 && (
          <span
            style={{ ...TAG, marginLeft: 4, color: SEVERITY_COLOR.warning }}
            title={clamps.map((d) => d.message).join('\n')}
            data-testid="engrave-feeds-clamped"
            data-codes={clamps.map((d) => d.code).join(' ')}
          >
            clamped to this machine ({clamps.length})
          </span>
        )}
      </h3>
      {!tool && <p style={MUTED}>Choose a cutter to see its cutting parameters.</p>}
      {feeds && !feeds.ok && (
        <div
          data-testid="engrave-feeds-refused"
          style={{ border: '1px solid #7a2828', background: '#2a1416', borderRadius: 4, padding: 6, color: '#f0b4ad', fontSize: 12 }}
        >
          {feeds.reason}
        </div>
      )}
      {params && (
        <>
          {feedRow('spindle', 'spindle', `${params.rpm} rpm`)}
          {feedRow('feed', 'feed', `${params.feed} mm/min`)}
          {feedRow('plunge', 'plunge', `${params.plungeFeed} mm/min`)}
          {feedRow('step-down', 'step-down', `${params.stepDown} mm`)}
          {feedRow('step-over', 'step-over', `${params.stepOver} mm`)}
        </>
      )}
      {/* The override stays mounted even while refused: hiding it would hide the only way to
          undo the override that caused the refusal. */}
      {tool && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>Override</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
            {OVERRIDE_FIELDS.map((f) => overrideNum(f.key, f.label, f.unit))}
          </div>
          <p style={MUTED}>
            Leave a field empty to use the computed value. A step-over wider than the cutter’s
            radius is refused rather than clamped (#191).
          </p>
        </details>
      )}

      {/* 7 — findings on the job as a whole (a label's own findings sit under its row) */}
      {jobFindings.length > 0 && (
        <>
          <h3 style={SUBHEAD}>Findings</h3>
          {jobFindings.map((f, i) => (
            <div
              key={`${f.code}-${i}`}
              // #411 review — the index is part of the test id, the same way the row shell's own
              // finding lines carry theirs (`${prefix}-finding-${index}-${code}`). Two findings can
              // share a code on one job (two labels both too deep), and the key above has always
              // said so; a test id carrying only the code would have been two nodes under one name.
              data-testid={`engrave-finding-${i}-${f.code}`}
              style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.45, margin: '3px 0', color: '#d1d5db' }}
            >
              <span style={{ color: SEVERITY_COLOR[f.severity], flexShrink: 0 }}>●</span>
              <span>
                <code style={{ color: SEVERITY_COLOR[f.severity] }}>{f.code}</code> {f.message}
              </span>
            </div>
          ))}
        </>
      )}

      {previewStatus === 'error' && (
        <p style={{ ...MUTED, color: '#f0b4ad' }} data-testid="engrave-preview-error">
          The preview could not be built: {previewError ?? 'unknown error'}
        </p>
      )}

      {/* 8 — generate → verify → simulate → oracle → save (#206) */}
      <h3 style={SUBHEAD}>Generate</h3>
      <div data-testid="engrave-generate-slot">
        <button
          type="button"
          data-testid="engrave-generate"
          disabled={blocked || running || !simEnabled}
          title={
            !simEnabled
              ? 'This build has no simulation worker.'
              : blocked
                ? 'Fix the errors above first.'
                : 'Generate, verify, simulate and check the toolpath (#206).'
          }
          style={{ width: '100%', padding: 7 }}
          onClick={() => void generate()}
        >
          {running ? 'Working…' : 'Generate toolpath'}
        </button>

        {!blocked && (
          <>
            <div style={{ marginTop: 6 }} data-testid="engrave-run-rows">
              <RunRow testid="engrave-run-toolpath" state={rowToolpath} text={rowToolpathText} />
              {/* #277 — what the last measured run of this program actually took, from a record
                  file a person filled in. It sits BESIDE the estimate, never in place of it: the
                  `~` above is still the planning figure, and this is a reading with a date. */}
              {lastMeasured && lastMeasured.minutes !== null && (
                <p
                  data-testid="engrave-last-measured"
                  style={{ margin: '2px 0 4px 18px', fontSize: 11, color: '#9aa4b0', lineHeight: 1.45 }}
                >
                  Last measured run: {formatDuration(lastMeasured.minutes * 60)} on {lastMeasured.cutOn} — a
                  bench reading, not the estimate above.
                </p>
              )}
              {/* #432 review R11 — the facing program is its own file: name the cutter it runs, or
                  the reason it was withheld. Absent when the job does not face. */}
              {facingJob && <RunRow testid="engrave-run-facing" state={rowFacing} text={rowFacingText} />}
              <RunRow testid="engrave-run-verified" state={rowVerified} text={rowVerifiedText} />
              <RunRow testid="engrave-run-simulated" state={rowSimulated} text={rowSimulatedText} />
              {simCoverage.length > 0 && (
                <div
                  data-testid="engrave-sim-coverage"
                  style={{ margin: '2px 0 4px 18px', display: 'flex', flexDirection: 'column', gap: 2 }}
                >
                  {simCoverage.map((line, i) => (
                    <span key={i} style={{ fontSize: 11, color: '#9aa4b0', lineHeight: 1.45 }}>
                      {line}
                    </span>
                  ))}
                </div>
              )}
              <RunRow testid="engrave-run-oracle" state={rowOracle} text={rowOracleText} />
            </div>

            {runErrors.length > 0 && (
              <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-run-errors">
                {runErrors.length} error{runErrors.length === 1 ? '' : 's'} outstanding.
              </p>
            )}
            {run.error && (
              <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-run-error">
                {run.error}
              </p>
            )}

            {ackCodes.length > 0 && (
              <label
                style={{ display: 'block', marginTop: 6, fontSize: 12, color: '#c8d3de' }}
                data-testid="engrave-ack-label"
              >
                <input
                  type="checkbox"
                  data-testid="engrave-ack"
                  checked={run.acknowledged}
                  onChange={(e) => run.setAcknowledged(e.target.checked)}
                />{' '}
                I have checked clearance to the vise and the tool&apos;s reach myself.
              </label>
            )}

            <button
              type="button"
              data-testid="engrave-save"
              disabled={saveBlockerText !== null}
              title={saveBlockerText ?? 'Save the generated program — to upload it from here, or to open in Makera Studio.'}
              style={{ width: '100%', padding: 7, marginTop: 6 }}
              onClick={() => void saveProgram()}
            >
              Save .nc…
            </button>
            {saveBlockerText !== null && (
              <p style={MUTED} data-testid="engrave-save-blocked">
                Save is disabled — {saveBlockerText}.
              </p>
            )}

            {/* #255 — hand the verified program to the machine. Desktop build only: `canDriveMachine`
                folds to false in the web build, so this block is dead code there and the bridge
                never enters the web bundle. The filename is the one Save writes, so the file on the
                machine's card and the one in the operator's run sheet are named the same thing.
                #469 — a job of more than one program is the release step's: it uploads every file
                and plays them in cut order, so the single-file upload is not offered for it. */}
            {canDriveMachine && releaseGenerated !== null && (
              <EngraveReleaseStep
                target={machine === null ? null : { host: machine.host, port: machine.port }}
                job={job}
                generated={releaseGenerated}
                blocker={releaseBlockerText}
                onProgramLine={followProgramLine}
              />
            )}
            {canDriveMachine && releaseGenerated === null && (
              <EngraveMachineUpload
                blocker={uploadBlockerText}
                machine={machine}
                program={uploadable}
                filename={runSheetFileName(job.name)}
                lift={{
                  zMachine: jobMachine(job).toolChange.clearanceZ,
                  zFloorMachine: jobMachine(job).softEndstop.zMin,
                }}
                onLiveStatus={noteLiveStatus}
                runContext={runContext}
                jobEdgeMarginMm={job.edgeMargin}
                onProgramLine={followProgramLine}
              />
            )}

            {/* The operator run sheet (#207): printable, built from this job and the verified
                result. Offered once a job has generated AND verified; a stale result is refused,
                because the sheet would describe a job the user has since changed. */}
            <button
              type="button"
              data-testid="engrave-run-sheet"
              disabled={!runSheetReady || runSheetBlocked}
              title={
                runSheetBlocked
                  ? 'The job changed since it was generated; regenerate before opening the sheet.'
                  : runSheetReady
                    ? 'Open the printable run sheet for the machine (#207).'
                    : 'Generate and verify the job first.'
              }
              style={{ width: '100%', padding: 7, marginTop: 6 }}
              onClick={() => void openRunSheet()}
            >
              Run sheet…
            </button>
          </>
        )}

        {/* #277 — the record a previous run of this job left beside its `.nc`, brought back in.
            Offered whether or not the job on screen has generated: it is about a run that already
            happened, and the estimate's "last measured" line is what it feeds. */}
        <button
          type="button"
          data-testid="engrave-open-record"
          title="Open the run record saved beside a previous run's .nc, and show its measured wall clock beside the estimate."
          style={{ width: '100%', padding: 7, marginTop: 6 }}
          onClick={() => void openRunRecord()}
        >
          Open run record…
        </button>
        {recordMessage !== null && (
          <p style={MUTED} data-testid="engrave-record-message">
            {recordMessage}
          </p>
        )}
      </div>

      {sheet && <RunSheetView sheet={sheet} onClose={() => setSheet(null)} />}
      {setupOpen && <EngraveSetupFlow onClose={() => setSetupOpen(false)} />}
      {pendingOutline && (
        <EngraveImportDialog
          outline={pendingOutline}
          cutterDiameter={diameter}
          trace={
            pendingImage && {
              options: traceOptions,
              onChange: retrace,
              imageWidth: pendingImage.width,
              imageHeight: pendingImage.height,
              error: traceError,
            }
          }
          onAccept={acceptOutline}
          onClose={closeImport}
        />
      )}

      {previewStatus === 'loading' && (
        <p style={{ ...MUTED, opacity: 0.7 }} data-testid="engrave-preview-loading">
          Rebuilding the preview…
        </p>
      )}
        </>
      ) : (
        preflight !== null && (
          <>
            {/* #495 — the registration step runs the setup's approved plan, then the gate's
                findings read below it. The release step (slice 3) mounts on this same page. */}
            <EngraveRegistrationStep
              job={job}
              target={machine === null ? null : { host: machine.host, port: machine.port }}
            />
            <EngravePreflight report={preflight} onBackToDesign={backToDesign} />
          </>
        )
      )}
    </div>
  );
}
