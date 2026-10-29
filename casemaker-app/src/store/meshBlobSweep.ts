/**
 * #728 — the mesh blob store's sweep, run once at start-up.
 *
 * The blob store (`platform/meshBlobs.ts`) is keyed by SHA-256 and nothing used to delete from it.
 * A mesh is still wanted while the open job names it, or while a recent job's snapshot does (a
 * snapshot saved while its mesh was still loading carries the hash but not the bytes). Everything
 * else goes. Hashes are read out of the recent texts by pattern rather than parsed: the texts are
 * bounded and the field name is the schema's own.
 */
import { sweepMeshBlobs } from '@/platform/meshBlobs';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { recentJobText, useRecentJobsStore } from '@/store/recentJobsStore';

const SHA_FIELD = /"sha256"\s*:\s*"([0-9a-f]{64})"/g;

/** The hashes the open job and the recent jobs still refer to. */
export async function referencedMeshHashes(): Promise<Set<string>> {
  const keep = new Set<string>();
  const target = useEngraveJobStore.getState().job.targetObject;
  if (target !== undefined) keep.add(target.sha256);
  for (const recent of useRecentJobsStore.getState().jobs) {
    const text = await recentJobText(recent.fileName);
    if (text === null) continue;
    for (const m of text.matchAll(SHA_FIELD)) keep.add(m[1]!);
  }
  return keep;
}

/** Sweep the blob store down to what is still referred to. A failure is silent: it is housekeeping. */
export async function sweepUnusedMeshBlobs(): Promise<number> {
  try {
    const keep = await referencedMeshHashes();
    // The open job is asked again at delete time: an import made while the recents were read
    // is still referred to.
    return await sweepMeshBlobs(
      (sha) => keep.has(sha) || useEngraveJobStore.getState().job.targetObject?.sha256 === sha,
    );
  } catch {
    return 0;
  }
}
