// @vitest-environment jsdom
// #827 — the Register step's centre section: it offers the routine only to a measured 3D probe,
// with the feature choice and a search radius, and says why when the tip is unmeasured.

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveCentreFind } from '@/components/panels/EngraveCentreFind';
import type { ProbeSpec, RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
import { planCentreFind } from '@/engine/cnc/registration/centreFind';
import { dryCentreFind } from '@/engine/cnc/registration/dryRun';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { MachineRecordSchema, type LocationView } from '@/platform/locationClient';

const TARGET = { host: '192.0.2.10', port: 2222 };

const PROBE: ProbeSpec = {
  id: 'fx-probe-3d',
  variant: '3d',
  instrument: 'xyz',
  tip: { diameterMm: 2, rimOffsetMm: 0.875, rimOffsetUncertaintyMm: 0.01 },
};

const PLAN = {
  mount: 'tape',
  stock: { xMin: 0, yMin: 0, xMax: 40, yMax: 30 },
  surfacePoint: { x: 20, y: 15 },
  stockThicknessMm: 5,
  seek: { fromMachineZ: -3, band: { min: -6, max: -4 } },
  probe: PROBE,
} as unknown as RegistrationPlan;

const SETTINGS = {
  touchFeed: 150,
  surfaceSlowFeed: 150,
  parkAboveSurfaceMm: 2,
  // #1211 field 5 — the panel resolves the find's hold from these; a cast fixture must state them.
  tipRadiusMm: 0.875,
  edgeBandMm: 4,
  probeFootprintShrinkMm: 3,
} as unknown as RegistrationSettings;

afterEach(() => {
  cleanup();
  resetLocationStore();
});

describe('#827 the centre section', () => {
  it('offers the feature choice, the search and the find action to a measured 3D probe', () => {
    render(<EngraveCentreFind target={TARGET} plan={PLAN} settings={SETTINGS} probe={PROBE} />);
    expect(screen.getByTestId('engrave-centre')).toBeTruthy();
    expect(screen.getByTestId('engrave-centre-kind')).toBeTruthy();
    expect(screen.getByTestId('engrave-centre-search')).toBeTruthy();
    expect((screen.getByTestId('engrave-centre-find') as HTMLButtonElement).disabled).toBe(false);
  });

  it('draws nothing for a wired probe', () => {
    const wired: ProbeSpec = { id: 'fx-probe', variant: null, instrument: 'z-only', tip: PROBE.tip };
    render(<EngraveCentreFind target={TARGET} plan={PLAN} settings={SETTINGS} probe={wired} />);
    expect(screen.queryByTestId('engrave-centre')).toBeNull();
  });

  it('says to measure the tip when the 3D probe has none', () => {
    const bare: ProbeSpec = { ...PROBE, tip: null };
    render(<EngraveCentreFind target={TARGET} plan={PLAN} settings={SETTINGS} probe={bare} />);
    expect(screen.getByTestId('engrave-centre-no-tip').textContent).toContain('no measured tip');
    expect(screen.queryByTestId('engrave-centre-find')).toBeNull();
  });
});

/** The plan and options the card will build for PROBE/PLAN/SETTINGS — for the identity fixtures. */
async function cardDry() {
  const made = planCentreFind({
    kind: 'bore',
    at: { x: 20, y: 15 },
    searchMm: 8, // the card's default: round(min(40, 30) / 4)
    maxSearchMm: 60, // registration.centreSearchMaxMm's recommendation
    ballRadiusMm: 0.875,
    stockThicknessMm: 5,
    touchFeed: 150,
  });
  if (!made.ok) throw new Error(made.reason);
  return dryCentreFind({
    plan: made.plan,
    seekFromMachineZ: -3,
    bandMm: { min: -6, max: -4 },
    surfaceFeed: 150,
    parkAboveSurfaceMm: 2,
    probeTouches: 'all',
    hold: {
      footprint: { xMin: -1000, yMin: -1000, xMax: 1000, yMax: 1000 },
      marginMm: 1,
      bandMm: 4,
      bodyRadiusMm: 1,
      expectedRadiusMm: null,
      obstacles: [],
    },
    topTouchAt: { x: 30, y: 15 },
  });
}

describe('#1202 — the centre find’s first-run mark', () => {
  it('marks an unrun routine and holds the press until its own statement is ticked', async () => {
    render(<EngraveCentreFind target={TARGET} plan={PLAN} settings={SETTINGS} probe={PROBE} />);
    await act(async () => {}); // the dry preview resolves off the executor
    expect(screen.getByTestId('engrave-registration-routine').getAttribute('data-routine')).toBe('centre-find');
    expect(screen.getByTestId('engrave-registration-first-run').textContent).toContain('has not run on this machine before');
    const find = screen.getByTestId('engrave-centre-find') as HTMLButtonElement;
    expect(find.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-registration-first-run-tick'));
    expect(find.disabled).toBe(false);
  });

  it('does not mark a shape this machine has already completed', async () => {
    const dry = await cardDry();
    const record = MachineRecordSchema.parse({
      id: 'm-1',
      address: { host: TARGET.host, port: TARGET.port },
      updatedAt: '2026-11-11T09:00:00.000Z',
      completedRoutines: [
        { routine: 'centre-find', shape: dry.identity.shape, at: '2026-11-11T09:00:00.000Z', build: { version: '1.0.0', commit: null } },
      ],
    });
    useLocationStore.setState({
      status: 'present',
      etag: '"e1"',
      reason: null,
      location: {
        kind: 'casemaker-location',
        schemaVersion: 1,
        id: 'loc-1',
        name: 'QA',
        createdAt: '2026-11-11T00:00:00.000Z',
        machines: [record],
        accessories: [],
      } as unknown as LocationView,
    });
    render(<EngraveCentreFind target={TARGET} plan={PLAN} settings={SETTINGS} probe={PROBE} />);
    await act(async () => {});
    expect(screen.queryByTestId('engrave-registration-first-run')).toBeNull();
    expect((screen.getByTestId('engrave-centre-find') as HTMLButtonElement).disabled).toBe(false);
  });
});
