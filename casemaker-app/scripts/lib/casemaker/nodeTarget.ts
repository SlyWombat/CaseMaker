// What this process is, for the app modules it reaches (#477).
//
// `src/platform/capabilities.ts` reads the build-time constant `__BUILD_TARGET__` that Vite injects;
// the app's own checks (`tools/check-platform-gate.mjs`) rely on that constant folding so the web
// bundle drops desktop-only code. A Node entry point has no bundler to inject it, and importing
// `machineUpload.ts` — which `machine upload` does, because the upload gate must be the app's —
// reaches `capabilities.ts` by a top-level import.
//
// So the CLI states the answer before any of those modules is evaluated. `desktop` is the truthful
// value: this process can open the raw sockets `capabilities.ts` is asking about, and that is the
// same seam `scripts/machine-upload-check.ts` relies on when it drives the real bridge over the
// Node transport. The assignment lands on the global object, where an unqualified identifier read
// finds it exactly as the injected literal would have been found.
//
// THIS FILE MUST BE IMPORTED FIRST. ES modules are evaluated in the order their imports are
// declared, so the entry point names this one before the handlers that pull in the app.

(globalThis as unknown as Record<string, unknown>).__BUILD_TARGET__ = 'desktop';
