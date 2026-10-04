// The transport bar (#198, `/Simulation.md` §8.0): scrub, play to completion, stop at pauses.
//
// It mounts over the bottom of the viewport whenever a simulation owns the scene (`isSimSceneActive`),
// including a PATH-ONLY session (#194), which has a timeline but no stock. The bar is the only
// thing that runs a clock; the store's actions do the moving, and every scrubber position is a
// PROGRAM STEP (0 … `summary.steps - 1`), never a checkpoint. Checkpoints are when the material
// updates — not ticks on the bar — so the only tick marks drawn are the program's pause points.
//
// One `requestAnimationFrame` loop runs while `playing`. Each frame it calls the pure `advance`
// and hands the time back through `seekSeconds`; it never runs a Manifold boolean and never
// touches the material, which changes only when `checkpointAtStep` does.

import { useEffect, type CSSProperties } from 'react';
import { advance, lineAtStep, totalTime } from '@/engine/cnc/playbackClock';
import { isSimSceneActive, SIM_SPEEDS, useSimStore, type SimSpeed } from '@/store/simStore';
import type { PausePoint, ToolState } from '@/engine/cnc';

/**
 * A backgrounded tab's first frame can carry minutes of wall time, which at 100x would jump the
 * whole program. Cap one frame's wall time so playback lurches at most this far instead (#198).
 */
const MAX_FRAME_DT_SECONDS = 0.1;

/** Skip the shortcuts while the user is typing into a panel field (the `ViewportToolbar` rule). */
function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

/** `m:ss` — program time is seconds, and a program can run past an hour only in theory. */
function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `T1`, `T?` (an unknown tool) or an em dash for "none". */
function toolLabel(t: ToolState | number | null): string {
  if (t === null) return '—';
  if (t === 'unknown') return 'T?';
  return `T${t}`;
}

/**
 * The callout names the pause the way the machine states it (#198). A tool change is a pause, not
 * an error — the emulator stops where the operator would, and play continues past it.
 */
function pauseMessage(p: PausePoint): string {
  if (p.kind === 'tool-change') {
    return `Tool change: ${toolLabel(p.fromTool)} → ${toolLabel(p.toTool)}. Press play to continue.`;
  }
  return `${p.kind} pause at line ${p.line}. Press play to continue.`;
}

const BAR: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 6,
  background: 'rgba(17,23,36,.97)',
  borderTop: '1px solid #2a2f36',
  padding: '6px 12px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const BTN: CSSProperties = {
  width: 30,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#1a1f25',
  border: '1px solid #2a2f36',
  color: '#d1d5db',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
};
const PLAY_BTN: CSSProperties = { ...BTN, background: '#243042', borderColor: '#3a5a7a', color: '#cfe' };
const SPEED: CSSProperties = {
  background: '#1a1f25',
  border: '1px solid #2a2f36',
  color: '#d1d5db',
  borderRadius: 4,
  fontSize: 11,
  padding: '3px 6px',
  fontFamily: 'monospace',
};
const SCRUB_WRAP: CSSProperties = { flex: 1, position: 'relative', minWidth: 0, display: 'flex', alignItems: 'center', margin: '0 8px' };
const SCRUBBER: CSSProperties = { width: '100%', margin: 0, accentColor: '#4d8eff' };
const TICKS: CSSProperties = { position: 'absolute', left: 0, right: 0, top: '50%', height: 0, pointerEvents: 'none' };
const TICK: CSSProperties = {
  position: 'absolute',
  top: -8,
  width: 2,
  height: 15,
  background: '#e0c07a',
  opacity: 0.85,
  borderRadius: 1,
  transform: 'translateX(-1px)',
};
const READOUT: CSSProperties = { fontFamily: 'monospace', fontSize: 11, color: '#d1d5db', whiteSpace: 'nowrap' };
const READOUT_MUTED: CSSProperties = { ...READOUT, color: '#9aa4b0' };
const CALLOUT: CSSProperties = {
  position: 'absolute',
  left: 16,
  bottom: 84,
  maxWidth: 440,
  background: '#4a3e1d',
  border: '1px solid #7a6828',
  color: '#f7eed4',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 12,
  boxShadow: '0 2px 10px rgba(0,0,0,.4)',
};
const NOTE: CSSProperties = { fontSize: 10, color: '#6c7585', fontFamily: 'monospace' };

/** The bar itself; rendered only while a simulation owns the scene. */
function TransportBar() {
  const path = useSimStore((s) => s.path);
  const playing = useSimStore((s) => s.playing);
  const speed = useSimStore((s) => s.speed);
  const step = useSimStore((s) => s.step);
  const stepCount = useSimStore((s) => s.stepCount);
  const pauses = useSimStore((s) => s.pauses);
  const seconds = useSimStore((s) => s.seconds);
  const stoppedAt = useSimStore((s) => s.stoppedAt);
  const info = useSimStore((s) => s.info);

  const lastStep = stepCount > 0 ? stepCount - 1 : 0;
  const total = path ? totalTime(path) : 0;
  const line = path ? lineAtStep(path, step) : null;

  // One frame loop, live only while `playing`. It reads the store non-reactively each frame so a
  // new `seconds`/`speed` never restarts it, and it stops itself on `end`/`pause` by not asking
  // for another frame (the `playing = false` that follows also tears the effect down).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    const tick = (ts: number) => {
      const s = useSimStore.getState();
      const p = s.path;
      if (!p || p.t.length === 0) {
        s.halt(null);
        return;
      }
      if (last === null) last = ts;
      const dtWall = Math.min(Math.max(ts - last, 0) / 1000, MAX_FRAME_DT_SECONDS);
      last = ts;
      const { seconds: nextSeconds, stop } = advance(
        p,
        s.seconds,
        dtWall,
        s.speed,
        s.pauses.map((x) => x.step),
      );
      if (stop) {
        if (stop.reason === 'pause') {
          // Snap the scrubber to the pause's own step, so the thumb and "step N" name where the
          // machine stopped; the stock is the one after the last cut before it.
          s.setStep(stop.step);
          s.halt(s.pauses.find((x) => x.step === stop.step) ?? null);
        } else {
          // End of program: the last STEP, so the viewport shows the final result (`SimMeshes`).
          s.toEnd();
          s.halt(null);
        }
        return;
      }
      s.seekSeconds(nextSeconds);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Keyboard, when the viewport has focus: Space play/pause, ←/→ step, Home/End jump. Skips a
  // focused field so the scrubber and the speed select keep their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useSimStore.getState();
      if (e.key === ' ') {
        if (s.playing) s.pause();
        else s.play();
      } else if (e.key === 'ArrowLeft') {
        s.pause();
        s.stepBy(-1);
      } else if (e.key === 'ArrowRight') {
        s.pause();
        s.stepBy(1);
      } else if (e.key === 'Home') {
        s.pause();
        s.toStart();
      } else if (e.key === 'End') {
        s.pause();
        s.toEnd();
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div data-testid="sim-transport" style={BAR}>
      <div style={ROW}>
        <button type="button" data-testid="sim-to-start" title="Jump to start" style={BTN} onClick={() => useSimStore.getState().toStart()}>
          ⏮
        </button>
        <button type="button" data-testid="sim-step-back" title="Step back" style={BTN} onClick={() => useSimStore.getState().stepBy(-1)}>
          ◀
        </button>
        <button
          type="button"
          data-testid="sim-play"
          title="Play / pause"
          aria-label={playing ? 'Pause' : 'Play'}
          style={PLAY_BTN}
          onClick={() => {
            const s = useSimStore.getState();
            if (s.playing) s.pause();
            else s.play();
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button type="button" data-testid="sim-step-forward" title="Step forward" style={BTN} onClick={() => useSimStore.getState().stepBy(1)}>
          ▶
        </button>
        <button
          type="button"
          data-testid="sim-to-end"
          title="Run to completion"
          style={BTN}
          onClick={() => useSimStore.getState().toEnd()}
        >
          ⏭
        </button>
        <select
          data-testid="sim-speed"
          aria-label="Playback speed"
          title="Wall-clock multiplier for playback"
          style={SPEED}
          value={speed}
          onChange={(e) => useSimStore.getState().setSpeed(Number(e.target.value) as SimSpeed)}
        >
          {SIM_SPEEDS.map((n) => (
            <option key={n} value={n}>
              {n}×
            </option>
          ))}
        </select>
        <div style={SCRUB_WRAP}>
          <input
            data-testid="sim-scrubber"
            type="range"
            min={0}
            max={lastStep}
            step={1}
            value={Math.max(0, Math.min(step, lastStep))}
            aria-label="Program step"
            // Every input event moves the step (issue #198): the client's frame coalescer keeps at
            // most one seek in flight, so a fast drag is already coalesced — no debounce here.
            onChange={(e) => useSimStore.getState().setStep(Number(e.target.value))}
            style={SCRUBBER}
          />
          <div data-testid="sim-pause-markers" style={TICKS} aria-hidden="true">
            {pauses.map((p, i) => (
              <span
                key={`${p.step}-${i}`}
                data-testid="sim-pause-tick"
                style={{ ...TICK, left: `${lastStep > 0 ? (p.step / lastStep) * 100 : 0}%` }}
              />
            ))}
          </div>
        </div>
        <span data-testid="sim-time" style={READOUT} title="Simulated time — rapids use a display-only rate, so this is not a cycle-time estimate.">
          {formatTime(seconds)} / {formatTime(total)} simulated
        </span>
        <span data-testid="sim-step" style={READOUT_MUTED}>
          step {Math.max(0, step) + 1} / {stepCount}
        </span>
        <span data-testid="sim-line" style={READOUT_MUTED}>
          line {line ?? '—'}
        </span>
      </div>
      {stoppedAt && (
        <div data-testid="sim-pause-callout" style={CALLOUT}>
          {pauseMessage(stoppedAt)}
        </div>
      )}
      {info && (
        <div data-testid="sim-checkpoint-note" style={NOTE}>
          Material updates at {info.count} point{info.count === 1 ? '' : 's'} in this program — between
          them the tool moves over a static stock. Ticks are the program’s pause points.
        </div>
      )}
    </div>
  );
}

/**
 * The transport, mounted over the viewport (#198). Renders nothing unless a simulation owns the
 * scene: a completed load, or a path-only refusal (#194), both of which carry a `SimPath`.
 */
export function SimTransport() {
  const active = useSimStore(isSimSceneActive);
  return active ? <TransportBar /> : null;
}
