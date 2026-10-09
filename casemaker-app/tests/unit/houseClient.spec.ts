// The house service client (#306, tracking #212). The REAL client — URL building, the JSON check,
// the schema check, the ETag round trip — driven against a stubbed `fetch`, because a fetch stub is
// the only part a unit test cannot have real. The trap under test is the one that makes this module
// worth having: the embedded server answers unknown paths with `index.html` and status 200.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  houseBaseUrl,
  houseFeeds,
  houseTools,
  probeHouse,
  setHouseClientLoader,
  HOUSE_API_PATH,
  HOUSE_SCHEMA_VERSION,
  type HouseClient,
} from '@/platform/houseClient';

const BASE = 'http://127.0.0.1:8000';

beforeEach(() => {
  setHouseClientLoader(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One canned response, recorded so a test can assert the request as well as the answer. */
interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(
  answer: (url: string) => { status?: number; contentType?: string; body?: string; etag?: string },
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    const a = answer(String(url));
    const headers = new Headers();
    if (a.contentType) headers.set('content-type', a.contentType);
    if (a.etag) headers.set('etag', a.etag);
    const status = a.status ?? 200;
    // A 304 may not carry a body at all — the Response constructor refuses one, which is the
    // behaviour a browser has too.
    return new Response(status === 304 ? null : (a.body ?? ''), { status, headers });
  });
  return calls;
}

const HEALTH = {
  ok: true,
  schemaVersion: HOUSE_SCHEMA_VERSION,
  hasCatalogue: false,
  feedRows: 0,
  catalogueSyncedAt: null,
  problems: [],
};

/** One entry in the shape the service serves — every field explicit, nulls included. */
const ENTRY = {
  key: 'user:1a2b3c4d5e',
  provenance: 'typed in by hand',
  tool: {
    number: null,
    id: null,
    name: '2 mm flat end',
    typeText: 'Flat End',
    shape: 'flat',
    handleDiameter: null,
    tipDiameter: 2,
    diameter: 2,
    cornerRadius: 0,
    angle: null,
    halfAngle: null,
    fluteLength: null,
    shoulderLength: 12,
    stickout: null,
    centreCutting: null,
  },
};

describe('houseBaseUrl', () => {
  it('is this page’s own origin, and empty when there is no page', () => {
    // Node has no `location`: a relative URL, and a probe that honestly finds nothing.
    expect(houseBaseUrl()).toBe('');
    vi.stubGlobal('location', { origin: BASE });
    expect(houseBaseUrl()).toBe(BASE);
    // An opaque origin (`file://`) reports the literal string "null"; `null/api/v1/health` is not
    // a URL worth building.
    vi.stubGlobal('location', { origin: 'null' });
    expect(houseBaseUrl()).toBe('');
  });
});

describe('probeHouse', () => {
  it('is present when the origin serves the house health as JSON', async () => {
    const calls = stubFetch(() => ({ contentType: 'application/json', body: JSON.stringify(HEALTH) }));
    const probe = await probeHouse({ base: BASE });
    expect(probe).toEqual({ kind: 'present', health: HEALTH, base: BASE });
    expect(calls[0]!.url).toBe(`${BASE}${HOUSE_API_PATH}/health`);
    expect(calls[0]!.headers.Accept).toBe('application/json');
  });

  it('is absent — not present — when an HTML 200 answers', async () => {
    // The SPA fallback: the embedded server answers an unknown path with index.html and 200. A
    // client that read the status alone would populate the registry from a web page.
    stubFetch(() => ({ contentType: 'text/html', body: '<!doctype html><title>Case Maker</title>' }));
    const probe = await probeHouse({ base: BASE });
    expect(probe.kind).toBe('absent');
    if (probe.kind !== 'absent') throw new Error('unreachable');
    expect(probe.reason).toContain('text/html');
    expect(probe.reason).toContain(BASE);
  });

  it('is absent when a static host answers 404', async () => {
    stubFetch(() => ({ status: 404, contentType: 'text/html', body: 'not found' }));
    expect((await probeHouse({ base: BASE })).kind).toBe('absent');
  });

  it('is an error when the service speaks a version this build does not read', async () => {
    stubFetch(() => ({
      contentType: 'application/json',
      body: JSON.stringify({ ...HEALTH, schemaVersion: HOUSE_SCHEMA_VERSION + 1 }),
    }));
    const probe = await probeHouse({ base: BASE });
    expect(probe.kind).toBe('error');
    if (probe.kind !== 'error') throw new Error('unreachable');
    expect(probe.detail).toContain(`version ${HOUSE_SCHEMA_VERSION + 1}`);
    expect(probe.detail).toContain(`reads version ${HOUSE_SCHEMA_VERSION}`);
  });

  it('is an error when the JSON is not a health report', async () => {
    stubFetch(() => ({ contentType: 'application/json', body: '{"hello":"world"}' }));
    expect((await probeHouse({ base: BASE })).kind).toBe('error');
  });

  it('is an error — and never throws — when nothing answers at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const probe = await probeHouse({ base: BASE });
    expect(probe.kind).toBe('error');
    if (probe.kind !== 'error') throw new Error('unreachable');
    expect(probe.detail).toContain('fetch failed');
  });

  it('gives up rather than hanging on a socket that never answers', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const probe = await probeHouse({ base: BASE, timeoutMs: 10 });
    expect(probe.kind).toBe('error');
    if (probe.kind !== 'error') throw new Error('unreachable');
    expect(probe.detail).toContain('no answer within 10 ms');
  });
});

describe('houseTools', () => {
  it('reads a list, keeps its validator, and refuses to send one it does not have', async () => {
    const calls = stubFetch(() => ({
      contentType: 'application/json',
      body: JSON.stringify([ENTRY]),
      etag: '"fnv1a-abc"',
    }));
    const read = await houseTools(null, { base: BASE });
    expect(read).toEqual({ kind: 'ok', etag: '"fnv1a-abc"', entries: [ENTRY] });
    expect(calls[0]!.headers['If-None-Match']).toBeUndefined();

    // The second read offers the validator it was given, and a 304 means the caller keeps what it
    // has — which is the whole reason the ETag is worth carrying.
    const again = await houseTools('"fnv1a-abc"', { base: BASE });
    expect(calls[1]!.headers['If-None-Match']).toBe('"fnv1a-abc"');
    expect(again).toEqual({
      kind: 'ok',
      etag: '"fnv1a-abc"',
      entries: [ENTRY],
    });

    stubFetch(() => ({ status: 304 }));
    expect(await houseTools('"fnv1a-abc"', { base: BASE })).toEqual({ kind: 'unchanged' });
  });

  it('is absent when a page answers, and an error when the list is the wrong shape', async () => {
    stubFetch(() => ({ contentType: 'text/html', body: '<!doctype html>' }));
    expect((await houseTools(null, { base: BASE })).kind).toBe('absent');

    // One bad entry is refused whole: the SAME schema the built-in list is written to (#305), so a
    // duplicate key is a refusal whoever sent it.
    stubFetch(() => ({ contentType: 'application/json', body: JSON.stringify([ENTRY, ENTRY]) }));
    const read = await houseTools(null, { base: BASE });
    expect(read.kind).toBe('error');
    if (read.kind !== 'error') throw new Error('unreachable');
    expect(read.detail).toContain('duplicate tool key');
  });

  it('refuses a tool missing a field it must state', async () => {
    const { shape, ...withoutShape } = ENTRY.tool;
    void shape;
    stubFetch(() => ({
      contentType: 'application/json',
      body: JSON.stringify([{ ...ENTRY, tool: withoutShape }]),
    }));
    const read = await houseTools(null, { base: BASE });
    expect(read.kind).toBe('error');
    if (read.kind !== 'error') throw new Error('unreachable');
    expect(read.detail).toContain('shape');
  });
});

describe('houseFeeds (#310)', () => {
  const ROW = {
    cutterId: '112111313812',
    material: 'Hardwood',
    rpm: 12000,
    feed: 900,
    plungeFeed: 300,
    stepDown: 1.2,
  };

  it('reads the rows, carries the validator, and treats a 304 as unchanged', async () => {
    const calls = stubFetch(() => ({
      contentType: 'application/json',
      body: JSON.stringify([ROW]),
      etag: '"fnv1a-feed"',
    }));
    expect(await houseFeeds(null, { base: BASE })).toEqual({
      kind: 'ok',
      etag: '"fnv1a-feed"',
      rows: [ROW],
    });
    expect(calls[0]!.url).toBe(`${BASE}${HOUSE_API_PATH}/feeds`);
    expect(calls[0]!.headers['If-None-Match']).toBeUndefined();

    expect(await houseFeeds('"fnv1a-feed"', { base: BASE })).toMatchObject({ kind: 'ok' });
    expect(calls[1]!.headers['If-None-Match']).toBe('"fnv1a-feed"');

    stubFetch(() => ({ status: 304 }));
    expect(await houseFeeds('"fnv1a-feed"', { base: BASE })).toEqual({ kind: 'unchanged' });
  });

  it('is absent for a page or a host with no feed endpoint — a normal answer, not an error', async () => {
    stubFetch(() => ({ status: 404, contentType: 'text/html', body: 'not found' }));
    expect((await houseFeeds(null, { base: BASE })).kind).toBe('absent');

    stubFetch(() => ({ contentType: 'text/html', body: '<!doctype html>' }));
    expect((await houseFeeds(null, { base: BASE })).kind).toBe('absent');
  });

  it('is an error when a row is not the shape this build reads', async () => {
    // `rpm` as a string is exactly the kind of plausible-but-wrong row that must not reach the
    // engine: `feedsFor` would put it on the wire as a spindle speed.
    stubFetch(() => ({
      contentType: 'application/json',
      body: JSON.stringify([{ ...ROW, rpm: '12000' }]),
    }));
    const read = await houseFeeds(null, { base: BASE });
    expect(read.kind).toBe('error');
    if (read.kind !== 'error') throw new Error('unreachable');
    expect(read.detail).toContain('feed catalogue');
  });
});

describe('the loader seam', () => {
  it('swaps the client for every caller, and null restores the real one', async () => {
    const seen: Array<string | null> = [];
    const fake: HouseClient = {
      probe: async () => ({ kind: 'absent', reason: 'fake' }),
      tools: async (etag) => {
        seen.push(etag);
        return { kind: 'unchanged' };
      },
      feeds: async () => ({ kind: 'absent', reason: 'fake' }),
    };
    setHouseClientLoader(async () => fake);
    expect(await probeHouse({ base: BASE })).toEqual({ kind: 'absent', reason: 'fake' });
    expect(await houseTools('"x"')).toEqual({ kind: 'unchanged' });
    expect(seen).toEqual(['"x"']);

    // Restored: the real client builds a URL and asks. With no `location` and no base the URL is
    // relative, which in a browser asks this page's own origin — the behaviour the LAN case needs,
    // and the reason nothing here is gated on the build target (decision 31: reaching is a runtime
    // fact).
    setHouseClientLoader(null);
    const calls = stubFetch(() => ({ status: 404, contentType: 'text/html', body: 'no' }));
    expect((await probeHouse()).kind).toBe('absent');
    expect(calls).toHaveLength(1);
  });
});
