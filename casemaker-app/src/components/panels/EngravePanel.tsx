import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveRunStore, requiredAckCodes, runErrorCodes, saveBlocker } from '@/store/engraveRunStore';
import { saveText } from '@/engine/exportTrigger';
import { useSettingsStore } from '@/store/settingsStore';
import { TOOL_LIBRARY, Z1 } from '@/engine/cnc';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { jobTool, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { ensureFontsLoaded, fontKeysForLabels } from '@/engine/fonts/registry';
import { buildRunSheet, runSheetFileName, type RunSheet } from '@/engine/cnc/engrave/runSheet';
import { feedsFor, type CutParams } from '@/engine/cnc/feeds';
import { MATERIAL_OPTIONS } from '@/engine/cnc/engrave/setupFlow';
import { importOutlineFromDisk, toVectorShape, type OutlineImport } from '@/engine/import/outlineImport';
import { newEngraveShapeId } from '@/engine/cnc/engrave/defaults';
import {
  defaultSacrificialSide,
  defaultSacrificialUnder,
  hasSacrificial,
  noneSacrificial,
  presetJawStrips,
  presetPartOnBoard,
} from '@/engine/cnc/sacrificial';
import { EngraveLabelRow } from './EngraveLabelRow';
import { EngraveShapeRow } from './EngraveShapeRow';
import { EngraveCombinedRow } from './EngraveCombinedRow';
import { EngraveDrillRow } from './EngraveDrillRow';
import { EngraveTraceRow } from './EngraveTraceRow';
import { EngraveVectorRow } from './EngraveVectorRow';
import { EngraveImportDialog } from './EngraveImportDialog';
import { EngraveSetupFlow } from './EngraveSetupFlow';
import { RunSheetView } from './RunSheetView';
import { coverageDisclaimer, type SimRunOutcome } from './simCoverage';
import { viseEnvelope } from '@/engine/cnc/fixture';
import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveJob,
  EngraveShape,
  FieldSource,
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
const FIELD: CSSProperties = { width: 74 };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };
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

/**
 * The visible word for a value's source (#246/#254): a typed number reads "typed", never looking
 * like a bench reading, and a computed feed says so. `measured` is the one that gets a colour.
 */
const SOURCE_LABEL: Record<FieldSource, string> = { computed: 'computed', user: 'typed', measured: 'measured' };
const SOURCE_COLOR: Record<FieldSource, string> = { computed: '#9aa4b0', user: '#9aa4b0', measured: '#9fd19b' };

/** The tag that shows a field's provenance (#246/#254), or null when nothing was asserted. */
function SourceTag({ source, testid }: { source: FieldSource; testid: string }): JSX.Element {
  return (
    <span
      style={{ ...TAG, color: SOURCE_COLOR[source], borderColor: source === 'measured' ? '#3a5a3a' : '#2a2f36' }}
      data-testid={testid}
      data-source={source}
      title={
        source === 'computed'
          ? 'Computed from the feeds table — no one typed this.'
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

/** Every item of the job, in the order `toPartPlan` walks them (#214/#215/#217). Imported
 *  vector outlines are `EngraveAnyItem`s too, so a frame or a cut-away may name one. */
function allItems(job: EngraveJob): EngraveAnyItem[] {
  return [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])];
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

/** Cutting diameter of a library entry, best effort (`tipDiameter ?? diameter`). */
function entryDiameter(e: ToolLibraryEntry): number | null {
  return e.tool.tipDiameter ?? e.tool.diameter;
}

function toolOptionLabel(e: ToolLibraryEntry): string {
  const d = entryDiameter(e);
  return d === null ? `${e.tool.name} — cutting diameter unknown` : `${e.tool.name} — Ø ${d} mm cutting`;
}

/** The badge that says where the vise numbers came from (decision 28: a default is not a measurement). */
function viseBadge(v: ViseParams): string {
  if (v.source === 'default') return 'default · unmeasured';
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

export function EngravePanel(): JSX.Element {
  const job = useEngraveJobStore((s) => s.job);
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
  const addVector = useEngraveJobStore((s) => s.addVector);
  const updateVector = useEngraveJobStore((s) => s.updateVector);
  const removeVector = useEngraveJobStore((s) => s.removeVector);
  const setTool = useEngraveJobStore((s) => s.setTool);
  const setVise = useEngraveJobStore((s) => s.setVise);
  const setSacrificial = useEngraveJobStore((s) => s.setSacrificial);
  const setCutOverride = useEngraveJobStore((s) => s.setCutOverride);
  const setCutOverrideSource = useEngraveJobStore((s) => s.setCutOverrideSource);

  const preview = useEngravePreviewStore((s) => s.preview);
  const previewStatus = useEngravePreviewStore((s) => s.status);
  const previewError = useEngravePreviewStore((s) => s.error);

  // The first preview. Later edits reach the store through its own subscription to the job
  // store, so the panel never has to ask after this.
  useEffect(() => {
    useEngravePreviewStore.getState().request(useEngraveJobStore.getState().job);
  }, []);

  // Findings: the worker's list (validateJob + validateVise + the geometry findings, deduped)
  // once it has one, otherwise the pure `validateJob` — which already carries `validateVise`'s
  // most important codes and the sacrificial ones, so the form is never blank.
  const findings: JobFinding[] = preview?.findings ?? validateJob(job);
  const jobFindings = findings.filter((f) => f.labelId === undefined);
  const findingsFor = (labelId: string): JobFinding[] => findings.filter((f) => f.labelId === labelId);

  const tool = jobTool(job);
  const toolEntry = TOOL_LIBRARY.find((e) => e.key === job.toolKey) ?? null;
  const diameter = toolEntry ? entryDiameter(toolEntry) : null;
  const feeds = tool ? feedsFor(job.stock.material, tool, Z1, job.cutOverride) : null;
  const params: CutParams | null = feeds && feeds.ok ? feeds.params : null;

  const maxDepth = job.stock.thickness - job.minFloor;
  const errors = findings.filter((f) => f.severity === 'error');
  const blockedByFeeds = feeds !== null && !feeds.ok;
  const blocked = errors.length > 0 || blockedByFeeds;

  const rec = preview?.recommendation ?? null;
  const recPick = rec?.key ? rec.candidates.find((c) => c.key === rec.key) ?? null : null;

  // ---- the run (#206) ----------------------------------------------------------------------

  const run = useEngraveRunStore();
  const simEnabled = __FEATURE_SIM__;
  const running = run.phase === 'generating' || run.phase === 'simulating' || run.phase === 'checking';

  // The run sheet is built on demand from the current job and the last generated result, and
  // shown as an overlay (#207). A stale result is not offered: the sheet would describe a job the
  // user has since changed.
  const [sheet, setSheet] = useState<RunSheet | null>(null);
  // The guided job setup (#254) is a path into this panel, not a gate in front of it.
  const [setupOpen, setSetupOpen] = useState(false);
  const runSheetReady = run.generated !== null && run.generated.verify !== null && run.generated.nc !== null;
  const runSheetBlocked = run.staleSince !== null;

  async function openRunSheet(): Promise<void> {
    const generated = useEngraveRunStore.getState().generated;
    if (!generated || !generated.verify || generated.nc === null) return;
    // `buildRunSheet` typesets every label to lay out the origin diagram, and `resolveFont`
    // throws unless the bundled faces are already parsed (#180). The sim worker loads them, but
    // that cache is per-realm — the main thread must load the job's faces itself first, exactly
    // as `JobScheduler` does before its compile.
    await ensureFontsLoaded(fontKeysForLabels(job.labels, job.customFonts ?? []));
    setSheet(buildRunSheet(job, generated, { diagnostics: run.simDiagnostics }));
  }

  const verifyFindings = run.generated?.verify?.findings ?? [];
  const verifyErrors = verifyFindings.filter((f) => f.severity === 'error').length;
  const verifyWarnings = verifyFindings.filter((f) => f.severity === 'warning').length;
  const simErrors = run.simDiagnostics.filter((d) => d.severity === 'error').length;
  const simWarnings = run.simDiagnostics.filter((d) => d.severity === 'warning').length;
  const runErrors = runErrorCodes(run);
  const ackCodes = requiredAckCodes(run);
  const saveBlockerText = saveBlocker(run);
  const cam = run.generated?.cam ?? null;

  // #243 (§14.2 A2) — the blind-spot half of the Simulated row. The SAME pure builder the
  // Simulate panel uses, fed from THIS run rather than re-written: the fixture the setup
  // modelled, whether sacrificial material was included, the machine's own holder (null on the
  // Z1, so the collet nut is unmodelled), and the codes the sweep raised. Importing it is what
  // keeps the two panels from disagreeing about what the sweep saw.
  const simCoverage: string[] =
    run.simStatus === null
      ? []
      : coverageDisclaimer({
          outcome: (run.simStatus === 'ready' ? 'swept' : run.pathOnly ? 'path-only' : 'refused') as SimRunOutcome,
          fixtureLabels: viseEnvelope(job.stock, job.workholding.vise, job.sacrificial).boxes.map((b) => b.label),
          fixtureSource: job.workholding.vise.source,
          sacrificialModelled: hasSacrificial(job.sacrificial),
          holderKnown: Z1.holder !== null,
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

  async function generate(): Promise<void> {
    await run.generate();
  }

  async function saveProgram(): Promise<void> {
    const nc = run.generated?.nc;
    if (!nc || saveBlockerText !== null) return;
    // The run sheet prints this exact name (#207), so both come from `runSheetFileName` — the
    // sheet and the saved file can never disagree about what the file is called.
    await saveText(nc, runSheetFileName(job.name), 'text/plain');
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
      setPendingOutline(result.outline);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  /** The dialog's accepted (possibly rescaled) outline becomes a job item centred on the stock. */
  function acceptOutline(outline: OutlineImport): void {
    addVector(
      toVectorShape(outline, {
        id: newEngraveShapeId(),
        position: { x: job.stock.length / 2, y: job.stock.width / 2 },
        depth: 0.5,
        name: outline.sourceName,
      }),
    );
    setPendingOutline(null);
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
        value={job.workholding.vise[key]}
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
   * The source of one cutting override (#246): `computed` when the box shows the feeds table's
   * value untouched, otherwise the tag the value was stamped with. The tag is the toggle — a
   * typed value can be declared a bench measurement and back, so a measured feed is visible and
   * reversible, and never silently relabelled by a regenerate.
   */
  const overrideSourceTag = (key: keyof Omit<CutParams, 'air'>): JSX.Element => {
    const src: FieldSource = job.cutOverride?.[key] === undefined ? 'computed' : job.sources?.cut?.[key] ?? 'user';
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

      {/* 1 — stock */}
      <h3 style={SUBHEAD}>Stock</h3>
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
            {MATERIAL_OPTIONS.map((m) => (
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

      {/* 2 — items: labels, shape pockets and combined shapes, one list (#214/#215) */}
      <h3 style={SUBHEAD}>
        Items{' '}
        <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-item-count">
          {job.labels.length + job.shapes.length + combinedCount + traceCount + drillCount + vectorCount}
        </span>
      </h3>
      {job.labels.map((label, i) => (
        <EngraveLabelRow
          key={label.id}
          label={label}
          index={i}
          maxDepth={maxDepth}
          findings={findingsFor(label.id)}
          customFonts={job.customFonts}
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
              onClick={() => (k.value === 'label' ? addLabel() : addShape(k.value as EngraveShape['kind']))}
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
              onClick={() => addCombined(k.value)}
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
              onClick={() => addTrace(k.value)}
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
              onClick={() => addDrill(k.value)}
            >
              {k.label}
            </button>
          ))}
        </div>
        {/* #217: import an SVG or DXF as a filled cut region. The file is parsed once; the
            contour list is what the job keeps. */}
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
        </div>
        {importError && (
          <p style={{ ...MUTED, color: SEVERITY_COLOR.error }} data-testid="engrave-import-error">
            {importError}
          </p>
        )}
      </details>
      <p style={MUTED}>Depth keeps the {job.minFloor} mm minimum floor — at most {maxDepth} mm on this stock.</p>

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
        {TOOL_LIBRARY.map((e) => (
          <option key={e.key} value={e.key} title={e.provenance}>
            {toolOptionLabel(e)}
          </option>
        ))}
      </select>
      {job.sources?.tool && <SourceTag source={job.sources.tool} testid="engrave-tool-source" />}
      {diameter !== null && (
        <p style={MUTED} data-testid="engrave-thin-strokes">
          Strokes thinner than {fmtDiameter(diameter)} mm cannot be cut — the cutter opens them away entirely.
        </p>
      )}
      {rec && (
        <div
          data-testid="engrave-recommendation"
          style={{ margin: '6px 0', border: '1px solid #3a4a5a', background: '#16202a', borderRadius: 4, padding: 6 }}
        >
          <p style={{ ...MUTED, color: '#c8d3de', margin: 0 }}>
            {recPick ? (
              <>
                <b>Recommended: {fmtDiameter(recPick.diameter)} mm flat end</b> — {rec.reason}{' '}
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
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>
              Why? — {rec.candidates.length} cutters considered
            </summary>
            <div style={{ marginTop: 4 }}>
              {rec.candidates.map((c) => {
                const detail = c.excluded
                  ? c.excluded === 'not-flat'
                    ? 'not a flat end mill'
                    : 'no cutting parameters for this material'
                  : c.worst
                    ? `worst item "${itemDisplay(c.worst.labelId)}" · ${Math.round(c.worst.ratio * 100)} % kept`
                    : 'not measured';
                return (
                  <div
                    key={c.key}
                    data-testid={`engrave-candidate-${c.key}`}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, lineHeight: 1.6 }}
                  >
                    <span style={MUTED}>{fmtDiameter(c.diameter)} mm flat end</span>
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

      {/* 6 — cutting parameters */}
      <h3 style={SUBHEAD}>
        Cutting
        {feeds?.ok && (
          <span
            style={{ ...TAG, marginLeft: 4 }}
            title={feeds.entry.provenance}
            data-testid="engrave-feeds-status"
          >
            {feeds.entry.status === 'unmeasured' ? 'starting values — unmeasured' : 'measured'}
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
              data-testid={`engrave-finding-${f.code}`}
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
              title={saveBlockerText ?? 'Save the generated program for Makera Studio.'}
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
      </div>

      {sheet && <RunSheetView sheet={sheet} onClose={() => setSheet(null)} />}
      {setupOpen && <EngraveSetupFlow onClose={() => setSetupOpen(false)} />}
      {pendingOutline && (
        <EngraveImportDialog
          outline={pendingOutline}
          cutterDiameter={diameter}
          onAccept={acceptOutline}
          onClose={() => setPendingOutline(null)}
        />
      )}

      {previewStatus === 'loading' && (
        <p style={{ ...MUTED, opacity: 0.7 }} data-testid="engrave-preview-loading">
          Rebuilding the preview…
        </p>
      )}
    </div>
  );
}
