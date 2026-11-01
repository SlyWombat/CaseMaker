import { useMemo, useState } from 'react';
import * as opentype from 'opentype.js';
import { FontPicker, WeightPicker } from '@/components/panels/FontPicker';
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
import { MAGNET_SIZES, type MagnetPocket, type MagnetRetention, type MagnetSize, type NameplateParams } from '@/types';
import { MAGNETS } from '@/engine/compiler/fasteners';
import { FACE_NAME, faceSizeForProject, magnetFactsForProject } from '@/engine/compiler/magnets';
import type { CaseDivider } from '@/types';
import {
  DEFAULT_FLOOR_GRID,
  DIVIDER_THICKNESS,
  DIVIDER_TOP_CLEARANCE,
  GRID_FLOOR_UNDER,
  WIDEN_SIDE_NAME,
  caseDividerFacts,
  suggestCaseDivider,
} from '@/engine/compiler/caseDividers';
import { useJobStore } from '@/store/jobStore';
import {
  CONNECTOR_FACES,
  STACK_KEY_VARIANTS,
  STACK_LONG_REACH,
  STACK_SLIDE_CLEARANCE,
  stackKeyLength,
  type ConnectorFace,
  type StackConnectorParams,
  type StackKeyVariant,
} from '@/types/stackConnector';
import { FIT_VARIANTS, type FitVariant } from '@/types/snap';
import { stackKeyDims } from '@/engine/compiler/stackConnector';
import type { ClashOffer, ClashStatement } from '@/engine/compiler/caseClashes';
import { METHOD_NAME } from '@/engine/compiler/interiorClash';

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
const EMPTY_FONTS: import('@/types/textLabel').CustomFont[] = [];
const EMPTY_FEATURES: import('@/types/mounting').MountingFeature[] = [];
const EMPTY_CATCHES: import('@/types/snap').SnapCatch[] = [];
const EMPTY_CUTOUTS: import('@/types').CustomCutout[] = [];
const CUTOUT_FACES: import('@/types').CutoutFace[] = ['top', 'bottom', 'front', 'back', 'left', 'right'];
const CUTOUT_SHAPES: import('@/types').CustomCutoutShape[] = ['rect', 'round', 'slot'];
const EMPTY_MAGNETS: MagnetPocket[] = [];
const RETENTIONS: { id: MagnetRetention; label: string; hint: string }[] = [
  { id: 'glue', label: 'glue', hint: 'Open pocket at the table’s glue fit (disc + 0.5 mm)' },
  { id: 'press', label: 'press', hint: 'Open pocket at a light press fit (disc + 0.1 mm, provisional)' },
  {
    id: 'captured',
    label: 'captured',
    hint: 'Closed by a 0.6 mm skin; the print pauses to drop the magnet in (floor and lid only)',
  },
];
const sizeLabel = (s: MagnetSize): string => {
  const m = MAGNETS[s];
  return `${m.d} × ${m.h} mm`;
};
const faceLabel = (f: CaseFace): string => `${FACE_NAME[f]} (${f})`;

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
      <MagnetPocketsSection />
      <NameplateSection />
      <MagnetNotes />
      <SnapCatchesSection />
      <FloorGridSection />
      <StackConnectorSection />
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
  const customFonts = useProjectStore((s) => s.project.customFonts) ?? EMPTY_FONTS;
  const addCustomFont = useProjectStore((s) => s.addCustomFont);
  const [fontError, setFontError] = useState<string | null>(null);

  // Issue #169 — embed a user-supplied TTF/OTF in the project (base64, like
  // ExternalAsset.data) so the project stays self-contained and portable.
  const onFontFile = async (file: File | undefined) => {
    if (!file) return;
    setFontError(null);
    try {
      const buf = await file.arrayBuffer();
      opentype.parse(buf); // throws on anything that is not a usable font
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      addCustomFont({ id: `font-${newId()}`, name: file.name.replace(/\.[^.]+$/, ''), data: btoa(bin) });
    } catch {
      setFontError(`Could not read "${file.name}" as a TTF/OTF font.`);
    }
  };

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
      <div className="features-row">
        <label title="Embed your own TTF/OTF font in this project for use in labels.">
          Add font…{' '}
          <input
            type="file"
            accept=".ttf,.otf,font/ttf,font/otf"
            data-testid="add-custom-font"
            onChange={(e) => {
              void onFontFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        {fontError && <span role="alert">{fontError}</span>}
      </div>
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
          <FontPicker
            value={l.font}
            onChange={(font) => patchTextLabel(l.id, { font })}
            customFonts={customFonts}
            aria-label={`Label ${l.id} font`}
            title="Typeface for the label."
          />
          <WeightPicker
            value={l.weight}
            onChange={(weight) => patchTextLabel(l.id, { weight })}
            aria-label={`Label ${l.id} weight`}
            title="Regular or bold (bundled fonts only; an embedded font is used as-is)."
          />
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
        <button
          onClick={() => applyPreset('extrusion-mount-2020')}
          data-testid="preset-extrusion-mount"
          title="Two M5 bolt holes on a 20 mm pitch for bolting the case to 20-series T-slot extrusion (2020/2040/2060), with a T-nut captive in the slot."
        >
          + 2020 extrusion
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

function MagnetPocketsSection() {
  // Issue #152 — disc-magnet pockets cut into a case face.
  const pockets = useProjectStore((s) => s.project.case.magnetPockets) ?? EMPTY_MAGNETS;
  const patchCase = useProjectStore((s) => s.patchCase);
  const set = (next: MagnetPocket[]) => patchCase({ magnetPockets: next });
  const patch = (id: string, p: Partial<MagnetPocket>) =>
    set(pockets.map((m) => (m.id === id ? { ...m, ...p } : m)));

  const onAdd = () => {
    const project = useProjectStore.getState().project;
    const [fw, fh] = faceSizeForProject(project, '-y');
    set([
      ...pockets,
      {
        id: newId('magnet'),
        face: '-y',
        u: Math.round(fw / 2),
        v: Math.round(fh / 2),
        size: '6x2',
        retention: 'glue',
        count: 1,
        enabled: true,
      },
    ]);
  };

  return (
    <section className="features-section" data-testid="magnet-pockets-section">
      <h4>Magnet pockets</h4>
      <div className="features-row">
        <button
          onClick={onAdd}
          data-testid="add-magnet-pocket"
          title="Add a 6 × 2 mm magnet pocket at the centre of the front face — edit size, count and position below."
        >
          + Add magnet pocket
        </button>
      </div>
      {pockets.length === 0 && <p className="features-empty">No magnet pockets.</p>}
      {pockets.map((m) => (
        <div key={m.id} className="features-row" data-testid={`magnet-pocket-${m.id}`}>
          <input
            type="checkbox"
            checked={m.enabled}
            onChange={(e) => patch(m.id, { enabled: e.target.checked })}
            aria-label={`Magnet pocket ${m.id} enabled`}
            title="Toggle this magnet pocket on/off."
          />
          <select
            value={m.face}
            onChange={(e) => patch(m.id, { face: e.target.value as CaseFace })}
            data-testid={`magnet-pocket-face-${m.id}`}
            aria-label={`Magnet pocket ${m.id} face`}
            title="Which case face the pocket is cut into. Top pockets go into the lid."
          >
            {CASE_FACES.map((f) => (
              <option key={f} value={f}>
                {faceLabel(f)}
              </option>
            ))}
          </select>
          <select
            value={m.size}
            onChange={(e) => patch(m.id, { size: e.target.value as MagnetSize })}
            data-testid={`magnet-pocket-size-${m.id}`}
            aria-label={`Magnet pocket ${m.id} magnet size`}
            title="Disc magnet size, diameter × thickness. Pocket fits are provisional until the magnet coupon is printed."
          >
            {MAGNET_SIZES.map((s) => (
              <option key={s} value={s}>
                {sizeLabel(s)}
              </option>
            ))}
          </select>
          <select
            value={m.retention ?? 'glue'}
            onChange={(e) => patch(m.id, { retention: e.target.value as MagnetRetention })}
            data-testid={`magnet-pocket-retention-${m.id}`}
            aria-label={`Magnet pocket ${m.id} retention`}
            title="How the magnet is held: glued in an open pocket, pressed in, or captured mid-print under a skin."
          >
            {RETENTIONS.map((r) => (
              <option key={r.id} value={r.id} title={r.hint}>
                {r.label}
              </option>
            ))}
          </select>
          <label title="Pockets in a row along the face, centred on the position.">
            Count{' '}
            <input
              type="number"
              value={m.count ?? 1}
              min={1}
              max={12}
              step={1}
              onChange={(e) => patch(m.id, { count: Math.max(1, Math.min(12, Math.round(Number(e.target.value)) || 1)) })}
              style={{ width: 48 }}
              data-testid={`magnet-pocket-count-${m.id}`}
              aria-label={`Magnet pocket ${m.id} count`}
              title="Pockets in a row along the face, centred on U and V."
            />
          </label>
          <label title="The row's centre along the face, in mm from the face corner.">
            U (mm){' '}
            <input
              type="number"
              value={m.u}
              step={1}
              onChange={(e) => patch(m.id, { u: Number(e.target.value) })}
              style={{ width: 56 }}
              data-testid={`magnet-pocket-u-${m.id}`}
              aria-label={`Magnet pocket ${m.id} U position (mm)`}
              title="U position (mm) — the row's centre along the face."
            />
          </label>
          <label title="The row's centre across the face, in mm from the face corner.">
            V (mm){' '}
            <input
              type="number"
              value={m.v}
              step={1}
              onChange={(e) => patch(m.id, { v: Number(e.target.value) })}
              style={{ width: 56 }}
              data-testid={`magnet-pocket-v-${m.id}`}
              aria-label={`Magnet pocket ${m.id} V position (mm)`}
              title="V position (mm) — the row's centre across the face."
            />
          </label>
          <button
            onClick={() => set(pockets.filter((x) => x.id !== m.id))}
            data-testid={`magnet-pocket-remove-${m.id}`}
            title="Remove this magnet pocket"
            aria-label={`Remove magnet pocket ${m.id}`}
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

function NameplateSection() {
  // Issue #152 — a separate plate carrying text, held on by magnets.
  const plate = useProjectStore((s) => s.project.case.nameplate);
  const patchCase = useProjectStore((s) => s.patchCase);
  const put = (p: Partial<NameplateParams>) => {
    if (!plate) return;
    patchCase({ nameplate: { ...plate, ...p } });
  };
  const centreOn = (face: CaseFace): { u: number; v: number } => {
    const [fw, fh] = faceSizeForProject(useProjectStore.getState().project, face);
    return { u: Math.round(fw / 2), v: Math.round(fh / 2) };
  };

  const onAdd = () => {
    patchCase({
      nameplate: {
        enabled: true,
        face: '-y',
        ...centreOn('-y'),
        width: 50,
        height: 16,
        thickness: 4,
        cornerRadius: 2,
        text: 'NAME',
        textSize: 7,
        textMode: 'engrave',
        textDepth: 0.6,
        magnetSize: '6x2',
        magnetCount: 2,
        retention: 'glue',
      },
    });
  };

  const num = (
    key: 'width' | 'height' | 'thickness' | 'textSize' | 'textDepth' | 'u' | 'v',
    label: string,
    hint: string,
    min?: number,
  ) =>
    plate && (
      <label title={hint}>
        {label}{' '}
        <input
          type="number"
          value={plate[key]}
          step={key === 'textDepth' ? 0.1 : 1}
          min={min}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (min !== undefined && !(v >= min)) return;
            put({ [key]: v });
          }}
          style={{ width: 56 }}
          data-testid={`nameplate-${key}`}
          aria-label={`Nameplate ${label}`}
          title={hint}
        />
      </label>
    );

  return (
    <section className="features-section" data-testid="nameplate-section">
      <h4>Nameplate</h4>
      {!plate ? (
        <div className="features-row">
          <button
            onClick={onAdd}
            data-testid="add-nameplate"
            title="Add a swappable nameplate to the front face, held on by two 6 × 2 mm magnets."
          >
            + Add nameplate
          </button>
        </div>
      ) : (
        <>
          <div className="features-row">
            <input
              type="checkbox"
              checked={plate.enabled}
              onChange={(e) => put({ enabled: e.target.checked })}
              data-testid="nameplate-enabled"
              aria-label="Nameplate enabled"
              title="Toggle the nameplate and its case pockets on/off."
            />
            <input
              type="text"
              value={plate.text}
              onChange={(e) => put({ text: e.target.value })}
              style={{ flex: 1, minWidth: 60 }}
              data-testid="nameplate-text"
              aria-label="Nameplate text"
              title="Text on the plate's front face."
            />
            <select
              value={plate.face}
              onChange={(e) => {
                const face = e.target.value as CaseFace;
                put({ face, ...centreOn(face) });
              }}
              data-testid="nameplate-face"
              aria-label="Nameplate face"
              title="Which case face the plate sits on. Changing it re-centres the plate on that face."
            >
              {CASE_FACES.map((f) => (
                <option key={f} value={f}>
                  {faceLabel(f)}
                </option>
              ))}
            </select>
            <select
              value={plate.textMode}
              onChange={(e) => put({ textMode: e.target.value as NameplateParams['textMode'] })}
              data-testid="nameplate-text-mode"
              aria-label="Nameplate text mode"
              title="Engrave the text into the plate or raise it off the plate."
            >
              <option value="engrave">engrave</option>
              <option value="emboss">emboss</option>
            </select>
            <button
              onClick={() => patchCase({ nameplate: undefined })}
              data-testid="nameplate-remove"
              title="Remove the nameplate"
              aria-label="Remove nameplate"
            >
              ✕
            </button>
          </div>
          <div className="features-row">
            {num('width', 'Width (mm)', 'Plate width along the face, in mm.', 5)}
            {num('height', 'Height (mm)', 'Plate height across the face, in mm.', 5)}
            {num('thickness', 'Thickness (mm)', 'Plate thickness, in mm. It must hold the magnet pocket plus a skin under the text.', 1)}
          </div>
          <div className="features-row">
            {num('u', 'Centre U (mm)', 'Plate centre along the face, in mm from the face corner.')}
            {num('v', 'Centre V (mm)', 'Plate centre across the face, in mm from the face corner.')}
            {num('textSize', 'Text height (mm)', 'Cap height of the text, in mm.', 1)}
            {num('textDepth', 'Text depth (mm)', 'Engraving depth or emboss height of the text, in mm.', 0.1)}
          </div>
          <div className="features-row">
            <select
              value={plate.magnetSize}
              onChange={(e) => put({ magnetSize: e.target.value as MagnetSize })}
              data-testid="nameplate-magnet-size"
              aria-label="Nameplate magnet size"
              title="Disc magnet size, diameter × thickness. One magnet in the plate and one in the case per position."
            >
              {MAGNET_SIZES.map((s) => (
                <option key={s} value={s}>
                  {sizeLabel(s)}
                </option>
              ))}
            </select>
            <select
              value={plate.magnetCount}
              onChange={(e) => put({ magnetCount: Number(e.target.value) })}
              data-testid="nameplate-magnet-count"
              aria-label="Nameplate magnet count"
              title="Magnets along the plate's width."
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} magnet{n > 1 ? 's' : ''}
                </option>
              ))}
            </select>
            <select
              value={plate.retention ?? 'glue'}
              onChange={(e) => put({ retention: e.target.value as MagnetRetention })}
              data-testid="nameplate-retention"
              aria-label="Nameplate case-side retention"
              title="How the case-side magnets are held. The plate's own pockets are always open for glue."
            >
              {RETENTIONS.map((r) => (
                <option key={r.id} value={r.id} title={r.hint}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </section>
  );
}

function MagnetNotes() {
  const project = useProjectStore((s) => s.project);
  const patchCase = useProjectStore((s) => s.patchCase);
  const allClashes = useJobStore((s) => s.clashes);
  const clashes = allClashes.filter((c) => c.subject === 'magnet');
  const notes = useMemo(() => {
    const c = project.case;
    if (!(c.magnetPockets ?? []).some((m) => m.enabled) && !c.nameplate?.enabled) return [];
    try {
      return magnetFactsForProject(project).notes;
    } catch {
      return [];
    }
  }, [project]);
  const take = (o: ClashOffer) => {
    if (o.kind !== 'move-magnet') return;
    const c = project.case;
    if (o.source === 'nameplate') {
      if (c.nameplate) patchCase({ nameplate: { ...c.nameplate, u: o.u, v: o.v } });
    } else {
      patchCase({ magnetPockets: (c.magnetPockets ?? []).map((m) => (m.id === o.source ? { ...m, u: o.u, v: o.v } : m)) });
    }
  };
  if (notes.length === 0 && clashes.length === 0) return null;
  return (
    <section className="features-section" data-testid="magnet-notes">
      {notes.map((n) => (
        <p key={n} className="features-note">
          {n}
        </p>
      ))}
      <ClashList statements={clashes} testId="magnet-clash" onTake={take} />
    </section>
  );
}

/** Words on the button that takes a clash offer. */
function offerLabel(o: ClashOffer): string {
  switch (o.kind) {
    case 'move-magnet':
      return `Move to u ${Math.round(o.u * 10) / 10} mm, v ${Math.round(o.v * 10) / 10} mm`;
    case 'move-divider':
      return `Move to line ${o.line + 1}`;
    case 'shorten-divider':
      return `Shorten to ${o.holes} sockets`;
  }
}

/**
 * The compiler's clash statements for one feature, each with its offer as a
 * button. The tooltip says how the clash was found. Taking an offer is the
 * only thing a click does: nothing here blocks an export.
 */
function ClashList({
  statements,
  testId,
  onTake,
  label = offerLabel,
}: {
  statements: ClashStatement[];
  testId: string;
  onTake: (o: ClashOffer) => void;
  label?: (o: ClashOffer) => string;
}) {
  if (statements.length === 0) return null;
  // One button per distinct offer, after the last statement that makes it.
  const lastWithOffer = new Map<string, number>();
  statements.forEach((c, i) => c.offer && lastWithOffer.set(JSON.stringify(c.offer), i));
  return (
    <>
      {statements.map((c, i) => (
        <div key={`${c.message}-${i}`}>
          <p className="features-note" data-testid={testId} data-method={c.method} title={METHOD_NAME[c.method]}>
            {c.message}
          </p>
          {c.offer && lastWithOffer.get(JSON.stringify(c.offer)) === i && (
            <button
              type="button"
              onClick={() => onTake(c.offer!)}
              data-testid={`${testId}-offer`}
              title="Take the offer: the clash is gone after the next rebuild."
            >
              {label(c.offer)}
            </button>
          )}
        </div>
      ))}
    </>
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

const EMPTY_DIVIDERS: CaseDivider[] = [];
const FIT_NAME: Record<FitVariant, string> = { tight: 'Tight', standard: 'Standard', loose: 'Loose' };
const fmt = (n: number) => `${Math.round(n * 100) / 100} mm`;

/**
 * Issue #150 — the floor socket grid and the drop-in dividers that plug into
 * it. Every fact here comes from `caseDividerFacts`, the same function the
 * compiler builds from, so what the panel says is what gets built. A clash is
 * stated with an offer to move, never a refusal.
 */
function FloorGridSection() {
  const project = useProjectStore((s) => s.project);
  const patchCase = useProjectStore((s) => s.patchCase);
  const [thickened, setThickened] = useState<string | null>(null);
  const params = project.case;
  const grid = params.floorGrid;
  const dividers = params.dividers ?? EMPTY_DIVIDERS;
  const facts = caseDividerFacts(project);
  const clashes = useJobStore((s) => s.clashes);

  const setGrid = (patch: Partial<NonNullable<typeof grid>>) =>
    patchCase({ floorGrid: { ...DEFAULT_FLOOR_GRID, ...grid, ...patch } });
  const setDividers = (next: CaseDivider[]) => patchCase({ dividers: next });
  const patchDivider = (id: string, patch: Partial<CaseDivider>) =>
    setDividers(dividers.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const onToggle = (on: boolean) => {
    if (!on) {
      setGrid({ enabled: false });
      setThickened(null);
      return;
    }
    const depth = grid?.depth ?? DEFAULT_FLOOR_GRID.depth;
    const need = depth + GRID_FLOOR_UNDER;
    if (params.floorThickness < need) {
      setThickened(
        `Floor thickened from ${fmt(params.floorThickness)} to ${fmt(need)} so the ${fmt(depth)} sockets keep ${fmt(GRID_FLOOR_UNDER)} of floor under them.`,
      );
      patchCase({ floorGrid: { ...DEFAULT_FLOOR_GRID, ...grid, enabled: true }, floorThickness: need });
    } else {
      setThickened(null);
      setGrid({ enabled: true });
    }
  };

  const onAdd = (axis: 'x' | 'y') => {
    const at = suggestCaseDivider(project, axis);
    setDividers([...dividers, { id: newId('divider'), ...at, thickness: DIVIDER_THICKNESS, enabled: true }]);
  };

  const onWiden = () => {
    if (!facts.widen) return;
    const t = params.clearanceTweaks ?? { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
    patchCase({ clearanceTweaks: { ...t, [facts.widen.side]: (t[facts.widen.side] ?? 0) + facts.widen.by } });
  };

  const caseFit = params.fit ?? 'tight';
  return (
    <section className="features-section" data-testid="floor-grid-section">
      <h4>Floor grid and dividers</h4>
      <div className="features-row">
        <label title="Cut a grid of square, blind sockets into the case floor. Dividers plug into it and lift out again.">
          <input
            type="checkbox"
            checked={grid?.enabled === true}
            onChange={(e) => onToggle(e.target.checked)}
            data-testid="floor-grid-enabled"
          />{' '}
          Socket grid in the floor
        </label>
      </div>
      {thickened && (
        <p className="features-empty" data-testid="floor-grid-thickened">
          {thickened}
        </p>
      )}
      {grid?.enabled && (
        <>
          <div className="features-row">
            <label>
              Pitch (mm){' '}
              <input
                type="number"
                min={1}
                step={0.5}
                value={grid.pitch}
                style={{ width: 56 }}
                onChange={(e) => setGrid({ pitch: Number(e.target.value) })}
                data-testid="floor-grid-pitch"
                title="Socket centre spacing, both ways, in millimetres."
              />
            </label>
            <label>
              Socket (mm){' '}
              <input
                type="number"
                min={1}
                step={0.1}
                value={grid.socket}
                style={{ width: 56 }}
                onChange={(e) => setGrid({ socket: Number(e.target.value) })}
                data-testid="floor-grid-socket"
                title="Side of each square socket before the fit relief, in millimetres."
              />
            </label>
            <label>
              Depth (mm){' '}
              <input
                type="number"
                min={0.5}
                step={0.1}
                value={grid.depth}
                style={{ width: 56 }}
                onChange={(e) => setGrid({ depth: Number(e.target.value) })}
                data-testid="floor-grid-depth"
                title={`How deep the sockets go. The floor keeps ${GRID_FLOOR_UNDER} mm under them.`}
              />
            </label>
            <label>
              Fit{' '}
              <select
                value={grid.fit ?? ''}
                onChange={(e) =>
                  setGrid({ fit: e.target.value === '' ? undefined : (e.target.value as FitVariant) })
                }
                data-testid="floor-grid-fit"
                title="How much clearance the divider tenons get in their sockets. Go looser if a divider will not drop in."
              >
                <option value="">Case fit ({FIT_NAME[caseFit]})</option>
                {FIT_VARIANTS.map((f) => (
                  <option key={f} value={f}>
                    {FIT_NAME[f]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="features-empty" data-testid="floor-grid-facts">
            {fmt(facts.pitch)} pitch · sockets cut {fmt(facts.socketCut)} square and {fmt(facts.depth)} deep ·
            tenons {fmt(facts.tenon)} square, {fmt(facts.clearance)} clearance ({FIT_NAME[facts.fit]}
            {facts.fitSource === 'case' ? ', the case fit' : ''}) · {facts.sockets.length} sockets, {facts.blocked} left out
            for the board, its standoffs and the wall.
          </p>
          {facts.notes.map((n) => (
            <p key={n} className="features-empty" data-testid="floor-grid-note">
              {n}
            </p>
          ))}
          <div className="features-row">
            {facts.depth < facts.depthWanted && (
              <button
                onClick={() => patchCase({ floorThickness: facts.floorNeeded })}
                data-testid="floor-grid-thicken"
                title="Thicken the case floor so the sockets reach their full depth."
              >
                Thicken the floor to {fmt(facts.floorNeeded)}
              </button>
            )}
            {facts.widen && (
              <button
                onClick={onWiden}
                data-testid="floor-grid-widen"
                title="Grow the cavity on a side with no ports, to make room for a bay beside the board."
              >
                Widen the {WIDEN_SIDE_NAME[facts.widen.side]} side by {fmt(facts.widen.by)}
              </button>
            )}
          </div>
          <div className="features-row">
            <button onClick={() => onAdd('x')} data-testid="add-divider-x" title="Add a divider wall running along X, on a grid row.">
              + Divider along X
            </button>
            <button onClick={() => onAdd('y')} data-testid="add-divider-y" title="Add a divider wall running along Y, on a grid column.">
              + Divider along Y
            </button>
          </div>
          {dividers.length === 0 && <p className="features-empty">No dividers.</p>}
          {dividers.map((d, i) => {
            const f = facts.dividers.find((x) => x.id === d.id);
            const lineWord = d.axis === 'x' ? 'Row' : 'Column';
            return (
              <div key={d.id} data-testid={`divider-${i + 1}`}>
                <div className="features-row">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={(e) => patchDivider(d.id, { enabled: e.target.checked })}
                    aria-label={`Divider ${i + 1} enabled`}
                    title="Build this divider."
                  />
                  <strong>Divider {i + 1}</strong>
                  <select
                    value={d.axis}
                    onChange={(e) => patchDivider(d.id, { axis: e.target.value as 'x' | 'y' })}
                    aria-label={`Divider ${i + 1} direction`}
                    title="Which way the wall runs."
                  >
                    <option value="x">along X</option>
                    <option value="y">along Y</option>
                  </select>
                  <label>
                    {lineWord}{' '}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={d.line + 1}
                      style={{ width: 48 }}
                      onChange={(e) => patchDivider(d.id, { line: Math.max(0, Math.round(Number(e.target.value)) - 1) })}
                      aria-label={`Divider ${i + 1} ${lineWord.toLowerCase()}`}
                      data-testid={`divider-line-${i + 1}`}
                      title={`The grid ${lineWord.toLowerCase()} the wall stands on, counted from 1 at the ${d.axis === 'x' ? 'front (−Y)' : 'left (−X)'} wall.`}
                    />
                  </label>
                  <label>
                    From{' '}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={d.start + 1}
                      style={{ width: 48 }}
                      onChange={(e) => patchDivider(d.id, { start: Math.max(0, Math.round(Number(e.target.value)) - 1) })}
                      aria-label={`Divider ${i + 1} first socket`}
                      title="The socket the wall starts at, counted from 1."
                    />
                  </label>
                  <label>
                    Sockets{' '}
                    <input
                      type="number"
                      min={2}
                      step={1}
                      value={d.holes}
                      style={{ width: 48 }}
                      onChange={(e) => patchDivider(d.id, { holes: Math.max(2, Math.round(Number(e.target.value))) })}
                      aria-label={`Divider ${i + 1} sockets`}
                      data-testid={`divider-holes-${i + 1}`}
                      title="How many sockets the wall covers, first to last. The tenons sit in the end two."
                    />
                  </label>
                  <button
                    onClick={() => setDividers(dividers.filter((x) => x.id !== d.id))}
                    aria-label={`Remove divider ${i + 1}`}
                    title="Remove this divider."
                  >
                    ✕
                  </button>
                </div>
                {f && (
                  <p className="features-empty" data-testid={`divider-facts-${i + 1}`}>
                    {fmt(f.length)} long × {fmt(f.height)} tall × {fmt(d.thickness ?? DIVIDER_THICKNESS)} thick — the cavity's{' '}
                    {fmt(facts.cavityHeight)} inside height less {fmt(DIVIDER_TOP_CLEARANCE)} under the lid. Prints on its side as its own part.
                  </p>
                )}
                {f?.clashes.map((c) => (
                  <p key={c} className="features-empty" data-testid={`divider-clash-${i + 1}`}>
                    {c}
                  </p>
                ))}
                {f && f.clashes.length > 0 && f.moveTo !== null && (
                  <button
                    onClick={() => patchDivider(d.id, { line: f.moveTo! })}
                    data-testid={`divider-move-${i + 1}`}
                    title="Move the divider to the nearest grid line where it seats cleanly."
                  >
                    Move to {lineWord.toLowerCase()} {f.moveTo + 1}
                  </button>
                )}
                {f && f.makeRoom && (
                  <button
                    onClick={() => patchDivider(f.makeRoom!.id, { start: f.makeRoom!.start, holes: f.makeRoom!.holes })}
                    data-testid={`divider-make-room-${i + 1}`}
                    title={`Shorten ${f.makeRoom.label} so this divider seats beside it.`}
                  >
                    Shorten {f.makeRoom.label} to {f.makeRoom.holes} sockets
                  </button>
                )}
                {f && f.clashes.length > 0 && f.moveTo === null && f.shortenTo && !f.makeRoom && (
                  <button
                    onClick={() => patchDivider(d.id, { start: f.shortenTo!.start, holes: f.shortenTo!.holes })}
                    data-testid={`divider-shorten-${i + 1}`}
                    title="Drop sockets from the end that clashes."
                  >
                    Shorten to {f.shortenTo.holes} sockets
                  </button>
                )}
                <ClashList
                  statements={clashes.filter((c) => c.subject === 'divider' && c.subjectId === d.id)}
                  testId={`divider-clash-${i + 1}`}
                  onTake={(o) => {
                    if (o.kind === 'move-divider') patchDivider(o.id, { line: o.line });
                    else if (o.kind === 'shorten-divider') patchDivider(o.id, { start: o.start, holes: o.holes });
                  }}
                  label={(o) =>
                    o.kind === 'move-divider' ? `Move to ${lineWord.toLowerCase()} ${o.line + 1}` : offerLabel(o)
                  }
                />
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

const FACE_LABEL: Record<ConnectorFace, string> = {
  '-y': 'Front (−Y)',
  '+y': 'Back (+Y)',
  '-x': 'Left (−X)',
  '+x': 'Right (+X)',
};

const KEY_LABEL: Record<StackKeyVariant, string> = {
  short: `Short — ${stackKeyLength('short')} mm, parts touching`,
  long: `Long — ${stackKeyLength('long')} mm, bridges a ${STACK_LONG_REACH} mm gap`,
};

const EMPTY_CONNECTOR: StackConnectorParams = { sockets: [], key: 'short', keys: 0 };

const mm1 = (v: number): string => `${Math.round(v * 100) / 100}`;

/**
 * Issue #149 — the stacking connector: which walls get a dovetail socket, which
 * key, how many keys go in the export, and the key's fit. The compiler's own
 * statements (a socket on a port, a short wall) are listed under it, each with
 * the move that clears it when there is one — inform, never refuse.
 */
function StackConnectorSection() {
  const stored = useProjectStore((s) => s.project.case.stackConnector);
  const caseFit = useProjectStore((s) => s.project.case.fit);
  const patchCase = useProjectStore((s) => s.patchCase);
  const report = useJobStore((s) => s.connector);
  const c = stored ?? EMPTY_CONNECTOR;
  const set = (patch: Partial<StackConnectorParams>) => patchCase({ stackConnector: { ...c, ...patch } });
  const socketOn = (face: ConnectorFace) => c.sockets.find((s) => s.face === face);
  const toggleFace = (face: ConnectorFace, on: boolean) =>
    set({
      sockets: on
        ? [...c.sockets.filter((s) => s.face !== face), { face, offset: 0 }]
        : c.sockets.filter((s) => s.face !== face),
    });
  const setOffset = (face: ConnectorFace, offset: number) =>
    set({ sockets: c.sockets.map((s) => (s.face === face ? { ...s, offset } : s)) });
  const setCutThrough = (face: ConnectorFace, offset: number, cutThrough: boolean) =>
    set({
      sockets: c.sockets.map((s) => {
        if (s.face !== face) return s;
        const { cutThrough: _drop, ...rest } = s;
        return cutThrough ? { ...rest, offset, cutThrough: true } : rest;
      }),
    });
  const fit: FitVariant = c.fit ?? caseFit ?? 'tight';
  const dims = stackKeyDims(c.key, fit);
  const active = c.sockets.length > 0 || c.keys > 0 || c.register === true;

  return (
    <section className="features-section" data-testid="stack-connector-section">
      <h4>Stacking connector</h4>
      <p className="features-empty">
        Dovetail sockets on the outside of the walls, and printed keys that slide into them to lock
        this case to another one or to a base plate.
      </p>
      {CONNECTOR_FACES.map((face) => {
        const sock = socketOn(face);
        return (
          <div key={face} className="features-row" title={`Dovetail socket on the ${FACE_LABEL[face]} wall`}>
            <label className="cell-label">
              <input
                type="checkbox"
                checked={!!sock}
                onChange={(e) => toggleFace(face, e.target.checked)}
                data-testid={`stack-socket-${face}`}
                aria-label={`Socket on the ${FACE_LABEL[face]} wall`}
              />
              <span className="cell-label__axis">{FACE_LABEL[face]}</span>
            </label>
            {sock && (
              <label className="cell-label" title="Shift along the wall from its centre, in millimetres.">
                <span className="cell-label__axis">shift (mm)</span>
                <input
                  type="number"
                  step={0.5}
                  value={sock.offset}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setOffset(face, v);
                  }}
                  data-testid={`stack-socket-offset-${face}`}
                  aria-label={`Socket shift along the ${FACE_LABEL[face]} wall, mm`}
                />
              </label>
            )}
          </div>
        );
      })}
      <label className="cell-label" style={{ display: 'flex', width: '100%' }}>
        <span className="cell-label__axis">key</span>
        <select
          value={c.key}
          onChange={(e) => set({ key: e.target.value as StackKeyVariant })}
          data-testid="stack-key-variant"
          aria-label="Key length"
          title="The short key joins two parts that touch; the long key reaches across a gap such as rugged feet."
        >
          {STACK_KEY_VARIANTS.map((v) => (
            <option key={v} value={v}>
              {KEY_LABEL[v]}
            </option>
          ))}
        </select>
      </label>
      <label className="cell-label" style={{ display: 'flex', width: '100%' }}>
        <span className="cell-label__axis">keys to print</span>
        <input
          type="number"
          min={0}
          max={8}
          step={1}
          value={c.keys}
          onChange={(e) => {
            const v = Math.max(0, Math.min(8, Math.floor(Number(e.target.value) || 0)));
            set({ keys: v });
          }}
          data-testid="stack-key-count"
          aria-label="Keys to add to the export"
          title="Each key is its own part in the export, printed flat."
        />
      </label>
      <label className="cell-label" style={{ display: 'flex', width: '100%' }}>
        <span className="cell-label__axis">key fit</span>
        <select
          value={c.fit ?? ''}
          onChange={(e) => set({ fit: e.target.value === '' ? undefined : (e.target.value as FitVariant) })}
          data-testid="stack-key-fit"
          aria-label="Key fit"
          title="Looser rungs make the key smaller; the socket never changes, so a looser key can be reprinted for a case already printed."
        >
          <option value="">Case fit ({caseFit ?? 'tight'})</option>
          {FIT_VARIANTS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {/* #854 item 2 — registration, apart from retention: a ridge on the lid
          and a groove under the floor square a stack before any key goes in. */}
      <label
        className="cell-label"
        style={{ display: 'flex', width: '100%' }}
        title="A ridge on the lid's top and a matching groove under the floor, so stacked cases register square with no key in them. Registration only — it holds nothing down; keys do the retaining."
      >
        <input
          type="checkbox"
          checked={c.register === true}
          onChange={(e) => set({ register: e.target.checked })}
          data-testid="stack-register"
          aria-label="Register stacked cases with a skirt and rim ridge"
        />
        <span>register stacked cases (skirt + rim ridge)</span>
      </label>
      {active && (
        <p className="features-empty" data-testid="stack-key-summary">
          Key {mm1(dims.length)} mm long, {mm1(dims.capture)} mm held in each part, {mm1(dims.lipOverlap)} mm
          under each lip; gap {mm1(dims.clearance)} mm per face ({mm1(STACK_SLIDE_CLEARANCE)} mm sliding gap + {mm1(dims.relief)}{' '}
          mm {fit} relief). Provisional until the stacking-connector fit coupon is printed.
        </p>
      )}
      {active && report?.storage != null && (
        <p className="features-empty" data-testid="stack-key-storage">
          Key storage: {report.storage.flush
            ? 'a parked key sits flush with the top.'
            : `a parked key stands ${mm1(report.storage.storedProud)} mm half-proud — the wall has room for the ${mm1(report.storage.channelMm)} mm channel, not a flush seat.`}
        </p>
      )}
      {report && report.notes.length > 0 && (
        <ul className="features-notes" data-testid="stack-connector-notes">
          {report.notes.map((n, i) => (
            <li key={i} data-testid={`stack-note-${n.kind}-${n.face}`}>
              {n.message}
              {n.suggestedOffset !== undefined && !n.padCutout && (
                <button
                  type="button"
                  onClick={() => setOffset(n.face, n.suggestedOffset!)}
                  data-testid={`stack-move-${n.face}`}
                  title="Move the socket along its wall to the nearest clear position."
                >
                  Move to {mm1(n.suggestedOffset)} mm
                </button>
              )}
              {n.suggestedOffset !== undefined && n.padCutout && (
                <button
                  type="button"
                  onClick={() => setCutThrough(n.face, n.suggestedOffset!, true)}
                  data-testid={`stack-pad-cutout-${n.face}`}
                  title="Notch the brim and ribbing where the socket stands. The wall itself is not cut."
                >
                  Cut a pad cut-out at {mm1(n.suggestedOffset)} mm
                </button>
              )}
              {n.kind === 'pad-cutout' && (
                <button
                  type="button"
                  onClick={() => {
                    const sock = c.sockets.find((x) => x.face === n.face);
                    if (sock) setCutThrough(n.face, sock.offset, false);
                  }}
                  data-testid={`stack-pad-cutout-remove-${n.face}`}
                  title="Leave the brim and ribbing whole."
                >
                  Remove the pad cut-out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
