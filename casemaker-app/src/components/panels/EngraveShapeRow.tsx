import { useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { RestCutterControl, type RestChoice } from '@/components/panels/RestCutterControl';
import { itemOperationName } from '@/engine/cnc/engrave/partPlan';
import { regionChipLabel, useRegionOperationType } from '@/components/panels/operationTypes';
import { rowSummary } from '@/components/panels/engraveRowText';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { ShapePatch } from '@/store/engraveJobStore';
import type { EngraveShape, TexturePattern } from '@/types/engraveJob';
import { DEFAULT_INLAY_GLUE_GAP_MM, type InlayNumbers } from '@/engine/cnc/engrave/inlay';
import {
  DEFAULT_MAX_TEXTURE_STROKES,
  textureOperationName,
  type TextureNumbers,
} from '@/engine/cnc/engrave/texture';
import { DEFAULT_PRISM_BASE_MM, type PrismCheck } from '@/engine/cnc/engrave/prism';
import type { Mm } from '@/types/units';

/**
 * One shape pocket of an engrave job (#214, work item 5): enabled, an optional name, the
 * kind's own dimensions, position, rotation, depth and its own findings.
 *
 * Each kind gets its OWN editor (the issue's rule) because the dimensions differ: a rect has
 * width/height/cornerRadius, a circle a diameter, a slot a length and width, a polygon a list
 * of points. Depth is a NUMERIC field with a slider BESIDE it, never a slider alone — the same
 * rule the label row follows, for the same reason (a slider cannot express "1.5 mm" reliably).
 *
 * The polygon editor keeps its text LOCAL and only commits points that parse to 3–500 of them:
 * a half-typed ring must never reach the job, or the schema would reject the whole document on
 * the next load.
 *
 * #411 changed only the row's OUTER shape: `EngraveItemRow` owns the one-line head and draws the
 * editor below it while the row is open. The fields are the ones they were, moved one level in.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };

/** `2` / `0.5` — a number as a sentence uses it. */
const fmt = (n: number): string => `${Number(n.toFixed(3))}`;
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };
const POINTS: CSSProperties = {
  width: '100%',
  minHeight: 54,
  fontFamily: 'monospace',
  fontSize: 11,
  boxSizing: 'border-box',
};

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

const KIND_LABEL: Record<EngraveShape['kind'], string> = {
  rect: 'Rectangle',
  circle: 'Circle',
  slot: 'Slot',
  polygon: 'Polygon',
};

/**
 * The one-glyph-per-kind column of the collapsed line (#411). The design's own mockup draws ▭ for a
 * face and ▢ for a pocket; the rest follow it, and a shape reads as itself rather than as "Shape".
 */
const KIND_GLYPH: Record<EngraveShape['kind'], string> = {
  rect: '▭',
  circle: '◯',
  slot: '▬',
  polygon: '⬠',
};

/** The numeric fields a row can edit, across all kinds. */
type NumField = 'width' | 'height' | 'cornerRadius' | 'diameter' | 'length' | 'rotation';

function pointsToText(points: readonly [Mm, Mm][]): string {
  return points.map(([x, y]) => `${x}, ${y}`).join('\n');
}

/** Parse "x, y" per line into points, or null when any line is not two finite numbers. */
function parsePoints(text: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 2) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out;
}

export interface EngraveShapeRowProps {
  shape: EngraveShape;
  /** Position of this row in `job.shapes`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: ShapePatch) => void;
  onRemove: () => void;
  /** Findings about THIS shape (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
  /**
   * #667 — the rest pair's control data (the setup's rough and rest cutters), or null when this
   * row's item is not in a setup or the job has no cutter. The panel owns the registry reading.
   */
  rest?: RestChoice | null;
  /**
   * #665 — the variable-depth control, present only when the job's cutter is a cone: the level
   * pitch the CAM will run, or null when the feeds row did not resolve for this cutter. #677 —
   * `coreCutterName` is the setup's clearance cutter (the flat end mill after the V, when the
   * setup names one): the flat bottom's own program, or null when the core would stand.
   */
  vCarve?: { pitchMm: number | null; coreCutterName: string | null } | null;
  /**
   * #673 — the inlay half's own facts, present on a region carrying an inlay marker: the derived
   * numbers (`null` when they do not derive — the finding says why) and the action that saves the
   * matching male blank as its own job (`null` while the job cannot make one).
   */
  inlay?: { numbers: InlayNumbers | null; onSaveMale: (() => void) | null } | null;
  /**
   * #670 — the texture's own facts, present on a region carrying a texture marker: the numbers
   * the CAM runs with, how many strokes the pattern derives, and whether the cap shortened it.
   */
  texture?: { numbers: TextureNumbers; strokes: number; capped: boolean } | null;
  /**
   * #674 — the prism's own facts, present on a region carrying a prism marker: the numbers the plan
   * derives (the base, the slope's width either side, the margin where the cut meets the top face)
   * and whether they derive at all.
   */
  prism?: PrismCheck | null;
  /** #687 — the row's Technical fold (the V-carve geometry), when this item has any. */
  technical?: ReactNode;
}

export function EngraveShapeRow({
  shape,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
  rest = null,
  vCarve = null,
  inlay = null,
  texture = null,
  prism = null,
  technical = null,
}: EngraveShapeRowProps): JSX.Element {
  // #662 - the chip states what THIS cutter makes of a region.
  const region = useRegionOperationType();
  const depthInvalid = shape.depth > maxDepth;
  // #673 — the female inlay half's marker, narrowed once so the glue-gap write carries the role.
  const femaleInlay = shape.inlay?.role === 'female' ? shape.inlay : null;
  // #670 — a texture's marker, narrowed once: every write below carries the pattern with it.
  const mark = shape.texture ?? null;
  // #674 — a prism's marker, narrowed once: the base write carries it whole.
  const prismMark = shape.prism ?? null;
  const raisePrism = prismMark !== null;
  /** Write one number into the marker, keeping the pattern and the other numbers. */
  const setTexture = (patch: Partial<{ pattern: TexturePattern; pitchMm: Mm; strokeMm: Mm; seed: number }>): void => {
    if (mark === null) return;
    onChange({ texture: { ...mark, ...patch } });
  };
  const [pointsText, setPointsText] = useState(() => (shape.kind === 'polygon' ? pointsToText(shape.points) : ''));

  const numField = (key: NumField, label: string, title: string, invalid = false): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={(shape as unknown as Record<string, number>)[key]}
        data-testid={`engrave-shape-${key}-${index}`}
        aria-label={`Shape ${index + 1} ${label}`}
        title={title}
        style={{ ...NUM, ...(invalid ? INVALID : null) }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ [key]: v } as ShapePatch);
        }}
      />
    </label>
  );

  const positionNum = (axis: 'x' | 'y'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={shape.position[axis]}
        data-testid={`engrave-shape-${axis}-${index}`}
        aria-label={`Shape ${index + 1} ${axis.toUpperCase()}`}
        title={`Centre of the shape, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...shape.position, [axis]: v } });
        }}
      />
    </label>
  );

  return (
    // #411 — one line per shape: remove, show/hide, chevron, the kind's own glyph, the name (or the
    // kind's word when it has none) and the depth; the editor below opens on the chevron.
    <EngraveItemRow
      id={shape.id}
      selectable
      prefix="engrave-shape"
      index={index}
      glyph={KIND_GLYPH[shape.kind]}
      kindWord={KIND_LABEL[shape.kind]}
      typeLabel={
        // #674/#670 — a prism and a texture are their own operations whatever the cutter makes of
        // the region; the plan gives the prism's marker precedence.
        raisePrism
          ? 'Prism'
          : shape.texture !== undefined
            ? 'Texture'
            : shape.through !== true && shape.vCarveDepth === 'variable' && region === 'v-carve'
              ? 'V-carve (variable)'
              : regionChipLabel(shape.through, region)
      }
      name={
        raisePrism
          ? itemOperationName(shape, 'Prism')
          : shape.texture === undefined
            ? itemOperationName(shape)
            : textureOperationName(mark?.pattern ?? shape.texture.pattern)
      }
      summary={shape.through === true ? 'through' : rowSummary(shape.depth)}
      enabled={shape.enabled}
      enabledTitle="A disabled shape is kept in the job but not cut."
      removeTitle="Remove this shape."
      removeNoun="shape"
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
      restLabel={rest?.chip ?? null}
      technical={technical}
    >
      {/* The optional name lives in the editor rather than on the line: the line has no room for a
          text field beside the two controls and the summary, and a name nobody has set should read
          as the kind ("Circle"), not as an empty box. */}
      <label style={ROW_INLINE}>
        <span>name</span>
        <input
          type="text"
          value={shape.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-shape-name-${index}`}
          aria-label={`Shape ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
      </label>

      <div style={ROW_INLINE}>
        {shape.kind === 'rect' && (
          <>
            {numField('width', 'width', 'Rectangle width in X, mm.')}
            {numField('height', 'height', 'Rectangle height in Y, mm.')}
            {numField(
              'cornerRadius',
              'corner r',
              'Corner radius, mm. 0 = sharp — the cutter rounds it anyway; never more than half the smaller side.',
              shape.cornerRadius > Math.min(shape.width, shape.height) / 2,
            )}
          </>
        )}
        {shape.kind === 'circle' && numField('diameter', 'diameter', 'Circle diameter, mm. A hole larger than the cutter; a smaller one is item-empty.')}
        {shape.kind === 'slot' && (
          <>
            {numField('length', 'length', 'Overall slot length (end to end), mm.')}
            {numField('width', 'width', 'Slot width, mm — the end radius is half of it.', shape.length < shape.width)}
          </>
        )}
      </div>

      {shape.kind === 'polygon' && (
        <label style={{ display: 'block', marginTop: 4 }}>
          <span style={{ ...MUTED, display: 'block' }}>points — one “x, y” per line, relative to the centre</span>
          <textarea
            value={pointsText}
            data-testid={`engrave-shape-points-${index}`}
            aria-label={`Shape ${index + 1} polygon points`}
            title="One x, y pair per line. A closed ring of 3 to 500 points; a crossing ring is reported, not cut."
            style={{ ...POINTS, ...(parsePoints(pointsText) && parsePoints(pointsText)!.length >= 3 ? null : INVALID) }}
            onChange={(e) => {
              const text = e.target.value;
              setPointsText(text);
              const pts = parsePoints(text);
              // Commit only a valid ring: an invalid one would make the whole job unloadable.
              if (pts && pts.length >= 3 && pts.length <= 500) onChange({ points: pts });
            }}
          />
          <span style={MUTED} data-testid={`engrave-shape-point-count-${index}`}>
            {(() => {
              const pts = parsePoints(pointsText);
              if (!pts) return 'Not a list of x, y points.';
              if (pts.length < 3) return `${pts.length} point${pts.length === 1 ? '' : 's'} — a polygon needs at least 3.`;
              if (pts.length > 500) return `${pts.length} points — at most 500.`;
              return `${pts.length} points.`;
            })()}
          </span>
        </label>
      )}

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={shape.construction === true}
            data-testid={`engrave-shape-construction-${index}`}
            aria-label={`Shape ${index + 1} reference only`}
            title="Reference only: this shape is not cut. It can still be named by a frame or a cut-away — as a cut-away island it is left standing."
            onChange={(e) => onChange({ construction: e.target.checked ? true : undefined })}
          />
          <span>reference only</span>
        </label>
        {positionNum('x')}
        {positionNum('y')}
        {numField('rotation', 'rot', 'Degrees counter-clockwise about the shape centre.')}
        {/* #218 — a through region has no typed depth: its floor is the breakthrough rule. The
            toggle replaces the depth controls rather than sitting beside a dead input. */}
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={shape.through === true}
            data-testid={`engrave-shape-through-${index}`}
            aria-label={`Shape ${index + 1} through`}
            title="Cut this pocket through the blank into the under-board. Needs a sacrificial board; the depth comes from the breakthrough rule, so no depth is typed."
            onChange={(e) => onChange({ through: e.target.checked ? true : undefined })}
          />
          <span>through</span>
        </label>
        {shape.through !== true && (
          <label style={FIELD_LABEL}>
            <span>depth</span>
            <input
              type="range"
              min={0}
              max={maxDepth}
              step="0.1"
              value={Math.min(shape.depth, maxDepth)}
              aria-label={`Shape ${index + 1} depth slider`}
              title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
              onChange={(e) => onChange({ depth: Number(e.target.value) })}
            />
            <input
              type="number"
              min={0}
              step="0.1"
              value={shape.depth}
              data-testid={`engrave-shape-depth-${index}`}
              aria-label={`Shape ${index + 1} depth`}
              title="Depth of this pocket's floor below the top face, mm."
              style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) onChange({ depth: v });
              }}
            />
            <span>mm</span>
          </label>
        )}
      </div>

      {shape.through === true ? (
        <p style={MUTED} data-testid={`engrave-shape-maxdepth-${index}`}>
          Cuts through the blank into the board — the depth is the breakthrough rule, not a typed number.
        </p>
      ) : (
        <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-shape-maxdepth-${index}`}>
          Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
        </p>
      )}
      {/* #674 — A RAISED PRISM: the shape stands and the V cuts the ring around it. The same
          toggle is the picker's entry, so an existing pocket can become one; the depth above is
          the standing height. The V-carve depth select and the rest fold are hidden while it is
          on — a prism is one plane region cut from the mouth inward, not a ladder and not a pair. */}
      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={raisePrism}
            data-testid={`engrave-shape-prism-${index}`}
            aria-label={`Shape ${index + 1} raise as a prism`}
            title="Raise this shape instead of pocketing it: a V-bit carves a ring around it so it stands at the depth above, its sides sloping at the bit's angle."
            onChange={(e) => onChange({ prism: e.target.checked ? {} : undefined })}
          />
          <span>raise as a prism</span>
        </label>
        {prismMark !== null && (
          <label style={FIELD_LABEL}>
            <span>base</span>
            <input
              type="number"
              min={0.1}
              step="0.5"
              value={fmt(prismMark.baseMm ?? DEFAULT_PRISM_BASE_MM)}
              data-testid={`engrave-shape-prism-base-${index}`}
              aria-label={`Shape ${index + 1} prism base`}
              title="The flat base's width around the shape, mm — the floor the V's tip clears. The cut's outer edge is this plus the slope either side."
              style={NUM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) onChange({ prism: { ...prismMark, baseMm: v } });
              }}
            />
            <span>mm</span>
          </label>
        )}
      </div>
      {prismMark !== null && (
        <p
          style={{ ...MUTED, ...(prism !== null && !prism.ok ? { color: SEVERITY_COLOR.error } : null) }}
          data-testid={`engrave-shape-prism-note-${index}`}
        >
          {prism === null
            ? 'A prism is cut by a V-bit.'
            : prism.ok
              ? `The shape stands ${fmt(prism.numbers.heightMm)} mm, its sides sloping over ${fmt(
                  prism.numbers.slopeWidthMm,
                )} mm, on a ${fmt(prism.numbers.baseMm)} mm flat base (${prism.numbers.baseSource}); the cut meets ` +
                `the untouched top face ${fmt(prism.numbers.marginMm)} mm out from the shape.`
              : prism.code === 'prism-needs-cone'
                ? 'A prism’s sides are the V-bit’s flank: choose a V-bit.'
                : prism.code === 'prism-tip'
                  ? 'A point tip leaves the base as ridges: use a V-bit with a tip diameter.'
                  : `The base is narrower than the tip’s flat twice, so the tip has no path between the shape’s slope and the base’s outer bevel — widen it or use a smaller tip.`}
        </p>
      )}
      {/* #665 — a region cut by a cone can follow the design's width instead of one depth. Only
          shown for a cone (a flat cutter pockets at a single depth) and never on a through cut,
          which has no floor to follow. */}
      {vCarve !== null && shape.through !== true && !raisePrism && (
        <div style={ROW_INLINE}>
          <label style={FIELD_LABEL}>
            <span>V-carve depth</span>
            <select
              value={shape.vCarveDepth ?? 'plane'}
              data-testid={`engrave-shape-vcarve-depth-${index}`}
              aria-label={`Shape ${index + 1} V-carve depth`}
              title="Plane cuts one constant floor at the colour plane. Variable follows the design's width down to its centre, level by level; where the V's width runs out, the middle is left standing and the setup's flat end mill pockets it at the cap, in its own program."
              onChange={(e) => onChange({ vCarveDepth: e.target.value === 'variable' ? 'variable' : 'plane' })}
            >
              <option value="plane">plane (one depth)</option>
              <option value="variable">variable (the medial axis)</option>
            </select>
          </label>
        </div>
      )}
      {vCarve !== null && shape.through !== true && !raisePrism && shape.vCarveDepth === 'variable' && (
        <p style={MUTED} data-testid={`engrave-shape-vcarve-note-${index}`}>
          The V follows the design’s width —{' '}
          {vCarve.pitchMm === null ? 'the level pitch comes from the feeds row' : `${fmt(vCarve.pitchMm)} mm per level`}{' '}
          — down to {fmt(shape.depth)} mm at the centre. Where the V cannot reach, the middle
          stands as a core:{' '}
          {vCarve.coreCutterName === null
            ? 'add a flat end mill to the setup and the engine pockets it at that depth in its own program.'
            : `${vCarve.coreCutterName} pockets it flat at that depth in its own program, after the V-carve.`}
        </p>
      )}
      {/* #673 — THE INLAY HALF: the glue gap the operator decides, the derived plug numbers, and
          the action that saves the matching male blank as its own job (one blank, one job). */}
      {inlay !== null && femaleInlay !== null && (
        <div data-testid={`engrave-shape-inlay-${index}`} style={{ marginTop: 4 }}>
          <p style={MUTED}>
            The female half of a V-carve inlay: the design is the pocket, and a second blank is cut
            as its plug.
          </p>
          <label style={FIELD_LABEL}>
            <span>glue gap</span>
            <input
              type="number"
              min={0.01}
              step="0.05"
              value={fmt(femaleInlay.glueGapMm ?? DEFAULT_INLAY_GLUE_GAP_MM)}
              data-testid={`engrave-shape-inlay-gap-${index}`}
              aria-label={`Shape ${index + 1} inlay glue gap`}
              title="The vertical clearance between the plug's end and this pocket's floor, mm. The plug's edge sits in from the design by this gap times the V's half-angle tangent."
              style={NUM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) onChange({ inlay: { ...femaleInlay, glueGapMm: v } });
              }}
            />
            <span>mm</span>
          </label>
          <p style={{ ...MUTED, ...(inlay.numbers === null ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-shape-inlay-note-${index}`}>
            {inlay.numbers === null
              ? 'The glue gap must be above zero and below the pocket depth for a plug to fit it.'
              : `Pocket ${fmt(inlay.numbers.pocketDepthMm)} mm · plug ${fmt(inlay.numbers.plugDepthMm)} mm · ` +
                `the plug's edge ${fmt(inlay.numbers.topInsetMm)} mm inside the design — the gap down the ` +
                `flank is ${fmt(inlay.numbers.wallClearanceMm)} mm.`}
          </p>
          <button
            type="button"
            data-testid={`engrave-shape-inlay-male-${index}`}
            disabled={inlay.onSaveMale === null}
            title="Build the male blank — its own job, its own blank, the design mirrored — and save it as a file to open and cut next."
            onClick={() => inlay.onSaveMale?.()}
          >
            Save the male blank…
          </button>
        </div>
      )}
      {/* #670 — THE TEXTURE: the pattern, its spacing numbers, and the strokes they derive. The
          depth above is the pattern's floor; the note prints the numbers the CAM will run, from
          the same `textureStrokes` the plan calls. */}
      {texture !== null && mark !== null && (
        <div data-testid={`engrave-shape-texture-${index}`} style={{ marginTop: 4 }}>
          <p style={MUTED}>
            A texture cuts a seeded pattern of short strokes over this region instead of a pocket;
            each stroke is a trace, cut at the depth above.
          </p>
          <div style={ROW_INLINE}>
            <label style={FIELD_LABEL}>
              <span>pattern</span>
              <select
                value={mark.pattern}
                data-testid={`engrave-shape-texture-pattern-${index}`}
                aria-label={`Shape ${index + 1} texture pattern`}
                title="Stipple: short jittered strokes in every cell. Scallop: rows of semicircular bumps."
                onChange={(e) => setTexture({ pattern: e.target.value === 'scallop' ? 'scallop' : 'stipple' })}
              >
                <option value="stipple">stipple</option>
                <option value="scallop">scallop</option>
              </select>
            </label>
            <label style={FIELD_LABEL}>
              <span>pitch</span>
              <input
                type="number"
                min={0.1}
                step="0.1"
                value={fmt(texture.numbers.pitchMm)}
                data-testid={`engrave-shape-texture-pitch-${index}`}
                aria-label={`Shape ${index + 1} texture pitch`}
                title="Stroke and row spacing, mm. Past a few thousand strokes the pattern is capped: widen the pitch."
                style={NUM}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) setTexture({ pitchMm: v });
                }}
              />
              <span>mm</span>
            </label>
            {mark.pattern === 'stipple' && (
              <>
                <label style={FIELD_LABEL}>
                  <span>stroke</span>
                  <input
                    type="number"
                    min={0.1}
                    step="0.1"
                    value={fmt(texture.numbers.strokeMm)}
                    data-testid={`engrave-shape-texture-stroke-${index}`}
                    aria-label={`Shape ${index + 1} texture stroke length`}
                    title="A stipple stroke's length, mm. A longer stroke than the pitch overlaps its neighbours."
                    style={NUM}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > 0) setTexture({ strokeMm: v });
                    }}
                  />
                  <span>mm</span>
                </label>
                <label style={FIELD_LABEL}>
                  <span>seed</span>
                  <input
                    type="number"
                    min={0}
                    step="1"
                    value={fmt(texture.numbers.seed)}
                    data-testid={`engrave-shape-texture-seed-${index}`}
                    aria-label={`Shape ${index + 1} texture seed`}
                    title="The stipple's jitter and direction seed. The same seed gives the same pattern; a different seed lays out a different one."
                    style={NUM}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isInteger(v) && v >= 0) setTexture({ seed: v });
                    }}
                  />
                </label>
              </>
            )}
          </div>
          <p
            style={{ ...MUTED, ...(texture.strokes === 0 ? { color: SEVERITY_COLOR.error } : texture.capped ? { color: SEVERITY_COLOR.warning } : null) }}
            data-testid={`engrave-shape-texture-note-${index}`}
          >
            {texture.strokes === 0
              ? `The pattern comes out empty at a ${fmt(texture.numbers.pitchMm)} mm pitch over this region; widen the region or narrow the pitch.`
              : `${texture.strokes} stroke${texture.strokes === 1 ? '' : 's'} at a ${fmt(texture.numbers.pitchMm)} mm pitch ` +
                `(${texture.numbers.pitchSource})` +
                (texture.numbers.pattern === 'stipple'
                  ? ` and a ${fmt(texture.numbers.strokeMm)} mm stroke (${texture.numbers.strokeSource}), seed ${texture.numbers.seed}`
                  : '') +
                `, cut ${fmt(texture.numbers.depthMm)} mm deep.` +
                (texture.capped
                  ? ` More than the ${DEFAULT_MAX_TEXTURE_STROKES}-${texture.numbers.pattern === 'scallop' ? 'run' : 'stroke'} cap: the first ${DEFAULT_MAX_TEXTURE_STROKES} are cut.`
                  : '')}
          </p>
        </div>
      )}
      {rest !== null && !raisePrism && <RestCutterControl rest={rest} testidPrefix="engrave-shape" index={index} />}
    </EngraveItemRow>
  );
}
