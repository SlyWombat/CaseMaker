import { useEffect } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { getBoard } from '@/library/registry';
import { getBuiltinHat } from '@/library/hats';
import type { CutoutShape, PortPlacement } from '@/types';
import type { SnapCatch, SnapWall, BarbType } from '@/types/snap';
import { BARB_TYPES } from '@/types/snap';
import type { MountingFeature } from '@/types/mounting';
import type { BoardComponent, Facing } from '@/types/board';

/**
 * Issue #83 — floating panel that surfaces the active in-viewport selection
 * (host PCB or HAT placement) and exposes the per-domain offset fields.
 *
 * - Host: Z = `board.defaultStandoffHeight`. X/Y disabled in v1 pending the
 *   v7 schema migration that adds `Project.hostBoardOffset`.
 * - HAT: Z = `liftOverride`, X/Y = `offsetOverride`.
 *
 * Keyboard nudge:
 * - Arrow keys / Q / E nudge X/Y by 0.5 mm (Shift × 10).
 * - PageUp / PageDown nudge Z by 0.5 mm (Shift × 10).
 * - Escape clears the selection.
 *
 * All shortcuts gate against input focus + modifier keys so they don't fire
 * while the user is typing into a panel field elsewhere in the app.
 */

const STEP = 0.5;
const STEP_FAST = 5;

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function SelectionPanel() {
  const selection = useViewportStore((s) => s.selection);
  const setSelection = useViewportStore((s) => s.setSelection);
  const project = useProjectStore((s) => s.project);
  const patchBoardMeta = useProjectStore((s) => s.patchBoardMeta);
  const patchHat = useProjectStore((s) => s.patchHat);
  const patchPort = useProjectStore((s) => s.patchPort);
  const resetPort = useProjectStore((s) => s.resetPortToDefault);
  const patchSnapCatch = useProjectStore((s) => s.patchSnapCatch);
  const patchMountingFeature = useProjectStore((s) => s.patchMountingFeature);
  const patchComponent = useProjectStore((s) => s.patchComponent);

  // Track whether we've already warned about host X/Y nudge being a no-op
  // in v1 — log once per page session.
  useEffect(() => {
    // no-op effect; the warn is fired inline below.
  }, []);

  // Keyboard nudge handler. Bound to window so the user doesn't have to
  // focus the panel — the selection itself is the focus context.
  useEffect(() => {
    if (!selection) return;
    let warnedHostXY = false;
    function onKey(e: KeyboardEvent) {
      if (!selection) return;
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setSelection(null);
        return;
      }
      const step = (e.shiftKey ? STEP_FAST : STEP) * 10 / 10; // keep 0.5 / 5
      // Map keys to deltas. Z moves on PageUp / PageDown only — arrow keys
      // are X/Y. Q/E are convenience for X (matches issue spec).
      let dx = 0;
      let dy = 0;
      let dz = 0;
      switch (e.key) {
        case 'ArrowLeft':
          dx = -step;
          break;
        case 'ArrowRight':
          dx = step;
          break;
        case 'ArrowDown':
          dy = -step;
          break;
        case 'ArrowUp':
          dy = step;
          break;
        case 'q':
        case 'Q':
          dx = -step;
          break;
        case 'e':
        case 'E':
          dx = step;
          break;
        case 'PageDown':
          dz = -step;
          break;
        case 'PageUp':
          dz = step;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (selection.kind === 'host') {
        if (dx !== 0 || dy !== 0) {
          if (!warnedHostXY) {
            console.info(
              '[SelectionPanel] host PCB X/Y nudge is disabled in v1; coming with the v7 schema migration (issue #83).',
            );
            warnedHostXY = true;
          }
          return;
        }
        if (dz !== 0) {
          const next = Math.max(0, project.board.defaultStandoffHeight + dz);
          patchBoardMeta({ defaultStandoffHeight: round(next) });
        }
      } else if (selection.kind === 'port') {
        // Issue #94 — port nudge already handled by PortMarkers' own
        // keyboard handler (axis-locked + facing-aware via
        // nudgeVectorsForFacing). Skip here to avoid double-firing.
        return;
      } else if (
        selection.kind === 'snap-catch' ||
        selection.kind === 'mounting-feature' ||
        selection.kind === 'component'
      ) {
        // Issue #95 / #96 / #97 — these selections don't have a 3D
        // pivot to nudge yet; arrow keys reach the right-rail form
        // through native input focus instead.
        return;
      } else if (selection.kind === 'hat') {
        const placement = project.hats?.find((h) => h.id === selection.hatPlacementId);
        if (!placement) return;
        if (dz !== 0) {
          const profile =
            (project.customHats ?? []).find((h) => h.id === placement.hatId) ??
            getBuiltinHat(placement.hatId);
          const baseLift = placement.liftOverride ?? profile?.headerHeight ?? 0;
          const next = Math.max(0, baseLift + dz);
          patchHat(placement.id, { liftOverride: round(next) });
        }
        if (dx !== 0 || dy !== 0) {
          const cur = placement.offsetOverride ?? { x: 0, y: 0 };
          patchHat(placement.id, {
            offsetOverride: { x: round(cur.x + dx), y: round(cur.y + dy) },
          });
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, project.board.defaultStandoffHeight, project.hats, project.customHats, patchBoardMeta, patchHat, setSelection]);

  if (!selection) return null;

  if (selection.kind === 'port') {
    const port = project.ports.find((p) => p.id === selection.portId);
    if (!port) return null;
    return (
      <PortDetail
        port={port}
        onClose={() => setSelection(null)}
        onPatch={(patch) => patchPort(port.id, patch)}
        onReset={port.sourceComponentId ? () => resetPort(port.id) : undefined}
      />
    );
  }

  if (selection.kind === 'snap-catch') {
    const c = project.case.snapCatches?.find((x) => x.id === selection.catchId);
    if (!c) return null;
    return (
      <SnapCatchDetail
        catch_={c}
        onClose={() => setSelection(null)}
        onPatch={(patch) => patchSnapCatch(c.id, patch)}
      />
    );
  }

  if (selection.kind === 'mounting-feature') {
    const f = project.mountingFeatures?.find((x) => x.id === selection.featureId);
    if (!f) return null;
    return (
      <MountingFeatureDetail
        feature={f}
        onClose={() => setSelection(null)}
        onPatch={(patch) => patchMountingFeature(f.id, patch)}
      />
    );
  }

  if (selection.kind === 'component') {
    const comp = project.board.components.find((c) => c.id === selection.componentId);
    if (!comp) return null;
    return (
      <ComponentDetail
        component={comp}
        onClose={() => setSelection(null)}
        onPatch={(patch) => patchComponent(comp.id, patch)}
      />
    );
  }

  if (selection.kind === 'host') {
    const board = project.board;
    const sourceId = board.clonedFrom ?? board.id;
    const builtinDefault =
      getBoard(sourceId)?.defaultStandoffHeight ?? board.defaultStandoffHeight;
    return (
      <div className="selection-panel" data-testid="selection-panel">
        <div className="selection-panel__header">
          <span className="selection-panel__title">Host PCB</span>
          <button
            type="button"
            className="selection-panel__close"
            onClick={() => setSelection(null)}
            aria-label="Close selection"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div className="selection-panel__subtitle">{board.name}</div>
        <FieldRow label="Standoff Z (mm)">
          <input
            type="number"
            className="numeric-input selection-panel__input"
            step={STEP}
            min={0}
            value={board.defaultStandoffHeight}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) {
                patchBoardMeta({ defaultStandoffHeight: round(v) });
              }
            }}
            data-testid="selection-host-standoff"
            aria-label="Host PCB standoff Z (mm)"
            title="Z lift between the case floor and the bottom of the PCB (mm)."
          />
        </FieldRow>
        <FieldRow label="X offset (mm)">
          <input
            type="number"
            className="numeric-input selection-panel__input"
            value={0}
            disabled
            title="Host PCB X offset is coming soon (issue #83 follow-up). Standoff Z is editable above."
            aria-label="Host PCB X offset (disabled — coming soon)"
          />
        </FieldRow>
        <FieldRow label="Y offset (mm)">
          <input
            type="number"
            className="numeric-input selection-panel__input"
            value={0}
            disabled
            title="Host PCB Y offset is coming soon (issue #83 follow-up). Standoff Z is editable above."
            aria-label="Host PCB Y offset (disabled — coming soon)"
          />
        </FieldRow>
        <div className="selection-panel__hint">
          PageUp / PageDown nudges Z by {STEP} mm (Shift × 10).
        </div>
        <div className="selection-panel__actions">
          <button
            type="button"
            className="selection-panel__btn"
            onClick={() => patchBoardMeta({ defaultStandoffHeight: builtinDefault })}
            data-testid="selection-host-reset"
          >
            Reset
          </button>
        </div>
      </div>
    );
  }

  // HAT
  const placement = project.hats?.find((h) => h.id === selection.hatPlacementId);
  if (!placement) {
    // Selection points at a HAT that no longer exists — clear and bail.
    return null;
  }
  const profile =
    (project.customHats ?? []).find((h) => h.id === placement.hatId) ??
    getBuiltinHat(placement.hatId);
  const liftValue = placement.liftOverride ?? profile?.headerHeight ?? 0;
  const offX = placement.offsetOverride?.x ?? 0;
  const offY = placement.offsetOverride?.y ?? 0;
  return (
    <div className="selection-panel" data-testid="selection-panel">
      <div className="selection-panel__header">
        <span className="selection-panel__title">{profile?.name ?? 'HAT'}</span>
        <button
          type="button"
          className="selection-panel__close"
          onClick={() => setSelection(null)}
          aria-label="Close selection"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div className="selection-panel__subtitle">stack #{placement.stackIndex}</div>
      <FieldRow label="Lift Z (mm)">
        <input
          type="number"
          className="numeric-input selection-panel__input"
          step={STEP}
          min={0}
          value={liftValue}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0) {
              patchHat(placement.id, { liftOverride: round(v) });
            }
          }}
          data-testid="selection-hat-lift"
          aria-label="HAT lift Z (mm)"
          title="Z lift of this HAT above the host PCB (mm). Use to override the header height."
        />
      </FieldRow>
      <FieldRow label="X offset (mm)">
        <input
          type="number"
          className="numeric-input selection-panel__input"
          step={STEP}
          value={offX}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) {
              patchHat(placement.id, {
                offsetOverride: { x: round(v), y: offY },
              });
            }
          }}
          data-testid="selection-hat-x"
          aria-label="HAT X offset (mm)"
          title="HAT X offset relative to the host PCB origin (mm)."
        />
      </FieldRow>
      <FieldRow label="Y offset (mm)">
        <input
          type="number"
          className="numeric-input selection-panel__input"
          step={STEP}
          value={offY}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) {
              patchHat(placement.id, {
                offsetOverride: { x: offX, y: round(v) },
              });
            }
          }}
          data-testid="selection-hat-y"
          aria-label="HAT Y offset (mm)"
          title="HAT Y offset relative to the host PCB origin (mm)."
        />
      </FieldRow>
      <div className="selection-panel__hint">
        Arrows / Q / E nudge X/Y, PageUp / PageDown nudges Z (Shift × 10).
      </div>
      <div className="selection-panel__actions">
        <button
          type="button"
          className="selection-panel__btn"
          onClick={() =>
            patchHat(placement.id, {
              liftOverride: undefined,
              offsetOverride: undefined,
            })
          }
          data-testid="selection-hat-reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  // Wrapping the input in <label> auto-associates it for a11y; the visible
  // text is still rendered. Each input also carries its own aria-label so
  // screen readers don't lose context if the wrapper changes.
  return (
    <label className="selection-panel__row">
      <span className="selection-panel__label">{label}</span>
      {children}
    </label>
  );
}

/** Round to 0.01 mm to keep nudge math from accumulating float drift. */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Issue #94 (Phase 4b) — port detail form. Mirrors the inline expand block
 * that used to live in PortEditorRow, but rendered in the right rail with
 * full-width inputs and proper labels. Position / size on a 3-column grid;
 * cutout-margin + shape on a row below.
 */
function PortDetail({
  port,
  onClose,
  onPatch,
  onReset,
}: {
  port: PortPlacement;
  onClose: () => void;
  onPatch: (patch: {
    position?: Partial<{ x: number; y: number; z: number }>;
    size?: Partial<{ x: number; y: number; z: number }>;
    cutoutMargin?: number;
    cutoutShape?: CutoutShape;
  }) => void;
  onReset?: () => void;
}) {
  const portLabel = port.kind === 'custom' && port.sourceComponentId
    ? port.sourceComponentId
    : port.kind;
  return (
    <div className="selection-panel" data-testid="selection-panel-port">
      <div className="selection-panel__header">
        <span className="selection-panel__title">{portLabel}</span>
        <button
          type="button"
          className="selection-panel__close"
          onClick={onClose}
          aria-label="Close selection"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div className="selection-panel__subtitle">
        port [{port.facing}] · {port.enabled ? 'enabled' : 'disabled'}
      </div>

      <div className="port-coord-grid">
        <span className="coord-label" />
        <span className="coord-axis">x</span>
        <span className="coord-axis">y</span>
        <span className="coord-axis">z</span>
        <span className="coord-label">pos</span>
        <PortNum value={port.position.x} onChange={(v) => onPatch({ position: { x: v } })} testId={`port-${port.id}-pos-x`} ariaLabel="Port position X (mm)" />
        <PortNum value={port.position.y} onChange={(v) => onPatch({ position: { y: v } })} testId={`port-${port.id}-pos-y`} ariaLabel="Port position Y (mm)" />
        <PortNum value={port.position.z} onChange={(v) => onPatch({ position: { z: v } })} testId={`port-${port.id}-pos-z`} ariaLabel="Port position Z (mm)" />
        <span className="coord-label">size</span>
        <PortNum value={port.size.x} onChange={(v) => onPatch({ size: { x: v } })} testId={`port-${port.id}-size-x`} ariaLabel="Port size X (mm)" />
        <PortNum value={port.size.y} onChange={(v) => onPatch({ size: { y: v } })} testId={`port-${port.id}-size-y`} ariaLabel="Port size Y (mm)" />
        <PortNum value={port.size.z} onChange={(v) => onPatch({ size: { z: v } })} testId={`port-${port.id}-size-z`} ariaLabel="Port size Z (mm)" />
      </div>

      <FieldRow label="Cutout margin (mm)">
        <input
          type="number"
          step={0.1}
          className="numeric-input selection-panel__input"
          value={port.cutoutMargin}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onPatch({ cutoutMargin: v });
          }}
          data-testid={`port-${port.id}-margin`}
          aria-label="Port cutout margin (mm)"
          title="Extra clearance added to the cutout (mm). For round shapes the diameter = max(size.y, size.z) + 2 × margin."
        />
      </FieldRow>
      <FieldRow label="Cutout shape">
        <select
          className="selection-panel__input"
          value={port.cutoutShape ?? 'rect'}
          onChange={(e) => onPatch({ cutoutShape: e.target.value as CutoutShape })}
          data-testid={`port-${port.id}-shape`}
          aria-label="Port cutout shape"
          title="Cutout shape — rectangle (size.y × size.z) or round (max axis = diameter)."
        >
          <option value="rect">rect</option>
          <option value="round">round</option>
        </select>
      </FieldRow>

      {port.cutoutShape === 'round' ? (
        <p className="selection-panel__hint">
          Round hole diameter = max(size.y={port.size.y.toFixed(1)}, size.z={port.size.z.toFixed(1)}) + 2 × margin = <strong>{(Math.max(port.size.y, port.size.z) + 2 * port.cutoutMargin).toFixed(2)} mm</strong>.
        </p>
      ) : (
        <p className="selection-panel__hint">
          Rect cutout = (size.y + 2 × margin) × (size.z + 2 × margin) on the wall face.
        </p>
      )}

      {onReset && (
        <div className="selection-panel__actions">
          <button
            type="button"
            className="selection-panel__btn"
            onClick={onReset}
            data-testid={`port-${port.id}-reset`}
            title="Reset position / size / margin / shape back to the source component's default."
          >
            ↺ Reset to component default
          </button>
        </div>
      )}
    </div>
  );
}

function PortNum({
  value,
  onChange,
  testId,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  testId?: string;
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      value={value}
      step={0.1}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="port-num numeric-input"
      style={{ width: '100%' }}
    />
  );
}

const SNAP_WALLS_LIST: SnapWall[] = ['+x', '-x', '+y', '-y'];

/**
 * Issue #95 (Phase 4c) — snap-catch detail form. Wall, uPosition,
 * barbType, cantileverOn, plus enable/disable. The full set of editable
 * fields that used to live as cell-label chips in the left rail.
 */
function SnapCatchDetail({
  catch_,
  onClose,
  onPatch,
}: {
  catch_: SnapCatch;
  onClose: () => void;
  onPatch: (patch: Partial<SnapCatch>) => void;
}) {
  return (
    <div className="selection-panel" data-testid="selection-panel-catch">
      <div className="selection-panel__header">
        <span className="selection-panel__title">Snap catch</span>
        <button
          type="button"
          className="selection-panel__close"
          onClick={onClose}
          aria-label="Close selection"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div className="selection-panel__subtitle">{catch_.id}</div>

      <FieldRow label="Enabled">
        <input
          type="checkbox"
          checked={catch_.enabled}
          onChange={(e) => onPatch({ enabled: e.target.checked })}
          data-testid={`catch-${catch_.id}-enabled`}
          aria-label="Catch enabled"
        />
      </FieldRow>
      <FieldRow label="Wall">
        <select
          className="selection-panel__input"
          value={catch_.wall}
          onChange={(e) => onPatch({ wall: e.target.value as SnapWall })}
          data-testid={`catch-${catch_.id}-wall`}
          aria-label="Catch wall"
          title="Which wall the catch is on (±x / ±y)."
        >
          {SNAP_WALLS_LIST.map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="U position (mm)">
        <input
          type="number"
          step={0.5}
          className="numeric-input selection-panel__input"
          value={catch_.uPosition}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onPatch({ uPosition: v });
          }}
          data-testid={`catch-${catch_.id}-u`}
          aria-label="Catch U position (mm)"
          title="Distance along the wall from the wall's start corner (mm)."
        />
      </FieldRow>
      <FieldRow label="Barb cross-section">
        <select
          className="selection-panel__input"
          value={catch_.barbType ?? 'hook'}
          onChange={(e) => onPatch({ barbType: e.target.value as BarbType })}
          data-testid={`catch-${catch_.id}-barb`}
          aria-label="Barb cross-section"
          title="Barb cross-section: hook = classic; symmetric = service-friendly; ball-socket = detent."
        >
          {BARB_TYPES.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="Cantilever on">
        <select
          className="selection-panel__input"
          value={catch_.cantileverOn ?? 'lid'}
          onChange={(e) => onPatch({ cantileverOn: e.target.value as 'lid' | 'case' })}
          data-testid={`catch-${catch_.id}-arm`}
          aria-label="Cantilever location"
          title="Which part flexes — lid (default) or case."
        >
          <option value="lid">on lid</option>
          <option value="case">on case</option>
        </select>
      </FieldRow>
    </div>
  );
}

/**
 * Issue #96 (Phase 4d) — mounting-feature detail form. Type-aware: shows
 * only the params relevant to the selected feature.type.
 */
function MountingFeatureDetail({
  feature,
  onClose,
  onPatch,
}: {
  feature: MountingFeature;
  onClose: () => void;
  onPatch: (patch: Partial<MountingFeature>) => void;
}) {
  const params = feature.params ?? {};
  function patchParam(key: string, value: number | string): void {
    onPatch({ params: { ...params, [key]: value } });
  }
  function getNum(key: string, fallback: number): number {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }
  return (
    <div className="selection-panel" data-testid="selection-panel-feature">
      <div className="selection-panel__header">
        <span className="selection-panel__title">{feature.type}</span>
        <button
          type="button"
          className="selection-panel__close"
          onClick={onClose}
          aria-label="Close selection"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div className="selection-panel__subtitle">
        {feature.id} · face {feature.face}
      </div>

      <FieldRow label="Enabled">
        <input
          type="checkbox"
          checked={feature.enabled}
          onChange={(e) => onPatch({ enabled: e.target.checked })}
          data-testid={`feature-${feature.id}-enabled`}
          aria-label="Feature enabled"
        />
      </FieldRow>
      <FieldRow label="Position u (mm)">
        <input
          type="number"
          step={0.5}
          className="numeric-input selection-panel__input"
          value={feature.position.u}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v))
              onPatch({ position: { u: v, v: feature.position.v } });
          }}
          data-testid={`feature-${feature.id}-u`}
          aria-label="Feature u position (mm)"
        />
      </FieldRow>
      {/* Issue #101 — end-flanges are always flush with the case bottom; the
          compiler overrides v. Hide the input to avoid the user setting a
          value that gets silently ignored. */}
      {feature.type !== 'end-flange' && (
        <FieldRow label="Position v (mm)">
          <input
            type="number"
            step={0.5}
            className="numeric-input selection-panel__input"
            value={feature.position.v}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v))
                onPatch({ position: { u: feature.position.u, v } });
            }}
            data-testid={`feature-${feature.id}-v`}
            aria-label="Feature v position (mm)"
          />
        </FieldRow>
      )}

      {feature.type === 'screw-tab' && (
        <>
          <FieldRow label="Tab length (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('tabLength', 12)} onChange={(e) => patchParam('tabLength', Number(e.target.value))} aria-label="Tab length (mm)" />
          </FieldRow>
          <FieldRow label="Tab width (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('tabWidth', 14)} onChange={(e) => patchParam('tabWidth', Number(e.target.value))} aria-label="Tab width (mm)" />
          </FieldRow>
          <FieldRow label="Tab thickness (mm)">
            <input type="number" step={0.1} className="numeric-input selection-panel__input" value={getNum('tabThickness', 3)} onChange={(e) => patchParam('tabThickness', Number(e.target.value))} aria-label="Tab thickness (mm)" />
          </FieldRow>
          <FieldRow label="Hole Ø (mm)">
            <input type="number" step={0.1} className="numeric-input selection-panel__input" value={getNum('holeDiameter', 4.2)} onChange={(e) => patchParam('holeDiameter', Number(e.target.value))} aria-label="Hole diameter (mm)" />
          </FieldRow>
        </>
      )}

      {feature.type === 'end-flange' && (
        <>
          <FieldRow label="Projection (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('projection', 12)} onChange={(e) => patchParam('projection', Number(e.target.value))} aria-label="Flange projection (mm)" />
          </FieldRow>
          <FieldRow label="Width (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('width', 12)} onChange={(e) => patchParam('width', Number(e.target.value))} aria-label="Flange width (mm)" />
          </FieldRow>
          <FieldRow label="Thickness (mm)">
            <input type="number" step={0.1} className="numeric-input selection-panel__input" value={getNum('thickness', 3)} onChange={(e) => patchParam('thickness', Number(e.target.value))} aria-label="Flange thickness (mm)" />
          </FieldRow>
          <FieldRow label="Hole Ø (mm)">
            <input type="number" step={0.1} className="numeric-input selection-panel__input" value={getNum('holeDiameter', 3.4)} onChange={(e) => patchParam('holeDiameter', Number(e.target.value))} aria-label="Bolt hole diameter (mm)" />
          </FieldRow>
          <FieldRow label="Rib enabled">
            <input
              type="checkbox"
              checked={getNum('ribEnabled', 1) !== 0}
              onChange={(e) => patchParam('ribEnabled', e.target.checked ? 1 : 0)}
              aria-label="Reinforcing rib enabled"
              title="Toggle the triangular reinforcing rib gusset on top of the flange."
            />
          </FieldRow>
          <FieldRow label="Rib length (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('ribLength', 8)} onChange={(e) => patchParam('ribLength', Number(e.target.value))} aria-label="Rib length (mm)" />
          </FieldRow>
          <FieldRow label="Rib height (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('ribHeight', 6)} onChange={(e) => patchParam('ribHeight', Number(e.target.value))} aria-label="Rib height (mm)" />
          </FieldRow>
          <FieldRow label="Rib thickness (mm)">
            <input type="number" step={0.1} className="numeric-input selection-panel__input" value={getNum('ribThickness', 2)} onChange={(e) => patchParam('ribThickness', Number(e.target.value))} aria-label="Rib thickness (mm)" />
          </FieldRow>
        </>
      )}

      {feature.type === 'zip-tie-slot' && (
        <>
          <FieldRow label="Slot length (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('slotLength', 15)} onChange={(e) => patchParam('slotLength', Number(e.target.value))} aria-label="Slot length (mm)" />
          </FieldRow>
          <FieldRow label="Slot width (mm)">
            <input type="number" step={0.5} className="numeric-input selection-panel__input" value={getNum('slotWidth', 4)} onChange={(e) => patchParam('slotWidth', Number(e.target.value))} aria-label="Slot width (mm)" />
          </FieldRow>
        </>
      )}

      {feature.type === 'vesa-mount' && (
        <>
          <FieldRow label="Pattern (mm)">
            <select
              className="selection-panel__input"
              value={getNum('patternSize', 75)}
              onChange={(e) => patchParam('patternSize', Number(e.target.value))}
              aria-label="VESA pattern (mm)"
            >
              <option value={75}>VESA 75</option>
              <option value={100}>VESA 100</option>
            </select>
          </FieldRow>
          <FieldRow label="Hole Ø (mm)">
            <input type="number" step={0.1} className="numeric-input selection-panel__input" value={getNum('holeDiameter', 5)} onChange={(e) => patchParam('holeDiameter', Number(e.target.value))} aria-label="Hole diameter (mm)" />
          </FieldRow>
        </>
      )}

      {(feature.type === 'aligned-standoff' || feature.type === 'saddle') && (
        <p className="selection-panel__hint">
          Internal-mount geometry is a follow-up (#80 slice 4 deferred). The
          schema records this feature type but no geometry is emitted yet.
        </p>
      )}
    </div>
  );
}

/**
 * Issue #97 (Phase 4e) — board component detail form. Used for the
 * BoardEditor components table — full-width detail editor when a row
 * is selected.
 */
function ComponentDetail({
  component,
  onClose,
  onPatch,
}: {
  component: BoardComponent;
  onClose: () => void;
  onPatch: (patch: Partial<BoardComponent>) => void;
}) {
  return (
    <div className="selection-panel" data-testid="selection-panel-component">
      <div className="selection-panel__header">
        <span className="selection-panel__title">{component.kind}</span>
        <button
          type="button"
          className="selection-panel__close"
          onClick={onClose}
          aria-label="Close selection"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div className="selection-panel__subtitle">{component.id}</div>

      <FieldRow label="Kind">
        <select
          className="selection-panel__input"
          value={component.kind}
          onChange={(e) => onPatch({ kind: e.target.value as BoardComponent['kind'] })}
          data-testid={`component-detail-${component.id}-kind`}
          aria-label="Component kind"
        >
          {(['usb-c', 'usb-a', 'usb-b', 'micro-usb', 'hdmi', 'micro-hdmi', 'barrel-jack', 'ethernet-rj45', 'gpio-header', 'sd-card', 'flat-cable', 'fan-mount', 'text-label', 'antenna-connector', 'custom'] as const).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="Facing">
        <select
          className="selection-panel__input"
          value={component.facing ?? '+y'}
          onChange={(e) => onPatch({ facing: e.target.value as Facing })}
          data-testid={`component-detail-${component.id}-facing`}
          aria-label="Component facing"
        >
          {(['+x', '-x', '+y', '-y', '+z'] as const).map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </FieldRow>

      <div className="port-coord-grid">
        <span className="coord-label" />
        <span className="coord-axis">x</span>
        <span className="coord-axis">y</span>
        <span className="coord-axis">z</span>
        <span className="coord-label">pos</span>
        <PortNum value={component.position.x} onChange={(v) => onPatch({ position: { ...component.position, x: v } })} testId={`component-detail-${component.id}-pos-x`} ariaLabel="Position X (mm)" />
        <PortNum value={component.position.y} onChange={(v) => onPatch({ position: { ...component.position, y: v } })} testId={`component-detail-${component.id}-pos-y`} ariaLabel="Position Y (mm)" />
        <PortNum value={component.position.z} onChange={(v) => onPatch({ position: { ...component.position, z: v } })} testId={`component-detail-${component.id}-pos-z`} ariaLabel="Position Z (mm)" />
        <span className="coord-label">size</span>
        <PortNum value={component.size.x} onChange={(v) => onPatch({ size: { ...component.size, x: v } })} testId={`component-detail-${component.id}-size-x`} ariaLabel="Size X (mm)" />
        <PortNum value={component.size.y} onChange={(v) => onPatch({ size: { ...component.size, y: v } })} testId={`component-detail-${component.id}-size-y`} ariaLabel="Size Y (mm)" />
        <PortNum value={component.size.z} onChange={(v) => onPatch({ size: { ...component.size, z: v } })} testId={`component-detail-${component.id}-size-z`} ariaLabel="Size Z (mm)" />
      </div>

      <FieldRow label="Cutout margin (mm)">
        <input
          type="number"
          step={0.1}
          className="numeric-input selection-panel__input"
          value={component.cutoutMargin ?? 0.5}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onPatch({ cutoutMargin: v });
          }}
          aria-label="Cutout margin (mm)"
        />
      </FieldRow>
      <FieldRow label="Cutout shape">
        <select
          className="selection-panel__input"
          value={component.cutoutShape ?? 'rect'}
          onChange={(e) => onPatch({ cutoutShape: e.target.value as 'rect' | 'round' })}
          aria-label="Cutout shape"
        >
          <option value="rect">rect</option>
          <option value="round">round</option>
        </select>
      </FieldRow>
      <FieldRow label="Fixture id">
        <input
          type="text"
          className="selection-panel__input"
          value={component.fixtureId ?? ''}
          onChange={(e) => onPatch({ fixtureId: e.target.value || undefined })}
          aria-label="Fixture id"
          placeholder="(optional)"
        />
      </FieldRow>
    </div>
  );
}
