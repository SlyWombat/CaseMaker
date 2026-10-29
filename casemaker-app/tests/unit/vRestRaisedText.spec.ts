/**
 * #765 (engine half) — A V-BIT AS THE REST CUTTER FOR RAISED TEXT.
 *
 * The flat rough opens the cutaway everywhere its disc can enter; the narrowest pinches between
 * the standing letters stay as slivers. #486 refused a V as a rest cutter on a region job — right
 * for an area rest pass, wrong here: the cone's flank is exactly what clears a sliver, and the
 * pick measures how much of the letters' edge it takes (0.018 mm a side on the coin's 0.278 mm
 * pinch, inside the 0.03 mm tolerance). This suite pins the posting:
 *
 *   - the coin's ⌀2 + 0.1 mm 30° V plan generates TWO programs, the second cut by the V;
 *   - the V rest program was measured, verified and simulated (from the blank, with the fact
 *     stated — the column engine cannot seed a rest pass);
 *   - an ordinary region job still gets #486's sentence, so the exemption is the raised-text shape
 *     and nothing wider.
 */
import { describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { hasRaisedTextCutaway, vBitRestRefusal } from '@/engine/cnc/engrave/restPass';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { FEEDS_TABLE, type FeedsEntry } from '@/engine/cnc/feeds';

/** The demo's 0.1 mm 30° engraver, verbatim (demo5's catalogue). */
const V: Tool = {
  number: 2,
  id: '121011013830',
  name: '3.175*0.1mm*30º Engraving',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.1,
  diameter: 3.175,
  cornerRadius: 0,
  angle: null,
  halfAngle: 15,
  fluteLength: 5,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
};
const O2 = flatEndMill(2, { id: 'inv:o-flute-2', number: 1, name: '2 mm O-flute', fluteLength: 12, shoulderLength: 20 });
const O2_KEY = 'inv:o-flute-2';
const V_KEY = 'cat:121011013830';
const V_ENTRY: ToolLibraryEntry = { key: V_KEY, tool: V, provenance: 'test fixture' };
const O2_ENTRY: ToolLibraryEntry = { key: O2_KEY, tool: O2, provenance: 'test fixture' };
/**
 * The HOUSE feed table's row for the 0.1 mm engraver — what the location carries for a cutter the
 * starting table's 0.3–0.5 mm V row cannot serve. The compiled table refuses a 0.1 mm tip in PLA
 * (a V row exists, out of band), so the house row is the one that answers, exactly as it does in
 * the app when the bench's own table is loaded.
 */
const V_FEEDS: FeedsEntry = {
  material: 'pla',
  edge: 'v',
  minDiameter: 0.05,
  maxDiameter: 0.2,
  params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.4, stepOverFraction: 0.5, peckFraction: 1, air: true },
  status: 'unmeasured',
  provenance: 'test fixture: the 0.1 mm 30° engraver on PLA',
};

/** The coin's raised-text cutaway: a ⌀26 field cleared around the construction labels. */
function coinJob(raised: boolean): EngraveJob {
  const construction = raised ? { construction: true as const } : {};
  return {
    ...defaultEngraveJob(),
    name: 'j04 coin',
    stock: { length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 },
    labels: [
      { id: 'cnx', text: 'CNX', font: DEFAULT_FONT_ID, weight: 'bold', size: 7, position: { x: 15, y: 18.5 }, rotation: 0, depth: 0.4, enabled: true, ...construction },
      { id: 'software', text: 'Software', font: DEFAULT_FONT_ID, weight: 'bold', size: 3.6, position: { x: 15, y: 10.5 }, rotation: 0, depth: 0.4, enabled: true, ...construction },
    ],
    shapes: [
      { id: 'field', kind: 'circle', position: { x: 15, y: 15 }, rotation: 0, depth: 0.4, enabled: true, diameter: 26, construction: true },
    ],
    combined: [
      { id: 'clear', kind: 'cutaway', position: { x: 15, y: 15 }, rotation: 0, depth: 0.4, enabled: true, outer: 'field', islands: ['cnx', 'software'] },
    ],
    toolKey: '',
    setups: undefined,
    targetObject: undefined,
    workholding: { kind: 'vise', vise: { stockProud: 1.5, seat: 'ledge', fixedJawThickness: 10, movingJawThickness: 10, jawLength: 100, jawStartY: -10, source: 'default', uncertainty: 0.5 } },
    jawClearance: 1,
    breakthrough: 0.3,
    edgeMargin: 1,
    minFloor: 1,
  };
}

/** ⌀2 owns the cutaway; the V rests over the leftovers — the plan #765's pick offers. */
function withPlan(job: EngraveJob): EngraveJob {
  const setup = jobSetups(job)[0]!;
  return {
    ...job,
    toolKey: O2_KEY,
    setups: [{ ...setup, tools: [O2_KEY, V_KEY], toolItems: { [O2_KEY]: ['clear'], [V_KEY]: [] } }],
  };
}

describe('#765 — a V-bit takes the raised-text rest', () => {

  it('the shape is the #739 cutaway, and the rest rule reads it', () => {
    expect(hasRaisedTextCutaway(coinJob(true))).toBe(true);
    expect(hasRaisedTextCutaway(coinJob(false))).toBe(false);
    expect(vBitRestRefusal(coinJob(true), V)).toBeNull();
    // An ordinary region job keeps #486's sentence.
    expect(vBitRestRefusal(coinJob(false), V)).toMatch(/V-bit is not a rest cutter/);
  });

  it('the coin’s ⌀2 + 0.1 mm V plan posts two programs, the second cut by the V', () => {
    const job = withPlan(coinJob(true));
    const gen = engraveGenerate(tl, job, O2, [], null, undefined, { tools: [O2_ENTRY, V_ENTRY], feeds: [...FEEDS_TABLE, V_FEEDS] });
    expect(gen.errors).toEqual([]);
    expect(gen.ok).toBe(true);
    expect(gen.programs).toHaveLength(2);
    const rest = gen.programs[1]!;
    expect(rest.toolKey).toBe(V_KEY);
    expect(rest.cam?.cuttingMoves ?? 0).toBeGreaterThan(0);
    // The rest program was verified by the same verifier every program goes through.
    expect(rest.verify).not.toBeNull();
    expect(rest.verify!.ok).toBe(true);
    // Its simulation could not be seeded by the column engine; the fact is stated, not hidden.
    expect(gen.findings.some((f) => f.code === 'rest-swept-from-blank' && f.severity === 'info')).toBe(true);
    // And the #486 refusal is nowhere in the run's findings.
    expect(gen.findings.some((f) => f.severity === 'error' && /V-bit is not a rest cutter/.test(f.message))).toBe(false);
  });

  it('without raised text the same rest is refused with #486’s sentence', () => {
    // A plain region job — one dish cut by the flat, the V named as its rest. There is no
    // raised text for the V to open, so #486's rule stands and the run stops with its sentence.
    const base: EngraveJob = {
      ...defaultEngraveJob(),
      name: 'plain dish',
      stock: { length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 },
      labels: [],
      shapes: [{ id: 'dish', kind: 'circle', position: { x: 15, y: 15 }, rotation: 0, depth: 0.4, enabled: true, diameter: 20 }],
      combined: [],
      toolKey: '',
      setups: undefined,
      targetObject: undefined,
      workholding: { kind: 'vise', vise: { stockProud: 1.5, seat: 'ledge', fixedJawThickness: 10, movingJawThickness: 10, jawLength: 100, jawStartY: -10, source: 'default', uncertainty: 0.5 } },
      jawClearance: 1,
      breakthrough: 0.3,
      edgeMargin: 1,
      minFloor: 1,
    };
    const setup = jobSetups(base)[0]!;
    const job: EngraveJob = {
      ...base,
      toolKey: O2_KEY,
      setups: [{ ...setup, tools: [O2_KEY, V_KEY], toolItems: { [O2_KEY]: ['dish'], [V_KEY]: [] } }],
    };
    const gen = engraveGenerate(tl, job, O2, [], null, undefined, { tools: [O2_ENTRY, V_ENTRY], feeds: [...FEEDS_TABLE, V_FEEDS] });
    expect(gen.ok).toBe(false);
    expect(gen.findings.some((f) => /V-bit is not a rest cutter/.test(f.message))).toBe(true);
  });
});
