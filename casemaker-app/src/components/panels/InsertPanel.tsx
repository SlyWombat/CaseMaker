import type React from 'react';
import { useProjectStore } from '@/store/projectStore';
import type { InsertItem, InsertParams, InsertPocketShape } from '@/types';
import { LabelledField } from '@/components/ui/LabelledField';
import { derivedKind } from '@/engine/compiler/archetype';
import {
  defaultInsert,
  insertGrid,
  insertLayout,
  insertProblem,
} from '@/engine/compiler/insert';
import { newId } from '@/utils/id';

/**
 * Tool-insert holder editor (issue #158, types/insert.ts).
 *
 * IMPORTANT: `patchCase` validates with a TOP-LEVEL partial only, so every
 * update sends the COMPLETE `insert` object — never a nested fragment.
 */

const ROW: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  marginBottom: 6,
};
const NUM: React.CSSProperties = { width: 72 };
const HINT: React.CSSProperties = { fontSize: 12, color: '#9aa4b0', margin: '2px 0 0' };
const PROBLEM: React.CSSProperties = {
  fontSize: 12,
  color: '#e0b060',
  border: '1px solid #3a3320',
  background: '#221d12',
  borderRadius: 4,
  padding: '6px 8px',
  margin: '2px 0 6px',
};

/** One click adds a pocket at a sensible starter size for its shape, and at
 *  the deepest depth the current plate can hold without eating its floor. */
function starterItem(insert: InsertParams, shape: InsertPocketShape): InsertItem {
  const depth = Math.max(1, Math.round((insert.thickness - insert.floor) * 10) / 10);
  return {
    id: newId('item'),
    shape,
    // Ø10 round / 6.35 mm (1/4") across-flats hex — the two most common first
    // entries, and both editable immediately.
    size: shape === 'round' ? 10 : 6.35,
    depth,
  };
}

export function InsertPanel() {
  const project = useProjectStore((s) => s.project);
  const patchCase = useProjectStore((s) => s.patchCase);
  const archetype = useProjectStore((s) => derivedKind(s.project));
  const insert = project?.case.insert;

  if (!project) return null;

  if (archetype !== 'insert' || !insert) {
    return (
      <div className="panel-stack" data-testid="insert-panel-disabled">
        <p style={{ fontSize: 13, lineHeight: 1.5, color: '#9aa4b0' }}>
          Generate a parametric tool-insert holder: a plate of round (socket-OD) and hex
          (across-flats) pockets sized to your own tools, auto-distributed on an even grid.
          Replaces the normal case/lid pipeline while enabled.
        </p>
        <button
          type="button"
          data-testid="insert-enable"
          onClick={() => patchCase({ insert: defaultInsert() })}
        >
          Enable tool-insert project
        </button>
      </div>
    );
  }

  const update = (partial: Partial<InsertParams>): void => {
    patchCase({ insert: { ...insert, ...partial } });
  };
  const setItem = (i: number, next: InsertItem): void => {
    const items = [...insert.items];
    items[i] = next;
    update({ items });
  };
  const addItem = (shape: InsertPocketShape): void => {
    update({ items: [...insert.items, starterItem(insert, shape)] });
  };
  const removeItem = (i: number): void => {
    update({ items: insert.items.filter((_, k) => k !== i) });
  };

  const problem = insertProblem(insert);
  const grid = insertGrid(insert);
  const placed = insertLayout(insert).length;

  return (
    <div className="panel-stack" data-testid="insert-panel">
      <LabelledField
        label="Plate size"
        unit="mm"
        hint="Outside width (X), depth (Y) and thickness (Z). The plate prints as modelled, pocket mouths up."
      >
        <div style={ROW}>
          <input
            type="number"
            min={10}
            step={1}
            value={insert.width}
            data-testid="insert-width"
            aria-label="Plate width"
            style={NUM}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
          <span aria-hidden>×</span>
          <input
            type="number"
            min={10}
            step={1}
            value={insert.depth}
            data-testid="insert-depth"
            aria-label="Plate depth"
            style={NUM}
            onChange={(e) => update({ depth: Number(e.target.value) })}
          />
          <span aria-hidden>×</span>
          <input
            type="number"
            min={1}
            step={0.5}
            value={insert.thickness}
            data-testid="insert-thickness"
            aria-label="Plate thickness"
            style={NUM}
            onChange={(e) => update({ thickness: Number(e.target.value) })}
          />
        </div>
      </LabelledField>

      <LabelledField
        label="Corner radius"
        unit="mm"
        hint="Round the plate's corners. 0 gives square corners."
      >
        <input
          type="number"
          min={0}
          step={1}
          value={insert.cornerRadius}
          data-testid="insert-corner"
          style={NUM}
          onChange={(e) => update({ cornerRadius: Number(e.target.value) })}
        />
      </LabelledField>

      <LabelledField
        label="Fit and floor"
        hint="Clearance added to each pocket's nominal size; the chamfer widens round pocket mouths; the floor is the material left beneath the deepest pocket."
      >
        <div style={ROW}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>Clear</span>
            <input
              type="number"
              min={0}
              step={0.05}
              value={insert.clearance}
              data-testid="insert-clearance"
              style={NUM}
              onChange={(e) => update({ clearance: Number(e.target.value) })}
            />
          </label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>Chamfer</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={insert.chamfer}
              data-testid="insert-chamfer"
              style={NUM}
              onChange={(e) => update({ chamfer: Number(e.target.value) })}
            />
          </label>
        </div>
        <div style={ROW}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>Floor</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={insert.floor}
              data-testid="insert-floor"
              style={NUM}
              onChange={(e) => update({ floor: Number(e.target.value) })}
            />
          </label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>Gap</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={insert.pitchGap}
              data-testid="insert-pitch-gap"
              style={NUM}
              onChange={(e) => update({ pitchGap: Number(e.target.value) })}
            />
          </label>
        </div>
      </LabelledField>

      <LabelledField
        label="Pockets"
        hint="Round: outside diameter. Hex: across-flats. Enter the size you measured on the tool — clearance is added for you."
      >
        {problem ? (
          <p style={PROBLEM} data-testid="insert-problem">
            {problem}
          </p>
        ) : (
          <p style={HINT} data-testid="insert-summary">
            {placed} of {insert.items.length} pocket{insert.items.length === 1 ? '' : 's'} placed on a{' '}
            {Math.max(1, Math.min(grid.cols, insert.items.length))} ×{' '}
            {Math.max(1, Math.ceil(insert.items.length / Math.max(1, grid.cols)))} grid
            {grid.pitch > 0 ? ` at ${Math.round(grid.pitch * 100) / 100} mm pitch` : ''}.
          </p>
        )}

        {insert.items.map((item, i) => (
          <div key={item.id} style={ROW} data-testid={`insert-item-${i}`}>
            <select
              value={item.shape}
              aria-label="Pocket shape"
              style={{ width: 74 }}
              onChange={(e) =>
                setItem(i, { ...item, shape: e.target.value as InsertPocketShape })
              }
            >
              <option value="round">Round</option>
              <option value="hex">Hex</option>
            </select>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={item.size}
              data-testid={`insert-item-${i}-size`}
              aria-label="Pocket size"
              style={NUM}
              onChange={(e) => setItem(i, { ...item, size: Number(e.target.value) })}
            />
            <span style={{ fontSize: 12 }}>⌀ / AF</span>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={item.depth}
              data-testid={`insert-item-${i}-depth`}
              aria-label="Pocket depth"
              style={NUM}
              onChange={(e) => setItem(i, { ...item, depth: Number(e.target.value) })}
            />
            <span style={{ fontSize: 12 }}>deep</span>
            <button
              type="button"
              data-testid={`insert-item-${i}-remove`}
              aria-label="Remove pocket"
              style={{ marginLeft: 'auto', width: 26, height: 26 }}
              onClick={() => removeItem(i)}
            >
              ✕
            </button>
          </div>
        ))}

        <div style={{ ...ROW, gap: 8 }}>
          <button type="button" data-testid="insert-add-round" onClick={() => addItem('round')}>
            + Round
          </button>
          <button type="button" data-testid="insert-add-hex" onClick={() => addItem('hex')}>
            + Hex
          </button>
        </div>
      </LabelledField>

      <button
        type="button"
        data-testid="insert-disable"
        onClick={() => patchCase({ insert: { ...insert, enabled: false } })}
      >
        Remove tool-insert project
      </button>
    </div>
  );
}
