import type { ChangeEvent } from 'react';
import { useProjectStore } from '@/store/projectStore';
import type { CaseParameters } from '@/types';

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
    </div>
  );
}
