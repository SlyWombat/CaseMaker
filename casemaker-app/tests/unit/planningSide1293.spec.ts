/**
 * #1293 — THE PAGE SAYS WHICH SIDE PLANS. A house whose health says `runs: false` used to send every
 * Generate to the page's own worker in silence. Now the run's own progress line (and so its log) says
 * "Planning in this page — the house can't run jobs yet: <the service's reason>." or "Planning on the
 * house.", once per run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/houseClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/houseClient')>()),
  probeHouse: vi.fn(),
}));

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { houseGenerationStatus } from '@/platform/houseGenerate';
import { probeHouse } from '@/platform/houseClient';
import { setEngraveRunClientLoader, useEngraveRunStore } from '@/store/engraveRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { settleShopSettings } from '../tools/settledShop';

const REFUSED = { ok: false, stage: 'cam', findings: [], errors: [{ stage: 'cam', message: 'test: nothing to plan' }], programs: [], nc: null } as unknown as EngraveGenerated;
const probe = vi.mocked(probeHouse);
const REASON = "the house's Node is not at /usr/bin/node — set CASEMAKER_NODE to the node binary, or install the house package";

beforeEach(() => {
  useEngraveRunStore.getState().reset();
  useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-1.0' } });
  settleShopSettings('present', {}, '"e1"');
  setEngraveRunClientLoader(async () => ({ engraveGenerate: async () => REFUSED }) as never);
});
afterEach(() => {
  setEngraveRunClientLoader(null);
  useEngraveRunStore.getState().reset();
  probe.mockReset();
});

describe('#1293 houseGenerationStatus', () => {
  it('names the service reason when runs is false', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: false, runsReason: `${REASON}.` } as never, base: '' });
    expect(await houseGenerationStatus()).toEqual({
      available: false,
      sentence: `Planning in this page — the house can't run jobs yet: ${REASON}.`,
    });
  });
  it('says so without a reason from an older service, and when no house answers', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: false } as never, base: '' });
    expect((await houseGenerationStatus()).sentence).toBe("Planning in this page — the house can't run jobs yet.");
    probe.mockResolvedValue({ kind: 'absent', reason: 'none' });
    expect((await houseGenerationStatus()).sentence).toBe('Planning in this page — no house answered.');
  });
  it('says the house plans when runs is true', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: true } as never, base: '' });
    expect(await houseGenerationStatus()).toEqual({ available: true, sentence: 'Planning on the house.' });
  });
});

describe('#1293 the run says which side plans, once', () => {
  it('a Generate against a house that cannot run logs the reason', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: false, runsReason: REASON } as never, base: '' });
    await useEngraveRunStore.getState().generate();
    const said = useEngraveRunStore.getState().log.filter((l) => l.label.startsWith('Planning'));
    expect(said.map((l) => l.label)).toEqual([`Planning in this page — the house can't run jobs yet: ${REASON}.`]);
  });
});
