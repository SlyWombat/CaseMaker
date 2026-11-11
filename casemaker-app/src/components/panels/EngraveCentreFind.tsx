/**
 * #827 — "ORIGIN FROM A BORE / A BOSS / A ROUND PART", the Register step's centre path.
 *
 * Studio's probing exists to set the work origin; this is that, in the job's own flow. The 3D
 * probe finds the feature's centre (`runCentreFind`: ±X, recentre, ±Y, repeat X, every touch
 * released with G38.5) and touches the top for Z0; the operator then writes the measured centre
 * as X/Y zero. The diameter the routine measures is shown, so a blank a little off its stated
 * size is a fact the operator reads rather than a surprise later.
 *
 * WHAT IT DOES NOT DO. It writes no placement frame and records no setup registration: the
 * G10 origin is the whole write, exactly as `applyCorrection` writes it. A job still needs its
 * edge registration (the stock's position and rotation) before a program is posted from it — the
 * feature's centre says where the ORIGIN is, not where the stock's edges are.
 */

import { useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { attachConsole } from '@/platform/machineConsole';
import { applyCorrection, runCentreFind, type CentreRunResult } from '@/engine/cnc/registration/execute';
import { planCentreFind, type CentreKind } from '@/engine/cnc/registration/centreFind';
import { probeInstrumentOf, type ProbeSpec, type RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const BOX: CSSProperties = { marginTop: 6, padding: 8, border: '1px solid #3a4552', borderRadius: 4, background: '#1b2027' };
const OK = '#9fd19b';
const BAD = '#f0b4ad';

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

export interface EngraveCentreFindProps {
  target: { host: string; port: number } | null;
  plan: RegistrationPlan | null;
  settings: RegistrationSettings;
  probe: ProbeSpec | null;
}

type Phase = 'idle' | 'running' | 'measured' | 'writing' | 'written' | 'failed';

/** #827 — the centre-find section of the Register step. Draws nothing without a 3D probe. */
export function EngraveCentreFind({ target, plan, settings, probe }: EngraveCentreFindProps): JSX.Element | null {
  const [kind, setKind] = useState<CentreKind>('bore');
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<CentreRunResult, { ok: true }> | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ text: string; resolve: (v: boolean) => void } | null>(null);
  const alive = useRef(true);

  // The estimate and the stock, in the plan's own frame. The cut centre is the round blank's
  // middle; a bore is found wherever the job puts it, so the same point is the estimate either way.
  const stock = plan?.stock ?? null;
  const estimate = plan?.surfacePoint ?? null;
  const thickness = plan?.stockThicknessMm;
  const defaultSearch = useMemo(() => {
    if (stock === null) return '8';
    const w = stock.xMax - stock.xMin;
    const h = stock.yMax - stock.yMin;
    // A boss must be searched from outside its own reach; a bore needs to reach its far wall.
    return String(kind === 'boss' ? Math.ceil(Math.hypot(w, h) / 2) + 2 : Math.max(4, Math.round(Math.min(w, h) / 4)));
  }, [stock, kind]);
  // A bore's centre is a hole: the top touch goes to a point on the face beyond the search, on
  // +X when the stock has room, else −X.
  const topTouchAt = useMemo(() => {
    if (estimate === null || stock === null) return null;
    const reach = Number(search.trim() === '' ? defaultSearch : search);
    const gap = Number.isFinite(reach) ? reach + 2 : null;
    if (gap === null) return null;
    if (estimate.x + gap <= stock.xMax - 1) return { x: estimate.x + gap, y: estimate.y };
    if (estimate.x - gap >= stock.xMin + 1) return { x: estimate.x - gap, y: estimate.y };
    return null;
  }, [estimate, stock, search, defaultSearch]);

  const operator = (step: { text: string }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (!alive.current) {
        resolve(false);
        return;
      }
      setAsk({ text: step.text, resolve });
    });

  function answer(value: boolean): void {
    const a = ask;
    setAsk(null);
    a?.resolve(value);
  }

  async function find(): Promise<void> {
    if (target === null || plan === null || probe?.tip == null || estimate === null) return;
    const made = planCentreFind({
      kind,
      at: estimate,
      searchMm: Number(search.trim() === '' ? defaultSearch : search),
      ballRadiusMm: probe.tip.rimOffsetMm,
      ...(thickness === undefined ? {} : { stockThicknessMm: thickness }),
      touchFeed: settings.touchFeed,
    });
    if (!made.ok) {
      setError(made.reason);
      setPhase('failed');
      return;
    }
    setPhase('running');
    setError(null);
    setResult(null);
    setWritten(null);
    alive.current = true;
    const handle = attachConsole(target);
    try {
      const r = await runCentreFind(
        {
          plan: made.plan,
          seekFromMachineZ: plan.seek.fromMachineZ,
          bandMm: plan.seek.band,
          surfaceFeed: settings.surfaceSlowFeed,
          parkAboveSurfaceMm: settings.parkAboveSurfaceMm,
          ...(kind === 'bore' && topTouchAt !== null ? { topTouchAt } : {}),
          // #1211 field 6 — a top-touch-only probe refuses the wall touches before anything is sent.
          probeTouches: probe.touches ?? 'z-only',
        },
        { console: { send: (line, timing) => handle.send(line, timing) }, operator, liveClearanceZ: plan.seek.fromMachineZ },
      );
      if (!alive.current) return;
      if (!r.ok) {
        setError(r.reason);
        setPhase('failed');
        return;
      }
      setResult(r);
      setPhase('measured');
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('failed');
      }
    } finally {
      await handle.close();
    }
  }

  async function write(): Promise<void> {
    if (target === null || result === null) return;
    setPhase('writing');
    setError(null);
    const handle = attachConsole(target);
    try {
      const a = await applyCorrection(
        result.outcome,
        { console: { send: (line, timing) => handle.send(line, timing) }, operator, liveClearanceZ: result.outcome.machineClearanceZ ?? Number.NaN },
        { confirmed: true },
      );
      if (!alive.current) return;
      if (!a.ok) {
        setError(a.reason);
        setPhase('failed');
        return;
      }
      setWritten(a.line);
      setPhase('written');
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('failed');
      }
    } finally {
      await handle.close();
    }
  }

  if (plan === null || target === null || probeInstrumentOf(probe) !== 'xyz') return null;
  const tip = probe?.tip ?? null;
  const busy = phase === 'running' || phase === 'writing';

  return (
    <section style={BOX} data-testid="engrave-centre">
      <p style={{ fontSize: 12, fontWeight: 600, color: '#e6edf5', margin: '0 0 4px' }}>Origin from a bore, a boss or a round part</p>
      {tip === null ? (
        <p style={MUTED} data-testid="engrave-centre-no-tip">
          This 3D probe has no measured tip — measure it in Manage › Accessories, then find the centre.
        </p>
      ) : (
        <>
          <p style={MUTED}>
            The 3D probe touches the feature&rsquo;s walls and top; the origin becomes the measured centre (X/Y) with Z0 from
            the top touch. It writes no stock frame — the edge registration still sets that.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, color: '#c8d3de' }}>
              The feature{' '}
              <select
                data-testid="engrave-centre-kind"
                value={kind}
                disabled={busy}
                style={{ marginLeft: 4 }}
                onChange={(e) => {
                  setKind(e.target.value as CentreKind);
                  setPhase('idle');
                  setResult(null);
                }}
              >
                <option value="bore">a bore</option>
                <option value="boss">a boss or a round part</option>
              </select>
            </label>
            <label style={{ fontSize: 11, color: '#c8d3de' }}>
              Search{' '}
              <input
                data-testid="engrave-centre-search"
                type="number"
                min={0.5}
                step={0.5}
                value={search}
                placeholder={defaultSearch}
                disabled={busy}
                aria-label="Search radius, mm"
                style={{ width: 64, marginLeft: 4 }}
                onChange={(e) => setSearch(e.target.value)}
              />{' '}
              mm
            </label>
          </div>
          {kind === 'bore' && topTouchAt === null && (
            <p style={MUTED} data-testid="engrave-centre-no-face">
              The stock has no face beside the bore within the search radius — make the search smaller, or touch off on a
              larger blank.
            </p>
          )}
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              data-testid="engrave-centre-find"
              disabled={busy || (kind === 'bore' && topTouchAt === null)}
              style={{ width: '100%', padding: 7 }}
              onClick={() => void find()}
            >
              {phase === 'running' ? 'Finding the centre…' : 'Find the centre'}
            </button>
          </div>
          {ask !== null && (
            <div style={BOX} data-testid="engrave-centre-operator">
              <p style={MUTED}>{ask.text}</p>
              <button type="button" data-testid="engrave-centre-continue" style={{ marginRight: 6 }} onClick={() => answer(true)}>
                Continue
              </button>
              <button type="button" data-testid="engrave-centre-stop" onClick={() => answer(false)}>
                Stop
              </button>
            </div>
          )}
          {error !== null && (
            <p style={{ ...MUTED, color: BAD }} data-testid="engrave-centre-error">
              {error}
            </p>
          )}
          {result !== null && (
            <div style={BOX} data-testid="engrave-centre-result">
              <p style={{ ...MUTED, color: '#e6edf5', margin: 0 }} data-testid="engrave-centre-centre">
                Centre — X {n(result.centreWork.x)} Y {n(result.centreWork.y)} (machine X {n(result.centreMachine.x)} Y{' '}
                {n(result.centreMachine.y)})
              </p>
              <p style={MUTED} data-testid="engrave-centre-diameter">
                {result.pairs.map((p) => `${p.axis.toUpperCase()} ${n(p.diameterMm)} mm`).join(' · ')} — measured across the{' '}
                {kind === 'bore' ? 'walls' : 'part'}
              </p>
              <p style={MUTED} data-testid="engrave-centre-top">
                Top — machine Z {n(result.surfaceZ)} (Z0 is written from it with the cutter&rsquo;s own M491)
              </p>
              <button
                type="button"
                data-testid="engrave-centre-write"
                disabled={busy}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => void write()}
              >
                {phase === 'writing' ? 'Writing the origin…' : 'Use this centre as X/Y zero'}
              </button>
            </div>
          )}
          {written !== null && (
            <p style={{ ...MUTED, color: OK }} data-testid="engrave-centre-written">
              Origin written — <code>{written}</code>
            </p>
          )}
        </>
      )}
    </section>
  );
}
