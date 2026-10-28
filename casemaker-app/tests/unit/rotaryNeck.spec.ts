/**
 * #737 — THE NECK FOR PARTING, through the generator, the verifier and the run sheet.
 *
 * The fixture is the rotary design's own (#240 W, `rotary-flow.md` §3.6, §3.11): a PLA rod
 * ⌀20 × 100 in the chuck, 85 mm out, tailstock in, one "Zoomba" engrave, a ⌀1 mm flat end. Its
 * free span is X 3–75 mm. The DEFAULT neck is on the CHUCK side — the stock goes into the jaws
 * there, so the saw frees the whole part rather than only the scrap stub — and runs X 3–8 mm, saw
 * at X 5.5 mm, floor at r 6.5 mm (⌀7 mm). The strength check measures the cantilever to the
 * neck's ROOT (X 3), so the default's effective length is 41 mm and PLA asks ⌀5.18 mm: the ⌀7 mm
 * default is not silently refused. A tailstock-side neck (X 70–75, saw 72.5, ⌀4) is still
 * available and is used where the test is about that end.
 *
 * Codes are data: every refusal is asserted on the operator's sentence with its numbers and
 * units. The neck's operation is asserted where the machine reads it — in the posted `.nc`.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { defaultEngraveJob, newEngraveLabelId } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { createSimSession } from '@/workers/sim/session';
import { engraveGenerate, type EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { flatEndMill } from '@/engine/cnc/tool';
import { type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { rotaryFreeSpan, rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import {
  ROTARY_NECK_DIAMETER_MM,
  ROTARY_NECK_MIN_LENGTH_MM,
  defaultRotaryNeck,
  neckCarriedBy,
  rotaryNeckFacts,
  rotaryNeckMinDiameterMm,
  rotaryNeckSpan,
} from '@/engine/cnc/rotary/neck';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveShape, JobSetup, RotaryChuck, RotaryNeck } from '@/types/engraveJob';

const CHUCK: RotaryChuck = {
  stickout: 85,
  gripDiameter: null,
  jawMode: 'reverse-inner',
  tailstock: true,
  source: 'test',
};

/** The design's starter, with a neck when one is asked for. */
function dowel(neck: RotaryNeck | null = defaultRotaryNeck(), over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'Zoomba on a dowel',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: neck === null ? { ...CHUCK } : { ...CHUCK, neck: { ...neck } },
    },
    labels: [
      {
        id: newEngraveLabelId(),
        text: 'Zoomba',
        font: DEFAULT_FONT_ID,
        weight: 'bold',
        size: 5,
        position: { x: 42.5, y: Math.PI * 10 }, // centred at 180°
        rotation: 0,
        depth: 0.5,
        enabled: true,
      },
    ],
    shapes: [],
    toolKey: 'flat-1.0',
    ...over,
  };
}

interface CutLine {
  x: number | null;
  z: number | null;
  a: number | null;
}

/** Every cutting line (G1 with the spindle on), with the modal words it carries. */
function cuttingLines(nc: string): CutLine[] {
  const out: CutLine[] = [];
  let feed = false;
  let spindle = false;
  let x: number | null = null;
  let z: number | null = null;
  let a: number | null = null;
  for (const raw of nc.split('\n')) {
    const line = raw.trim();
    if (line === '' || line === '%' || line.startsWith(';')) continue;
    const words = line.toUpperCase().match(/[A-Z][-+]?\d*\.?\d*/g) ?? [];
    for (const w of words) {
      if (w === 'G0' || w === 'G00') feed = false;
      else if (w === 'G1' || w === 'G01') feed = true;
      else if (w === 'M3') spindle = true;
      else if (w === 'M5') spindle = false;
    }
    const xw = words.find((w) => w.startsWith('X'));
    const zw = words.find((w) => w.startsWith('Z'));
    const aw = words.find((w) => w.startsWith('A'));
    if (xw !== undefined) x = Number(xw.slice(1));
    if (zw !== undefined) z = Number(zw.slice(1));
    if (aw !== undefined) a = Number(aw.slice(1));
    if (feed && spindle) out.push({ x, z, a });
  }
  return out;
}

function gen(job: EngraveJob): EngraveGenerated {
  return generate(tl, job);
}

const IDENTITY = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  front: 'front',
  back: 'back',
} as const;

/** One setup with the given cutters, in use order, and the items it cuts. */
function setup(tools: string[], itemIds: string[]): JobSetup {
  return { id: 'setup-1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools };
}

/** A small second item, so a test can put an engrave where the neck runs. */
function labelAt(text: string, x: number): EngraveJob['labels'][number] {
  return {
    id: newEngraveLabelId(),
    text,
    font: DEFAULT_FONT_ID,
    weight: 'bold',
    size: 5,
    position: { x, y: Math.PI * 10 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
  };
}

describe('#737 — the neck setting and its geometry', () => {
  it('offers the labelled defaults: chuck side, ⌀7 mm, 5 mm long', () => {
    // The stock goes into the jaws at the chuck side, so the saw there frees the whole part. ⌀7 mm
    // is the thinnest round default that clears the corrected root-length check for PLA, softwood
    // and metal on the design's ⌀20 × 85 mm stick-out.
    expect(defaultRotaryNeck()).toEqual({ end: 'chuck', diameter: 7, length: 5 });
    expect(ROTARY_NECK_DIAMETER_MM).toBe(7);
    // The shortest sawable neck: 0.5 mm kerf plus 1 mm clear either side.
    expect(ROTARY_NECK_MIN_LENGTH_MM).toBe(2.5);
  });

  it('places the neck at the free span’s ends, and its saw line at the neck’s middle', () => {
    const map = rotaryMapOf(dowel())!;
    expect(rotaryFreeSpan(map)).toEqual({ from: 3, to: 75, centre: 39 });
    const tail = rotaryNeckSpan(map, { end: 'tailstock', diameter: 4, length: 5 })!;
    expect(tail.fromMm).toBe(70);
    expect(tail.toMm).toBe(75);
    expect(tail.sawAtMm).toBe(72.5);
    expect(tail.depthMm).toBe(8); // R 10 − ⌀4/2
    // The root is the neck's chuck-side edge, X 70 — not the saw line. The piece the check treats
    // as carried runs from that root to the free end (X 85): 15 mm. With the tailstock centre
    // holding its far end the check counts half of it, where the bending is shared.
    expect(tail.carriedMm).toBe(15);
    expect(tail.effectiveMm).toBe(7.5);

    const chuck = rotaryNeckSpan(map, { end: 'chuck', diameter: 4, length: 5 })!;
    expect([chuck.fromMm, chuck.toMm, chuck.sawAtMm]).toEqual([3, 8, 5.5]);
    // The root is the jaws' edge, X 3: 82 mm to the free end.
    expect(chuck.carriedMm).toBe(82);
    expect(chuck.effectiveMm).toBe(41);
  });

  it('reads the neck the RUN leaves from its programs, not from the job', () => {
    const facts = rotaryNeckFacts(dowel())!;
    expect(neckCarriedBy(undefined)).toBeNull();
    expect(neckCarriedBy([])).toBeNull();
    expect(neckCarriedBy([{ neck: null }, { neck: null }])).toBeNull();
    // A dropped rest program leaves the earlier program's null: the job still names a neck, but
    // the run does not. The last program that does carry it is the run's.
    expect(neckCarriedBy([{ neck: null }, { neck: facts }])).toEqual(facts);
  });

  it('computes the safe minimum from the material and the effective cantilever, as a labelled default', () => {
    // d = cbrt(32·F·L / (π·σ)) with F = 10 N, L in metres, σ in Pa; 7.5 mm is the tailstock-side
    // neck's effective length (15 mm from the root, halved with the tailstock engaged).
    const pla = rotaryNeckMinDiameterMm('pla', 7.5);
    expect(pla.group).toBe('plastic');
    expect(pla.stressMpa).toBe(30);
    expect(pla.diameterMm).toBeCloseTo(2.942, 3);

    const softwood = rotaryNeckMinDiameterMm('softwood', 7.5);
    expect(softwood.diameterMm).toBeCloseTo(3.707, 3);
    const metal = rotaryNeckMinDiameterMm('aluminium-6061', 7.5);
    expect(metal.group).toBe('metal');
    expect(metal.diameterMm).toBeCloseTo(1.9695, 3);
    // Stronger stock needs a thinner neck, for the same carried piece.
    expect(metal.diameterMm).toBeLessThan(pla.diameterMm);
    expect(softwood.diameterMm).toBeGreaterThan(pla.diameterMm);
  });

  it('measures the default chuck-side neck from its root, and the default clears the minimum', () => {
    // The default's root is X 3, 82 mm from the free end. The tailstock shares the bending, so the
    // check counts 41 mm; PLA asks ⌀5.18 mm, softwood ⌀6.53 mm and metal ⌀3.47 mm, and the ⌀7 mm
    // default clears all three. This is why the default is 7 mm and not the 4 mm of a shorter end.
    const facts = rotaryNeckFacts(dowel())!;
    expect(facts).toMatchObject({ end: 'chuck', fromMm: 3, toMm: 8, sawAtMm: 5.5, diameterMm: 7 });
    expect(facts.carriedMm).toBe(82);
    expect(facts.effectiveMm).toBe(41);
    expect(rotaryNeckMinDiameterMm('pla', facts.effectiveMm).diameterMm).toBeCloseTo(5.183, 3);
    expect(rotaryNeckMinDiameterMm('softwood', facts.effectiveMm).diameterMm).toBeCloseTo(6.53, 2);
    expect(rotaryNeckMinDiameterMm('aluminium-6061', facts.effectiveMm).diameterMm).toBeCloseTo(3.47, 2);
    expect(rotaryNeckMinDiameterMm('softwood', facts.effectiveMm).diameterMm).toBeLessThan(
      ROTARY_NECK_DIAMETER_MM,
    );
  });

  it('keeps an old document without a neck byte-for-byte, and parses one that has it', () => {
    const legacy = dowel(null);
    const parsedLegacy = parseEngraveJob(legacy);
    expect(parsedLegacy.ok).toBe(true);
    if (!parsedLegacy.ok) return;
    expect(parsedLegacy.job.workholding.kind).toBe('rotary-chuck');
    if (parsedLegacy.job.workholding.kind !== 'rotary-chuck') return;
    expect('neck' in parsedLegacy.job.workholding.rotary).toBe(false);

    const parsedNeck = parseEngraveJob(dowel());
    expect(parsedNeck.ok).toBe(true);
    if (!parsedNeck.ok || parsedNeck.job.workholding.kind !== 'rotary-chuck') return;
    expect(parsedNeck.job.workholding.rotary.neck).toEqual({ end: 'chuck', diameter: 7, length: 5 });
  });

  it('refuses a neck with no diameter or no length at the document gate', () => {
    const bad = dowel({ end: 'tailstock', diameter: 0, length: 5 });
    expect(parseEngraveJob(bad).ok).toBe(false);
    const short = dowel({ end: 'tailstock', diameter: 4, length: 0 });
    expect(parseEngraveJob(short).ok).toBe(false);
  });
});

describe('#737 — the neck is the program’s last operation, all the way round', () => {
  it('appends one neck operation after the engrave, with the same ⌀1 mm flat', () => {
    const job = dowel();
    const g = gen(job);
    expect(g.ok, JSON.stringify(g.findings.filter((f) => f.severity === 'error'))).toBe(true);
    expect(g.nc).not.toBeNull();

    // The IR holds two operations: the engrave, then the neck. The rotary post writes no
    // `;@MKR|TOOLPATH` header (its provenance is `;@CM|`), so the count is read off the CAM
    // summary the program carries.
    expect(g.cam?.operations).toBe(2);
    expect(g.programs).toHaveLength(1);
    expect(g.programs[0]!.cam?.operations).toBe(2);
    // The same cutter cut the part: one tool in the file.
    expect(g.programs[0]!.toolKey).toBe('flat-1.0');
  });

  it('cuts the neck to its floor at Z 2 mm, full circumference, and ends on it', () => {
    // The tailstock-side neck is explicit here: its floor is below the default's, so the geometry
    // is unambiguous. It is still a neck the corrected root check allows (⌀4 against ⌀2.94).
    const g = gen(dowel({ end: 'tailstock', diameter: 4, length: 5 }));
    expect(g.ok).toBe(true);
    const cuts = cuttingLines(g.nc ?? '');
    // The engrave is at r 9.5; the neck's floor is r 2 (⌀4 mm on a ⌀20 rod).
    const neck = cuts.filter((c) => c.z !== null && Math.abs(c.z - 2) < 1e-6);
    expect(neck.length).toBeGreaterThan(0);

    // The outer and inner rings wrap the whole circumference: a seam left uncut would show as an
    // A range short of 360°.
    const a = neck.map((c) => c.a).filter((v): v is number => v !== null);
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThanOrEqual(359.9);

    // The tool centre stays inside the neck's span, a radius in from each edge and the seam.
    const x = neck.map((c) => c.x).filter((v): v is number => v !== null);
    expect(Math.min(...x)).toBeGreaterThanOrEqual(70.5 - 1e-6);
    expect(Math.max(...x)).toBeLessThanOrEqual(74.5 + 1e-6);

    // The program's LAST cutting line is the neck's floor: every finish pass came before it.
    const last = cuts[cuts.length - 1]!;
    expect(last.z).toBeCloseTo(2, 6);
  });

  it('leaves the neck facts on the program, with the span the findings judged', () => {
    const job = dowel({ end: 'tailstock', diameter: 4, length: 5 });
    const g = gen(job);
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(1);
    const facts = g.programs[0]!.neck;
    expect(facts).not.toBeNull();
    expect(facts).toMatchObject({ end: 'tailstock', diameterMm: 4, lengthMm: 5, fromMm: 70, toMm: 75, sawAtMm: 72.5 });
    // The generator's facts and the job's are the same object shape, from one span.
    expect(rotaryNeckFacts(job)).toMatchObject(facts!);
  });

  it('cuts nothing extra when the neck is off', () => {
    const g = gen(dowel(null));
    expect(g.ok).toBe(true);
    expect(g.cam?.operations).toBe(1);
    expect(g.programs[0]!.cam?.operations).toBe(1);
    expect(g.programs[0]!.neck ?? null).toBeNull();
    // No level at the neck's floor: the program only has the engrave's.
    const depths = (g.predicted ?? []).map((p) => p.depth);
    expect(depths).toEqual([0.5]);
  });

  it('simulates the neck with no under- or over-cut at its floor', () => {
    const job = dowel({ end: 'tailstock', diameter: 4, length: 5 });
    const g = gen(job);
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    const session = createSimSession(tl);
    try {
      const r = session.load(g.nc ?? '', toSetup(job, Z1), tool!, Z1.id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const report = session.oracle(g.predicted);
      expect(report.ok).toBe(true);
      const levels = [...report.levels].sort((p, q) => q.z - p.z);
      expect(levels).toHaveLength(2);
      expect(levels[0]!.z).toBeCloseTo(-0.5, 6);
      expect(levels[1]!.z).toBeCloseTo(-8, 6);
      for (const level of levels) {
        expect(level.underCut, `level ${level.z}`).toBe(0);
        expect(level.overCut, `level ${level.z}`).toBe(0);
      }
    } finally {
      session.dispose();
    }
  });

  it('refuses a neck a V-bit cannot leave — the last program must cut it with the part’s cutter', () => {
    // A V-bit posts the engrave but leaves a GROOVE where the neck needs a flat floor: the run is
    // refused before a file exists, rather than quietly omitting the neck.
    const vBit = flatEndMill(0.3, {
      name: '30° engraving bit',
      typeText: 'Engraving',
      shape: 'engraving',
      tipDiameter: 0.3,
      halfAngle: 15,
      angle: 30,
    });
    const g = engraveGenerate(tl, dowel(), vBit, [], null);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.find((x) => x.code === 'neck-not-cut');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toContain('The neck for parting is set, but');
    expect(f!.message).toContain('"30° engraving bit" is a V-bit');
    expect(f!.message).toContain('not the flat floor a saw needs');
    expect(f!.message).toContain('Use a flat end mill for the part, or turn the neck off');
    expect(f!.message).not.toContain('neck-not-cut');
  });
});

describe('#737 — the run sheet says where to saw', () => {
  it('ends the Cut section with the saw line, naming the neck’s size', () => {
    const job = dowel({ end: 'tailstock', diameter: 4, length: 5 });
    const g = gen(job);
    expect(g.ok).toBe(true);
    const sheet = buildRunSheet(job, g, null);
    const cut = sheet.sections.find((s) => s.id === 'cut');
    expect(cut).toBeDefined();
    const last = cut!.steps[cut!.steps.length - 1]!;
    expect(last.text).toMatch(/^Saw the part off at X 72\.5 mm \(the neck\)/);
    expect(last.text).toContain('⌀4 mm');
    expect(last.text).toContain('5 mm long');
    expect(last.value).toBe('⌀4 × 5 mm neck');
  });

  it('puts the saw step in the last program’s own section, not program 1’s', () => {
    // Two setups, one item each. Only the run's last program is asked to leave the neck, so the
    // saw step must sit at the end of the SECOND Cut section — program 1 ends with its engrave.
    const first = dowel();
    const second = {
      ...first.labels[0]!,
      id: newEngraveLabelId(),
      position: { x: 55, y: Math.PI * 10 },
    };
    const itemA = first.labels[0]!.id;
    const job: EngraveJob = {
      ...first,
      labels: [first.labels[0]!, second],
      setups: [
        setup([first.toolKey], [itemA]),
        { ...setup([first.toolKey], [second.id]), id: 'setup-2' },
      ],
    };
    const g = generate(tl, job);
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, findings: g.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    expect(g.programs).toHaveLength(2);
    expect(g.programs[0]!.neck ?? null).toBeNull();
    expect(g.programs[1]!.neck).not.toBeNull();

    const sheet = buildRunSheet(job, g, null);
    const cut1 = sheet.sections.find((s) => s.id === 'cut')!;
    const cut2 = sheet.sections.find((s) => s.id === 'cut-2')!;
    expect(cut1.steps.some((step) => /Saw the part off/.test(step.text))).toBe(false);
    const last = cut2.steps[cut2.steps.length - 1]!;
    expect(last.text).toMatch(/^Saw the part off at X 5\.5 mm \(the neck\)/);
    expect(last.text).toContain('⌀7 mm');
  });

  it('says nothing about a saw when the job has no neck', () => {
    const job = dowel(null);
    const g = gen(job);
    expect(g.ok).toBe(true);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    expect(texts.some((t) => /Saw the part off/.test(t))).toBe(false);
  });

  it('builds the coverage warning from the generated programs, not from the job', () => {
    // The job still names a neck, but no generated program carries one (the dropped rest program
    // of the first case above). The sheet must not claim the part is left on a neck it never cut.
    const job = dowel();
    const g = gen(job);
    expect(g.ok).toBe(true);
    const withNeck = buildRunSheet(job, g, { diagnostics: [] });
    const withTexts = withNeck.sections.flatMap((s) => s.steps.map((st) => st.text));
    expect(withTexts.some((t) => t.includes('The part stays on a'))).toBe(true);

    const noNeckPrograms = g.programs.map((program) => ({ ...program, neck: null }));
    const stripped = { ...g, programs: noNeckPrograms, neck: null };
    const sheet = buildRunSheet(job, stripped, { diagnostics: [] });
    const texts = sheet.sections.flatMap((s) => s.steps.map((st) => st.text));
    expect(texts.some((t) => t.includes('The part stays on a'))).toBe(false);
    expect(texts.some((t) => /Saw the part off/.test(t))).toBe(false);
  });
});

// ---- The refusals ---------------------------------------------------------------

/**
 * The neck's four wrong states, each refused at the FINDINGS stage — before a toolpath exists —
 * in the operator's own words. `rotaryJobFindings` is the one owner: the generator calls it, so a
 * refusal here is a run that never posts. Every sentence carries its numbers and units, and none
 * of them says the internal code.
 */
describe('#737 — a neck that cannot hold the part is refused in words', () => {
  /** The finding, checked to be an error at the neck's own row with no code in its text. */
  function neckError(job: EngraveJob, code: string) {
    const g = gen(job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.find((x) => x.code === code);
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('rotary-neck');
    expect(f!.message).not.toContain(code);
    expect(f!.message).not.toContain('rotary-neck');
    return f!;
  }

  it('refuses a neck thinner than the carried piece calls for — as a labelled default', () => {
    // Chuck-side ⌀2 mm: the root is X 3, so the piece the check treats as carried runs 82 mm to
    // the free end. The tailstock centre holds its far end, so the check counts half of it, 41 mm,
    // where PLA's default minimum is ⌀5.18 mm (10 N side load, 30 MPa allowable bending stress).
    const f = neckError(dowel({ end: 'chuck', diameter: 2, length: 5 }), 'neck-thin');
    expect(f.message).toContain('The neck for parting is too thin');
    expect(f.message).toContain('the neck is ⌀2 mm');
    expect(f.message).toContain('PLA with the whole part beyond the neck runs 82 mm');
    expect(f.message).toContain('from the neck’s root at X 3 mm to the free end');
    expect(f.message).toContain('held at both ends — by the neck and the tailstock centre');
    expect(f.message).toContain('the bending is shared and the check counts half of it (41 mm)');
    expect(f.message).toContain('so it needs at least ⌀5.18 mm');
    expect(f.message).toContain('The 10 N load acts sideways at the free end of that piece');
    expect(f.message).toContain('30 MPa is the allowable bending stress for plastic');
    expect(f.message).toContain("Those numbers are Case Maker's defaults, not measurements");
    expect(f.message).toContain('the neck is cut last, with the part still held');
    expect(f.message).toContain('the minimum is a guess until it is checked on the machine');
    expect(f.message).not.toContain('(#238)');
    expect(f.message).toContain('Make the neck thicker, shorten the part, or choose a stronger stock');
  });

  it('judges the carried piece as a cantilever when the tailstock is out', () => {
    // Tailstock out and the neck at the free end: the root is X 80, so the piece runs 5 mm to the
    // free end, and nothing holds its far end, so the check counts all of it. A ⌀1 mm neck is
    // refused against PLA's 2.57 mm minimum.
    const job = dowel(
      { end: 'tailstock', diameter: 1, length: 5 },
      {
        workholding: {
          kind: 'rotary-chuck',
          rotary: { ...CHUCK, tailstock: false, neck: { end: 'tailstock', diameter: 1, length: 5 } },
        },
      },
    );
    const f = neckError(job, 'neck-thin');
    expect(f.message).toContain('the stub beyond the neck runs 5 mm');
    expect(f.message).toContain('from the neck’s root at X 80 mm to the free end and hangs free');
    expect(f.message).toContain('the check counts all of it (5 mm)');
    expect(f.message).toContain('needs at least ⌀2.57 mm');
  });

  it('measures the cantilever to the root, not the saw line — the reviewer’s 20 mm example', () => {
    // Tailstock out, a 20 mm neck at the free end (X 65–85), so the saw is at X 75. The old
    // saw-line model used 10 mm and accepted ⌀3.5 mm; the root model uses 20 mm and requires
    // ⌀4.08 mm for PLA.
    const neck: RotaryNeck = { end: 'tailstock', diameter: 3.5, length: 20 };
    const job = dowel(neck, {
      workholding: { kind: 'rotary-chuck', rotary: { ...CHUCK, tailstock: false, neck } },
    });
    const facts = rotaryNeckFacts(job)!;
    expect([facts.fromMm, facts.toMm, facts.sawAtMm]).toEqual([65, 85, 75]);
    expect(facts.carriedMm).toBe(20);
    expect(facts.effectiveMm).toBe(20);
    expect(rotaryNeckMinDiameterMm('pla', facts.effectiveMm).diameterMm).toBeCloseTo(4.08, 2);
    const f = neckError(job, 'neck-thin');
    expect(f.message).toContain('runs 20 mm from the neck’s root at X 65 mm');
    expect(f.message).toContain('needs at least ⌀4.08 mm');
  });

  it('allows the default neck the panel offers', () => {
    // The default ⌀7 mm at the chuck side is allowed: the root is X 3, the piece runs 82 mm, the
    // tailstock centre shares the bending so the check counts 41 mm, and PLA's minimum there is
    // ⌀5.18 mm. This is the default the panel offers, so it must not refuse.
    const g = gen(dowel());
    expect(g.ok).toBe(true);
  });

  it('refuses a neck shorter than the saw can cut off cleanly', () => {
    const f = neckError(dowel({ end: 'tailstock', diameter: 4, length: 1 }), 'neck-too-short');
    expect(f.message).toContain('The neck for parting is too short');
    expect(f.message).toContain('the neck is 1 mm long');
    expect(f.message).toContain('a saw needs at least 2.5 mm');
    expect(f.message).toContain('0.5 mm of kerf');
    expect(f.message).toContain('1 mm clear either side');
  });

  it('refuses a neck in the jaws’ keep-out — a tailstock-side neck longer than the free span', () => {
    // The free span is X 3–75 mm; an 80 mm neck from the tailstock side reaches X −5 mm.
    const f = neckError(dowel({ end: 'tailstock', diameter: 4, length: 80 }), 'neck-in-band');
    expect(f.message).toContain('The neck for parting runs into the jaws');
    expect(f.message).toContain('it reaches X -5 mm');
    expect(f.message).toContain('inside the first 3 mm of the stick-out');
    expect(f.message).toContain("where the chuck's jaws are");
  });

  it('refuses a neck in the tailstock’s band — a chuck-side neck past the free span', () => {
    // A 80 mm neck from the jaws' line reaches X 83 mm, inside the tailstock's X 75–85 mm band.
    const f = neckError(dowel({ end: 'chuck', diameter: 4, length: 80 }), 'neck-in-band');
    expect(f.message).toContain("The neck for parting runs into the tailstock's band");
    expect(f.message).toContain('it reaches X 83 mm');
    expect(f.message).toContain('the tailstock holds the last 10 mm of the stick-out');
    expect(f.message).toContain('X 75–85 mm');
  });

  it('refuses a neck as wide as the part — the cutter could not cut it down all the way round', () => {
    const f = neckError(dowel({ end: 'tailstock', diameter: 20, length: 5 }), 'neck-wider-than-part');
    expect(f.message).toContain('The neck for parting is wrong');
    expect(f.message).toContain('the neck is ⌀20 mm');
    expect(f.message).toContain('the part at that end is ⌀20 mm');
    expect(f.message).toContain('a neck has to be narrower than the part it holds');
    expect(f.message).toContain('all the way round');
  });

  it('refuses a neck strictly wider than the part too', () => {
    const f = neckError(dowel({ end: 'tailstock', diameter: 21, length: 5 }), 'neck-wider-than-part');
    expect(f.message).toContain('the neck is ⌀21 mm');
    expect(f.message).toContain('the part at that end is ⌀20 mm');
    expect(f.message).toContain('a neck has to be narrower than the part it holds');
  });

  it('refuses a neck that would cut through an item on the part', () => {
    // A tailstock-side neck X 70–75 runs straight through an engrave at X 72. The neck is the
    // operator's chosen cut, but it must not erase a design item: the refusal names the item, its
    // X extent, and the neck's.
    const base = dowel({ end: 'tailstock', diameter: 4, length: 5 });
    const atNeck = labelAt('M', 72);
    const job = {
      ...base,
      labels: [base.labels[0]!, atNeck],
      setups: [setup([base.toolKey], [base.labels[0]!.id, atNeck.id])],
    };
    const f = neckError(job, 'neck-cuts-item');
    expect(f.message).toContain('The neck for parting is wrong');
    expect(f.message).toContain('Engrave text "M"');
    expect(f.message).toContain('the neck runs X 70–75 mm');
    expect(f.message).toContain('reaches X');
    expect(f.message).toContain('would cut through it');
    expect(f.message).toContain('Move the item clear of the neck, or shorten or move the neck');
  });

  it('refuses a neck no longer than the cutter is wide, in its own words', () => {
    // A ⌀6 mm flat is as wide as the 5 mm neck. The pocket cannot be opened by a tool that does
    // not fit between the neck's edges, so the neck would be cut away rather than left as a floor.
    const pocket: EngraveShape = {
      id: 'pocket-1',
      name: 'pocket',
      kind: 'rect',
      position: { x: 40, y: Math.PI * 10 },
      rotation: 0,
      depth: 0.5,
      enabled: true,
      width: 12,
      height: 8,
      cornerRadius: 0,
    };
    const job = dowel(
      { end: 'tailstock', diameter: 4, length: 5 },
      { labels: [], shapes: [pocket] },
    );
    const cutter = flatEndMill(6, { name: '6 mm flat' });
    const g = engraveGenerate(tl, job, cutter, [], null);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.find((x) => x.code === 'neck-too-narrow-for-cutter');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('rotary-neck');
    expect(f!.message).toContain('The neck for parting is too short for the cutter');
    expect(f!.message).toContain('the neck is 5 mm long');
    expect(f!.message).toContain('"6 mm flat" is ⌀6 mm wide');
    expect(f!.message).toContain('as wide as the neck or wider cannot leave a floor');
    expect(f!.message).toContain('Make the neck longer than ⌀6 mm');
    expect(f!.message).toContain('use a narrower cutter for the last cut');
    expect(f!.message).toContain('turn the neck off');
    expect(f!.message).not.toContain('neck-too-narrow-for-cutter');
  });

  it('refuses a run whose only neck-carrying rest program was dropped', () => {
    // A setup naming the same ⌀1 mm cutter twice: the rough program removes everything the rest
    // cutter could open, so the measured rest pass is dropped with `setup-rest-nothing`. The neck
    // was assigned to that rest program only; without the run-level check the rough-only program
    // posts, no neck is cut, and every sentence still says the part is on one.
    const base = dowel();
    const itemId = base.labels[0]!.id;
    const rest: ToolLibraryEntry = {
      key: 'user:flat-8-rest-nothing',
      tool: flatEndMill(8.0, { name: '8 mm flat (cannot enter the engrave)' }),
      provenance: 'test',
    };
    const job: EngraveJob = { ...base, setups: [setup([base.toolKey, rest.key], [itemId])] };
    const g = generate(tl, job, null, [], undefined, { tools: [rest] });
    expect(g.findings.find((f) => f.code === 'setup-rest-nothing')).toBeDefined();
    expect(g.programs).toHaveLength(1);
    expect(g.programs[0]!.neck ?? null).toBeNull();
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.find((x) => x.code === 'neck-not-cut');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('rotary-neck');
    expect(f!.message).toContain('The neck for parting is set, but no program in this run cuts it');
    expect(f!.message).toContain('Turn the neck off');
    expect(f!.message).not.toContain('neck-not-cut');
  });
});
