// @vitest-environment jsdom
// #827 — the Register step's centre section: it offers the routine only to a measured 3D probe,
// with the feature choice and a search radius, and says why when the tip is unmeasured.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EngraveCentreFind } from '@/components/panels/EngraveCentreFind';
import type { ProbeSpec, RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';

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
} as unknown as RegistrationSettings;

afterEach(cleanup);

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
