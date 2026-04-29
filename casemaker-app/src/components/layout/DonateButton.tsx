// Issue #72 — Production-only Donate button.
// Renders only when __DONATE_URL__ is non-empty (set by deploy-cpanel.mjs from
// .env DONATE_URL). Hidden in dev, Tauri desktop, GitHub Pages, etc.
//
// Two surfaces:
//   variant="status"  — small "☕ Tip" link in the StatusBar.
//   variant="export"  — fuller prompt under the Export panel after first export.

interface DonateButtonProps {
  variant: 'status' | 'export';
}

export function DonateButton({ variant }: DonateButtonProps) {
  if (!__DONATE_URL__) return null;
  if (variant === 'status') {
    return (
      <a
        className="donate-link"
        href={__DONATE_URL__}
        target="_blank"
        rel="noopener"
        title="Saved you a print? Buy me a coffee — pays the hosting bill."
        data-testid="donate-link-status"
      >
        ☕ Tip the dev
      </a>
    );
  }
  return (
    <div className="donate-prompt" data-testid="donate-prompt-export">
      <p>Nice — your case is ready to print.</p>
      <p>
        If Case Maker saved you a re-print or two,{' '}
        <a href={__DONATE_URL__} target="_blank" rel="noopener">
          tip the dev
        </a>{' '}
        — the project's free, the hosting isn't. Any amount is appreciated. ☕
      </p>
    </div>
  );
}
