// #571 — the HTTP-backed machine transport a LAN browser uses (the twin of the Tauri transport),
// and the runtime choice between them. `@tauri-apps/api/core` is mocked so importing the Tauri
// transport does not need a real Tauri runtime; `fetch` is mocked so no socket is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { httpTransport } from '@/platform/desktop/httpTransport';
import { tauriTransport } from '@/platform/desktop/transport';
import { defaultTransport } from '@/platform/desktop/machineBridge';

const okJson = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
const noContent = () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } }) as unknown as Response;
const errJson = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response;

describe('httpTransport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tcpConnect POSTs application/json to the same-origin endpoint and returns the conn id', async () => {
    fetchMock.mockResolvedValue(okJson({ conn: 7 }));
    const conn = await httpTransport.tcpConnect('192.168.10.43', 2222, 1000);
    expect(conn).toBe(7);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/machine/tcp/connect');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ host: '192.168.10.43', port: 2222, timeout_ms: 1000 });
  });

  it('tcpWrite sends the bytes as a number array and resolves on a 204', async () => {
    fetchMock.mockResolvedValue(noContent());
    await httpTransport.tcpWrite(7, Uint8Array.from([1, 2, 3]));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ conn: 7, data: [1, 2, 3] });
  });

  it('tcpRead returns a Uint8Array of the server bytes', async () => {
    fetchMock.mockResolvedValue(okJson({ bytes: [112, 111, 110, 103] }));
    const out = await httpTransport.tcpRead(7, 64, 1000);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([112, 111, 110, 103]);
  });

  it('tcpRead of an empty window is an empty array, not an error', async () => {
    fetchMock.mockResolvedValue(okJson({ bytes: [] }));
    expect(Array.from(await httpTransport.tcpRead(7, 64, 50))).toEqual([]);
  });

  it('udpListen returns the datagram array', async () => {
    fetchMock.mockResolvedValue(okJson([{ at: 1, text: 'Makera_Z1' }]));
    expect(await httpTransport.udpListen(5000, 100)).toEqual([{ at: 1, text: 'Makera_Z1' }]);
  });

  it('throws the server error message so the protocol layer sees the same words', async () => {
    fetchMock.mockResolvedValue(errJson(502, 'the machine closed the connection'));
    await expect(httpTransport.tcpRead(7, 64, 1000)).rejects.toThrow('the machine closed the connection');
  });

  it('wraps a network-level failure instead of surfacing a bare TypeError', async () => {
    fetchMock.mockRejectedValue(new Error('Failed to fetch'));
    await expect(httpTransport.tcpConnect('h', 1, 1)).rejects.toThrow(/could not reach the machine service/);
  });
});

describe('defaultTransport', () => {
  afterEach(() => { delete (globalThis as { isTauri?: unknown }).isTauri; });

  it('uses the HTTP transport when the Tauri runtime is absent (a LAN browser)', () => {
    delete (globalThis as { isTauri?: unknown }).isTauri;
    expect(defaultTransport()).toBe(httpTransport);
  });

  it('uses the Tauri transport inside the desktop webview (globalThis.isTauri set)', () => {
    (globalThis as { isTauri?: unknown }).isTauri = true;
    expect(defaultTransport()).toBe(tauriTransport);
  });
});
