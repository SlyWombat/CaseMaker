import { useProjectStore } from '@/store/projectStore';
import type { ComponentKind, Facing } from '@/types';
import { LabelledField } from '@/components/ui/LabelledField';

const KIND_OPTIONS: ComponentKind[] = [
  'usb-c',
  'usb-a',
  'usb-b',
  'micro-usb',
  'hdmi',
  'micro-hdmi',
  'barrel-jack',
  'ethernet-rj45',
  'gpio-header',
  'sd-card',
  'custom',
];

const FACING_OPTIONS: Facing[] = ['+x', '-x', '+y', '-y', '+z'];

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
  const patchComponent = useProjectStore((s) => s.patchComponent);

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
        <LabelledField
          label="Cross-reference URL"
          hint="Link to product page, schematic, or documentation. Free-form."
        >
          <input
            type="text"
            value={board.crossReference ?? ''}
            onChange={(e) => patchMeta({ crossReference: e.target.value })}
            data-testid="meta-crossref"
            placeholder="https://..."
          />
        </LabelledField>
        <LabelledField
          label="Datasheet revision"
          hint="Datasheet version + date this profile was measured against, e.g. 'Rev 1.4 — 2023-08'."
        >
          <input
            type="text"
            value={board.datasheetRevision ?? ''}
            onChange={(e) => patchMeta({ datasheetRevision: e.target.value })}
            data-testid="meta-revision"
            placeholder="Rev 1.4 — 2023-08"
          />
        </LabelledField>
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
                <NumInput
                  value={h.x}
                  onChange={(v) => patchHole(h.id, { x: v })}
                  testId={`hole-${h.id}-x`}
                  ariaLabel={`Mounting hole ${h.id} X (mm)`}
                  title={`Mounting hole ${h.id} — position X (mm)`}
                />
              </td>
              <td>
                <NumInput
                  value={h.y}
                  onChange={(v) => patchHole(h.id, { y: v })}
                  testId={`hole-${h.id}-y`}
                  ariaLabel={`Mounting hole ${h.id} Y (mm)`}
                  title={`Mounting hole ${h.id} — position Y (mm)`}
                />
              </td>
              <td>
                <NumInput
                  value={h.diameter}
                  onChange={(v) => patchHole(h.id, { diameter: v })}
                  testId={`hole-${h.id}-d`}
                  ariaLabel={`Mounting hole ${h.id} diameter (mm)`}
                  title={`Mounting hole ${h.id} — drill diameter (mm)`}
                />
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
      <table className="hole-table">
        <thead>
          <tr>
            <th title="Component kind (USB-C, HDMI, etc.)">Kind</th>
            <th title="Which face the connector points out of">Facing</th>
            <th colSpan={2} title="Position + size, edited in the row below">Pos / Size (mm)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {board.components.flatMap((c) => [
            <tr key={`${c.id}-head`}>
              <td>
                <select
                  value={c.kind}
                  onChange={(e) =>
                    patchComponent(c.id, { kind: e.target.value as ComponentKind })
                  }
                  data-testid={`component-${c.id}-kind`}
                  aria-label={`Component ${c.id} kind`}
                  title="Connector kind. Drives the default cutout shape and port group."
                  style={{ width: '100%' }}
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  value={c.facing ?? '+y'}
                  onChange={(e) =>
                    patchComponent(c.id, { facing: e.target.value as Facing })
                  }
                  data-testid={`component-${c.id}-facing`}
                  aria-label={`Component ${c.id} facing`}
                  title="Which case face the connector points out of (e.g. +y = back wall)."
                  style={{ width: '100%' }}
                >
                  {FACING_OPTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </td>
              <td colSpan={2} style={{ color: '#8a94a4', fontSize: 11 }}>
                pos / size below
              </td>
              <td>
                <button
                  onClick={() => removeComponent(c.id)}
                  data-testid={`remove-component-${c.id}`}
                  title="Remove this component"
                  aria-label={`Remove component ${c.id}`}
                >
                  ✕
                </button>
              </td>
            </tr>,
            <tr key={`${c.id}-body`}>
              <td colSpan={5} style={{ paddingBottom: 8 }}>
                <div className="comp-coord-grid">
                  <span className="coord-label" />
                  <span className="coord-axis-header">X</span>
                  <span className="coord-axis-header">Y</span>
                  <span className="coord-axis-header">Z</span>
                  <span className="coord-label">pos</span>
                  <NumInput
                    value={c.position.x}
                    onChange={(v) => patchComponent(c.id, { position: { x: v } })}
                    testId={`component-${c.id}-pos-x`}
                    ariaLabel={`Component ${c.id} position X (mm)`}
                    title={`Component ${c.id} — position X (mm), measured from the PCB origin.`}
                  />
                  <NumInput
                    value={c.position.y}
                    onChange={(v) => patchComponent(c.id, { position: { y: v } })}
                    testId={`component-${c.id}-pos-y`}
                    ariaLabel={`Component ${c.id} position Y (mm)`}
                    title={`Component ${c.id} — position Y (mm), measured from the PCB origin.`}
                  />
                  <NumInput
                    value={c.position.z}
                    onChange={(v) => patchComponent(c.id, { position: { z: v } })}
                    testId={`component-${c.id}-pos-z`}
                    ariaLabel={`Component ${c.id} position Z (mm)`}
                    title={`Component ${c.id} — position Z (mm), measured from the top of the PCB.`}
                  />
                  <span className="coord-label">size</span>
                  <NumInput
                    value={c.size.x}
                    onChange={(v) => patchComponent(c.id, { size: { x: v } })}
                    testId={`component-${c.id}-size-x`}
                    ariaLabel={`Component ${c.id} size X (mm)`}
                    title={`Component ${c.id} — size X (mm). For side-facing connectors this is the depth into the wall.`}
                  />
                  <NumInput
                    value={c.size.y}
                    onChange={(v) => patchComponent(c.id, { size: { y: v } })}
                    testId={`component-${c.id}-size-y`}
                    ariaLabel={`Component ${c.id} size Y (mm)`}
                    title={`Component ${c.id} — size Y (mm).`}
                  />
                  <NumInput
                    value={c.size.z}
                    onChange={(v) => patchComponent(c.id, { size: { z: v } })}
                    testId={`component-${c.id}-size-z`}
                    ariaLabel={`Component ${c.id} size Z (mm)`}
                    title={`Component ${c.id} — size Z (mm).`}
                  />
                </div>
              </td>
            </tr>,
          ])}
        </tbody>
      </table>
    </div>
  );
}
