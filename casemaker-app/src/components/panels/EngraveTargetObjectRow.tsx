import { useState, type CSSProperties, type JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { DEFAULT_PENCIL_CREASE_DEG, type GoalSurfaceFacts } from '@/engine/cnc/cam/surface3d';
import { DEFAULT_RELIEF_DEPTH_MM } from '@/engine/cnc/cam/relief';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import {
  fitToStockScale,
  isUniform,
  placedSize,
  scaleForAxisSize,
  targetScale,
  targetTurns,
} from '@/engine/cnc/engrave/targetScale';
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

/** `2` / `0.5` — a number as a sentence uses it. */
const fmt = (n: number): string => `${Number(n.toFixed(3))}`;

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

/**
 * #672 — a picture goal's numbers, as the row states them: the pixel size (decoded by the panel),
 * the resolved relief depth and where it came from, the direction, and the two lengths the
 * resolution sentence compares the picture's pixel pitch with.
 */
export interface ReliefRowFacts {
  pixels: { width: number; height: number } | null;
  depth: { value: number; source: string };
  typed: boolean;
  invert: boolean;
  gridPitch: { value: number; source: string };
  cutterDiameter: number | null;
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
  /** #672 — a PNG goal's relief facts; absent on a mesh or a reference. */
  relief?: ReliefRowFacts | null;
  /**
   * #722 — the blank a mesh is fitted to: its size and the job's edge margin, mm. Absent hides
   * "Fit to the stock" (the row then still scales by hand).
   */
  stock?: { length: number; width: number; thickness: number; edgeMargin: number };
}

const AXIS_WORD = { x: 'width', y: 'length', z: 'height' } as const;

/**
 * #722 — a mesh's size on the blank: the placed width, length and height (mm), one percent, the
 * aspect lock, and Fit to the stock. Every field writes the ONE `scale` the readers apply.
 */
function MeshSizeControls({
  target,
  index,
  onChange,
  stock,
}: {
  target: EngraveTargetObject;
  index: number;
  onChange: (patch: TargetObjectPatch) => void;
  stock?: EngraveTargetObjectRowProps['stock'];
}): JSX.Element {
  const scale = targetScale(target);
  const placed = placedSize(target);
  const uniform = isUniform(scale);
  // The lock follows the object: a different target (or a reload) starts from its own scale, so a
  // stretched document is never silently collapsed by the next width typed.
  const [lock, setLock] = useState<{ id: string; locked: boolean }>(() => ({ id: target.id, locked: uniform }));
  const locked = lock.id === target.id ? lock.locked : uniform;
  const setLocked = (next: boolean): void => setLock({ id: target.id, locked: next });
  const fit =
    stock === undefined ? null : fitToStockScale(target.size, stock, stock.edgeMargin, targetTurns(target));

  const axisField = (axis: 'x' | 'y' | 'z'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{AXIS_WORD[axis]}</span>
      <input
        type="number"
        step="any"
        min={0.001}
        value={Number(placed[axis].toFixed(3))}
        data-testid={`engrave-target-size-${axis}-${index}`}
        aria-label={`Target object ${AXIS_WORD[axis]}`}
        title={
          locked
            ? `The object's ${AXIS_WORD[axis]} on the blank, mm. The other two follow (aspect locked).`
            : `The object's ${AXIS_WORD[axis]} on the blank, mm. Only this direction changes (aspect unlocked).`
        }
        style={NUM}
        onChange={(e) => {
          const next = scaleForAxisSize(scale, target.size, axis, Number(e.target.value), locked);
          if (next !== null) onChange({ scale: next });
        }}
      />
      <span>mm</span>
    </label>
  );

  return (
    <div data-testid={`engrave-target-size-${index}`}>
      <div style={ROW_INLINE}>
        {axisField('x')}
        {axisField('y')}
        {axisField('z')}
      </div>
      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <span>scale</span>
          <input
            type="number"
            step="any"
            min={0.1}
            value={uniform ? Number((scale.x * 100).toFixed(3)) : ''}
            placeholder={uniform ? undefined : 'mixed'}
            data-testid={`engrave-target-scale-${index}`}
            aria-label="Target object scale"
            title="One scale for all three directions, % of the file's own size."
            style={NUM}
            onChange={(e) => {
              const pct = Number(e.target.value);
              if (!Number.isFinite(pct) || pct <= 0) return;
              const f = pct / 100;
              onChange({ scale: { x: f, y: f, z: f } });
              setLocked(true);
            }}
          />
          <span>%</span>
        </label>
        <label style={FIELD_LABEL} title="Locked, one size field scales all three directions; unlocked, it stretches only its own.">
          <input
            type="checkbox"
            checked={locked}
            data-testid={`engrave-target-aspect-${index}`}
            aria-label="Keep the aspect"
            onChange={(e) => setLocked(e.target.checked)}
          />
          <span>keep the aspect</span>
        </label>
        {stock !== undefined && (
          <button
            type="button"
            data-testid={`engrave-target-fit-${index}`}
            disabled={fit === null}
            title={
              fit === null
                ? 'The blank less its edge margin leaves no room to fit the object.'
                : 'The largest same-in-every-direction size that fits inside the blank less its edge margin, as the object is turned, no taller than the blank; centred on the blank with its top at the top face.'
            }
            onClick={() => {
              if (fit === null) return;
              onChange({
                scale: { x: fit, y: fit, z: fit },
                position: { x: stock!.length / 2, y: stock!.width / 2, z: 0 },
              });
              setLocked(true);
            }}
          >
            Fit to the stock
          </button>
        )}
        {uniform && scale.x === 1 ? null : (
          <button
            type="button"
            data-testid={`engrave-target-scale-reset-${index}`}
            aria-label="Use the file's own size"
            title="Back to the file's own size (100 %)."
            onClick={() => {
              onChange({ scale: null });
              setLocked(true);
            }}
          >
            ↺
          </button>
        )}
      </div>
      <p style={MUTED} data-testid={`engrave-target-size-note-${index}`}>
        {`On the blank it is ${fmt(placed.x)} × ${fmt(placed.y)} × ${fmt(placed.z)} mm`}
        {uniform
          ? scale.x === 1
            ? ' — the file’s own size.'
            : ` — ${fmt(scale.x * 100)} % of the file’s ${fmt(target.size.x)} × ${fmt(target.size.y)} × ${fmt(target.size.z)} mm.`
          : ` — stretched: ${fmt(scale.x * 100)} % × ${fmt(scale.y * 100)} % × ${fmt(scale.z * 100)} % of the file’s ${fmt(target.size.x)} × ${fmt(target.size.y)} × ${fmt(target.size.z)} mm.`}
      </p>
    </div>
  );
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
  relief = null,
  onCutterChange,
  stock,
}: EngraveTargetObjectRowProps): JSX.Element {
  // #722 — the row states the PLACED size (the file's bbox times the scale).
  const size = placedSize(target);
  const sizeText = `${Number(size.x.toFixed(2))}×${Number(size.y.toFixed(2))}×${Number(size.z.toFixed(2))} mm`;
  const goal = target.role === 'goal';
  // #721 — a mold's cavity opens at the stock top, so its Z is not a placement.
  const moldGoal = goal && target.goalMode === 'mold' && target.format !== 'png';
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
            ? moldGoal
              ? "A mold's cavity always opens at the stock's top face, so its height is not used."
              : "Height of the object's TOP above the stock's top face, mm. Z0 is the top face; a negative value sinks it into the blank."
            : `Centre of the object's bounding box in ${axis.toUpperCase()}, mm from the stock's front-left corner.`
        }
        disabled={axis === 'z' && moldGoal}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { [axis]: v } });
        }}
      />
      <span>mm</span>
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
          ? target.goalMode === 'mold' && target.format !== 'png'
            ? ` The object is the goal, made as a MOLD: its shape is cut as a cavity to cast it in, ${fmt(size.z)} mm deep. Its size is ${sizeText}.`
            : ` The object is the goal: the shape to make, roughed and finished in 3D. Its size is ${sizeText}.`
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
          <span>°</span>
        </label>
        {/* #723 part 2 — turns about X and Y: how the operator orients a part for a side that is
            not reached from the top. Applied after Z, before Y and X; absent is 0. */}
        {(['x', 'y'] as const).map((axis) => (
          <label key={axis} style={FIELD_LABEL}>
            <span>rot {axis.toUpperCase()}</span>
            <input
              type="number"
              step="any"
              value={axis === 'x' ? (target.rotationX ?? 0) : (target.rotationY ?? 0)}
              data-testid={`engrave-target-rotation-${axis}-${index}`}
              aria-label={`Target object rotation about ${axis.toUpperCase()}`}
              title={`Degrees about the object's ${axis.toUpperCase()} axis through its bbox centre, applied after Z (absent = 0). Turn a part 180 about X to cut its other side.`}
              style={NUM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                // 0 is written as the absence of the field, so an untouched document round-trips
                // without gaining a key.
                if (axis === 'x') onChange({ rotationX: v === 0 ? undefined : v });
                else onChange({ rotationY: v === 0 ? undefined : v });
              }}
            />
            <span>°</span>
          </label>
        ))}
      </div>

      {/* #721 — what the goal makes: the part, or a mold to cast it in. A picture is a relief only. */}
      {goal && target.format !== 'png' && (
        <label style={ROW_INLINE}>
          <span style={{ fontSize: 11, color: '#9aa4b0' }}>make</span>
          <select
            value={target.goalMode === 'mold' ? 'mold' : 'item'}
            data-testid={`engrave-target-goal-mode-${index}`}
            aria-label="What the goal makes"
            title="Make the part (material is removed down to its surface), or a mold of it (its shape is cut as a cavity to cast it in)."
            onChange={(e) => onChange({ goalMode: e.target.value === 'mold' ? 'mold' : undefined })}
          >
            <option value="item">Make the part</option>
            <option value="mold">Make a mold of it</option>
          </select>
        </label>
      )}

      {/* #764 — WHAT IS CLEARED AROUND AN ITEM GOAL. The goal is cut only inside its own footprint
          otherwise, so the blank round it keeps its height and the part ends in a pit. The default
          ring is one cutter diameter wide; a mold's rim is the stock top, so a mold has no choice. */}
      {goal && target.format !== 'png' && target.goalMode !== 'mold' && (
        <label style={ROW_INLINE}>
          <span style={{ fontSize: 11, color: '#9aa4b0' }}>clear around</span>
          <select
            value={settings.clearAround ?? 'ring'}
            data-testid={`engrave-target-clear-around-${index}`}
            aria-label="Clear around the goal"
            title="Cut the stock around the part down to the part's base plane, so the part is not left in a pit: a band one cutter diameter wide (the default), the whole blank, or nothing."
            onChange={(e) =>
              setSurface({
                clearAround: e.target.value === 'ring' ? undefined : (e.target.value as 'whole' | 'none'),
              })
            }
          >
            <option value="ring">a ring around it</option>
            <option value="whole">the whole blank</option>
            <option value="none">nothing</option>
          </select>
        </label>
      )}

      {/* #722 — a mesh's size on the blank; a picture keeps its own width field below. */}
      {target.format !== 'png' && (
        <MeshSizeControls target={target} index={index} onChange={onChange} stock={stock} />
      )}

      {/* #535 — the goal operation's own numbers, behind the row's Technical fold. */}
      {goal && surface !== undefined && (
        <details data-testid={`engrave-target-technical-${index}`} style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>Technical</summary>
          <div style={{ marginTop: 4 }}>
            {/* #672 — A PICTURE RELIEF: the map's two numbers and the resolution the picture can
                hold. The pixels are the panel's decode of the embedded PNG; the depth says where
                its default came from; the sentence states the pixel pitch against the grid and
                the cutter, because a 100 px image is not a 0.05 mm relief. */}
            {relief != null && (
              <div data-testid={`engrave-target-relief-${index}`}>
                <div style={ROW_INLINE}>
                  <label style={FIELD_LABEL}>
                    <span>relief depth</span>
                    <input
                      type="number"
                      step="any"
                      min={0.01}
                      value={Number(relief.depth.value.toFixed(3))}
                      data-testid={`engrave-target-relief-depth-${index}`}
                      aria-label="Relief depth"
                      title="The deepest relief cut below the image's top face, mm."
                      style={NUM}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v) || v <= 0) return;
                        onChange({ relief: { maxDepthMm: v }, size: { ...target.size, z: v } });
                      }}
                    />
                    <span>mm</span>
                  </label>
                  <span data-testid={`engrave-target-relief-depth-source-${index}`} style={SOURCE_WORD}>
                    {relief.typed ? 'typed' : relief.depth.source}
                  </span>
                  {relief.typed && (
                    <button
                      type="button"
                      data-testid={`engrave-target-relief-depth-reset-${index}`}
                      aria-label="Use the default relief depth"
                      title="Use the default again."
                      onClick={() =>
                        onChange({
                          relief: { maxDepthMm: undefined },
                          size: { ...target.size, z: DEFAULT_RELIEF_DEPTH_MM },
                        })
                      }
                    >
                      ↺
                    </button>
                  )}
                </div>
                <label style={ROW_INLINE}>
                  <span style={{ fontSize: 11, color: '#9aa4b0' }}>top face</span>
                  <select
                    value={relief.invert ? 'black' : 'white'}
                    data-testid={`engrave-target-relief-invert-${index}`}
                    aria-label="Relief direction"
                    title="Which end of the picture's tones sits at the top face: white as drawn, or black (inverted)."
                    onChange={(e) => onChange({ relief: { invert: e.target.value === 'black' ? true : undefined } })}
                  >
                    <option value="white">white (the picture as drawn)</option>
                    <option value="black">black (inverted)</option>
                  </select>
                </label>
                <label style={ROW_INLINE}>
                  <span style={{ fontSize: 11, color: '#9aa4b0' }}>width</span>
                  <input
                    type="number"
                    step="any"
                    min={1}
                    value={Number(target.size.x.toFixed(3))}
                    data-testid={`engrave-target-relief-width-${index}`}
                    aria-label="Relief width"
                    title="The picture's placed width on the blank, mm. The height follows the picture's aspect."
                    style={NUM}
                    onChange={(e) => {
                      const w = Number(e.target.value);
                      if (!Number.isFinite(w) || w <= 0) return;
                      const aspect = target.size.y / target.size.x;
                      onChange({ size: { x: w, y: w * aspect, z: target.size.z } });
                    }}
                  />
                  <span>mm</span>
                </label>
                <p style={MUTED} data-testid={`engrave-target-relief-resolution-${index}`}>
                  {relief.pixels === null
                    ? 'The picture could not be read, so its pixel size is unknown.'
                    : `${relief.pixels.width} × ${relief.pixels.height} px over ${fmt(target.size.x)} × ${fmt(target.size.y)} mm — ` +
                      `${fmt(Math.max(target.size.x / relief.pixels.width, target.size.y / relief.pixels.height))} mm per pixel; ` +
                      `the grid samples at ${fmt(relief.gridPitch.value)} mm` +
                      (relief.cutterDiameter === null ? '' : ` and the cutter is ⌀${fmt(relief.cutterDiameter)} mm`) +
                      '.'}
                </p>
              </div>
            )}
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
