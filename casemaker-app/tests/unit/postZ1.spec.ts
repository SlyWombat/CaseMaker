// The Z1 post-processor (#173): toolpath IR → `.nc`.
//
// Unit cases build their IRs by hand; the round trip at the bottom drives the real #172
// generator through the wasm harness, then parses and runs the emitted text — the check on
// our output is our own reader, which reads Studio's files with zero errors.

import { describe, it, expect } from 'vitest';
import { estimateSeconds, type CamMove, type CamOperation, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { flatEndMill, cuttingRadiusForSweep } from '@/engine/cnc/tool';
import { Z1, type MillProfile } from '@/engine/cnc/machine';
import { postZ1, FINAL_RETRACT_Z, type PostContext } from '@/engine/cnc/post/z1';
import { formatFixed, sanitizeMkrValue } from '@/engine/cnc/post/format';
import { parseMkrRecord } from '@/engine/cnc/gcode/mkrHeader';
import type { MkrHeader, MkrRecord, MoveEvent } from '@/engine/cnc/gcode/types';
import { setupFromHeader } from '@/engine/cnc/setupFromHeader';
import { parseGcode } from '@/engine/cnc/gcode';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { toSetup, jobTool } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { labelProfile } from '@/engine/cnc/engrave/partPlan';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import { generateEngrave, type EngraveRegion } from '@/engine/cnc/cam/engraveJob';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { EngraveLabel } from '@/types/engraveJob';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { tl } from './helpers/manifoldExec';

const rapid = (x: number, y: number, z: number): CamMove => ({ kind: 'rapid', x, y, z });
const cut = (x: number, y: number, z: number, f: number): CamMove => ({ kind: 'feed', x, y, z, f });

function operation(number: number, name: string, labelId: string, depth: number, moves: CamMove[]): CamOperation {
  return { number, name, labelId, depth, moves, estimatedSeconds: estimateSeconds(moves) };
}

function makeIr(operations: CamOperation[], over: Partial<ToolpathIR> = {}): ToolpathIR {
  return {
    frame: 'flat',
    tool: flatEndMill(1),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 1,
    operations,
    ...over,
  };
}

const CTX: PostContext = {
  jobName: 'badge',
  stock: { length: 20, width: 10, thickness: 5 },
  materialName: 'softwood',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
};

/** Small two-operation engrave IR: a rectangle at -1.0, then a smaller one at -0.5. */
const TWO_OP = makeIr([
  operation(1, '[T1]Engrave "A" 1.0mm', 'a', 1, [
    rapid(2, 2, 1),
    cut(2, 2, -1, 200),
    cut(4, 2, -1, 500),
    cut(4, 4, -1, 500),
    cut(2, 4, -1, 500),
    cut(2, 2, -1, 500),
    rapid(2, 2, 5),
  ]),
  operation(2, '[T1]Engrave "B" 0.5mm', 'b', 0.5, [
    rapid(10, 5, 1),
    cut(10, 5, -0.5, 200),
    cut(12, 5, -0.5, 500),
    cut(12, 7, -0.5, 500),
    rapid(12, 7, 5),
  ]),
]);

function codeLines(text: string): string[] {
  return text.split('\n').filter((l) => /^[GMT]/.test(l));
}

describe('postZ1 (#173)', () => {
  it('number formatting matches Studio: fixed places, zeros stripped, no -0, no exponent', () => {
    expect(formatFixed(70.11, 3)).toBe('70.11');
    expect(formatFixed(5, 3)).toBe('5');
    expect(formatFixed(-0.05, 3)).toBe('-0.05');
    expect(formatFixed(-0, 3)).toBe('0');
    expect(formatFixed(-0.0004, 3)).toBe('0');
    expect(formatFixed(1e-7, 3)).toBe('0');
    expect(formatFixed(500, 2)).toBe('500');
    expect(formatFixed(0.5, 3)).toBe('0.5');
    // The record format is `|`-separated; a `|` or a newline in a value becomes a space.
    expect(sanitizeMkrValue('A|B\nC')).toBe('A B C');
  });

  it('posts a two-operation hand-built IR to a stable .nc', () => {
    const res = postZ1(TWO_OP, CTX, Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toMatchInlineSnapshot(`
      ";@MKR|BEGIN
      ;@MKR|SCHEMA|v=1.0.0
      ;@MKR|MACHINE|id=Z1|name=Makera Z1
      ;@MKR|MATERIAL|id=0|name=softwood
      ;@MKR|STOCK|id=cuboid|length=20|width=10|height=5|diameter=1
      ;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-10|y=-5|z=2.5
      ;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
      ;@MKR|UNIT|value=MM
      ;@MKR|TOOL|number=1|id=0|name=1 mm flat end|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=0|diameter=1|tipdiameter=1|cornerradius=0|angle=0|halfAngle=0
      ;@MKR|TIME|seconds=3
      ; cycle estimate: cutting + rapids at an assumed 3000 mm/min (PROVISIONAL, #208 D3 calibrates)
      ;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]Engrave "A" 1.0mm
      ;@MKR|TOOLPATH|number=2|tool_number=1|name=[T1]Engrave "B" 0.5mm
      ;@MKR|END

      G90 G21
      ;@MKR|TOOLPATH_START|toolpath_number=1

      ; T1-1 mm flat end

      T1 M6
      M7
      G0 X2 Y2
      S12000 M3
      G0 Z5
      G0 Z1
      G1 Z-1 F200
      G1 X4 F500
      G1 Y4
      G1 X2
      G1 Y2
      G0 Z5
      ;@MKR|TOOLPATH_START|toolpath_number=2
      G0 X10 Y5 Z1
      G1 Z-0.5 F200
      G1 X12 F500
      G1 Y7
      G0 Z5
      G0 Z15
      M9
      M05
      G28
      M02
      "
    `);
  });

  it('every cutting Z is a pass depth of its operation and never depends on stock thickness', () => {
    const a = postZ1(TWO_OP, CTX, Z1);
    const b = postZ1(TWO_OP, { ...CTX, stock: { ...CTX.stock, thickness: 13 } }, Z1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Only the STOCK and ORIGIN header lines may change; thickness must not reach the cut.
    const strip = (text: string): string =>
      text
        .split('\n')
        .filter((l) => !l.startsWith(';@MKR|STOCK') && !l.startsWith(';@MKR|ORIGIN'))
        .join('\n');
    expect(strip(b.text)).toBe(strip(a.text));
    expect(a.text).toContain(';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-10|y=-5|z=2.5');
    expect(b.text).toContain(';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-10|y=-5|z=6.5');

    const depths = [-1, -0.5]; // the two operations' own pass depths
    const cuttingZ: number[] = [];
    for (const line of a.text.split('\n')) {
      if (!line.startsWith('G1 ')) continue;
      for (const m of line.matchAll(/Z(-?\d+(?:\.\d+)?)/g)) cuttingZ.push(Number(m[1]));
    }
    expect(cuttingZ.length).toBeGreaterThan(0);
    for (const z of cuttingZ) expect(depths).toContain(z);
  });

  it('round-trips its own header through parseMkrRecord and setupFromHeader', () => {
    const res = postZ1(TWO_OP, CTX, Z1);
    if (!res.ok) throw new Error('post failed');
    const lines = res.text.split('\n');
    const endIndex = lines.findIndex((l) => l.startsWith(';@MKR|END'));
    const records: MkrRecord[] = [];
    lines.slice(0, endIndex + 1).forEach((l, i) => {
      const rec = parseMkrRecord(l, i + 1);
      if (rec) records.push(rec);
    });
    expect(records.map((r) => r.tag)).toEqual([
      'BEGIN', 'SCHEMA', 'MACHINE', 'MATERIAL', 'STOCK', 'ORIGIN', 'CAM', 'UNIT', 'TOOL', 'TIME',
      'TOOLPATH', 'TOOLPATH', 'END',
    ]);
    expect(records.find((r) => r.tag === 'MACHINE')?.fields).toMatchObject({ id: 'Z1', name: 'Makera Z1' });
    expect(records.find((r) => r.tag === 'STOCK')?.fields).toMatchObject({
      id: 'cuboid', length: '20', width: '10', height: '5', diameter: '1',
    });
    expect(records.find((r) => r.tag === 'TOOL')?.fields).toMatchObject({ number: '1', type: 'Flat End', halfAngle: '0' });

    const header: MkrHeader = { records };
    const fromHeader = setupFromHeader(header);
    expect(fromHeader.patch.part).toEqual({ kind: 'prism', outline: { kind: 'p-rect', size: [20, 10] }, thickness: 5 });
    expect(fromHeader.workOrigin).toEqual({ corner: 'top-front-left', source: 'header' });
  });

  it('emits only the words that changed, and one F across a same-feed run', () => {
    const sticky = makeIr([
      operation(1, 'sticky', 'l', 1, [rapid(0, 0, 1), cut(0, 0, -1, 200), cut(5, 0, -1, 200), cut(5, 0, -1, 200), cut(5, 3, -1, 200)]),
    ]);
    const res = postZ1(sticky, CTX, Z1);
    if (!res.ok) throw new Error('post failed');
    expect(codeLines(res.text).filter((l) => l.startsWith('G1'))).toEqual(['G1 Z-1 F200', 'G1 X5', 'G1 Y3']);
    expect(res.text.match(/F200/g)?.length).toBe(1);
  });

  it('never puts an F on a G0 and emits none of the forbidden codes', () => {
    const res = postZ1(TWO_OP, CTX, Z1);
    if (!res.ok) throw new Error('post failed');
    const lines = codeLines(res.text);
    expect(lines.filter((l) => l.startsWith('G0 ')).some((l) => l.includes('F'))).toBe(false);
    const forbidden = /\b(G2|G3|G38|G10|G92|G53|G54|G55|G56|G57|G58|G59|G91|G81|G82|G83|G84|G85|G86|G87|G88|G89|M490|M491|M801|M802|M861|M862|M3\d\d)\b|\bA[-+]?\d/;
    expect(lines.join('\n')).not.toMatch(forbidden);
  });

  it('a name containing | does not add a field to its header record', () => {
    const res = postZ1(TWO_OP, { ...CTX, materialName: 'A|B' }, Z1);
    if (!res.ok) throw new Error('post failed');
    const line = res.text.split('\n').find((l) => l.startsWith(';@MKR|MATERIAL'))!;
    expect(parseMkrRecord(line, 1)?.fields).toEqual({ id: '0', name: 'A B' });
  });

  it('skips an operation with no moves and renumbers the rest', () => {
    const three = makeIr([
      operation(1, 'first', 'a', 1, [rapid(0, 0, 1), cut(0, 0, -1, 200), cut(2, 0, -1, 200), rapid(2, 0, 5)]),
      operation(2, 'empty', 'b', 1, []),
      operation(3, 'third', 'c', 1, [rapid(5, 5, 1), cut(5, 5, -1, 200), cut(7, 5, -1, 200), rapid(7, 5, 5)]),
    ]);
    const res = postZ1(three, CTX, Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const nums = res.text
      .split('\n')
      .filter((l) => l.startsWith(';@MKR|TOOLPATH|'))
      .map((l) => l.replace(/^;@MKR\|TOOLPATH\|number=(\d+).*$/, '$1'));
    expect(nums).toEqual(['1', '2']);
    expect(res.text.split('\n').filter((l) => l.startsWith(';@MKR|TOOLPATH_START'))).toEqual([
      ';@MKR|TOOLPATH_START|toolpath_number=1',
      ';@MKR|TOOLPATH_START|toolpath_number=2',
    ]);
    expect(res.text).not.toContain('empty');
  });

  it('refuses IRs it cannot post, with a reason each time', () => {
    const empty = postZ1(makeIr([]), CTX, Z1);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.join(' ')).toMatch(/no operation/i);

    const allEmpty = postZ1(makeIr([operation(1, 'a', 'a', 1, []), operation(2, 'b', 'b', 1, [])]), CTX, Z1);
    expect(allEmpty.ok).toBe(false);

    const fastFeed = postZ1(makeIr([operation(1, 'a', 'a', 1, [rapid(0, 0, 1), cut(0, 0, -1, 1500)])]), CTX, Z1);
    expect(fastFeed.ok).toBe(false);
    if (!fastFeed.ok) expect(fastFeed.errors.join(' ')).toMatch(/feed/i);

    const fastRpm = postZ1({ ...TWO_OP, spindleRpm: 20000 }, CTX, Z1);
    expect(fastRpm.ok).toBe(false);
    if (!fastRpm.ok) expect(fastRpm.errors.join(' ')).toMatch(/RPM/i);

    const nan = postZ1(makeIr([operation(1, 'a', 'a', 1, [rapid(0, 0, 1), cut(Number.NaN, 0, -1, 200)])]), CTX, Z1);
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.errors.join(' ')).toMatch(/non-finite/i);

    // `hasATC` is the profile's literal `false`; this post only writes the manual dialect.
    const atc = { ...Z1, hasATC: true } as unknown as MillProfile;
    const atcResult = postZ1(TWO_OP, CTX, atc);
    expect(atcResult.ok).toBe(false);
    if (!atcResult.ok) expect(atcResult.errors.join(' ')).toMatch(/tool changer/i);

    // A "cut" above the stock but below the hop height is cutting air.
    const airCut = postZ1(makeIr([operation(1, 'a', 'a', 1, [rapid(0, 0, 1), cut(0, 0, 0.5, 200)])]), CTX, Z1);
    expect(airCut.ok).toBe(false);
    if (!airCut.ok) expect(airCut.errors.join(' ')).toMatch(/air/i);

    // #237: a rotary-frame IR, or the rotary Z datum, is not postable by the flat dialect.
    const rotaryFrame = postZ1(
      makeIr([operation(1, 'a', 'a', 1, [rapid(0, 0, 1), cut(0, 0, -1, 200)])], { frame: 'rotary' }),
      CTX,
      Z1,
    );
    expect(rotaryFrame.ok).toBe(false);
    if (!rotaryFrame.ok) expect(rotaryFrame.errors.join(' ')).toMatch(/ROTARY-frame/i);

    const rotaryDatum = postZ1(TWO_OP, { ...CTX, zDatum: 'rotary-axis' }, Z1);
    expect(rotaryDatum.ok).toBe(false);
    if (!rotaryDatum.ok) expect(rotaryDatum.errors.join(' ')).toMatch(/rotary-axis/i);
  });

  it('ends on Studio\'s own closing lines', () => {
    const res = postZ1(TWO_OP, CTX, Z1);
    if (!res.ok) throw new Error('post failed');
    const tail = res.text.trimEnd().split('\n').slice(-5);
    expect(tail).toEqual([`G0 Z${FINAL_RETRACT_Z}`, 'M9', 'M05', 'G28', 'M02']);
  });
});

describe('postZ1 round trip (#173)', () => {
  it('the default engrave job posts, parses and runs with zero errors, endpoints matching the IR', () => {
    const job = defaultEngraveJob();
    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    if (!tool) return;
    const radius = cuttingRadiusForSweep(tool);
    if (!radius.ok) throw new Error(radius.reason);
    const feeds = feedsFor([], job.stock.material, tool, Z1);
    if (!feeds.ok) throw new Error(feeds.reason);

    const opened = (label: EngraveLabel): Polygons => {
      const cs = executeProfile(tl, engravableProfile(labelProfile(label, []), radius.radius));
      const polygons = cs.toPolygons() as Polygons;
      cs.delete();
      return polygons;
    };
    const labels: EngraveRegion[] = job.labels
      .filter((l) => l.enabled && l.text.trim().length > 0)
      .map((l) => ({ id: l.id, text: l.text, depth: l.depth, polygons: opened(l) }));
    const ir = generateEngrave(tl, labels, tool, feeds.params);

    const ctx: PostContext = {
      jobName: job.name,
      stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
      materialName: job.stock.material,
      zDatum: 'probed-top-face',
      origin: 'topFrontLeft',
      camVersion: '1.0.0',
    };
    const res = postZ1(ir, ctx, Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const parse = parseGcode(res.text);
    expect(parse.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const timeline = buildTimeline(parse, toSetup(job, Z1), Z1);
    expect(timeline.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const irFeeds = ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    const cutMoves = parse.events.filter((e): e is MoveEvent => e.kind === 'move' && e.mode === 'cut');
    expect(cutMoves.length).toBeGreaterThan(0);
    expect(timeline.summary.cuttingMoves).toBe(cutMoves.length);

    // A feed whose formatted axis words AND feed repeat the last emitted ones is degenerate
    // after rounding (a sub-0.0005 mm move) and emits no line — the spec's "non-degenerate"
    // count. Walk the IR in order, pair each emitted cutting move with the feed that produced
    // it, and check the endpoint; the walk must consume every emitted move exactly once.
    const p = Z1.dialect.axisPrecision;
    const fp = Z1.dialect.feedPrecision;
    let emitted = 0;
    for (const f of irFeeds) {
      const cm = cutMoves[emitted];
      const matches =
        cm !== undefined &&
        cm.to[0] === Number(formatFixed(f.x, p)) &&
        cm.to[1] === Number(formatFixed(f.y, p)) &&
        cm.to[2] === Number(formatFixed(f.z, p)) &&
        cm.feed === Number(formatFixed(f.f, fp));
      if (!matches) continue;
      // Each cutting move's work-frame endpoint equals the IR's to within half the last
      // printed digit: 3 decimals, so 0.0005 mm.
      expect(Math.abs((cm.to[0] as number) - f.x)).toBeLessThanOrEqual(0.0005);
      expect(Math.abs((cm.to[1] as number) - f.y)).toBeLessThanOrEqual(0.0005);
      expect(Math.abs((cm.to[2] as number) - f.z)).toBeLessThanOrEqual(0.0005);
      emitted++;
    }
    expect(emitted).toBe(cutMoves.length);
  });
});
