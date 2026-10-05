import { describe, it, expect } from 'vitest';
import { boardProfileSchema } from '@/library/schema';
import { builtinBoards } from '@/library';

/**
 * #130 — visual assets (photos / GLBs) on a board profile are licensed
 * material. `visualAssets` may only be populated alongside the licence and
 * source URL that name it, so this gate rejects an asset-bearing profile that
 * did not record them.
 *
 * It runs in `npm test`, which is the CI step (casemaker-app/.github/workflows/
 * ci.yml) that validates every built-in board in this repo; the same schema
 * validates local + remote community boards when they are imported, so the
 * rule holds outside this repo too.
 */

function makeBoard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-board',
    name: 'Test Board',
    manufacturer: 'Test',
    pcb: { size: { x: 50, y: 40, z: 1.6 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 5,
    builtin: false,
    ...overrides,
  };
}

describe('#130 — visualAssets licence gate', () => {
  it('accepts a profile with no visualAssets at all', () => {
    expect(boardProfileSchema.safeParse(makeBoard()).success).toBe(true);
  });

  it('accepts a licence/source on their own (assets not yet added)', () => {
    const r = boardProfileSchema.safeParse(
      makeBoard({ visualAssets: { license: 'CC-BY-SA-4.0', sourceUrl: 'https://example.com' } }),
    );
    expect(r.success).toBe(true);
  });

  it('rejects a bundled topImage with no licence', () => {
    const r = boardProfileSchema.safeParse(
      makeBoard({
        visualAssets: { topImage: '/board-assets/rpi-4b/top.png', sourceUrl: 'https://example.com' },
      }),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/visualAssets\.license/);
  });

  it('rejects a GLB with no source URL (licence alone is not enough)', () => {
    const r = boardProfileSchema.safeParse(
      makeBoard({ visualAssets: { glb: '/board-assets/rpi-4b/model.glb', license: 'CC-BY-SA-4.0' } }),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/visualAssets\.sourceUrl/);
  });

  it('rejects a sideImage with neither licence nor source', () => {
    const r = boardProfileSchema.safeParse(
      makeBoard({ visualAssets: { sideImage: '/board-assets/x/side.png' } }),
    );
    expect(r.success).toBe(false);
  });

  it('accepts a fully-attributed bundled asset set', () => {
    const r = boardProfileSchema.safeParse(
      makeBoard({
        visualAssets: {
          glb: '/board-assets/rpi-4b/model.glb',
          topImage: '/board-assets/rpi-4b/top.png',
          sideImage: '/board-assets/rpi-4b/side.png',
          license: 'CC-BY-SA-4.0',
          sourceUrl: 'https://www.raspberrypi.com/',
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it('accepts a community board whose assets are absolute URLs', () => {
    const r = boardProfileSchema.safeParse(
      makeBoard({
        visualAssets: {
          topImage: 'https://library.example.org/boards/foo/top.jpg',
          license: 'CC-BY-4.0',
          sourceUrl: 'https://library.example.org/boards/foo.json',
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it('every shipped built-in board with an asset records licence + source', () => {
    for (const b of builtinBoards) {
      const a = b.visualAssets;
      if (!a) continue;
      const hasAsset = Boolean(a.glb || a.topImage || a.sideImage);
      if (!hasAsset) continue;
      expect(a.license, `${b.id} asset without a licence`).toBeTruthy();
      expect(a.sourceUrl, `${b.id} asset without a source URL`).toBeTruthy();
    }
  });

  it('accepts a component silkscreen `text` field (text-label legend)', () => {
    const r = boardProfileSchema.safeParse(
      makeBoard({
        components: [
          {
            id: 'legend',
            kind: 'text-label',
            position: { x: 5, y: 5, z: 0 },
            size: { x: 20, y: 3, z: 0.1 },
            text: 'DIGITAL',
          },
        ],
      }),
    );
    expect(r.success).toBe(true);
  });
});
