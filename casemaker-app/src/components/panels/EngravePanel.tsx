import { featureSim } from '@/platform/features';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode, type RefObject } from 'react';
import { newItemDepthFor, newTargetObjectId, useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveJobFileStore } from '@/store/engraveJobFileStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { expandEngraveRow, useEngraveRowStore } from '@/store/engraveRowStore';
import { useEngraveRunStore, firstRunError, gateViewFor, releaseBlocker, runErrorCodes, saveBlocker, uploadBlocker, withPeriod } from '@/store/engraveRunStore';
import { useMachineStore } from '@/store/machineStore';
import { useSimStore } from '@/store/simStore';
import { useCncModeStore } from '@/store/cncModeStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import { useStockStore } from '@/store/stockStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { preflightHub } from '@/engine/cnc/preflight';
import type { PreflightCause } from '@/engine/cnc/preflight';
import { runContextFor } from '@/store/machineRunStore';
import { stepAtLine } from '@/engine/cnc/playbackClock';
import { EngraveCutSurface } from './EngraveCutSurface';
import { saveEngraveProgram } from '@/engine/exportTrigger';
import { useSettingsStore } from '@/store/settingsStore';
import {
  blankDepthCeiling,
  effectiveMargins,
  houseBoundaryMargin,
  recommendLabelDepth,
  recommendMargins,
  voidMarginWords,
  zBudgetInputsFor,
} from '@/engine/cnc/engrave/depthBounds';
import type { LabelDepthRecommendation } from '@/engine/cnc/engrave/depthBounds';
import { jobSplit } from '@/engine/cnc/engrave/depthIntent';
import { TOOL_GROUPS, toolDisplay, toolDisplayName } from '@/engine/cnc/toolDisplay';
import { jobMachine } from '@/engine/cnc/calibration';
import { machineDisplayName } from '@/platform/locationClient';
import { machineRecordByProfile, useLocationStore } from '@/store/locationStore';
import { mountNameFor, probeNameFor } from '@/engine/cnc/registration/mountContext';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { cuttingDiameter, drillPointAngle, pointLength } from '@/engine/cnc/tool';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { borePitchMm, boreRampAngleFrom } from '@/engine/cnc/cam/drill';
import { readDefault } from '@/platform/defaultsClient';
import { caseWordsForKey } from '@/engine/cnc/toolCondition';
import { dedupeFindings, itemKindWord, itemRowName, jobSetups, jobTool, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { bedUnderFacts, machineForJob } from '@/platform/bedProfiles';
import type { RestChoice } from '@/components/panels/RestCutterControl';
import {
  hasRegionItems,
  itemName,
  type ToolCandidate,
} from '@/engine/cnc/engrave/recommendTool';
import { vCone, vFluteLength } from '@/engine/cnc/vProfile';
import {
  vCarvePlane,
  vCarveStepover,
  vCarveStepoverClampNote,
} from '@/engine/cnc/vCarveGeometry';
import { jobVise, validateVise } from '@/engine/cnc/fixture';
import {
  keepOutLimitParts,
  keepOutMembrane,
  labelGlyphMeasure,
  labelJawReach,
  primitiveLabel,
  primitiveReducesToRegion,
  voidLimitForItem,
} from '@/engine/cnc/engrave/partPlan';
import { ensureLabelFontsLoaded, ensureSeedFontsLoaded, labelFontsLoaded } from '@/engine/fonts/registry';
import { buildRunSheet, type RunSheet } from '@/engine/cnc/engrave/runSheet';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { buildRunRecord, isMeasuredRun, serializeRunRecord } from '@/engine/cnc/engrave/runRecord';
import { allRuns, lastTimedRun } from '@/engine/cnc/engrave/runHistory';
import { useRunRecordStore } from '@/store/runRecordStore';
import { surfaceSpreadFor, firstRegistrationFor } from '@/store/engraveRegistrationStore';
import { openTextFile } from '@/utils/openTextFile';
import { feedCatalogueSnapshot, feedsFor, type CutParams } from '@/engine/cnc/feeds';
import {
  TRACE_DEFAULTS,
  importOutlineFromDisk,
  importRasterFromDisk,
  toLineTraces,
  toVectorShape,
  traceRaster,
  type OutlineImport,
  type RasterImage,
  type TraceOptions,
} from '@/engine/import/outlineImport';
import { newEngraveShapeId, newEngraveTraceId } from '@/engine/cnc/engrave/defaults';
import {
  FACING_DEPTH_MAX_MM,
  facingDefault,
  facingDepthDefault,
  facingRefusal,
  facingShopFrom,
  finishOf,
  formLabel,
  measuredTopSpreadMm,
  stockSizeWords,
} from '@/engine/cnc/stockStart';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { groupRejections, isActionableRejection, shouldGroupCatalogueRows } from './recommendationRejections';
import { useShopDefaultsStore, shopDefault } from '@/store/shopDefaultsStore';
import { readDesignFile } from '@/engine/import/designImport';
import { readTargetObjectFile } from '@/engine/import/targetObject';
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
import { EngraveDrillRow, type BorePitchFacts, type DrillPeckFacts } from './EngraveDrillRow';
import { EngraveChamferRow, type ChamferFacts, type ChamferRimOption } from './EngraveChamferRow';
import { EngraveCutoutRow, type CutoutTarget } from './EngraveCutoutRow';
import { EngraveThreadRow } from './EngraveThreadRow';
import { EngravePrimitiveRow } from './EngravePrimitiveRow';
import { EngraveTargetObjectRow } from './EngraveTargetObjectRow';
import { OperationPicker } from './OperationPicker';
import { addOperationOfType, jobHasOperations, operationType, type OperationOptionDef, type OperationTypeId } from './operationTypes';
import {
  inlayGlueGap,
  inlayMaleJob,
  inlayMaleJobName,
  inlayNumbers,
  type InlayNumbers,
} from '@/engine/cnc/engrave/inlay';
import { textureNumbers, textureStrokes, type TextureNumbers } from '@/engine/cnc/engrave/texture';
import { prismNumbers, type PrismCheck } from '@/engine/cnc/engrave/prism';
import { jobFileName } from '@/engine/cnc/engrave/jobFile';
import { decodePng } from '@/engine/import/png';
import { base64ToArrayBuffer } from '@/engine/import/base64';
import { reliefNumbers } from '@/engine/cnc/cam/relief';
import { saveJobFileText } from '@/store/engraveJobFileStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { setOperationIntake } from './operationIntake';
import { EngraveTraceRow } from './EngraveTraceRow';
import { EngraveVectorRow } from './EngraveVectorRow';
import { EngraveImportDialog } from './EngraveImportDialog';
import { EngraveSetupsSection } from './EngraveSetupsSection';
import { RunSheetView } from './RunSheetView';
import { formatDuration } from '@/engine/cnc/plan/format';
import { bedHoldLine, fmt } from '@/components/welcome/holdingMounts';
import { activeProfileOf } from '@/platform/machineChange';
import type {
  EngraveAnyItem,
  EngraveChamfer,
  EngraveDrill,
  EngraveJob,
  EngraveKeepOut,
  EngraveLabel,
  EngraveShape,
  FieldSource,
  JobStockFinish,
  Sacrificial,
  SacrificialSide,
  SacrificialUnder,
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
const FIELD: CSSProperties = { width: 74 };
// #503 — the label may WRAP, not just shrink. A stock field carries a `computed` source tag after
// its input; at the panel's ~300 px content width that tag did not fit beside the label and input,
// and because it could not wrap it was the thing cut off (the tag read "compu" at the right edge).
// Wrapping puts the tag on its own line, where it stays readable.
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0', flexWrap: 'wrap' };
/**
 * #503 — a two-column field grid whose columns may shrink below their content's min-content width.
 * `1fr` is `minmax(auto, 1fr)`, so the widest unbreakable thing in a cell (here the source tag) set
 * the column's minimum and the second column hung past the panel's right edge at phone and tablet
 * widths. A zero minimum keeps both columns inside the panel; the label's own `flexWrap` handles
 * the overflow within a cell.
 */
const FIELD_GRID: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 };

/**
 * A value as a field should PRINT it (#406, §4's three-decimal rule). Binary float noise a person
 * should never read — `3.2 − 3.1` is `0.10000000000000009`, and a thin blank's `stockProud` can be
 * its negative — is removed at the 0.001 mm the controller moves in. The stored value is untouched:
 * this is the display only.
 */
function shownNumber(v: number): number {
  return Number(v.toFixed(3));
}
const TAG: CSSProperties = {
  fontSize: 10,
  color: '#9aa4b0',
  border: '1px solid #2a2f36',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
  fontWeight: 400,
};
const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

/** A leading letter, uppercased — the engine's reasons are clauses, the panel prints sentences. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * #516 item 5 — the cutter key the first Generate should apply. Reads the preview's current pick;
 * when the preview has not landed yet (`loading`/`idle`) it waits for it, so a Generate pressed
 * before the preview finished still picks the cutter and builds the program in one press. Resolves
 * null when no cutter is eligible, the preview errors, or the wait times out.
 */
function awaitPreviewRecommendationKey(timeoutMs = 30_000): Promise<string | null> {
  const got = useEngravePreviewStore.getState();
  if (got.preview?.recommendation?.key) return Promise.resolve(got.preview.recommendation.key);
  if (got.status === 'ready' || got.status === 'error') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (key: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(key);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    const unsub = useEngravePreviewStore.subscribe((state) => {
      const key = state.preview?.recommendation?.key ?? null;
      if (key !== null) settle(key);
      else if (state.status === 'ready' || state.status === 'error') settle(null);
    });
  });
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

/**
 * The tag that shows a field's provenance (#246/#254), or null when nothing was asserted.
 *
 * #686, design §2 — a grey `typed` chip beside every number the operator typed thirty seconds ago
 * is noise (audit D2). The fact that a value is theirs is still stated: one sentence in the Cutter
 * group's Technical fold names every field that was typed by hand. Computed, Makera's catalogue,
 * measured and assumed still carry their tag, because those are claims the operator cannot read off
 * the number itself.
 */
function SourceTag({ source, testid }: { source: FieldSource; testid: string }): JSX.Element | null {
  if (source === 'user') return null;
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
            ? "Makera's catalogue — their starting number for this cutter, not a measurement of this machine."
            : source === 'measured'
              ? 'Taken at the bench.'
              : 'Typed here — not more trustworthy for that.'
      }
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

// #685 — the kinds this menu used to list in a second vocabulary (shapes, combined items, traces,
// drills, primitives, the cut-out) are now OPTIONS of the operations they belong to, in
// `operationTypes.ts` (`OPERATION_OPTIONS`). The picker draws them; the panel only maps a picked
// option to its store action (`addFolded`).

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
    ...(job.primitives ?? []).map((i) => i.id),
    ...(job.cutouts ?? []).map((i) => i.id),
    ...(job.vectors ?? []).map((i) => i.id),
    ...(job.chamfers ?? []).map((i) => i.id),
  ];
}

const ATTACH_METHODS: readonly { value: SacrificialUnder['attach']; label: string }[] = [
  { value: 'tape', label: 'tape' },
  { value: 'glue', label: 'glue' },
  { value: 'screws', label: 'screws' },
  { value: 'loose', label: 'loose (a warning)' },
];

const STRIP_SIDES: readonly (keyof Sacrificial['sides'])[] = ['left', 'right', 'front', 'back'];

/**
 * #454/#458 — a built-in or catalogue key borrows the condition of the shop's copies that
 * correspond to it, so a summarised condition on it is a statement about THOSE copies, not about
 * the shipped definition. The `Why?` row's short suffix has to say so, or it reads exactly like a
 * condition the operator set. An owned key's summary IS its own copies and carries no attribution.
 */
function conditionSourceWord(c: ToolCandidate): string {
  return c.condition?.adopted ? ' (the shop’s copies)' : '';
}

/**
 * #687 — the cutter list's option text is the one display form, with the metal fact spelled as a
 * last segment because a native `<select>` cannot draw the tag. The vendor label is not the name;
 * it stays in the option's hover (`title`), beside the provenance, which is where data belongs.
 */
function toolOptionLabel(e: ToolLibraryEntry): string {
  const display = toolDisplay(e.tool);
  return display.metal ? `${display.name} · metal` : display.name;
}

/** The option's hover: the vendor's label and the provenance, neither of which is the name. */
function toolOptionTitle(e: ToolLibraryEntry): string {
  return e.tool.name.trim() === '' ? e.provenance : `${e.tool.name} · ${e.provenance}`;
}

/**
 * The badge that says where the vise numbers came from (decision 28: a default is not a
 * measurement). The shipped set is calipered as of 2026-10-15 (#208), so 'default' no longer means
 * "nobody measured it" — it means nobody measured THIS machine's vise, and the badge says that.
 */
function viseBadge(v: ViseParams): string {
  // #690b — the operator's words: the shipped set is measured, once, on the machine the product was
  // designed around; it is this vise that has not been measured. "Reference unit" said neither.
  if (v.source === 'default') return 'shipped · not measured here';
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
  if (s.source === 'default') return 'default';
  if (s.source === 'saved') return 'saved';
  return 'measured · this setup';
}

/**
 * #686 — the footer's finding count in the operator's words: `1 note`, `3 notes` (§3.6). The old
 * "2 warnings · 0 errors" tally was audit B13: a count split by severity beside a list whose rows
 * carried a colour dot instead of the severity word. Each row now names its severity and the
 * summary says how many notes there are.
 */
function findingTally(findings: JobFinding[]): string {
  return `${findings.length} note${findings.length === 1 ? '' : 's'}`;
}

/** The severity as the operator reads it in a finding row (#686). */
const SEVERITY_WORD: Record<JobFinding['severity'], string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Note',
};

/**
 * A collapsible group in the Design rail (#523): a heading with a one-line summary that stays
 * visible, and a body that opens or closes. The summary carries the group's facts in words so a
 * closed group is not a blank — no new controls, the browser's own `<details>` is the mechanism.
 *
 * #688 — the open state is the PANEL's, not the group's: Generate's Fix has to open the group a
 * blocker names, and a `<details>` that owns its own `open` cannot be opened from outside.
 */
function Group({
  testid,
  title,
  summary,
  action,
  open,
  onOpenChange,
  children,
}: {
  testid: string;
  title: string;
  summary: string;
  /** #681 — the group's own way into the wizard (the mockup's `edit`), without opening the group. */
  action?: { testid: string; label: string; onClick: () => void };
  /** #688 — the panel owns the open state, so Generate's Fix can open a group it names. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      data-testid={testid}
      open={open}
      onToggle={(e) => onOpenChange((e.currentTarget as HTMLDetailsElement).open)}
      style={{ marginTop: 8, borderTop: '1px solid #2a2f36', paddingTop: 4 }}
    >
      <summary
        data-testid={`${testid}-summary`}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: '#c8d3de' }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, textAlign: 'right' }}>
          <span style={{ ...MUTED, margin: 0 }}>{summary}</span>
          {action && (
            <button
              type="button"
              data-testid={action.testid}
              style={{ ...MUTED, margin: 0, padding: '1px 6px', cursor: 'pointer' }}
              onClick={(e) => {
                // A button inside a summary would otherwise toggle the group as well.
                e.preventDefault();
                e.stopPropagation();
                action.onClick();
              }}
            >
              {action.label}
            </button>
          )}
        </span>
      </summary>
      <div style={{ marginTop: 4 }}>{children}</div>
    </details>
  );
}

/** The four run rows' states (#206): a tick, a cross, a spinner, or nothing yet. */
type RowState = 'tick' | 'cross' | 'pending' | 'idle';

/**
 * #688 — the exact sentence `saveBlocker` returns when the clearance acknowledgement is missing.
 * Save's blocker line uses the match to know that Cut is where this one is resolved (and gets the
 * Fix); every other Save blocker is a Design fact. #689 writes the same words where Cut step 1
 * asks the question, so the sentence and the control it names cannot drift apart.
 */
const CLEARANCE_ACK_BLOCKER = 'tick the clearance check in Cut, step 1';

const ROW_MARK: Record<RowState, string> = { tick: '✓', cross: '✗', pending: '…', idle: '·' };
const ROW_COLOR: Record<RowState, string> = { tick: '#8fd694', cross: '#f0b4ad', pending: '#c8d3de', idle: '#66707a' };

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

/**
 * #688 — one of the FOUR ticks Generate leaves on one line (§3.6): `✓ generated · ✓ verified · ✓
 * simulated · ✓ matches the design`. The counts and under/over-cut numbers those rows used to
 * carry are the simulation's own facts and live in its panel (#691).
 */
function RunTick({ testid, state, label, last = false }: { testid: string; state: RowState; label: string; last?: boolean }): JSX.Element {
  return (
    <span data-testid={testid} data-state={state} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span aria-hidden style={{ color: ROW_COLOR[state] }}>
        {ROW_MARK[state]}
      </span>
      <span>{label}</span>
      {!last && (
        <span aria-hidden style={{ color: '#66707a', marginLeft: 4 }}>
          ·
        </span>
      )}
    </span>
  );
}

/**
 * #688 — where the Generate blocker's Fix takes the reader. The panel opens the GROUP, expands the
 * item's row, opens the fold and focuses the control; a job-level finding with no field of its own
 * (there is none today) still lands on the findings list.
 */
interface PanelFix {
  group: 'engrave-group-job' | 'engrave-group-cutter' | 'engrave-group-hold';
  /** An item (label/shape/drill/…) whose row the finding names. */
  itemId?: string;
  /** The control to focus once the group and folds are open. */
  focusTestid?: string;
  /** A `<details>` fold to open on the way (`engrave-override`, `engrave-add-menu`). */
  openDetails?: string;
  /**
   * #725 B4 — the fix is in a wizard STEP rather than a field of this panel: the bed's clamp/arm
   * refusals open Holding (the picture where the clamp is dragged), and a rotary job whose blank
   * is not a cylinder opens the Stock step.
   */
  openWizardStep?: 'holding' | 'stock';
}

/** A sentence a disabled Generate carries, and the control that resolves it. */
interface GenerateBlocker {
  sentence: string;
  /**
   * #725 review — null when there is no control to offer: a PROGRAM defect of ours gets its
   * sentence at the button, never a Fix that sends the operator to re-seat the work for our gap.
   */
  fix: PanelFix | null;
}

/**
 * #688 — the control a blocking FINDING names. Most findings point at one item and carry its
 * `labelId`, so the Fix opens that row. The job-level codes are a small closed set with a known
 * home, mapped here rather than guessed from the message.
 *
 * #725 B4 — the bed's generation-time refusals (a clamp in the cut's path, a cut into an arm) are
 * fixed on the Holding step's picture, so those codes open Holding rather than an item row.
 *
 * #725 review — a `rotary-` PREFIX is not a fix: `rotary-unsupported` is per-item (its row), and
 * `rotary-y-off-axis` / `rotary-rapid-engaged` / `rotary-turn-in-stock` are PROGRAM defects of ours
 * (`null`: no Fix at all — never send the operator to re-seat the work for a software gap). Only
 * `rotary-stock` has an operator fix, and it is the Stock step.
 */
export function findingFix(f: { code: string; labelId?: string }): PanelFix | null {
  const code = f.code;
  if (PROGRAM_DEFECT_CODES.has(code)) return null;
  if (HOLD_FIX_CODES.has(code)) {
    return { group: 'engrave-group-hold', openWizardStep: 'holding' };
  }
  if (f.labelId !== undefined) return { group: 'engrave-group-job', itemId: f.labelId };
  if (code === 'rotary-stock') return { group: 'engrave-group-job', openWizardStep: 'stock' };
  if (code === 'tool-missing') return { group: 'engrave-group-cutter', focusTestid: 'engrave-tool' };
  if (code === 'no-items') {
    return { group: 'engrave-group-job', openDetails: 'engrave-add-menu', focusTestid: 'engrave-add-summary' };
  }
  if (code.startsWith('goal-object')) return { group: 'engrave-group-job', focusTestid: 'engrave-target-input' };
  if (code === 'facing-too-deep') return { group: 'engrave-group-job', focusTestid: 'engrave-facing-depth' };
  if (
    code.startsWith('vise-') ||
    code.startsWith('setup-') ||
    code.startsWith('sacrificial-') ||
    code.startsWith('side-strip') ||
    code.startsWith('strip-') ||
    code.startsWith('under-')
  ) {
    return { group: 'engrave-group-hold', openDetails: 'engrave-vise-card', focusTestid: 'engrave-vise-card' };
  }
  return { group: 'engrave-group-job' };
}

/**
 * #725 review — the codes whose refusal is the SOFTWARE's, not the operator's: a rotary program
 * that turns or traverses while the tip is in the cut, leaves the axis, or cannot prove the sector
 * between two indexed positions. The sentence stays (the run's row), but there is no control to
 * offer: asking an operator to re-seat the work for a program defect is the one thing a Fix must
 * never do.
 */
const PROGRAM_DEFECT_CODES: ReadonlySet<string> = new Set([
  'rotary-y-off-axis',
  'rotary-rapid-engaged',
  'rotary-turn-in-stock',
]);

/**
 * #725 B4 — the bed's codes whose fix is the Hold picture (§3.7). `clamp-in-path` and
 * `bracket-in-path` are the verifier's; the tape/board ones are the document gate's. They open
 * the Holding step, where the clamp is dragged and the board chosen.
 */
const HOLD_FIX_CODES: ReadonlySet<string> = new Set([
  'clamp-in-path',
  'bracket-in-path',
  'clamps-overlap',
  'clamp-off-stock',
  'tape-hold-stock',
  'tape-hold-piece',
  'tape-tall-stock',
  'through-needs-board',
  'board-too-small',
]);


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
  section: 'items' | 'voids' | 'target';
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
  const updateChamfer = useEngraveJobStore((s) => s.updateChamfer);
  const removeChamfer = useEngraveJobStore((s) => s.removeChamfer);
  const updateThread = useEngraveJobStore((s) => s.updateThread);
  const removeThread = useEngraveJobStore((s) => s.removeThread);
  const addPrimitive = useEngraveJobStore((s) => s.addPrimitive);
  const updatePrimitive = useEngraveJobStore((s) => s.updatePrimitive);
  const removePrimitive = useEngraveJobStore((s) => s.removePrimitive);
  const setTargetObject = useEngraveJobStore((s) => s.setTargetObject);
  const updateTargetObject = useEngraveJobStore((s) => s.updateTargetObject);
  const removeTargetObject = useEngraveJobStore((s) => s.removeTargetObject);
  const updateCutout = useEngraveJobStore((s) => s.updateCutout);
  const removeCutout = useEngraveJobStore((s) => s.removeCutout);
  const addKeepOut = useEngraveJobStore((s) => s.addKeepOut);
  const updateKeepOut = useEngraveJobStore((s) => s.updateKeepOut);
  const removeKeepOut = useEngraveJobStore((s) => s.removeKeepOut);
  const takeDesign = useEngraveJobStore((s) => s.takeDesign);
  const addVector = useEngraveJobStore((s) => s.addVector);
  const addLine = useEngraveJobStore((s) => s.addLine);
  const updateVector = useEngraveJobStore((s) => s.updateVector);
  const removeVector = useEngraveJobStore((s) => s.removeVector);
  const setTool = useEngraveJobStore((s) => s.setTool);
  const setVise = useEngraveJobStore((s) => s.setVise);
  const setMetalLineOverride = useEngraveJobStore((s) => s.setMetalLineOverride);
  // #572 — the double-confirm state for the cutter/material override affordance.
  const [confirmMetalOverride, setConfirmMetalOverride] = useState(false);
  // #573 — the guided flow replaced the panel while it owned the order. #689 deleted it: Cut is the
  // one flow now (Cut mode's four-step checklist), so there is no second screen to open.
  // #688 — the Design groups' open state is the PANEL's, so Generate's Fix can open the one a
  // blocker names (see `Group`). The defaults are the panel redesign's (§3.6): Job and Cutter
  // open, Hold closed.
  const [groupsOpen, setGroupsOpen] = useState<Record<string, boolean>>({});
  const groupProps = (testid: string, defaultOpen: boolean) => ({
    open: groupsOpen[testid] ?? defaultOpen,
    onOpenChange: (open: boolean): void => setGroupsOpen((m) => ({ ...m, [testid]: open })),
  });
  // #688 — a pressed Fix, applied after the commit that opens the group, fold or row it names:
  // an element inside a closed `<details>` cannot take focus, so focusing in the click handler
  // would silently land nowhere.
  const panelRef = useRef<HTMLDivElement>(null);
  const [fixRequest, setFixRequest] = useState<PanelFix | null>(null);
  function applyFix(fix: PanelFix): void {
    setGroupsOpen((m) => ({ ...m, [fix.group]: true }));
    if (fix.itemId !== undefined) expandEngraveRow(fix.itemId);
    // #725 B4 — the bed's clamp/arm refusals are fixed on Holding's picture, and a non-cylinder
    // rotary blank on the Stock step: open the step, not a field of this panel.
    if (fix.openWizardStep !== undefined) useStartWizardStore.getState().openWizard(fix.openWizardStep);
    // A fresh object each press: the same Fix pressed twice must run twice.
    setFixRequest({ ...fix });
  }
  useEffect(() => {
    const request = fixRequest;
    if (request === null) return;
    setFixRequest(null);
    // The wizard is its own modal over the panel: nothing behind it takes focus.
    if (request.openWizardStep !== undefined) return;
    const root = panelRef.current;
    if (root === null) return;
    if (request.openDetails !== undefined) {
      const fold = root.querySelector<HTMLDetailsElement>(`[data-testid="${request.openDetails}"]`);
      if (fold !== null) fold.open = true;
    }
    let target: HTMLElement | null = null;
    if (request.itemId !== undefined) {
      for (const row of Array.from(root.querySelectorAll<HTMLElement>('[data-item-id]'))) {
        if (row.getAttribute('data-item-id') !== request.itemId) continue;
        target =
          row.querySelector<HTMLElement>(
            '.engrave-item-row__body input, .engrave-item-row__body select, .engrave-item-row__body button',
          ) ?? row.querySelector<HTMLElement>('.engrave-item-row__expand');
        break;
      }
    } else if (request.focusTestid !== undefined) {
      const el = root.querySelector<HTMLElement>(`[data-testid="${request.focusTestid}"]`);
      if (el !== null) target = el.tagName === 'DETAILS' ? el.querySelector<HTMLElement>('summary') : el;
    }
    // A finding with no field of its own still lands on the list that states it.
    if (target === null) target = root.querySelector<HTMLElement>('[data-testid="engrave-findings"] summary');
    if (target !== null && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center' });
    }
    target?.focus();
  }, [fixRequest]);
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
  //
  // #725 B7 — the fallback judges a bed job with the bed's own through facts, read here as the run
  // store reads them (the worker cannot see the location). Without them a taped cut-out over the
  // wasteboard reads "reaches the vise" until the preview lands, and the blocker refuses it.
  const shopDefaults = useShopDefaultsStore((s) => s.defaults);
  // #730 — the record for THIS job's machine (its `machineId` is a profile id), not the house's
  // first machine: two machines give two beds.
  const locationView = useLocationStore((s) => s.location);
  const locationMachine = useMemo(() => machineForJob(locationView, job.machineId), [locationView, job.machineId]);
  const bedFacts = useMemo(
    () =>
      bedUnderFacts(locationMachine, shopDefaults, job.breakthrough + 1, {
        length: job.stock.length,
        width: job.stock.width,
      }),
    [locationMachine, shopDefaults, job.breakthrough],
  );
  const findings: JobFinding[] =
    preview?.findings ??
    dedupeFindings([
      ...validateJob(job, null, { bed: bedFacts, defaults: shopDefaults }),
      // #240 — the vise's own validator is the VISE's. A job in the rotary chuck has no jaw faces
      // or seat to judge; its holding findings are slice 3's rotary run sheet.
      ...(job.workholding.kind === 'vise'
        ? validateVise(job.stock, job.workholding.vise, job.sacrificial)
        : []),
    ]);
  const jobFindings = findings.filter((f) => f.labelId === undefined);
  const findingsFor = (labelId: string): JobFinding[] => findings.filter((f) => f.labelId === labelId);

  // #305 — the snapshot the resolver reads, so the list here and the tool everything else uses
  // can never come from two different places.
  const tools = useToolRegistry();
  const tool = jobTool(job);
  const toolEntry = tools.find((e) => e.key === job.toolKey) ?? null;
  const diameter = toolEntry ? cuttingDiameter(toolEntry.tool) : null;
  // #667 — THE REST PAIR, for the region rows' control. The engine's unit is the SETUP (its second
  // tool is the measured rest pass), so a row asks the setup that owns its item. The options are
  // the flat cutters smaller than the rough one: a region CAM's rest pass runs a flat bit, and a
  // V-bit rest is refused by the engine. The chip and the control's words are worded here so the
  // row renders data, not a second opinion about the registry.
  const setRestCutter = useEngraveJobStore((s) => s.setRestCutter);
  const setups = jobSetups(job);
  // #677 — THE CORE CLEARANCE, as a row states it: the setup that owns the item, its first cutter
  // a cone, and a FLAT end mill after it that owns no items of its own — the same pair the
  // generator turns into the ladder + the core pocket (a later cutter with assigned items keeps
  // #472's rest model). Null when the core would stand.
  const coreCutterFor = (itemId: string): string | null => {
    const setup = setups.find((s) => s.itemIds.includes(itemId));
    if (setup === undefined) return null;
    // The generator's own preconditions: a cone first, EXACTLY one later cutter, and that cutter
    // owning no items — anything else keeps #472's rest model and its refusal.
    if (setup.tools.length !== 2) return null;
    const firstKey = setup.tools[0];
    const first = firstKey === undefined ? null : (tools.find((e) => e.key === firstKey)?.tool ?? null);
    if (first === null || vCone(first) === null) return null;
    const laterKey = setup.tools[1];
    if (laterKey === undefined) return null;
    const later = tools.find((e) => e.key === laterKey)?.tool ?? null;
    if (later === null || later.shape !== 'flat') return null;
    if ((setup.toolItems?.[laterKey]?.length ?? 0) > 0) return null;
    return toolDisplayName(later);
  };
  const isVariableCarve = (itemId: string): boolean =>
    job.shapes.some((s) => s.id === itemId && s.enabled && !s.construction && s.vCarveDepth === 'variable');
  const restFor = (itemId: string): RestChoice | null => {
    const setupIndex = setups.findIndex((setup) => setup.itemIds.includes(itemId));
    if (setupIndex === -1) return null;
    const setup = setups[setupIndex]!;
    const roughEntry = setup.tools[0] === undefined ? null : (tools.find((e) => e.key === setup.tools[0]) ?? null);
    const roughTool = roughEntry?.tool ?? null;
    const roughDiameter = roughTool === null ? null : cuttingDiameter(roughTool);
    const restKey = setup.tools[1] ?? null;
    const restEntry = restKey === null ? null : (tools.find((e) => e.key === restKey) ?? null);
    const restDiameter = restEntry === null ? null : cuttingDiameter(restEntry.tool);
    const options = tools
      .filter((e) => {
        const d = cuttingDiameter(e.tool);
        if (d === null || d <= 0) return false;
        // A region CAM's rest pass is a flat cutter's; a V-bit rest is refused by the engine, and a
        // drill is not a region cutter at all.
        if (e.tool.shape !== 'flat') return false;
        return roughDiameter === null || d < roughDiameter;
      })
      .map((e) => ({ key: e.key, name: toolDisplayName(e.tool), diameter: cuttingDiameter(e.tool) as number }))
      .sort((a, b) => a.diameter - b.diameter);
    // #677 — a VARIABLE-depth shape under a cone with ONE later cutter: the second cutter is the
    // core clearance, not a rest pass, and the chip says which. The same precondition the
    // generator applies (`coreCutterFor` above): a later cutter owning items keeps #472's rest
    // model, so the chip must not promise a clearance that pair does not make.
    const laterKey = setup.tools[1];
    const coreClearance =
      isVariableCarve(itemId) &&
      setup.tools.length === 2 &&
      roughTool !== null &&
      vCone(roughTool) !== null &&
      (laterKey === undefined || (setup.toolItems?.[laterKey]?.length ?? 0) === 0);
    return {
      rough: roughTool === null ? null : { key: roughEntry!.key, name: toolDisplayName(roughTool), diameter: roughDiameter },
      roughIsV: roughTool !== null && vCone(roughTool) !== null,
      coreClearance,
      options,
      restKey,
      // A REST cutter only matters on a job whose setups are stated (the write materialises them);
      // the number lets a multi-setup job say which setup the row's choice belongs to.
      setupNumber: job.setups === undefined ? null : setupIndex + 1,
      chip:
        restEntry === null
          ? null
          : restDiameter === null
            ? `${coreClearance ? 'core' : 'rest'} ${toolDisplayName(restEntry.tool)}`
            : `${coreClearance ? 'core' : 'rest'} ⌀${Number(restDiameter.toFixed(3))} mm`,
      onPick: (key) => setRestCutter(itemId, key),
    };
  };
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
  // #665 — the variable V-carve's level pitch, from the same two row numbers the CAM uses
  // (`min(stepDown, stepOver / tanHalf)`); null until the feeds row and the cone are both known.
  const vCarvePitchMm =
    cone !== null && params !== null ? Math.min(params.stepDown, params.stepOver / cone.tanHalf) : null;
  const hasRegions = hasRegionItems(job);
  // #434 — A DRILL BIT IS A DRILL-ONLY CUTTER. One program has one tool, so the select offers the
  // registry's drills only when the job's cutting work is all drilled holes; the cutter already
  // selected stays listed so the select's value is always one of its options. A hand-edited job
  // that pairs a drill with other work is refused by `drill-mixed-tools`, not silently offered.
  const drillOnly =
    (job.drills ?? []).some((d) => d.enabled) &&
    !hasRegions &&
    !(job.traces ?? []).some((t) => t.enabled) &&
    !(job.threads ?? []).some((t) => t.enabled);
  const toolOptions = tools.filter((e) => e.tool.shape !== 'drill' || e.key === job.toolKey || drillOnly);
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
  // #435 — a cuttable primitive is a region the V-carve pockets too, so its colour-plane numbers
  // belong here beside the labels and shapes. The list is normalised to id/name/depth because a
  // primitive is not an `EngraveAnyItem` (it has no text and no `itemName` wording).
  const vCarveItems: { id: string; name: string; depth: number }[] = vCarveJob
    ? [
        ...job.labels.filter((i) => i.enabled).map((i) => ({ id: i.id, name: itemName(i), depth: i.depth })),
        ...job.shapes.filter((i) => i.enabled).map((i) => ({ id: i.id, name: itemName(i), depth: i.depth })),
        ...(job.combined ?? []).filter((i) => i.enabled).map((i) => ({ id: i.id, name: itemName(i), depth: i.depth })),
        ...(job.vectors ?? []).filter((i) => i.enabled).map((i) => ({ id: i.id, name: itemName(i), depth: i.depth })),
        ...(job.primitives ?? [])
          .filter((p) => p.enabled && primitiveReducesToRegion(p))
          .map((p) => ({ id: p.id, name: primitiveLabel(p), depth: p.depth })),
      ]
    : [];
  // #687 — the V-carve box used to sit between the cutter and the recommendation, where it read as
  // a second opinion about the pick. Its arithmetic is about ONE item's floor, so it lives in that
  // item row's Technical fold now. Same engine calls and same sentences; only the place moved.
  const vCarveFactById = new Map(vCarveItems.map((item) => [item.id, item]));
  const vCarveTechnical = (itemId: string): ReactNode => {
    const item = vCarveFactById.get(itemId);
    if (item === undefined || cone === null) return null;
    const plane = filmPending ? null : vCarvePlane(cone, item.depth, film);
    const stepover =
      plane === null ||
      vCarveRatio === null ||
      !Number.isFinite(vCarveRatio) ||
      vCarveRatio <= 0 ||
      vCarveRatio > 1
        ? null
        : vCarveStepover(plane.planeRadius, cone, vCarveRatio);
    return (
      <>
        <p style={{ ...MUTED, color: '#c8d3de' }} data-testid={`engrave-vcarve-depth-note-${item.id}`}>
          <b>V-carve.</b> The depth you type is the pocket floor; the design is correct at the{' '}
          <b>colour plane</b>
          {filmPending
            ? ' — resolving it from the print…'
            : film !== null
              ? `, ${fmt(film)} mm below the top, resolved from the print.`
              : ' — this blank states no film, so the plane is the floor.'}{' '}
          The tip is {fmt(cone.tipRadius * 2)} mm wide and its flank is{' '}
          {fmt(cone.halfAngleDeg)}° from the axis.
        </p>
        {plane !== null && (
          <p style={MUTED} data-testid={`engrave-vcarve-item-${item.id}`}>
            {item.name} at {fmt(item.depth)} mm: {fmt(plane.grooveWidth)} mm groove at the plane —
            floor {fmt(plane.floorInset)} mm narrower per side, top opening{' '}
            {fmt(plane.surfaceOutset)} mm wider per side;{' '}
            {stepover === null
              ? 'the pass pitch was not resolved for this job'
              : `pass pitch ${fmt(stepover.effective)} mm beside the requested ${fmt(stepover.requested)} mm`}
            {'.'}
          </p>
        )}
        {stepover !== null && stepover.clamped && (
          // The finding's own sentence, not a paraphrase: this is a note about a correct cut, and
          // the panel must not invent a second wording (or a second severity).
          <p
            style={{ ...MUTED, color: '#e0c07a' }}
            data-testid={`engrave-vcarve-clamp-${item.id}`}
          >
            {vCarveStepoverClampNote(item.name, stepover, cone.tipRadius)}
          </p>
        )}
      </>
    );
  };
  // Only the clamps (#317): an `ok: false` result carries `-refused` diagnostics, which the refusal
  // box below already states, and a `catalogue-ignored` is not the machine's doing at all.
  const clamps = feeds?.ok ? feeds.diagnostics.filter((d) => CLAMP_CODES.has(d.code)) : [];

  // #724 W4 — the ceiling is the BLANK's own: the stock thickness on a plate, but a rotary cut's
  // floor is a radius above the axis (9 mm on a ⌀20 rod, not 19 — 19 is past the centre), and a
  // tube's is its wall. The sentence says which number made it, so 9 never reads as a thickness.
  const maxDepth = blankDepthCeiling(job);
  const maxDepthWhy = (() => {
    const map = rotaryMapOf(job);
    if (map === null) return 'the stock thickness less the minimum floor';
    const wall = job.stock.wall;
    if (wall !== undefined && wall > 0 && wall < map.radius) {
      return `the tube’s ${fmt(wall)} mm wall less the minimum floor`;
    }
    return `the rod’s ${fmt(map.radius)} mm radius less the minimum floor`;
  })();
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
  // (`shopDefaults` is read above the findings fallback, which also needs it — #725 B7.)
  // #434 — the point this drill is planned with, and where its angle came from: the same reading
  // the CAM (`planDrillBit`) and the simulation take — the drill's own record, else the shop's
  // `drill.pointAngleDeg`, with that reading's source.
  const drillShop = drillSettings(shopDefaults ?? null);
  const drillPoint =
    tool !== null && tool.shape === 'drill'
      ? drillPointAngle(tool, { deg: drillShop.settings.pointAngleDeg, source: drillShop.sources.pointAngleDeg })
      : null;
  const drillDiameter = tool !== null && tool.shape === 'drill' ? cuttingDiameter(tool) : null;
  const drillTipLength =
    drillPoint?.ok === true && drillDiameter !== null ? pointLength(drillDiameter, drillPoint.deg) : null;
  // #668 — a bore row's helix pitch, resolved HERE from the same feeds row the CAM runs with and
  // the shop's own `bore.rampAngleDeg`, through the CAM's own `borePitchMm`. The row prints this
  // number; nothing on the screen computes a second pitch.
  const boreRamp = readDefault(shopDefaults ?? null, 'bore.rampAngleDeg');
  // #675 — a plunge drill's peck: the job's own number, or the source that binds — the shop's
  // `drill.peckDiameters × ⌀` for a drill bit, the feeds row's `peck` for a milling cutter. The
  // same two sources the CAM reads, so the row and the file cannot print different numbers.
  const peckFor = (drill: EngraveDrill): DrillPeckFacts | null => {
    if (drill.mode === 'bore' || tool === null) return null;
    const source =
      tool.shape === 'drill'
        ? (() => {
            const d = cuttingDiameter(tool);
            const x = drillShop.settings.peckDiameters;
            if (d === null || !(d > 0) || !(x > 0)) return null;
            const mm = d * x;
            return {
              mm,
              word: `${Number(x.toFixed(3))} × ⌀${Number(d.toFixed(3))} = ${Number(mm.toFixed(3))} mm (drill.peckDiameters: ${drillShop.sources.peckDiameters})`,
            };
          })()
        : params !== null && params.peck > 0
          ? { mm: params.peck, word: `the feeds row's peck (${Number(params.peck.toFixed(3))} mm)` }
          : null;
    if (source === null) return null;
    const typed = drill.peckMm !== undefined && drill.peckMm > 0;
    return { mm: typed ? (drill.peckMm as number) : source.mm, typed, source: source.word };
  };

  const borePitchFor = (drill: EngraveDrill): BorePitchFacts | null => {
    if (drill.mode !== 'bore' || drill.diameter === undefined || !(drill.diameter > 0)) return null;
    const cutter = tool === null ? null : cuttingDiameter(tool);
    if (cutter === null || !(cutter > 0) || params === null) return null;
    const centreRadius = drill.diameter / 2 - cutter / 2;
    if (!(centreRadius > 0)) return null;
    const rampAngleDeg = boreRampAngleFrom(boreRamp.value);
    return {
      pitchMm: borePitchMm(params.stepDown, centreRadius, rampAngleDeg),
      stepDownMm: params.stepDown,
      rampAngleDeg,
      rampSource: boreRamp.source,
      // The CAM spirals when the wall lap cannot reach the centre: a hole wider than twice the cutter.
      spirals: centreRadius > cutter / 2,
    };
  };
  const finish = finishOf(job);
  // #474/#493 — no plastic is faced (wood and metal only), so the material refuses it whatever the
  // finish says; the panel withholds the choice rather than merely seeding it off.
  const facingRefused = facingRefusal(job.stock.material) !== null;
  const facingDef = facingDefault(finish ?? 'unknown', job.stock.material);
  const facing = job.facing ?? null;
  const facingOn = facing?.enabled ?? false;
  // #432 review R9 — the aimed-for default is the MEASURED top's high-to-low spread plus the
  // shop's margin. Since #496 `stock.flatness` IS the measurement (nothing else writes it), and
  // `measuredTopSpreadMm` returns null on any plastic, so the wood/metal-only rule holds here too.
  const facingDepthFill = facingDepthDefault(finish ?? 'unknown', {
    probedSpreadMm: measuredTopSpreadMm(job),
    shop: facingShopFrom(shopDefaults),
  });
  const facingDepthReason =
    facing !== null && Math.abs(facing.depth - facingDepthFill.depthMm) < 1e-9
      ? sentenceCase(facingDepthFill.reason) + '.'
      : `Your number, not the ${fmt(facingDepthFill.depthMm)} filled in for this finish.`;
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

  // #271 route 1 and #280's twin used to hang a "use the project's badge / blank" button under the
  // stock fields. #686 moved both routes behind the wizard's stock step (`engrave-stock-edit`): the
  // main path is one stock line, and the sizes are the wizard's answers, not a field grid here.
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
  // #435 — the reference object's import. Like the design file, this needs the BYTES (the mesh is
  // parsed once and embedded), so it is a plain hidden input rather than the text-file picker.
  const targetInputRef = useRef<HTMLInputElement>(null);
  /** #662 — the Surface a mesh operation's own input: the file becomes the job's GOAL. */
  const goalInputRef = useRef<HTMLInputElement>(null);
  // The wizard asks for the goal import through `operationIntake` (it is a portal and cannot hold
  // this input). One listener while the panel is mounted, cleared with it.
  useEffect(() => {
    setOperationIntake((type) => {
      if (type === 'surface') goalInputRef.current?.click();
    });
    return () => setOperationIntake(null);
  }, []);
  const [targetImporting, setTargetImporting] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);

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
  /**
   * #435 — read a picked STL/3MF (or, #672, a PNG relief) as the target object. The parser, the
   * size guard, the hash and
   * the base64 embedding are all `readTargetObjectFile`'s; this only places the result: centred in
   * X/Y with its TOP on the stock's top face (Z0), which is where a reference part sits when it is
   * being used to lay out pockets.
   */
  async function readTarget(file: File, role: 'reference' | 'goal' = 'reference'): Promise<void> {
    setTargetError(null);
    setTargetImporting(true);
    try {
      // #672 — a PICTURE has no physical size: the import fits it onto the blank (aspect kept),
      // and a picture is always the shape to MAKE — a tone map is not something to position
      // against, so the role is the goal whatever the door.
      const isPng = /\.png$/i.test(file.name);
      const result = await readTargetObjectFile(
        file,
        newTargetObjectId(),
        isPng
          ? { fit: { maxWidth: Math.max(1, job.stock.length - 4), maxHeight: Math.max(1, job.stock.width - 4) } }
          : {},
      );
      if (!result.ok) {
        setTargetError(result.error);
        return;
      }
      setTargetObject({
        id: result.id,
        name: result.name,
        format: result.format,
        sha256: result.sha256,
        data: result.data,
        size: result.size,
        position: { x: job.stock.length / 2, y: job.stock.width / 2, z: 0 },
        rotation: 0,
        enabled: true,
        // #662 — the Surface a mesh operation: a goal is the shape to MAKE (the engine roughs and
        // ball-finishes it), where a reference is only something to position against.
        ...(role === 'goal' || isPng ? { role: 'goal' as const } : {}),
      });
      // A new object arrives open, like every other add: its placement is the field the import
      // could not settle.
      expandEngraveRow(result.id);
    } catch (e) {
      setTargetError(e instanceof Error ? e.message : String(e));
    } finally {
      setTargetImporting(false);
    }
  }

  /**
   * #662 — what a pick in the operation picker does. Every type but one is a store action; Surface
   * a mesh opens the goal file input, because a mesh is a file and the role is what makes it an
   * operation. A new operation arrives open: it is a default until its fields are set.
   */
  function addOperation(type: OperationTypeId): void {
    if (type === 'surface') {
      goalInputRef.current?.click();
      return;
    }
    expandEngraveRow(addOperationOfType(type));
  }

  /**
   * #685 — what a FOLDED option does. The old second vocabulary's kinds were always one of these
   * operations, so each still makes exactly the item it always made, and arrives open (#411).
   */
  function addFolded(option: OperationOptionDef): void {
    const id = option.id;
    if (id === 'line' || id === 'stroke-label') {
      expandEngraveRow(addTrace(id));
      return;
    }
    if (id === 'circle' || id === 'slot' || id === 'polygon') {
      expandEngraveRow(addShape(id));
      return;
    }
    if (id === 'border' || id === 'frame' || id === 'cutaway') {
      const made = addCombined(id);
      if (made !== null) expandEngraveRow(made);
      return;
    }
    if (id === 'drill-array') {
      expandEngraveRow(addDrill('drill-array'));
      return;
    }
    // box | cylinder | cone | sphere
    expandEngraveRow(addPrimitive(id));
  }

  const errors = findings.filter((f) => f.severity === 'error');
  /**
   * #688 — WHAT DISABLES GENERATE, SAID AT GENERATE (design §1 principle 4). The old code folded
   * two unrelated causes into one `blocked` flag and one tooltip, "Fix the errors above first." —
   * which was seen beside a findings line reading "1 warning · 0 errors" (the reproduced PLA +
   * V/chamfer dead end, audit B9). A blocking FINDING is named by its own sentence; a feeds
   * refusal is named by its own, with the cutter or the override fold as its Fix.
   *
   * Findings come first: they are errors ON the job, and no cutter choice can resolve one. The
   * feeds half distinguishes its causes — "no feeds … choose a flat end mill" is only true for a
   * missing row, never for a refused override or a cutter no CAM here can use.
   */
  const generateBlocker: GenerateBlocker | null = (() => {
    const finding = errors[0];
    if (finding !== undefined) {
      return { sentence: sentenceCase(finding.message), fix: findingFix(finding) };
    }
    if (feeds === null || feeds.ok || tool === null) return null;
    if (feeds.cause === 'values') {
      return {
        sentence: sentenceCase(feeds.reason),
        fix: { group: 'engrave-group-cutter', openDetails: 'engrave-override', focusTestid: 'engrave-override' },
      };
    }
    if (feeds.cause === 'cutter') {
      return {
        sentence: `${toolDisplayName(tool)} cannot cut this job — choose another cutter`,
        fix: { group: 'engrave-group-cutter', focusTestid: 'engrave-tool' },
      };
    }
    const material = MATERIAL_LABELS[job.stock.material];
    // The mockup's sentence (§3.6). A flat end mill is the alternative only when the job is not
    // already holding one — telling an operator to choose what they already chose is not a fix.
    const alternative = tool.shape === 'flat' ? '' : ' — choose a flat end mill';
    return {
      sentence: `No feeds for the ${toolDisplayName(tool)} on ${material}${alternative}`,
      fix: { group: 'engrave-group-cutter', focusTestid: 'engrave-tool' },
    };
  })();
  const blocked = generateBlocker !== null;

  // #673 — THE INLAY HALF: the derived plug numbers (null when they do not derive) and the action
  // that saves the MALE blank as its own job. The action is offered only when the female's job has
  // no blocking finding — a male built from a job that cannot cut would be a second broken job.
  const saveMaleInlay = async (): Promise<void> => {
    if (tool === null) return;
    const inlayCone = vCone(tool);
    if (inlayCone === null) return;
    const result = inlayMaleJob(job, inlayCone);
    if (!result.ok) return;
    const parsed = parseEngraveJob(result.job);
    await saveJobFileText(
      JSON.stringify(parsed.ok ? parsed.job : result.job, null, 2),
      jobFileName(inlayMaleJobName(job.name)),
    );
  };
  const inlayFor = (
    shape: EngraveShape,
  ): { numbers: InlayNumbers | null; onSaveMale: (() => void) | null } | undefined => {
    if (shape.inlay === undefined || shape.inlay.role !== 'female') return undefined;
    const check = cone === null ? null : inlayNumbers(cone, shape.depth, inlayGlueGap(shape.inlay));
    const numbers = check !== null && check.ok ? check.numbers : null;
    return {
      numbers,
      onSaveMale:
        numbers === null || blocked
          ? null
          : () => {
              void saveMaleInlay();
            },
    };
  };

  // #670 — THE TEXTURE: the numbers the CAM runs with and the strokes they derive, from the same
  // module the plan calls. Derived once per shape edit, not per render of every row.
  const textureById = useMemo(() => {
    const map = new Map<string, { numbers: TextureNumbers; strokes: number; capped: boolean }>();
    for (const shape of job.shapes) {
      if (shape.texture === undefined) continue;
      const numbers = textureNumbers(shape.texture, shape.depth);
      const derived = textureStrokes(shape, numbers);
      map.set(shape.id, { numbers, strokes: derived.paths.length, capped: derived.capped });
    }
    return map;
  }, [job.shapes]);
  const textureFor = (
    shape: EngraveShape,
  ): { numbers: TextureNumbers; strokes: number; capped: boolean } | undefined =>
    shape.texture === undefined ? undefined : textureById.get(shape.id);
  // #674 — a prism's derived numbers, from the same `prismNumbers` the plan, the finding and the
  // sheet read. Cheap arithmetic, so no memo.
  const prismFor = (shape: EngraveShape): PrismCheck | undefined =>
    shape.prism === undefined ? undefined : prismNumbers(cone, shape.depth, shape.prism);

  const rec = preview?.recommendation ?? null;
  const recPick = rec?.key ? rec.candidates.find((c) => c.key === rec.key) ?? null : null;
  const recPickEntry = recPick === null ? null : (tools.find((e) => e.key === recPick.key) ?? null);
  // #687 — the pick is NAMED by the one display form. A candidate the registry no longer holds
  // (an older preview) falls back to its diameter and no kind, never to a vendor string.
  const recPickDisplay =
    recPickEntry !== null
      ? toolDisplay(recPickEntry.tool)
      : recPick === null
        ? null
        : { name: `⌀ ${fmt(recPick.diameter)} mm cutter`, metal: false };
  // #687 — "applied" is a fact about the job, not about the preview: the job's cutter is the pick.
  // `Use it` exists only when that is false, so it never offers to change nothing.
  const recPickApplied = recPick !== null && rec !== null && rec.key !== null && rec.key === job.toolKey;
  // #687 — only the rejections the operator can act on get a line (see `isActionableRejection`).
  const actionableRejections = rec?.candidates.filter(isActionableRejection) ?? [];
  // #699 — the catalogue rows are one sentence when there are many of them, not a wall of
  // near-identical ones; one or two keep their own row and their catalogue sentence.
  const rejectionGroups = groupRejections(rec?.candidates ?? []);
  const catalogueRowsGrouped = shouldGroupCatalogueRows(rejectionGroups.noCatalogueRow.length);
  const whySummary = `Why? — ${actionableRejections.length} cutter${actionableRejections.length === 1 ? '' : 's'} rejected`;

  // #516 — the tool is the software's recommendation once the work is defined. When the preview
  // has a pick and the operator has not chosen a cutter, the job follows it (source 'computed');
  // a user-chosen or measured tool is left alone, so the recommender cannot silently replace a
  // decision the operator made.
  useEffect(() => {
    const key = rec?.key ?? null;
    if (key === null) return;
    const source = job.sources?.tool;
    if (source === 'user' || source === 'measured') return;
    // #516 item 5 — the first recommendation lands on the first edit or Generate, not on load: a
    // clean (just-opened or just-saved) tool-less document keeps its empty key, so opening a saved
    // job does not immediately dirty it.
    if (job.toolKey === '' && !useEngraveJobFileStore.getState().dirty) return;
    if (job.toolKey !== key) setTool(key, 'computed');
  }, [rec?.key, job.sources?.tool, job.toolKey, setTool]);

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
  // #425 — the document owns the package block. Prefer what the store hands back (on #425's branch
  // that reads the open document, and a fresh freeze lands there first), and fall back to a block a
  // loaded v3 document already carries. Both are the same `FrozenPackage` shape.
  const storedPackage = useEngravePackageStore((s) => s.packages.find((p) => p.jobId === job.id) ?? null);
  const jobPackage = storedPackage ?? job.package ?? null;
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
            // #581 — the hub names the input that moved instead of "the job or the machine frame".
            staleReason: run.staleReason,
            package: jobPackage,
            calibration,
            shelfItem,
            // No honest reachability table is available synchronously in this slice — the preview
            // holds a recommendation, not the measured table. Null leaves `recommendTool`'s verdict
            // unstated rather than guessing it, so `no-cutter` stays unwired here.
            reach: null,
            // #735 — the same bed facts the Design fallback reads (#725 B7): the gate's through-cut
            // owner must judge a taped job by the bed it is taped to, not in the pre-#712 vise words.
            bed: bedFacts,
          })
        : null,
    [mode, job, run.generated, run.staleSince, run.staleReason, jobPackage, calibration, shelfItem, bedFacts],
  );

  const backToDesign = (cause: PreflightCause | null): void => {
    // §5.6's "Back to Design" lands on the row the owner named (through #411's expand seam), then
    // leaves Cut. `hubTarget` is still the unresolved placeholder, so there is no scroll yet; a
    // cause naming no item (a run-policy row, say) simply returns to the form.
    if (cause?.labelId !== undefined) expandEngraveRow(cause.labelId);
    showMode('design');
  };

  // #681 — the setup is a step of the ONE cutting-job wizard. Stock and Hold re-open it at their
  // own step, with the shell's one counter; there is no second modal in the panel.
  const openWizard = useStartWizardStore((s) => s.openWizard);
  // The run sheet is built on demand from the current job and the last generated result, and
  // shown as an overlay (#207). A stale result is not offered: the sheet would describe a job the
  // user has since changed.
  const [sheet, setSheet] = useState<RunSheet | null>(null);
  // #277 — the last measured run of THIS job's program, out of the record files this browser has
  // been handed (the panel's own "Open run record…", plus whatever the readback committed).
  const importedRecords = useRunRecordStore((s) => s.imported);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const lastMeasured = lastTimedRun(job.name, allRuns(importedRecords));
  // #535 — a surface program has no verifier report; its run sheet is gated on the program itself
  // (the sheet prints the surface facts and the engine's notes for it).
  const runSheetReady =
    run.generated !== null &&
    (run.generated.verify !== null || run.generated.surface3d != null) &&
    run.generated.nc !== null;
  const runSheetBlocked = run.staleSince !== null;

  async function openRunSheet(): Promise<void> {
    const generated = useEngraveRunStore.getState().generated;
    if (!generated || (!generated.verify && generated.surface3d == null) || generated.nc === null) return;
    // `buildRunSheet` typesets every label to lay out the origin diagram, and `resolveFont`
    // throws unless the bundled faces are already parsed (#180). The sim worker loads them, but
    // that cache is per-realm — the main thread must load the job's faces itself first, exactly
    // as `JobScheduler` does before its compile.
    await ensureLabelFontsLoaded(job.labels, job.customFonts ?? []);
    // #475 — the cut-extent measurement from THIS job's registration on THIS machine, if one has
    // run. Handing the readings in makes the origin section print the measured spread and the
    // landing range (or the refusal) instead of only the plan; no measurement means the sheet keeps
    // its plan-and-stop-rule wording.
    const measuredMachine = useMachineStore.getState().machine;
    const measuredSpread =
      measuredMachine === null
        ? null
        : surfaceSpreadFor(job.id, { host: measuredMachine.host, port: measuredMachine.port });
    // #604 — the found position from the registration, and the probe/mount the header names.
    const foundReg =
      measuredMachine === null
        ? null
        : firstRegistrationFor(job.id, { host: measuredMachine.host, port: measuredMachine.port });
    const machineRecord = machineRecordByProfile(job.machineId);
    const probeName = probeNameFor(machineRecord);
    const mountName = mountNameFor(machineRecord, job.workholding.kind);
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
        // #475 — a measured run hands its own touch count and readings in; with none, the sheet
        // plans the touches from the shop's `registration.surfaceTouchCount`, resolved by the same
        // reader the registration planner uses (the labelled fallback is the seed, 5).
        // #491 — the chosen copy's case, or both when the pick is indifferent; null leaves the
        // colourless sentence. Read here from the registry's copy pool (this thread), never in the
        // pure sheet module.
        {
          // A measurement was taken with the APPROVED plan's count; taking the shop's current
          // number here could build a different plan and silently drop the readings.
          // #596 — the machine's name on paper is the nickname the person gave it, else the profile.
          machineName:
            machineDisplayName(machineRecordByProfile(job.machineId), jobMachine(job)) ?? undefined,
          probeName: probeName ?? undefined,
          mountName,
          found:
            foundReg === null
              ? undefined
              : { offset: foundReg.outcome.offset, rotationDeg: foundReg.outcome.rotationDeg },
          surfaceTouchCount:
            measuredSpread?.assessment.plan.touches.length ??
            registrationSettings(shopDefaults).settings.surfaceTouchCount,
          surfaceReadings: measuredSpread?.assessment.touches,
          // #501 — the console G32 recipe's shape, when this run measured a tilt: the cutter's
          // radius (the grid grows by it), the APPROVED plan's own probe clearance where there is
          // one (else the shop's), and the shop's grid points.
          surfaceLevel: (() => {
            const cutter = jobTool(job);
            const diameter = cutter === null ? null : cuttingDiameter(cutter);
            if (diameter === null) return undefined;
            const approved = job.setups?.[0]?.registration?.plan.settings.parkAboveSurfaceMm;
            return {
              toolRadiusMm: diameter / 2,
              clearanceMm: approved ?? registrationSettings(shopDefaults).settings.parkAboveSurfaceMm,
              points: shopDefault('plan.autoLevelPoints').value,
            };
          })(),
          toolCase: caseWordsForKey(job.toolKey) ?? undefined,
          // #472 — the two-tool facts the generator measured, so the sheet's second-program section
          // prints the files and numbers this run actually produced rather than re-deriving them.
          restPass: generated.restPass ?? undefined,
          // #451 — the shop's `runSheet.blankToleranceMm`: how far a measured blank may differ
          // before the sheet says "change the job and regenerate".
          blankToleranceMm: shopDefault('runSheet.blankToleranceMm').value,
        },
      ),
    );
  }

  const verifyFindings = run.generated?.verify?.findings ?? [];
  const verifyErrors = verifyFindings.filter((f) => f.severity === 'error').length;
  const simErrors = run.simDiagnostics.filter((d) => d.severity === 'error').length;
  const runErrors = runErrorCodes(run);
  // #724 B2 — the row names the FIRST error in its own words (with its move or line where it has
  // one); the count alone told the operator that something was wrong and nothing about what.
  const firstRunErrorText = firstRunError(run)?.message ?? null;
  // #725 B4 — the SAME first error carries its Fix, at the button (#688's rule), so a
  // generation-time refusal reaches the operator exactly as a document finding does. Only while
  // the run is CURRENT (`staleSince` null): an edit re-opens Generate, and the new run's verdict
  // replaces this one. `firstRunError` (#724 B2) is the one owner of "which error".
  const currentRunError = run.staleSince === null ? firstRunError(run) : null;
  const runFix: PanelFix | null = currentRunError === null ? null : findingFix(currentRunError);
  // #688 — Save writes the .nc that goes to Makera Studio: a path to the machine, so it waits on
  // the clearance acknowledgement exactly as Upload and Release do. The statement's home is Cut
  // step 1 (#689); the sentence names it and the Fix beside Save takes the operator there.
  //
  // #240/#545 — the gates also read the machine's rotary provenance and the job's holding, so a
  // rotary job's .nc save is refused until the module is measured (the .cutjob document save never
  // passes through here). One view for all three, so they cannot disagree about the machine.
  const gateView = gateViewFor(run, jobMachine(job, calibration), job.workholding.kind === 'rotary-chuck');
  const saveBlockerText = saveBlocker(gateView);
  // #255 — the machine upload. `uploadBlocker` is never weaker than `saveBlocker` (see its own
  // note), so Save and Upload state one rule between them rather than two that agree by luck.
  const uploadBlockerText = uploadBlocker(gateView);
  // #469 / #419 §3 — the Cut surface owns the run controls. It plays the FROZEN list: more than
  // one program goes through the release step, one program through the single-file upload. Both
  // gates are computed here, against the live run view, and handed down so the panel and the
  // surface cannot state two different rules.
  const releaseBlockerText = releaseBlocker(gateView);
  const machine = useMachineStore((s) => s.machine);
  const noteLiveStatus = useMachineStore((s) => s.noteLiveStatus);
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

  // #688 — the four ticks replace the two long paragraphs and the oracle numbers that used to sit
  // here (audit B14). Those facts — what the sweep checked and did not, and the under/over-cut
  // numbers — are the simulation's own and move to its panel (#691); the data they need is already
  // in the run view (`simDiagnostics`, `oracle`, `generated.verify`, `pathOnly`) and the pure
  // `coverageDisclaimer`/`oracleSentence` builders, so no second source is introduced here.
  const rowToolpath: RowState = cam ? 'tick' : run.phase === 'generating' ? 'pending' : run.generated ? 'cross' : 'idle';
  const rowToolpathText =
    rowToolpath === 'tick'
      ? 'generated'
      : rowToolpath === 'pending'
        ? 'generating…'
        : rowToolpath === 'cross'
          ? 'not generated'
          : 'not generated yet';

  // #726 W16 — a SURFACE program has no 2.5D verifier report by design (`verify: null`; its check
  // is the material sweep, #535). The row read "not verified yet" after a good run; it now states
  // the check that was made, at the step where it is made (the sweep runs with the simulation).
  // A pure GOAL run: its `verify` is null by design and its check is the material sweep (#535),
  // which the result records as `surface3d`.
  const surfaceProgram = run.generated !== null && run.generated.verify === null && run.generated.surface3d != null;
  const rowVerified: RowState = surfaceProgram
    ? run.simStatus === 'ready'
      ? simErrors > 0
        ? 'cross'
        : 'tick'
      : run.phase === 'simulating'
        ? 'pending'
        : 'idle'
    : run.generated?.verify
      ? verifyErrors > 0
        ? 'cross'
        : 'tick'
      : run.phase === 'generating'
        ? 'pending'
        : 'idle';
  const rowVerifiedText =
    rowVerified === 'tick'
      ? surfaceProgram
        ? 'checked on the simulation’s grid'
        : 'verified'
      : rowVerified === 'cross'
        ? surfaceProgram
          ? 'the sweep found errors'
          : 'verification found errors'
        : rowVerified === 'pending'
          ? surfaceProgram
            ? 'checking on the sweep…'
            : 'verifying…'
          : surfaceProgram
            ? 'not checked yet'
            : 'not verified yet';

  const rowSimulated: RowState =
    run.simStatus === 'ready' ? (simErrors > 0 ? 'cross' : 'tick') : run.phase === 'simulating' ? 'pending' : run.simStatus ? 'cross' : 'idle';
  const rowSimulatedText =
    rowSimulated === 'tick'
      ? 'simulated'
      : rowSimulated === 'cross'
        ? 'the simulation did not pass'
        : rowSimulated === 'pending'
          ? 'simulating…'
          : 'not simulated yet';

  const rowOracle: RowState = run.oracle ? (run.oracle.ok ? 'tick' : 'cross') : run.phase === 'checking' ? 'pending' : 'idle';
  const rowOracleText =
    rowOracle === 'tick'
      ? 'matches the design'
      : rowOracle === 'cross'
        ? 'does not match the design'
        : rowOracle === 'pending'
          ? 'checking against the design…'
          : 'not checked against the design yet';

  /**
   * #688 — ONE labelled time (audit B15). The Generate row used to say "~2:16" while the simulator
   * said "3:40"; this is the program's own estimate, the same number the run sheet prints, and it
   * says in words that it is an estimate.
   */
  // #726 P7 — "about" is the estimate word; "(estimated)" said it a second time on every time.
  const runTimeText = cam === null ? null : `about ${formatDuration(cam.estimatedSeconds)}`;

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
          '. The program can still be run, but the top will not be skimmed — clear the reason and generate again.'
        : facingCam !== null
          ? `${facingCam.toolName}, ⌀ ${fmt(facingCam.diameterMm)} mm flat, ${facingCam.passes} × ${fmt(facingCam.stepDown)} mm passes`
          : `${run.generated.facingToolKey ?? 'its own cutter'}`
  }`;

  async function generate(): Promise<void> {
    // #516 item 5 — the first Generate recommends the cutter for a tool-less job, so one press both
    // picks the tool and builds the program (the sacrificial swatch reads the sim scene it loads).
    // A tool the operator chose or measured is left alone.
    const source = job.sources?.tool;
    if (job.toolKey === '' && source !== 'user' && source !== 'measured') {
      const key = rec?.key ?? (await awaitPreviewRecommendationKey());
      if (key) setTool(key, 'computed');
    }
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
    // #240 — a rotary job has no vise answers to save.
    if (job.workholding.kind !== 'vise') return;
    setVise(source === 'default' ? {} : { source });
    // Keep the measured numbers for the next job too ("Save as my vise", #203).
    useSettingsStore.getState().setVise(jobVise(useEngraveJobStore.getState().job));
  }

  // ---- sacrificial material (#213) ---------------------------------------------------------

  const sac = job.sacrificial;
  const under = sac.under;

  // #240 — the Hold card reads the vise the job HOLDS: for a rotary job that is the neutral seat
  // this slice's flat preview uses (`jobVise`), and the chuck's own facts when the rotary is the
  // holding. `setVise` does not write a rotary job, so its fields are not offered there.
  const vise = jobVise(job);
  const rotaryRod =
    job.workholding.kind === 'rotary-chuck'
      ? { diameter: job.stock.diameter ?? job.stock.width, length: job.stock.length }
      : null;
  // #725 W1 — a BED job's Hold line is its mount's, not the vise's (§3.7): taped or the bracket,
  // with the surface under it and the mount's own numbers. `null` for the vise and rotary, whose
  // lines are below.
  const bedLine = bedHoldLine(job, activeProfileOf(locationMachine), shopDefaults);

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

  /**
   * The dialog's accepted (possibly rescaled) outline becomes job items centred on the stock: the
   * closed shapes as one vector region, and #664 every OPEN path as an Engrave (line) operation.
   * The paths share the import's centred frame, so the same position/rotation keeps a file's
   * strokes on its fills. A lines-only file is one or more rows and no shape.
   */
  function acceptOutline(outline: OutlineImport): void {
    const position = { x: job.stock.length / 2, y: job.stock.width / 2 };
    // #451/#492 — the same starting depth the store's own "Add…" entries use, read from the one
    // stock-aware reader so an imported outline and a drawn shape cannot begin at different
    // numbers, and a laminate's field arrives at its cap + margin.
    const depth = newItemDepthFor(job);
    let firstId: string | null =
      outline.contours.length > 0
        ? addVector(
            toVectorShape(outline, {
              id: newEngraveShapeId(),
              position,
              depth,
              name: outline.sourceName,
            }),
          )
        : null;
    const lines = toLineTraces(outline, {
      idFor: () => newEngraveTraceId(),
      position,
      depth,
      name: outline.sourceName,
    });
    for (const line of lines) {
      addLine(line);
      firstId ??= line.id;
    }
    // #411 — like every other add, it arrives open: an imported outline's placement and depth are
    // exactly what the import dialog could not settle. Several imported lines open the first only.
    if (firstId !== null) expandEngraveRow(firstId);
    closeImport();
  }

  // ---- item naming (labels, shapes and combined shapes are one list downstream, #214/#215) ---

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
  const cutoutCount = job.cutouts?.length ?? 0;
  const vectorCount = job.vectors?.length ?? 0;
  const primitiveCount = job.primitives?.length ?? 0;
  const chamferCount = job.chamfers?.length ?? 0;
  // #726 W16 — a GOAL mesh is the job's work ("Surface a mesh" is an operation): it counted as 0
  // items beside "Target object (1)", so the job read as empty while it had a whole 3D program.
  const goalCount = job.targetObject?.enabled === true && (job.targetObject.role ?? 'reference') === 'goal' ? 1 : 0;
  const itemTotal =
    goalCount +
    job.labels.length +
    job.shapes.length +
    combinedCount +
    traceCount +
    drillCount +
    threadCount +
    primitiveCount +
    cutoutCount +
    vectorCount +
    chamferCount;
  // #686 — the Job group's ONE stock line, and the provenance facts that moved off the inline
  // fields (design §2): the line's hover and the Cutter group's Technical fold.
  /** §4's word for the stock's form, lowercase mid-sentence: plate · block · sheet · printed blank. */
  // #724 W3 — the form word comes from the STOCK when it is round: a rod in the chuck's box has
  // its own facts (`shape: 'cylinder'`, its diameter), and the stock entry may be absent. A tube
  // states a wall; anything else keeps the entry's word (or a plate's, with no entry).
  const stockFormWord =
    job.stock.shape === 'cylinder'
      ? job.stock.wall !== undefined && job.stock.wall > 0
        ? 'tube'
        : 'rod'
      : formLabel(job.stockEntry?.form ?? 'plate').toLowerCase();
  // #726 P3 — a ROUND job (a rod or disc in the chuck) has no flat bottom face to pocket and no
  // bed to surface a mesh on. The Voids and Target object rows are not offered for it; a job that
  // already carries one still draws its row, so it can be taken away.
  const roundStock = job.stock.shape === 'cylinder';
  const STOCK_FIELD_WORD: Record<string, string> = {
    length: 'length',
    width: 'width',
    thickness: 'thickness',
    material: 'material',
  };
  const stockSources = job.sources?.stock ?? {};
  const stockProvenance = (() => {
    const words = Object.entries(STOCK_FIELD_WORD).flatMap(([key, word]) => {
      const src = (stockSources as Record<string, FieldSource | undefined>)[key];
      return src === undefined ? [] : [`${word} ${SOURCE_LABEL[src]}`];
    });
    return words.length === 0 ? 'The stock is stated in the wizard’s step 2.' : `Stock — ${words.join(' · ')}.`;
  })();
  // #686, design §2 — a typed value's provenance is not a chip beside it (audit D2): the fields the
  // operator typed are named in ONE sentence in the Cutter group's Technical fold.
  const typedByUser: string[] = [];
  for (const [key, word] of Object.entries(STOCK_FIELD_WORD)) {
    if ((stockSources as Record<string, FieldSource | undefined>)[key] === 'user') typedByUser.push(`stock ${word}`);
  }
  if (job.sources?.tool === 'user') typedByUser.push('the cutter');
  const CUT_FIELD_WORD: Record<string, string> = {
    rpm: 'spindle speed',
    feed: 'feed',
    plungeFeed: 'plunge feed',
    stepDown: 'step-down',
    stepOver: 'step-over',
  };
  for (const [key, word] of Object.entries(CUT_FIELD_WORD)) {
    if ((job.sources?.cut as Record<string, FieldSource | undefined> | undefined)?.[key] === 'user') {
      typedByUser.push(word);
    }
  }
  const target = job.targetObject ?? null;
  // #672 — a picture goal's pixel size, decoded once per image (the document stores the bytes and
  // the two numbers; the pixels are derived here for the row's resolution sentence).
  const reliefPixels = useMemo(() => {
    // #720 — the bytes may be absent (the mesh store lost them, or a reload has not re-attached
    // them yet): nothing to decode, and the job's finding says what to do about it.
    if (target === null || target.format !== 'png' || target.data === undefined) return null;
    try {
      const decoded = decodePng(new Uint8Array(base64ToArrayBuffer(target.data)));
      return decoded.ok ? { width: decoded.image.width, height: decoded.image.height } : null;
    } catch {
      return null;
    }
  }, [target === null ? null : target.format, target === null ? null : target.sha256]);
  const reliefFacts =
    target !== null && target.format === 'png'
      ? (() => {
          const numbers = reliefNumbers(target.relief);
          return {
            pixels: reliefPixels,
            depth: { value: numbers.maxDepthMm, source: numbers.depthSource },
            typed: target.relief?.maxDepthMm !== undefined,
            invert: numbers.invert,
            gridPitch: shopDefault('sim.columnFlatPitchYMm'),
            cutterDiameter: tool === null ? null : cuttingDiameter(tool),
          };
        })()
      : null;
  const hasReferenceable = job.labels.length + job.shapes.length + combinedCount + vectorCount > 0;
  // #218 — the `of` picker's choices. The words are the item list's own (`itemRowName` /
  // `itemKindWord`), so the row and the list cannot name the same item differently.
  const cutoutTargets: CutoutTarget[] = allItems(job).map((it) => {
    const name = itemRowName(it);
    return { id: it.id, label: name === '' ? itemKindWord(it) : `${itemKindWord(it)} “${name}”` };
  });
  // #669 — the rims a chamfer can follow: every item whose own profile is a closed edge — a
  // shape, an imported outline or a combined shape (a construction item is a part's outline just
  // as much as a cut one). The item list's own words, so a row and a finding name the same edge
  // the same way.
  const chamferRims: ChamferRimOption[] = [...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])]
    .filter((it) => it.enabled)
    .map((it) => {
      const name = itemRowName(it);
      return { id: it.id, label: name === '' ? itemKindWord(it) : `${itemKindWord(it)} “${name}”` };
    });
  /** A rim the row NAMES but the picker does not hold: say which kind of dead end it is. */
  const chamferRimIssue = (chamfer: EngraveChamfer): string | null => {
    if (chamfer.of === undefined || chamferRims.some((r) => r.id === chamfer.of)) return null;
    const known = [...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])].some(
      (it) => it.id === chamfer.of,
    );
    return known ? 'disabled' : 'not in the job';
  };
  // #669 — the chamfer row's derived numbers come from the job's own cutter: the cone's angle and
  // its reach (`vFluteLength · tan`), the same arithmetic the finding and the CAM use.
  const chamferCone = tool === null ? null : vCone(tool);
  const chamferFlute = tool === null ? null : vFluteLength(tool);
  const chamferFacts: ChamferFacts = {
    cutterName: tool === null ? null : toolDisplayName(tool),
    halfAngleDeg: chamferCone === null ? null : chamferCone.halfAngleDeg,
    reachMm:
      chamferCone === null || chamferFlute === null ? null : chamferFlute * chamferCone.tanHalf,
    tipDiameterMm: chamferCone === null ? null : chamferCone.tipRadius * 2,
    tipSource:
      chamferCone === null || tool === null ? null : tool.tipDiameter !== null ? 'stated' : 'point, by kind',
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
        value={shownNumber(jobVise(job)[key])}
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
        title="Click to mark this value as a bench measurement, or back to typed."
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
    <div className="panel-stack" data-testid="engrave-panel" ref={panelRef}>
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
      {/* #686 — ONE file bar (design §1): the job's name, its saved time, the dirty marker and a
          `File ▾` menu. The `.3mf` design read (#410) is the menu's fourth item, so it keeps its
          testid and its way in without a second headline button. */}
      <EngraveJobFileBar
        onReadDesign={featureSim ? () => designInputRef.current?.click() : undefined}
        designReading={designReading}
      />
      {featureSim && (
        <>
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

      <Group
        testid="engrave-group-job"
        title="Job"
        summary={`${itemTotal} item${itemTotal === 1 ? '' : 's'}`}
        {...groupProps('engrave-group-job', true)}
      >
      {/* 1 — stock, as ONE line (#686, design §2). The wizard's step 2 states the stock; the panel
          reads it here. The inline fields, their size rows and the blank notes are gone, and the
          badge / bare-blank headline routes are the door's starters now (#680). */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          data-testid="engrave-stock-line"
          title={stockProvenance}
          style={{ fontSize: 12, color: '#d1d5db' }}
        >
          <span style={MUTED}>Stock</span> · {stockFormWord} {stockSizeWords(job.stock)} ·{' '}
          {MATERIAL_LABELS[job.stock.material]}
        </span>
        <button
          type="button"
          data-testid="engrave-stock-edit"
          style={{ ...MUTED, margin: 0, padding: '1px 6px', cursor: 'pointer', marginLeft: 'auto' }}
          title="Open the cutting-job wizard at step 2 and state the stock — the same wizard, the same counter."
          onClick={() => openWizard('stock')}
        >
          ▸ edit
        </button>
      </div>

      {/* 1a — the skim of the top (#432 slice 4, decision Q6; #686's one line). On wood and metal
          the choice is one line with its current number; `change` opens the choice and the depth in
          place. An absent `facing` key is the pre-#432 job: nothing has chosen, and the job does not
          face. #726 P2 — plastic is not faced at all (#474/#493), so it draws NO line: the design
          keeps Facing "one line only on wood/metal". A job that somehow has facing on is the one
          exception — its line is how it is turned back off. */}
      {(!facingRefused || facingOn) && (
      <details data-testid="engrave-facing-editor" style={{ marginTop: 6 }}>
        <summary data-testid="engrave-facing-line" style={{ ...MUTED, cursor: 'pointer', margin: 0 }}>
          Facing —{' '}
          {facingRefused
            ? 'not offered on plastic'
            : facing === null
              ? 'not chosen'
              : facingOn
                ? `${fmt(facing.depth)} mm off the top`
                : 'off'}{' '}
          <span style={{ color: '#8fb8e0' }}>▸ change</span>
        </summary>
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
              title="Skim the whole top before cutting, then re-touch Z0 on the new surface."
              onClick={() => chooseFacing(true)}
            >
              Face the top
            </button>
          )}
          <button
            type="button"
            data-testid="engrave-facing-off"
            aria-pressed={!facingOn}
            title="Cut the top as it arrives."
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
      </details>
      )}

      {(!roundStock || keepOuts.length > 0) && (
      <details data-testid="engrave-voids-fold" style={{ marginTop: 6 }}>
        <summary data-testid="engrave-voids-summary" style={{ ...MUTED, cursor: 'pointer', margin: 0 }}>
          Voids under the face (<span data-testid="engrave-keepout-count">{keepOuts.length}</span>)
          <span style={{ marginLeft: 6, color: '#8fb8e0' }}>+</span>
        </summary>
        <RowFolds testidPrefix="engrave-keepout" ids={keepOuts.map((ko) => ko.id)} firstButtonRef={voidsFoldRef} />
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
      </details>
      )}

      {/* 2 — items: labels, shape pockets and combined shapes, one list (#214/#215). #686 puts the
          ONE "Add operation" picker directly under the heading, where the mockup has it. */}
      {/* #686 review — the Add control is this heading's own line (`+ Add operation` sits directly
          under it), so the section gap is not repeated inside the pair: no margin under the heading
          and none over the control. That is what keeps the list's header inside the ten-rows
          budget at 1440 × 900 (#411). */}
      <h3 style={{ ...SUBHEAD, marginBottom: 0 }}>
        Items{' '}
        <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-item-count">
          {itemTotal}
        </span>
        <RowFolds testidPrefix="engrave-item" ids={itemRowIds(job)} firstButtonRef={itemsFoldRef} />
      </h3>
      <UndoRemoval section="items" fallbackRef={itemsFoldRef} />
      {/* The one "Add" control: the SAME grouped operation picker the wizard's step 4 draws
          (#685). Its historic `engrave-add-*` ids are kept, so the flows that already drive them
          keep working; the old "More kinds and imports" list is no longer a second vocabulary but
          the picker's own options (see `operationTypes.ts`). */}
      {/* #686 review — the mockup puts `+ Add operation` on the Items heading's own line; while it
          is still the line under it, its spacing is the heading's, not a section gap, so the list's
          header stays inside the ten-rows-at-1440 × 900 budget (#411). */}
      <details data-testid="engrave-add-menu" style={{ marginTop: 0 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#c8d3de' }} data-testid="engrave-add-summary">
          + Add operation ▾
        </summary>
        {/* #662/#685 — THE ONE ENTRY POINT, and it says what the operation IS. The type table is
            the same one the wizard's step 4 and every row's chip read; the historic
            `engrave-add-*` ids live on these buttons so the flows that already drive them keep
            working. The old second list ("More kinds and imports") is folded in as OPTIONS of the
            operation each kind belongs to: Circle/Slot/Polygon (and the combined regions) under
            Pocket, Line and single-line text under Engrave text, Hole array under Hole, the four
            primitives under Cut away's 3D shape, and the two file routes under the picker (#685,
            B6). */}
        <OperationPicker
          mode="add"
          testidFor={(id) => operationType(id).addTestId}
          onPick={addOperation}
          surfaceAllowed={!jobHasOperations(job)}
          onOption={addFolded}
          optionEnabled={(option) => option.needsReference !== true || hasReferenceable}
          onImportOutline={() => void importOutline()}
          onImportImage={() => void importImage()}
          importing={importing}
        />
        {importError && (
          <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-import-error">
            {importError}
          </p>
        )}
      </details>
      {job.labels.map((label, i) => (
        <EngraveLabelRow
          key={label.id}
          label={label}
          index={i}
          maxDepth={maxDepth}
          maxDepthWhy={maxDepthWhy}
          findings={findingsFor(label.id)}
          customFonts={job.customFonts}
          recommended={depthRecommendation(label)}
          split={split}
          rest={label.construction === true ? null : restFor(label.id)}
          technical={vCarveTechnical(label.id)}
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
          maxDepthWhy={maxDepthWhy}
          findings={findingsFor(shape.id)}
          rest={shape.construction === true || shape.prism !== undefined ? null : restFor(shape.id)}
          vCarve={
            cone === null
              ? null
              : {
                  pitchMm: vCarvePitchMm,
                  coreCutterName: shape.vCarveDepth === 'variable' ? coreCutterFor(shape.id) : null,
                }
          }
          inlay={shape.construction === true ? null : (inlayFor(shape) ?? null)}
          texture={shape.construction === true ? null : (textureFor(shape) ?? null)}
          prism={shape.construction === true ? null : (prismFor(shape) ?? null)}
          technical={vCarveTechnical(shape.id)}
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
          maxDepthWhy={maxDepthWhy}
          candidates={referenceableItems(shape.id)}
          findings={findingsFor(shape.id)}
          rest={shape.construction === true ? null : restFor(shape.id)}
          technical={vCarveTechnical(shape.id)}
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
          maxDepthWhy={maxDepthWhy}
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
          maxDepthWhy={maxDepthWhy}
          findings={findingsFor(drill.id)}
          borePitch={borePitchFor(drill)}
          peck={peckFor(drill)}
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
          maxDepthWhy={maxDepthWhy}
          findings={findingsFor(thread.id)}
          onChange={(patch) => updateThread(thread.id, patch)}
          onRemove={() => removeThread(thread.id)}
        />
      ))}
      {(job.primitives ?? []).map((primitive, i) => (
        <EngravePrimitiveRow
          key={primitive.id}
          primitive={primitive}
          index={i}
          maxDepth={maxDepth}
          maxDepthWhy={maxDepthWhy}
          findings={findingsFor(primitive.id)}
          rest={primitiveReducesToRegion(primitive) ? restFor(primitive.id) : null}
          technical={vCarveTechnical(primitive.id)}
          onChange={(patch) => updatePrimitive(primitive.id, patch)}
          onRemove={() => removePrimitive(primitive.id)}
        />
      ))}
      {(job.cutouts ?? []).map((cutout, i) => (
        <EngraveCutoutRow
          key={cutout.id}
          cutout={cutout}
          index={i}
          targets={cutoutTargets}
          findings={findingsFor(cutout.id)}
          onChange={(patch) => updateCutout(cutout.id, patch)}
          onRemove={() => removeCutout(cutout.id)}
        />
      ))}
      {(job.chamfers ?? []).map((chamfer, i) => (
        <EngraveChamferRow
          key={chamfer.id}
          chamfer={chamfer}
          index={i}
          rims={chamferRims}
          missingRimLabel={chamferRimIssue(chamfer)}
          facts={chamferFacts}
          findings={findingsFor(chamfer.id)}
          onChange={(patch) => updateChamfer(chamfer.id, patch)}
          onRemove={() => removeChamfer(chamfer.id)}
        />
      ))}
      {(job.vectors ?? []).map((shape, i) => (
        <EngraveVectorRow
          key={shape.id}
          shape={shape}
          index={i}
          maxDepth={maxDepth}
          maxDepthWhy={maxDepthWhy}
          findings={findingsFor(shape.id)}
          rest={shape.construction === true ? null : restFor(shape.id)}
          technical={vCarveTechnical(shape.id)}
          onChange={(patch) => updateVector(shape.id, patch)}
          onRemove={() => removeVector(shape.id)}
        />
      ))}
      {/* #726 P4 — the depth ceiling is stated by the row BESIDE the depth field ("Max depth N mm
          here — …"), not again here: the same number twice read as two rules. */}

      {/* 2b — the target object (#435), a closed one-line row carrying its count (#686, design §2).
          It is deliberately NOT in the item list or the item count: it is never cut, and
          `validateJob` says so once as a warning. `stock − target` is the profile cut-out work
          tracked in #218. At 0 the paragraph and the import button are behind the row. */}
      {(!roundStock || target !== null) && (
      <details data-testid="engrave-target-fold" style={{ marginTop: 6 }}>
        <summary data-testid="engrave-target-summary" style={{ ...MUTED, cursor: 'pointer', margin: 0 }}>
          Target object (<span data-testid="engrave-target-count">{target === null ? 0 : 1}</span>)
          <span style={{ marginLeft: 6, color: '#8fb8e0' }}>+</span>
        </summary>
      <p style={MUTED}>
        A model the job is placed against. As a reference it is embedded and drawn but never cut —
        the stock around it is the profile cut-out work. As a goal (Surface a mesh) it is the
        shape to make, roughed and finished in 3D.
      </p>
      <UndoRemoval section="target" />
      {target !== null && (
        <EngraveTargetObjectRow
          target={target}
          index={0}
          findings={findings.filter((f) => f.code === 'target-object-not-cut')}
          onChange={(patch) => updateTargetObject(patch)}
          onRemove={() => removeTargetObject()}
          // #535 — a goal's operation owns its cutter and four numbers. The defaults are the
          // ones the engine falls back to: the feeds row's step-down/step-over, the shop's flat
          // grid pitch and finish allowance. The row only places them and words their source.
          surface={
            target.role === 'goal'
              ? {
                  cutter:
                    tool === null ? null : { key: job.toolKey, name: toolDisplayName(tool), shape: tool.shape },
                  cutters: toolOptions.map((e) => ({ key: e.key, label: toolOptionLabel(e) })),
                  feeds:
                    params === null
                      ? null
                      : {
                          stepDown: params.stepDown,
                          stepOver: params.stepOver,
                          typed:
                            job.cutOverride?.stepDown !== undefined ||
                            job.cutOverride?.stepOver !== undefined,
                        },
                  gridPitch: shopDefault('sim.columnFlatPitchYMm'),
                  stockToLeave: shopDefault('finish.stockToLeaveMm'),
                }
              : undefined
          }
          surfaceFacts={target.role === 'goal' ? (run.generated?.surface3d ?? null) : null}
          relief={reliefFacts}
          onCutterChange={(key) => setTool(key)}
        />
      )}
      <button
        type="button"
        data-testid="engrave-target-import"
        disabled={targetImporting}
        style={{ marginTop: 4 }}
        title="Read an STL or 3MF part as a reference object. The file is parsed once, embedded in the job and shown in the viewport; it is never cut."
        onClick={() => targetInputRef.current?.click()}
      >
        {targetImporting ? 'Reading the object…' : target === null ? 'Import a target object…' : 'Replace the target object…'}
      </button>
      <input
        ref={targetInputRef}
        type="file"
        accept=".stl,.3mf,model/stl,model/3mf"
        style={{ display: 'none' }}
        data-testid="engrave-target-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void readTarget(file);
        }}
      />
      {targetError && (
        <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-target-error">
          {targetError}
        </p>
      )}
      </details>
      )}
      {/* #662 — the Surface a mesh operation's input. The same reader as the reference above; the
          role is the difference, and it is what the engine dispatches on (`generateGoalProgram`).
          Outside the target row's fold: it is the operation picker's door, not the target row's. */}
      <input
        ref={goalInputRef}
        type="file"
        accept=".stl,.3mf,.png,model/stl,model/3mf,image/png"
        style={{ display: 'none' }}
        data-testid="engrave-surface-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void readTarget(file, 'goal');
        }}
      />
      </Group>

      <Group
        testid="engrave-group-cutter"
        title="Cutter"
        summary={tool === null ? 'no cutter chosen' : toolDisplayName(tool)}
        {...groupProps('engrave-group-cutter', true)}
      >
      {/* 3 — tool */}
      <h3 style={SUBHEAD}>Tool</h3>
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
        {/* #687 — grouped by kind in the design's order. A bull nose sits with the flat ends and a
            tapered ball with the balls; a row this build cannot classify is drawn without a heading
            rather than under an invented seventh one. */}
        {TOOL_GROUPS.map((group) => {
          const entries = toolOptions.filter((e) => group.shapes.includes(e.tool.shape));
          if (entries.length === 0) return null;
          return (
            <optgroup key={group.id} label={group.label}>
              {entries.map((e) => (
                <option key={e.key} value={e.key} title={toolOptionTitle(e)}>
                  {toolOptionLabel(e)}
                </option>
              ))}
            </optgroup>
          );
        })}
        {toolOptions
          .filter((e) => !TOOL_GROUPS.some((group) => group.shapes.includes(e.tool.shape)))
          .map((e) => (
            <option key={e.key} value={e.key} title={toolOptionTitle(e)}>
              {toolOptionLabel(e)}
            </option>
          ))}
      </select>
      {job.sources?.tool && <SourceTag source={job.sources.tool} testid="engrave-tool-source" />}
      {/* #434 — a drill's cutting end is a point, and the hole is its full diameter only a point
          length above the tip. The panel states the angle and where it came from, the same reading
          the worker plans and the simulation sweeps. */}
      {tool?.shape === 'drill' && (
        <p style={MUTED} data-testid="engrave-drill-point">
          {drillPoint?.ok === true ? (
            <>
              <b>Drill point.</b> {fmt(drillPoint.deg)}° included — {drillPoint.from}.
              {drillTipLength !== null && (
                <>
                  {' '}
                  The hole is its full ⌀{fmt(drillDiameter ?? 0)} mm only{' '}
                  {fmt(drillTipLength)} mm above the tip.
                </>
              )}
            </>
          ) : (
            <>The drill’s point: {drillPoint?.reason ?? 'the point angle could not be read'}.</>
          )}
        </p>
      )}
      {diameter !== null && !vCarveJob && (
        <p style={MUTED} data-testid="engrave-thin-strokes">
          Strokes thinner than {fmt(diameter)} mm cannot be cut — the cutter opens them away entirely.
        </p>
      )}
      {rec && (
        <div
          data-testid="engrave-recommendation"
          style={{ margin: '6px 0', border: '1px solid #3a4a5a', background: '#16202a', borderRadius: 4, padding: 6 }}
        >
          <p style={{ ...MUTED, color: '#c8d3de', margin: 0 }}>
            {recPick !== null && recPickDisplay !== null ? (
              <>
                <b>{recPickDisplay.name}</b>{' '}
                <span style={{ ...TAG, marginLeft: 0 }} data-testid="engrave-tool-recommended-tag">
                  recommended
                </span>
                {recPickDisplay.metal && (
                  <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-recommendation-metal">
                    metal
                  </span>
                )}
                {rec.reason ? ` — ${rec.reason}` : ''}{' '}
                {/* #687 — only when pressing it changes the job's cutter. The audit's complaint was
                    a `Use it` button beside the cutter it would "change" to itself. */}
                {!recPickApplied && rec.key !== null && (
                  <button
                    type="button"
                    data-testid="engrave-use-recommended"
                    onClick={() => rec.key && setTool(rec.key, 'computed')}
                  >
                    Use it
                  </button>
                )}
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
          {/* #687 — one line per cutter REJECTED for a reason the operator can act on, and nothing
              else. The qualifying rows, the compromise rows and every `not-flat` row are gone: they
              were the 160-line wall, and "not a flat end mill" against a ball nose was a naming bug
              the display form fixed. A list with nothing actionable draws no disclosure at all. */}
          {actionableRejections.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>
                {whySummary}
              </summary>
              <div style={{ marginTop: 4 }}>
                {[
                  ...rejectionGroups.individual,
                  ...(catalogueRowsGrouped ? [] : rejectionGroups.noCatalogueRow),
                ].map((c) => {
                  const candidateEntry = tools.find((e) => e.key === c.key);
                  const name =
                    candidateEntry === undefined
                      ? `⌀ ${fmt(c.diameter)} mm cutter`
                      : toolDisplayName(candidateEntry.tool);
                  const detail =
                    c.excluded === 'broken'
                      ? // #454/#458 — whose copies said so. Without the attribution a built-in
                        // reading "every copy is marked broken" sounds like the operator's own
                        // verdict on the shipped definition.
                        'every copy is marked broken' + conditionSourceWord(c)
                      : c.excluded === 'unknown-size'
                        ? // #699 — the number the recommendation itself cannot state. Actionable:
                          // the record can be given a tip diameter, or another bit chosen.
                          'its cutting diameter is not stated'
                        : c.excluded === 'no-catalogue-row'
                          ? // #455/#458 — the catalogue's own words. "No cutting parameters" is
                            // the opposite of true here: the starting table answers these cutters
                            // and it is the catalogue that named the materials it is listed for.
                            (c.catalogueNote ?? 'not listed by the catalogue for this material')
                          : c.excluded === 'metal-line'
                            ? // #699b — the job's OWN refusal, in the same words the finding uses.
                              (c.refusal ?? 'on Makera\'s "for Metal" line, and this job’s material refuses it')
                            : c.excluded === 'job-shape'
                              ? // #702 — the job's own SHAPE gate, in the finding's words.
                                (c.refusal ?? 'the job’s own operations refuse it')
                              : 'no cutting parameters for this material';
                  return (
                    <div
                      key={c.key}
                      data-testid={`engrave-candidate-${c.key}`}
                      style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, lineHeight: 1.6 }}
                    >
                      <span style={MUTED}>{name}</span>
                      <span style={{ color: '#e0a19b' }}>{detail}</span>
                    </div>
                  );
                })}
                {catalogueRowsGrouped && rejectionGroups.noCatalogueRow.length > 0 && (
                  <div
                    data-testid="engrave-candidate-group-no-catalogue-row"
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, lineHeight: 1.6 }}
                  >
                    <span style={MUTED}>
                      {rejectionGroups.noCatalogueRow.length} cutter
                      {rejectionGroups.noCatalogueRow.length === 1 ? '' : 's'} not listed by the catalogue
                    </span>
                    <span style={{ color: '#e0a19b' }}>
                      {rejectionGroups.noCatalogueRow.length === 1 ? 'has' : 'have'} no catalogue row for{' '}
                      {MATERIAL_LABELS[job.stock.material]}
                    </span>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}
      {!rec && previewStatus === 'loading' && (
        <p style={MUTED} data-testid="engrave-recommendation-pending">
          Measuring which cutter keeps every item intact…
        </p>
      )}

      {/* 6 — cutting parameters */}
      <h3 style={SUBHEAD}>
        Cutting{' '}
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
              ? "Makera's catalogue"
              : feeds.entry.status === 'unmeasured'
                ? 'starting values'
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
          {feedRow('feed', 'feed', `${fmt(params.feed)} mm/min`)}
          {feedRow('plunge', 'plunge', `${fmt(params.plungeFeed)} mm/min`)}
          {/* #688 (audit B10) — three decimals at most, trailing zeros dropped: a step-over of
              1.42875 mm read as five decimals of precision the row never claimed. */}
          {feedRow('step-down', 'step-down', `${fmt(params.stepDown)} mm`)}
          {feedRow('step-over', 'step-over', `${fmt(params.stepOver)} mm`)}
        </>
      )}
      {/* The override stays mounted even while refused: hiding it would hide the only way to
          undo the override that caused the refusal. */}
      {tool && (
        <details data-testid="engrave-override" style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>Override</summary>
          <div style={{ ...FIELD_GRID, marginTop: 6 }}>
            {OVERRIDE_FIELDS.map((f) => overrideNum(f.key, f.label, f.unit))}
          </div>
          <p style={MUTED}>
            Leave a field empty to use the computed value. A step-over wider than the cutter’s
            radius is refused rather than clamped.
          </p>
        </details>
      )}
      {/* #686, design §3 — the Cutter group's Technical fold. The depth margins are ONE line
          (`Margins 0.2 mm · Z tolerance 0.05 mm`); the engineering prose and the `(house default)`
          chip are gone (audit B11/D2), and the controls keep their testids inside the fold. The
          operator-typed facts also live here as one sentence rather than as a grey chip beside every
          field they typed. */}
      <details data-testid="engrave-cutter-technical" style={{ marginTop: 6 }}>
        <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>Technical</summary>
        {typedByUser.length > 0 && (
          <p style={MUTED} data-testid="engrave-typed-sources">
            Typed by you: {typedByUser.join(', ')}.
          </p>
        )}
        <div data-testid="engrave-margins" style={{ marginTop: 6 }}>
          <p style={{ ...MUTED, color: '#c8d3de', margin: 0 }} data-testid="engrave-margins-value">
            Margins {fmt(margins.boundaryMargin)} mm · Z tolerance {fmt(margins.zTolerance)} mm
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
            <span style={{ ...MUTED, margin: 0 }} data-testid="engrave-margins-recommended">
              For this blank: <b>{fmt(recommendation.boundaryMargin)} mm</b> — {recommendation.basis.join('; ')}.
            </span>
            {recommendMore && (
              <button
                type="button"
                data-testid="engrave-margins-use"
                title={`Run this job on ${fmt(recommendation.boundaryMargin)} mm — the margin this blank's own arithmetic argues for`}
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
                title={`Drop this job's own margins and follow the house setting (${fmt(houseBoundary)} mm on this blank)`}
                onClick={() => setJobMargins(null)}
              >
                Follow the house setting
              </button>
            )}
          </div>
        </div>
      </details>
      </Group>

      <Group
        testid="engrave-group-hold"
        title="Hold"
        summary={
          // #725 W1 — a bed job says its own mount (§3.7's lines), not the vise it is not in.
          bedLine !== null
            ? bedLine
            : rotaryRod === null
              ? `Vise — ${viseBadge(vise)} · blank on the ${vise.seat}`
              : `Rotary chuck — ⌀${fmt(rotaryRod.diameter)} × ${fmt(rotaryRod.length)} mm rod`
        }
        action={{ testid: 'engrave-hold-edit', label: 'edit', onClick: () => openWizard('holding') }}
        {...groupProps('engrave-group-hold', false)}
      >
      {/* 4 — vise */}
      {/* #523 — the vise is a card: the one sentence always visible, the fields open on Edit. */}
      {rotaryRod !== null ? (
        <p style={MUTED} data-testid="engrave-rotary-card">
          In the rotary chuck: a ⌀{fmt(rotaryRod.diameter)} × {fmt(rotaryRod.length)} mm rod along
          X. The holding step is where the chuck’s jaws, tailstock and grip are set.
        </p>
      ) : bedLine !== null ? (
        // #725 W1 — the bed's card is its mount's one line; the vise's fields are not shown for a
        // job that is not in the vise. `edit` re-enters Holding, where the tape and clamps are.
        <p style={MUTED} data-testid="engrave-bed-card">
          {bedLine}. The holding step is where the tape, the board under it and the clamps are set.
        </p>
      ) : (
      <details data-testid="engrave-vise-card" style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 12, color: '#c8d3de' }}>
          <span>
            Vise — <span style={TAG} data-testid="engrave-vise-badge">{viseBadge(vise)}</span> blank on the {vise.seat}
            {vise.stockProud >= 0
              ? `, ${vise.stockProud} mm proud of the jaw tops`
              : `, ${-vise.stockProud} mm below the jaw tops`}
          </span>
          <span style={MUTED}>Edit</span>
        </summary>
        <div style={{ marginTop: 4 }}>
          <div style={FIELD_GRID}>
            {/* #508 — the seat is the operator's answer, not a measurement: it is WHAT the blank's
                underside rests on, and it is what sets how high the blank sits. The body floor's depth
                is PROVISIONAL until the bench calipers it. */}
            <label style={FIELD_LABEL}>
              <span>blank rests on</span>
              <select
                value={vise.seat}
                data-testid="engrave-vise-seat"
                aria-label="Vise blank seat"
                title="What the blank’s underside rests on: the soft jaws’ ledge, or the vise body’s floor."
                style={FIELD}
                onChange={(e) => setVise({ seat: e.target.value as ViseParams['seat'] })}
              >
                <option value="ledge">jaw ledge</option>
                <option value="floor">body floor (PROVISIONAL)</option>
              </select>
            </label>
            {viseNum('stockProud', 'stock proud', 'How far the stock’s top face stands above the jaw tops, mm. A default vise derives it from the seat and the thickness.')}
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
        </div>
      </details>
      )}

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
        <div style={FIELD_GRID}>
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
      </Group>

      {/* #686 — the footer is the panel's LAST flow child, so `position: sticky; bottom: 0` pins the
          whole state block (findings, Generate and its blocker + Fix, the ticks and the time) to the
          bottom of the panel's own scroll box at a 1024 × 700 window. The preview notice sits above
          it rather than after it: nothing may follow the sticky region in the flow. */}
      {previewStatus === 'loading' && (
        <p style={{ ...MUTED, opacity: 0.7 }} data-testid="engrave-preview-loading">
          Rebuilding the preview…
        </p>
      )}
      {/* #523 — the sticky footer is the one place the job's state is read: the findings as a
          count that expands, then Generate and the run rows — never below the fold. A finding row
          is the sentence alone (#505): `data-code` keeps the code for the tests. */}
      <footer
        data-testid="engrave-footer"
        style={{ position: 'sticky', bottom: 0, background: 'var(--cm-color-surface-container-low)', borderTop: '1px solid #2a2f36', paddingTop: 6, paddingBottom: 6 }}
      >
        {jobFindings.length > 0 && (
          <details data-testid="engrave-findings">
            <summary style={{ ...MUTED, cursor: 'pointer', margin: 0 }}>
              {findingTally(jobFindings)}{' '}
              <span style={{ color: '#8fb8e0' }}>▸ show</span>
            </summary>
            <div style={{ marginTop: 4 }}>
              {jobFindings.map((f, i) => (
                <div
                  key={`${f.code}-${i}`}
                  data-testid={`engrave-finding-${i}-${f.code}`}
                  data-code={f.code}
                  style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.45, margin: '3px 0', color: '#d1d5db' }}
                >
                  {/* #686, design §5 — the severity as a WORD, not a colour dot (audit B13): a dot
                      asks the reader to remember a legend. `data-code` keeps the code for tests. */}
                  <span style={{ color: SEVERITY_COLOR[f.severity], flexShrink: 0, fontWeight: 600 }} data-severity={f.severity}>
                    {SEVERITY_WORD[f.severity]}
                  </span>
                  <span>{f.message}</span>
                  {f.code === 'tool-metal-line' && f.severity === 'error' && (
                    <span style={{ flexShrink: 0, marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      {!confirmMetalOverride ? (
                        <button type="button" data-testid="metal-line-use-anyway" onClick={() => setConfirmMetalOverride(true)}>
                          Use this cutter anyway
                        </button>
                      ) : (
                        <>
                          <span style={{ color: '#f0b4ad' }}>
                            This bit is ground and coated for metal; on this material it can chip or snap, and no feed row was written for it — feeds/speeds are a guess.
                          </span>
                          <button type="button" data-testid="metal-line-confirm" onClick={() => { setMetalLineOverride(true); setConfirmMetalOverride(false); }}>
                            I understand the bit may break
                          </button>
                        </>
                      )}
                    </span>
                  )}
                  {f.code === 'tool-metal-line' && f.severity === 'warning' && (
                    <span style={{ flexShrink: 0, marginLeft: 'auto', color: SEVERITY_COLOR.warning }} data-testid="metal-line-override-active">
                      override active
                    </span>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        {previewStatus === 'error' && (
          <p style={{ ...MUTED, color: '#f0b4ad' }} data-testid="engrave-preview-error">
            The preview could not be built: {previewError ?? 'unknown error'}
          </p>
        )}

        {/* 8 — generate → verify → simulate → oracle → save */}
        <h3 style={SUBHEAD}>Generate</h3>
      <div data-testid="engrave-generate-slot">
        {/* #688 — the blocker is the button's OWN sentence with its Fix (design §1 principle 4).
            It used to be one tooltip for two causes, "Fix the errors above first.", which could
            be — and was — shown beside "0 errors" (audit B9). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            data-testid="engrave-generate"
            disabled={blocked || running || !simEnabled}
            title={
              !simEnabled
                ? 'This build has no simulation worker.'
                : 'Generate the toolpath, verify it, simulate it and check it against the design.'
            }
            style={{ padding: '7px 14px' }}
            onClick={() => void generate()}
          >
            {running ? 'Working…' : 'Generate'}
          </button>
          {generateBlocker !== null && (
            <span
              data-testid="engrave-generate-blocker"
              style={{ flex: '1 1 180px', fontSize: 12, lineHeight: 1.45, color: SEVERITY_COLOR.error }}
            >
              {generateBlocker.sentence}
              {generateBlocker.fix !== null && (
              <>
              {' '}
              <button
                type="button"
                data-testid="engrave-generate-fix"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  font: 'inherit',
                  color: '#8fb8e0',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
                onClick={() => applyFix(generateBlocker.fix!)}
              >
                ▸ Fix
              </button>
              </>
              )}
            </span>
          )}
        </div>

        {!blocked && (
          <>
            {/* #688 — four ticks and ONE labelled time (§3.6, audit B14/B15). The counts and the
                under/over-cut numbers the old rows carried belong to the simulation's own panel
                (#691), whose data is already the run view's. */}
            <div
              data-testid="engrave-run-rows"
              style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, fontSize: 12, color: '#c8d3de' }}
            >
              <RunTick testid="engrave-run-toolpath" state={rowToolpath} label={rowToolpathText} />
              <RunTick testid="engrave-run-verified" state={rowVerified} label={rowVerifiedText} />
              <RunTick testid="engrave-run-simulated" state={rowSimulated} label={rowSimulatedText} />
              <RunTick testid="engrave-run-oracle" state={rowOracle} label={rowOracleText} last />
              {runTimeText !== null && (
                <span data-testid="engrave-run-time" style={{ marginLeft: 'auto', color: '#9aa4b0' }}>
                  {runTimeText}
                </span>
              )}
            </div>
            {/* #432 review R11 — the facing program is its own file: name the cutter it runs, or
                the reason it was withheld. Absent when the job does not face. */}
            {facingJob && <RunRow testid="engrave-run-facing" state={rowFacing} text={rowFacingText} />}
            {/* #277 — what the last measured run of this program actually took, from a record
                file a person filled in. It sits BESIDE the estimate, never in place of it: the
                figure above is the program's planning estimate, and this is a reading with a
                date. */}
            {lastMeasured && lastMeasured.minutes !== null && (
              <p
                data-testid="engrave-last-measured"
                style={{ margin: '2px 0 4px', fontSize: 11, color: '#9aa4b0', lineHeight: 1.45 }}
              >
                Last measured run: {formatDuration(lastMeasured.minutes * 60)} on {lastMeasured.cutOn} — a
                bench reading, not the estimate above.
              </p>
            )}

            {runErrors.length > 0 && (
              <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-run-errors">
                {firstRunErrorText ?? `${runErrors.length} error${runErrors.length === 1 ? '' : 's'} outstanding.`}
                {runErrors.length > 1 && ` (+${runErrors.length - 1} more error${runErrors.length === 2 ? '' : 's'})`}
                {/* #725 B4 — the same sentence's Fix, in the footer at the button: the verifier's
                    clamp/arm refusals and the rotary's have always had their sentences, but no
                    control took the operator to what resolves one. */}
                {runFix !== null && (
                  <>
                    {' '}
                    <button
                      type="button"
                      data-testid="engrave-run-blocker-fix"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        font: 'inherit',
                        color: '#8fb8e0',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                      }}
                      onClick={() => applyFix(runFix)}
                    >
                      ▸ Fix
                    </button>
                  </>
                )}
              </p>
            )}
            {run.error && (
              <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-run-error">
                {run.error}
              </p>
            )}

            <button
              type="button"
              data-testid="engrave-save"
              disabled={saveBlockerText !== null}
              title={saveBlockerText ?? 'Save the generated program to carry it to the Cut step, or to open in Makera Studio.'}
              style={{ width: '100%', padding: 7, marginTop: 6 }}
              onClick={() => void saveProgram()}
            >
              Save .nc…
            </button>
            {saveBlockerText !== null && (
              <p style={MUTED} data-testid="engrave-save-blocked">
                Save is disabled — {withPeriod(saveBlockerText!)}{' '}
                {/* #688 — only the acknowledgement is something Cut can resolve, so only that
                    blocker gets the Fix. The sentence and #689's Cut step 1 use the same words. */}
                {saveBlockerText === CLEARANCE_ACK_BLOCKER && (
                  <button
                    type="button"
                    data-testid="engrave-save-fix"
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      color: '#8fb8e0',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                    onClick={() => showMode('cut')}
                  >
                    ▸ Fix
                  </button>
                )}
              </p>
            )}

            {/* #419 §3 — the run controls live under CUT now, over the frozen package. Design
                stops at a verified, saved program; Cut is the approval and the run. */}

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
                    ? 'Open the printable run sheet for the machine.'
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
      </footer>

      {sheet && <RunSheetView sheet={sheet} onClose={() => setSheet(null)} />}
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
        </>
      ) : (
        preflight !== null && (
          <>
            {/* #524 — the registration step now lives in the Cut surface's four-step checklist,
                below the gate and the package. */}
            <EngraveCutSurface
              job={job}
              report={preflight}
              package={jobPackage}
              generated={run.generated}
              staleSince={run.staleSince}
              machine={machine}
              runContext={runContext}
              uploadBlocker={uploadBlockerText}
              releaseBlocker={releaseBlockerText}
              onProgramLine={followProgramLine}
              onLiveStatus={noteLiveStatus}
              onBackToDesign={backToDesign}
            />
          </>
        )
      )}
    </div>
  );
}
