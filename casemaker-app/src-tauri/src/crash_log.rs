//! #787 — WEBVIEW2 PROCESS FAILURES, ON DISK.
//!
//! A renderer killed for running out of memory ("Aw, Snap") never reaches the page's own flight
//! recorder: the recorder's session marker survives and earns the banner, but the WHY does not —
//! no JS stack exists for an OOM kill. WebView2 raises `ProcessFailed` with the process kind, the
//! reason and (on newer runtimes) the exit code and the process's own description. The desktop
//! shell writes one JSON line per event to `crash.log` in the app's log directory; the page asks
//! for the tail on the next load (`crash_log_tail`) and puts it in the crash report it offers to
//! save or send. No outside service, and nothing is uploaded from here.

use std::io::Write;
use std::path::Path;

/// The most lines the page is handed — a log that has run away must not become the thing that
/// breaks the page reading it.
pub const TAIL_LINES: usize = 20;
/// The most bytes one line may carry (a `ProcessDescription` can be long; a broken one may not).
pub const MAX_LINE_BYTES: usize = 8 * 1024;

/// Append one line to the crash log, creating the directory if needed. BEST-EFFORT by design: a
/// recorder that cannot record must not disturb the app it is watching.
pub fn append_line(path: &Path, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let clipped: String = line.replace(['\r', '\n'], " ").chars().take(MAX_LINE_BYTES).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{clipped}");
    }
}

/// The last [`TAIL_LINES`] lines, each capped at [`MAX_LINE_BYTES`]. A missing file is an empty
/// list — a first run has no crash log and that is not a problem.
pub fn tail(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| l.chars().take(MAX_LINE_BYTES).collect::<String>())
        .collect();
    if lines.len() > TAIL_LINES {
        lines.drain(0..lines.len() - TAIL_LINES);
    }
    lines
}

/// The process kind's words. A value this build does not know is logged as `kind-<n>` rather than
/// guessed at; the numbers are WebView2's own.
fn kind_words(kind: i32) -> String {
    match kind {
        0 => "browser-process-exited".into(),
        1 => "render-process-exited".into(),
        2 => "render-process-unresponsive".into(),
        3 => "frame-render-process-exited".into(),
        4 => "utility-process-exited".into(),
        5 => "sandbox-helper-process-exited".into(),
        6 => "gpu-process-exited".into(),
        7 => "ppapi-plugin-process-exited".into(),
        8 => "ppapi-broker-process-exited".into(),
        9 => "unknown-process-exited".into(),
        n => format!("kind-{n}"),
    }
}

/// The reason's words, as WebView2's `COREWEBVIEW2_PROCESS_FAILED_REASON` enumerates them.
fn reason_words(reason: i32) -> String {
    match reason {
        0 => "unexpected".into(),
        1 => "out-of-memory".into(),
        2 => "terminated".into(),
        3 => "crashed".into(),
        4 => "launch-failed".into(),
        5 => "unresponsive".into(),
        6 => "profile-deleted".into(),
        n => format!("reason-{n}"),
    }
}

#[cfg(windows)]
pub fn log_line(kind: i32, reason: i32, exit_code: Option<i32>, detail: &str) -> String {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    serde_json::json!({
        "at": at,
        "kind": kind_words(kind),
        "reason": reason_words(reason),
        "exitCode": exit_code,
        "detail": detail,
    })
    .to_string()
}

/// Attach the ProcessFailed listener to the running webview (Windows only). Even a failure to
/// attach is silent here: the recorder's marker still produces the next load's banner, and this
/// file is the extra detail, never the only record.
#[cfg(windows)]
pub fn attach(webview: &tauri::webview::PlatformWebview, path: std::path::PathBuf) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    let core = unsafe { webview.controller().CoreWebView2() };
    let Ok(core) = core else {
        return;
    };
    let handler = ProcessFailedEventHandler::create(Box::new(
        move |_sender: Option<_>, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
            let mut kind =
                webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND(0);
            let mut reason = 0i32;
            let mut exit_code: Option<i32> = None;
            let mut detail = String::new();
            if let Some(args) = args {
                unsafe {
                    let _ = args.ProcessFailedKind(&mut kind);
                    if let Ok(two) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                        let mut r = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_REASON(0);
                        if two.Reason(&mut r).is_ok() {
                            reason = r.0;
                        }
                        let mut code = 0i32;
                        if two.ExitCode(&mut code).is_ok() {
                            exit_code = Some(code);
                        }
                        let mut desc = windows_core::PWSTR::null();
                        if two.ProcessDescription(&mut desc).is_ok() {
                            detail = webview2_com::take_pwstr(desc);
                        }
                    }
                }
            }
            append_line(&path, &log_line(kind.0, reason, exit_code, &detail));
            Ok(())
        },
    ));
    let mut token = 0i64;
    unsafe {
        let _ = core.add_ProcessFailed(&handler, &mut token);
    }
}

/// The non-Windows shell has no WebView2: nothing to attach, and the page's `crash_log_tail` reads
/// an empty list.
#[cfg(not(windows))]
pub fn attach(_webview: &tauri::webview::PlatformWebview, _path: std::path::PathBuf) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_append_and_the_tail_is_the_last_ones_capped() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("logs").join("crash.log");
        assert!(tail(&path).is_empty(), "a missing log is an empty list");
        for i in 0..(TAIL_LINES + 5) {
            append_line(&path, &format!("line {i}"));
        }
        let got = tail(&path);
        assert_eq!(got.len(), TAIL_LINES);
        assert_eq!(got.first().unwrap(), "line 5");
        assert_eq!(got.last().unwrap(), &format!("line {}", TAIL_LINES + 4));
        // A newline in a line cannot become a second line; an overlong one is clipped.
        append_line(&path, "two\nlines");
        let long = "x".repeat(MAX_LINE_BYTES * 2);
        append_line(&path, &long);
        let got = tail(&path);
        assert!(got.iter().any(|l| l == "two lines"));
        assert!(got.iter().all(|l| l.chars().count() <= MAX_LINE_BYTES));
    }

    #[test]
    fn the_words_are_the_known_values_and_never_a_guess() {
        assert_eq!(kind_words(3), "frame-render-process-exited");
        assert_eq!(kind_words(6), "gpu-process-exited");
        assert_eq!(kind_words(99), "kind-99");
        assert_eq!(reason_words(1), "out-of-memory");
        assert_eq!(reason_words(3), "crashed");
        assert_eq!(reason_words(99), "reason-99");
    }
}
