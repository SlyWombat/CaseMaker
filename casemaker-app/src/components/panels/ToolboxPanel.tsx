import type React from 'react';
import { useProjectStore } from '@/store/projectStore';
import {
  defaultToolboxParams,
  defaultToolboxPeg,
  toolboxParamsProblem,
  TOOLBOX_HEIGHT_LADDER,
  TOOLBOX_LID_H,
  TOOLBOX_MIN_HEIGHT,
  TOOLBOX_MIN_PLAN,
  type ToolboxParams,
  type ToolboxPeg,
} from '@/types';
import { LabelledField } from '@/components/ui/LabelledField';
import { derivedKind } from '@/engine/compiler/archetype';
import {
  computeToolboxDims,
  toolboxPegHeadroom,
  toolboxPegProblems,
  toolboxPegSpanLimit,
} from '@/engine/compiler/toolbox';
import { validateToolboxFit } from '@/engine/compiler/toolboxFit';
import { resolvePrinter } from '@/engine/compiler/rackFit';

/**
 * Stacking-toolbox editor (issue #155, types/toolbox.ts).
 *
 * IMPORTANT: `patchCase` validates with a TOP-LEVEL partial only, so every
 * update sends the COMPLETE `toolbox` object — never a nested fragment.
 *
 * Sizes are phrased throughout in physical terms (the footprint, the rim) and
 * measured from the module's own landmarks rather than from raw coordinates —
 * the outline is centred on the origin, but that is the exporter's business,
 * not the user's.
 */
const ROW: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  marginBottom: 6,
  flexWrap: 'wrap',
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
const PEG_ROW: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  flexWrap: 'wrap',
  padding: '5px 0',
  borderTop: '1px solid #2a2f36',
};

export function ToolboxPanel() {
  const project = useProjectStore((s) => s.project);
  const patchCase = useProjectStore((s) => s.patchCase);
  const archetype = useProjectStore((s) => derivedKind(s.project));
  const toolbox = project?.case.toolbox;

  if (!project) return null;

  if (archetype !== 'toolbox' || !toolbox) {
    return (
      <div className="panel-stack" data-testid="toolbox-panel-disabled">
        <p style={{ fontSize: 13, lineHeight: 1.5, color: '#9aa4b0' }}>
          Generate a stacking toolbox: a bin and a lid that register on each other with no
          connector at all, plus a grid of sockets in the bin&rsquo;s floor for drop-in
          dividers. Stack modules of different heights and they still line up. Replaces
          the normal case/lid pipeline while enabled.
        </p>
        <button
          type="button"
          data-testid="toolbox-enable"
          onClick={() => patchCase({ toolbox: defaultToolboxParams() })}
        >
          Enable stacking toolbox
        </button>
      </div>
    );
  }

  /** Complete object, always — see the note at the top of this file. */
  const update = (partial: Partial<ToolboxParams>): void => {
    patchCase({ toolbox: { ...toolbox, ...partial } });
  };

  const problem = toolboxParamsProblem(toolbox);
  const dims = computeToolboxDims(toolbox, toolbox.height, { grid: toolbox.grid });
  const lidDims = computeToolboxDims(toolbox, TOOLBOX_LID_H, { grid: false });
  const fitIssues = validateToolboxFit(toolbox, resolvePrinter(project));
  const grid = dims.grid;
  const pegs = toolbox.pegs ?? [];
  const pegProblems = toolboxPegProblems(toolbox);

  /** The lowest number not already in use, so a test (or a reload) sees a
   *  stable id rather than a random one. The id is the whole suffix of the
   *  emitted node's `divider-peg-<id>`, so keep it short. */
  const nextPegId = (): string => {
    const used = new Set(pegs.map((peg) => peg.id));
    for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
  };

  const addPeg = (): void => {
    const spans = Math.max(1, Math.min(3, toolboxPegSpanLimit(toolbox, 'x')));
    const peg = defaultToolboxPeg(nextPegId(), spans, Math.round(toolboxPegHeadroom(toolbox)));
    update({ pegs: [...pegs, peg] });
  };

  const updatePeg = (id: string, partial: Partial<ToolboxPeg>): void => {
    update({ pegs: pegs.map((peg) => (peg.id === id ? { ...peg, ...partial } : peg)) });
  };

  const removePeg = (id: string): void => {
    update({ pegs: pegs.filter((peg) => peg.id !== id) });
  };

  return (
    <div className="panel-stack" data-testid="toolbox-panel">
      <LabelledField
        label="Footprint"
        unit="mm"
        hint="The module's outside width (X) and depth (Y). This is the footprint that stacks — the cavity inside is smaller by two walls."
      >
        <div style={ROW}>
          <input
            type="number"
            min={Math.ceil(TOOLBOX_MIN_PLAN)}
            step={10}
            value={toolbox.width}
            data-testid="toolbox-width"
            aria-label="Toolbox width"
            style={NUM}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
          <span aria-hidden>×</span>
          <input
            type="number"
            min={Math.ceil(TOOLBOX_MIN_PLAN)}
            step={10}
            value={toolbox.depth}
            data-testid="toolbox-depth"
            aria-label="Toolbox depth"
            style={NUM}
            onChange={(e) => update({ depth: Number(e.target.value) })}
          />
        </div>
      </LabelledField>

      <LabelledField
        label="Module height"
        unit="mm"
        hint="Rim to seating plane. The ladder is a convenience, not a cage — any buildable height is a valid module, and modules of different heights still stack."
      >
        <div style={ROW}>
          {TOOLBOX_HEIGHT_LADDER.map((h) => (
            <button
              key={h}
              type="button"
              data-testid={`toolbox-height-${h}`}
              aria-pressed={toolbox.height === h}
              style={
                toolbox.height === h
                  ? { borderColor: '#5b8def', color: '#cfe0ff', fontWeight: 600 }
                  : undefined
              }
              onClick={() => update({ height: h })}
            >
              {h}
            </button>
          ))}
          <input
            type="number"
            min={Math.ceil(TOOLBOX_MIN_HEIGHT)}
            step={5}
            value={toolbox.height}
            data-testid="toolbox-height"
            aria-label="Module height"
            style={NUM}
            onChange={(e) => update({ height: Number(e.target.value) })}
          />
        </div>
      </LabelledField>

      <LabelledField
        label="Floor grid"
        hint={
          grid
            ? `${grid.columns} × ${grid.rows} square sockets ${grid.socket} mm across on a ${grid.pitch} mm pitch, cut ${grid.depth} mm into the bin's floor. Blind, not through — each socket keeps a floor under it for a divider's tenon to seat on. Applied to the bin only; the lid has no floor to put sockets in.`
            : "A lattice of square sockets cut part-way into the bin's floor, for the drop-in dividers below. Applied to the bin only — the lid has no floor to put sockets in."
        }
      >
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={toolbox.grid}
            data-testid="toolbox-grid"
            onChange={(e) => update({ grid: e.target.checked })}
          />
          Cut a socket grid into the bin&rsquo;s floor
        </label>
      </LabelledField>

      <LabelledField
        label="Dividers"
        hint="Drop-in walls that stand in the bin, held down by square tenons in the floor's sockets — take one out and the floor is flat again. A divider is sized in SOCKETS: 4 means its two tenons sit four sockets apart, so it stays right when the footprint changes."
      >
        <div style={ROW}>
          <button
            type="button"
            data-testid="toolbox-add-peg"
            disabled={!toolbox.grid}
            onClick={addPeg}
          >
            Add divider
          </button>
          {!toolbox.grid && (
            <span style={HINT}>Turn the floor grid on to add one.</span>
          )}
        </div>

        {pegs.map((peg) => (
          <div key={peg.id} style={PEG_ROW} data-testid={`toolbox-peg-${peg.id}`}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={peg.enabled}
                data-testid={`toolbox-peg-enabled-${peg.id}`}
                aria-label={`Divider ${peg.id} enabled`}
                onChange={(e) => updatePeg(peg.id, { enabled: e.target.checked })}
              />
              Divider {peg.id}
            </label>
            <label style={{ fontSize: 12, color: '#9aa4b0' }}>
              across{' '}
              <select
                value={peg.axis}
                data-testid={`toolbox-peg-axis-${peg.id}`}
                aria-label={`Divider ${peg.id} axis`}
                onChange={(e) => updatePeg(peg.id, { axis: e.target.value as 'x' | 'y' })}
              >
                <option value="x">width</option>
                <option value="y">depth</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: '#9aa4b0' }}>
              sockets{' '}
              <input
                type="number"
                min={1}
                max={toolboxPegSpanLimit(toolbox, peg.axis)}
                step={1}
                value={peg.spans}
                data-testid={`toolbox-peg-spans-${peg.id}`}
                aria-label={`Divider ${peg.id} span in sockets`}
                style={{ width: 56 }}
                onChange={(e) => updatePeg(peg.id, { spans: Number(e.target.value) })}
              />
            </label>
            <label style={{ fontSize: 12, color: '#9aa4b0' }}>
              tall{' '}
              <input
                type="number"
                min={1}
                step={5}
                value={peg.height}
                data-testid={`toolbox-peg-height-${peg.id}`}
                aria-label={`Divider ${peg.id} height`}
                style={{ width: 64 }}
                onChange={(e) => updatePeg(peg.id, { height: Number(e.target.value) })}
              />
            </label>
            <label style={{ fontSize: 12, color: '#9aa4b0' }}>
              thick{' '}
              <input
                type="number"
                min={0.8}
                step={0.2}
                value={peg.thickness}
                data-testid={`toolbox-peg-thickness-${peg.id}`}
                aria-label={`Divider ${peg.id} thickness`}
                style={{ width: 56 }}
                onChange={(e) => updatePeg(peg.id, { thickness: Number(e.target.value) })}
              />
            </label>
            <button
              type="button"
              data-testid={`toolbox-peg-remove-${peg.id}`}
              aria-label={`Remove divider ${peg.id}`}
              onClick={() => removePeg(peg.id)}
            >
              Remove
            </button>
          </div>
        ))}
      </LabelledField>

      {problem !== null ? (
        <p style={PROBLEM} data-testid="toolbox-problem">
          {problem}
        </p>
      ) : (
        <p style={HINT} data-testid="toolbox-summary">
          Bin: {toolbox.width} × {toolbox.depth} × {toolbox.height} mm outside, cavity{' '}
          {Math.round(dims.inner.width)} × {Math.round(dims.inner.depth)} ×{' '}
          {Math.round(dims.innerDepth)} mm deep.
          {grid
            ? ` Floor grid: ${grid.columns} × ${grid.rows} sockets (${grid.holes.length}).`
            : ' No floor grid.'}{' '}
          {pegs.length > 0
            ? ` Dividers: ${pegs.filter((peg) => peg.enabled).length} of ${pegs.length} on.`
            : ''}{' '}
          Lid: {Math.round(lidDims.outer.height)} mm, so a bin and its lid stand{' '}
          {Math.round(toolbox.height + TOOLBOX_LID_H - dims.foot.height)} mm together.
        </p>
      )}

      {pegProblems.map((reason) => (
        <p key={reason} style={PROBLEM} data-testid="toolbox-peg-problem">
          {reason}
        </p>
      ))}

      {fitIssues.map((issue) => (
        <p key={issue.message} style={PROBLEM} data-testid="toolbox-fit-issue">
          {issue.message}
        </p>
      ))}
    </div>
  );
}
