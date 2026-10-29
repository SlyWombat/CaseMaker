/**
 * #743 D-2 — RESIZE THE JOB TO A MEASURED DISC.
 *
 * The maintainer's decision (2026-10-29): a disc more than 1 % off the stated diameter is a
 * question, and one answer is to resize the job to what was measured. This module is that answer:
 * every item is scaled in X and Y about the stock's centre — the point the registration measures
 * the stock's own centre at — and the stock box (and a disc's ⌀) are scaled with them, so the
 * design covers the same fraction of the blank it was drawn for.
 *
 * NOTHING IS SCALED IN Z. Depths, peck lengths, tab heights, breakthrough and flatness are the
 * cut's own numbers, not the blank's footprint: a 1 % wider disc does not want a 1 % deeper pocket.
 * A thread's SIZE is a physical standard (M5 stays M5 — only its position moves), a texture's and
 * prism's marks are surface treatment widths, and a glue gap is a clearance; those are left at the
 * numbers the operator chose.
 *
 * PURE, and exhaustive by switch: a new item kind is a type error here rather than an item the
 * resize quietly leaves behind.
 */

import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveCutout,
  EngraveDrill,
  EngraveJob,
  EngraveKeepOut,
  EngraveLabel,
  EngravePrimitive,
  EngraveShape,
  EngraveTraceItem,
  EngraveVectorShape,
} from '@/types/engraveJob';

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** A point scaled about `c`, rounded to the document's micron. */
const about = (p: { x: number; y: number }, c: { x: number; y: number }, f: number): { x: number; y: number } => ({
  x: r3(c.x + (p.x - c.x) * f),
  y: r3(c.y + (p.y - c.y) * f),
});

const points = (pts: readonly [number, number][], f: number): [number, number][] =>
  pts.map(([x, y]) => [r3(x * f), r3(y * f)] as [number, number]);

/** The job, scaled about its stock's centre. A factor that is not a positive number changes nothing. */
export function scaleJobAboutCentre(job: EngraveJob, factor: number): EngraveJob {
  if (!Number.isFinite(factor) || !(factor > 0)) return job;
  const f = factor;
  const c = { x: job.stock.length / 2, y: job.stock.width / 2 };
  const len = (v: number): number => r3(v * f);

  const stock: EngraveJob['stock'] = {
    ...job.stock,
    length: len(job.stock.length),
    width: len(job.stock.width),
    ...(job.stock.diameter !== undefined ? { diameter: len(job.stock.diameter) } : {}),
    // The wall is a material thickness, and the flatness/thickness are Z: neither is rescaled.
  };

  const label = (l: EngraveLabel): EngraveLabel => ({
    ...l,
    position: about(l.position, c, f),
    size: len(l.size),
  });

  const shape = (s: EngraveShape | EngraveVectorShape | EngraveCombinedShape): EngraveAnyItem => {
    switch (s.kind) {
      case 'rect':
        return { ...s, position: about(s.position, c, f), width: len(s.width), height: len(s.height), cornerRadius: len(s.cornerRadius) };
      case 'circle':
        return { ...s, position: about(s.position, c, f), diameter: len(s.diameter) };
      case 'slot':
        return { ...s, position: about(s.position, c, f), length: len(s.length), width: len(s.width) };
      case 'polygon':
        return { ...s, position: about(s.position, c, f), points: points(s.points, f) };
      case 'vector':
        return {
          ...s,
          position: about(s.position, c, f),
          contours: s.contours.map((ring) => points(ring, f)),
          width: len(s.width),
          height: len(s.height),
        };
      case 'border':
        return { ...s, inset: len(s.inset), width: len(s.width) };
      case 'frame':
        return { ...s, gap: len(s.gap), width: len(s.width) };
      case 'cutaway':
        // References only (an outer and its islands): every one of them is scaled by its own entry.
        return s;
    }
  };

  const drill = (d: EngraveDrill): EngraveDrill =>
    d.kind === 'drill-array'
      ? {
          ...d,
          position: about(d.position, c, f),
          pitch: { x: len(d.pitch.x), y: len(d.pitch.y) },
          ...(d.diameter !== undefined ? { diameter: len(d.diameter) } : {}),
        }
      : { ...d, position: about(d.position, c, f), ...(d.diameter !== undefined ? { diameter: len(d.diameter) } : {}) };

  const primitive = (p: EngravePrimitive): EngravePrimitive => {
    switch (p.kind) {
      case 'box':
        return { ...p, position: about(p.position, c, f), width: len(p.width), height: len(p.height) };
      case 'cylinder':
      case 'sphere':
        return { ...p, position: about(p.position, c, f), diameter: len(p.diameter) };
      case 'cone':
        return { ...p, position: about(p.position, c, f), diameter: len(p.diameter), tipDiameter: len(p.tipDiameter) };
    }
  };

  const trace = (t: EngraveTraceItem): EngraveTraceItem =>
    t.kind === 'line'
      ? {
          ...t,
          position: about(t.position, c, f),
          points: points(t.points, f),
          ...(t.flute?.rampMm !== undefined ? { flute: { ...t.flute, rampMm: len(t.flute.rampMm) } } : {}),
        }
      : { ...t, position: about(t.position, c, f), size: len(t.size) };

  const keepOut = (k: EngraveKeepOut): EngraveKeepOut => {
    switch (k.kind) {
      case 'rect':
        return { ...k, position: about(k.position, c, f), width: len(k.width), height: len(k.height), cornerRadius: len(k.cornerRadius) };
      case 'circle':
        return { ...k, position: about(k.position, c, f), diameter: len(k.diameter) };
      case 'slot':
        return { ...k, position: about(k.position, c, f), length: len(k.length), width: len(k.width) };
      case 'polygon':
        return { ...k, position: about(k.position, c, f), points: points(k.points, f) };
    }
  };

  const cutout = (k: EngraveCutout): EngraveCutout => ({
    ...k,
    inset: len(k.inset),
    // The tab's WIDTH runs along the part and scales with it; its HEIGHT is measured down from the
    // top face (how much material holds the part), which the footprint does not change.
    tabs: { ...k.tabs, width: len(k.tabs.width) },
  });

  return {
    ...job,
    stock,
    labels: job.labels.map(label),
    shapes: job.shapes.map(shape) as EngraveShape[],
    ...(job.combined !== undefined ? { combined: job.combined.map(shape) as EngraveCombinedShape[] } : {}),
    ...(job.vectors !== undefined ? { vectors: job.vectors.map(shape) as EngraveVectorShape[] } : {}),
    ...(job.traces !== undefined ? { traces: job.traces.map(trace) } : {}),
    ...(job.drills !== undefined ? { drills: job.drills.map(drill) } : {}),
    ...(job.threads !== undefined ? { threads: job.threads.map((t) => ({ ...t, position: about(t.position, c, f) })) } : {}),
    ...(job.primitives !== undefined ? { primitives: job.primitives.map(primitive) } : {}),
    ...(job.chamfers !== undefined ? { chamfers: job.chamfers.map((ch) => ({ ...ch, width: len(ch.width) })) } : {}),
    ...(job.cutouts !== undefined ? { cutouts: job.cutouts.map(cutout) } : {}),
    ...(job.keepOuts !== undefined ? { keepOuts: job.keepOuts.map(keepOut) } : {}),
    ...(job.targetObject !== undefined
      ? {
          targetObject: {
            ...job.targetObject,
            // X/Y move with the blank; Z is the object's top in the work frame and is not a
            // footprint number. The mesh itself is not rescaled: a goal's relief is its own model.
            position: { ...about(job.targetObject.position, c, f), z: job.targetObject.position.z },
          },
        }
      : {}),
  };
}
