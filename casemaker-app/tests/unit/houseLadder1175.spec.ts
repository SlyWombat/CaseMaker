/**
 * #1175 — THE HOUSE GENERATE PATH CARRIES THE BROWSER'S OWN INPUTS.
 *
 * #1046's "Measure the standard balls" press asks the owned plan for the rungs by passing
 * `restLadder: true` as the tenth argument of `client.engraveGenerate`; the eighth is the app's
 * whole tool library (the ideal plan's candidate set). Before #1175 the house wrapper accepted
 * only the first seven arguments, so on a service that CAN generate both were silently dropped:
 * the ladder press asked for nothing and the ideal planned from the service's own disk snapshot.
 *
 * RED FIRST: this file shipped as `it.fails` while the gap existed. #1175 forwards both — the
 * wrapper hands all ten arguments of the browser call, the submit carries `restLadder` and
 * `tools`, `runs.rs` writes `tools.json` and passes `--rest-ladder` / `--tools` to the CLI, and
 * the CLI uses the list verbatim (its own registry only when none was sent). The assertions below
 * are the fix's pin: a regression that drops either argument fails this file.
 */
import { describe, expect, it, vi } from 'vitest';

/** Every argument object the house path hands the service, in call order. */
const houseCalls: Array<Record<string, unknown>> = [];

vi.mock('@/platform/houseGenerate', () => ({
  // The service reports `runs: true`, so the run store takes the house branch.
  houseGenerationAvailable: async () => true,
  houseEngraveGenerate: async (args: Record<string, unknown>) => {
    houseCalls.push(args);
    return {
      ok: true,
      stage: 'done',
      findings: [],
      feeds: null,
      threads: null,
      cam: null,
      verify: null,
      surface3d: null,
      frameNc: null,
      frameVerify: null,
      facingNc: null,
      facingVerify: null,
      facingToolKey: null,
      facingError: null,
      facingCam: null,
      predicted: [],
      programs: [],
      errors: [],
      nc: ';@MKR|BEGIN\nG21 G90\nM02',
    };
  },
  cancelActiveHouseRun: () => {},
}));

import { setEngraveRunClientLoader, useEngraveRunStore } from '@/store/engraveRunStore';
import { getTools } from '@/engine/cnc/toolRegistry';
import { useSimStore } from '@/store/simStore';
import type { SimLoadOk } from '@/workers/sim/session';
import { beforeEach as beforeEachSettled } from 'vitest';
import { settleShopSettings } from '../tools/settledShop';

// #1276 — Generate waits for / refuses without the shop's settings: these specs run with them settled.
beforeEachSettled(() => settleShopSettings());

function swept(over: Partial<SimLoadOk> = {}): SimLoadOk {
  return {
    ok: true,
    diagnostics: [],
    summary: { rotary: false },
    stats: { engine: 'exact', removedVolume: 0 },
    count: 1,
    meshes: { removal: null },
    ...over,
  } as unknown as SimLoadOk;
}

describe('#1175 the house generate path forwards the browser’s inputs', () => {
  it('the ladder press and the tool list reach the house service', async () => {
    setEngraveRunClientLoader(async () => ({
      // The house branch replaces engraveGenerate; the browser client keeps the sim/oracle.
      simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }) as never,
    }) as never);
    const realLoad = useSimStore.getState().loadProgram;
    useSimStore.setState({
      loadProgram: async () => {
        useSimStore.setState({ status: 'ready', diagnostics: [], pathOnly: false });
        return swept();
      },
    });
    try {
      await useEngraveRunStore.getState().generate(null, { restLadder: true });
      expect(houseCalls.length, 'the house path was chosen and asked once').toBe(1);
      // The tenth argument (the ladder press) and the eighth (the app's tool library, the ideal's
      // candidate set) both ride the submit now.
      expect(houseCalls[0]!.restLadder, 'the ladder press must reach the house service (#1175)').toBe(true);
      expect(houseCalls[0]!.catalogueTools, 'the tools argument must reach the house service (#1175)').toEqual(
        getTools().map((entry) => entry.tool),
      );
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  }, 60_000);
});
