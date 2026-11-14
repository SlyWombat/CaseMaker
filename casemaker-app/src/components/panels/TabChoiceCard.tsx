/**
 * #1258 — THE TAB QUESTION: the card Generate stops on.
 *
 * Drawn and approved (issue #1258, mock-up v2). When tabs at the shop's full corner margins cannot
 * keep every stretch of the outline under its span limit, the planner asks instead of placing a tab
 * itself, and this is the question: its own large card at the point Generate stopped, headed ACTION
 * NEEDED, the exact sentence, the part's outline to scale with the stretches numbered, and three
 * answers — two that choose between the shop's rules (one answer for all the stretches) and, set
 * apart, one that changes the rules' inputs.
 *
 * STATES (all one component, one place):
 *   ask       — nothing selected, "Use this choice" disabled; the drawing follows the option in focus
 *   collapsed — after Cancel: a one-line amber bar with "Choose…"; Generate still has no programs
 *   answered  — a compact summary with "Change…"; the same place
 * `again` (the answer is stale) is `ask` with one more line. Option 1 is absent when no stretch has
 * room for a tab, and says why.
 *
 * DISPLAY ONLY. It reads the planner's question and calls back; it writes no job and plans nothing.
 * Focus moves to the card when it opens, the stop is announced (`aria-live`), the options are a
 * radio group a keyboard reaches, and colour never carries meaning alone.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { TabChoiceNeeded } from '@/engine/cnc/cam/model/plan';
import { loopNearest, loopOf, stretchSpan } from '@/engine/cnc/tabChoiceGeometry';
import {
  COST_INSIDE_MARGIN,
  COST_LONGER_STRETCH,
  NO_PLACE_LINE,
  TAB_AGAIN_LINE,
  TAB_BAR_HEADLINE,
  TAB_BAR_SUB,
  TAB_PAUSED_LINE,
  TAB_QUESTION,
  answeredSummary,
  insideMarginOffered,
  CHANGE_TABS_LINE,
  insideMarginRow,
  longerStretchRow,
  mm,
  severalCuts,
  stretchCountLine,
  stretchNumber,
  type TabChoiceAnswer,
} from './tabChoiceWords';

const AMBER = '#f5a524';
const AMBER_TEXT = '#ffd166';
const BLUE = '#4d8eff';
const GREEN = '#4ade80';
const INK = '#dae2fd';
const MUTED = '#a9b4d0';
const LINE = '#2a3448';

export type TabCardMode = 'ask' | 'collapsed' | 'answered';

export interface TabChoiceCardProps {
  needed: TabChoiceNeeded;
  /** A tab's width along the outline, mm — the job's own tab width. */
  tabWidthMm?: number;
  mode: TabCardMode;
  /** The answer on the job, in `answered` mode. */
  answer?: TabChoiceAnswer | null;
  /** The answer was for a different outline or different tab settings. */
  stale?: boolean;
  /** Phone layout: the primary above Cancel, the card stacked. */
  phone?: boolean;
  onUse(choice: TabChoiceAnswer): void;
  onCancel(): void;
  onChoose(): void;
  onChange(): void;
  /** "Change the tabs myself": the tab settings open beneath the question, the stretches still marked. */
  onChangeTabs(): void;
  /**
   * Whether the job has a control for the tab count and width to go to. A goal job (a mesh to make)
   * has none — its tabs are the planner's own — so option 3 is not offered there.
   */
  canChangeTabs?: boolean;
}

type Focus = TabChoiceAnswer | null;

type NeededSetup = TabChoiceNeeded['setups'][number];

/** One setup's outline to scale, its stretches numbered, and the option in focus drawn over it. */
export function TabChoiceDrawing({
  needed,
  setup,
  tabWidthMm = 4,
  focus,
  width,
}: {
  needed: TabChoiceNeeded;
  setup: NeededSetup;
  tabWidthMm?: number;
  focus: Focus;
  width: number | string;
}): JSX.Element {
  // The stretches and the candidates lie on the cutter's centre path, one tool radius outside the
  // outline: the path is what is measured on, the outline is what is drawn as the part.
  const loops = useMemo(() => setup.path.map((r) => loopOf(r)), [setup]);
  const stretches = needed.stretches.filter((s) => s.setupIndex === setup.setupIndex);
  const all = setup.path.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY);
  const pad = size * 0.24;
  const fs = size * 0.042;
  // Work Y points up; the screen's points down.
  const px = (x: number): number => x - minX;
  const py = (y: number): number => maxY - y;
  const vb = `${-pad} ${-pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;
  const ringPath = (r: readonly (readonly [number, number])[]): string =>
    `M ${r.map((p) => `${px(p[0]).toFixed(2)} ${py(p[1]).toFixed(2)}`).join(' L ')} Z`;
  const pts = (loop: ReturnType<typeof loopOf>, s0: number, s1: number): string => {
    const out: string[] = [];
    for (let s = s0; s <= s1 + 1e-6; s += Math.max(0.5, (s1 - s0) / 400)) {
      const p = loop.at(s);
      out.push(`${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`);
    }
    return out.join(' ');
  };
  const tabMark = (p: { x: number; y: number; ang: number }, w: number, h: number, props: Record<string, string | number>): JSX.Element => (
    <rect
      x={-w / 2}
      y={-h / 2}
      width={w}
      height={h}
      rx={w * 0.12}
      transform={`translate(${px(p.x).toFixed(2)} ${py(p.y).toFixed(2)}) rotate(${((-p.ang * 180) / Math.PI).toFixed(2)})`}
      {...props}
    />
  );
  return (
    <svg
      viewBox={vb}
      width={width}
      role="img"
      aria-label="The part's outline to scale, with the stretches that need a choice numbered"
      data-testid="tab-choice-drawing"
      data-focus={focus ?? 'none'}
    >
      {setup.outline.map((r, i) => (
        <path key={`o${i}`} d={ringPath(r)} fill={i === 0 ? '#101a2e' : '#0b1326'} stroke="#6b7ba3" strokeWidth={fs * 0.22} />
      ))}
      {setup.tabsAt.map((p, i) => {
        const loop = loopNearest(loops, p);
        return <g key={`t${i}`}>{tabMark(loop.at(loop.project(p)), tabWidthMm, fs * 1.5, { fill: GREEN })}</g>;
      })}
      {stretches.map((s) => {
        const loop = loopNearest(loops, s.startXY);
        const { from, to } = stretchSpan(loop, s);
        const mid = loop.at((from + to) / 2);
        const cands = s.candidates;
        return (
          <g key={s.index}>
            {focus === 'insideMargin' && cands.length > 0 ? (
              (() => {
                // The stretch is cut at each candidate; the lengths left are the engine's own.
                const rel = (p: { atXY: readonly [number, number] }): number => (((loop.project(p.atXY) - from) % loop.length) + loop.length) % loop.length;
                const ats = cands.map((c) => ({ s: from + rel(c), c })).sort((x, y) => x.s - y.s);
                const cuts = [from, ...ats.flatMap((t) => [t.s - tabWidthMm / 2, t.s + tabWidthMm / 2]), to];
                const pieces: [number, number][] = [];
                for (let i = 0; i < cuts.length; i += 2) pieces.push([cuts[i]!, cuts[i + 1]!]);
                return (
                  <>
                    {pieces.map(([p0, p1], i) => {
                      const pm = loop.at((p0 + p1) / 2);
                      return (
                        <g key={`p${i}`}>
                          <polyline points={pts(loop, p0, p1)} fill="none" stroke={AMBER} strokeOpacity={0.55} strokeWidth={fs * 0.55} strokeDasharray={`${fs} ${fs * 0.6}`} />
                          {s.leavesSpansMm[i] !== undefined ? (
                            <text x={px(pm.x) + Math.sin(pm.ang) * fs * 2.4} y={py(pm.y) + Math.cos(pm.ang) * fs * 2.4 + fs * 0.35} fill={AMBER_TEXT} fontSize={fs} fontWeight={600} textAnchor="middle">
                              {mm(s.leavesSpansMm[i]!)}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}
                    {ats.map((t, i) => (
                      <g key={`c${i}`}>{tabMark(loop.at(t.s), tabWidthMm + fs * 0.3, fs * 2.2, { fill: BLUE, stroke: '#cfe0ff', strokeWidth: fs * 0.18 })}</g>
                    ))}
                  </>
                );
              })()
            ) : (
              <>
                <polyline points={pts(loop, from, to)} fill="none" stroke={AMBER} strokeWidth={fs * 0.6} />
                {focus === null
                  ? cands.map((c, i) => (
                      <g key={`d${i}`}>{tabMark(loop.at(loop.project(c.atXY)), tabWidthMm, fs * 1.5, { fill: 'none', stroke: BLUE, strokeWidth: fs * 0.14, strokeDasharray: `${fs * 0.4} ${fs * 0.3}` })}</g>
                    ))
                  : null}
              </>
            )}
            <circle cx={px(mid.x) - Math.sin(mid.ang) * fs * 3} cy={py(mid.y) - Math.cos(mid.ang) * fs * 3} r={fs * 1.25} fill={AMBER_TEXT} />
            <text x={px(mid.x) - Math.sin(mid.ang) * fs * 3} y={py(mid.y) - Math.cos(mid.ang) * fs * 3 + fs * 0.45} fill="#0b1326" fontSize={fs * 1.3} fontWeight={800} textAnchor="middle">
              {stretchNumber(s)}
            </text>
            {focus !== 'insideMargin' ? (
              <text x={px(mid.x) - Math.sin(mid.ang) * fs * 7} y={py(mid.y) - Math.cos(mid.ang) * fs * 7 + fs * 0.35} fill={AMBER_TEXT} fontSize={fs} fontWeight={600} textAnchor="middle">
                {mm(s.spanMm)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function Legend({ focus }: { focus: Focus }): JSX.Element {
  const key = (swatch: JSX.Element, words: string): JSX.Element => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} key={words}>
      {swatch}
      {words}
    </span>
  );
  const bar = (bg: string, extra: object = {}): JSX.Element => (
    <span aria-hidden style={{ width: 14, height: 6, borderRadius: 3, display: 'inline-block', background: bg, ...extra }} />
  );
  const common = [
    key(bar(GREEN), 'placed tabs'),
    key(<span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: AMBER_TEXT, display: 'inline-block' }} />, 'numbered stretch with no tab'),
  ];
  const rest =
    focus === 'insideMargin'
      ? [key(bar(BLUE), 'the tab option 1 adds'), key(bar(AMBER, { opacity: 0.5 }), 'the stretches it leaves')]
      : focus === 'longerStretch'
        ? [key(bar(AMBER), 'the full stretch, left as it is')]
        : [key(bar('transparent', { border: `1px dashed ${BLUE}` }), "where option 1's tab would go")];
  return (
    <figcaption style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: MUTED, marginTop: 6 }}>
      {[...common, ...rest]}
    </figcaption>
  );
}

const FOCUS_WORDS: Record<'none' | TabChoiceAnswer, string> = {
  none: 'Nothing chosen yet — the stretches, and where option 1 would put a tab',
  insideMargin: 'Option 1: the tab it adds, and the stretches it leaves',
  longerStretch: 'Option 2: the full stretches, no tab added',
};

const BTN: React.CSSProperties = {
  padding: '9px 16px',
  borderRadius: 8,
  font: 'inherit',
  fontWeight: 600,
  fontSize: 13,
  border: `1px solid ${LINE}`,
  background: 'transparent',
  color: MUTED,
  cursor: 'pointer',
};
const PRIMARY: React.CSSProperties = { ...BTN, background: BLUE, border: `1px solid ${BLUE}`, color: '#00214d' };

/**
 * Whether the card's own box is narrow. The card lives in the Job panel (a few hundred pixels) as
 * often as in a wide page, so its stacked layout follows ITS width, not the window's.
 */
function useNarrow(ref: React.RefObject<HTMLElement | null>, below: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = (): void => setNarrow(el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width < below);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, below]);
  return narrow;
}

export function TabChoiceCard(props: TabChoiceCardProps): JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null);
  const narrow = useNarrow(holder, 640);
  return (
    <div ref={holder} data-testid="tab-choice-holder">
      <TabChoiceCardBody {...props} phone={props.phone === true || narrow} />
    </div>
  );
}

function TabChoiceCardBody(props: TabChoiceCardProps): JSX.Element {
  const { needed, mode, stale = false, phone = false } = props;
  const [picked, setPicked] = useState<TabChoiceAnswer | null>(null);
  const [hover, setHover] = useState<TabChoiceAnswer | null>(null);
  const head = useRef<HTMLHeadingElement | null>(null);
  const offered = insideMarginOffered(needed);
  // Focus moves to the card when the question opens: the operator must see that action is needed.
  useEffect(() => {
    if (mode === 'ask') head.current?.focus();
  }, [mode]);
  if (mode === 'collapsed') {
    return (
      <div
        role="alert"
        data-testid="tab-choice-bar"
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 12, border: '1px solid #7a5a1a', background: '#261c08', color: INK }}
      >
        <span aria-hidden style={{ width: 26, height: 26, borderRadius: '50%', border: `1px solid ${AMBER}`, display: 'grid', placeItems: 'center', color: AMBER, fontWeight: 800 }}>
          !
        </span>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 14, color: '#ffe2a8' }}>{TAB_BAR_HEADLINE}</b>
          <br />
          <span style={{ fontSize: 12, color: MUTED }}>{TAB_BAR_SUB}</span>
        </span>
        <button type="button" style={PRIMARY} onClick={props.onChoose} data-testid="tab-choice-choose">
          Choose…
        </button>
      </div>
    );
  }
  if (mode === 'answered' && props.answer != null) {
    const sum = answeredSummary(props.answer, needed);
    return (
      <div
        data-testid="tab-choice-answered"
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 12, border: '1px solid #2f5a44', background: '#0f2019', color: INK }}
      >
        <span aria-hidden style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid #2f7a4a', display: 'grid', placeItems: 'center', color: GREEN }}>
          ✓
        </span>
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 14 }}>{sum.headline}</b>
          <br />
          <span style={{ fontSize: 12, color: MUTED }}>{sum.detail}</span>
        </span>
        <button type="button" style={BTN} onClick={props.onChange} data-testid="tab-choice-change">
          Change…
        </button>
      </div>
    );
  }
  const focus: Focus = hover ?? picked;
  const optionStyle = (on: boolean): React.CSSProperties => ({
    display: 'grid',
    gridTemplateColumns: '22px 1fr',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 10,
    border: `1px solid ${on ? BLUE : LINE}`,
    background: on ? '#14213a' : '#17203a',
    boxShadow: on ? '0 0 0 2px rgba(77,142,255,.25)' : 'none',
    cursor: 'pointer',
    margin: 0,
  });
  const radio = (value: TabChoiceAnswer, title: string, rows: string[], cost: string): JSX.Element => (
    <label
      key={value}
      style={optionStyle(picked === value)}
      onMouseEnter={() => setHover(value)}
      onMouseLeave={() => setHover(null)}
      data-testid={`tab-choice-option-${value}`}
    >
      {/* The native radio carries the keyboard and the screen reader; the drawn ring and centre carry
          the look, so a picked option rests on more than its border: a filled accent centre against
          an empty ring. */}
      <span style={{ position: 'relative', width: 18, height: 18, marginTop: 2 }}>
        <input
          type="radio"
          name="tab-choice"
          value={value}
          checked={picked === value}
          onChange={() => setPicked(value)}
          onFocus={() => setHover(value)}
          onBlur={() => setHover(null)}
          style={{ position: 'absolute', inset: 0, margin: 0, opacity: 0, cursor: 'pointer' }}
        />
        <span
          aria-hidden
          data-testid={`tab-choice-radio-${value}`}
          data-picked={picked === value}
          style={{
            display: 'block',
            width: 18,
            height: 18,
            boxSizing: 'border-box',
            borderRadius: '50%',
            border: `2px solid ${picked === value ? BLUE : '#7f8aa8'}`,
            background: picked === value ? `radial-gradient(circle at 50% 50%, ${BLUE} 0 5px, transparent 5px)` : 'transparent',
          }}
        />
      </span>
      <span>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: INK, marginBottom: 4 }}>{title}</span>
        {rows.map((r) => (
          <span key={r} style={{ display: 'block', fontSize: 13, lineHeight: 1.45, color: INK }}>
            {r}
          </span>
        ))}
        <span style={{ display: 'block', fontSize: 13, lineHeight: 1.45, color: MUTED, marginTop: 5 }}>
          <b style={{ color: INK }}>What it costs:</b> {cost}
        </span>
      </span>
    </label>
  );
  return (
    <section
      aria-live="assertive"
      data-testid="tab-choice-card"
      style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid #3a5680', background: '#131b2e', color: INK, boxShadow: '0 20px 50px rgba(0,0,0,.45)' }}
    >
      <header style={{ background: BLUE, color: '#f4f8ff', padding: phone ? '14px 14px 12px' : '16px 22px 14px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.18em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: '#ffd166', boxShadow: '0 0 0 4px rgba(255,209,102,.25)' }} />
          Action needed
        </div>
        <h2 ref={head} tabIndex={-1} style={{ margin: '8px 0 0', fontSize: phone ? 18 : 21, fontWeight: 600, lineHeight: 1.3, outline: 'none' }} data-testid="tab-choice-heading">
          {TAB_QUESTION}
        </h2>
        <p style={{ margin: '6px 0 0', fontSize: 13 }} data-testid="tab-choice-count">
          {stretchCountLine(needed.stretches.length)}
          {stale ? <b> {TAB_AGAIN_LINE}</b> : null}
        </p>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : 'minmax(0, 1fr) minmax(0, 1.05fr)', gap: 16, padding: phone ? 12 : '16px 18px 8px' }}>
        <figure style={{ margin: 0, background: '#0d1526', border: `1px solid ${LINE}`, borderRadius: 10, padding: 8, alignSelf: 'start' }}>
          <div style={{ fontSize: 11, color: MUTED, padding: '2px 4px 6px', fontWeight: 600 }}>{FOCUS_WORDS[focus ?? 'none']}</div>
          {needed.setups.map((setup) => (
            <div key={setup.setupIndex}>
              {needed.setups.length > 1 ? (
                <div style={{ fontSize: 11, color: MUTED, padding: '2px 4px' }}>Side {setup.setupIndex + 1}</div>
              ) : null}
              <TabChoiceDrawing needed={needed} setup={setup} tabWidthMm={props.tabWidthMm} focus={focus} width="100%" />
            </div>
          ))}
          <Legend focus={focus} />
        </figure>
        <div role="radiogroup" aria-label="How to hold the part" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!offered ? (
            <p style={{ margin: 0, padding: '8px 10px', fontSize: 13, color: MUTED, border: `1px solid ${LINE}`, borderRadius: 8 }} data-testid="tab-choice-no-place">
              <b style={{ color: AMBER }}>Option 1 is not offered.</b> {NO_PLACE_LINE}
            </p>
          ) : (
            radio('insideMargin', 'Put a tab inside the corner margin', needed.stretches.map((s) => insideMarginRow(s, severalCuts(needed.stretches))), COST_INSIDE_MARGIN)
          )}
          {radio(
            'longerStretch',
            needed.stretches.length === 1 ? 'Leave the longer stretch' : 'Leave the longer stretches',
            needed.stretches.map((s) => longerStretchRow(s, needed.limitMm, severalCuts(needed.stretches))),
            COST_LONGER_STRETCH,
          )}
          {props.canChangeTabs === false ? null : (
            <>
          <div aria-hidden data-testid="tab-choice-or" style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#7f8aa8', fontSize: 10, fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase' }}>
            <span style={{ flex: 1, height: 1, background: LINE }} />
            or
            <span style={{ flex: 1, height: 1, background: LINE }} />
          </div>
          <button
            type="button"
            onClick={props.onChangeTabs}
            data-testid="tab-choice-change-tabs"
            style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: `1px dashed ${LINE}`, background: 'transparent', color: MUTED, font: 'inherit', cursor: 'pointer' }}
          >
            <span style={{ display: 'block', fontSize: 14, fontWeight: 500 }}>Change the tabs myself</span>
            <span style={{ display: 'block', fontSize: 13, lineHeight: 1.45 }}>
              {CHANGE_TABS_LINE}
            </span>
          </button>
            </>
          )}
        </div>
      </div>
      <footer style={{ display: 'flex', flexDirection: phone ? 'column' : 'row', alignItems: phone ? 'stretch' : 'center', gap: phone ? 9 : 12, padding: phone ? '10px 12px 14px' : '10px 18px 14px' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: AMBER, display: 'flex', alignItems: 'center', gap: 7, justifyContent: phone ? 'center' : 'flex-start' }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: AMBER }} />
          {TAB_PAUSED_LINE}
        </span>
        {phone ? null : <span style={{ flex: 1 }} />}
        {/* Phone: Use this choice above Cancel, the first mock-up's order. */}
        {phone ? (
          <>
            <button type="button" style={{ ...PRIMARY, width: '100%', padding: 12, fontSize: 14, opacity: picked === null ? 0.4 : 1 }} disabled={picked === null} onClick={() => picked !== null && props.onUse(picked)} data-testid="tab-choice-use">
              Use this choice
            </button>
            <button type="button" style={BTN} onClick={props.onCancel} data-testid="tab-choice-cancel">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" style={BTN} onClick={props.onCancel} data-testid="tab-choice-cancel">
              Cancel
            </button>
            <button type="button" style={{ ...PRIMARY, opacity: picked === null ? 0.4 : 1 }} disabled={picked === null} onClick={() => picked !== null && props.onUse(picked)} data-testid="tab-choice-use">
              Use this choice
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
