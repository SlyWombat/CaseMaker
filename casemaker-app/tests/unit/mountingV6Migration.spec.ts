import { describe, it, expect } from 'vitest';
import { parseProject, serializeProject } from '@/store/persistence';
import { createDefaultProject } from '@/store/projectStore';

describe('mounting features v6 schema migration (#80)', () => {
  it("createDefaultProject stamps schemaVersion: 10", () => {
    const p = createDefaultProject('rpi-4b');
    expect(p.schemaVersion).toBe(10);
  });

  it('a v5-shaped project on disk loads, stamps schemaVersion: 10, and fills mountClass on every feature', () => {
    const v5OnDisk = {
      schemaVersion: 5,
      id: 'p1',
      name: 'legacy',
      createdAt: '2026-01-01T00:00:00Z',
      modifiedAt: '2026-01-01T00:00:00Z',
      board: createDefaultProject('rpi-4b').board,
      case: createDefaultProject('rpi-4b').case,
      ports: [],
      externalAssets: [],
      hats: [],
      customHats: [],
      mountingFeatures: [
        {
          id: 'legacy-tab',
          type: 'screw-tab',
          face: '-z',
          position: { u: 8, v: 8 },
          rotation: 0,
          params: { tabLength: 12, tabWidth: 14, tabThickness: 3, holeDiameter: 4.2 },
          enabled: true,
          // mountClass deliberately absent — pre-#80 disk shape
        },
        {
          id: 'legacy-vesa',
          type: 'vesa-mount',
          face: '+y',
          position: { u: 50, v: 30 },
          rotation: 0,
          params: { patternSize: 100, holeDiameter: 5 },
          enabled: true,
        },
      ],
      display: null,
      customDisplays: [],
      fanMounts: [],
      textLabels: [],
      antennas: [],
    };
    const parsed = parseProject(JSON.stringify(v5OnDisk));
    expect(parsed.schemaVersion).toBe(10);
    expect(parsed.mountingFeatures).toHaveLength(2);
    for (const f of parsed.mountingFeatures) {
      expect(f.mountClass).toBe('external');
    }
  });

  it('a v6-shaped project round-trips with mountClass intact', () => {
    const original = createDefaultProject('rpi-4b');
    original.mountingFeatures = [
      {
        id: 'standoff-1',
        type: 'aligned-standoff',
        mountClass: 'internal',
        face: '-z',
        position: { u: 30, v: 20 },
        rotation: 0,
        params: { diameter: 6, holeDiameter: 2.7 },
        enabled: true,
      },
    ];
    const round = parseProject(serializeProject(original));
    expect(round.mountingFeatures[0]!.mountClass).toBe('internal');
    expect(round.mountingFeatures[0]!.type).toBe('aligned-standoff');
  });

  it('rejects a project that uses an mountingFeature.type that is not in the v7 enum', () => {
    const bad = {
      ...createDefaultProject('rpi-4b'),
      mountingFeatures: [
        {
          id: 'bogus',
          type: 'completely-invalid-type',
          mountClass: 'external',
          face: '-z',
          position: { u: 0, v: 0 },
          rotation: 0,
          params: {},
          enabled: true,
        },
      ],
    };
    expect(() => parseProject(JSON.stringify(bad))).toThrow();
  });
});
