import type { ChangeEvent } from 'react';
import { useProjectStore } from '@/store/projectStore';
import type { CaseParameters, JointType, InsertType, SnapType } from '@/types';

const JOINT_OPTIONS: { value: JointType; label: string }[] = [
  { value: 'flat-lid', label: 'Flat lid' },
  { value: 'snap-fit', label: 'Snap-fit' },
  { value: 'screw-down', label: 'Screw-down' },
];

const INSERT_OPTIONS: { value: InsertType; label: string }[] = [
  { value: 'self-tap', label: 'Self-tap M2.5' },
  { value: 'heat-set-m2.5', label: 'Heat-set M2.5' },
  { value: 'heat-set-m3', label: 'Heat-set M3' },
  { value: 'pass-through', label: 'Pass-through' },
];

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  testId?: string;
}

function Slider({ label, value, min, max, step, onChange, testId }: SliderProps) {
  const handle = (e: ChangeEvent<HTMLInputElement>): void => onChange(Number(e.target.value));
  return (
    <label className="slider-row">
      <div className="slider-label">
        <span>{label}</span>
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
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handle}
        className="slider-num"
        data-testid={testId ? `${testId}-num` : undefined}
      />
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
        label="Wall thickness (mm)"
        value={params.wallThickness}
        min={1}
        max={6}
        step={0.1}
        onChange={set('wallThickness')}
        testId="wall-thickness"
      />
      <Slider
        label="Floor thickness (mm)"
        value={params.floorThickness}
        min={1}
        max={6}
        step={0.1}
        onChange={set('floorThickness')}
        testId="floor-thickness"
      />
      <Slider
        label="Lid thickness (mm)"
        value={params.lidThickness}
        min={1}
        max={6}
        step={0.1}
        onChange={set('lidThickness')}
        testId="lid-thickness"
      />
      <Slider
        label="Internal clearance (mm)"
        value={params.internalClearance}
        min={0}
        max={3}
        step={0.1}
        onChange={set('internalClearance')}
        testId="internal-clearance"
      />
      <Slider
        label="Z-clearance (mm)"
        value={params.zClearance}
        min={0}
        max={50}
        step={0.5}
        onChange={set('zClearance')}
        testId="z-clearance"
      />
      <Slider
        label="Extra cavity height (mm)"
        value={params.extraCavityZ ?? 0}
        min={0}
        max={100}
        step={0.5}
        onChange={(v) => patch({ extraCavityZ: v })}
        testId="extra-cavity-z"
      />
      <div className="joint-row">
        <span className="joint-label">Joint type</span>
        <div className="joint-buttons" role="radiogroup" aria-label="Joint type">
          {JOINT_OPTIONS.map((opt) => (
            <label key={opt.value}>
              <input
                type="radio"
                name="joint"
                value={opt.value}
                checked={params.joint === opt.value}
                onChange={() => patch({ joint: opt.value })}
                data-testid={`joint-${opt.value}`}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
      {params.joint === 'snap-fit' && (
        <div className="joint-row">
          <span className="joint-label">Snap type</span>
          <div className="joint-buttons" role="radiogroup" aria-label="Snap type">
            {(
              [
                { value: 'barb', label: 'Barb Lid' },
                { value: 'full-lid', label: 'Full Lid' },
              ] as { value: SnapType; label: string }[]
            ).map((opt) => (
              <label key={opt.value}>
                <input
                  type="radio"
                  name="snap-type"
                  value={opt.value}
                  checked={(params.snapType ?? 'barb') === opt.value}
                  onChange={() => patch({ snapType: opt.value })}
                  data-testid={`snap-type-${opt.value}`}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="joint-row">
        <span className="joint-label">Boss insert type</span>
        <select
          value={params.bosses.insertType}
          onChange={(e) =>
            patch({ bosses: { ...params.bosses, insertType: e.target.value as InsertType } })
          }
          data-testid="insert-type"
        >
          {INSERT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <label className="vent-row">
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
        />
        <span>Ventilation on back wall</span>
      </label>
      {params.ventilation.enabled && (
        <>
          <div className="joint-row">
            <span className="joint-label">Pattern</span>
            <div className="joint-buttons" role="radiogroup" aria-label="Ventilation pattern">
              {(['slots', 'hex'] as const).map((p) => (
                <label key={p}>
                  <input
                    type="radio"
                    name="vent-pattern"
                    value={p}
                    checked={params.ventilation.pattern === p}
                    onChange={() => patch({ ventilation: { ...params.ventilation, pattern: p } })}
                    data-testid={`vent-pattern-${p}`}
                  />
                  <span>{p}</span>
                </label>
              ))}
            </div>
          </div>
          <Slider
            label="Vent coverage"
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
