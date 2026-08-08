import { useState } from 'react';
import { useJobStore } from '@/store/jobStore';

/**
 * Issue #37 + #51 — surface placement-validator findings as a sticky banner
 * above the viewport. The report is produced once per compile in
 * ProjectCompiler.ts and shipped to the job store; we just read it here
 * instead of re-running validatePlacements on every render. Errors get a red
 * bar; warnings only get a yellow bar. Clicking an entry doesn't navigate
 * yet — that's a follow-up — but the message names the offending feature ids
 * so users can find them by hand.
 *
 * Dismissible: the ✕ hides the banner for the CURRENT issue set only — any
 * change in the report's content (new issue, message change, one fixed)
 * brings it back. Keyed by content, not by compile, so the banner doesn't
 * reappear on every rebuild while the same problems persist.
 */
export function PlacementBanner() {
  const report = useJobStore((s) => s.placementReport);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!report || (report.errorCount === 0 && report.warningCount === 0)) return null;

  const contentKey = report.issues.map((i) => `${i.severity}:${i.message}`).join('|');
  if (dismissedKey === contentKey) return null;

  const severity: 'error' | 'warning' = report.errorCount > 0 ? 'error' : 'warning';

  return (
    <div
      className={`placement-banner placement-banner--${severity}`}
      data-testid="placement-banner"
      data-severity={severity}
    >
      <div className="placement-banner__head">
        {report.errorCount > 0 && (
          <span className="placement-banner__count">
            {report.errorCount} error{report.errorCount > 1 ? 's' : ''}
          </span>
        )}
        {report.warningCount > 0 && (
          <span className="placement-banner__count">
            {report.warningCount} warning{report.warningCount > 1 ? 's' : ''}
          </span>
        )}
        <button
          type="button"
          className="placement-banner__close"
          data-testid="placement-banner-close"
          aria-label="Dismiss warnings (they return if the issues change)"
          title="Dismiss — returns if the issues change"
          onClick={() => setDismissedKey(contentKey)}
        >
          ✕
        </button>
      </div>
      <ul className="placement-banner__list">
        {report.issues.slice(0, 5).map((iss, idx) => (
          <li key={idx} data-severity={iss.severity}>
            <span className="placement-banner__sev">[{iss.severity}]</span>{' '}
            {iss.message}
          </li>
        ))}
        {report.issues.length > 5 && (
          <li className="placement-banner__more">… +{report.issues.length - 5} more</li>
        )}
      </ul>
    </div>
  );
}
