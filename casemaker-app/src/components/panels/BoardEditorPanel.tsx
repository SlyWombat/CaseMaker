import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { LabelledField } from '@/components/ui/LabelledField';
// Issue #97 (Phase 4e) — KIND_OPTIONS / FACING_OPTIONS lists moved to
// SelectionPanel.ComponentDetail (right-rail editor) since the inline
// kind/facing selects were removed from this panel.

interface NumInputProps {
  value: number;
  step?: number;
  min?: number;
  onChange: (v: number) => void;
  testId?: string;
  ariaLabel: string;
  title: string;
  /** Forwarded by LabelledField via cloneElement so `<label htmlFor>` resolves. */
  id?: string;
  /** Forwarded by LabelledField for screen-reader hint text. */
  'aria-describedby'?: string;
}

function NumInput({
  value,
  step = 0.1,
  min,
  onChange,
  testId,
  ariaLabel,
  title,
  id,
  'aria-describedby': describedBy,
}: NumInputProps) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      min={min}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      aria-label={ariaLabel}
      title={title}
      id={id}
      aria-describedby={describedBy}
      className="slider-num numeric-input"
      style={{ width: '100%' }}
    />
  );
}

export function BoardEditorPanel() {
  const board = useProjectStore((s) => s.project.board);
  const cloneForEditing = useProjectStore((s) => s.cloneBoardForEditing);
  const patchPcb = useProjectStore((s) => s.patchBoardPcb);
  const patchMeta = useProjectStore((s) => s.patchBoardMeta);
  const addHole = useProjectStore((s) => s.addMountingHole);
  const removeHole = useProjectStore((s) => s.removeMountingHole);
  const patchHole = useProjectStore((s) => s.patchMountingHole);
  const addComponent = useProjectStore((s) => s.addComponent);
  const removeComponent = useProjectStore((s) => s.removeComponent);
  // patchComponent moved to SelectionPanel.ComponentDetail (right rail).
  const setSelection = useViewportStore((s) => s.setSelection);
  const selectedComponentId = useViewportStore((s) =>
    s.selection?.kind === 'component' ? s.selection.componentId : null,
  );

  if (board.builtin) {
    return (
      <div className="panel">
        <h3>Board editor</h3>
        <p className="board-meta">
          Built-in profiles are read-only. Clone to a custom copy to edit dimensions, mounting holes, components, and metadata.
        </p>
        <button
          onClick={cloneForEditing}
          data-testid="clone-board"
          title="Clone the current built-in profile to a custom copy you can edit."
        >
          Clone &amp; edit
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>Board editor (custom)</h3>
      <div className="board-meta-grid">
        <LabelledField
          label="Name"
          hint="Display name for this custom board profile (free-form)."
        >
          <input
            type="text"
            value={board.name}
            onChange={(e) => patchMeta({ name: e.target.value })}
            data-testid="meta-name"
          />
        </LabelledField>
        <LabelledField
          label="Manufacturer"
          hint="Manufacturer or brand. Free-form, displayed in the board picker."
        >
          <input
            type="text"
            value={board.manufacturer}
            onChange={(e) => patchMeta({ manufacturer: e.target.value })}
            data-testid="meta-manufacturer"
          />
        </LabelledField>
        <LabelledField
          label="Standoff"
          unit="mm"
          hint="Default Z lift between the case floor and the bottom of the PCB. Used by the standoff pillars under each mounting hole."
        >
          <NumInput
            value={board.defaultStandoffHeight}
            onChange={(v) => patchMeta({ defaultStandoffHeight: v })}
            testId="meta-standoff"
            ariaLabel="Standoff height (mm)"
            title="Default standoff height (mm) — Z lift from case floor to bottom of PCB."
          />
        </LabelledField>
        <LabelledField
          label="Z clearance"
          unit="mm"
          hint="Recommended headroom above the tallest component before the lid. Adds to the case Z-clearance default for this board."
        >
          <NumInput
            value={board.recommendedZClearance}
            onChange={(v) => patchMeta({ recommendedZClearance: v })}
            testId="meta-zclearance"
            ariaLabel="Recommended Z clearance (mm)"
            title="Recommended Z headroom above the tallest component (mm)."
          />
        </LabelledField>
        {/* Issue #103 — Cross-reference URL + Datasheet revision moved to
            the sidebar footer (SidebarFooter). They're reference data, not
            interactive day-to-day, so they no longer take real estate
            alongside Name / Manufacturer / Standoff in the meta-grid. */}
      </div>
      <div className="pcb-grid">
        <LabelledField
          label="PCB X"
          unit="mm"
          hint="PCB length along the X axis (mm). Drives the case footprint."
        >
          <NumInput
            value={board.pcb.size.x}
            onChange={(v) => patchPcb({ x: v })}
            testId="pcb-x"
            ariaLabel="PCB size X (mm)"
            title="PCB length along the X axis (mm)."
          />
        </LabelledField>
        <LabelledField
          label="PCB Y"
          unit="mm"
          hint="PCB width along the Y axis (mm). Drives the case footprint."
        >
          <NumInput
            value={board.pcb.size.y}
            onChange={(v) => patchPcb({ y: v })}
            testId="pcb-y"
            ariaLabel="PCB size Y (mm)"
            title="PCB width along the Y axis (mm)."
          />
        </LabelledField>
        <LabelledField
          label="PCB Z"
          unit="mm"
          hint="PCB thickness (mm). Most PCBs are 1.6 mm."
        >
          <NumInput
            value={board.pcb.size.z}
            onChange={(v) => patchPcb({ z: v })}
            testId="pcb-z"
            ariaLabel="PCB size Z (mm)"
            title="PCB thickness (mm)."
          />
        </LabelledField>
      </div>
      <h4 className="subhead">
        Mounting holes
        <button
          onClick={addHole}
          data-testid="add-hole"
          style={{ marginLeft: 8, fontSize: 11 }}
          title="Add a new mounting hole at the origin — drag it via the X/Y fields."
        >
          + add
        </button>
      </h4>
      <table className="hole-table">
        <thead>
          <tr>
            <th title="Mounting-hole position X (mm)" className="axis-head">X (mm)</th>
            <th title="Mounting-hole position Y (mm)" className="axis-head">Y (mm)</th>
            <th title="Mounting-hole diameter (mm)" className="axis-head">Diameter (mm)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {board.mountingHoles.map((h) => (
            <tr key={h.id}>
              <td>
                <label className="cell-label">
                  <span className="cell-label__row">{h.id}</span>
                  <span className="cell-label__axis">X</span>
                  <NumInput
                    value={h.x}
                    onChange={(v) => patchHole(h.id, { x: v })}
                    testId={`hole-${h.id}-x`}
                    ariaLabel={`Mounting hole ${h.id} X (mm)`}
                    title={`Mounting hole ${h.id} — position X (mm)`}
                  />
                </label>
              </td>
              <td>
                <label className="cell-label">
                  <span className="cell-label__axis">Y</span>
                  <NumInput
                    value={h.y}
                    onChange={(v) => patchHole(h.id, { y: v })}
                    testId={`hole-${h.id}-y`}
                    ariaLabel={`Mounting hole ${h.id} Y (mm)`}
                    title={`Mounting hole ${h.id} — position Y (mm)`}
                  />
                </label>
              </td>
              <td>
                <label className="cell-label">
                  <span className="cell-label__axis">Ø</span>
                  <NumInput
                    value={h.diameter}
                    onChange={(v) => patchHole(h.id, { diameter: v })}
                    testId={`hole-${h.id}-d`}
                    ariaLabel={`Mounting hole ${h.id} diameter (mm)`}
                    title={`Mounting hole ${h.id} — drill diameter (mm)`}
                  />
                </label>
              </td>
              <td>
                <button
                  onClick={() => removeHole(h.id)}
                  data-testid={`remove-hole-${h.id}`}
                  title="Remove this mounting hole"
                  aria-label={`Remove mounting hole ${h.id}`}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className="subhead">
        Components
        <button
          onClick={addComponent}
          data-testid="add-component"
          style={{ marginLeft: 8, fontSize: 11 }}
          title="Add a new component (defaults to USB-C at the origin)."
        >
          + add
        </button>
      </h4>
      {/* Issue #97 (Phase 4e) — components are now compact one-liners.
          Detail editing (kind / facing / pos XYZ / size XYZ / cutout
          margin / shape / fixture id) lives in the right-rail
          ContextPanel and is reached by clicking the row. */}
      <ul className="component-list">
        {board.components.map((c) => {
          const isSelected = selectedComponentId === c.id;
          return (
            <li
              key={c.id}
              className={`component-list__row${isSelected ? ' component-list__row--selected' : ''}`}
            >
              <button
                type="button"
                className="component-list__select"
                onClick={() => setSelection({ kind: 'component', componentId: c.id })}
                aria-pressed={isSelected}
                data-testid={`component-${c.id}-select`}
                title="Edit this component's kind / facing / position / size in the right rail"
              >
                <span className="component-list__id">{c.id}</span>
                <span className="component-list__meta">{c.kind} · {c.facing ?? '+y'}</span>
              </button>
              <button
                onClick={() => removeComponent(c.id)}
                data-testid={`remove-component-${c.id}`}
                title="Remove this component"
                aria-label={`Remove component ${c.id}`}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
