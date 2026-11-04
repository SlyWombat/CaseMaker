import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { DEFAULT_RELIEF_DEPTH_MM } from '@/engine/cnc/engrave/relief';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import {
  fitToStockScale,
  isUniform,
  placedSize,
  rotatedExtents,
  scaleForAxisSize,
  targetScale,
  targetTurns,
} from '@/engine/cnc/engrave/targetScale';
import {
  chooseLayFlat,
  describeTurn,
  LAY_FLAT_SUGGEST_RATIO,
  turnAboutAxis,
  turnsPatch,
  type FaceDirection,
} from '@/engine/cnc/engrave/goalOrientation';
import {
  goalUndersideCached,
  UNDERSIDE_CHOICES,
  undersideFor,
  undersideSentence,
} from '@/engine/cnc/engrave/goalUnderside';
import { rememberGoalPlacement, undoGoalPlacement, useGoalTransformUndo } from '@/store/goalTransformUndo';
import { useViewportStore } from '@/store/viewportStore';
import {
  centreInStockPatch,
  dropToFloorPatch,
  flushToTopPatch,
  goalFit,
  resetRotationPatch,
} from '@/engine/cnc/engrave/goalPlacement';
import type { TargetObjectPatch } from '@/store/engraveJobStore';
import { goalEdgeBreak, type EngraveTargetObject, type GoalUndersideKind } from '@/types/engraveJob';

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
      <MeshTurnControls target={target} index={index} onChange={onChange} stock={stock} locked={locked} />
    </div>
  );
}

/**
 * #876 — THE NUMERIC PLACEMENT PRESSES: Centre in stock, Drop to floor, Flush to top and Reset
 * rotation, each ONE document write and one undo entry, with the fit fact beneath them. A mould's
 * cavity always opens at the stock top, so its Z is not a placement: Drop and Flush are not
 * offered for one. Every press is at least 44 px so a phone finger can take it.
 */
function MeshPlacementActions({
  target,
  index,
  onChange,
  stock,
  mould,
}: {
  target: EngraveTargetObject;
  index: number;
  onChange: (patch: TargetObjectPatch) => void;
  stock: EngraveTargetObjectRowProps['stock'];
  mould: boolean;
}): JSX.Element {
  const write = (patch: TargetObjectPatch): void => {
    rememberGoalPlacement(target);
    onChange(patch);
  };
  const fit = stock === undefined ? null : goalFit(target, stock);
  const press = (testid: string, title: string, label: string, run: () => void): JSX.Element => (
    <button type="button" data-testid={testid} title={title} style={{ minHeight: 44, minWidth: 44 }} onClick={run}>
      {label}
    </button>
  );
  return (
    <div data-testid={`engrave-target-place-actions-${index}`} style={{ marginTop: 6 }}>
      <div style={ROW_INLINE}>
        {stock !== undefined &&
          press(`engrave-target-centre-${index}`, 'Centre the object’s bounding box in the stock.', 'Centre in stock', () =>
            write(centreInStockPatch(stock)),
          )}
        {stock !== undefined &&
          !mould &&
          press(`engrave-target-drop-${index}`, 'Drop the part until its bottom rests on the stock’s bottom face.', 'Drop to floor', () =>
            write(dropToFloorPatch(target, stock)),
          )}
        {stock !== undefined &&
          !mould &&
          press(`engrave-target-flush-${index}`, 'Set the part’s top flush with the stock’s top face.', 'Flush to top', () =>
            write(flushToTopPatch()),
          )}
        {press(`engrave-target-reset-rotation-${index}`, 'Put every turn back to 0°.', 'Reset rotation', () =>
          write(resetRotationPatch()),
        )}
      </div>
      {fit !== null && (
        <p style={MUTED} data-testid={`engrave-target-fit-said-${index}`}>
          {fit.sentence}
        </p>
      )}
    </div>
  );
}

const fmt1 = (n: number): string => `${Number(n.toFixed(1))}`;

/** A field has the keyboard: the arrow keys belong to it, not to the nudge (#876). */
function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * #831 — TURNING THE MESH TO FIT THE STOCK: the three angles (degrees, the stored "XYZ" turns), a
 * +90° button per stock axis, and "Lay it flat" — the shallowest of the 24 axis-aligned
 * orientations, re-fitted to the stock when the aspect is kept, stated in one line. A goal that
 * stands much deeper than it could lie gets the suggestion without being asked (the app proposes
 * the better choice). Every write here remembers the placement it replaced, so Undo puts it back.
 */
function MeshTurnControls({
  target,
  index,
  onChange,
  stock,
  locked,
}: {
  target: EngraveTargetObject;
  index: number;
  onChange: (patch: TargetObjectPatch) => void;
  stock?: EngraveTargetObjectRowProps['stock'];
  locked: boolean;
}): JSX.Element {
  const turns = targetTurns(target);
  const turnsKey = `${turns.x},${turns.y},${turns.z}`;
  const room =
    stock === undefined ? null : { x: stock.length - 2 * stock.edgeMargin, y: stock.width - 2 * stock.edgeMargin };
  const flat = chooseLayFlat(target, room);
  const suggest = flat.changes && flat.currentDepthMm >= LAY_FLAT_SUGGEST_RATIO * flat.depthMm;
  const [said, setSaid] = useState<{ id: string; key: string; text: string } | null>(null);
  const canUndo = useGoalTransformUndo(
    (s) => s.stack.length > 0 && s.stack[s.stack.length - 1]!.targetId === target.id,
  );
  // #876 — PLACE ON FACE: arm the viewport to take the click, with the direction the operator
  // chose. The press toggles; the picker disarms itself once a face is placed.
  const placeFace = useViewportStore((s) => s.placeFace);
  const armPlaceFace = useViewportStore((s) => s.armPlaceFace);
  const disarmPlaceFace = useViewportStore((s) => s.disarmPlaceFace);
  const armedDirection = placeFace !== null && placeFace.targetId === target.id ? placeFace.direction : null;
  const arm = (direction: FaceDirection): void => {
    if (armedDirection === direction) disarmPlaceFace();
    else armPlaceFace(target.id, direction);
  };
  const write = (patch: TargetObjectPatch): void => {
    rememberGoalPlacement(target);
    onChange(patch);
  };

  // #876 — ARROW KEYS NUDGE THE GOAL: 1 mm, and Shift 10 mm, in the stock's X/Y. Bound to the
  // window while the row is open (the row is the focus context, as the board's own nudge is), and
  // skipped while a field has focus so typing and stepping a number still work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.shiftKey ? 10 : 1;
      let patch: TargetObjectPatch;
      switch (e.key) {
        case 'ArrowLeft':
          patch = { position: { x: target.position.x - step } };
          break;
        case 'ArrowRight':
          patch = { position: { x: target.position.x + step } };
          break;
        case 'ArrowDown':
          patch = { position: { y: target.position.y - step } };
          break;
        case 'ArrowUp':
          patch = { position: { y: target.position.y + step } };
          break;
        default:
          return;
      }
      e.preventDefault();
      write(patch);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `write` reads the target being nudged and the row's own onChange; both change with `target`.
  }, [target, onChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const layFlat = (): void => {
    if (!flat.changes) {
      setSaid({
        id: target.id,
        key: turnsKey,
        text: `Already lying flat: ${fmt1(flat.depthMm)} mm deep is its shallowest.`,
      });
      return;
    }
    const patch: TargetObjectPatch = { ...turnsPatch(flat.turns) };
    let depth = flat.depthMm;
    let tail = '';
    if (locked && stock !== undefined) {
      const f = fitToStockScale(target.size, stock, stock.edgeMargin, flat.turns);
      if (f !== null) {
        patch.scale = { x: f, y: f, z: f };
        patch.position = { x: stock.length / 2, y: stock.width / 2, z: 0 };
        depth = rotatedExtents({ x: target.size.x * f, y: target.size.y * f, z: target.size.z * f }, flat.turns).z;
        tail = `, fitted to the stock at ${fmt1(f * 100)} %`;
      }
    }
    write(patch);
    setSaid({
      id: target.id,
      key: `${flat.turns.x},${flat.turns.y},${flat.turns.z}`,
      text: `${describeTurn(turns, flat.turns)}: ${fmt1(depth)} mm deep instead of ${fmt1(flat.currentDepthMm)} mm${tail}.`,
    });
  };

  const angleField = (axis: 'x' | 'y' | 'z'): JSX.Element => (
    <span key={axis} style={FIELD_LABEL}>
      <label style={FIELD_LABEL}>
        <span>about {axis.toUpperCase()}</span>
        <input
          type="number"
          step="any"
          value={turns[axis]}
          data-testid={axis === 'z' ? `engrave-target-rotation-${index}` : `engrave-target-rotation-${axis}-${index}`}
          aria-label={axis === 'z' ? 'Target object rotation' : `Target object rotation about ${axis.toUpperCase()}`}
          title={`Degrees about the object's ${axis.toUpperCase()} axis through its centre. The three turns apply Z first, then Y, then X.`}
          style={NUM}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            // 0 about X or Y is written as the absence of the field, so an untouched document
            // round-trips without gaining a key.
            if (axis === 'z') onChange({ rotation: v });
            else if (axis === 'x') onChange({ rotationX: v === 0 ? undefined : v });
            else onChange({ rotationY: v === 0 ? undefined : v });
          }}
        />
        <span>°</span>
      </label>
      <button
        type="button"
        data-testid={`engrave-target-turn-${axis}-${index}`}
        aria-label={`Turn 90° about ${axis.toUpperCase()}`}
        title={`Turn the object a quarter turn about the stock's ${axis.toUpperCase()} axis, through its centre.`}
        onClick={() => write(turnsPatch(turnAboutAxis(turns, axis, 90)))}
      >
        +90°
      </button>
    </span>
  );

  return (
    <div data-testid={`engrave-target-turn-${index}`}>
      <div style={ROW_INLINE}>
        <span style={{ fontSize: 11, color: '#9aa4b0' }}>turn</span>
        {angleField('x')}
        {angleField('y')}
        {angleField('z')}
      </div>
      <div style={ROW_INLINE}>
        <button
          type="button"
          data-testid={`engrave-target-layflat-${index}`}
          title="Turn the object to whichever of its 24 square-on orientations stands lowest over the stock; ties go to the one that best fits the blank. With the aspect kept, it is then fitted to the stock."
          onClick={layFlat}
        >
          Lay it flat
        </button>
        {canUndo && (
          <button
            type="button"
            data-testid={`engrave-target-turn-undo-${index}`}
            title="Put back the turn, place and size from before the last turn, move or fit."
            onClick={() => {
              undoGoalPlacement();
              setSaid(null);
            }}
          >
            Undo
          </button>
        )}
      </div>
      {/* #876 — the face choice is made where the faces are; this press arms the viewport and
          says which way the picked face goes. 44 px so a phone finger can take it. */}
      <div style={ROW_INLINE}>
        <span style={{ fontSize: 11, color: '#9aa4b0' }}>place on face</span>
        {(['down', 'up'] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            data-testid={`engrave-target-place-${direction}-${index}`}
            aria-pressed={armedDirection === direction}
            title={
              direction === 'down'
                ? 'Pick a face in the 3D view: it becomes the bottom of the part.'
                : 'Pick a face in the 3D view: it becomes the top, the face machined first.'
            }
            style={{ minHeight: 44, minWidth: 44 }}
            onClick={() => arm(direction)}
          >
            {direction === 'down' ? 'Face down' : 'Face up first'}
          </button>
        ))}
      </div>
      {armedDirection !== null && (
        <p style={MUTED} data-testid={`engrave-target-place-armed-${index}`}>
          {armedDirection === 'down'
            ? 'Click a face in the 3D view: it goes face down, at the bottom of the part.'
            : 'Click a face in the 3D view: it goes face up, the face machined first.'}
        </p>
      )}
      {said !== null && said.id === target.id && said.key === turnsKey ? (
        <p style={MUTED} data-testid={`engrave-target-layflat-said-${index}`}>
          {said.text}
        </p>
      ) : (
        suggest && (
          <p style={MUTED} data-testid={`engrave-target-layflat-suggest-${index}`}>
            {`It stands ${fmt1(flat.currentDepthMm)} mm tall; laid flat it would be ${fmt1(flat.depthMm)} mm deep. Press Lay it flat.`}
          </p>
        )
      )}
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

export function EngraveTargetObjectRow({
  target,
  index,
  onChange,
  onRemove,
  findings,
  surface,
  relief = null,
  onCutterChange,
  stock,
}: EngraveTargetObjectRowProps): JSX.Element {
  // #722 — the row states the PLACED size (the file's bbox times the scale).
  const size = placedSize(target);
  const sizeText = `${Number(size.x.toFixed(2))}×${Number(size.y.toFixed(2))}×${Number(size.z.toFixed(2))} mm`;
  const goal = target.role === 'goal';
  // #774 — a STEP target is stored as the mesh the CAD kernel tessellated it into. The name is the
  // file the operator picked (and may be edited later), so what is EMBEDDED is still `format`; the
  // sentence says both truths rather than calling a .step file an STL.
  const convertedFromStep = /\.(step|stp)$/i.test(target.name);
  // #721 — a mold's cavity opens at the stock top, so its Z is not a placement.
  const moldGoal = goal && target.goalMode === 'mold' && target.format !== 'png';
  // #898 — the underside control (a part goal only) and, when nothing is chosen, the app's own
  // reading of the mesh. Cached on the mesh's facts, so a render does not re-measure it.
  const showsUnderside = goal && target.format !== 'png' && target.goalMode !== 'mold';
  const undersideOffer = showsUnderside ? goalUndersideCached(target) : null;
  const undersideChosen = showsUnderside ? undersideSentence(target) : null;


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
              ? "A mould's cavity always opens at the stock's top face, so its height is not used."
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
        {convertedFromStep
          ? 'Imported STEP — read by the CAD kernel and embedded in the job as a mesh'
          : `Imported ${target.format.toUpperCase()} — embedded in the job`}{' '}
        ({target.sha256.slice(0, 12)}…).
        {goal
          ? target.goalMode === 'mold' && target.format !== 'png'
            ? ` The object is the goal, made as a MOULD: its shape is cut as a cavity to cast it in, ${fmt(size.z)} mm deep. Its size is ${sizeText}.`
            : ` The object is the goal: the shape to make, roughed and finished in 3D. Its size is ${sizeText}.`
          : ` The object is a reference, not a cut; its size is ${sizeText}.`}
      </p>

      <div style={ROW_INLINE}>
        {positionNum('x')}
        {positionNum('y')}
        {positionNum('z')}
        {/* A picture turns about Z only; a mesh's three turns sit with its size (#831). */}
        {target.format === 'png' && (
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
        )}
      </div>

      {/* #721 — what the goal makes: the part, or a mold to cast it in. A picture is a relief only. */}
      {goal && target.format !== 'png' && (
        <label style={ROW_INLINE}>
          <span style={{ fontSize: 11, color: '#9aa4b0' }}>make</span>
          <select
            value={target.goalMode === 'mold' ? 'mold' : 'item'}
            data-testid={`engrave-target-goal-mode-${index}`}
            aria-label="What the goal makes"
            title="Make the part (material is removed down to its surface), or a mould of it (its shape is cut as a cavity to cast it in)."
            onChange={(e) => onChange({ goalMode: e.target.value === 'mold' ? 'mold' : undefined })}
          >
            <option value="item">Make the part</option>
            <option value="mold">Make a mould of it</option>
          </select>
        </label>
      )}

      {/* #966 — WHAT IS CLEARED AROUND A GOAL is the model engine's own decision now (the plan
          clears around the part as part of its sequence); the old per-job switch had one reader,
          the retired heightfield engine. */}

      {/* #898 — WHERE THE PART'S UNDERSIDE COMES FROM. Nothing chosen is today's cut (the mesh's
          own depth); the app proposes one of the three from the mesh — its flat bottom's share of
          the footprint, or the area that faces down above it — and the operator's press stores
          the choice. The sentence under it says what the chosen kind does. */}
      {showsUnderside && (
        <>
          <label style={ROW_INLINE}>
            <span style={{ fontSize: 11, color: '#9aa4b0' }}>underside</span>
            <select
              value={target.underside?.kind ?? ''}
              data-testid={`engrave-target-underside-${index}`}
              aria-label="Where the part’s underside comes from"
              title="How the part's underside is made: stop at its own flat bottom (one setup), cut it from both sides with holding tabs, or leave a plinth. Not chosen is the cut as the mesh is."
              onChange={(e) => {
                const kind = e.target.value;
                onChange({
                  underside:
                    kind === ''
                      ? undefined
                      : undersideFor(kind as GoalUndersideKind, target.underside),
                });
              }}
            >
              <option value="">
                {undersideOffer === null ? 'not chosen' : `not chosen — the app proposes ${UNDERSIDE_CHOICES.find((c) => c.kind === undersideOffer.kind)?.label ?? undersideOffer.kind}`}
              </option>
              {UNDERSIDE_CHOICES.map((choice) => (
                <option key={choice.kind} value={choice.kind}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          {undersideChosen !== null ? (
            <p data-testid={`engrave-target-underside-why-${index}`} style={MUTED}>
              {undersideChosen}
            </p>
          ) : undersideOffer !== null ? (
            <p data-testid={`engrave-target-underside-why-${index}`} style={MUTED}>
              The mesh reads as {UNDERSIDE_CHOICES.find((c) => c.kind === undersideOffer.kind)?.label ?? undersideOffer.kind}: {undersideOffer.reason}.
            </p>
          ) : null}
        </>
      )}

      {/* #829/#963 — CHAMFER THE PART'S EDGES: a V-bit follows the mesh's top rim after the
          surfacing program. The width is the job's stated EDGE BREAK (`edgeBreak`, which the
          gate's allowance also reads); the engine chooses the V-bit by cost, so nothing is picked
          here. A mold's rim is a later slice. */}
      {goal && target.format !== 'png' && target.goalMode !== 'mold' && (
        <label style={ROW_INLINE}>
          <span style={{ fontSize: 11, color: '#9aa4b0' }}>chamfer the edges</span>
          <input
            type="number"
            min={0}
            step={0.1}
            style={{ width: 64 }}
            data-testid={`engrave-target-chamfer-${index}`}
            aria-label="Chamfer the part’s edges: the bevel’s width in millimetres"
            title="Bevel the part’s top edges with a V-bit after the part is surfaced; the engine chooses the V-bit. Leave it empty for square edges."
            value={goalEdgeBreak(target)?.widthMm ?? ''}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const mm = Number(raw);
              const next = raw === '' || !(mm > 0) ? undefined : { ...(goalEdgeBreak(target) ?? { widthMm: mm }), widthMm: mm };
              // shortcut: both names are written while the pre-#966 engine still reads `chamfer`;
              // #966 drops the mirror and the alias together.
              onChange({ edgeBreak: next, chamfer: next === undefined ? undefined : { ...next } });
            }}
          />
          <span style={{ fontSize: 11, color: '#9aa4b0' }}>mm</span>
        </label>
      )}

      {/* #722 — a mesh's size on the blank; a picture keeps its own width field below. */}
      {target.format !== 'png' && (
        <>
          <MeshSizeControls target={target} index={index} onChange={onChange} stock={stock} />
          {/* #876 — the numeric placement presses and the fit fact. */}
          <MeshPlacementActions target={target} index={index} onChange={onChange} stock={stock} mould={moldGoal} />
        </>
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

            {/* #966 — THE OLD ENGINE'S OWN NUMBERS ARE GONE. The step-down, step-over, sampling
                grid, scallop/pencil passes, stock to leave and the "Last generated" sentence all
                described the retired heightfield planner; the plan block states the model engine's
                own sequence and numbers. */}
          </div>
        </details>
      )}
    </EngraveItemRow>
  );
}
