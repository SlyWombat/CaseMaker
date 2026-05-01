import { useId, type ChangeEvent } from 'react';
import { useProjectStore } from '@/store/projectStore';
import type {
  CaseParameters,
  JointType,
  InsertType,
  SnapType,
  HingeFeature,
  HingeStyle,
  HingePinMode,
  HingePositioning,
} from '@/types';
import { VENT_SURFACES } from '@/types';
import { LabelledField } from '@/components/ui/LabelledField';

const JOINT_OPTIONS: { value: JointType; label: string; hint: string }[] = [
  {
    value: 'flat-lid',
    label: 'Flat lid',
    hint: 'Lid sits flat on top of the rim. Easiest to print, no recess.',
  },
  {
    value: 'snap-fit',
    label: 'Snap-fit',
    hint: 'Cantilever barbs flex into a catch on the case wall — no fasteners needed.',
  },
  {
    value: 'screw-down',
    label: 'Screw-down',
    hint: 'Lid is fastened to the case via screws that engage corner bosses.',
  },
];

const INSERT_OPTIONS: { value: InsertType; label: string; hint: string }[] = [
  { value: 'self-tap', label: 'Self-tap M2.5', hint: 'Self-tapping M2.5 screw threading directly into the plastic boss.' },
  { value: 'heat-set-m2.5', label: 'Heat-set M2.5', hint: 'Heat-set M2.5 brass insert melted into the boss for stronger threads.' },
  { value: 'heat-set-m3', label: 'Heat-set M3', hint: 'Heat-set M3 brass insert melted into the boss.' },
  { value: 'pass-through', label: 'Pass-through', hint: 'Open hole sized for an M2.5 screw shaft — no thread engagement.' },
];

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  testId?: string;
  /** Issue #89 — full description shown via title= and aria-describedby. */
  hint?: string;
  /** Issue #89 — unit chip shown in the label row, e.g. "mm" / "deg". */
  unit?: string;
}

function Slider({ label, value, min, max, step, onChange, testId, hint, unit }: SliderProps) {
  const handle = (e: ChangeEvent<HTMLInputElement>): void => onChange(Number(e.target.value));
  const hintId = useId();
  return (
    <label className="slider-row">
      <div className="slider-label">
        <span>
          {label}
          {unit && <span className="slider-unit">{unit}</span>}
        </span>
        <span className="slider-value">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handle}
        data-testid={testId}
        title={hint ?? label}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handle}
        className="slider-num numeric-input"
        data-testid={testId ? `${testId}-num` : undefined}
        title={hint ?? label}
        aria-label={`${label} (numeric)`}
        aria-describedby={hint ? hintId : undefined}
      />
      {hint && (
        <span id={hintId} className="labelled-field__hint-sr">
          {hint}
        </span>
      )}
    </label>
  );
}

export function CasePanel() {
  const params = useProjectStore((s) => s.project.case);
  const patch = useProjectStore((s) => s.patchCase);
  const set = (key: keyof CaseParameters) => (v: number) => patch({ [key]: v } as Partial<CaseParameters>);

  return (
    <div className="panel">
      <h3>Case Parameters</h3>
      <Slider
        label="Wall thickness"
        unit="mm"
        hint="Outer-shell wall thickness. Thicker = stiffer but more material; the outer XY footprint grows by 2 × this value."
        value={params.wallThickness}
        min={1}
        max={6}
        step={0.1}
        onChange={set('wallThickness')}
        testId="wall-thickness"
      />
      <Slider
        label="Floor thickness"
        unit="mm"
        hint="Bottom-floor thickness under the PCB. Floor is added below the cavity, so total Z grows by this value."
        value={params.floorThickness}
        min={1}
        max={6}
        step={0.1}
        onChange={set('floorThickness')}
        testId="floor-thickness"
      />
      <Slider
        label="Lid thickness"
        unit="mm"
        hint="Top-lid thickness. Lid is added above the cavity, so total Z grows by this value (or by lid − recess if 'Recessed lid' is enabled)."
        value={params.lidThickness}
        min={1}
        max={6}
        step={0.1}
        onChange={set('lidThickness')}
        testId="lid-thickness"
      />
      <Slider
        label="Corner radius"
        unit="mm"
        hint="Outer XY corner radius. 0 = sharp corners; values up to ~10 mm produce nicely-rounded edges."
        value={params.cornerRadius}
        min={0}
        max={10}
        step={0.5}
        onChange={set('cornerRadius')}
        testId="corner-radius"
      />
      <Slider
        label="Internal clearance"
        unit="mm"
        hint="XY clearance added between the PCB edge and the inside of the wall. Increase if the PCB rocks or doesn't drop in."
        value={params.internalClearance}
        min={0}
        max={3}
        step={0.1}
        onChange={set('internalClearance')}
        testId="internal-clearance"
      />
      <Slider
        label="Z-clearance"
        unit="mm"
        hint="Headroom above the tallest component before the lid. Outer Z grows by this value."
        value={params.zClearance}
        min={0}
        max={50}
        step={0.5}
        onChange={set('zClearance')}
        testId="z-clearance"
      />
      <Slider
        label="Extra cavity height"
        unit="mm"
        hint="Additional internal cavity height beyond the PCB + Z-clearance — useful for stuffing wiring, batteries, or extra modules under the lid."
        value={params.extraCavityZ ?? 0}
        min={0}
        max={100}
        step={0.5}
        onChange={(v) => patch({ extraCavityZ: v })}
        testId="extra-cavity-z"
      />
      <div className="joint-row">
        <span className="joint-label" id="joint-type-label">
          Joint type
        </span>
        <div className="joint-buttons" role="radiogroup" aria-labelledby="joint-type-label">
          {JOINT_OPTIONS.map((opt) => (
            <label key={opt.value} title={opt.hint}>
              <input
                type="radio"
                name="joint"
                value={opt.value}
                checked={params.joint === opt.value}
                onChange={() => patch({ joint: opt.value })}
                data-testid={`joint-${opt.value}`}
                title={opt.hint}
                aria-label={`${opt.label} — ${opt.hint}`}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
      {params.joint === 'snap-fit' && (
        <div className="joint-row">
          <span className="joint-label" id="snap-type-label">
            Snap type
          </span>
          <div className="joint-buttons" role="radiogroup" aria-labelledby="snap-type-label">
            {(
              [
                {
                  value: 'barb',
                  label: 'Barb Lid',
                  hint: 'Cantilever barb on the lid engages a catch shelf in the case wall — easy to remove with a fingernail.',
                },
                {
                  value: 'full-lid',
                  label: 'Full Lid',
                  hint: 'Full-perimeter lid lip drops past a continuous catch — strongest grip, hardest to open.',
                },
              ] as { value: SnapType; label: string; hint: string }[]
            ).map((opt) => (
              <label key={opt.value} title={opt.hint}>
                <input
                  type="radio"
                  name="snap-type"
                  value={opt.value}
                  checked={(params.snapType ?? 'barb') === opt.value}
                  onChange={() => patch({ snapType: opt.value })}
                  data-testid={`snap-type-${opt.value}`}
                  title={opt.hint}
                  aria-label={`${opt.label} — ${opt.hint}`}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {/* Issue #98 — Recessed-lid hidden for flat-lid joint (no joint
          hardware = no pocket to drop into). Snap-fit + screw-down show it. */}
      {params.joint !== 'flat-lid' && (
        <label className="vent-row" title="If enabled, the lid drops into a pocket flush with the rim — gives a cleaner look but uses more material.">
          <input
            type="checkbox"
            checked={params.lidRecess ?? false}
            onChange={(e) => patch({ lidRecess: e.target.checked })}
            data-testid="lid-recess"
            aria-label="Recessed lid"
            title="If enabled, the lid drops into a pocket flush with the rim."
          />
          <span>Recessed lid (drops into a pocket flush with the rim)</span>
        </label>
      )}
      {/* Issue #98 — Boss-insert type only applies when the joint actually
          uses bosses (screw-down). Hidden for flat-lid and snap-fit. */}
      {params.joint === 'screw-down' && (
        <>
          <div className="joint-row">
            <label className="joint-label" htmlFor="case-insert-type">
              Boss insert type
            </label>
            <select
              id="case-insert-type"
              value={params.bosses.insertType}
              onChange={(e) =>
                patch({ bosses: { ...params.bosses, insertType: e.target.value as InsertType } })
              }
              data-testid="insert-type"
              title="What kind of fastener anchors into the corner bosses."
              aria-label="Boss insert type"
            >
              {INSERT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.hint}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {/* Issue #104 — Boss position. Bottom (default) anchors bosses to
              the floor; Top anchors them to the lid underside with a
              tapered support column on the inside wall (printable open
              side up without supports). */}
          <div className="joint-row">
            <span className="joint-label" id="boss-position-label">
              Boss position
            </span>
            <div className="joint-buttons" role="radiogroup" aria-labelledby="boss-position-label">
              {(
                [
                  {
                    value: 'bottom',
                    label: 'Bottom',
                    hint: 'Bosses rise from the case floor; lid screws down through the lid into the boss tops.',
                  },
                  {
                    value: 'top',
                    label: 'Top',
                    hint: 'Bosses hang from the lid underside, with a tapered support column on the inside wall. Useful for printing the case open-side-up without support material under the bosses.',
                  },
                ] as { value: 'bottom' | 'top'; label: string; hint: string }[]
              ).map((opt) => (
                <label key={opt.value} title={opt.hint}>
                  <input
                    type="radio"
                    name="boss-position"
                    value={opt.value}
                    checked={(params.bosses.position ?? 'bottom') === opt.value}
                    onChange={() =>
                      patch({ bosses: { ...params.bosses, position: opt.value } })
                    }
                    data-testid={`boss-position-${opt.value}`}
                    aria-label={`${opt.label} — ${opt.hint}`}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      {/* Issue #98 — Hinge dropdown sits JUST ABOVE Ventilation. Hidden for
          flat-lid (no closure mechanism to pivot). Replaced the previous
          enable-checkbox + style-radio with a single None / External pin /
          Print-in-place dropdown. Detailed knuckle/pin params expand below. */}
      {params.joint !== 'flat-lid' && <HingeSection params={params} patch={patch} />}
      <label
        className="vent-row"
        title="Add ventilation cutouts to the selected case faces."
      >
        <input
          type="checkbox"
          checked={params.ventilation.enabled}
          onChange={(e) =>
            patch({
              ventilation: {
                ...params.ventilation,
                enabled: e.target.checked,
                pattern: e.target.checked && params.ventilation.pattern === 'none' ? 'slots' : params.ventilation.pattern,
              },
            })
          }
          data-testid="ventilation-toggle"
          aria-label="Ventilation enabled"
          title="Enable ventilation cutouts on the case."
        />
        <span>Ventilation</span>
      </label>
      {params.ventilation.enabled && (
        <>
          <div className="joint-row">
            <span className="joint-label" id="vent-surfaces-label">
              Surfaces
            </span>
            <div className="joint-buttons" role="group" aria-labelledby="vent-surfaces-label">
              {VENT_SURFACES.map((s) => {
                const current = params.ventilation.surfaces ?? ['back'];
                const checked = current.includes(s);
                return (
                  <label key={s} title={`Toggle ventilation on the ${s} face.`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...current, s]
                          : current.filter((x) => x !== s);
                        patch({
                          ventilation: { ...params.ventilation, surfaces: next },
                        });
                      }}
                      data-testid={`vent-surface-${s}`}
                      aria-label={`Vent surface ${s}`}
                      title={`Vent on the ${s} face`}
                    />
                    <span>{s}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="joint-row">
            <span className="joint-label" id="vent-pattern-label">
              Pattern
            </span>
            <div className="joint-buttons" role="radiogroup" aria-labelledby="vent-pattern-label">
              {(
                [
                  { value: 'slots', hint: 'Vertical-slot pattern — fastest to print, easiest to clean.' },
                  { value: 'hex', hint: 'Hexagonal honeycomb pattern — strong, more decorative.' },
                ] as const
              ).map((p) => (
                <label key={p.value} title={p.hint}>
                  <input
                    type="radio"
                    name="vent-pattern"
                    value={p.value}
                    checked={params.ventilation.pattern === p.value}
                    onChange={() => patch({ ventilation: { ...params.ventilation, pattern: p.value } })}
                    data-testid={`vent-pattern-${p.value}`}
                    aria-label={`Ventilation pattern ${p.value}`}
                    title={p.hint}
                  />
                  <span>{p.value}</span>
                </label>
              ))}
            </div>
          </div>
          <Slider
            label="Vent coverage"
            unit="0–1"
            hint="Fraction of the vent area that is open. 0 = solid wall, 1 = maximum open area."
            value={params.ventilation.coverage}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patch({ ventilation: { ...params.ventilation, coverage: v } })}
            testId="vent-coverage"
          />
        </>
      )}
    </div>
  );
}

// =============================================================================
// Issue #92 — barrel-hinge section.
//
// Collapsed by default; the user toggles "Enable hinge" to reveal the full
// form. Lazy-defaults the HingeFeature object on first enable so the schema
// stays clean for users who don't use it (`hinge` remains undefined on
// disk).
// =============================================================================

function defaultHinge(): HingeFeature {
  return {
    id: 'hinge-1',
    style: 'external-pin',
    face: '-y',
    numKnuckles: 5,
    knuckleOuterDiameter: 8,
    pinDiameter: 3,
    knuckleClearance: 0.4,
    positioning: 'centered',
    hingeLength: 60,
    pinMode: 'separate',
    enabled: true,
  };
}

interface HingeSectionProps {
  params: CaseParameters;
  patch: (p: Partial<CaseParameters>) => void;
}

const HINGE_STYLE_OPTIONS: { value: HingeStyle; label: string; hint: string }[] = [
  {
    value: 'external-pin',
    label: 'External pin',
    hint: 'Knuckles + a separate pin (M3 screw or 3 mm brass rod). Easiest to print, strongest action.',
  },
  {
    value: 'print-in-place',
    label: 'Print-in-place',
    hint: 'Pin solid is printed inside the through-hole — no assembly required, slightly looser action.',
  },
  {
    value: 'piano-continuous',
    label: 'Piano (continuous)',
    hint: 'Many tightly-spaced knuckles giving a visually-continuous hinge bar. Strongest action — best for protective cases. (#110)',
  },
  {
    value: 'piano-segmented',
    label: 'Piano (segmented)',
    hint: '5–7 knuckle clusters with gaps. Easier to print than continuous; visually similar. (#110)',
  },
  {
    value: 'pip-pivot',
    label: 'Pip pivot',
    hint: 'Two short pivot bosses near the ends, no centerline pin. Lid clips on. Suitable only for shallow cases (< 80 mm). (#110)',
  },
];

const HINGE_FACE_OPTIONS: { value: HingeFeature['face']; label: string }[] = [
  { value: '-y', label: '-y (front)' },
  { value: '+y', label: '+y (back)' },
  { value: '-x', label: '-x (left)' },
  { value: '+x', label: '+x (right)' },
];

const HINGE_POSITIONING_OPTIONS: { value: HingePositioning; label: string; hint: string }[] = [
  { value: 'continuous', label: 'Continuous', hint: 'Hinge run starts at the face origin and spans hingeLength.' },
  { value: 'pair-at-ends', label: 'Pair at ends', hint: 'Knuckle clusters near the face ends (v1 approximation).' },
  { value: 'centered', label: 'Centered', hint: 'Hinge run is centered along the face — recommended default.' },
];

/** Issue #98 — Hinge dropdown values. 'none' fully disables the hinge
 *  (sets feature.enabled=false); the other two map to existing styles. */
type HingeDropdownValue = 'none' | HingeStyle;

function HingeSection({ params, patch }: HingeSectionProps) {
  const hinge = params.hinge;
  const setHinge = (next: HingeFeature | undefined) => patch({ hinge: next });
  const updateHinge = (p: Partial<HingeFeature>) => {
    if (!hinge) return;
    setHinge({ ...hinge, ...p });
  };
  const enabled = !!hinge?.enabled;
  // Dropdown current value: 'none' if disabled, otherwise the style.
  const dropdownValue: HingeDropdownValue = enabled ? hinge!.style : 'none';
  const onDropdownChange = (next: HingeDropdownValue): void => {
    if (next === 'none') {
      if (hinge) setHinge({ ...hinge, enabled: false });
      return;
    }
    // Selecting a style enables the hinge; pinMode follows the style choice.
    const nextPinMode: HingePinMode =
      next === 'print-in-place' ? 'print-in-place' : 'separate';
    if (hinge) {
      setHinge({ ...hinge, enabled: true, style: next, pinMode: nextPinMode });
    } else {
      setHinge({ ...defaultHinge(), style: next, pinMode: nextPinMode });
    }
  };
  return (
    <div className="hinge-section">
      <div className="joint-row">
        <label className="joint-label" htmlFor="case-hinge-style">
          Hinge
        </label>
        <select
          id="case-hinge-style"
          value={dropdownValue}
          onChange={(e) => onDropdownChange(e.target.value as HingeDropdownValue)}
          data-testid="hinge-style-dropdown"
          title="Hinge style. None disables the hinge entirely; External pin uses a separate M3 screw or brass rod; Print-in-place prints the pin inside the through-hole as one part."
          aria-label="Hinge style"
        >
          <option value="none" title="No hinge — lid is fully removable.">
            None
          </option>
          {HINGE_STYLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} title={opt.hint}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {enabled && hinge && (
        <>
          <div className="joint-row">
            <span className="joint-label" id="hinge-face-label">
              Face
            </span>
            <div className="joint-buttons" role="radiogroup" aria-labelledby="hinge-face-label">
              {HINGE_FACE_OPTIONS.map((opt) => (
                <label key={opt.value} title={`Place the hinge on the ${opt.value} face.`}>
                  <input
                    type="radio"
                    name="hinge-face"
                    value={opt.value}
                    checked={hinge.face === opt.value}
                    onChange={() => updateHinge({ face: opt.value })}
                    data-testid={`hinge-face-${opt.value}`}
                    aria-label={`Hinge face ${opt.label}`}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
          <LabelledField
            label="Knuckle count"
            unit="count"
            hint="Total knuckle slots. Odd, ≥3. Even indices are case-attached; odd indices are lid-attached."
          >
            <input
              type="number"
              min={3}
              step={2}
              value={hinge.numKnuckles}
              onChange={(e) =>
                updateHinge({ numKnuckles: Math.max(3, Number(e.target.value) || 3) })
              }
              data-testid="hinge-num-knuckles"
              className="numeric-input"
            />
          </LabelledField>
          <LabelledField
            label="Knuckle Ø"
            unit="mm"
            hint="Outside diameter of every knuckle cylinder."
          >
            <input
              type="number"
              min={4}
              max={20}
              step={0.5}
              value={hinge.knuckleOuterDiameter}
              onChange={(e) =>
                updateHinge({ knuckleOuterDiameter: Number(e.target.value) || 8 })
              }
              data-testid="hinge-knuckle-od"
              className="numeric-input"
            />
          </LabelledField>
          <LabelledField
            label="Pin Ø"
            unit="mm"
            hint="Pin / through-hole nominal diameter. 3 mm fits an M3 screw or brass rod."
          >
            <input
              type="number"
              min={1}
              max={6}
              step={0.1}
              value={hinge.pinDiameter}
              onChange={(e) =>
                updateHinge({ pinDiameter: Number(e.target.value) || 3 })
              }
              data-testid="hinge-pin-d"
              className="numeric-input"
            />
          </LabelledField>
          <div className="joint-row">
            <span className="joint-label" id="hinge-positioning-label">
              Positioning
            </span>
            <div className="joint-buttons" role="radiogroup" aria-labelledby="hinge-positioning-label">
              {HINGE_POSITIONING_OPTIONS.map((opt) => (
                <label key={opt.value} title={opt.hint}>
                  <input
                    type="radio"
                    name="hinge-positioning"
                    value={opt.value}
                    checked={hinge.positioning === opt.value}
                    onChange={() => updateHinge({ positioning: opt.value })}
                    data-testid={`hinge-positioning-${opt.value}`}
                    aria-label={`${opt.label} — ${opt.hint}`}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
          <LabelledField
            label="Hinge length"
            unit="mm"
            hint="Total length of the knuckle run, including clearances."
          >
            <input
              type="number"
              min={6}
              max={200}
              step={1}
              value={hinge.hingeLength}
              onChange={(e) =>
                updateHinge({ hingeLength: Number(e.target.value) || 60 })
              }
              data-testid="hinge-length"
              className="numeric-input"
            />
          </LabelledField>
          {/* Issue #98 — Pin-mode radio removed; pinMode now follows the
              hinge dropdown style choice ('print-in-place' style ⇒
              print-in-place pin, 'external-pin' style ⇒ separate hardware). */}
        </>
      )}
    </div>
  );
}
