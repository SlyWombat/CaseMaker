/**
 * #737 — THE NECK FOR PARTING, through the generator, the verifier and the run sheet.
 *
 * The fixture is the rotary design's own (#240 W, `rotary-flow.md` §3.6, §3.11): a PLA rod
 * ⌀20 × 100 in the chuck, 85 mm out, tailstock in, one "Zoomba" engrave, a ⌀1 mm flat end. Its
 * free span is X 3–75 mm, so the default neck grows in from the tailstock side: X 70–75 mm, saw
 * at X 72.5 mm, floor at r 2 mm (⌀4 mm). The starter is also where the 4 mm default just clears
 * the safe minimum for PLA with the tailstock-side stub's 6.25 mm effective length (2.77 mm), so
 * the default is not silently refused.
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
import { rotaryFreeSpan, rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import {
  ROTARY_NECK_DIAMETER_MM,
  ROTARY_NECK_MIN_LENGTH_MM,
  defaultRotaryNeck,
  rotaryNeckFacts,
  rotaryNeckMinDiameterMm,
  rotaryNeckSpan,
} from '@/engine/cnc/rotary/neck';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, RotaryChuck, RotaryNeck } from '@/types/engraveJob';

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

describe('#737 — the neck setting and its geometry', () => {
  it('offers the labelled defaults: tailstock side, ⌀4 mm, 5 mm long', () => {
    expect(defaultRotaryNeck()).toEqual({ end: 'tailstock', diameter: 4, length: 5 });
    expect(ROTARY_NECK_DIAMETER_MM).toBe(4);
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
    // The saw frees the stub from the saw line (X 72.5) to the free end (X 85): 12.5 mm. With the
    // tailstock centre holding its far end the check counts half of it, where the bending is shared.
    expect(tail.carriedMm).toBe(12.5);
    expect(tail.effectiveMm).toBe(6.25);

    const chuck = rotaryNeckSpan(map, { end: 'chuck', diameter: 4, length: 5 })!;
    expect([chuck.fromMm, chuck.toMm, chuck.sawAtMm]).toEqual([3, 8, 5.5]);
    // The whole part beyond the saw line: X 5.5–85.
    expect(chuck.carriedMm).toBe(79.5);
    expect(chuck.effectiveMm).toBe(39.75);
  });

  it('computes the safe minimum from the material and the effective cantilever, as a labelled default', () => {
    // d = cbrt(32·F·L / (π·σ)) with F = 10 N, L in metres, σ in Pa; 6.25 mm is the default
    // tailstock-side stub's effective length (12.5 mm carried, halved with the tailstock engaged).
    const pla = rotaryNeckMinDiameterMm('pla', 6.25);
    expect(pla.group).toBe('plastic');
    expect(pla.stressMpa).toBe(30);
    expect(pla.diameterMm).toBeCloseTo(2.7686, 3);
    // The default ⌀4 mm clears it, which is why 4 mm is the default.
    expect(pla.diameterMm).toBeLessThan(ROTARY_NECK_DIAMETER_MM);

    const softwood = rotaryNeckMinDiameterMm('softwood', 6.25);
    expect(softwood.diameterMm).toBeCloseTo(3.488, 3);
    const metal = rotaryNeckMinDiameterMm('aluminium-6061', 6.25);
    expect(metal.group).toBe('metal');
    expect(metal.diameterMm).toBeCloseTo(1.853, 3);
    // Stronger stock needs a thinner neck, for the same carried piece.
    expect(metal.diameterMm).toBeLessThan(pla.diameterMm);
    expect(softwood.diameterMm).toBeGreaterThan(pla.diameterMm);
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
    expect(parsedNeck.job.workholding.rotary.neck).toEqual({ end: 'tailstock', diameter: 4, length: 5 });
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
    const g = gen(dowel());
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
    const g = gen(dowel());
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(1);
    const facts = g.programs[0]!.neck;
    expect(facts).not.toBeNull();
    expect(facts).toMatchObject({ end: 'tailstock', diameterMm: 4, lengthMm: 5, fromMm: 70, toMm: 75, sawAtMm: 72.5 });
    // The generator's facts and the job's are the same object shape, from one span.
    expect(rotaryNeckFacts(dowel())).toMatchObject(facts!);
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
    const job = dowel();
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
    const job = dowel();
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

  it('says nothing about a saw when the job has no neck', () => {
    const job = dowel(null);
    const g = gen(job);
    expect(g.ok).toBe(true);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    expect(texts.some((t) => /Saw the part off/.test(t))).toBe(false);
  });

});
