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
  it('a service that sent a code: the operator line is fixed, the service sentence is the detail', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: false, runsReason: REASON, runsReasonCode: 'node-missing' } as never, base: '' });
    expect(await houseGenerationStatus()).toEqual({
      available: false,
      sentence: "Planning in this page — this house's install cannot plan jobs.",
      detail: REASON,
    });
  });
  it('an older service (no code), and no house at all, keep their plain sentences', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: false } as never, base: '' });
    expect(await houseGenerationStatus()).toEqual({ available: false, sentence: "Planning in this page — the house can't run jobs yet." });
    probe.mockResolvedValue({ kind: 'absent', reason: 'none' });
    expect((await houseGenerationStatus()).sentence).toBe('Planning in this page — no house answered.');
  });
  it('says the house plans when runs is true', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: true } as never, base: '' });
    expect(await houseGenerationStatus()).toEqual({ available: true, sentence: 'Planning on the house.' });
  });
});

describe('#1293 the run says which side plans, once', () => {
  it('the progress line gets the operator sentence; the Log gets it and then the service sentence verbatim', async () => {
    probe.mockResolvedValue({ kind: 'present', health: { runs: false, runsReason: REASON, runsReasonCode: 'node-missing' } as never, base: '' });
    await useEngraveRunStore.getState().generate();
    const labels = useEngraveRunStore.getState().log.map((l) => l.label);
    const at = labels.indexOf("Planning in this page — this house's install cannot plan jobs.");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(labels[at + 1]).toBe(REASON);
    expect(labels.filter((l) => l.startsWith('Planning'))).toHaveLength(1);
  });
});
