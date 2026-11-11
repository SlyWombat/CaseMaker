/**
 * #787 — the desktop crash log's tail, for the crash report.
 *
 * THE IMPORT IS COMPILE-TIME DEAD ON THE WEB. The guard reads the vite `define` INLINE
 * (`__BUILD_TARGET__`), so the web build sees `if (true) return []` and the bundler drops the
 * `@tauri-apps/api` import with the branch — the same rule `capabilities.loadMachineBridge` uses,
 * and what keeps the whole Tauri dependency out of the public bundle (#181,
 * `tools/check-platform-gate.mjs`).
 *
 * #1198 — WHY THE DEFINE IS READ INLINE, NOT THROUGH `BUILD_TARGET`: the exported const is a
 * different module's binding, and rolldown kept this dynamic import in the web graph even though
 * the branch could never run — the web dist shipped an orphan `core-*.js` (the `invoke` shim)
 * that nothing referenced. #1196 hit the same thing in `flightRecorder.ts`; the inline define
 * folds the branch and the chunk is not emitted at all.
 *
 * The file it reads is written by `crash_log.rs`: one JSON line per WebView2 `ProcessFailed`, with
 * the process kind, the reason and the exit code. An empty list means no process has failed on
 * this machine, or the log could not be read — either way the report carries what it has.
 */
export async function readDesktopCrashLog(): Promise<string[]> {
  if (__BUILD_TARGET__ !== 'desktop') return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const lines = await invoke<string[]>('crash_log_tail');
    return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}
