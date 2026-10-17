// The shop's own defaults, as the BENCH TOOLS read them (#449): `location.json`'s `defaults` section,
// the same document the app reads through the house service, so `z1.mjs run` and `power.sh` wait,
// poll and give up by the numbers the app uses rather than by copies of them.
//
// WHY A RESTATEMENT. The app's registry is `src/platform/defaultsClient.ts`'s `KNOWN_DEFAULTS`, which
// imports zod and `@/` paths that plain Node cannot load without the app's build. So the keys these
// tools read are restated here — each with its bounds and its fallback — and
// `tests/unit/benchDefaults.spec.ts` holds every one of them to the registry: the same fallback, and
// accepted or refused at exactly the same bounds. A key changed there and not here fails that spec.
//
// WHERE THE FILE IS: `--location <file>`, else `CASEMAKER_LOCATION`, else the app's own data folder —
// `%APPDATA%\casemaker\location.json` on Windows (`$XDG_DATA_HOME` or `~/.local/share` elsewhere), the
// path `scripts/engrave-job.ts` and the desktop app use. `none` for either means "no location": every
// value is its fallback (the tests use it, so a run on the maintainer's machine is not steered by the
// maintainer's own file).
//
// A FALLBACK SAYS SO. Each value comes back with its source: `seeded`, `chosen` or `measured` (the
// file's own word) or `fallback`, and a value the file holds outside its bounds is NOT used — it falls
// back, and the note says why, the way `readDefault` treats it in the app.
//
// Read-only: this opens one file for reading and never writes anything.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The keys the bench tools read. `min`/`max` are inclusive, as zod's `.min`/`.max` are; `int` is
 * zod's `.int()`. Each fallback is the key's `KNOWN_DEFAULTS` fallback, which is its seed.
 */
export const BENCH_DEFAULTS = Object.freeze({
  // `z1.mjs run` — the status poll (never under the compiled 2000 ms floor, MIN_STATUS_POLL_MS), the
  // bound on a job that reports no progress, and the unanswered polls that end the watch.
  'run.pollMs': { min: 2000, max: 60000, fallback: 2000, unit: 'ms' },
  'run.noProgressMs': { min: 15000, max: 600000, fallback: 30000, unit: 'ms' },
  'run.missLimit': { min: 1, max: 10, int: true, fallback: 3, unit: 'polls' },
  // `z1.mjs run`'s Ctrl-C and the app's Stop both give `abort` this reply window; then how many Idle
  // polls before `M332`. NOT `stop.idlePollMs`: in the app that is the wait between those polls, while
  // the harness paces them by `run.pollMs` and its compiled 5000 there is each poll's REPLY window — a
  // different quantity.
  'stop.abortReplyMs': { min: 20000, max: 300000, fallback: 60000, unit: 'ms' },
  'stop.idlePolls': { min: 1, max: 20, int: true, fallback: 3, unit: 'polls' },
  // `power.sh on` — how long it waits, the pause in a cycle, and the wait between checks.
  'power.onWaitSeconds': { min: 10, max: 1800, fallback: 180, unit: 's' },
  'power.cyclePauseSeconds': { min: 3, max: 120, fallback: 10, unit: 's' },
  'power.pollSeconds': { min: 2, max: 60, fallback: 3, unit: 's' },
});

/** Whether `value` is within `key`'s bounds — `KNOWN_DEFAULTS[key].rule.safeParse(value).success`. */
export function accepts(key, value) {
  const k = BENCH_DEFAULTS[key];
  if (k === undefined) throw new Error(`${key} is not a key the bench tools read`);
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= k.min &&
    value <= k.max &&
    (!k.int || Number.isInteger(value))
  );
}

/** The app's own location file on this machine, or null when there is no data folder to look in. */
export function defaultLocationPath(env = process.env, platform = process.platform) {
  const base =
    platform === 'win32'
      ? env.APPDATA
      : (env.XDG_DATA_HOME ?? (env.HOME ? join(env.HOME, '.local', 'share') : undefined));
  return base ? join(base, 'casemaker', 'location.json') : null;
}

/**
 * Read `keys` (default: every bench key). Never throws for a missing or unreadable file — the tools
 * run on their fallbacks then, as the app does with no house service — and says which happened.
 *
 * Returns `{ path, note, values }`: `path` is the file read (null when none was), `note` says why no
 * file was used, and `values[key]` is `{ value, source, unit, note? }`.
 */
export function readBenchDefaults({ location, env = process.env, platform = process.platform, keys } = {}) {
  const wanted = keys ?? Object.keys(BENCH_DEFAULTS);
  for (const key of wanted) {
    if (BENCH_DEFAULTS[key] === undefined) throw new Error(`${key} is not a key the bench tools read`);
  }
  const asked = location ?? env.CASEMAKER_LOCATION;
  const path = asked === 'none' ? null : (asked ?? defaultLocationPath(env, platform));

  let section = null;
  let note = null;
  if (path === null) {
    note = asked === 'none' ? 'no location asked for (none)' : 'no data folder to look for location.json in';
  } else if (!existsSync(path)) {
    note = `${path} does not exist`;
  } else {
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      if (doc && typeof doc === 'object' && doc.defaults && typeof doc.defaults === 'object') section = doc.defaults;
      else note = `${path} has no defaults section`;
    } catch (e) {
      note = `${path} could not be read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const values = {};
  for (const key of wanted) {
    const k = BENCH_DEFAULTS[key];
    const d = section?.[key];
    const why = whyNotUsed(key, k, d);
    if (d !== undefined && why === null) {
      values[key] = { value: d.value, source: d.source, unit: k.unit };
    } else {
      values[key] = {
        value: k.fallback,
        source: 'fallback',
        unit: k.unit,
        ...(d !== undefined && why !== null ? { note: why } : {}),
      };
    }
  }
  return { path: section === null ? null : path, note, values };
}

/** Why a stored entry is not used, in a sentence — or null when it is usable. Each reason is its own. */
function whyNotUsed(key, k, d) {
  if (d === undefined) return null;
  if (d === null || typeof d !== 'object') return 'the file\'s entry is not an object — not used';
  if (!['seeded', 'chosen', 'measured'].includes(d.source)) {
    return `the file's entry has source ${JSON.stringify(d.source)}, not seeded, chosen or measured — not used`;
  }
  if (!accepts(key, d.value)) {
    return `the file's ${JSON.stringify(d.value)} is outside ${k.min} to ${k.max}${k.int ? ', whole' : ''} — not used`;
  }
  return null;
}

/** One line per value, for a person: `run.pollMs = 2000 ms (seeded, from C:\…\location.json)`. */
export function describeBenchDefaults(result) {
  return Object.entries(result.values).map(([key, v]) => {
    const where = v.source === 'fallback' ? `fallback${result.note ? `: ${result.note}` : ''}` : `${v.source}, from ${result.path}`;
    return `${key} = ${v.value} ${v.unit} (${where}${v.note ? `; ${v.note}` : ''})`;
  });
}
