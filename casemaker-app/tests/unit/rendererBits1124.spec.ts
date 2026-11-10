// #1124 — the planner's browser requirement, at the seam: a 32-bit bitness refuses before any
// probe; a renderer whose probe cannot reserve the planner's floor refuses too; a 64-bit browser
// whose probe passes generates as before.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_32_BIT_SENTENCE,
  BROWSER_MEMORY_SHORT_WARNING,
  clearRendererWarning,
  PLANNER_PEAK_FLOOR_MB,
  PROBE_CHUNK_MB,
  getRendererVerdict,
  probeAddressSpace,
  readRendererBitness,
  recheckRendererForGenerate,
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
  it('the page verdict goes checking → unsupported and the panel reads the refusal', async () => {
    const verdict = nextVerdict();
    startRendererCheck(navWithBitness('32'), passed);
    expect((await verdict).state).toBe('unsupported');
    expect(getRendererVerdict().refusal?.sentence).toBe(BROWSER_32_BIT_SENTENCE);
  });
});

describe('#1124 — a failed startup probe is retried, and the press is the verdict (landing ruling)', () => {
  const noWait = async (): Promise<void> => {};

  it('a first startup attempt that fails and a retry that passes leaves the verdict ok', async () => {
    let attempts = 0;
    const probe = (): ProbeResult => {
      attempts++;
      return attempts === 1 ? failed() : passed();
    };
    const verdict = nextVerdict();
    startRendererCheck(navWithBitness('64'), probe, { wait: noWait });
    const landed = await verdict;
    expect(attempts).toBe(2);
    expect(landed.state).toBe('ok');
    expect(landed.refusal).toBeNull();
  });

  it('both startup attempts failing is NOT a refusal: the verdict stays checking and Generate stays available', async () => {
    let attempts = 0;
    const probe = (): ProbeResult => {
      attempts++;
      return failed();
    };
    const verdict = nextVerdict();
    startRendererCheck(navWithBitness('64'), probe, { wait: noWait });
    const landed = await verdict;
    expect(attempts).toBe(2);
    expect(landed.state).toBe('checking');
    expect(landed.refusal).toBeNull();
    expect(getRendererVerdict()).toEqual({ state: 'checking', refusal: null, warning: null });
  });

  it('the press probe WARNS on a failed reservation and never refuses (the landing ruling)', async () => {
    // The startup left 'checking' (both attempts failed); the press asks the renderer again.
    startRendererCheck(navWithBitness('64'), failed, { wait: noWait });
    await nextVerdict();
    const refusal = await recheckRendererForGenerate(navWithBitness('64'), failed);
    expect(refusal).toBeNull();
    const landed = getRendererVerdict();
    expect(landed.refusal).toBeNull();
    expect(landed.state).toBe('checking');
    expect(landed.warning).toBe(BROWSER_MEMORY_SHORT_WARNING);
  });

  it('#1123-52 — the press warning is cleared for the next screen, and only the warning', async () => {
    startRendererCheck(navWithBitness('64'), failed, { wait: noWait });
    await nextVerdict();
    await recheckRendererForGenerate(navWithBitness('64'), failed);
    expect(getRendererVerdict().warning).toBe(BROWSER_MEMORY_SHORT_WARNING);
    clearRendererWarning();
    expect(getRendererVerdict()).toEqual({ state: 'checking', refusal: null, warning: null });
  });

  it('the press re-probe that passes clears the page to ok', async () => {
    startRendererCheck(navWithBitness('64'), failed, { wait: noWait });
    await nextVerdict();
    const refusal = await recheckRendererForGenerate(navWithBitness('64'), passed);
    expect(refusal).toBeNull();
    expect(getRendererVerdict()).toEqual({ state: 'ok', refusal: null, warning: null });
  });

  it('bitness 32 refuses at startup AND at the press, and neither runs the probe', async () => {
    let probed = 0;
    const probe = (): ProbeResult => {
      probed++;
      return passed();
    };
    const verdict = nextVerdict();
    startRendererCheck(navWithBitness('32'), probe, { wait: noWait });
    expect((await verdict).refusal?.sentence).toBe(BROWSER_32_BIT_SENTENCE);
    const press = await recheckRendererForGenerate(navWithBitness('32'), probe);
    expect(press?.sentence).toBe(BROWSER_32_BIT_SENTENCE);
    expect(probed).toBe(0);
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
    expect(PLANNER_PEAK_FLOOR_MB).toBe(454);
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
