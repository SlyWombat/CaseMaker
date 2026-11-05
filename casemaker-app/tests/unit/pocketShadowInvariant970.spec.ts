/**
 * #970 — THE MANAGER'S INVARIANT, env-gated on the real tray STEP (the same one
 * `opsAcceptance959.spec.ts`'s own acceptance cases use): with `aboveMaterial` ON, the posted
 * pocket programs equal those with it OFF, byte for byte, UNLESS a node's own region genuinely
 * sits under real overhang material its 2D footprint alone could not see — the elephant's belly,
 * this tree's own `pocketShadow966.spec.ts` table slab.
 *
 * The tray has no such overhang anywhere (#970's own finding, confirmed against E's real render):
 * every pocket node's own 2D footprint already accounts for everything above it. So for the real
 * tray, this is a STRICT equality — any difference at all is #970's own over-clip bug returning,
 * whether from a wall, a draft, a fillet, a rim or a scoop, not a named exception.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, type FeatureTree } from '@/engine/cnc/cam/model/features';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { planPocketsForTree, type PlanPocketsOptions } from '@/engine/cnc/cam/model/plan';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import type { ParsedMesh } from '@/engine/import/stlParser';

const TRAY = process.env.CM_959_TRAY_STEP;

async function placedTray(file: string): Promise<{ tree: FeatureTree; mesh: ParsedMesh }> {
  const bytes = fs.readFileSync(file);
  const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
  const { min, max } = read.mesh.bbox;
  const dx = 110 / 2 - (min[0] + max[0]) / 2;
  const dy = 140 / 2 - (min[1] + max[1]) / 2;
  const dz = -1.2 - max[2];
  const positions = Float32Array.from(read.mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  const mesh: ParsedMesh = { ...read.mesh, positions };
  const tree = recogniseFeatures({ triangles: mesh, faceId: read.faceId }, { up: [0, 0, 1], stockTop: 0 }, tl);
  return { tree, mesh };
}

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175 = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });

function pocketOptions(shadowMesh: PlanPocketsOptions['shadowMesh']): Omit<PlanPocketsOptions, 'offset'> {
  return {
    houseFlats: [FLAT6, FLAT3175],
    stepDownMm: 1.5,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    spindleRpm: 12000,
    air: true,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    ...(shadowMesh === undefined ? {} : { shadowMesh }),
  };
}

const ctx: PostContext = {
  jobName: 'tray-invariant', stock: { length: 110, width: 140, thickness: 27.2 },
  materialName: 'hardwood', zDatum: 'probed-top-face', origin: 'topFrontLeft',
  camVersion: 'test-970', toolKey: 'multi',
};

describe.skipIf(TRAY === undefined)('#970 the real tray — aboveMaterial on equals off, no overhang anywhere', () => {
  it('every pocket program posts byte-for-byte identical text with the shadow check on or off', async () => {
    const { tree, mesh } = await placedTray(TRAY!);
    const offset = makeClipperOffset(tl);

    const withShadow = planPocketsForTree(tree, { offset, ...pocketOptions(mesh) });
    const withoutShadow = planPocketsForTree(tree, { offset, ...pocketOptions(undefined) });

    const textsFor = (result: typeof withShadow): Map<string, string> => {
      const texts = new Map<string, string>();
      result.programs.forEach(({ cutterKey, ir }, i) => {
        const posted = postZ1(ir, ctx, Z1);
        texts.set(`${cutterKey}#${i}`, posted.ok ? posted.text : `REFUSED: ${posted.errors.join('; ')}`);
      });
      return texts;
    };

    const withTexts = textsFor(withShadow);
    const withoutTexts = textsFor(withoutShadow);
    expect([...withTexts.keys()].sort(), 'the same cutters post in both runs').toEqual([...withoutTexts.keys()].sort());
    const diffs: string[] = [];
    for (const [key, text] of withTexts) {
      if (text !== withoutTexts.get(key)) diffs.push(`${key}: posted text differs with the shadow check on vs. off`);
    }
    expect(diffs, diffs.join('\n')).toEqual([]);
  }, 300_000);
});
