import { useProjectStore } from '@/store/projectStore';
import { listBuiltinDisplayIds } from '@/library/displays';
import { newId } from '@/utils/id';
import type { AntennaType } from '@/types/antenna';
import type { FanSize, CaseFace, FanGrille } from '@/types/fan';
import type { TextLabel } from '@/types/textLabel';
import type { SnapWall } from '@/types/snap';
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
 */

const FAN_SIZES: FanSize[] = ['30x30x10', '40x40x10', '40x40x20', '50x50x10', '60x60x15'];
const CASE_FACES: CaseFace[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const FAN_GRILLES: FanGrille[] = ['cross', 'spiral', 'honeycomb', 'concentric', 'open'];
const ANTENNA_TYPES: AntennaType[] = ['internal', 'rpi-external', 'external-mount'];
const SNAP_WALLS: SnapWall[] = ['+x', '-x', '+y', '-y'];
const DISPLAY_FRAMINGS: DisplayFraming[] = ['top-window', 'recessed-bezel'];

// Stable empty-array constants to avoid Zustand snapshot churn — selectors
// returning `?? []` would create a new [] every render and trigger
// "getSnapshot should be cached" → infinite re-render loops.
const EMPTY_ANTENNAS: import('@/types/antenna').AntennaPlacement[] = [];
const EMPTY_FANS: import('@/types/fan').FanMount[] = [];
const EMPTY_LABELS: import('@/types/textLabel').TextLabel[] = [];
const EMPTY_FEATURES: import('@/types/mounting').MountingFeature[] = [];
const EMPTY_CATCHES: import('@/types/snap').SnapCatch[] = [];

export function FeaturesPanel() {
  return (
    <div className="panel">
      <h3>Features</h3>
      <DisplaySection />
      <AntennasSection />
      <FansSection />
      <TextLabelsSection />
      <MountingSection />
      <SnapCatchesSection />
      <RecessToggle />
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
      <select
        value={display?.displayId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          setDisplay(v === '' ? null : v);
        }}
        data-testid="display-select"
      >
        <option value="">— none —</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      {display && (
        <div className="features-row">
          <label>
            <input
              type="checkbox"
              checked={display.enabled}
              onChange={(e) => patchDisplay({ enabled: e.target.checked })}
              data-testid="display-enabled"
            />
            enabled
          </label>
          <select
            value={display.framing}
            onChange={(e) => patchDisplay({ framing: e.target.value as DisplayFraming })}
            data-testid="display-framing"
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
          />
          <select
            value={a.type}
            onChange={(e) => patchAntenna(a.id, { type: e.target.value as AntennaType })}
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
          >
            {(['+x', '-x', '+y', '-y'] as const).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button onClick={() => removeAntenna(a.id)} data-testid={`remove-antenna-${a.id}`}>
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
          />
          <select
            value={f.size}
            onChange={(e) => patchFanMount(f.id, { size: e.target.value as FanSize })}
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
          >
            {FAN_GRILLES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <button onClick={() => removeFanMount(f.id)}>✕</button>
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
          />
          <input
            type="text"
            value={l.text}
            onChange={(e) => patchTextLabel(l.id, { text: e.target.value })}
            style={{ flex: 1, minWidth: 60 }}
          />
          <select
            value={l.face}
            onChange={(e) => patchTextLabel(l.id, { face: e.target.value as CaseFace })}
          >
            {CASE_FACES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button onClick={() => removeTextLabel(l.id)}>✕</button>
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

  return (
    <section className="features-section">
      <h4>Mounting features</h4>
      <div className="features-row">
        <button onClick={() => applyPreset('four-corner-screw-tabs')}>
          + 4-corner tabs
        </button>
        <button onClick={() => applyPreset('rear-vesa-100')}>+ VESA 100</button>
        <button onClick={() => applyPreset('rear-vesa-75')}>+ VESA 75</button>
      </div>
      {features.length === 0 && <p className="features-empty">No mounting features.</p>}
      {features.map((f) => (
        <div key={f.id} className="features-row">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => patchFeature(f.id, { enabled: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            {f.type} ({f.face})
          </span>
          <button onClick={() => removeFeature(f.id)}>✕</button>
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

  if (joint !== 'snap-fit') return null;

  return (
    <section className="features-section">
      <h4>
        Snap catches
        <button
          onClick={() => addSnapCatch('-x', 20)}
          data-testid="add-snap-catch"
          className="features-add"
        >
          + add
        </button>
      </h4>
      {catches.length === 0 && <p className="features-empty">No catches.</p>}
      {catches.map((c) => (
        <div key={c.id} className="features-row">
          <input
            type="checkbox"
            checked={c.enabled}
            onChange={(e) => patchSnapCatch(c.id, { enabled: e.target.checked })}
          />
          <select
            value={c.wall}
            onChange={(e) => patchSnapCatch(c.id, { wall: e.target.value as SnapWall })}
          >
            {SNAP_WALLS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={c.uPosition}
            step={1}
            onChange={(e) => patchSnapCatch(c.id, { uPosition: Number(e.target.value) })}
            style={{ width: 60 }}
          />
          <button onClick={() => removeSnapCatch(c.id)}>✕</button>
        </div>
      ))}
    </section>
  );
}

function RecessToggle() {
  const lidRecess = useProjectStore((s) => s.project.case.lidRecess ?? false);
  const patchCase = useProjectStore((s) => s.patchCase);

  return (
    <section className="features-section">
      <label className="features-row">
        <input
          type="checkbox"
          checked={lidRecess}
          onChange={(e) => patchCase({ lidRecess: e.target.checked })}
          data-testid="lid-recess"
        />
        Recessed lid (drops into a pocket flush with the rim)
      </label>
    </section>
  );
}
