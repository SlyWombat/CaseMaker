/**
 * #1093 R1/R3 — THE SHEET NAMES THE FILES, AND A MULTI-PROGRAM RUN'S LIST NAMES EVERY ONE.
 *
 * Two defects this spec pins down:
 *
 *  1. The app handed `buildRunSheet` the generated programs with their TEXTS in `nc` (the sheet's
 *     contract, and the CLI since #733, is that `nc` is "the file to load"). A later program's
 *     section therefore pasted its whole G-code into the sheet. `nameProgramsForSheet` is the app's
 *     substitution; the sheet's texts must contain names, never `G21`/`M6` program bodies.
 *  2. A multi-program run has no file called `<job>.nc`: the header and the steps that say "load
 *     …" must name program 1's own file (`<job>-p1.nc`, #1093 R1).
 *
 * RED before the change: the header read `<job>.nc`, the step texts read `<job>.nc`, `RunSheet`
 * had no `files`, and the app's per-program sections printed their program bodies.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { nameProgramsForSheet } from '@/engine/cnc/engrave/programFiles';
import { buildRunSheet, type RunSheet, type RunSheetGenerated, type RunSheetSim } from '@/engine/cnc/engrave/runSheet';
import type { EngraveProgram } from '@/workers/sim/engraveGenerate';

const NOW = new Date('2026-11-08T12:00:00Z');
const NO_SIM: RunSheetSim | null = null;

function job(name = 'm1trayB-bottom') {
  const base = defaultEngraveJob();
  return { ...base, name, toolKey: 'flat-1.0', labels: [], shapes: [] };
}

function program(nc: string, frameNc: string | null = null, extra: Partial<EngraveProgram> = {}): EngraveProgram {
  return {
    setupIndex: 1,
    setupId: 'setup-1',
    toolKey: 'flat-1.0',
    nc,
    frameNc,
    cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 60 },
    verify: null,
    frameVerify: null,
    ...extra,
  } as unknown as EngraveProgram;
}

function generated(programs: EngraveProgram[]): RunSheetGenerated {
  return {
    findings: [],
    feeds: null,
    cam: null,
    nc: programs[0]?.nc ?? null,
    verify: null,
    frameNc: programs[0]?.frameNc ?? null,
    programs,
  };
}

const sheetText = (sheet: RunSheet): string =>
  sheet.sections.flatMap((s) => s.steps.map((step) => `${step.text} ${step.value ?? ''}`)).join('\n');

describe('#1093 — the sheet names a multi-program run’s files', () => {
  it('three programs: the header and the file list are p1..p3, the frames ride p2', () => {
    const jobDoc = job();
    const raw = [
      program('G21 G90\nT1 M6\nG1 X1 Y1\nM2'),
      program('G21 G90\nT1 M6\nG1 X2 Y2\nM2', 'G21 G90\nT1 M6\nG1 Z20\nM2'),
      program('G21 G90\nT1 M6\nG1 X3 Y3\nM2'),
    ];
    const sheet = buildRunSheet(jobDoc, generated(nameProgramsForSheet(raw, jobDoc.name)), NO_SIM, NOW);
    // The header names program 1's own file — no `<job>.nc` is written on a multi-program run.
    expect(sheet.header.fileName).toBe('m1trayB-bottom-p1.nc');
    // Every row: its file, its own frame only where one was produced.
    expect(sheet.files?.map((f) => [f.number, f.name, f.frameName])).toEqual([
      [1, 'm1trayB-bottom-p1.nc', null],
      [2, 'm1trayB-bottom-p2.nc', 'm1trayB-bottom-p2-frame.nc'],
      [3, 'm1trayB-bottom-p3.nc', null],
    ]);
    // The sections print names, never a program's body.
    const text = sheetText(sheet);
    expect(text).toContain('Program 2 is m1trayB-bottom-p2.nc');
    expect(text).not.toContain('G1 X1 Y1');
    expect(text).not.toContain('G1 X2 Y2');
    expect(text).not.toContain('G21 G90');
  });

  it('a one-program run is unchanged: `<job>.nc`, no file list', () => {
    const jobDoc = job('tray');
    const raw = [program('G21 G90\nM2')];
    const sheet = buildRunSheet(jobDoc, generated(nameProgramsForSheet(raw, jobDoc.name)), NO_SIM, NOW);
    expect(sheet.header.fileName).toBe('tray.nc');
    expect(sheet.files).toBeUndefined();
  });

  it('a faced run numbers the engraving programs among themselves and keeps the skim’s own name', () => {
    const jobDoc = job('badge');
    const raw = [
      program('G21 G90\n;face\nM2', null, { kind: 'facing' }),
      program('G21 G90\n;one\nM2'),
      program('G21 G90\n;two\nM2'),
    ];
    const named = nameProgramsForSheet(raw, jobDoc.name);
    expect(named.map((p) => p.nc)).toEqual(['badge-face.nc', 'badge-p1.nc', 'badge-p2.nc']);
  });

  it('the app’s facing steps name program 1’s file, not the old `<job>.nc`', () => {
    const jobDoc = { ...job('tray'), facing: { enabled: true, depth: 0.5 } };
    const raw = [program('G21 G90\n;face\nM2', null, { kind: 'facing' }), program('G21 G90\n;one\nM2'), program('G21 G90\n;two\nM2')];
    const withFace = { ...generated(nameProgramsForSheet(raw, jobDoc.name)), facingNc: 'G21 G90\n;face\nM2' };
    const sheet = buildRunSheet(jobDoc, withFace, NO_SIM, NOW);
    // The facing section's hand-over steps name the first engraving file, which is `-p1.nc` here.
    const cut = sheet.sections.flatMap((s) => s.steps).map((s) => s.text).join('\n');
    expect(cut).toContain('tray-p1.nc');
    expect(cut).not.toMatch(/load tray\.nc/);
  });
});
