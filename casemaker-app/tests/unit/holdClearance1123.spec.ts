// #1123 item 55 — THE CLEARANCE STATEMENT NAMES THE JOB'S OWN HOLD.
//
// The Cut step's acknowledgement asked every operator to check "clearance to the vise", including
// a bracket job whose blank is clamped in the bracket — a vise that is not on the machine. The
// words come from the job's mount record, the same record the Design panel's Hold line
// (`bedHoldLine`) is built from. This spec pins each arm's words: the bracket's arms and its
// clamps, the bed a taped blank sits on, the chuck (and tailstock) of a rotary job.
import { describe, expect, it } from 'vitest';
import { clearanceHoldWords } from '@/components/welcome/holdingMounts';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultBracketHold, defaultTapeHold } from '@/engine/cnc/engrave/jobSetup';
import type { JobWorkholding } from '@/types/engraveJob';
import { TAPE_DEFAULTS } from '@/engine/cnc/engrave/jobSetup';

const STOCK = { x: 100, y: 60, z: 12 };

function bracket(clamps: number): JobWorkholding {
  const hold = defaultBracketHold(STOCK, null);
  return { kind: 'bracket', bracket: { ...hold, clamps: hold.clamps.slice(0, clamps) } };
}

function rotary(tailstock: boolean): JobWorkholding {
  return {
    kind: 'rotary-chuck',
    rotary: { stickout: 40, gripDiameter: 20, jawMode: 'reverse-inner', tailstock, source: 'the rotary page' },
  };
}

describe('#1123-55 — the clearance words come from the job’s own hold', () => {
  it('a vise job still names the vise', () => {
    expect(clearanceHoldWords(defaultEngraveJob().workholding)).toBe('the vise');
  });

  it('a bracket job names the bracket’s arms and its clamps — never the vise', () => {
    expect(clearanceHoldWords(bracket(2))).toBe("the bracket's arms and its 2 clamps");
    expect(clearanceHoldWords(bracket(2))).not.toContain('vise');
  });

  it('one clamp reads as the clamp', () => {
    expect(clearanceHoldWords(bracket(1))).toBe("the bracket's arms and the clamp");
  });

  it('a bracket with no clamp still names its arms', () => {
    expect(clearanceHoldWords(bracket(0))).toBe("the bracket's arms");
  });

  it('a taped blank names the bed it sits on', () => {
    expect(clearanceHoldWords({ kind: 'tape', tape: defaultTapeHold(TAPE_DEFAULTS) })).toBe('the bed');
  });

  it('a rotary job names the chuck, and the tailstock when one is fitted', () => {
    expect(clearanceHoldWords(rotary(true))).toBe('the chuck and the tailstock');
    expect(clearanceHoldWords(rotary(false))).toBe('the chuck');
  });
});
