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
 *
 * Issue #89 — every input has aria-label + title. Visible column-axis chips
 * supplement the per-cell labels for screen-reader-free hovers.
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
  const portLabel = port.kind === 'custom' && port.sourceComponentId
    ? port.sourceComponentId
    : port.kind;
  return (
    <li className="port-editor-row">
      <div className="port-editor-row__head">
        <label className="cell-label" title={`Enable / disable the cutout for the ${portLabel} port.`}>
          <span className="cell-label__axis">on</span>
          <input
            type="checkbox"
            checked={port.enabled}
            onChange={(e) => onSetEnabled(e.target.checked)}
            data-testid={`${tid}-enabled`}
            aria-label={`Port ${portLabel} enabled`}
          />
        </label>
        <button
          className="port-editor-row__expand"
          onClick={() => setOpen((v) => !v)}
          data-testid={`${tid}-expand`}
          aria-expanded={open}
          title={open ? 'Collapse port details' : 'Expand to edit position / size / margin / shape'}
        >
          {open ? '▾' : '▸'}{' '}
          {/* Issue #79 — show the source component id when kind is 'custom'
              (e.g., DMX shield XLRs would otherwise all read "custom"). */}
          {portLabel}{' '}
          <span className="port-facing">[{port.facing}]</span>
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
            <NumInput
              value={port.position.x}
              onChange={(v) => onPatch({ position: { x: v } })}
              testId={`${tid}-pos-x`}
              ariaLabel={`Port ${portLabel} position X (mm)`}
              title="Position X (mm)"
            />
            <NumInput
              value={port.position.y}
              onChange={(v) => onPatch({ position: { y: v } })}
              testId={`${tid}-pos-y`}
              ariaLabel={`Port ${portLabel} position Y (mm)`}
              title="Position Y (mm)"
            />
            <NumInput
              value={port.position.z}
              onChange={(v) => onPatch({ position: { z: v } })}
              testId={`${tid}-pos-z`}
              ariaLabel={`Port ${portLabel} position Z (mm)`}
              title="Position Z (mm)"
            />
            <span className="coord-label">size</span>
            <NumInput
              value={port.size.x}
              onChange={(v) => onPatch({ size: { x: v } })}
              testId={`${tid}-size-x`}
              ariaLabel={`Port ${portLabel} size X (mm)`}
              title="Size X — depth into the wall (mm)"
            />
            <NumInput
              value={port.size.y}
              onChange={(v) => onPatch({ size: { y: v } })}
              testId={`${tid}-size-y`}
              ariaLabel={`Port ${portLabel} size Y (mm)`}
              title="Size Y (mm)"
            />
            <NumInput
              value={port.size.z}
              onChange={(v) => onPatch({ size: { z: v } })}
              testId={`${tid}-size-z`}
              ariaLabel={`Port ${portLabel} size Z (mm)`}
              title="Size Z (mm)"
            />
          </div>
          <div className="port-editor-row__extras">
            <label>
              <span>margin (mm)</span>
              <NumInput
                value={port.cutoutMargin}
                step={0.1}
                onChange={(v) => onPatch({ cutoutMargin: v })}
                testId={`${tid}-margin`}
                ariaLabel={`Port ${portLabel} cutout margin (mm)`}
                title="Extra clearance added to the cutout (mm). For round shapes the hole diameter = max(size.y, size.z) + 2 × margin."
              />
            </label>
            <label>
              <span>shape</span>
              <select
                value={port.cutoutShape ?? 'rect'}
                onChange={(e) => onPatch({ cutoutShape: e.target.value as CutoutShape })}
                data-testid={`${tid}-shape`}
                aria-label={`Port ${portLabel} cutout shape`}
                title="Cutout shape — rectangle (size.y × size.z) or round (max axis = diameter)."
              >
                <option value="rect">rect</option>
                <option value="round">round</option>
              </select>
            </label>
            {onReset && (
              <button
                onClick={onReset}
                data-testid={`${tid}-reset`}
                title="Reset position / size / margin / shape back to the component's default values."
                aria-label={`Reset port ${portLabel} to default`}
              >
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
  ariaLabel,
  title,
}: {
  value: number;
  step?: number;
  onChange: (v: number) => void;
  testId?: string;
  ariaLabel: string;
  title?: string;
}) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      aria-label={ariaLabel}
      title={title}
      className="port-num numeric-input"
      style={{ width: '100%' }}
    />
  );
}
