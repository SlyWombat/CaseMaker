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

/** One panel of the before/after picture: blank, two bores, the ringed corner. */
function FlipPanel({
  side,
  title,
  bores,
  stock,
  caption,
}: {
  side: 'before' | 'after';
  title: string;
  bores: { x: number; y: number }[] | null;
  stock: { length: number; width: number };
  caption: string | null;
}): JSX.Element {
  const x = side === 'before' ? 36 : 376;
  const y = 40;
  const w = 150;
  const h = 134;
  const atX = (mm: number): number => x + (mm / stock.length) * w;
  // Work Y runs away from the operator; SVG Y runs down. The front edge is the bottom.
  const atY = (mm: number): number => y + h - (mm / stock.width) * h;
  return (
    <g>
      <text x={x + w / 2} y={18} fill="#c9d4e2" fontSize={12} textAnchor="middle">
        {title}
      </text>
      <g transform={`translate(${x},0)`}>
        <path
          data-testid={`engrave-flip-bracket-${side}`}
          d={`M0 ${y + h} H${w} V${y}`}
          stroke="#c9d4e2"
          strokeWidth={10}
          fill="none"
        />
      </g>
      <rect x={x} y={y} width={w} height={h} fill={side === 'before' ? '#8a6a3a' : '#7a5c30'} stroke="#c9a06a" />
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
          strokeWidth={2}
        />
      ))}
      {/* The corner that sits in the bracket: the FIXTURE's corner, identical in both panels. */}
      <circle
        data-testid={`engrave-flip-corner-${side}`}
        cx={x + w}
        cy={y + h}
        r={8}
        fill="none"
        stroke="#5fc27f"
        strokeWidth={2}
      />
      {caption !== null && (
        <text x={x + w / 2} y={y + h + 18} fill="#5fc27f" fontSize={11} textAnchor="middle">
          {caption}
        </text>
      )}
    </g>
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
        style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, borderBottom: '1px solid #2a3542', paddingBottom: 8 }}
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
            fontSize: 12,
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
        {machineWords.length > 0 && <span style={{ fontSize: 12, color: '#5fc27f' }}>{machineWords}</span>}
      </div>

      <svg
        data-testid="engrave-flip-diagram"
        width="100%"
        height={220}
        viewBox="0 0 560 220"
        role="img"
        aria-label={`Before: side ${due.fromSetup} up, the blank's ${words.corner} corner in the bracket. After: the blank turned ${words.axisWords}, the other front corner in the bracket, the two locating bores now in their side-2 places.`}
      >
        <FlipPanel
          side="before"
          title={`Before · side ${due.fromSetup} up`}
          bores={due.boresBefore}
          stock={due.stock}
          caption={null}
        />
        <path d="M250 110h60" stroke="#c9d4e2" strokeWidth={2} />
        <path d="M310 110l-8-6v12z" fill="#c9d4e2" />
        <text
          data-testid="engrave-flip-axis"
          x={280}
          y={98}
          fill="#9aa8b8"
          fontSize={11}
          textAnchor="middle"
        >
          {words.arrow}
        </text>
        <FlipPanel
          side="after"
          title={`After · side ${due.toSetup} up`}
          bores={due.boresAfter}
          stock={due.stock}
          caption="the other front corner now sits in the bracket"
        />
      </svg>

      {due.boresAfter === null && (
        <p style={{ ...MUTED, fontSize: 12, margin: '0 0 8px' }} data-testid="engrave-flip-no-bores">
          This setup states no locating pins, so the two bores cannot be drawn or registered on — re-plan the
          flip in Design → Setups.
        </p>
      )}

      <ol data-testid="engrave-flip-steps" style={{ margin: '8px 0 10px', paddingLeft: 20, fontSize: 14, display: 'grid', gap: 6 }}>
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
        style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: '#1b2531', fontSize: 14 }}
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
        <span style={{ fontSize: 12, color: '#9aa8b8' }} data-testid="engrave-flip-register-note">
          Probe in, two bores found from side {due.toSetup}’s top, Z checked at the corners first; a reading off the
          carried side-{due.toSetup} top by more than {toleranceMm} mm stops before any bore is entered. Then the
          cutter for program {due.nextIndex}
          {nextBit === undefined ? '' : ` (${nextBit})`}.
        </span>
      </div>
    </section>
  );
}
