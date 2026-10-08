import type React from 'react';
import { useProjectStore } from '@/store/projectStore';
import {
  defaultToolboxParams,
  toolboxParamsProblem,
  TOOLBOX_HEIGHT_LADDER,
  TOOLBOX_LID_H,
  TOOLBOX_MIN_HEIGHT,
  TOOLBOX_MIN_PLAN,
  type ToolboxParams,
} from '@/types';
import { LabelledField } from '@/components/ui/LabelledField';
import { derivedKind } from '@/engine/compiler/archetype';
import { computeToolboxDims } from '@/engine/compiler/toolbox';
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
          connector at all, plus a drop-in hole grid through the bin&rsquo;s floor. Stack
          modules of different heights and they still line up. Replaces the normal
          case/lid pipeline while enabled.
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
        hint={`A ${grid ? grid.pitch : 25} mm pitch of through-holes in the bin's floor, for drop-in pegs and partitions. Applied to the bin only — the lid has no floor to put holes in.`}
      >
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={toolbox.grid}
            data-testid="toolbox-grid"
            onChange={(e) => update({ grid: e.target.checked })}
          />
          Cut a hole grid through the bin&rsquo;s floor
        </label>
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
            ? ` Floor grid: ${grid.columns} × ${grid.rows} holes (${grid.holes.length}).`
            : ' No floor grid.'}{' '}
          Lid: {Math.round(lidDims.outer.height)} mm, so a bin and its lid stand{' '}
          {Math.round(toolbox.height + TOOLBOX_LID_H - dims.foot.height)} mm together.
        </p>
      )}

      {fitIssues.map((issue) => (
        <p key={issue.message} style={PROBLEM} data-testid="toolbox-fit-issue">
          {issue.message}
        </p>
      ))}
    </div>
  );
}
