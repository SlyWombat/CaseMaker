// @vitest-environment jsdom
// The feeds table's transport and store (#450 slice 2), on the stock shelf's model (#413): the rows
// the service accepts through the client schema, and the store's unguarded create / guarded edits
// against a fake service that moves its `ETag` on every write. The specimen is `feed-table.json` —
// the same one `feeds.rs` reads — because the held `location-doc.json` has no `feeds` section yet.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { FeedRowSchema, feedProblem, type FeedRow } from '@/platform/feedClient';
import {
  newFeedId,
  resetFeedTableStore,
  useFeedTableStore,
} from '@/store/feedTableStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOOD = (
  JSON.parse(readFileSync(join(HERE, 'fixtures', 'feed-table.json'), 'utf8')) as { good: unknown[] }
).good;
const ROW: FeedRow = FeedRowSchema.parse(GOOD[0]);

/** The service's table, with a validator that moves on every write, as `house.rs` guards it. */
function fakeTable(initial: unknown[]) {
  let rows = JSON.parse(JSON.stringify(initial)) as Array<{ id: string }>;
  let version = 1;
  const calls: string[] = [];
  const etag = () => `"f-${version}"`;
  const client = {
    call: async (method: string, path: string, body?: unknown, opts?: { ifMatch?: string | null }): Promise<HouseCall> => {
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === '/feed-table') return { kind: 'ok', text: JSON.stringify(rows), etag: etag() };
      if (method === 'POST' && path === '/feed-table') {
        rows.push(body as { id: string });
        version += 1;
        return { kind: 'ok', text: '' };
      }
      if (!opts?.ifMatch) return { kind: 'refused', status: 428, message: 'this save did not say which version of the feeds table' };
      if (opts.ifMatch !== etag()) return { kind: 'refused', status: 412, message: 'the feeds table changed since you read it' };
      const id = decodeURIComponent(path.replace('/feed-table/', ''));
      if (method === 'PATCH') rows = rows.map((r) => (r.id === id ? (body as { id: string }) : r));
      if (method === 'DELETE') rows = rows.filter((r) => r.id !== id);
      version += 1;
      return { kind: 'ok', text: '' };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  return { calls, rows: () => rows, bump: () => (version += 1) };
}

describe('the feeds table store (#450 slice 2)', () => {
  beforeEach(resetFeedTableStore);
  afterEach(() => setHouseClientLoader(null));

  it('reads the shared specimen, in the order the service stores it', async () => {
    fakeTable(GOOD);
    await useFeedTableStore.getState().refresh();
    const s = useFeedTableStore.getState();
    expect(s.status).toBe('present');
    expect(s.rows.map((r) => r.id)).toEqual((GOOD as Array<{ id: string }>).map((r) => r.id));
    expect(s.rows).toHaveLength(11);
    expect(s.unreadable).toEqual([]);
    expect(s.etag).toBe('"f-1"');
  });

  it('creates unguarded, then edits and removes under the table ETag', async () => {
    const svc = fakeTable([ROW]);
    await useFeedTableStore.getState().refresh();

    expect(await useFeedTableStore.getState().add({ ...ROW, id: 'feed-new', material: 'pla' })).toBe(true);
    expect(svc.calls).toContain('POST /feed-table');

    const edited = { ...ROW, params: { ...ROW.params, feed: 600 } };
    expect(await useFeedTableStore.getState().replace(edited)).toBe(true);
    expect(svc.calls).toContain('PATCH /feed-table/feed-softwood-flat-0.8-1.6');
    expect(svc.rows()[0]).toMatchObject({ id: ROW.id, params: { feed: 600 } });

    expect(await useFeedTableStore.getState().remove(ROW.id)).toBe(true);
    expect(svc.calls).toContain('DELETE /feed-table/feed-softwood-flat-0.8-1.6');
    expect(useFeedTableStore.getState().rows.map((r) => r.id)).toEqual(['feed-new']);
  });

  it('a stale guard is a 412, re-reads, and the retry carries the new ETag', async () => {
    const svc = fakeTable([ROW]);
    await useFeedTableStore.getState().refresh();
    svc.bump();
    expect(await useFeedTableStore.getState().replace({ ...ROW, params: { ...ROW.params, feed: 600 } })).toBe(false);
    expect(useFeedTableStore.getState().notice?.text).toContain('changed since you read it');
    expect(svc.calls.at(-1)).toBe('GET /feed-table');
    expect(useFeedTableStore.getState().etag).toBe('"f-2"');
    expect(await useFeedTableStore.getState().replace({ ...ROW, params: { ...ROW.params, feed: 600 } })).toBe(true);
  });

  it('relays a 428 when this window has no validator and re-reads', async () => {
    fakeTable([ROW]);
    // No refresh: `etag` is null, so the write sends no If-Match and the service says 428.
    expect(await useFeedTableStore.getState().remove(ROW.id)).toBe(false);
    expect(useFeedTableStore.getState().notice?.text).toContain('which version');
    expect(useFeedTableStore.getState().status).toBe('present');
  });

  it('a row the schema refuses sends nothing', async () => {
    const svc = fakeTable([ROW]);
    await useFeedTableStore.getState().refresh();
    svc.calls.length = 0;
    expect(await useFeedTableStore.getState().add({ ...ROW, id: 'feed-bad', params: { ...ROW.params, rpm: 0 } })).toBe(false);
    expect(useFeedTableStore.getState().notice?.text).toContain('rpm');
    expect(svc.calls).toEqual([]);
    expect(feedProblem({ ...ROW, id: 'feed-bad', params: { ...ROW.params, rpm: 0 } })).not.toBeNull();
  });

  it('sets aside a row this build cannot read, and keeps the rest', async () => {
    fakeTable([...GOOD, { id: 'feed-new', material: 'unobtainium' }]);
    await useFeedTableStore.getState().refresh();
    expect(useFeedTableStore.getState().rows).toHaveLength(11);
    expect(useFeedTableStore.getState().unreadable.map((u) => u.id)).toEqual(['feed-new']);
  });

  it('a write while another is in flight says so instead of doing nothing silently', async () => {
    fakeTable([ROW]);
    await useFeedTableStore.getState().refresh();
    useFeedTableStore.setState({ busy: true });
    expect(await useFeedTableStore.getState().add(ROW)).toBe(false);
    expect(useFeedTableStore.getState().notice?.text).toContain('still being saved');
  });

  it('a service from before the table is absent, not an error', async () => {
    setHouseClientLoader(
      async () =>
        ({
          call: async (): Promise<HouseCall> => ({ kind: 'refused', status: 404, message: 'no route' }),
        }) as unknown as HouseClient,
    );
    await useFeedTableStore.getState().refresh();
    expect(useFeedTableStore.getState().status).toBe('absent');
    expect(useFeedTableStore.getState().reason).toBe('no route');
  });

  it('mints ids the service accepts as a row id', () => {
    expect(feedProblem({ ...ROW, id: newFeedId() })).toBeNull();
  });
});
