import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { LASER_JOG_STEPS, LaserPointSession, pointToOriginAllowed, stockTopSentence, zText, type LaserLift } from '@/platform/machineLaser';
import { laserHomeKey, useLaserHomeStore } from '@/store/laserHomeStore';

/**
 * #431 slice 2 — laser point-to-origin: lift, laser on, jog the red dot onto the stock's corner (X and Y
 * only, 10 / 1 / 0.1 mm), Set — confirmed — writes `G10 L2 P1 X Y` from where the machine is; then laser
 * off and home. Z0 is unchanged.
 *
 * A user option, OFF by default (Q21): it renders only when `laserOptions.pointToOrigin` is on. It is
 * refused for a job whose edge margin is tighter than the dot's accuracy (`laser.originUncertaintyMm`,
 * ±1, chosen), and armed by one tick naming what only the person can see. The laser is switched off on
 * every way out. The machine HOMES only on what the operator pressed — Finish, or Set. A failure, or this
 * panel going away (it unmounts on a tab switch, a selection, a form error), switches the laser off and
 * moves nothing; the home it owes is recorded, and offered here and on the machine card as a button.
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const ROW: CSSProperties = { display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' };

export interface EngraveLaserPointProps {
  host: string;
  port: number;
  /** The job's edge margin, mm, and where it came from (the job's own, or the house setting). */
  margin: { mm: number; from: string };
  /** `laser.originUncertaintyMm`, with its source. */
  uncertainty: { mm: number; source: string };
  /**
   * The Z the head lifts to, with the bounds that make it safe — the resolved machine's
   * `toolChange.clearanceZ` and `softEndstop.zMin`. REQUIRED, not defaulted: a missing one must be
   * a typecheck error, never a silent −3 (#448).
   */
  lift: LaserLift;
}

export function EngraveLaserPoint({ host, port, margin, uncertainty, lift }: EngraveLaserPointProps): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [stage, setStage] = useState<'idle' | 'jogging' | 'confirm' | 'busy'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const session = useRef<LaserPointSession | null>(null);
  const allowed = pointToOriginAllowed(margin.mm, uncertainty.mm);
  const target = { host, port };
  const owed = useLaserHomeStore((s) => s.pending[laserHomeKey({ host, port })] ?? null);
  const owe = useLaserHomeStore((s) => s.owe);
  const clearOwed = useLaserHomeStore((s) => s.clear);
  const sendHome = useLaserHomeStore((s) => s.home);

  // The panel going away is not something anybody pressed: the laser goes off, and NOTHING moves. A
  // lifted head owes a home, recorded for the next time this panel or the machine card opens.
  useEffect(
    () => () => {
      const s = session.current;
      session.current = null;
      if (s) {
        void s.end({ home: false }).then((r) => {
          if (r.lifted) useLaserHomeStore.getState().owe({ host, port }, 'a laser point-to-origin session ended without a home (the panel closed)');
        });
      }
    },
    [host, port],
  );

  async function finish(prefix: string): Promise<void> {
    const s = session.current;
    session.current = null;
    const r = s ? await s.end({ home: true }) : { laserOff: true, homed: false, lifted: false };
    if (r.homed) clearOwed(target);
    else if (r.lifted) owe(target, 'a laser point-to-origin session ended without a home');
    setNote(`${prefix}${r.laserOff ? ' The laser is off' : ' The laser may still be on — send M832 or switch it off at the machine'}${r.homed ? ' and the machine is homing.' : '.'}`);
    setStage('idle');
    setArmed(false);
  }

  /** A failed step: the session switched the laser off and moved nothing; record the home it owes. */
  function failed(r: { detail: string; homeOwed?: boolean }): void {
    if (r.homeOwed) owe(target, 'a laser point-to-origin step failed after the lift');
    setNote(r.detail);
  }

  async function start(): Promise<void> {
    setStage('busy');
    const s = new LaserPointSession({ host, port }, lift);
    session.current = s;
    const r = await s.begin();
    if (r.ok) {
      setNote(r.detail);
      setStage('jogging');
    } else {
      failed(r);
      session.current = null;
      setStage('idle');
      setArmed(false);
    }
  }

  async function jog(axis: 'X' | 'Y', step: number): Promise<void> {
    const s = session.current;
    if (!s) return;
    const r = await s.jog(axis, step);
    if (r.ok) setNote(r.detail);
    else failed(r);
    if (!r.ok && !s.active) {
      session.current = null;
      setStage('idle');
    }
  }

  async function set(): Promise<void> {
    const s = session.current;
    if (!s) return;
    setStage('busy');
    const r = await s.set(true);
    if (r.ok) await finish(`${r.detail}`);
    else if (!s.active) {
      session.current = null;
      failed(r);
      setStage('idle');
    } else {
      setNote(r.detail);
      setStage('jogging');
    }
  }

  if (!allowed.ok) {
    return (
      <p style={MUTED} data-testid="engrave-laser-point-refused">
        Laser point-to-origin is not offered: {allowed.reason} ({margin.from}; ±{uncertainty.mm} mm is {uncertainty.source}).
      </p>
    );
  }

  const homeOwed = owed !== null && stage === 'idle' && (
    <div data-testid="engrave-laser-point-home-owed">
      <p style={MUTED}>Home the machine before the next step — {owed.why}.</p>
      <button
        type="button"
        data-testid="engrave-laser-point-home"
        onClick={() => void sendHome(target).then((r) => setNote(r.detail))}
      >
        Home ($H)
      </button>
    </div>
  );

  const steps = [...LASER_JOG_STEPS].flatMap((v) => [-v]).concat([...LASER_JOG_STEPS].reverse());
  return (
    <div data-testid="engrave-laser-point" style={{ marginTop: 8 }}>
      <p style={MUTED}>
        Laser point-to-origin — good to ±{uncertainty.mm} mm ({uncertainty.source}, laser.originUncertaintyMm); sets X and Y only, Z0 is
        unchanged.
      </p>
      {/* #457 — the lift's own bound, in the same words the frame uses. */}
      <p style={MUTED} data-testid="engrave-laser-point-surface">
        {stockTopSentence(lift)}
      </p>
      {homeOwed}
      {stage === 'idle' && (
        <>
          <label style={{ ...MUTED, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" data-testid="engrave-laser-point-arm" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
            The 3D probe is in the spindle, and I am at the machine
          </label>
          <button
            type="button"
            data-testid="engrave-laser-point-start"
            disabled={!armed}
            style={{ width: '100%', padding: 7, marginTop: 4 }}
            title={`Lift to machine Z ${zText(lift.zMachine)}, then switch the probe laser on (M831)`}
            onClick={() => void start()}
          >
            Point to origin with laser
          </button>
        </>
      )}
      {(stage === 'jogging' || stage === 'confirm') && (
        <div data-testid="engrave-laser-point-jog">
          {(['X', 'Y'] as const).map((axis) => (
            <div key={axis} style={ROW}>
              <span style={{ ...MUTED, width: 14 }}>{axis}</span>
              {steps.map((st) => (
                <button
                  key={st}
                  type="button"
                  data-testid={`engrave-laser-jog-${axis}${st > 0 ? '+' : ''}${st}`}
                  disabled={stage !== 'jogging'}
                  onClick={() => void jog(axis, st)}
                >
                  {st > 0 ? '+' : ''}
                  {st}
                </button>
              ))}
            </div>
          ))}
          {stage === 'jogging' && (
            <div style={ROW}>
              <button type="button" data-testid="engrave-laser-point-set" onClick={() => setStage('confirm')}>
                Set origin here…
              </button>
              <button type="button" data-testid="engrave-laser-point-finish" onClick={() => void finish('Stopped without setting an origin.')}>
                Finish (laser off, home)
              </button>
            </div>
          )}
          {stage === 'confirm' && (
            <div data-testid="engrave-laser-point-confirm">
              <p style={MUTED}>
                Write the work origin's X and Y where the red dot is now, on the stock's corner? Z0 stays as it is. Good to ±{uncertainty.mm} mm.
              </p>
              <button type="button" data-testid="engrave-laser-point-confirm-yes" onClick={() => void set()}>
                Write X and Y
              </button>{' '}
              <button type="button" data-testid="engrave-laser-point-confirm-no" onClick={() => setStage('jogging')}>
                Back to jogging
              </button>
            </div>
          )}
        </div>
      )}
      {stage === 'busy' && <p style={MUTED}>Working…</p>}
      {note !== null && (
        <p style={MUTED} data-testid="engrave-laser-point-note">
          {note}
        </p>
      )}
    </div>
  );
}
