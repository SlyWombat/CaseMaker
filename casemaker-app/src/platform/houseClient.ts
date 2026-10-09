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
 * READ-ONLY FOR NOW. `GET /api/v1/health`, `GET /api/v1/tools` and `GET /api/v1/feeds` (#310) are
 * the whole client. The service's write endpoints (register a cutter, clone from the catalogue,
 * import a house file) exist and are tested on the Rust side, but their client arrives with the UI
 * that drives them (#309/#311) — a write path with no user in front of it is untestable in the way
 * that matters. `GET /api/v1/inventory` is likewise the service's, waiting for #309's reader.
 *
 * NO VENDOR DATA, ANYWHERE. What this client receives is the user's own tiers plus whatever their
 * own machine's catalogue holds. Nothing it fetches is committed to the repo and nothing it fetches
 * is sent anywhere (see `/Fabrication.md` §3, #186).
 */

import { z } from 'zod';
import { ToolLibrarySchema, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
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
}

/**
 * What a probe concluded. `absent` covers every "something answered, and it was not the house
 * service" including a static host's 404; `error` means the service is there and this build cannot
 * use it (a version it does not speak, a payload that fails the schema, a dead socket).
 */
export type HouseProbe =
  | { kind: 'present'; health: HouseHealth; base: string }
  | { kind: 'absent'; reason: string }
  | { kind: 'error'; detail: string };

/** What a tool-list read concluded. `unchanged` is a 304: the caller keeps the entries it has. */
export type HouseTools =
  | { kind: 'ok'; etag: string | null; entries: ToolLibraryEntry[] }
  | { kind: 'unchanged' }
  | { kind: 'absent'; reason: string }
  | { kind: 'error'; detail: string };

/** What a feed-catalogue read concluded (#310). The same four outcomes, its own validator. */
export type HouseFeeds =
  | { kind: 'ok'; etag: string | null; rows: FeedCatalogueRow[] }
  | { kind: 'unchanged' }
  | { kind: 'absent'; reason: string }
  | { kind: 'error'; detail: string };

/** The house service, as the store sees it. Three methods, all reads. */
export interface HouseClient {
  probe(opts?: HouseRequestOptions): Promise<HouseProbe>;
  tools(etag: string | null, opts?: HouseRequestOptions): Promise<HouseTools>;
  feeds(etag: string | null, opts?: HouseRequestOptions): Promise<HouseFeeds>;
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
async function get(
  path: string,
  opts: HouseRequestOptions & { etag?: string | null },
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

  try {
    const res = await fetch(`${root}${HOUSE_API_PATH}${path}`, {
      method: 'GET',
      headers,
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
 * Look for the house service and report what it says about itself. Never throws — every failure is
 * one of the three outcomes, because the caller has to render a failure as readily as a success.
 */
export async function probeHouse(opts?: HouseRequestOptions): Promise<HouseProbe> {
  try {
    return await (await clientFactory()).probe(opts);
  } catch (e) {
    return { kind: 'error', detail: reasonOf(e) };
  }
}

/**
 * Read the tiers above the built-ins. `etag` is the validator from the last read, so an unchanged
 * list costs a 304 and no body (`store/toolRegistryStore.ts` keeps it).
 */
export async function houseTools(
  etag: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseTools> {
  try {
    return await (await clientFactory()).tools(etag, opts);
  } catch (e) {
    return { kind: 'error', detail: reasonOf(e) };
  }
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
  try {
    return await (await clientFactory()).feeds(etag, opts);
  } catch (e) {
    return { kind: 'error', detail: reasonOf(e) };
  }
}
