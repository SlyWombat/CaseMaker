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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { markMachineChanged } from '@/store/engraveRegistrationStore';
import { attachConsole } from '@/platform/machineConsole';
import {
  applyCorrection,
  runCentreFind,
  type CentreFindOptions,
  type CentreRunResult,
} from '@/engine/cnc/registration/execute';
import { planCentreFind, type CentreFindPlan, type CentreKind } from '@/engine/cnc/registration/centreFind';
import { readDefault } from '@/platform/defaultsClient';
import { probeInstrumentOf, type ProbeSpec, type RegistrationPlan } from '@/engine/cnc/registration/plan';
import { topTouchEdgeMarginsMm } from '@/engine/cnc/registration/cutBlank';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
// #1202 field 5 — the Find press's own dry line view, first-run mark and statement.
import { dryCentreFind, type DryRoutine } from '@/engine/cnc/registration/dryRun';
import { RoutineDryPreview } from './RoutineDryPreview';
import { buildStamp, routineCompleted, withRoutineCompletion } from '@/platform/routineRecord';
import { firstRunAutomationRefusal } from '@/platform/automation';
import { machineAt, saveMachineWithRetry, useLocationStore } from '@/store/locationStore';

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

  // #1202 field 5 — THE FIND PRESS'S OWN ROUTINE, shown before it moves. The same plan the press
  // runs goes through the dry executor (recording console, no socket); a shape this machine has
  // never completed is marked, the operator's statement holds the press, and a run that finishes
  // without a stop records the shape.
  const machineRecord = useLocationStore((s) =>
    target === null
      ? null
      : s.location?.machines.find((m) => m.address?.host === target.host && m.address.port === target.port) ?? null,
  );
  const made = useMemo((): { ok: true; plan: CentreFindPlan } | { ok: false; reason: string } | null => {
    if (plan === null || probe?.tip == null || estimate === null) return null;
    return planCentreFind({
      kind,
      at: estimate,
      searchMm: Number(search.trim() === '' ? defaultSearch : search),
      ballRadiusMm: probe.tip.rimOffsetMm,
      ...(thickness === undefined ? {} : { stockThicknessMm: thickness }),
      touchFeed: settings.touchFeed,
      // #1207 — the travel bound is the shop's; a plan stored before the key reads the
      // recommendation at this edge rather than a literal.
      maxSearchMm: settings.centreSearchMaxMm ?? readDefault(null, 'registration.centreSearchMaxMm').value,
    });
  }, [kind, search, defaultSearch, plan, probe, estimate, thickness, settings.touchFeed, settings.centreSearchMaxMm]);
  /** The executor's own options for this plan — the press and the preview must not differ. */
  const centreOptions = useMemo((): CentreFindOptions | null => {
    if (made === null || !made.ok || plan === null) return null;
    return {
      plan: made.plan,
      seekFromMachineZ: plan.seek.fromMachineZ,
      bandMm: plan.seek.band,
      surfaceFeed: settings.surfaceSlowFeed,
      parkAboveSurfaceMm: settings.parkAboveSurfaceMm,
      ...(kind === 'bore' && topTouchAt !== null ? { topTouchAt } : {}),
      // #1211 field 6 — a top-touch-only probe refuses the wall touches before anything is sent.
      // An UNSTATED probe is a legacy wired unit, which does touch sideways (the k3 3D probe now
      // states 'z-only' explicitly); the deny-by-default part is the REQUIRED hold block, not this.
      probeTouches: probe?.touches ?? 'all',
      // #1211 field 5 — THE HOLD the find must respect, resolved here per #1207 (the preview and
      // the press share these options, so they cannot disagree). This panel is not mounted yet; a
      // mount must also state a boss's expected radius — the routine refuses a boss without one.
      hold: (() => {
        const margins = topTouchEdgeMarginsMm(
          { tipRadiusMm: settings.tipRadiusMm, tipLateralUncertaintyMm: probe?.tipLateralUncertaintyMm ?? 0 },
          { floorMm: settings.probeFootprintShrinkMm ?? 0, hold: { xMm: 0, yMm: 0 } },
        );
        return {
          footprint: { xMin: plan.stock.xMin, xMax: plan.stock.xMax, yMin: plan.stock.yMin, yMax: plan.stock.yMax },
          marginMm: Math.max(margins.xMm, margins.yMm),
          bandMm: settings.edgeBandMm,
          bodyRadiusMm: (probe?.bodyDiameterMm ?? 0) / 2,
          expectedRadiusMm: null,
          obstacles: plan.mountObstacles ?? [],
        };
      })(),
    };
  }, [made, plan, probe, settings, kind, topTouchAt]);
  const [preview, setPreview] = useState<DryRoutine | null>(null);
  const [ticked, setTicked] = useState(false);
  useEffect(() => {
    if (centreOptions === null) {
      setPreview(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const dry = await dryCentreFind(centreOptions);
        if (live) setPreview(dry);
      } catch {
        if (live) setPreview(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [centreOptions]);
  // A fresh statement per routine shape: the tick that satisfied the last press is not this one.
  useEffect(() => setTicked(false), [preview?.identity.shape]);
  const firstRun = preview !== null && !routineCompleted(machineRecord, preview.identity);
  const headless = firstRunAutomationRefusal({ firstRun });
  const routineGate = (preview !== null && preview.refused) || (firstRun && !ticked);

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
    if (target === null || made === null) return;
    if (!made.ok) {
      setError(made.reason);
      setPhase('failed');
      return;
    }
    if (centreOptions === null) return;
    setPhase('running');
    setError(null);
    setResult(null);
    setWritten(null);
    alive.current = true;
    const handle = attachConsole(target);
    try {
      const r = await runCentreFind(centreOptions, {
        console: { send: (line, timing) => handle.send(line, timing) },
        operator,
        liveClearanceZ: centreOptions.seekFromMachineZ,
        onFirstSend: () => markMachineChanged(target),
      });
      if (!alive.current) return;
      if (!r.ok) {
        setError(r.reason);
        setPhase('failed');
        return;
      }
      setResult(r);
      setPhase('measured');
      // #1202 — THE ROUTINE COMPLETED (no stop): its identity is recorded on the machine, through
      // the guarded PUT. A refused write only means the next press marks the routine again. The
      // card's preview is the identity's source; a press taken before it resolved computes the
      // same identity from the same plan (the dry console never touches the wire).
      const recordMachine = machineAt(target);
      if (recordMachine !== null) {
        const identity = preview?.identity ?? (await dryCentreFind(centreOptions)).identity;
        void saveMachineWithRetry(recordMachine, (current) =>
          withRoutineCompletion(current, {
            routine: 'centre-find',
            shape: identity.shape,
            at: new Date().toISOString(),
            build: buildStamp(),
          }),
        );
      }
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
        { console: { send: (line, timing) => handle.send(line, timing) }, operator, liveClearanceZ: result.outcome.machineClearanceZ ?? Number.NaN, onFirstSend: () => markMachineChanged(target) },
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
          {/* #1202 field 5 — the Find press's own routine: shown, marked on a first run, and held
              by the operator's statement (or by a refused line / the headless refusal). */}
          {preview !== null && (
            <RoutineDryPreview
              preview={preview}
              firstRun={firstRun}
              ticked={ticked}
              onTick={setTicked}
              headless={headless}
            />
          )}
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              data-testid="engrave-centre-find"
              disabled={busy || (kind === 'bore' && topTouchAt === null) || routineGate || headless !== null}
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
