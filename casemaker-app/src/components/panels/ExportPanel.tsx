import { useState } from 'react';
import { DonateButton } from '@/components/layout/DonateButton';
import { useJobStore } from '@/store/jobStore';
import { ExportModal } from './ExportModal';

/**
 * Issue #120 — ExportPanel collapses to a single "Export…" button that
 * opens the persistent ExportModal. The per-format buttons + per-call
 * confirm dialog logic moves into the modal.
 *
 * Placement-error warning (#52) stays inline above the button so the user
 * sees the count before opening the modal; the confirm-on-export check
 * fires inside the modal's per-part Save handler.
 */
export function ExportPanel() {
  const [open, setOpen] = useState(false);
  const placementReport = useJobStore((s) => s.placementReport);
  const errorCount = placementReport?.errorCount ?? 0;

  const onOpen = (): void => {
    if (errorCount > 0) {
      const errorIssues = placementReport!.issues
        .filter((i) => i.severity === 'error')
        .slice(0, 5)
        .map((i) => `• ${i.message}`)
        .join('\n');
      const more = errorCount > 5 ? `\n…and ${errorCount - 5} more.` : '';
      const ok = window.confirm(
        `Placement validator found ${errorCount} error${errorCount === 1 ? '' : 's'} in this project:\n\n${errorIssues}${more}\n\nOpen export anyway?`,
      );
      if (!ok) return;
    }
    setOpen(true);
  };

  return (
    <div className="panel">
      <h3>Export</h3>
      {errorCount > 0 && (
        <p
          className="export-panel__warning"
          style={{ fontSize: 11, color: '#fca5a5', margin: '0 0 8px' }}
          data-testid="export-warning"
        >
          ⚠ {errorCount} placement error{errorCount === 1 ? '' : 's'} — export will prompt to confirm.
        </p>
      )}
      <button
        onClick={onOpen}
        data-testid="export-open"
        title="Open the export panel — list every part with per-part Save plus a Save-all-in-one option."
      >
        ⬇ Export…
      </button>
      {open && <ExportModal onClose={() => setOpen(false)} />}
      <DonateButton variant="export" />
    </div>
  );
}
