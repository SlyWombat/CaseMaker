/**
 * #1175 — RED FIRST: THE HOUSE GENERATE PATH DROPS THE LADDER.
 *
 * #1046's "Measure the standard balls" press asks the owned plan for the rungs by passing
 * `restLadder: true` as the tenth argument of `client.engraveGenerate`. When #1126's house path is
 * available the run store swaps in a wrapper (`engraveRunStore.ts`, the `houseGenerationAvailable()`
 * branch) that accepts only the first seven arguments and never forwards `restLadder` (nor the
 * tools list) to `houseEngraveGenerate`; the service's own submit (`runs.rs` / `runsClient.ts`) has
 * no ladder parameter either. So on a service that CAN generate, the press silently asks for
 * nothing — the sentence's promise and the posted plan disagree.
 *
 * This test is marked `it.fails` ON PURPOSE: it pins the gap and names the issue. When #1175 is
 * fixed (the ladder forwarded end to end — browser wrapper, submit body, CLI flag), the assertion
 * below starts passing and vitest fails this `it.fails`, which is the signal to flip it to a plain
 * `it`. No known-red test ships as a plain red — this is the recorded exception, in the suite
 * rather than in a note.
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
import { useSimStore } from '@/store/simStore';
import type { SimLoadOk } from '@/store/simStore';

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

describe('#1175 the house generate path forwards the ladder', () => {
  it.fails('the ladder press reaches the house service with restLadder: true', async () => {
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
      // TODAY THIS FAILS: the wrapper drops the tenth argument and the service has no field for it.
      expect(houseCalls[0]!.restLadder, 'the ladder press must reach the house service (#1175)').toBe(true);
    } finally {
      useSimStore.setState({ loadProgram: realLoad });
    }
  }, 60_000);
});
