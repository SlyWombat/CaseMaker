// @vitest-environment jsdom
// #450 slice 6 — Manage › Tools › Feeds: the table listed with its provenance, a row added through
// the form, a seeded row edited into a chosen one, both refusals shown on the offending field, a
// failed save reported rather than swallowed, and a row removed under the table's validator.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToolsScope } from '@/components/manage/ToolsScope';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import type { FeedRow } from '@/platform/feedClient';
import { resetFeedTableStore } from '@/store/feedTableStore';
import { resetManageMode } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const GOOD = (
  JSON.parse(readFileSync(join(HERE, 'fixtures', 'feed-table.json'), 'utf8')) as { good: unknown[] }
).good;

/**
 * The feeds table's service: a GET that answers the current rows with a moving validator, POST
 * unguarded, PATCH/DELETE guarded as `house.rs` guards them. `refuseWrites` makes every write answer
 * the service's own refusal sentence, which is what a failed save must show.
 */
function fakeTable(opts: { refuseWrites?: { status: number; message: string } } = {}) {
  let rows = JSON.parse(JSON.stringify(GOOD)) as FeedRow[];
  let version = 1;
  const sent: Array<{ method: string; path: string; body: unknown; ifMatch?: string | null }> = [];
  const etag = () => `"f-${version}"`;
  const client = {
    call: async (
      method: string,
      path: string,
      body?: unknown,
      req?: { ifMatch?: string | null },
    ): Promise<HouseCall> => {
      if (method === 'GET' && path === '/feed-table') {
        return { kind: 'ok', text: JSON.stringify(rows), etag: etag() };
      }
      sent.push({ method, path, body, ifMatch: req?.ifMatch });
      if (opts.refuseWrites) {
        return { kind: 'refused', status: opts.refuseWrites.status, message: opts.refuseWrites.message };
      }
      if (method !== 'POST' && req?.ifMatch !== etag()) {
        return { kind: 'refused', status: 412, message: 'the feeds table changed since you read it' };
      }
      const id = decodeURIComponent(path.replace('/feed-table/', ''));
      if (method === 'POST') rows.push(body as FeedRow);
      if (method === 'PATCH') rows = rows.map((r) => (r.id === id ? (body as FeedRow) : r));
      if (method === 'DELETE') rows = rows.filter((r) => r.id !== id);
      version += 1;
      return { kind: 'ok', text: '' };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  return { sent, rows: () => rows };
}

/** Open the Tools scope and switch to its feeds pane, waiting for the first read. */
async function openFeeds() {
  render(<ToolsScope />);
  fireEvent.click(screen.getByTestId('manage-tools-pane-feeds'));
  await screen.findByTestId('manage-feeds-table');
}

beforeEach(() => {
  resetFeedTableStore();
  resetManageMode();
  useToolRegistryStore.setState({ status: 'present' });
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
  useToolRegistryStore.setState({ status: 'checking' });
});

describe('#450 Manage › Tools › Feeds', () => {
  it('lists each row with its band, its seven parameters and its provenance', async () => {
    fakeTable();
    await openFeeds();

    const row = screen.getByTestId('manage-feeds-row-feed-pla-flat-0.8-1.6');
    // Cell by cell, so a value cannot pass by running into its neighbour (0.3 + 0.45 would have read
    // as "0.30" in `row.textContent`).
    const cells = within(row)
      .getAllByRole('cell')
      .map((td) => td.textContent ?? '');
    expect(cells[0]).toContain('PLA');
    // The provenance sentence is drawn, not just held in the model.
    expect(cells[0]).toContain('Starting value.');
    expect(cells[1]).toBe('flat');
    expect(cells[2]).toBe('0.8–1.6');
    expect(cells[3]).toBe('12000');
    expect(cells[4]).toBe('500');
    expect(cells[5]).toBe('200');
    expect(cells[6]).toBe('0.3');
    expect(cells[7]).toBe('0.45');
    expect(cells[8]).toBe('1.00');
    expect(cells[9]).toBe('on');
    expect(cells[10]).toBe('seeded');
    const source = screen.getByTestId('manage-feeds-source-feed-pla-flat-0.8-1.6');
    expect(source.textContent).toBe('seeded');
    expect(source.getAttribute('data-source')).toBe('seeded');
    expect(screen.getByTestId('manage-feeds-counts').textContent).toContain('11 seeded');
  });

  it('adds a row through the form as a chosen row with a date, never as seeded', async () => {
    const svc = fakeTable();
    await openFeeds();

    fireEvent.click(screen.getByTestId('manage-feed-add'));
    fireEvent.change(screen.getByTestId('manage-feed-material'), { target: { value: 'petg' } });
    fireEvent.change(screen.getByTestId('manage-feed-min'), { target: { value: '0.8' } });
    fireEvent.change(screen.getByTestId('manage-feed-max'), { target: { value: '1.6' } });
    fireEvent.change(screen.getByTestId('manage-feed-param-rpm'), { target: { value: '9000' } });
    fireEvent.change(screen.getByTestId('manage-feed-param-feed'), { target: { value: '400' } });
    fireEvent.change(screen.getByTestId('manage-feed-param-plunge'), { target: { value: '150' } });
    fireEvent.change(screen.getByTestId('manage-feed-param-stepdown'), { target: { value: '0.4' } });
    fireEvent.change(screen.getByTestId('manage-feed-param-stepover'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByTestId('manage-feed-param-peck'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('manage-feed-provenance'), {
      target: { value: 'typed from the cutter box, not measured.' },
    });
    // A new row cannot claim the app seeded it.
    const seeded = Array.from((screen.getByTestId('manage-feed-source') as HTMLSelectElement).options).find(
      (o) => o.value === 'seeded',
    )!;
    expect(seeded.disabled).toBe(true);
    expect((screen.getByTestId('manage-feed-source') as HTMLSelectElement).value).toBe('chosen');
    expect((screen.getByTestId('manage-feed-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('manage-feed-save'));
    await waitFor(() => expect(svc.sent.some((s) => s.method === 'POST')).toBe(true));
    const posted = svc.sent.find((s) => s.method === 'POST')!.body as FeedRow;
    expect(posted).toMatchObject({
      material: 'petg',
      edge: null,
      minDiameter: 0.8,
      maxDiameter: 1.6,
      source: 'chosen',
      note: null,
      params: {
        rpm: 9000,
        feed: 400,
        plungeFeed: 150,
        stepDown: 0.4,
        stepOverFraction: 0.5,
        peckFraction: 1,
        air: true,
      },
    });
    expect(typeof posted.setAt).toBe('string');
    expect(posted.setAt).not.toBe('');
    await waitFor(() => expect(svc.rows()).toHaveLength(12));
    await screen.findByTestId(`manage-feeds-row-${posted.id}`);
  });

  it('editing a seeded row’s numbers turns it into a chosen row, dated, and keeps the sentence editable', async () => {
    const svc = fakeTable();
    await openFeeds();

    fireEvent.click(screen.getByTestId('manage-feeds-pick-feed-pla-flat-0.8-1.6'));
    // The seeded row says so, and has no date.
    expect((screen.getByTestId('manage-feed-source') as HTMLSelectElement).value).toBe('seeded');
    expect(screen.getByTestId('manage-feed-setat').textContent).toContain('No date');

    fireEvent.change(screen.getByTestId('manage-feed-param-rpm'), { target: { value: '9000' } });
    // Moving a number flips the visible claim immediately; the old seeded sentence is flagged.
    expect((screen.getByTestId('manage-feed-source') as HTMLSelectElement).value).toBe('chosen');
    expect(screen.getByTestId('manage-feed-setat').textContent).not.toContain('No date');
    expect(screen.getByTestId('manage-feed-demoted').textContent).toContain('no longer the starting values');

    fireEvent.change(screen.getByTestId('manage-feed-provenance'), {
      target: { value: 'cut the 0.8 mm band at 9000 rpm on PETG, 2026-10-17.' },
    });
    expect(screen.queryByTestId('manage-feed-demoted')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-feed-save'));
    await waitFor(() => expect(svc.sent.some((s) => s.method === 'PATCH')).toBe(true));
    const patched = svc.sent.find((s) => s.method === 'PATCH')!.body as FeedRow;
    expect(patched).toMatchObject({
      id: 'feed-pla-flat-0.8-1.6',
      source: 'chosen',
      params: { rpm: 9000 },
      provenance: 'cut the 0.8 mm band at 9000 rpm on PETG, 2026-10-17.',
    });
    expect(typeof patched.setAt).toBe('string');
    expect(patched.setAt).not.toBe('');
    expect(svc.rows().find((r) => r.id === 'feed-pla-flat-0.8-1.6')).toMatchObject({
      source: 'chosen',
      params: { rpm: 9000 },
    });
  });

  it('marks a row measured only by choosing it explicitly, and refuses until its provenance says who measured it', async () => {
    const svc = fakeTable();
    await openFeeds();

    fireEvent.click(screen.getByTestId('manage-feeds-pick-feed-pla-flat-0.8-1.6'));
    fireEvent.change(screen.getByTestId('manage-feed-param-rpm'), { target: { value: '9000' } });
    // Moving the numbers promotes the row to CHOSEN and no further: a measured row is a claim a
    // person makes, not a state the form falls into.
    expect((screen.getByTestId('manage-feed-source') as HTMLSelectElement).value).toBe('chosen');
    expect(screen.queryByTestId('manage-feed-measured')).toBeNull();

    fireEvent.change(screen.getByTestId('manage-feed-source'), { target: { value: 'measured' } });
    expect(screen.getByTestId('manage-feed-measured').textContent).toContain('says who measured it');
    // The seeded sentence is still in the box, and a measured row cannot keep it: the save is
    // refused on the field, with the reason, rather than writing a claim about Makera's numbers.
    expect((screen.getByTestId('manage-feed-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('manage-feed-problem').textContent).toContain(
      'a row marked measured says who measured it',
    );
    expect(screen.getByTestId('manage-feed-problem').getAttribute('data-field')).toBe('provenance');

    fireEvent.change(screen.getByTestId('manage-feed-provenance'), {
      target: { value: 'measured the 0.8–1.6 mm PLA band on the bench coupon, Dave, 2026-10-17.' },
    });
    expect(screen.queryByTestId('manage-feed-problem')).toBeNull();
    expect((screen.getByTestId('manage-feed-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('manage-feed-save'));
    await waitFor(() => expect(svc.sent.some((s) => s.method === 'PATCH')).toBe(true));
    const patched = svc.sent.find((s) => s.method === 'PATCH')!.body as FeedRow;
    expect(patched).toMatchObject({
      id: 'feed-pla-flat-0.8-1.6',
      source: 'measured',
      params: { rpm: 9000 },
      provenance: 'measured the 0.8–1.6 mm PLA band on the bench coupon, Dave, 2026-10-17.',
    });
    // The date is the save's, so the row states both halves of the claim: who in the sentence,
    // when in `setAt`.
    expect(typeof patched.setAt).toBe('string');
    expect(patched.setAt).not.toBe('');
    await waitFor(() =>
      expect(screen.getByTestId('manage-feeds-source-feed-pla-flat-0.8-1.6').textContent).toBe('measured'),
    );
    expect(screen.getByTestId('manage-feeds-counts').textContent).toContain('1 measured');
  });

  it('shows a backwards diameter on the field the schema names, and sends nothing', async () => {
    const svc = fakeTable();
    await openFeeds();

    fireEvent.click(screen.getByTestId('manage-feeds-pick-feed-pla-flat-0.8-1.6'));
    fireEvent.change(screen.getByTestId('manage-feed-min'), { target: { value: '5' } });

    const problem = screen.getByTestId('manage-feed-problem');
    expect(problem.textContent).toContain('backwards');
    expect(problem.getAttribute('data-field')).toBe('maxDiameter');
    expect(screen.getByTestId('manage-feed-max').getAttribute('data-status')).toBe('error');
    expect((screen.getByTestId('manage-feed-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('manage-feed-save'));
    expect(svc.sent).toEqual([]);
  });

  it('shows the cross-row overlap on the row being edited, naming both bands, and sends nothing', async () => {
    const svc = fakeTable();
    await openFeeds();

    // 1.6–3.2 mm moved down to 0.9 overlaps the 0.8–1.6 mm row; touching at 1.6 is allowed.
    fireEvent.click(screen.getByTestId('manage-feeds-pick-feed-softwood-flat-1.6-3.2'));
    fireEvent.change(screen.getByTestId('manage-feed-min'), { target: { value: '0.9' } });

    const problem = screen.getByTestId('manage-feed-problem');
    expect(problem.textContent).toContain('both cover');
    expect(problem.textContent).toContain('0.8–1.6');
    expect(problem.textContent).toContain('overlap');
    expect(problem.getAttribute('data-field')).toBe('minDiameter');
    expect(screen.getByTestId('manage-feed-min').getAttribute('data-status')).toBe('error');
    expect((screen.getByTestId('manage-feed-save') as HTMLButtonElement).disabled).toBe(true);

    // Touching at the boundary is not a conflict — the same edit to 1.6 is allowed.
    fireEvent.change(screen.getByTestId('manage-feed-min'), { target: { value: '1.6' } });
    expect(screen.queryByTestId('manage-feed-problem')).toBeNull();
    expect((screen.getByTestId('manage-feed-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('manage-feed-save'));
    await waitFor(() => expect(svc.sent.some((s) => s.method === 'PATCH')).toBe(true));
  });

  it('reports a failed save with the service’s own sentence and keeps the typed values', async () => {
    const svc = fakeTable({
      refuseWrites: { status: 400, message: 'feed feed-pla-flat-0.8-1.6: a row for this band already exists' },
    });
    await openFeeds();

    fireEvent.click(screen.getByTestId('manage-feeds-pick-feed-pla-flat-0.5-0.8'));
    fireEvent.change(screen.getByTestId('manage-feed-param-rpm'), { target: { value: '9500' } });
    fireEvent.click(screen.getByTestId('manage-feed-save'));

    const notice = await screen.findByTestId('manage-feeds-notice');
    expect(notice.getAttribute('data-kind')).toBe('refused');
    expect(notice.textContent).toContain('a row for this band already exists');
    // The editor is still open, with the number that was typed; the service's table is untouched.
    expect((screen.getByTestId('manage-feed-param-rpm') as HTMLInputElement).value).toBe('9500');
    expect(svc.rows().find((r) => r.id === 'feed-pla-flat-0.5-0.8')!.params.rpm).toBe(12000);
  });

  it('removes a row under the table validator and closes the editor', async () => {
    const svc = fakeTable();
    await openFeeds();

    fireEvent.click(screen.getByTestId('manage-feeds-pick-feed-pla-v-0.3-0.5'));
    fireEvent.click(screen.getByTestId('manage-feed-remove'));

    await waitFor(() => expect(svc.sent.some((s) => s.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(svc.rows()).toHaveLength(10));
    await waitFor(() => expect(screen.queryByTestId('manage-feeds-row-feed-pla-v-0.3-0.5')).toBeNull());
    expect(screen.getByTestId('manage-feed-detail-empty')).toBeTruthy();
  });

  it('says the table is absent rather than empty when the service predates it', async () => {
    setHouseClientLoader(
      async () =>
        ({
          call: async (): Promise<HouseCall> => ({ kind: 'refused', status: 404, message: 'no route' }),
        }) as unknown as HouseClient,
    );
    render(<ToolsScope />);
    fireEvent.click(screen.getByTestId('manage-tools-pane-feeds'));
    expect(await screen.findByTestId('manage-feeds-absent')).toBeTruthy();
    expect((screen.getByTestId('manage-feed-add') as HTMLButtonElement).disabled).toBe(true);
  });
});
