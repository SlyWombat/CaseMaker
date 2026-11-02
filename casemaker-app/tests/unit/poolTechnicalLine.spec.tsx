// @vitest-environment jsdom
// Issue #881 — the level pool on the run's Technical line.
//
// The line states the pool's own answer: how many planners ran, and which limit set the number
// (the memory, or the machine's cores). It is absent until a budgeted run has planned, so a
// raster job and a job with nothing generated show no line at all.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PoolTechnicalLine } from '@/components/panels/PoolTechnicalLine';
import type { PoolSizing } from '@/engine/jobs/poolSizing';

const MiB = 1024 * 1024;

const sizing: PoolSizing = {
  planners: 2,
  coreCap: 7,
  budgetBytes: 640 * MiB,
  parentBytes: 200 * MiB,
  levelBytes: 100 * MiB,
};

afterEach(cleanup);

describe('#881 — the pool’s Technical line', () => {
  it('says how many planners ran and which limit set the number', () => {
    render(<PoolTechnicalLine sizing={sizing} />);
    expect(screen.getByTestId('engrave-pool-technical').textContent).toBe(
      'Planned on 2 workers: the memory allows 2 of 7.',
    );
  });

  it('says the cores set the number when the memory left room for every one', () => {
    render(<PoolTechnicalLine sizing={{ ...sizing, planners: 7 }} />);
    expect(screen.getByTestId('engrave-pool-technical').textContent).toBe(
      'Planned on 7 workers (the machine’s cores allow no more).',
    );
  });

  it('is absent when no budgeted run has planned', () => {
    render(<PoolTechnicalLine sizing={null} />);
    expect(screen.queryByTestId('engrave-pool-technical')).toBeNull();
  });
});
