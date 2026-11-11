// @vitest-environment jsdom
// #1101 items 1, 4, 6 — THE HOLDING STEP SPEAKS ITS MOUNT'S VOCABULARY. Rendered directly for a
// vise job, a taped job and a rod in the chuck: the words each mount must never say are asserted
// absent from the SELECTED ROW, the one fold and the picture only (the other mounts' rows keep
// their own names — "In the rotary chuck" is a tape job's neighbour, not its vocabulary).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HoldingStep } from '@/components/welcome/HoldingStep';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultSetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import type { PartFootprint } from '@/components/welcome/workShape';
import type { MachineRecord, LocationView } from '@/platform/locationClient';
import type { EngraveJob } from '@/types/engraveJob';
import { act as actRtl } from '@testing-library/react';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { MachineRecordSchema } from '@/platform/locationClient';

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  id: string;
  name: string;
  createdAt: string;
  machines: unknown[];
  accessories: unknown[];
};

const ROTARY = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'machine', machineId: 'makera-z1-1a2b3c', since: '2026-10-27T09:00:00.000Z' },
  history: [],
};

function viseMachine(): MachineRecord {
  return MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
}

/** The fixture's machine with NOTHING on the pins, the thin bracket at anchor 1, tape and boards. */
function bedMachine(): MachineRecord {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  profile.placements = [
    {
      id: 'pl-bracket',
      fixture: 'fx-bracket-thin',
      where: { kind: 'anchor', anchor: 1, pins: null },
      count: null,
      seed: null,
      frame: null,
      provenance: {},
    },
  ];
  profile.surface = { ...profile.surface, length: 300, width: 200, position: { frontLeft: [20, 30], frame: 'machine' } };
  profile.consumables = {
    tape: { widthMm: 20, thicknessMm: 0.2, provenance: 'typed' },
    boards: [{ material: 'MDF', size: [100, 100, 2], count: 4 }],
  };
  return machine;
}

function rotaryMachine(): MachineRecord {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  profile.placements = [
    {
      id: 'pl-rotary',
      fixture: 'fx-rotary-1',
      where: { kind: 'pins', pins: 'rotary', anchor: null },
      count: null,
      seed: null,
      frame: null,
      provenance: {},
    },
  ];
  profile.surface = {
    kind: 'bare-bed',
    material: null,
    length: null,
    width: null,
    thickness: null,
    position: null,
    provenance: {},
    scars: [],
    lastResurfacedAt: null,
  };
  profile.consumables = null;
  return machine;
}

function seedLocation(machine: MachineRecord, accessories: unknown[] = DOC.accessories): void {
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    machines: [machine],
    accessories,
  } as unknown as LocationView;
  actRtl(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

function dj(stock: Partial<EngraveJob['stock']> = {}): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { ...job.stock, ...stock };
  return job;
}

function dowelJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { jawDiameter: null, stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [],
  } as EngraveJob;
}

const PART: PartFootprint = { kind: 'mesh', length: 65, width: 62.7, height: 19.1 };

function renderStep(job: EngraveJob, reads: 'along' | 'around' | null = null, onReads = vi.fn()): void {
  const noop = (): void => undefined;
  render(
    <HoldingStep
      job={job}
      answers={defaultSetupAnswers(job)}
      part={PART}
      reads={reads}
      onReads={onReads}
      onAnswers={noop}
      onRotary={noop}
      onBedHold={noop}
      onHold={noop}
      onMoveItemsToTop={noop}
    />,
  );
}

/** The three places a mount's own vocabulary lives, joined for one scoped assertion. */
function scopedText(mount: string): string {
  const row = screen.getByTestId(`engrave-setup-mount-row-${mount}`);
  const fold = screen.getByTestId('engrave-setup-hold-fold');
  const picture = screen.getByTestId('engrave-setup-holding-picture');
  return [row.textContent, fold.textContent, picture.textContent].join(' ');
}

beforeEach(() => {
  cleanup();
  caps.drive = true;
  resetLocationStore();
});
afterEach(() => cleanup());

describe('#1101 the Holding step speaks its mount', () => {
  it('vise: no chuck and no anchor in the selected row, the fold or the picture', () => {
    seedLocation(viseMachine());
    renderStep(dj({ length: 100, width: 60, thickness: 12 }));
    const text = scopedText('ledge');
    expect(text).toMatch(/jaw/i); // the vise's own words are there…
    expect(text).not.toMatch(/chuck/i);
    expect(text).not.toMatch(/anchor/i);
  });

  it('tape: no jaw, no proud, no shipped dimensions in the selected row, the fold or the picture', () => {
    seedLocation(bedMachine());
    // A 6 mm plate opens on the bracket; choose the tape row.
    renderStep(dj({ length: 100, width: 60, thickness: 6 }));
    actRtl(() => {
      screen.getByTestId('engrave-setup-mount-bed-tape').click();
    });
    // The direct render's parent does not store the answer, so re-render as the shell would.
    cleanup();
    seedLocation(bedMachine());
    const taped = {
      ...dj({ length: 100, width: 60, thickness: 6 }),
      workholding: {
        kind: 'tape' as const,
        tape: {
          width: 20,
          thickness: 0.2,
          inset: 2,
          where: null,
          squareTo: 'fence' as const,
          fence: { kind: 'bracket' as const, anchor: 1 as const, variant: 'thin', edges: 'corner' as const },
          source: 'saved' as const,
        },
      },
    };
    renderStep(taped);
    const text = scopedText('bed-tape');
    expect(text).not.toMatch(/jaw/i);
    expect(text).not.toMatch(/proud/i);
    expect(text).not.toMatch(/shipped/i);
    // Item 4 — no vise recommendation line on a taped job.
    expect(screen.queryByTestId('engrave-setup-recommendation-reason')).toBeNull();
  });

  it('rotary: Chuck end and Text reads, no hold cards and no fixed jaw', () => {
    seedLocation(rotaryMachine(), [...DOC.accessories, ROTARY]);
    const onReads = vi.fn();
    renderStep(dowelJob(), 'along', onReads);

    expect(screen.queryByTestId('engrave-setup-orientation-holds')).toBeNull();
    const text = scopedText('rotary');
    expect(text).not.toMatch(/fixed jaw/i);
    expect(screen.getByTestId('engrave-setup-rotary-chuck-end').textContent).toContain('Chuck end');
    expect((screen.getByTestId('engrave-setup-rotary-reads-along') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-setup-rotary-reads-around') as HTMLInputElement).checked).toBe(false);
    // The rotary's own field says "Chuck jaws", so "jaws" never names two things on the page.
    expect(screen.getAllByText('Chuck jaws').length).toBeGreaterThan(0);
  });
});
