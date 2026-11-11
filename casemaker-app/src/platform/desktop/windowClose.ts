/**
 * #1196 — the desktop window's close as a CLEAN EXIT, for the flight recorder's session marker.
 *
 * WebView2 does not reliably run the page's `pagehide`/`beforeunload` when the shell's window is
 * closed, so the recorder's marker survived ordinary quits: every next start read the last session
 * — usually a cleanly ended one — as a crash. All six reports in the house's crash-reports folder
 * were a day old for exactly this reason, several of them ending in a `work … end` crumb.
 *
 * `onCloseRequested` is Tauri's own event for the user closing the window: the handler runs and the
 * close proceeds (never prevented — this is bookkeeping, never a gate), so the marker is cleared
 * exactly as a browser tab's `pagehide` clears it.
 *
 * DESKTOP ONLY, and reached only through a guarded `await import()` (`flightRecorder.ts`), so the
 * web build drops the module with the dead branch — the same shape as `crashLog.ts` (#181).
 */
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Register `onClose` for the window's close request. The caller guards the desktop build. */
export function onWindowClose(onClose: () => void): void {
  void getCurrentWindow().onCloseRequested(() => {
    onClose();
  });
}
