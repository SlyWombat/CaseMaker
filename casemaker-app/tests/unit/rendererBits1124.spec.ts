// #1124 — the planner's browser requirement, at the seam: a 32-bit bitness refuses before any
// probe; a renderer whose probe cannot reserve the planner's floor refuses too; a 64-bit browser
// whose probe passes generates as before.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_32_BIT_SENTENCE,
  PLANNER_PEAK_FLOOR_MB,
  PROBE_CHUNK_MB,
  detectRendererRefusal,
  getRendererVerdict,
  probeAddressSpace,
  readRendererBitness,
  resetRendererCheck,
  startRendererCheck,
  subscribeRendererVerdict,
  type NavigatorLike,
  type ProbeResult,
  type RendererVerdict,
} from '@/engine/cnc/rendererBits';

/** A navigator whose UAData answers the two hints the check asks for. */
function navWithBitness(bitness: string | null): NavigatorLike {
  return {
    userAgentData: {
      getHighEntropyValues: async () =>
        bitness === null ? {} : { bitness, architecture: bitness === '32' ? 'x86' : 'arm' },
    },
  };
}

const passed = (): ProbeResult => ({ ok: true, reservedMb: PLANNER_PEAK_FLOOR_MB, failedAtMb: null });
const failed = (): ProbeResult => ({ ok: false, reservedMb: 96, failedAtMb: 104 });

/** The next verdict the page publishes — set up before the start call it waits for. */
function nextVerdict(): Promise<RendererVerdict> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeRendererVerdict(() => {
      unsubscribe();
      resolve(getRendererVerdict());
    });
  });
}

afterEach(() => resetRendererCheck());

describe('#1124 — a 32-bit renderer is refused before Generate', () => {
  it('bitness 32 refuses with the plain sentence, and never runs the probe', async () => {
    let probed = false;
    const refusal = await detectRendererRefusal(navWithBitness('32'), () => {
      probed = true;
      return passed();
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('browser-32-bit');
    expect(refusal!.sentence).toBe(BROWSER_32_BIT_SENTENCE);
    expect(refusal!.sentence).toBe('This browser is 32-bit; the planner needs a 64-bit browser');
    // Asking a hopeless renderer for another 704 MiB would be the only thing left to learn: nothing.
    expect(probed).toBe(false);
  });

  it('the page verdict goes checking → unsupported and the panel reads the refusal', async () => {
    const verdict = nextVerdict();
    startRendererCheck(navWithBitness('32'), passed);
    expect((await verdict).state).toBe('unsupported');
    expect(getRendererVerdict().refusal?.sentence).toBe(BROWSER_32_BIT_SENTENCE);
  });
});

describe('#1124 — the probe catches an address-limited renderer', () => {
  it('bitness 64 whose probe cannot reserve the floor is refused', async () => {
    const refusal = await detectRendererRefusal(navWithBitness('64'), failed);
    expect(refusal?.code).toBe('browser-32-bit');
    expect(refusal?.sentence).toBe(BROWSER_32_BIT_SENTENCE);
  });

  it('a browser that cannot state its bitness still passes when the probe reserves the floor', async () => {
    const refusal = await detectRendererRefusal(navWithBitness(null), passed);
    expect(refusal).toBeNull();
  });

  it('bitness 64 whose probe passes is not refused', async () => {
    expect(await detectRendererRefusal(navWithBitness('64'), passed)).toBeNull();
  });
});

describe('#1124 — the probe reserves the floor in chunks and releases them', () => {
  it('allocates floor/chunk buffers and reports the floor', () => {
    const sizes: number[] = [];
    const result = probeAddressSpace({
      floorMb: 32,
      chunkMb: 8,
      allocate: (bytes) => {
        sizes.push(bytes);
        return new ArrayBuffer(0);
      },
    });
    expect(result).toEqual({ ok: true, reservedMb: 32, failedAtMb: null });
    expect(sizes).toEqual(Array(4).fill(8 * 1024 * 1024));
  });

  it('a failed allocation reports where it stopped and still releases what it held', () => {
    let calls = 0;
    const result = probeAddressSpace({
      floorMb: 32,
      chunkMb: 8,
      allocate: () => {
        calls++;
        if (calls > 3) throw new RangeError('Array buffer allocation failed');
        return new ArrayBuffer(0);
      },
    });
    expect(result).toEqual({ ok: false, reservedMb: 24, failedAtMb: 32 });
  });

  it('the floor is the measured ball-rank peak and the chunk is the plan-scale buffer', () => {
    expect(PLANNER_PEAK_FLOOR_MB).toBe(704);
    expect(PROBE_CHUNK_MB).toBe(8);
  });
});

describe('#1124 — the browser bitness reader', () => {
  it('answers null when the browser has no userAgentData (Firefox, Safari, jsdom)', async () => {
    expect(await readRendererBitness({})).toBeNull();
    expect(await readRendererBitness(null)).toBeNull();
  });

  it('answers null when getHighEntropyValues rejects', async () => {
    const nav: NavigatorLike = {
      userAgentData: {
        getHighEntropyValues: async () => {
          throw new Error('denied');
        },
      },
    };
    expect(await readRendererBitness(nav)).toBeNull();
  });

  it('reads the bitness string the browser states', async () => {
    expect(await readRendererBitness(navWithBitness('32'))).toBe('32');
    expect(await readRendererBitness(navWithBitness('64'))).toBe('64');
    expect(await readRendererBitness(navWithBitness('arm'))).toBeNull();
  });
});
