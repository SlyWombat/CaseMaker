import type { CSSProperties, JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { DEFAULT_PENCIL_CREASE_DEG, type GoalSurfaceFacts } from '@/engine/cnc/cam/surface3d';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { TargetObjectPatch } from '@/store/engraveJobStore';
import type { EngraveSurfaceSettings, EngraveTargetObject } from '@/types/engraveJob';

/**
 * The reference object the 3D primitives are positioned against (#435).
 *
 * It is NOT an item: as a reference it is never cut and never enters `toPartPlan`. Its row exists
 * so the imported model can be placed against the pockets — the bbox centre in X/Y and its TOP at
 * `position.z` (Z0 is the stock top). The import owns the bytes, hash and parsed size; this row
 * edits only placement, rotation and visibility.
 *
 * #535 — AS A GOAL the mesh IS the work, and the operation has its own numbers. They sit behind a
 * Technical fold in this row: the cutter (one cutter cuts both passes — the engine posts one tool
 * per program) and the four numbers the surfaces passes run with, each prefilled from its default
 * and saying where that default lives. A typed number overrides it for this goal alone and shows
 * as "typed"; the reset puts the default back. When a run has generated, the row prints the
 * passes' own levels and the grid the heightfield was sampled on — the numbers the CAM ran with,
 * not a second resolution of the same question.
 *
 * The row still uses `EngraveItemRow`: it is the panel's one line-per-object shape, and the target
 * has a name, a number and a fold like every other object. It is `selectable` because the viewport
 * draws and picks it (`EngravePrimitives`); the selection highlights the row and the mesh.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };
const SOURCE_WORD: CSSProperties = { fontSize: 10, color: '#9aa4b0' };

/** The shop-default sources, in the words the rest of the panel uses for them. */
function shopSourceWords(source: string): string {
  switch (source) {
    case 'seeded':
      return 'this shop’s seed';
    case 'chosen':
      return 'chosen for this shop';
    case 'measured':
      return 'measured at the bench';
    default:
      return 'the shipped fallback';
  }
}

/** A goal cutter option: the job's cutter select, limited to what a 3D finish can use. */
export interface SurfaceCutterOption {
  key: string;
  label: string;
}

/**
 * Everything the goal's Technical fold needs to show its defaults and write its overrides. The
 * panel owns all of it (the registry, the resolved feeds row and the shop defaults); the row only
 * places the numbers and words.
 */
export interface SurfaceDefaults {
  /** The job's cutter, as chosen. */
  cutter: { key: string; name: string; shape: string } | null;
  /** The cutter select's options. */
  cutters: readonly SurfaceCutterOption[];
  /**
   * The feeds row's resolved step-down and step-over, or null when it did not resolve. `typed`
   * says the job overrides them by hand (`job.cutOverride`), so the word beside them changes.
   */
  feeds: { stepDown: number; stepOver: number; typed: boolean } | null;
  /** The shop's `sim.columnFlatPitchYMm` and where it came from. */
  gridPitch: { value: number; source: string };
  /** The shop's `finish.stockToLeaveMm` and where it came from. */
  stockToLeave: { value: number; source: string };
}

export interface EngraveTargetObjectRowProps {
  target: EngraveTargetObject;
  /** Row position; the target has one row, so this is always 0. */
  index: number;
  onChange: (patch: TargetObjectPatch) => void;
  onRemove: () => void;
  findings: readonly JobFinding[];
  /** #535 — the goal operation's defaults; absent on a reference row. */
  surface?: SurfaceDefaults;
  /** #535 — the last generated goal program's facts, or null before a Generate. */
  surfaceFacts?: GoalSurfaceFacts | null;
  /** #535 — set the job's cutter from the goal row. */
  onCutterChange?: (key: string) => void;
}

/** The cutter's own sentence: one cutter cuts both passes, and its shape decides the finish. */
function cutterSentence(cutter: SurfaceDefaults['cutter']): string {
  if (cutter === null) return 'One cutter cuts both passes. Choose a cutter.';
  if (cutter.shape === 'ball' || cutter.shape === 'bull') {
    return `One cutter cuts both passes. ${cutter.name} is a ${cutter.shape === 'ball' ? 'ball' : 'bull'} nose: its round tip follows the surface in the finishing pass.`;
  }
  return `One cutter cuts both passes. ${cutter.name} is a flat nose: its flat tip follows the surface in the finishing pass, so a curved surface finishes faceted.`;
}

/** One of the goal's four numbers, with its default and where the default lives. */
function SurfaceField({
  field,
  label,
  unit,
  title,
  index,
  value,
  fallback,
  sourceWords,
  min,
  onChange,
}: {
  field: keyof EngraveSurfaceSettings;
  label: string;
  unit: string;
  title: string;
  index: number;
  value: number | undefined;
  fallback: number | null;
  sourceWords: string;
  min: number;
  onChange: (value: number | undefined) => void;
}): JSX.Element {
  const shown = value ?? fallback;
  return (
    <div style={ROW_INLINE}>
      <label style={FIELD_LABEL}>
        <span>{label}</span>
        <input
          type="number"
          step="any"
          min={min}
          value={shown === null ? '' : Number(shown.toFixed(3))}
          disabled={fallback === null && value === undefined}
          data-testid={`engrave-target-surface-${field}-${index}`}
          aria-label={`Surface ${label}`}
          title={title}
          style={NUM}
          onChange={(e) => {
            const raw = e.target.value;
            // Clearing the box returns the number to its default: an absent key is the default.
            if (raw === '') {
              onChange(undefined);
              return;
            }
            const v = Number(raw);
            if (!Number.isFinite(v) || v < min) return;
            onChange(v);
          }}
        />
        <span>{unit}</span>
      </label>
      <span data-testid={`engrave-target-surface-${field}-source-${index}`} style={SOURCE_WORD}>
        {value !== undefined ? 'typed' : sourceWords}
      </span>
      {value !== undefined && (
        <button
          type="button"
          data-testid={`engrave-target-surface-${field}-reset-${index}`}
          aria-label={`Use the default ${label}`}
          title="Use the default again."
          onClick={() => onChange(undefined)}
        >
          ↺
        </button>
      )}
    </div>
  );
}

export function EngraveTargetObjectRow({
  target,
  index,
  onChange,
  onRemove,
  findings,
  surface,
  surfaceFacts = null,
  onCutterChange,
}: EngraveTargetObjectRowProps): JSX.Element {
  const size = target.size;
  const sizeText = `${Number(size.x.toFixed(2))}×${Number(size.y.toFixed(2))}×${Number(size.z.toFixed(2))} mm`;
  const goal = target.role === 'goal';
  const settings = target.surface ?? {};
  const feedsWords = surface?.feeds?.typed === true ? 'typed here' : 'the feeds row';

  const setSurface = (patch: Partial<EngraveSurfaceSettings>): void => onChange({ surface: patch });

  const positionNum = (axis: 'x' | 'y' | 'z'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={target.position[axis]}
        data-testid={`engrave-target-${axis}-${index}`}
        aria-label={`Target object ${axis.toUpperCase()}`}
        title={
          axis === 'z'
            ? "Height of the object's TOP above the stock's top face, mm. Z0 is the top face; a negative value sinks it into the blank."
            : `Centre of the object's bounding box in ${axis.toUpperCase()}, mm from the stock's front-left corner.`
        }
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { [axis]: v } });
        }}
      />
    </label>
  );

  return (
    <EngraveItemRow
      id={target.id}
      selectable
      prefix="engrave-target"
      index={index}
      glyph="◎"
      kindWord="Target object"
      typeLabel={goal ? 'Surface a mesh' : null}
      name={target.name}
      summary={sizeText}
      enabled={target.enabled}
      enabledTitle="A hidden target object stays in the job but is not drawn."
      removeTitle="Remove the target object."
      removeNoun="target object"
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
        <input
          type="text"
          value={target.name}
          data-testid={`engrave-target-name-${index}`}
          aria-label="Target object name"
          title="Shown in the job and in findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || target.name })}
        />
      </label>

      <p style={MUTED}>
        Imported {target.format.toUpperCase()} — embedded in the job ({target.sha256.slice(0, 12)}…).
        {goal
          ? ` The object is the goal: the shape to make, roughed and finished in 3D. Its size is ${sizeText}.`
          : ` The object is a reference, not a cut; its size is ${sizeText}.`}
      </p>

      <div style={ROW_INLINE}>
        {positionNum('x')}
        {positionNum('y')}
        {positionNum('z')}
        <label style={FIELD_LABEL}>
          <span>rot</span>
          <input
            type="number"
            step="any"
            value={target.rotation}
            data-testid={`engrave-target-rotation-${index}`}
            aria-label="Target object rotation"
            title="Degrees counter-clockwise about the object's Z axis, through its bbox centre."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ rotation: v });
            }}
          />
        </label>
      </div>

      {/* #535 — the goal operation's own numbers, behind the row's Technical fold. */}
      {goal && surface !== undefined && (
        <details data-testid={`engrave-target-technical-${index}`} style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>Technical</summary>
          <div style={{ marginTop: 4 }}>
            <label style={ROW_INLINE}>
              <span style={{ fontSize: 11, color: '#9aa4b0' }}>cutter</span>
              <select
                value={surface.cutter?.key ?? ''}
                data-testid={`engrave-target-surface-cutter-${index}`}
                aria-label="Surface cutter"
                title="The cutter this operation runs. One program has one tool, so the same cutter roughs and finishes."
                onChange={(e) => onCutterChange?.(e.target.value)}
              >
                {surface.cutter === null && (
                  <option value="" disabled>
                    Choose a cutter…
                  </option>
                )}
                {surface.cutters.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <p style={MUTED} data-testid={`engrave-target-surface-cutter-note-${index}`}>
              {cutterSentence(surface.cutter)}
            </p>

            <SurfaceField
              field="roughStepDownMm"
              label="roughing step-down"
              unit="mm"
              title="How deep each roughing Z layer steps, mm. Lighter layers leave less for the finishing pass."
              index={index}
              value={settings.roughStepDownMm}
              fallback={surface.feeds?.stepDown ?? null}
              sourceWords={feedsWords}
              min={0.01}
              onChange={(v) => setSurface({ roughStepDownMm: v })}
            />
            <SurfaceField
              field="roughStepOverMm"
              label="roughing step-over"
              unit="mm"
              title="The raster pitch between roughing scan lines, mm. It decides the ridges the finishing pass then removes."
              index={index}
              value={settings.roughStepOverMm}
              fallback={surface.feeds?.stepOver ?? null}
              sourceWords={feedsWords}
              min={0.01}
              onChange={(v) => setSurface({ roughStepOverMm: v })}
            />
            <SurfaceField
              field="finishStepOverMm"
              label="finishing step-over"
              unit="mm"
              title="The raster pitch between finishing scan lines, mm. The feeds row's step-over stands in for the 3D engagement number a bench cut measures."
              index={index}
              value={settings.finishStepOverMm}
              fallback={surface.feeds?.stepOver ?? null}
              sourceWords={feedsWords}
              min={0.01}
              onChange={(v) => setSurface({ finishStepOverMm: v })}
            />
            {/* #671 — the two extra finishing passes, each opt-in. Absent reads as off, which is
                the rough + parallel finish every pre-#671 job already cuts. */}
            <label style={ROW_INLINE}>
              <input
                type="checkbox"
                checked={settings.scallop === true}
                data-testid={`engrave-target-surface-scallop-${index}`}
                aria-label="Add a scallop pass"
                title="Also cut offset contours of the outline after the parallel finish, spaced so the step measured along the surface is the finishing step-over. It cleans the ridges the parallel finish leaves on slopes."
                onChange={(e) => setSurface({ scallop: e.target.checked ? true : undefined })}
              />
              <span style={{ fontSize: 11, color: '#9aa4b0' }}>scallop pass</span>
            </label>
            <label style={ROW_INLINE}>
              <input
                type="checkbox"
                checked={settings.pencil === true}
                data-testid={`engrave-target-surface-pencil-${index}`}
                aria-label="Add a pencil pass"
                title="Also run one pass along every concave crease after the scallop — the corners the finishing raster leaves proud."
                onChange={(e) => setSurface({ pencil: e.target.checked ? true : undefined })}
              />
              <span style={{ fontSize: 11, color: '#9aa4b0' }}>pencil pass</span>
            </label>
            {settings.pencil === true && (
              <SurfaceField
                field="pencilCreaseDeg"
                label="pencil crease"
                unit="°"
                title="The pencil pass follows creases where the surface's slope changes by more than this across one grid cell, degrees."
                index={index}
                value={settings.pencilCreaseDeg}
                fallback={DEFAULT_PENCIL_CREASE_DEG}
                sourceWords="the CAM’s default"
                min={1}
                onChange={(v) => setSurface({ pencilCreaseDeg: v })}
              />
            )}
            <SurfaceField
              field="gridPitchMm"
              label="grid pitch"
              unit="mm"
              title="The heightfield's sampling pitch on both axes, mm. Finer pitch follows detail and costs memory and time."
              index={index}
              value={settings.gridPitchMm}
              fallback={surface.gridPitch.value}
              sourceWords={shopSourceWords(surface.gridPitch.source)}
              min={0.02}
              onChange={(v) => setSurface({ gridPitchMm: v })}
            />
            <SurfaceField
              field="stockToLeaveMm"
              label="stock to leave"
              unit="mm"
              title="The stock the roughing pass leaves on the goal surface for the finishing pass, mm. Zero finishes straight off the roughing cut."
              index={index}
              value={settings.stockToLeaveMm}
              fallback={surface.stockToLeave.value}
              sourceWords={shopSourceWords(surface.stockToLeave.source)}
              min={0}
              onChange={(v) => setSurface({ stockToLeaveMm: v })}
            />

            {surfaceFacts !== null && (
              <p style={MUTED} data-testid={`engrave-target-surface-report-${index}`}>
                Last generated: {surfaceFacts.roughingLayers} roughing layer
                {surfaceFacts.roughingLayers === 1 ? '' : 's'} at{' '}
                {Number(surfaceFacts.stepDownMm.toFixed(3))} mm step-down and{' '}
                {Number(surfaceFacts.roughStepOverMm.toFixed(3))} mm step-over, leaving{' '}
                {Number(surfaceFacts.stockToLeaveMm.toFixed(3))} mm; finishing at{' '}
                {Number(surfaceFacts.finishStepOverMm.toFixed(3))} mm step-over
                {surfaceFacts.scallop == null
                  ? ''
                  : `, then a scallop pass on ${surfaceFacts.scallop.contours} contour${surfaceFacts.scallop.contours === 1 ? '' : 's'}`}
                {surfaceFacts.pencil == null
                  ? ''
                  : `, then a pencil pass on ${surfaceFacts.pencil.paths} crease${surfaceFacts.pencil.paths === 1 ? '' : 's'} at ${Number(surfaceFacts.pencil.creaseDeg.toFixed(0))}°`}
                .{' '}
                {surfaceFacts.resolutionNote.charAt(0).toUpperCase() + surfaceFacts.resolutionNote.slice(1)}.
              </p>
            )}
          </div>
        </details>
      )}
    </EngraveItemRow>
  );
}
