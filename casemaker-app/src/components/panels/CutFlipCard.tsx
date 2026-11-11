/**
 * #1170 — THE FLIP CARD: the turn between side 1 and side 2, drawn from the job.
 *
 * The mockup is canvas artboard 8 (`project/Cut-Run.dc.html`, "the flip"). A card in step 3, amber
 * border, shown when side 1's last program has finished and side 2's first has not:
 *
 *   - HEADER `Cut · side 1 done, 10 of 20 · turn the blank`, with the machine's own state.
 *   - THE PICTURE: the bracket's two arms, the blank, the two locating bores and the corner in
 *     the bracket — before and after the turn. The AXIS and the BORES are the flipped setup's
 *     record (#1073/#1088): the stored pins are side 2's frame, and the before panel is the same
 *     two points reflected back through `flipReflection`. The FIXTURE is never mirrored — only
 *     the blank's contents move.
 *   - THREE STEPS in the operator's words, the turn and the clamp edge from the axis.
 *   - ONE CONFIRMATION, and ONE PRESS that is disabled until it is ticked: side 2's registration
 *     is the next move, and its stop rule quotes the shop's registration tolerance.
 *   - THE ARRIVAL: the head is homed first, then the work light goes on (M821) — `flipArrival.ts`.
 *
 * DISPLAY AND ONE DOOR. The card reads the job, the frozen package and the finished hashes, and
 * its press hands the operator to the existing Register step (`onRegister`); it sends no motion of
 * its own beyond the arrival's home and light.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import { useMediaQuery } from '@/hooks/useMediaQuery';
import { readDefault } from '@/platform/defaultsClient';
import { fenceCornerFor } from '@/engine/cnc/engrave/flipChoice';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { flipReflection } from '@/engine/cnc/setups/flip';
import { machineKey } from '@/store/machineRunStore';
import { useMachineStore } from '@/store/machineStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useStripAccessoryStore } from '@/store/stripAccessoryStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { cutterIdentity } from '@/engine/cnc/engrave/cutterCaseLine';
import type { EngraveJob, FrozenPackage } from '@/types/engraveJob';
import { machineFlipArrival, prepareFlipArrival, type FlipArrivalIO } from './flipArrival';
import { cutMachineLine } from './cutMachineStatus';

const AMBER = '#e0a84a';
const MUTED = { color: '#9aa4b0' } as const;
const BOX = { padding: 12, border: `1px solid ${AMBER}`, borderRadius: 10, background: '#161d27' } as const;

/**
 * #1170 (the drawing finding) — THE PICTURE'S NUMBERS, in one place and named.
 *
 * The card's text is the design system's body type, never a literal (#84, #1207): a label that
 * scales with a drawing is how the old picture's words reached ~7 px on a phone. The drawing's
 * viewBox is its content plus {@link FLIP_DIAGRAM_PAD} of the larger side, so no side keeps an
 * empty margin over 6 % of the width. Every stroke is non-scaling, so lines keep one weight at
 * every size.
 */
const BODY_TEXT = 'var(--cm-text-body-size)';
const LINE_PX = 1.5;
const FLIP_DIAGRAM_PAD = 0.04;
/** Under this VIEWPORT width the before and after drawings stack; at the panel's width they share a row. */
const FLIP_STACK_BELOW_PX = 480;
const STACK_QUERY = `(max-width: ${FLIP_STACK_BELOW_PX - 1}px)`;
/** The drawn blank's schematic size, in the picture's own units. */
const PANEL_W = 150;
const PANEL_H = 134;
const BRACKET_STROKE = 10;
const CORNER_R = 8;

export interface FlipPictureBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * THE DRAWN CONTENT'S BOUNDS — the blank, its outline, the bracket's arm and the ringed corner,
 * strokes included. The turn arrow and the words are HTML now, so they are not in this box.
 */
export function flipPictureBounds(w = PANEL_W, h = PANEL_H): FlipPictureBounds {
  const rectEdge = LINE_PX / 2;
  const cornerEdge = CORNER_R + LINE_PX / 2;
  return {
    minX: -rectEdge,
    minY: -rectEdge,
    maxX: Math.max(w + BRACKET_STROKE / 2, w + cornerEdge),
    maxY: Math.max(h + BRACKET_STROKE / 2, h + cornerEdge),
  };
}

/** The content plus a pad of {@link FLIP_DIAGRAM_PAD} of its larger side on every side (#1170). */
export function flipViewBox(bounds: FlipPictureBounds): { viewBox: string; pad: number } {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const pad = Math.max(width, height) * FLIP_DIAGRAM_PAD;
  const viewBox = `${bounds.minX - pad} ${bounds.minY - pad} ${width + 2 * pad} ${height + 2 * pad}`;
  return { viewBox, pad };
}

type Axis = 'left-right' | 'front-back';

export interface FlipDue {
  /** The setup whose last program finished (1-based). */
  fromSetup: number;
  /** The flipped setup whose first program is next (1-based). */
  toSetup: number;
  /** Programs finished before the turn. */
  done: number;
  total: number;
  /** The 1-based program that follows the turn. */
  nextIndex: number;
  /** The cutter that program runs, for the card's last sentence. */
  nextToolKey: string;
  axis: Axis;
  method: 'free-then-flip' | 'tabs-in-blank';
  /** The two locating bores in side 2's work frame (the setup's stored pins), or null. */
  boresAfter: { x: number; y: number }[] | null;
  /** The same two points reflected into side 1's work frame, or null. */
  boresBefore: { x: number; y: number }[] | null;
  stock: { length: number; width: number };
}

/**
 * WHEN THE CARD IS DUE, from the package and the finished hashes alone — so a reload (which keeps
 * neither the release store nor a machine run) lands back on it.
 *
 * It is due at the FIRST unfinished program, when the program before it belongs to an earlier
 * setup AND that setup records a flip. A one-sided job can never produce it; a plain second setup
 * (no flip record) stays an ordinary bit change.
 */
export function flipDue(input: {
  job: EngraveJob;
  pkg: FrozenPackage;
  finishedHashes: readonly string[];
}): FlipDue | null {
  const finished = new Set(input.finishedHashes);
  const programs = input.pkg.programs;
  const nextAt = programs.findIndex((program) => !finished.has(program.hash));
  if (nextAt <= 0) return null;
  const next = programs[nextAt]!;
  const previous = programs[nextAt - 1]!;
  if (next.setupIndex === previous.setupIndex) return null;
  const setup = jobSetups(input.job)[next.setupIndex - 1];
  const flip = setup?.flip;
  if (setup === undefined || flip === undefined) return null;
  const stock = { length: input.job.stock.length, width: input.job.stock.width };
  const pins = setup.pins?.at ?? null;
  return {
    fromSetup: previous.setupIndex,
    toSetup: next.setupIndex,
    done: nextAt,
    total: programs.length,
    nextIndex: nextAt + 1,
    nextToolKey: next.toolKey,
    axis: flip.axis,
    method: flip.method,
    boresAfter: pins === null ? null : pins.map((p) => ({ ...p })),
    boresBefore: pins === null ? null : pins.map((p) => flipReflection(p, flip, stock.length, stock.width)),
    stock,
  };
}

export interface FlipCardWords {
  axisWords: string;
  arrow: string;
  /** The edge that keeps its place through the turn. */
  stays: string;
  /** The edge the clamp goes back on. */
  clamp: string;
  /** The fence corner the picture rings. */
  corner: string;
}

/** The axis in the operator's words: which edge stays, which edge the clamp returns to. */
export function flipCardWords(axis: Axis): FlipCardWords {
  const corner = fenceCornerFor(axis) === 'FR' ? 'front-right' : 'back-left';
  return axis === 'left-right'
    ? { axisWords: 'left to right', arrow: 'left ↔ right', stays: 'front', clamp: 'back', corner }
    : { axisWords: 'front to back', arrow: 'front ↔ back', stays: 'left', clamp: 'right', corner };
}

export interface CutFlipCardProps {
  job: EngraveJob;
  pkg: FrozenPackage;
  finishedHashes: readonly string[];
  target: { host: string; port: number } | null;
  /** Hand the operator to the existing Register step for the flipped setup. */
  onRegister: () => void;
  /** Test seam: the arrival's IO; the app uses the machine's own home and light. */
  arrival?: FlipArrivalIO;
}

/**
 * One side's drawing — its LABEL, the tight SVG and its caption (#1170 field 2): the words are
 * HTML in the card's body type, so they never scale down with the picture. Inside the drawing
 * the two blanks are told apart by the marks the card already uses — the face shading and the
 * datum corner ring — not by labels.
 */
function FlipPicture({
  side,
  label,
  describe,
  bores,
  stock,
  caption,
}: {
  side: 'before' | 'after';
  label: string;
  describe: string;
  bores: { x: number; y: number }[] | null;
  stock: { length: number; width: number };
  caption: string | null;
}): JSX.Element {
  const atX = (mm: number): number => (mm / stock.length) * PANEL_W;
  // Work Y runs away from the operator; SVG Y runs down. The front edge is the bottom.
  const atY = (mm: number): number => PANEL_H - (mm / stock.width) * PANEL_H;
  const { viewBox } = flipViewBox(flipPictureBounds());
  return (
    <figure
      data-testid={`engrave-flip-picture-${side}`}
      style={{ margin: 0, minWidth: 0, flex: '1 1 0', display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <figcaption data-testid={`engrave-flip-label-${side}`} style={{ fontSize: BODY_TEXT, color: '#c9d4e2' }}>
        {label}
      </figcaption>
      <svg
        data-testid="engrave-flip-diagram"
        data-side={side}
        width="100%"
        viewBox={viewBox}
        role="img"
        aria-label={describe}
        style={{ display: 'block', height: 'auto' }}
      >
        <path
          data-testid={`engrave-flip-bracket-${side}`}
          d={`M0 ${PANEL_H} H${PANEL_W} V0`}
          stroke="#c9d4e2"
          strokeWidth={BRACKET_STROKE}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        <rect
          x={0}
          y={0}
          width={PANEL_W}
          height={PANEL_H}
          fill={side === 'before' ? '#8a6a3a' : '#7a5c30'}
          stroke="#c9a06a"
          strokeWidth={LINE_PX}
          vectorEffect="non-scaling-stroke"
        />
        {(bores ?? []).map((bore, i) => (
          <circle
            key={`${side}-${i}`}
            data-testid={`engrave-flip-bore-${side}-${i}`}
            data-x={bore.x}
            data-y={bore.y}
            cx={atX(bore.x)}
            cy={atY(bore.y)}
            r={5}
            fill="none"
            stroke={AMBER}
            strokeWidth={LINE_PX}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* The corner that sits in the bracket: the FIXTURE's corner, identical in both panels. */}
        <circle
          data-testid={`engrave-flip-corner-${side}`}
          cx={PANEL_W}
          cy={PANEL_H}
          r={CORNER_R}
          fill="none"
          stroke="#5fc27f"
          strokeWidth={LINE_PX}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {caption !== null && (
        <p data-testid={`engrave-flip-caption-${side}`} style={{ ...MUTED, fontSize: BODY_TEXT, margin: 0 }}>
          {caption}
        </p>
      )}
    </figure>
  );
}

export function CutFlipCard({
  job,
  pkg,
  finishedHashes,
  target,
  onRegister,
  arrival,
}: CutFlipCardProps): JSX.Element | null {
  const due = useMemo(() => flipDue({ job, pkg, finishedHashes }), [job, pkg, finishedHashes]);
  const [ticked, setTicked] = useState(false);
  const [arrivalState, setArrivalState] = useState<'waiting' | 'ready' | 'failed'>('waiting');
  const attempted = useRef<string | null>(null);
  const stack = useMediaQuery(STACK_QUERY);
  const machine = useMachineStore((s) => s.machine);
  const heartbeat = useMachineStore((s) => s.heartbeat);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const targetKey = target === null ? null : machineKey(target);
  const light = useStripAccessoryStore((s) => (targetKey === null ? null : (s.modes[targetKey]?.light ?? null)));
  const toleranceMm = readDefault(defaults, 'registration.surfaceToleranceMm').value;
  const toolItems = useToolRegistryStore((s) => s.items);
  const nextBit = due === null ? null : cutterIdentity(due.nextToolKey, toolItems).name;

  useEffect(() => {
    if (targetKey === null || due === null) return;
    if (attempted.current === targetKey) return;
    attempted.current = targetKey;
    let alive = true;
    const io = arrival ?? machineFlipArrival();
    void prepareFlipArrival({ host: target!.host, port: target!.port }, io).then((result) => {
      if (!alive) return;
      // The light has no read-back: the one honest claim is what this app just sent (#648).
      if (result === 'light-on') useStripAccessoryStore.getState().note(targetKey!, 'light', true);
      setArrivalState(result === 'light-on' ? 'ready' : 'failed');
    });
    return () => {
      alive = false;
    };
  }, [targetKey, due, arrival, target]);

  if (due === null) return null;

  const words = flipCardWords(due.axis);
  const machineWords = cutMachineLine({ machine, heartbeat, light });

  return (
    <section data-testid="engrave-flip-card" data-arrival={arrivalState} style={{ ...BOX, marginTop: 8 }}>
      <div
        data-testid="engrave-flip-header"
        style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: BODY_TEXT, borderBottom: '1px solid #2a3542', paddingBottom: 8 }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: '#2a2317',
            color: AMBER,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: BODY_TEXT,
            fontWeight: 700,
          }}
        >
          3
        </span>
        <span style={{ flex: '1 1 auto' }}>
          <b style={{ fontWeight: 600 }}>Cut</b>{' '}
          <span style={MUTED}>
            · side {due.fromSetup} done, {due.done} of {due.total} · turn the blank
          </span>
        </span>
        {machineWords.length > 0 && <span style={{ fontSize: BODY_TEXT, color: '#5fc27f' }}>{machineWords}</span>}
      </div>

      {/* #1170 (the drawing finding) — two drawings, each tight to its own content, with every word
          in HTML. Under 480 px they stack at the card's full width; at the panel's width they share
          a row. The turn's own words sit under both, in the card's body type. */}
      <div data-testid="engrave-flip-picture-block">
        <div
          data-testid="engrave-flip-pictures"
          style={{
            display: 'flex',
            flexDirection: stack ? 'column' : 'row',
            alignItems: 'stretch',
            gap: 10,
            margin: '8px 0 4px',
          }}
        >
          <FlipPicture
            side="before"
            label={`Before · side ${due.fromSetup} up`}
            describe={`Side ${due.fromSetup} up: the blank's ${words.corner} corner in the bracket, the two locating bores in their side-${due.fromSetup} places.`}
            bores={due.boresBefore}
            stock={due.stock}
            caption={null}
          />
          <FlipPicture
            side="after"
            label={`After · side ${due.toSetup} up`}
            describe={`The blank turned ${words.axisWords}: the two locating bores in their side-${due.toSetup} places, the other front corner in the bracket.`}
            bores={due.boresAfter}
            stock={due.stock}
            caption="the other front corner now sits in the bracket"
          />
        </div>
        <p
          data-testid="engrave-flip-axis"
          style={{ textAlign: 'center', fontSize: BODY_TEXT, color: '#9aa8b8', margin: '0 0 8px' }}
        >
          {words.arrow}
        </p>
      </div>

      {due.boresAfter === null && (
        <p style={{ ...MUTED, fontSize: BODY_TEXT, margin: '0 0 8px' }} data-testid="engrave-flip-no-bores">
          This setup states no locating pins, so the two bores cannot be drawn or registered on — re-plan the
          flip in Design → Setups.
        </p>
      )}

      <ol data-testid="engrave-flip-steps" style={{ margin: '8px 0 10px', paddingLeft: 20, fontSize: BODY_TEXT, display: 'grid', gap: 6 }}>
        <li>Loosen the clamp, lift the blank out, brush the chips off the bed and the bracket.</li>
        <li>
          Turn it over <b>{words.axisWords}</b> (the {words.stays} edge stays at the {words.stays}) and push the
          corner into the bracket.
        </li>
        <li>
          Clamp again on the {words.clamp} edge. The part stays in the blank on its tabs.
        </li>
      </ol>

      <label
        style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: '#1b2531', fontSize: BODY_TEXT }}
      >
        <input
          type="checkbox"
          data-testid="engrave-flip-confirm"
          checked={ticked}
          onChange={(event) => setTicked(event.target.checked)}
        />{' '}
        The blank is turned, seated in the corner and clamped
      </label>

      <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
        <button
          type="button"
          data-testid="engrave-flip-register"
          disabled={!ticked}
          style={{ padding: 12, borderRadius: 8, border: 0, background: '#2b3f63', color: '#9fb6da', font: 'inherit', fontWeight: 600, fontSize: 15 }}
          onClick={onRegister}
        >
          Register side {due.toSetup} on the two bores
        </button>
        <span style={{ fontSize: BODY_TEXT, color: '#9aa8b8' }} data-testid="engrave-flip-register-note">
          Probe in, two bores found from side {due.toSetup}’s top, Z checked at the corners first; a reading off the
          carried side-{due.toSetup} top by more than {toleranceMm} mm stops before any bore is entered. Then the
          cutter for program {due.nextIndex}
          {nextBit === undefined ? '' : ` (${nextBit})`}.
        </span>
      </div>
    </section>
  );
}
