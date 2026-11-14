// #845 slice B — THE GRBL PRESETS AND THE HOUSE-LOCATION RECORD.
//
// Four stated machines ship: Shapeoko 4 XXL, Shapeoko 5 Pro (4 × 4), X-Carve Pro (4 × 4) and a
// 3018-PROVer V2. None is a vendor row Case Maker can read: the owner states the values, Case
// Maker writes the `.nc` for the owner's own sender and never drives the machine. This spec pins:
//   - every preset is a valid stated model (post `grbl`, no frame, a manual change, a work origin);
//   - EVERY cited value says where it came from — the vendor's published spec with its URL, or
//     "stated by you" where the vendor publishes nothing (no invented citation);
//   - the schema refuses a GRBL machine that claims an ATC (the post writes no tool changer);
//   - the location record a preset makes parses, names the preset model, and reaches no address;
//   - the run sheet names the dialect beside the machine, and only for a GRBL machine.

import { describe, expect, it } from 'vitest';

import {
  GENMITSU_3018,
  GRBL_PRESETS,
  MILL_MODELS,
  SHAPEOKO_4,
  SHAPEOKO_5,
  X_CARVE,
  millModelSchema,
  workOriginOf,
  type MillModel,
} from '@/engine/cnc/machine';
import { isGrblPresetId, machineRecordFromPreset } from '@/platform/genericMachines';
import { MachineRecordSchema } from '@/platform/locationClient';
import { buildRunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { dedupeFindings, jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import type { EngraveJob } from '@/types/engraveJob';
import { NO_SHOP } from '../tools/noShop';

const NOW = '2026-11-01T12:00:00.000Z';
const NC = [';@MKR|BEGIN', 'G21 G90', 'G1 Z-2.000 F200', 'G1 X10 Y10 F500', 'M5', 'M30'].join('\n');

function dj(): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  return job;
}

function sheetFor(job: EngraveJob, dialectName?: string) {
  const tool = jobTool(job);
  const generated: RunSheetGenerated = {
    findings: dedupeFindings(validateJob(job)),
    feeds: tool ? feedsFor([], job.stock.material, tool, Z1, NO_SHOP.refuse, job.cutOverride) : null,
    cam: { operations: 3, cuttingMoves: 1234, estimatedSeconds: 95, passes: 2 },
    nc: NC,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 6, cuttingMoves: 2, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
    frameNc: null,
  };
  return buildRunSheet(job, generated, { diagnostics: [] }, new Date(NOW), undefined, {
    ...(dialectName === undefined ? {} : { dialectName }),
  });
}

describe('#845 slice B the four GRBL presets', () => {
  it('ships the four machines the issue names, each a stated GRBL model that parses', () => {
    expect(GRBL_PRESETS.map((p) => p.id)).toEqual(['grbl:shapeoko-4', 'grbl:shapeoko-5-pro', 'grbl:x-carve-pro', 'grbl:3018-prover']);
    for (const preset of GRBL_PRESETS) {
      const parsed = millModelSchema.safeParse(preset);
      expect(parsed.success, `${preset.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(preset.post).toBe('grbl');
      expect(preset.frameState).toBe('stated');
      expect(preset.hasATC).toBe(false);
      expect(preset.toolSlots).toBe(0);
      // The work-area envelope starts at the stated origin, never in a Makera-style negative frame.
      expect(preset.envelope.x.min).toBe(0);
      expect(preset.envelope.y.min).toBe(0);
      expect(preset.envelope.z.min).toBe(0);
      expect(preset.envelope.x.max).toBeGreaterThan(0);
    }
  });

  it('the published work areas are the vendors’ own numbers', () => {
    // 33 × 33 × 4 in, 48.7 × 48.7 × 6.1 in, 48 × 48 × 4 in, and the 3018's published 300 × 180 × 45.
    expect([SHAPEOKO_4.envelope.x.max, SHAPEOKO_4.envelope.y.max, SHAPEOKO_4.envelope.z.max]).toEqual([838.2, 838.2, 101.6]);
    expect([SHAPEOKO_5.envelope.x.max, SHAPEOKO_5.envelope.y.max, SHAPEOKO_5.envelope.z.max]).toEqual([1237.0, 1237.0, 154.9]);
    expect([X_CARVE.envelope.x.max, X_CARVE.envelope.y.max, X_CARVE.envelope.z.max]).toEqual([1219.2, 1219.2, 101.6]);
    expect([GENMITSU_3018.envelope.x.max, GENMITSU_3018.envelope.y.max, GENMITSU_3018.envelope.z.max]).toEqual([300, 180, 45]);
  });

  it('EVERY cited value says where it came from — a vendor URL, or "stated by you"; nothing unlabelled', () => {
    for (const preset of GRBL_PRESETS) {
      const entries = Object.entries(preset.sources);
      expect(entries.length).toBeGreaterThanOrEqual(4);
      for (const [key, text] of entries) {
        const cited = /https?:\/\//.test(text);
        const stated = /^stated by you/.test(text);
        expect(cited || stated, `${preset.id}.${key}: "${text}" cites nothing`).toBe(true);
      }
      // A machine with no rotary states no rotary source — and none of the presets has one.
      expect(preset.rotaryEnvelope).toBeUndefined();
      expect(preset.sources.rotaryEnvelope).toBeUndefined();
    }
  });

  it('every preset states a rapid model for the cycle estimate, with its own labelled source', () => {
    for (const preset of GRBL_PRESETS) {
      const rapid = preset.rapidEstimate;
      expect(rapid.xyMmPerMin).toBeGreaterThan(0);
      expect(rapid.zMmPerMin).toBeGreaterThan(0);
      expect(rapid.accelMmPerS2).toBeGreaterThan(0);
      // No vendor publishes these: the estimate must say they are the owner's, not a vendor's.
      expect(rapid.source).toMatch(/^stated by you/);
    }
  });

  it('the work origin defaults to the front-left convention, and a stated centre-zero is kept', () => {
    expect(workOriginOf(SHAPEOKO_4)).toBe('top-front-left');
    const centred: MillModel = { ...GENMITSU_3018, workOrigin: 'top-centre' };
    expect(workOriginOf(centred)).toBe('top-centre');
    expect(millModelSchema.safeParse(centred).success).toBe(true);
  });

  it('a GRBL machine that claims a tool changer is refused, in the statement-side sentence', () => {
    const claimed = { ...SHAPEOKO_4, hasATC: true, toolSlots: 6 };
    const parsed = millModelSchema.safeParse(claimed);
    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues.find((i) => i.path[0] === 'hasATC');
    expect(issue?.message).toBe('a GRBL machine changes tools by hand: Case Maker’s GRBL post writes no tool changer');
  });

  it('every preset is in the model registry, so a record naming one resolves', () => {
    for (const preset of GRBL_PRESETS) {
      expect(MILL_MODELS[preset.id]).toBe(preset);
      expect(isGrblPresetId(preset.id)).toBe(true);
    }
    expect(isGrblPresetId(Z1.id)).toBe(false);
    expect(isGrblPresetId(null)).toBe(false);
  });
});

describe('#845 slice B the house-location record a preset makes', () => {
  it('parses as a machine record, names the preset model, and reaches no address', () => {
    const record = machineRecordFromPreset(SHAPEOKO_4, { id: 'machine-grbl-1', now: NOW });
    expect(MachineRecordSchema.safeParse(record).success).toBe(true);
    expect(record.profileId).toBe('grbl:shapeoko-4');
    expect(record.name).toBe('Shapeoko 4 XXL');
    expect(record.address).toBeNull();
    expect(record.bedProfiles).toBeUndefined();
    expect(MILL_MODELS[record.profileId!]).toBe(SHAPEOKO_4);
  });

  it('a nickname is the person’s, never the controller’s name (there is no controller)', () => {
    const record = machineRecordFromPreset(X_CARVE, { id: 'machine-grbl-2', now: NOW, nickname: 'The big one' });
    expect(record.nickname).toBe('The big one');
    expect(record.name).toBe('X-Carve Pro (4 × 4)');
  });
});

describe('#845 slice B the run sheet names the dialect', () => {
  it('prints "GRBL 1.1" when the caller resolved a GRBL machine, and nothing otherwise', () => {
    expect(sheetFor(dj(), 'GRBL 1.1').header.dialect).toBe('GRBL 1.1');
    expect(sheetFor(dj()).header.dialect).toBeUndefined();
  });
});
