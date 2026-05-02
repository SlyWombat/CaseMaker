import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { listBuiltinDisplayIds } from '@/library/displays';
import { newId } from '@/utils/id';
import type { AntennaType } from '@/types/antenna';
import type { FanSize, CaseFace, FanGrille } from '@/types/fan';
import type { TextLabel } from '@/types/textLabel';
import type { BarbType } from '@/types/snap';
import { BARB_TYPES } from '@/types/snap';
import type { DisplayFraming } from '@/types/display';

/**
 * Issue #49 — combined panel exposing the six engine domains that previously
 * had no UI: antennas, fan mounts, text labels, mounting features, display,
 * snap catches. Plus the lid-recess toggle. Each section is a list with
 * enable / remove / patch and an "add" button using sensible defaults.
 *
 * Per-feature detailed parameters (XYZ positions, fonts, antenna sub-types,
 * etc.) remain editable via JSON until per-domain dedicated panels land;
 * this gives every feature a first-class affordance instead of leaving them
 * unreachable.
 *
 * Issue #89 — every input now carries a visible label or aria-label and a
 * descriptive title= tooltip.
 */

const FAN_SIZES: FanSize[] = ['30x30x10', '40x40x10', '40x40x20', '50x50x10', '60x60x15'];
const CASE_FACES: CaseFace[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const FAN_GRILLES: FanGrille[] = ['cross', 'spiral', 'honeycomb', 'concentric', 'open'];
const ANTENNA_TYPES: AntennaType[] = ['internal', 'rpi-external', 'external-mount'];
// Issue #95 (Phase 4c) — SNAP_WALLS / BARB_TYPES moved to SnapCatchDetail
// in SelectionPanel since the row no longer renders inline editors.
const DISPLAY_FRAMINGS: DisplayFraming[] = ['top-window', 'recessed-bezel'];

// Stable empty-array constants to avoid Zustand snapshot churn — selectors
// returning `?? []` would create a new [] every render and trigger
// "getSnapshot should be cached" → infinite re-render loops.
const EMPTY_ANTENNAS: import('@/types/antenna').AntennaPlacement[] = [];
const EMPTY_FANS: import('@/types/fan').FanMount[] = [];
const EMPTY_LABELS: import('@/types/textLabel').TextLabel[] = [];
const EMPTY_FEATURES: import('@/types/mounting').MountingFeature[] = [];
const EMPTY_CATCHES: import('@/types/snap').SnapCatch[] = [];
const EMPTY_CUTOUTS: import('@/types').CustomCutout[] = [];
const CUTOUT_FACES: import('@/types').CutoutFace[] = ['top', 'bottom', 'front', 'back', 'left', 'right'];
const CUTOUT_SHAPES: import('@/types').CustomCutoutShape[] = ['rect', 'round', 'slot'];

export function FeaturesPanel() {
  return (
    <div className="panel">
      <h3>Features</h3>
      <DisplaySection />
      <AntennasSection />
      <FansSection />
      <TextLabelsSection />
      <MountingSection />
      <CustomCutoutsSection />
      <SnapCatchesSection />
    </div>
  );
}

function DisplaySection() {
  const display = useProjectStore((s) => s.project.display);
  const setDisplay = useProjectStore((s) => s.setDisplay);
  const patchDisplay = useProjectStore((s) => s.patchDisplay);
  const ids = listBuiltinDisplayIds();

  return (
    <section className="features-section">
      <h4>Display</h4>
      <label className="cell-label" style={{ display: 'flex', width: '100%' }}>
        <span className="cell-label__axis">module</span>
        <select
          value={display?.displayId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setDisplay(v === '' ? null : v);
          }}
          data-testid="display-select"
          aria-label="Display module"
          title="Pick a built-in display module to add a window/cutout to the case."
        >
          <option value="">— none —</option>
          {ids.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      {display && (
        <div className="features-row">
          <label title="Toggle whether the display window is cut into the case.">
            <input
              type="checkbox"
              checked={display.enabled}
              onChange={(e) => patchDisplay({ enabled: e.target.checked })}
              data-testid="display-enabled"
              aria-label="Display enabled"
              title="Toggle the display cutout on/off."
            />
            enabled
          </label>
          <select
            value={display.framing}
            onChange={(e) => patchDisplay({ framing: e.target.value as DisplayFraming })}
            data-testid="display-framing"
            aria-label="Display framing"
            title="Framing style — top-window cuts a hole, recessed-bezel adds a sunken bezel."
          >
            {DISPLAY_FRAMINGS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}

function AntennasSection() {
  const antennas = useProjectStore((s) => s.project.antennas) ?? EMPTY_ANTENNAS;
  const addAntenna = useProjectStore((s) => s.addAntenna);
  const removeAntenna = useProjectStore((s) => s.removeAntenna);
  const patchAntenna = useProjectStore((s) => s.patchAntenna);

  return (
    <section className="features-section">
      <h4>
        Antennas
        <button
          onClick={() =>
            addAntenna({
              id: `antenna-${newId()}`,
              type: 'external-mount',
              enabled: true,
              facing: '+y',
              uOffset: 20,
            })
          }
          data-testid="add-antenna"
          className="features-add"
          title="Add a new antenna placement (defaults to external SMA mount on +y face)."
        >
          + add
        </button>
      </h4>
      {antennas.length === 0 && <p className="features-empty">No antennas.</p>}
      {antennas.map((a) => (
        <div key={a.id} className="features-row">
          <input
            type="checkbox"
            checked={a.enabled}
            onChange={(e) => patchAntenna(a.id, { enabled: e.target.checked })}
            data-testid={`antenna-${a.id}-enabled`}
            aria-label={`Antenna ${a.id} enabled`}
            title="Toggle this antenna on/off."
          />
          <select
            value={a.type}
            onChange={(e) => patchAntenna(a.id, { type: e.target.value as AntennaType })}
            aria-label={`Antenna ${a.id} type`}
            title="Antenna type — internal pad, RPi-external coax, or panel-mount SMA."
          >
            {ANTENNA_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={a.facing ?? '+y'}
            onChange={(e) => patchAntenna(a.id, { facing: e.target.value as '+x' | '-x' | '+y' | '-y' })}
            aria-label={`Antenna ${a.id} facing`}
            title="Which case face the antenna points out of."
          >
            {(['+x', '-x', '+y', '-y'] as const).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <label className="cell-label" style={{ flex: 0 }} title="Position along the chosen face (mm from the lower-corner end). Adjust to move the antenna hole left/right along the wall — defaults to the on-board connector position when known.">
            <span className="cell-label__axis">u</span>
            <input
              type="number"
              step={1}
              min={0}
              value={a.uOffset ?? 0}
              onChange={(e) => patchAntenna(a.id, { uOffset: Number(e.target.value) })}
              className="numeric-input"
              style={{ width: 60 }}
              data-testid={`antenna-${a.id}-uoffset`}
              aria-label={`Antenna ${a.id} u offset (mm)`}
            />
          </label>
          <button
            onClick={() => removeAntenna(a.id)}
            data-testid={`remove-antenna-${a.id}`}
            title="Remove this antenna"
            aria-label={`Remove antenna ${a.id}`}
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

function FansSection() {
  const fans = useProjectStore((s) => s.project.fanMounts) ?? EMPTY_FANS;
  const addFanMount = useProjectStore((s) => s.addFanMount);
  const removeFanMount = useProjectStore((s) => s.removeFanMount);
  const patchFanMount = useProjectStore((s) => s.patchFanMount);

  return (
    <section className="features-section">
      <h4>
        Fan mounts
        <button
          onClick={() => addFanMount('40x40x10', '+z')}
          data-testid="add-fan"
          className="features-add"
          title="Add a 40×40×10 fan mount on the lid (+z face) — change size/face after."
        >
          + add
        </button>
      </h4>
      {fans.length === 0 && <p className="features-empty">No fans.</p>}
      {fans.map((f) => (
        <div key={f.id} className="features-row">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => patchFanMount(f.id, { enabled: e.target.checked })}
            aria-label={`Fan ${f.id} enabled`}
            title="Toggle this fan mount on/off."
          />
          <select
            value={f.size}
            onChange={(e) => patchFanMount(f.id, { size: e.target.value as FanSize })}
            aria-label={`Fan ${f.id} size`}
            title="Fan size — width × height × thickness in mm."
          >
            {FAN_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={f.face}
            onChange={(e) => patchFanMount(f.id, { face: e.target.value as CaseFace })}
            aria-label={`Fan ${f.id} face`}
            title="Which case face the fan mounts on."
          >
            {CASE_FACES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={f.grille}
            onChange={(e) => patchFanMount(f.id, { grille: e.target.value as FanGrille })}
            aria-label={`Fan ${f.id} grille`}
            title="Grille pattern over the fan opening — open lets the fan breathe; the others are decorative."
          >
            {FAN_GRILLES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <button
            onClick={() => removeFanMount(f.id)}
            title="Remove this fan mount"
            aria-label={`Remove fan ${f.id}`}
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

function TextLabelsSection() {
  const labels = useProjectStore((s) => s.project.textLabels) ?? EMPTY_LABELS;
  const addTextLabel = useProjectStore((s) => s.addTextLabel);
  const removeTextLabel = useProjectStore((s) => s.removeTextLabel);
  const patchTextLabel = useProjectStore((s) => s.patchTextLabel);

  return (
    <section className="features-section">
      <h4>
        Text labels
        <button
          onClick={() => {
            const newLabel: TextLabel = {
              id: `text-${newId()}`,
              text: 'CASE MAKER',
              face: '+z',
              position: { u: 20, v: 20 },
              rotation: 0,
              size: 5,
              depth: 0.6,
              mode: 'engrave',
              font: 'sans-default',
              weight: 'regular',
              enabled: true,
            };
            addTextLabel(newLabel);
          }}
          data-testid="add-text-label"
          className="features-add"
          title="Add a new engraved text label on the lid (+z) — edit text/face/size below."
        >
          + add
        </button>
      </h4>
      {labels.length === 0 && <p className="features-empty">No labels.</p>}
      {labels.map((l) => (
        <div key={l.id} className="features-row">
          <input
            type="checkbox"
            checked={l.enabled}
            onChange={(e) => patchTextLabel(l.id, { enabled: e.target.checked })}
            aria-label={`Label ${l.id} enabled`}
            title="Toggle this text label on/off."
          />
          <input
            type="text"
            value={l.text}
            onChange={(e) => patchTextLabel(l.id, { text: e.target.value })}
            style={{ flex: 1, minWidth: 60 }}
            aria-label={`Label ${l.id} text`}
            title="Label text — engraved or embossed onto the chosen face."
          />
          <select
            value={l.face}
            onChange={(e) => patchTextLabel(l.id, { face: e.target.value as CaseFace })}
            aria-label={`Label ${l.id} face`}
            title="Which case face the label appears on."
          >
            {CASE_FACES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            onClick={() => removeTextLabel(l.id)}
            title="Remove this label"
            aria-label={`Remove label ${l.id}`}
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

function MountingSection() {
  const features = useProjectStore((s) => s.project.mountingFeatures) ?? EMPTY_FEATURES;
  const applyPreset = useProjectStore((s) => s.applyMountingPreset);
  const removeFeature = useProjectStore((s) => s.removeMountingFeature);
  const patchFeature = useProjectStore((s) => s.patchMountingFeature);
  const setSelection = useViewportStore((s) => s.setSelection);
  const selectedFeatureId = useViewportStore((s) =>
    s.selection?.kind === 'mounting-feature' ? s.selection.featureId : null,
  );

  return (
    <section className="features-section">
      <h4>Mounting features</h4>
      <div className="features-row">
        <button
          onClick={() => applyPreset('four-corner-screw-tabs')}
          title="Add four screw tabs at the case corners."
        >
          + 4-corner tabs
        </button>
        <button
          onClick={() => applyPreset('pair-end-flanges-y')}
          data-testid="preset-end-flanges-y"
          title="Add flanges on the front and back faces (±Y) for end-screw mounting."
        >
          + End flanges (front/back)
        </button>
        <button
          onClick={() => applyPreset('pair-end-flanges-x')}
          data-testid="preset-end-flanges-x"
          title="Add flanges on the left and right faces (±X) for end-screw mounting."
        >
          + End flanges (left/right)
        </button>
        <button onClick={() => applyPreset('rear-vesa-100')} title="Add VESA 100×100 mounting hole pattern on the back.">
          + VESA 100
        </button>
        <button onClick={() => applyPreset('rear-vesa-75')} title="Add VESA 75×75 mounting hole pattern on the back.">
          + VESA 75
        </button>
      </div>
      {features.length === 0 && <p className="features-empty">No mounting features.</p>}
      {/* Issue #96 (Phase 4d) — rows are compact summaries; click selects
          and the right-rail ContextPanel renders the type-aware detail. */}
      {features.map((f) => (
        <div
          key={f.id}
          className={`features-row${selectedFeatureId === f.id ? ' features-row--selected' : ''}`}
        >
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => patchFeature(f.id, { enabled: e.target.checked })}
            aria-label={`Mounting feature ${f.id} enabled`}
            title="Toggle this mounting feature on/off."
          />
          <button
            type="button"
            className="features-row__select"
            onClick={() => setSelection({ kind: 'mounting-feature', featureId: f.id })}
            aria-pressed={selectedFeatureId === f.id}
            data-testid={`feature-${f.id}-select`}
            title="Edit feature parameters in the right rail"
          >
            {f.type} · {f.face} · u={f.position.u} v={f.position.v}
          </button>
          <button
            onClick={() => removeFeature(f.id)}
            title="Remove this mounting feature"
            aria-label={`Remove mounting feature ${f.id}`}
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

function CustomCutoutsSection() {
  // Issue #76 — freeform user-placed cutouts on any case face.
  const cutouts = useProjectStore((s) => s.project.case.customCutouts) ?? EMPTY_CUTOUTS;
  const addCutout = useProjectStore((s) => s.addCustomCutout);
  const removeCutout = useProjectStore((s) => s.removeCustomCutout);
  const patchCutout = useProjectStore((s) => s.patchCustomCutout);

  const onAdd = () => {
    addCutout({
      id: newId('cutout'),
      face: 'back',
      shape: 'rect',
      u: 25,
      v: 10,
      width: 10,
      height: 10,
      enabled: true,
    });
  };

  return (
    <section className="features-section">
      <h4>Custom cutouts</h4>
      <div className="features-row">
        <button
          onClick={onAdd}
          data-testid="add-custom-cutout"
          title="Add a 10×10 rect cutout on the back face — edit shape/size/position below."
        >
          + Add cutout
        </button>
      </div>
      {cutouts.length === 0 && <p className="features-empty">No custom cutouts.</p>}
      {cutouts.map((c) => (
        <div key={c.id} className="features-row" data-testid={`custom-cutout-${c.id}`}>
          <input
            type="checkbox"
            checked={c.enabled}
            onChange={(e) => patchCutout(c.id, { enabled: e.target.checked })}
            data-testid={`custom-cutout-enabled-${c.id}`}
            aria-label={`Cutout ${c.id} enabled`}
            title="Toggle this cutout on/off."
          />
          <select
            value={c.face}
            onChange={(e) =>
              patchCutout(c.id, { face: e.target.value as import('@/types').CutoutFace })
            }
            data-testid={`custom-cutout-face-${c.id}`}
            aria-label={`Cutout ${c.id} face`}
            title="Which case face the cutout is on."
          >
            {CUTOUT_FACES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select
            value={c.shape}
            onChange={(e) =>
              patchCutout(c.id, { shape: e.target.value as import('@/types').CustomCutoutShape })
            }
            data-testid={`custom-cutout-shape-${c.id}`}
            aria-label={`Cutout ${c.id} shape`}
            title="Cutout shape — rectangle, round, or rounded slot."
          >
            {CUTOUT_SHAPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={c.u}
            step={1}
            onChange={(e) => patchCutout(c.id, { u: Number(e.target.value) })}
            style={{ width: 56 }}
            data-testid={`custom-cutout-u-${c.id}`}
            aria-label={`Cutout ${c.id} U position (mm)`}
            title="U position (mm) — horizontal offset along the chosen face."
            placeholder="U"
          />
          <input
            type="number"
            value={c.v}
            step={1}
            onChange={(e) => patchCutout(c.id, { v: Number(e.target.value) })}
            style={{ width: 56 }}
            data-testid={`custom-cutout-v-${c.id}`}
            aria-label={`Cutout ${c.id} V position (mm)`}
            title="V position (mm) — vertical offset along the chosen face."
            placeholder="V"
          />
          <input
            type="number"
            value={c.width}
            step={1}
            min={0.1}
            onChange={(e) => patchCutout(c.id, { width: Number(e.target.value) })}
            style={{ width: 56 }}
            data-testid={`custom-cutout-width-${c.id}`}
            aria-label={`Cutout ${c.id} width (mm)`}
            title="Cutout width along U axis (mm). For round shapes this is the diameter."
            placeholder="W"
          />
          <input
            type="number"
            value={c.height}
            step={1}
            min={0.1}
            onChange={(e) => patchCutout(c.id, { height: Number(e.target.value) })}
            style={{ width: 56 }}
            data-testid={`custom-cutout-height-${c.id}`}
            aria-label={`Cutout ${c.id} height (mm)`}
            title="Cutout height along V axis (mm). Ignored for round shapes."
            placeholder="H"
          />
          <input
            type="text"
            placeholder="label"
            value={c.label ?? ''}
            onChange={(e) => patchCutout(c.id, { label: e.target.value })}
            style={{ flex: 1 }}
            aria-label={`Cutout ${c.id} label`}
            title="Optional descriptive label for this cutout."
          />
          <button
            onClick={() => removeCutout(c.id)}
            data-testid={`custom-cutout-remove-${c.id}`}
            title="Remove this cutout"
            aria-label={`Remove cutout ${c.id}`}
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

function SnapCatchesSection() {
  const joint = useProjectStore((s) => s.project.case.joint);
  const catches = useProjectStore((s) => s.project.case.snapCatches) ?? EMPTY_CATCHES;
  const addSnapCatch = useProjectStore((s) => s.addSnapCatch);
  const removeSnapCatch = useProjectStore((s) => s.removeSnapCatch);
  const patchSnapCatch = useProjectStore((s) => s.patchSnapCatch);
  const setSelection = useViewportStore((s) => s.setSelection);
  const selectedCatchId = useViewportStore((s) =>
    s.selection?.kind === 'snap-catch' ? s.selection.catchId : null,
  );

  if (joint !== 'snap-fit') return null;

  return (
    <section className="features-section">
      <h4>
        Snap catches
        <button
          onClick={() => addSnapCatch('-x', 20)}
          data-testid="add-snap-catch"
          className="features-add"
          title="Add a snap catch on the −X wall at U=20 mm."
        >
          + add
        </button>
      </h4>
      {catches.length === 0 && <p className="features-empty">No catches.</p>}
      {/* Issue #95 (Phase 4c) — rows are compact summaries; click selects
          and the right-rail ContextPanel renders the detail editor. */}
      {catches.map((c) => {
        const isSelected = selectedCatchId === c.id;
        return (
          <div
            key={c.id}
            className={`features-row${isSelected ? ' features-row--selected' : ''}`}
            title={`Catch ${c.id} on wall ${c.wall} at u=${c.uPosition} mm`}
          >
            <label className="cell-label" title="Toggle this snap catch on/off.">
              <span className="cell-label__axis">on</span>
              <input
                type="checkbox"
                checked={c.enabled}
                onChange={(e) => patchSnapCatch(c.id, { enabled: e.target.checked })}
                aria-label={`Snap catch ${c.id} enabled`}
              />
            </label>
            <button
              type="button"
              className="features-row__select"
              onClick={() => setSelection({ kind: 'snap-catch', catchId: c.id })}
              aria-pressed={isSelected}
              data-testid={`snap-catch-${c.id}-select`}
              title="Edit catch details in the right rail"
            >
              {c.wall} · u={c.uPosition}
            </button>
            {/* Barb cross-section stays inline — frequent edit, fits one
                row, and matches the user's mental model that "style" is
                always visible from the row. Wall + u-position + cantilever
                live in the right-rail detail. */}
            <label className="cell-label" style={{ flex: 0 }}>
              <span className="cell-label__axis">style</span>
              <select
                value={c.barbType ?? 'hook'}
                onChange={(e) => patchSnapCatch(c.id, { barbType: e.target.value as BarbType })}
                data-testid={`snap-barb-type-${c.id}`}
                aria-label={`Snap catch ${c.id} barb style`}
                title="Barb cross-section: hook = classic; symmetric-ramp = service-friendly; ball-socket = detent."
              >
                {BARB_TYPES.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() => removeSnapCatch(c.id)}
              title="Remove this snap catch"
              aria-label={`Remove snap catch ${c.id}`}
            >
              ✕
            </button>
          </div>
        );
      })}
    </section>
  );
}
