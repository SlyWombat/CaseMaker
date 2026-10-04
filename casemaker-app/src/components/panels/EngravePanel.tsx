import { useEffect, type CSSProperties, type JSX } from 'react';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useSettingsStore } from '@/store/settingsStore';
import { TOOL_LIBRARY, Z1 } from '@/engine/cnc';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { jobTool, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor, type CutParams } from '@/engine/cnc/feeds';
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
import type {
  EngraveJob,
  EngraveShape,
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

/** The kinds the panel can add with its "Add" control (#214): a label plus the four shapes. */
const ADD_KINDS: readonly { value: EngraveShape['kind'] | 'label'; label: string }[] = [
  { value: 'label', label: 'Label' },
  { value: 'rect', label: 'Rectangle' },
  { value: 'circle', label: 'Circle' },
  { value: 'slot', label: 'Slot' },
  { value: 'polygon', label: 'Polygon' },
];

const ATTACH_METHODS: readonly { value: SacrificialUnder['attach']; label: string }[] = [
  { value: 'tape', label: 'tape' },
  { value: 'glue', label: 'glue' },
  { value: 'screws', label: 'screws' },
  { value: 'loose', label: 'loose (a warning)' },
];

const STRIP_SIDES: readonly (keyof Sacrificial['sides'])[] = ['left', 'right', 'front', 'back'];

const MATERIALS: readonly { value: StockMaterial; label: string }[] = [
  { value: 'softwood', label: 'softwood' },
  { value: 'hardwood', label: 'hardwood' },
  { value: 'mdf', label: 'MDF' },
  { value: 'pla', label: 'PLA' },
];

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
  const setTool = useEngraveJobStore((s) => s.setTool);
  const setVise = useEngraveJobStore((s) => s.setVise);
  const setSacrificial = useEngraveJobStore((s) => s.setSacrificial);
  const setCutOverride = useEngraveJobStore((s) => s.setCutOverride);

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

  // ---- item naming (labels and shapes are one list downstream, #214) ------------------------

  /** A short name for an item id, for the recommendation's "worst item" line. */
  function itemDisplay(id: string): string {
    const item = [...job.labels, ...job.shapes].find((it) => it.id === id);
    if (!item) return id;
    if ('kind' in item) return item.name ?? item.kind;
    return item.text;
  }

  const stockNum = (key: 'length' | 'width' | 'thickness', label: string, title: string): JSX.Element => (    <label style={FIELD_LABEL}>
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
    </label>
  );

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
            {MATERIALS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p style={MUTED}>X runs between the vise jaws. The fixed jaw is on the left.</p>

      {/* 2 — items: labels and shape pockets, one list (#214) */}
      <h3 style={SUBHEAD}>
        Items{' '}
        <span style={{ ...TAG, marginLeft: 4 }} data-testid="engrave-item-count">
          {job.labels.length + job.shapes.length}
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
      {/* The one "Add" control (#214 work item 5): a menu with the five kinds. The label entry
          keeps the historic `engrave-add-label` test id (#205) as its own menu item, so the
          pre-#214 label flow is still one click. */}
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

      {/* 8 — generate (the action itself is #206) */}
      <h3 style={SUBHEAD}>Generate</h3>
      <div data-testid="engrave-generate-slot">
        <button
          type="button"
          data-testid="engrave-generate"
          disabled={blocked}
          title={blocked ? 'Fix the errors above first.' : 'Generate and verify the toolpath (#206).'}
          style={{ width: '100%', padding: 7 }}
        >
          Generate toolpath
        </button>
        <p style={{ ...MUTED, ...(blocked ? { color: SEVERITY_COLOR.error } : null) }}>
          {blockedByFeeds
            ? 'Disabled — the cutting parameters above are refused.'
            : errors.length > 0
              ? `Disabled while ${errors.length} error${errors.length === 1 ? '' : 's'} ${errors.length === 1 ? 'is' : 'are'} outstanding.`
              : 'Ready to generate and verify (#206).'}
        </p>
      </div>

      {previewStatus === 'loading' && (
        <p style={{ ...MUTED, opacity: 0.7 }} data-testid="engrave-preview-loading">
          Rebuilding the preview…
        </p>
      )}
    </div>
  );
}
