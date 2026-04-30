import { useState } from 'react';
import type { PortPlacement, CutoutShape } from '@/types';
import { useViewportStore } from '@/store/viewportStore';

/**
 * Issue #68 — per-port editor row.
 *
 * Two modes:
 *
 *   1. **Click-to-select** (Phase 4b, host-board ports): caller passes
 *      `onSelect`. Row is compact one-liner; clicking sets
 *      `viewportStore.selection = { kind: 'port', portId }` and the
 *      right-rail ContextPanel renders the detail form.
 *
 *   2. **Inline expand** (legacy, HAT ports — they live under a HAT
 *      placement and need scoped patch callbacks that don't fit the
 *      global selection model): caller passes `onPatch` / `onReset`. Row
 *      shows a disclosure caret; clicking expands position / size /
 *      margin / shape inputs in place. This stays as-is until a future
 *      phase introduces a HAT-port-aware selection scope.
 *
 * Pass exactly one of (`onSelect`) or (`onPatch` + optional `onReset`).
 */
export interface PortEditorRowProps {
  port: PortPlacement;
  onSetEnabled: (enabled: boolean) => void;
  /** Click-to-select mode — caller routes the selection elsewhere. */
  onSelect?: (portId: string) => void;
  /** Inline-expand mode — caller patches the port directly. */
  onPatch?: (patch: {
    position?: Partial<{ x: number; y: number; z: number }>;
    size?: Partial<{ x: number; y: number; z: number }>;
    cutoutMargin?: number;
    cutoutShape?: CutoutShape;
  }) => void;
  /** Inline-expand mode — reset to source-component default. */
  onReset?: () => void;
  testIdPrefix?: string;
}

export function PortEditorRow({
  port,
  onSetEnabled,
  onSelect,
  onPatch,
  onReset,
  testIdPrefix,
}: PortEditorRowProps) {
  const tid = testIdPrefix ?? `port-${port.id}`;
  const portLabel = port.kind === 'custom' && port.sourceComponentId
    ? port.sourceComponentId
    : port.kind;
  const isSelected = useViewportStore(
    (s) => s.selection?.kind === 'port' && s.selection.portId === port.id,
  );
  const inlineMode = !onSelect && !!onPatch;
  const [open, setOpen] = useState(false);
  return (
    <li
      className={`port-editor-row${isSelected ? ' port-editor-row--selected' : ''}`}
    >
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
          onClick={() => {
            if (onSelect) onSelect(port.id);
            else setOpen((v) => !v);
          }}
          data-testid={`${tid}-expand`}
          aria-pressed={onSelect ? isSelected : undefined}
          aria-expanded={inlineMode ? open : undefined}
          title={
            onSelect
              ? "Open this port's detail editor in the right rail (position / size / margin / shape)"
              : open
                ? 'Collapse port details'
                : 'Expand to edit position / size / margin / shape'
          }
        >
          {inlineMode && (open ? '▾ ' : '▸ ')}
          {portLabel}{' '}
          <span className="port-facing">[{port.facing}]</span>
        </button>
      </div>
      {inlineMode && open && onPatch && (
        <div className="port-editor-row__body">
          <div className="port-coord-grid">
            <span className="coord-label" />
            <span className="coord-axis">x</span>
            <span className="coord-axis">y</span>
            <span className="coord-axis">z</span>
            <span className="coord-label">pos</span>
            <NumInput value={port.position.x} onChange={(v) => onPatch({ position: { x: v } })} testId={`${tid}-pos-x`} ariaLabel={`Port ${portLabel} position X (mm)`} title="Position X (mm)" />
            <NumInput value={port.position.y} onChange={(v) => onPatch({ position: { y: v } })} testId={`${tid}-pos-y`} ariaLabel={`Port ${portLabel} position Y (mm)`} title="Position Y (mm)" />
            <NumInput value={port.position.z} onChange={(v) => onPatch({ position: { z: v } })} testId={`${tid}-pos-z`} ariaLabel={`Port ${portLabel} position Z (mm)`} title="Position Z (mm)" />
            <span className="coord-label">size</span>
            <NumInput value={port.size.x} onChange={(v) => onPatch({ size: { x: v } })} testId={`${tid}-size-x`} ariaLabel={`Port ${portLabel} size X (mm)`} title="Size X (mm)" />
            <NumInput value={port.size.y} onChange={(v) => onPatch({ size: { y: v } })} testId={`${tid}-size-y`} ariaLabel={`Port ${portLabel} size Y (mm)`} title="Size Y (mm)" />
            <NumInput value={port.size.z} onChange={(v) => onPatch({ size: { z: v } })} testId={`${tid}-size-z`} ariaLabel={`Port ${portLabel} size Z (mm)`} title="Size Z (mm)" />
          </div>
          <div className="port-editor-row__extras">
            <label>
              <span>margin (mm)</span>
              <NumInput value={port.cutoutMargin} onChange={(v) => onPatch({ cutoutMargin: v })} testId={`${tid}-margin`} ariaLabel={`Port ${portLabel} cutout margin (mm)`} title="Extra clearance added to the cutout (mm)." />
            </label>
            <label>
              <span>shape</span>
              <select
                value={port.cutoutShape ?? 'rect'}
                onChange={(e) => onPatch({ cutoutShape: e.target.value as CutoutShape })}
                data-testid={`${tid}-shape`}
                aria-label={`Port ${portLabel} cutout shape`}
                title="Cutout shape — rectangle or round."
              >
                <option value="rect">rect</option>
                <option value="round">round</option>
              </select>
            </label>
            {onReset && (
              <button onClick={onReset} data-testid={`${tid}-reset`} title="Reset to component default" aria-label={`Reset port ${portLabel} to default`}>
                ↺ reset
              </button>
            )}
          </div>
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
