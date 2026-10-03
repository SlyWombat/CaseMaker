// OPT-IN corpus smoke test (#186, #174).
//
// Runs the parser over Makera's 25 reference files, which `npm run reference-gcode:fetch`
// downloads into a GIT-IGNORED directory. They are GPL-3.0 / unlicensed upstream and
// Apache-2.0 here, so they are never committed and never embedded: this file reads them
// from disk and asserts only COUNTS and CODES, never vendor text.
//
// SKIPPED, not failed, when the directory is absent — so a clean checkout stays green.
//
// What it protects: the parser's error rate on KNOWN-GOOD vendor output must be zero. The
// first version raised 23 false errors here — 7 from a misreading of the spindle-on
// `M6` (the machine stops the spindle; it does not halt), and 16 from one `#` remark line.
// Neither was visible to a hand-written fixture until someone ran the real files.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGcode } from '@/engine/cnc/gcode';
import type { ParseResult } from '@/engine/cnc/gcode';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference-gcode');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.nc')) out.push(p);
  }
  return out;
}

describe.skipIf(!existsSync(DIR))('Makera reference corpus (run `npm run reference-gcode:fetch`)', () => {
  const files = existsSync(DIR) ? walk(DIR).sort() : [];
  const parsed = new Map<string, ParseResult>();
  const get = (rel: string): ParseResult => {
    const hit = [...parsed.entries()].find(([k]) => k.endsWith(rel));
    if (!hit) throw new Error(`corpus file not found: ${rel}`);
    return hit[1];
  };

  it('has all 26 files: 25 from CarveraController plus the Z1 TopClamp release asset', () => {
    expect(files).toHaveLength(26);
  });

  it('parses every file with ZERO errors: this is known-good vendor output', () => {
    const bad: string[] = [];
    for (const f of files) {
      const r = parseGcode(readFileSync(f, 'latin1'));
      parsed.set(relative(DIR, f).replace(/\\/g, '/'), r);
      for (const d of r.diagnostics) {
        if (d.severity === 'error') bad.push(`${relative(DIR, f)}:${d.line} ${d.code}: ${d.message.slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every move has finite coordinates wherever it has any', () => {
    // Collected and asserted ONCE: ~1.6 million moves, so a per-coordinate expect() is slow
    // enough to dominate the whole suite (it took two minutes).
    const bad: string[] = [];
    for (const [name, r] of parsed) {
      for (const e of r.events) {
        if (e.kind !== 'move') continue;
        for (const v of e.from) if (v !== null && !Number.isFinite(v)) bad.push(`${name}:${e.line}`);
        for (const v of e.to) if (v !== null && !Number.isFinite(v)) bad.push(`${name}:${e.line}`);
        if (bad.length > 20) break;
      }
    }
    expect(bad).toEqual([]);
  });

  it('Z1/TopClamp.nc: the ONLY Z1 sample and the only one with a ;@MKR| header', () => {
    const r = get('Z1/TopClamp.nc');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.header?.records.map((x) => x.tag)).toEqual([
      'BEGIN', 'SCHEMA', 'MACHINE', 'MATERIAL', 'STOCK', 'ORIGIN', 'CAM', 'UNIT', 'TOOL', 'TIME',
      'TOOLPATH', 'TOOLPATH', 'TOOLPATH', 'END', 'TOOLPATH_START', 'TOOLPATH_START', 'TOOLPATH_START',
    ]);
    // Three TOOLPATH_START markers are the segment boundaries the emulator's checkpoints key on.
    expect(r.events.filter((e) => e.kind === 'toolpath-start').map((e) => (e.kind === 'toolpath-start' ? e.number : -1))).toEqual([1, 2, 3]);
    expect(r.summary).toMatchObject({ moves: 9632, cuts: 9607, rapids: 25, toolChanges: 1, usesArcs: false });
    // It opens `T1 M6`, then `G0 X.. Y..` with NO Z: the first rapid must not get Z = 0.
    const first = r.events.find((e) => e.kind === 'move');
    expect(first?.kind === 'move' && first.from).toEqual([null, null, null]);
    expect(first?.kind === 'move' && first.to[2]).toBeNull();
    // The header unit CASE is not stable across Studio builds (`mm` in the locally installed
    // copy, `MM` in this release). The parser carries it as written; consumers must not
    // compare it case-sensitively.
    const unit = r.header?.records.find((x) => x.tag === 'UNIT');
    expect(unit?.fields['value']?.toLowerCase()).toBe('mm');
  });

  it('flags the laser jobs, which a mill simulation must refuse', () => {
    expect(get('Laser/AudreyHepburn.nc').summary.laser).toBe(true);
    expect(get('Laser/AudreyHepburnSmall.nc').summary.laser).toBe(true);
    expect(get('Tests/laser-test-air.nc').summary.laser).toBe(true);
  });

  it('flags the rotary jobs, which V1 does not simulate', () => {
    for (const f of ['Rotation/NefertitiFinish.nc', 'Rotation/NefertitiRough.nc', 'Tests/4th-test-air.nc']) {
      expect(get(f).summary.usesRotary, f).toBe(true);
    }
  });

  it('finds arcs where arcs are known to be, and none where they are not', () => {
    expect(get('Tests/fatigue-test.nc').summary.usesArcs).toBe(true);
    expect(get('LED/ABS-Base.nc').summary.usesArcs).toBe(true);
    expect(get('Tests/atc-test.nc').summary.usesArcs).toBe(false);
  });

  it('lowers the tiny files exactly (the ones small enough to check by eye)', () => {
    // atc-test.nc: T0M6 … T6M6. Seven tool changes, no motion, no errors.
    const atc = get('Tests/atc-test.nc');
    expect(atc.summary.toolChanges).toBe(7);
    expect(atc.summary.moves).toBe(0);
    // goto-pack-pos.nc: three G53 machine-coordinate rapids and nothing else.
    const goto = get('Tests/goto-pack-pos.nc');
    expect(goto.events.map((e) => e.kind)).toEqual(['move', 'move', 'move']);
    expect(goto.events.every((e) => e.kind === 'move' && e.frame === 'machine' && e.mode === 'rapid')).toBe(true);
    // flatness-test-air.nc: `T1 M06()` — the empty trailing comment must not hide the tool change.
    expect(get('Tests/flatness-test-air.nc').summary.toolChanges).toBe(1);
  });

  it('concatenated programs (M30 then T1M6, no M5) raise nothing', () => {
    for (const f of ['LED/ACRYLIC-Balloon.nc', 'LED/ACRYLIC-Face.nc', 'Relief/PirateShip.nc']) {
      expect(get(f).diagnostics.filter((d) => d.severity === 'error'), f).toEqual([]);
    }
  });

  it('the `#` remark in board-test.nc is a WARNING, once per line, and the commands still run', () => {
    const r = get('Tests/board-test.nc');
    const warns = r.diagnostics.filter((d) => d.code === 'ignored-text');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.every((d) => d.severity === 'warning')).toBe(true);
  });
});
