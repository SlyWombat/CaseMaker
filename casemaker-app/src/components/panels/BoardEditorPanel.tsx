import { useProjectStore } from '@/store/projectStore';
import type { ComponentKind, Facing } from '@/types';

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
}

function NumInput({ value, step = 0.1, min, onChange, testId }: NumInputProps) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      min={min}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      className="slider-num"
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
        <button onClick={cloneForEditing} data-testid="clone-board">
          Clone &amp; edit
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>Board editor (custom)</h3>
      <div className="board-meta-grid">
        <label>
          Name
          <input
            type="text"
            value={board.name}
            onChange={(e) => patchMeta({ name: e.target.value })}
            data-testid="meta-name"
            style={{ width: '100%' }}
          />
        </label>
        <label>
          Manufacturer
          <input
            type="text"
            value={board.manufacturer}
            onChange={(e) => patchMeta({ manufacturer: e.target.value })}
            data-testid="meta-manufacturer"
            style={{ width: '100%' }}
          />
        </label>
        <label>
          Standoff (mm)
          <NumInput
            value={board.defaultStandoffHeight}
            onChange={(v) => patchMeta({ defaultStandoffHeight: v })}
            testId="meta-standoff"
          />
        </label>
        <label>
          Z clearance (mm)
          <NumInput
            value={board.recommendedZClearance}
            onChange={(v) => patchMeta({ recommendedZClearance: v })}
            testId="meta-zclearance"
          />
        </label>
        <label>
          Cross-reference URL
          <input
            type="text"
            value={board.crossReference ?? ''}
            onChange={(e) => patchMeta({ crossReference: e.target.value })}
            data-testid="meta-crossref"
            placeholder="https://..."
            style={{ width: '100%' }}
          />
        </label>
        <label>
          Datasheet revision
          <input
            type="text"
            value={board.datasheetRevision ?? ''}
            onChange={(e) => patchMeta({ datasheetRevision: e.target.value })}
            data-testid="meta-revision"
            placeholder="Rev 1.4 — 2023-08"
            style={{ width: '100%' }}
          />
        </label>
      </div>
      <div className="pcb-grid">
        <label>
          PCB X (mm)
          <NumInput
            value={board.pcb.size.x}
            onChange={(v) => patchPcb({ x: v })}
            testId="pcb-x"
          />
        </label>
        <label>
          PCB Y (mm)
          <NumInput
            value={board.pcb.size.y}
            onChange={(v) => patchPcb({ y: v })}
            testId="pcb-y"
          />
        </label>
        <label>
          PCB Z (mm)
          <NumInput
            value={board.pcb.size.z}
            onChange={(v) => patchPcb({ z: v })}
            testId="pcb-z"
          />
        </label>
      </div>
      <h4 className="subhead">
        Mounting holes
        <button
          onClick={addHole}
          data-testid="add-hole"
          style={{ marginLeft: 8, fontSize: 11 }}
        >
          + add
        </button>
      </h4>
      <table className="hole-table">
        <thead>
          <tr>
            <th>x</th>
            <th>y</th>
            <th>⌀</th>
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
                />
              </td>
              <td>
                <NumInput
                  value={h.y}
                  onChange={(v) => patchHole(h.id, { y: v })}
                  testId={`hole-${h.id}-y`}
                />
              </td>
              <td>
                <NumInput
                  value={h.diameter}
                  onChange={(v) => patchHole(h.id, { diameter: v })}
                  testId={`hole-${h.id}-d`}
                />
              </td>
              <td>
                <button
                  onClick={() => removeHole(h.id)}
                  data-testid={`remove-hole-${h.id}`}
                  title="Remove"
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
        >
          + add
        </button>
      </h4>
      <table className="hole-table">
        <thead>
          <tr>
            <th>kind</th>
            <th>face</th>
            <th>pos</th>
            <th>size</th>
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
                >
                  ✕
                </button>
              </td>
            </tr>,
            <tr key={`${c.id}-body`}>
              <td colSpan={5} style={{ paddingBottom: 8 }}>
                <div className="comp-coord-grid">
                  <span className="coord-label">pos</span>
                  <NumInput
                    value={c.position.x}
                    onChange={(v) => patchComponent(c.id, { position: { x: v } })}
                    testId={`component-${c.id}-pos-x`}
                  />
                  <NumInput
                    value={c.position.y}
                    onChange={(v) => patchComponent(c.id, { position: { y: v } })}
                    testId={`component-${c.id}-pos-y`}
                  />
                  <NumInput
                    value={c.position.z}
                    onChange={(v) => patchComponent(c.id, { position: { z: v } })}
                    testId={`component-${c.id}-pos-z`}
                  />
                  <span className="coord-label">size</span>
                  <NumInput
                    value={c.size.x}
                    onChange={(v) => patchComponent(c.id, { size: { x: v } })}
                    testId={`component-${c.id}-size-x`}
                  />
                  <NumInput
                    value={c.size.y}
                    onChange={(v) => patchComponent(c.id, { size: { y: v } })}
                    testId={`component-${c.id}-size-y`}
                  />
                  <NumInput
                    value={c.size.z}
                    onChange={(v) => patchComponent(c.id, { size: { z: v } })}
                    testId={`component-${c.id}-size-z`}
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
