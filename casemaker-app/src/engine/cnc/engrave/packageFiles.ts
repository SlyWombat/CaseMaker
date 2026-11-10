/**
 * #1179 slice C — WHICH FILES ON THE CARD ARE THIS JOB'S, IN ANOTHER PACKAGE.
 *
 * Every uploaded file of a package carries the package's key in its name (`<stem>-<key8>-p01.nc`),
 * so a different plan's file can never be played by name. The cleanup reads the card's listing and
 * selects only this job's files whose name carries a DIFFERENT key, or no key at all (yesterday's
 * names); another job's stem is never touched, and neither is anything that is not a program name.
 */

import type { EngraveJob } from '@/types/engraveJob';

const KEY8 = /^[0-9a-f]{8}$/i;

/** A package hash as a name key, or null when it is absent or not an 8-hex FNV key. */
export function key8Of(hash: string | null | undefined): string | null {
  return typeof hash === 'string' && KEY8.test(hash) ? hash.toLowerCase() : null;
}

/** The key of the job's frozen package, when it has one. */
export function packageKeyOf(job: Pick<EngraveJob, 'package'>): string | null {
  return key8Of(job.package?.hash ?? null);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The files of `names` that are this job's but another package's:
 *   - a keyed name whose key differs from `key8` (`<stem>-<key8>-p01.nc`, `-face`, `-airwalk`…);
 *   - a legacy keyless name of this stem (`<stem>.nc`, `<stem>-p01.nc`, `<stem>-airwalk.nc`, …).
 * `key8` null (a package frozen before the key existed) selects only the keyless legacy names.
 */
export function otherPackageFilesFor(names: readonly string[], stem: string, key8: string | null): string[] {
  const s = escapeRegExp(stem);
  // Keyed: the stem, a hyphen, exactly eight hex characters, then any suffix and `.nc`.
  const keyed = new RegExp(`^${s}-([0-9a-f]{8})(?:[-.].*)?\\.nc$`, 'i');
  // Keyless legacy: the stem, an optional dry marker, program number, or a face/frame/walk suffix.
  const legacy = new RegExp(`^${s}(?:-dry)?(?:-p\\d+)?(?:-(?:face|frame|airwalk|clean))?\\.nc$`, 'i');
  return names.filter((name) => {
    const match = keyed.exec(name);
    if (match !== null) return key8 === null || match[1]!.toLowerCase() !== key8;
    return legacy.test(name);
  });
}
