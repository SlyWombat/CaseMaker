/**
 * #1202 + #1199 item 3 — THE DRY "WHAT WILL BE SENT" VIEW.
 *
 * The routine is run against a RECORDING console (scripted replies, no socket), every recorded line
 * is walked through the motion-order guard, and the card shows that list before the press. The
 * accident's own transcript (c8fa03a6) is the red case: with the guard applied it is shown AS
 * refused, and the fixed executor's own dry run shows no refusal at all.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { dryFlipRegistration, dryMountTap, recordingConsole, reviewLines, scriptedReply } from '@/engine/cnc/registration/dryRun';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);
const { settings: S } = registrationSettings(DEFAULTS);

/** The Z1's travel clearance (the machine frame says −3): the height every XY move must be at. */
const CLEARANCE = -3;
const FLOOR = -120;

/** The c8fa03a6 seat press, verbatim from #1199's trace — the sequence that bent the probe. */
const ACCIDENT = ['$H', 'M831', 'M491', 'G53 G0 Z-81.25', 'G53 G0 X-175 Y-35', 'G38.3 Z-11 F150'];
/** The same routine, ordered correctly: traverse at the clearance, descend at the point. */
const FIXED = ['$H', 'M831', 'M491', 'G53 G0 Z-3', 'G53 G0 X-175 Y-35', 'G53 G0 Z-81.25', 'G38.3 Z-11 F150'];

describe('#1199 item 3 — the shown verdict', () => {
  it('the accident’s sequence is shown AS REFUSED, at the traverse line', () => {
    const shown = reviewLines(ACCIDENT, CLEARANCE);
    const refused = shown.filter((l) => l.refused !== null);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.line).toBe('G53 G0 X-175 Y-35');
    expect(refused[0]!.refused).toContain('clearance');
    // The moves before it were fine; the descent is never reached with the guard's state unknown.
    expect(shown.slice(0, 3).every((l) => l.refused === null)).toBe(true);
  });

  it('the corrected order — lift/traverse at the clearance, descend at the point — is shown clean', () => {
    const shown = reviewLines(FIXED, CLEARANCE);
    expect(shown.every((l) => l.refused === null)).toBe(true);
  });
});

describe('#1202 — the recording console', () => {
  it('records every line and answers like a machine: Idle, open probe, a touched M491', async () => {
    const io = recordingConsole();
    for (const line of ['?', 'M119', 'M491']) await io.send(line);
    expect(io.lines).toEqual(['?', 'M119', 'M491']);
  });

  it('the seat press’s dry run lists its own lines, with no refusal, and a stable identity', async () => {
    const tap = { x: -175, y: -35, fromMachineZ: -81.25 };
    const opts = {
      clearanceZ: CLEARANCE,
      settings: S,
      workEnvelopeFloorZ: FLOOR,
      mount: 'bracket' as const,
      planTravelMm: 15,
      routine: 'seat-press' as const,
    };
    const dry = await dryMountTap(tap, opts);
    // The executor completes under the scripted machine (no error), and every line it WOULD send is
    // clean under the guard — the same pair the wire uses.
    expect(dry.error).toBeNull();
    expect(dry.refused).toBe(false);
    expect(dry.lines.length).toBeGreaterThan(3);
    for (const entry of dry.lines) expect(entry.refused).toBeNull();
    // The order the accident broke is the order this run has: no XY before a Z at the clearance.
    const firstXY = dry.lines.findIndex((l) => /^G53 G0 X/.test(l.line));
    expect(firstXY).toBeGreaterThan(0);
    expect(dry.lines.slice(0, firstXY).some((l) => l.line === `G53 G0 Z${CLEARANCE}`)).toBe(true);
    // The identity is the line sequence's shape: another blank's tap point is the SAME routine.
    const other = await dryMountTap({ ...tap, x: -100, y: 20 }, opts);
    expect(other.identity).toEqual(dry.identity);
    // ... and the identity is what the record will key on: same id, same shape.
    expect(dry.identity.routine).toBe('seat-press');
    expect(dry.identity.shape).toBe(other.identity.shape);
    // The named heights are in the identity: the clearance traverse is named, not a number.
    expect(dry.identity.lines.some((l) => l.height === 'clearance')).toBe(true);
  }, 120_000);
});

// #1202 — THE MOUNT TAP MEETS THE STORED LEVEL. A real tap lands on the jaw top (or the bracket's
// top) the machine record stores; a scripted midpoint reads millimetres above it, the executor's
// tap check stops, and the card's preview error holds a real Register ("#797 follow-up" went red).
describe('#1202 — the mount tap’s stored jaw top', () => {
  it('the scripted tap meets the jaw where the record stores it, not the middle of its travel', () => {
    const reply = scriptedReply({ tapZ: -57.491 });
    for (const line of ['$H', 'G53 G0 Z-50', 'G91']) reply(line);
    const prb = reply('G38.3 Z-20 F100');
    expect(prb).toContain('[PRB:0.000,0.000,-57.491:1]');
  });

  it('a standalone tap preview with a stored jaw top is clean', async () => {
    const dry = await dryMountTap(
      { x: -175, y: -35, fromMachineZ: -50 },
      {
        clearanceZ: CLEARANCE,
        settings: S,
        workEnvelopeFloorZ: FLOOR,
        mount: 'vise',
        routine: 'mount-tap',
        planTravelMm: 20,
        expectZ: -57.491,
        liveClearanceZ: CLEARANCE,
      },
    );
    expect(dry.error).toBeNull();
    expect(dry.refused).toBe(false);
    expect(dry.identity.routine).toBe('mount-tap');
  }, 120_000);
});
// #1202 — THE CLEARANCE IS REQUIRED, the same rule the tool-change preview follows (D's #1199):
// an unknown clearance is not 0. The flip registration's dry run must refuse rather than review
// its lines against an invented height, and the card's gate (previewHolds) then holds the press.
describe('#1202 — a preview with no clearance refuses', () => {
  it('the flip registration is not reviewed against an invented clearance', async () => {
    const dry = await dryFlipRegistration({ plan: {} as never, ctx: {} as never, z0: null }, {});
    expect(dry.refused).toBe(true);
    expect(dry.error).toContain('clearance unknown');
    expect(dry.lines).toEqual([]);
  });
});
