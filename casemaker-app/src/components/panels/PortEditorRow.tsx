import { useState } from 'react';
import type { PortPlacement, CutoutShape } from '@/types';

/**
 * Issue #68 — collapsible per-port editor row. Shows enable + summary in
 * the header; expanding reveals position/size/margin/shape inputs and a
 * "reset to component default" button.
 *
 * Rendered by both PortsPanel (board ports) and HatsPanel (HAT ports);
 * the parent supplies the patch / reset / setEnabled callbacks so this
 * component stays decoupled from the store.
 */
export interface PortEditorRowProps {
  port: PortPlacement;
  onSetEnabled: (enabled: boolean) => void;
  onPatch: (patch: {
    position?: Partial<{ x: number; y: number; z: number }>;
    size?: Partial<{ x: number; y: number; z: number }>;
    cutoutMargin?: number;
    cutoutShape?: CutoutShape;
  }) => void;
  onReset?: () => void;
  testIdPrefix?: string;
}

export function PortEditorRow({
  port,
  onSetEnabled,
  onPatch,
  onReset,
  testIdPrefix,
}: PortEditorRowProps) {
  const [open, setOpen] = useState(false);
  const tid = testIdPrefix ?? `port-${port.id}`;
  return (
    <li className="port-editor-row">
      <div className="port-editor-row__head">
        <input
          type="checkbox"
          checked={port.enabled}
          onChange={(e) => onSetEnabled(e.target.checked)}
          data-testid={`${tid}-enabled`}
        />
        <button
          className="port-editor-row__expand"
          onClick={() => setOpen((v) => !v)}
          data-testid={`${tid}-expand`}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} {port.kind} <span className="port-facing">[{port.facing}]</span>
        </button>
      </div>
      {open && (
        <div className="port-editor-row__body">
          <div className="port-coord-grid">
            <span className="coord-label" />
            <span className="coord-axis">x</span>
            <span className="coord-axis">y</span>
            <span className="coord-axis">z</span>
            <span className="coord-label">pos</span>
            <NumInput value={port.position.x} onChange={(v) => onPatch({ position: { x: v } })} testId={`${tid}-pos-x`} title="Position X (mm)" />
            <NumInput value={port.position.y} onChange={(v) => onPatch({ position: { y: v } })} testId={`${tid}-pos-y`} title="Position Y (mm)" />
            <NumInput value={port.position.z} onChange={(v) => onPatch({ position: { z: v } })} testId={`${tid}-pos-z`} title="Position Z (mm)" />
            <span className="coord-label">size</span>
            <NumInput value={port.size.x} onChange={(v) => onPatch({ size: { x: v } })} testId={`${tid}-size-x`} title="Size X — depth into the wall (mm)" />
            <NumInput value={port.size.y} onChange={(v) => onPatch({ size: { y: v } })} testId={`${tid}-size-y`} title="Size Y (mm)" />
            <NumInput value={port.size.z} onChange={(v) => onPatch({ size: { z: v } })} testId={`${tid}-size-z`} title="Size Z (mm)" />
          </div>
          <div className="port-editor-row__extras">
            <label>
              margin
              <NumInput
                value={port.cutoutMargin}
                step={0.1}
                onChange={(v) => onPatch({ cutoutMargin: v })}
                testId={`${tid}-margin`}
                title="Extra clearance added to the cutout (mm). For round shapes the hole diameter = max(size.y, size.z) + 2 × margin."
              />
            </label>
            <label>
              shape
              <select
                value={port.cutoutShape ?? 'rect'}
                onChange={(e) => onPatch({ cutoutShape: e.target.value as CutoutShape })}
                data-testid={`${tid}-shape`}
              >
                <option value="rect">rect</option>
                <option value="round">round</option>
              </select>
            </label>
            {onReset && (
              <button onClick={onReset} data-testid={`${tid}-reset`} title="Reset to component default">
                ↺ reset
              </button>
            )}
          </div>
          {port.cutoutShape === 'round' && (
            <p className="port-editor-row__hint">
              Round hole diameter = max(size.y={port.size.y.toFixed(1)}, size.z={port.size.z.toFixed(1)}) + 2 × margin = <strong>{(Math.max(port.size.y, port.size.z) + 2 * port.cutoutMargin).toFixed(2)} mm</strong>. Shrink size.y / size.z to make it smaller.
            </p>
          )}
          {port.cutoutShape !== 'round' && (
            <p className="port-editor-row__hint">
              Rect cutout = (size.y + 2 × margin) × (size.z + 2 × margin) on the wall face. Shrink the corresponding axis to make it smaller.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function NumInput({
  value,
  step = 0.1,
  onChange,
  testId,
  title,
}: {
  value: number;
  step?: number;
  onChange: (v: number) => void;
  testId?: string;
  title?: string;
}) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      title={title}
      className="slider-num"
      style={{ width: '100%' }}
    />
  );
}
