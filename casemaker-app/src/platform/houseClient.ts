/**
 * The house service client (#306, tracking #212) — the one place that answers "is this machine's
 * tool service there, and what does it have?".
 *
 * THE SERVICE. `src-tauri/src/house.rs` + `house_api.rs` are an axum API mounted under `/api/v1` by
 * the app's own embedded HTTP server, holding the machine's tool list and inventory as versioned
 * JSON. In the desktop app the window IS served by that server (`lib.rs`'s `window_url`), so the
 * service is at this page's own origin — including when the user opens the app's URL in an ordinary
 * browser on the LAN.
 *
 * ASKED BY EVERY BUILD, BECAUSE REACHING IS A RUNTIME FACT AND NOT A BUILD TARGET (decision 31). A
 * browser that loaded this page from the service — a phone on the LAN, a bench browser — must reach
 * it, and that browser is not the Tauri shell. So there is no `canRunLocalServer` guard here: the
 * probe runs and the ORIGIN's answer decides. `canRunLocalServer` gates hosting and syncing, never
 * reaching. The price of that honesty is one request and one 404 in the console for the web
 * deployment, whose origin has no service to answer — observed in #306's browser QA, reported on the
 * issue, and deliberately kept as the smaller cost next to a reachability rule that would be wrong
 * for the LAN case.
 *
 * THE TRAP IT EXISTS TO AVOID. The embedded server answers every path it does not know with
 * `index.html` and status **200** so the SPA's deep links work. A client that read "200" as
 * "the service is here" would populate the tool list from an HTML page (`server.rs`'s tests pin the
 * API against that fallback; this side pins the other end). So a health check is only `present`
 * when the answer is **JSON that matches this build's shape** — a page, a 404 from a static host, a
 * proxy's login redirect and a version this build does not speak all report honestly and none of
 * them feeds the registry.
 *
 * THREE OUTCOMES, MATCHING `probeMachine`'s discipline (#280). `absent` is a normal answer, not an
 * error: the web deployment and any Tauri run without the sidecar are perfectly good builds with no
 * house service, and the built-in tool tier is what they run on. Nothing here throws to a caller,
 * and nothing here blocks: a probe that hangs on a dead socket gives up after
 * {@link DEFAULT_TIMEOUT_MS} and says so.
 *
 * READS AND WRITES, ONE SEAM EACH. The read side is four typed calls — health, tools, feeds (#310),
 * inventory — because each has its own validator and its own caller. The write side (#309/#311) is a
 * single {@link HouseClient.call}: register, clone, sync, export and import are the same request with
 * a different method, path and body, and nine named methods would be nine places to get the status
 * handling wrong. {@link houseWrite} wraps it back up for the callers that want a name.
 *
 * A WRITE'S REFUSAL IS THE SERVICE'S OWN SENTENCE. `house_api.rs` writes every error body as
 * `{"error": "..."}` with a status chosen for the reason (400 for a body it cannot use, 404 for a
 * key that is not there, 409 for one that already is), and that sentence is written for the user —
 * so it is surfaced as `refused` and shown as-is, never re-worded here. Anything that answers without
 * that shape did not come from the service, which is `absent`, the same judgement the read path makes
 * about a probe. The `status` is kept beside the sentence for the one caller that has to tell two
 * refusals apart: 412 and 428 mean this client's copy is not the served one (#321), and
 * `store/houseStore.ts` re-reads on those and on nothing else.
 *
 * A WRITE THAT CHANGES A DOCUMENT SAYS WHICH VERSION IT CHANGED (#321). Replace and remove carry the
 * `ETag` of the list they were made against as `If-Match`; the service answers 428 when it is missing
 * and 412 when it is stale, which turns a two-window overwrite into a refusal the user can see. The
 * validator is `ifMatch` on the request options — deliberately a different field from the reads'
 * `etag`, which is an `If-None-Match` saying the opposite thing.
 *
 * NO VENDOR DATA, ANYWHERE. What this client receives is the user's own tiers plus whatever their
 * own machine's catalogue holds. Nothing it fetches is committed to the repo and nothing it fetches
 * is sent anywhere (see `/Fabrication.md` §3, #186).
 */

import { z } from 'zod';
import { ToolLibrarySchema, ToolSchema, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { FeedCatalogueSchema, type FeedCatalogueRow } from '@/engine/cnc/feeds';

/**
 * The API root under the page's origin. Matches `house_api.rs`'s route prefix, and is the one
 * string a change has to keep in step — the Rust route tests and this module are the two ends.
 */
export const HOUSE_API_PATH = '/api/v1';

/**
 * The document version this build understands, and it must equal `HOUSE_SCHEMA_VERSION` in
 * `house.rs`.
 *
 * It is checked against what the service REPORTS rather than assumed, and a mismatch is an `error`
 * rather than a best-effort read: a service at a version this build does not know may hold fields
 * it cannot see, and populating a picker from it would be exactly the "plausible but wrong" answer
 * the rest of this app refuses to give. The safe direction is a one-sided bump degrading to
 * "no service" — visible, and recoverable by updating — rather than to a wrong tool.
 */
export const HOUSE_SCHEMA_VERSION = 1;

/**
 * How long a request gets before it is called dead. A service on this machine or this LAN answers in
 * single-digit milliseconds; two seconds means it is not there, and the difference between "slow"
 * and "gone" cannot be established from here anyway.
 */
export const DEFAULT_TIMEOUT_MS = 2000;

/** What the service says about itself (`GET /api/v1/health`). */
const HouseHealthSchema = z.object({
  ok: z.boolean(),
  schemaVersion: z.number().int(),
  /** Whether a Makera catalogue has been imported (#308). False is normal on a fresh machine. */
  hasCatalogue: z.boolean(),
  /**
   * How many feed rows the stored catalogue holds (#310). Defaulted rather than required, so a
   * service that predates the feed tier still answers "present" instead of failing this build's
   * parse — the absence of the field IS the zero. A catalogue imported before #310 therefore
   * reports `hasCatalogue: true` with `feedRows: 0`, which is exactly the state a re-sync fixes.
   */
  feedRows: z.number().int().nonnegative().default(0),
  catalogueSyncedAt: z.string().nullable(),
  /**
   * One sentence per document the service could not read. Non-empty means it will refuse writes —
   * worth showing to the user rather than swallowing, and worth not treating as "no tools".
   */
  problems: z.array(z.string()),
});

export type HouseHealth = z.infer<typeof HouseHealthSchema>;

export interface HouseRequestOptions {
  /** Override the origin. Only tests and a future "another machine on the LAN" do this. */
  base?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * The version a GUARDED WRITE is based on (#321), sent as `If-Match` — the document as the caller
   * last read it. `null`/absent means the caller has no validator to offer, and the header is then
   * simply not sent: the service answers that with 428 and a sentence naming what was missing, which
   * is a better answer than one invented here.
   *
   * Deliberately NOT the same field as the reads' `etag`: that one is an `If-None-Match` and says the
   * opposite thing ("I already have this version"). One field for both would be a client that sends
   * "don't give it to me" on the request that is supposed to change it.
   */
  ifMatch?: string | null;
}

/**
 * The two ways a READ can fail. `absent` is every "something answered, and it was not the house
 * service" including a static host's 404; `error` means the service is there and this build cannot
 * use it (a version it does not speak, a payload that fails the schema, a dead socket).
 *
 * A read cannot be REFUSED, which is why this is not {@link HouseFailure}: only a write is answered
 * with a decision about the house, and a caller that handles reads never has to consider one.
 */
export type HouseReadFailure =
  | { kind: 'absent'; reason: string }
  | { kind: 'error'; detail: string };

/** What a probe concluded. */
export type HouseProbe =
  | { kind: 'present'; health: HouseHealth; base: string }
  | HouseReadFailure;

/** What a tool-list read concluded. `unchanged` is a 304: the caller keeps the entries it has. */
export type HouseTools =
  | { kind: 'ok'; etag: string | null; entries: ToolLibraryEntry[] }
  | { kind: 'unchanged' }
  | HouseReadFailure;

/** What a feed-catalogue read concluded (#310). The same four outcomes, its own validator. */
export type HouseFeeds =
  | { kind: 'ok'; etag: string | null; rows: FeedCatalogueRow[] }
  | { kind: 'unchanged' }
  | HouseReadFailure;

/**
 * A code printed on a cutter or its packaging (#309). `symbology` is kept because the same value can
 * arrive as a QR slug (`C1-BIT-BALL-NOSE-1-4`) or as typed text, and only the first is evidence that
 * a label was scanned.
 */
export const CodedSchema = z.object({
  symbology: z.string(),
  value: z.string(),
});

/**
 * The catalogue row a definition was materialised from (#212). `id` is the catalogue's `cutterId`
 * (`/Makera-Parity.md` §3.2), never the `.nc` header's `g_ID` — the UUID is what a re-sync diffs on
 * and the `g_ID` is not inherited by a clone. Absent on a cutter the user typed in themselves.
 */
export const OriginSchema = z.object({
  id: z.string().min(1),
  syncedAt: z.string().nullable().default(null),
});

/**
 * A physical cutter the user owns (#309): the materialised `Tool`, how many there are, and the codes
 * that identify one.
 *
 * MATERIALISED, not a reference to a catalogue row: a user who cloned a row and then synced a
 * catalogue that dropped it still physically owns the cutter. `quantity` is never 0 on the service's
 * side — "none left" is a removal, not a zero (`house.rs`'s `validate`) — so a payload carrying one
 * is a document this build should not be reading, which is why the floor is `.positive()` here too.
 */
export const InventoryItemSchema = z.object({
  /** Ours, minted by the client (`utils/id.ts`). */
  id: z.string().min(1),
  tool: ToolSchema,
  origin: OriginSchema.nullable().default(null),
  quantity: z.number().int().positive(),
  codes: z.array(CodedSchema).default([]),
  /** ISO timestamp from the client's clock: when the user registered it. */
  addedAt: z.string().min(1),
  notes: z.string().nullable().default(null),
});

/**
 * The inventory document, served as a bare array like the two tiers above the built-ins.
 *
 * The same shape of rule `ToolLibrarySchema` already applies to duplicate keys (#320): an id names
 * one possession and a CODE names one cutter — `code → the item` is the door #309 is built on, and
 * it is only a function if a printed code appears once — so a body carrying either twice is refused
 * whole rather than rendered as two rows the user cannot tell apart. The service refuses the same
 * document at its own door (`house.rs::HouseDoc::validate`), which is the point: this is a refusal
 * for a body that did not come from that service.
 */
export const InventorySchema = z.array(InventoryItemSchema).superRefine((list, ctx) => {
  const ids = new Set<string>();
  const codes = new Set<string>();
  list.forEach((item, i) => {
    if (ids.has(item.id)) {
      ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate inventory id "${item.id}"` });
    }
    ids.add(item.id);
    item.codes.forEach((coded, j) => {
      if (codes.has(coded.value)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'codes', j, 'value'],
          message: `the code "${coded.value}" is on more than one cutter`,
        });
      }
      codes.add(coded.value);
    });
  });
});

export type Coded = z.infer<typeof CodedSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

/** What an inventory read concluded: the same four outcomes as {@link HouseTools}. */
export type HouseInventory =
  | { kind: 'ok'; etag: string | null; items: InventoryItem[] }
  | { kind: 'unchanged' }
  | HouseReadFailure;

/**
 * Everything that is not success, shared by every WRITE here. On top of the two read failures,
 * `refused` is the service saying no in its own words — the sentence is written for the user and
 * shown as-is, `status` kept so a caller can tell "you sent something I cannot use" (400) from
 * "that key is already taken" (409) without re-reading the English.
 */
export type HouseFailure =
  | HouseReadFailure
  | { kind: 'refused'; status: number; message: string };

/** A write that worked. The success bodies are empty; the reads that follow are what says what changed. */
export type HouseWrite = { kind: 'ok' } | HouseFailure;

/** One request's outcome before any wrapper has interpreted it: the success body as text, or why not. */
export type HouseCall = { kind: 'ok'; text: string } | HouseFailure;

export type HouseMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * What one catalogue sync found (#308). `changed`/`added`/`removed` are KEYS, so the panel can name
 * what moved; `feedRows` is a count rather than a diff, because a feed row has no identity beyond its
 * (cutter, material) pair; `notes` carries what is worth saying about a sync that still succeeded.
 */
export const SyncReportSchema = z.object({
  /** The vendor database this read, so a user with two installs can see which one it was. */
  source: z.string(),
  syncedAt: z.string().nullable().default(null),
  total: z.number().int().nonnegative(),
  added: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([]),
  changed: z.array(z.string()).default([]),
  unchanged: z.number().int().nonnegative(),
  feedRows: z.number().int().nonnegative().default(0),
  notes: z.array(z.string()).default([]),
});

export type SyncReport = z.infer<typeof SyncReportSchema>;

/** A sync's outcome: the report, or why there is not one. */
export type HouseSync = { kind: 'ok'; report: SyncReport } | HouseFailure;

/** `GET /api/v1/export`'s outcome (#247): the house document's own text, as the file the user saves. */
export type HouseExport = { kind: 'ok'; text: string } | HouseFailure;

/**
 * The house service, as the stores see it.
 *
 * `call` is the only method a fake client has to implement for the whole write path, and `inventory`
 * exists as its own read for the same reason `tools` does: its own validator, its own ETag, its own
 * caller.
 */
export interface HouseClient {
  probe(opts?: HouseRequestOptions): Promise<HouseProbe>;
  tools(etag: string | null, opts?: HouseRequestOptions): Promise<HouseTools>;
  feeds(etag: string | null, opts?: HouseRequestOptions): Promise<HouseFeeds>;
  inventory(etag: string | null, opts?: HouseRequestOptions): Promise<HouseInventory>;
  /**
   * One request, without interpretation.
   *
   * `body` is JSON-encoded unless it is already a `string`, which is sent verbatim — the one caller
   * that needs that is import, whose body IS `export`'s answer and must reach the service byte for
   * byte rather than through a second round of parsing.
   */
  call(
    method: HouseMethod,
    path: string,
    body?: unknown,
    opts?: HouseRequestOptions,
  ): Promise<HouseCall>;
}

/**
 * Where the service is, from the page's own point of view.
 *
 * The origin that served this page is the only candidate, and not a guess: in the desktop app the
 * window's URL is the embedded server's address, and a browser can only have loaded this page from
 * something that answers `{@link HOUSE_API_PATH}` — a second address would need its own discovery
 * and its own Windows firewall story for nothing (#306). Returns `''` when there is no `location`
 * at all (a unit test, a worker), which makes every URL relative and every probe honestly `absent`.
 */
export function houseBaseUrl(): string {
  if (typeof location === 'undefined') return '';
  const origin = location.origin;
  // `file://` and other opaque origins report the literal string "null"; a relative URL is the
  // honest version of "this page has no origin", and it fails the probe rather than fetching
  // `null/api/v1/health`.
  return origin === 'null' ? '' : origin;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface RawResponse {
  status: number;
  contentType: string;
  etag: string | null;
  text: string;
}

/**
 * One GET, with the facts a caller needs to judge it. Never throws for an HTTP status: a 404 from a
 * static host is data, not an exception.
 */
async function send(
  method: HouseMethod,
  path: string,
  opts: HouseRequestOptions & { etag?: string | null; body?: unknown },
): Promise<RawResponse> {
  const root = (opts.base ?? houseBaseUrl()).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`no answer within ${timeoutMs} ms`)),
    timeoutMs,
  );
  const forward = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', forward, { once: true });

  const headers: Record<string, string> = { Accept: 'application/json' };
  // Only sent when there IS a validator to send: `If-None-Match: null` would be a request the
  // server cannot honour, and #306's ETag story is that a 304 means "byte-identical", not "I
  // forgot".
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  // A guarded write's validator (#321), and the other direction: `If-None-Match` asks to be spared a
  // body, `If-Match` asks the service to check the caller's copy is still current. Only sent when
  // there is one — an empty `If-Match` would be a validator that matches nothing, and the service's
  // 428 already says what a missing one means.
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  // A body that is not there is not an empty body: `Content-Type: application/json` with nothing
  // after it is a request the service cannot parse, and a sync takes no body at all.
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  try {
    const res = await fetch(`${root}${HOUSE_API_PATH}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      etag: res.headers.get('etag'),
      text: await res.text(),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', forward);
  }
}

/** One GET. The reads below are the only callers. */
function get(
  path: string,
  opts: HouseRequestOptions & { etag?: string | null },
): Promise<RawResponse> {
  return send('GET', path, opts);
}

/**
 * The service's own refusal, or `null` if this was something else answering. The shape is the
 * service's (`house_api.rs`'s `error_response` writes `{"error": "..."}` and nothing else), so a
 * page, a proxy's redirect or a static host's 404 — all of which arrive at some status or other —
 * cannot be read as a refusal and shown to the user as if the service had said it.
 */
function refusalOf(res: RawResponse): string | null {
  if (!isJson(res.contentType)) return null;
  try {
    const body: unknown = JSON.parse(res.text);
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const message = (body as { error: unknown }).error;
      if (typeof message === 'string' && message.trim().length > 0) return message;
    }
  } catch {
    // An unreadable body is not a refusal; the caller falls back to "not the service".
  }
  return null;
}

/**
 * The path for a key or an id. The Rust routes are wildcards (`/tools/*key`), so a `/` in a key must
 * stay a path separator; everything else a segment could carry — a space, a `#`, a `?` — must not,
 * or the request goes somewhere other than the key's route.
 */
function keyPath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

function isJson(contentType: string): boolean {
  return contentType.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/**
 * The sentence a user sees when something other than the service answered. It names the origin and
 * the content type, because "the web app has no house service" and "a proxy is intercepting" look
 * identical from inside the code and completely different to whoever has to fix it.
 */
function notTheService(root: string, res: RawResponse): string {
  const where = root === '' ? 'this page' : root;
  return `the page at ${where} answered with ${res.contentType || 'no content type'}, not the house service`;
}

const realClient: HouseClient = {
  async probe(opts = {}) {
    const root = (opts.base ?? houseBaseUrl()).replace(/\/+$/, '');
    let res: RawResponse;
    try {
      res = await get('/health', opts);
    } catch (e) {
      // A refused connection, a DNS failure, an aborted timeout: the service is not answering.
      return { kind: 'error', detail: reasonOf(e) };
    }
    // 404 is the web deployment and most static hosts; anything else non-200 is a proxy or a
    // misconfiguration. Neither is the house service, and neither is a crash.
    if (res.status !== 200) return { kind: 'absent', reason: notTheService(root, res) };
    if (!isJson(res.contentType)) return { kind: 'absent', reason: notTheService(root, res) };

    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      return { kind: 'error', detail: `${root}${HOUSE_API_PATH}/health is not readable JSON` };
    }
    const parsed = HouseHealthSchema.safeParse(json);
    if (!parsed.success) {
      return {
        kind: 'error',
        detail: `the house service's health does not match this build: ${firstIssue(parsed.error)}`,
      };
    }
    if (parsed.data.schemaVersion !== HOUSE_SCHEMA_VERSION) {
      return {
        kind: 'error',
        detail: `the house service speaks version ${parsed.data.schemaVersion}; this build reads version ${HOUSE_SCHEMA_VERSION}`,
      };
    }
    return { kind: 'present', health: parsed.data, base: root };
  },

  async tools(etag, opts = {}) {
    const root = (opts.base ?? houseBaseUrl()).replace(/\/+$/, '');
    let res: RawResponse;
    try {
      res = await get('/tools', { ...opts, etag });
    } catch (e) {
      return { kind: 'error', detail: reasonOf(e) };
    }
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status !== 200) return { kind: 'absent', reason: notTheService(root, res) };
    if (!isJson(res.contentType)) return { kind: 'absent', reason: notTheService(root, res) };

    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      return { kind: 'error', detail: `${root}${HOUSE_API_PATH}/tools is not readable JSON` };
    }
    // The SAME schema the built-in list is written to (#305): the service does not get a laxer
    // parse than the file does, and a duplicate key is a refusal whoever sent it.
    const parsed = ToolLibrarySchema.safeParse(json);
    if (!parsed.success) {
      return {
        kind: 'error',
        detail: `the house service's tool list does not match this build: ${firstIssue(parsed.error)}`,
      };
    }
    return { kind: 'ok', etag: res.etag, entries: parsed.data };
  },

  // #310. Deliberately a SEPARATE document from the tool list rather than a field on it: the two
  // are read for different reasons, the feed matrix is 1 328 rows against the cutters' 129, and a
  // build that wants only the cutters should not have to parse the matrix. It also gives the rows
  // their own validator, so a malformed feed row costs the feeds tier and not the whole house.
  async feeds(etag, opts = {}) {
    const root = (opts.base ?? houseBaseUrl()).replace(/\/+$/, '');
    let res: RawResponse;
    try {
      res = await get('/feeds', { ...opts, etag });
    } catch (e) {
      return { kind: 'error', detail: reasonOf(e) };
    }
    if (res.status === 304) return { kind: 'unchanged' };
    // 404 is a service that has not synced since the feed tier existed, and also every static host.
    // Either way there is no catalogue here, which is a normal answer, not a failure.
    if (res.status !== 200) return { kind: 'absent', reason: notTheService(root, res) };
    if (!isJson(res.contentType)) return { kind: 'absent', reason: notTheService(root, res) };

    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      return { kind: 'error', detail: `${root}${HOUSE_API_PATH}/feeds is not readable JSON` };
    }
    const parsed = FeedCatalogueSchema.safeParse(json);
    if (!parsed.success) {
      return {
        kind: 'error',
        detail: `the house service's feed catalogue does not match this build: ${firstIssue(parsed.error)}`,
      };
    }
    return { kind: 'ok', etag: res.etag, rows: parsed.data };
  },

  // #309. The inventory is a THIRD document, not a field on the tool list: an item is a physical
  // possession with a count and codes, a tool is a definition, and the two are edited by different
  // parts of the panel. Same contract and same ETag discipline as the two reads above.
  async inventory(etag, opts = {}) {
    const root = (opts.base ?? houseBaseUrl()).replace(/\/+$/, '');
    let res: RawResponse;
    try {
      res = await get('/inventory', { ...opts, etag });
    } catch (e) {
      return { kind: 'error', detail: reasonOf(e) };
    }
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status !== 200) return { kind: 'absent', reason: notTheService(root, res) };
    if (!isJson(res.contentType)) return { kind: 'absent', reason: notTheService(root, res) };

    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      return { kind: 'error', detail: `${root}${HOUSE_API_PATH}/inventory is not readable JSON` };
    }
    const parsed = InventorySchema.safeParse(json);
    if (!parsed.success) {
      return {
        kind: 'error',
        detail: `the house service's inventory does not match this build: ${firstIssue(parsed.error)}`,
      };
    }
    return { kind: 'ok', etag: res.etag, items: parsed.data };
  },

  // The whole write path, and the whole reason it is one method: what makes a write's answer a
  // refusal rather than a stray page is one rule, stated once (see `refusalOf`).
  async call(method, path, body, opts = {}) {
    const root = (opts.base ?? houseBaseUrl()).replace(/\/+$/, '');
    let res: RawResponse;
    try {
      res = await send(method, path, { ...opts, body });
    } catch (e) {
      // A refused connection, a DNS failure, an aborted timeout: nothing is there to have answered.
      return { kind: 'error', detail: reasonOf(e) };
    }
    if (res.status >= 200 && res.status < 300) {
      // The service's successes are mostly EMPTY — a bare 201/204 carries no content type at all,
      // and that is the most successful answer there is. A success that arrives WITH one that is not
      // JSON is a page, not a service: a static host that rewrites every path to `index.html` would
      // otherwise turn a write nobody performed and an export nobody wrote into a cheerful 200.
      if (res.contentType !== '' && !isJson(res.contentType)) {
        return { kind: 'absent', reason: notTheService(root, res) };
      }
      return { kind: 'ok', text: res.text };
    }
    const message = refusalOf(res);
    if (message !== null) return { kind: 'refused', status: res.status, message };
    return { kind: 'absent', reason: notTheService(root, res) };
  },
};

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognised shape';
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}

let clientFactory: () => Promise<HouseClient> = async () => realClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real one. */
export function setHouseClientLoader(fn: (() => Promise<HouseClient>) | null): void {
  clientFactory = fn ?? (async () => realClient);
}

/**
 * Every exported call goes through here, for two reasons: the client is loaded lazily (the real one
 * is this module's own object; a test swaps in a fake), and nothing reaches a caller as a throw —
 * a caller here has to render a failure as readily as a success.
 *
 * A client factory that throws is the one failure no call can report in its own terms, so it
 * becomes the same `error` a dead socket produces. Every return type below already contains that
 * member, which is why the union here needs no unwrapping at the call sites.
 */
async function ask<T>(fn: (client: HouseClient) => Promise<T>): Promise<T | HouseReadFailure> {
  try {
    return await fn(await clientFactory());
  } catch (e) {
    return { kind: 'error', detail: reasonOf(e) };
  }
}

/**
 * Look for the house service and report what it says about itself. Never throws — every failure is
 * one of the three outcomes, because the caller has to render a failure as readily as a success.
 */
export async function probeHouse(opts?: HouseRequestOptions): Promise<HouseProbe> {
  return ask((client) => client.probe(opts));
}

/**
 * Read the tiers above the built-ins. `etag` is the validator from the last read, so an unchanged
 * list costs a 304 and no body (`store/toolRegistryStore.ts` keeps it).
 */
export async function houseTools(
  etag: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseTools> {
  return ask((client) => client.tools(etag, opts));
}

/**
 * Read the machine's own feed catalogue (#310). Same contract as {@link houseTools}, including the
 * ETag: rows are the vendor's, and re-reading 1 328 of them on every store refresh would be the
 * cost this endpoint's validator exists to avoid.
 */
export async function houseFeeds(
  etag: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseFeeds> {
  return ask((client) => client.feeds(etag, opts));
}

/**
 * Read the cutters the user physically owns (#309). The same contract as {@link houseTools}: the
 * caller keeps its items on `unchanged`, and `absent` is a build with no service, not an error.
 */
export async function houseInventory(
  etag: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseInventory> {
  return ask((client) => client.inventory(etag, opts));
}

// — the writes (#309/#311). Each is one request with the naming the callers want; the judgement
// about what an answer means lives in `call`, once.
//
// THREE OF THE FOUR GUARDED WRITES TAKE A VALIDATOR, AND IT IS NOT OPTIONAL (#321). A replace or a
// remove changes a document somebody has already read, so the request has to say WHICH version of it
// the change was made against: `ifMatch` is the `ETag` from that read (`toolRegistryStore` keeps
// both, in `etag` and `inventoryEtag`). Without it the service answers 428 rather than resolving two
// windows' saves by arrival order — last-writer-wins with a status code.
//
// The parameter is required while its TYPE allows null, and that is on purpose. `null` means "this
// client holds no version", which is a real state (nothing has been read yet) and one the service has
// a sentence for; making it `string` would push every caller through an invented etag instead.
// Registering is NOT guarded: a create is judged against the KEY, which is a stronger answer than any
// validator (a second create of the same key is a 409 whatever version it was based on).

/** Register a new cutter, or a definition the catalogue did not have. */
export async function houseRegisterTool(
  entry: ToolLibraryEntry,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return ask(async (client) => okOnly(await client.call('POST', '/tools', entry, opts)));
}

/** Replace a definition in place — a clone being edited, or one the user corrected. */
export async function houseReplaceTool(
  entry: ToolLibraryEntry,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return ask(
    async (client) =>
      okOnly(await client.call('PATCH', `/tools/${keyPath(entry.key)}`, entry, { ...opts, ifMatch })),
  );
}

/** Remove a definition the user's house owns. The catalogue's own rows are not removable. */
export async function houseRemoveTool(
  key: string,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return ask(
    async (client) =>
      okOnly(await client.call('DELETE', `/tools/${keyPath(key)}`, undefined, { ...opts, ifMatch })),
  );
}

/** Register a physical cutter (#309's third door). The id is the client's; the codes are the evidence. */
export async function houseRegisterItem(
  item: InventoryItem,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return ask(async (client) => okOnly(await client.call('POST', '/inventory', item, opts)));
}

/** Change a possession: its count, its notes, or which codes identify it. */
export async function houseReplaceItem(
  item: InventoryItem,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return ask(
    async (client) =>
      okOnly(await client.call('PATCH', `/inventory/${keyPath(item.id)}`, item, { ...opts, ifMatch })),
  );
}

/** Take a cutter out of the inventory. Its definition is a separate thing and survives. */
export async function houseRemoveItem(
  id: string,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return ask(
    async (client) =>
      okOnly(await client.call('DELETE', `/inventory/${keyPath(id)}`, undefined, { ...opts, ifMatch })),
  );
}

/**
 * Import Makera's catalogue from Studio's own library (#308). Takes NO body: the path to the vendor
 * file is the service's own, and an endpoint that read a path from a request would be a way to read
 * any file on the machine it runs on. The report is the answer.
 */
export async function houseSyncCatalogue(opts?: HouseRequestOptions): Promise<HouseSync> {
  return ask(async (client) => {
    const res = await client.call('POST', '/catalogue/sync', undefined, opts);
    if (res.kind !== 'ok') return res;
    const parsed = parseJson(res.text, SyncReportSchema);
    return parsed.kind === 'ok'
      ? { kind: 'ok', report: parsed.value }
      : { kind: 'error', detail: `the sync's report ${parsed.why}` };
  });
}

/**
 * The house document as the file the user saves (#247's "my machine" export, without the fixtures'
 * half). The text is handed back rather than written anywhere: this module talks to the service, not
 * to the filesystem, and the caller owns the filename.
 */
export async function houseExportHouse(opts?: HouseRequestOptions): Promise<HouseExport> {
  return ask(async (client) => {
    const res = await client.call('GET', '/export', undefined, opts);
    return res.kind === 'ok' ? { kind: 'ok', text: res.text } : res;
  });
}

/**
 * Load a house document over the one the service holds. `text` is sent VERBATIM — it is an export's
 * own answer, and re-encoding it would be a chance to change it. The service decides what the file
 * is (kind, version, every key) and refuses in a sentence the user can act on.
 */
export async function houseImportHouse(
  text: string,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return ask(async (client) => okOnly(await client.call('POST', '/import', text, opts)));
}

/** A write's success body is empty; only its `text` is dropped, never its failure. */
function okOnly(res: HouseCall): HouseWrite {
  return res.kind === 'ok' ? { kind: 'ok' } : res;
}

/** Parse a success body, or say in one clause why it could not be read. */
function parseJson<T>(
  text: string,
  schema: z.ZodType<T>,
): { kind: 'ok'; value: T } | { kind: 'error'; why: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'error', why: 'is not readable JSON' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { kind: 'error', why: `does not match this build: ${firstIssue(parsed.error)}` };
  return { kind: 'ok', value: parsed.data };
}
