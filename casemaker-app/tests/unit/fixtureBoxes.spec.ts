// #1102 — the fence is a FIXTURE. A taped blank pushed into the bracket's corner posts the
// bracket's two arm boxes to the verifier (and the sweep, and the preview) exactly as a clamped
// job does; it posts no clamp boxes (the tape holds, nothing stands over the stock). The fixture is
// machine-fixed, never reflected (#1073).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { bracketSettings, mountInPath, type PathSegment } from '@/engine/cnc/mounts';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultBracketHold, defaultTapeHold, fixtureMountOf, jobMountObstacles } from '@/engine/cnc/engrave/jobSetup';
import type { BedFence, EngraveJob } from '@/types/engraveJob';
import { TAPE_DEFAULTS } from '@/engine/cnc/engrave/jobSetup';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);
const B = bracketSettings(DEFAULTS);
const TOOL_R = 3.175 / 2;
const FENCE: BedFence = { kind: 'bracket', anchor: 1, variant: 'thin', edges: 'corner' };

function plate(): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, stock: { ...base.stock, length: 100, width: 60, thickness: 6 } };
}
const fenced = (over: Partial<BedFence> = {}): EngraveJob => ({
  ...plate(),
  workholding: { kind: 'tape', tape: { ...defaultTapeHold(TAPE_DEFAULTS), where: null, squareTo: 'fence', fence: { ...FENCE, ...over } } },
});
const unfenced = (): EngraveJob => ({ ...plate(), workholding: { kind: 'tape', tape: defaultTapeHold(TAPE_DEFAULTS) } });
const clamped = (): EngraveJob => ({
  ...plate(),
  workholding: { kind: 'bracket', bracket: defaultBracketHold({ x: 100, y: 60, z: 6 }, DEFAULTS) },
});

/** A cut along the blank's left edge, the tool's EDGE `gap` mm in from the left arm's inner face (x = 0); negative = into the arm. */
function cutAlongLeftEdge(gapMm: number): PathSegment[] {
  const x = gapMm + TOOL_R;
  return [{ line: 1, mode: 'cut', from: [x, 10, -1], to: [x, 50, -1] }];
}

describe('#1102 a taped job with the fence posts the bracket’s arms', () => {
  it('the fixture mount of a fenced tape job is the bracket; an unfenced one is still tape', () => {
    expect(fixtureMountOf(fenced())).toBe('bracket');
    expect(fixtureMountOf(unfenced())).toBe('tape');
    expect(fixtureMountOf(clamped())).toBe('bracket');
  });

  it('posts the two arm boxes and no clamp boxes', () => {
    const mount = jobMountObstacles(fenced(), DEFAULTS);
    expect(mount).not.toBeNull();
    expect(mount!.obstacles.map((o) => o.id)).toEqual(['bracket-front-arm', 'bracket-left-arm']);
    expect(mount!.fixture.boxes.map((b) => b.id)).toEqual(['bracket-front-arm', 'bracket-left-arm']);
  });

  it('posts the same arm boxes as a clamped job (the arms, byte for byte)', () => {
    const arms = (job: EngraveJob) => jobMountObstacles(job, DEFAULTS)!.obstacles.filter((o) => o.kind === 'bracket');
    expect(arms(fenced())).toEqual(arms(clamped()));
  });

  it('an unfenced taped job posts nothing, as before', () => {
    expect(jobMountObstacles(unfenced(), DEFAULTS)).toBeNull();
  });

  it('the fence’s own obstacle boxes ride the fixture', () => {
    const hole = { id: 'hole-1', label: 'the counterbored hole', min: [5, 5, -6] as [number, number, number], max: [9, 9, -1] as [number, number, number] };
    const mount = jobMountObstacles(fenced({ obstacles: [hole] }), DEFAULTS)!;
    expect(mount.fixture.boxes.map((b) => b.id)).toContain('hole-1');
  });
});

describe('#1102 a contour near the arm is refused exactly as a clamped job refuses it', () => {
  const refuse = (job: EngraveJob, gap: number) => {
    const mount = jobMountObstacles(job, DEFAULTS)!;
    return mountInPath(cutAlongLeftEdge(gap), mount.obstacles, { radius: TOOL_R, uncertainty: mount.uncertainty });
  };

  it('a tool edge 0.4 mm INTO the left arm is bracket-in-path, and the same findings as a clamped job', () => {
    const fencedFindings = refuse(fenced(), -0.4);
    const clampedFindings = refuse(clamped(), -0.4);
    expect(fencedFindings.map((f) => f.code)).toEqual(clampedFindings.map((f) => f.code));
    expect(fencedFindings.length).toBeGreaterThan(0);
    expect(fencedFindings[0]!.code).toBe('bracket-in-path');
    expect(fencedFindings[0]!.obstacleId).toBe('bracket-left-arm');
  });

  it('well clear of the arm, nothing is refused', () => {
    expect(refuse(fenced(), 5)).toEqual([]);
    expect(B.settings.fitMm).toBeLessThan(5);
  });
});
