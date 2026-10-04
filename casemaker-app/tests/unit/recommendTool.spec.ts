// The cutter recommendation (#211). The pure rule is exercised with injected measurements, so
// every case but the last needs no wasm; the last one measures the DEFAULT job with the real
// library and asserts the 1.0 mm cutter wins over the 3.175 mm one, exactly as the issue asks.

import { describe, it, expect, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import {
  recommendTool,
  type ToolCandidate,
  type ToolRecommendation,
} from '@/engine/cnc/engrave/recommendTool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { flatEndMill, cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { measureLabels, type LabelEngravability } from '@/workers/sim/engraveGeometry';
import type { EngraveJob } from '@/types/engraveJob';

/** A library entry built around `flatEndMill`, with lengths/ratios supplied per case. */
function tool(key: string, diameter: number, opts: Partial<Tool> = {}): ToolLibraryEntry {
  return { key, tool: flatEndMill(diameter, opts), provenance: 'recommendTool test' };
}

/** One measured label. `emptyChars` is a COUNT; the rows carry the char list. */
function row(labelId: string, ratio: number, emptyChars = 0): LabelEngravability {
  return {
    labelId,
    glyphArea: 1,
    openedArea: ratio,
    ratio,
    emptyChars: Array.from({ length: emptyChars }, (_, index) => ({ index, char: 'x' })),
    outsideArea: 0,
    polygons: [],
  };
}

/** A one-label job centred in the default stock; the rule only reads text, size, depth, enabled. */
function jobWithLabel(id: string, text: string, depth: number, size = 8): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [
    {
      id,
      text,
      font: 'sans-default',
      weight: 'bold',
      size,
      position: { x: 50, y: 30 },
      rotation: 0,
      depth,
      enabled: true,
    },
  ];
  return job;
}

/** A `measure` that answers every candidate with the same single row. */
function allRows(ratio: number, emptyChars = 0) {
  return (_toolKey: string): LabelEngravability[] => [row('l1', ratio, emptyChars)];
}

function candidate(rec: ToolRecommendation, key: string): ToolCandidate {
  const c = rec.candidates.find((x) => x.key === key);
  expect(c, `candidate ${key} present`).toBeDefined();
  return c!;
}

describe('recommendTool (#211)', () => {
  it('picks the largest of the qualifying cutters', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [
      tool('t1.0', 1.0, { shoulderLength: 12 }),
      tool('t2.0', 2.0, { shoulderLength: 12 }),
      tool('t3.175', 3.175, { shoulderLength: 12 }),
    ];
    const measure = (key: string) => (key === 't3.175' ? [row('l1', 0.5)] : [row('l1', 1)]);
    const rec = recommendTool(job, tools, measure);
    expect(rec.key).toBe('t2.0');
    expect(rec.compromise).toBe(false);
    expect(rec.reason).toBe('Largest cutter that keeps every item intact.');
    expect(candidate(rec, 't2.0').qualifies).toBe(true);
    expect(candidate(rec, 't3.175').qualifies).toBe(false);
  });

  it('picks the only qualifying cutter when the others lose detail', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [tool('t1.0', 1.0), tool('t2.0', 2.0)];
    const measure = (key: string) => [row('l1', key === 't1.0' ? 1 : 0.4)];
    const rec = recommendTool(job, tools, measure);
    expect(rec.key).toBe('t1.0');
    expect(rec.compromise).toBe(false);
  });

  it('falls back to the smallest cutter, flagged compromise, naming the worst label', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [tool('t1.0', 1.0), tool('t2.0', 2.0), tool('t3.175', 3.175)];
    // Every cutter loses detail; the smaller the cutter the less it loses.
    const measure = (key: string) => [row('l1', key === 't1.0' ? 0.4 : key === 't2.0' ? 0.2 : 0.05)];
    const rec = recommendTool(job, tools, measure);
    expect(rec.key).toBe('t1.0');
    expect(rec.compromise).toBe(true);
    expect(rec.reason).toContain('CASE');
    expect(rec.reason).toContain('1.0 mm');
    expect(rec.reason).toContain('60 %');
    expect(candidate(rec, 't1.0').worst).toEqual({ labelId: 'l1', ratio: 0.4, emptyChars: 0 });
  });

  it('does not recommend a cutter whose reach is shorter than the deepest label, even at ratio 1', () => {
    const job = jobWithLabel('l1', 'CASE', 2.0);
    const tools = [tool('short', 2.0, { shoulderLength: 1 }), tool('ok', 1.0, { fluteLength: 12 })];
    const rec = recommendTool(job, tools, allRows(1));
    expect(rec.key).toBe('ok');
    const short = candidate(rec, 'short');
    expect(short.reachKnown).toBe(true);
    expect(short.reachOk).toBe(false);
    expect(short.qualifies).toBe(false);
  });

  it('excludes a ball nose as not-flat and never measures it', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const ball = tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' });
    const flat = tool('flat', 1.0);
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(job, [ball, flat], measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('flat');
    expect(candidate(rec, 'ball').excluded).toBe('not-flat');
    expect(candidate(rec, 'flat').excluded).toBeUndefined();
  });

  it('excludes a cutter with no feeds row and never measures it', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(job, [tool('big', 5.0), tool('flat', 1.0)], measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('flat');
    expect(candidate(rec, 'big').excluded).toBe('no-feeds');
  });

  it('still qualifies a cutter with unknown reach, and says so in the note', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(job, [tool('unknown-reach', 1.0)], allRows(1));
    expect(rec.key).toBe('unknown-reach');
    expect(rec.compromise).toBe(false);
    expect(candidate(rec, 'unknown-reach').reachKnown).toBe(false);
    expect(rec.reason).toContain('reach not recorded');
  });

  it('is deterministic on ties: known reach wins, then the lower key', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tied = [tool('z-unknown', 2.0), tool('a-unknown', 2.0)];
    expect(recommendTool(job, tied, allRows(1)).key).toBe('a-unknown');

    const reachTie = [tool('z-unknown', 2.0), tool('y-known', 2.0, { shoulderLength: 12 })];
    expect(recommendTool(job, reachTie, allRows(1)).key).toBe('y-known');
  });

  it('returns key null only when no eligible cutter exists', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(job, [tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' })], allRows(1));
    expect(rec.key).toBeNull();
    expect(rec.reason).toContain('flat end mill');

    const empty = recommendTool(job, [], allRows(1));
    expect(empty.key).toBeNull();
    expect(empty.candidates).toEqual([]);
  });
});

describe('recommendTool integration (#211)', () => {
  it('recommends the 1.0 mm cutter over the 3.175 mm one for the default job (#200)', () => {
    const job = defaultEngraveJob();
    const plan = toPartPlan(job);

    const perChar = (labelId: string) => {
      const label = job.labels.find((l) => l.id === labelId);
      if (!label) throw new Error(`no label ${labelId}`);
      return [...label.text].map((char) => ({
        char,
        profile: labelProfile({ ...label, text: char }, job.customFonts),
      }));
    };

    const measure = (toolKey: string): LabelEngravability[] => {
      const entry = TOOL_LIBRARY.find((e) => e.key === toolKey);
      if (!entry) throw new Error(`no tool ${toolKey}`);
      const radius = cuttingRadiusForSweep(entry.tool);
      if (!radius.ok) throw new Error(radius.reason);
      return measureLabels(tl, plan, radius.radius, job.edgeMargin, perChar);
    };

    const rec = recommendTool(job, TOOL_LIBRARY, measure);
    expect(rec.key).toBe('flat-1.0');
    // The wide cutter is the one that loses the thin strokes of the smaller labels.
    expect(candidate(rec, 'flat-3.175x12-metal').qualifies).toBe(false);
  });
});
