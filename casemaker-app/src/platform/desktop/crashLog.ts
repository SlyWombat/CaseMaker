/**
 * #787 — the desktop crash log's tail, for the crash report.
 *
 * THE IMPORT IS COMPILE-TIME DEAD ON THE WEB. `BUILD_TARGET` is a vite `define`, so the web build
 * sees `if (true) return []` and the bundler drops the `@tauri-apps/api` import with the branch —
 * the same rule `capabilities.loadMachineBridge` uses, and what keeps the whole Tauri dependency
 * out of the public bundle (#181, `tools/check-platform-gate.mjs`).
 *
 * The file it reads is written by `crash_log.rs`: one JSON line per WebView2 `ProcessFailed`, with
 * the process kind, the reason and the exit code. An empty list means no process has failed on
 * this machine, or the log could not be read — either way the report carries what it has.
 */
import { BUILD_TARGET } from '@/platform/capabilities';

export async function readDesktopCrashLog(): Promise<string[]> {
  if (BUILD_TARGET !== 'desktop') return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const lines = await invoke<string[]>('crash_log_tail');
    return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}
