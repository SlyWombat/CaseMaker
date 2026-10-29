// @vitest-environment jsdom
// #743 §4.2 — how a disc is held: the vise's two-line sentence, tape as the bed's only arm, the
// bracket shown-not-offered with its reason, and the rotary chuck not offered at all. Also the
// bed's default: a disc is taped, whatever the profile prefers for a plate.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { defaultBedMount, mountOptions } from '@/components/welcome/holdingMounts';
import { HoldingPicture } from '@/components/welcome/HoldingStep';
import { MachineRecordSchema, type BedProfile, type FixtureRecord } from '@/platform/locationClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  machines: unknown[];
  accessories: FixtureRecord[];
};
const MACHINE = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
const DISC_BOX = { length: 30, width: 30, thickness: 3 };

const ROTARY: FixtureRecord = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'box' },
  history: [],
};

describe('#743 holding a disc', () => {
  it('shows the bracket and the chuck, and offers neither, each with its reason', () => {
    const options = mountOptions({
      machine: MACHINE,
      accessories: [...DOC.accessories, ROTARY],
      stock: DISC_BOX,
      disc: true,
    });
    const bracket = options.find((o) => o.mount === 'bed-bracket');
    expect(bracket).toBeDefined();
    expect(bracket!.disabled).toBe(true);
    expect(bracket!.reason).toContain('two points');
    expect(bracket!.escape).toBeNull();

    const rotary = options.find((o) => o.mount === 'rotary');
    expect(rotary).toBeDefined();
    expect(rotary!.disabled).toBe(true);
    expect(rotary!.reason).toContain('cut on its face');
    expect(rotary!.escape).toBeNull();

    // Tape is offered for a disc as it is for a plate: the row is there, and the only thing
    // between it and the job is the machine change, not the stock.
    const tape = options.find((o) => o.mount === 'bed-tape');
    expect(tape).toBeDefined();
    expect(tape!.escape).toBe('bed');
  });

  it('defaults to tape on the bed, even where the profile would put a plate in the bracket', () => {
    const base = MACHINE.bedProfiles![0]!;
    const bracketed: BedProfile = {
      ...base,
      placements: [
        ...base.placements,
        { id: 'pl-bracket', fixture: 'fx-bracket-thin', where: { kind: 'anchor', anchor: 1, pins: null }, count: null, frame: null, provenance: {} },
      ],
      preferredMounting: [{ stock: 'plate', mount: { placement: 'pl-bracket', manner: 'corner+clamps' } }],
    };
    // Guard the premise: the same profile sends a plate to the bracket.
    expect(defaultBedMount(bracketed, { thickness: 6 }, 'plate')).toBe('bed-bracket');
    expect(defaultBedMount(bracketed, { thickness: 6 }, 'disc')).toBe('bed-tape');
  });

  it('tells the operator a disc is gripped on two lines', () => {
    const { getByTestId } = render(<HoldingPicture mount="ledge" stock={DISC_BOX} form="disc" />);
    const caption = getByTestId('engrave-setup-holding-caption').textContent ?? '';
    expect(caption).toContain('disc');
    expect(caption).toContain('gripped on two lines');
  });
});
