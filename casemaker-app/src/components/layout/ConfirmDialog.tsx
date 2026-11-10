import { useEffect, useRef, type JSX, type ReactNode } from 'react';

/**
 * #1123-48 — THE APP'S OWN CONFIRM, not `window.confirm`.
 *
 * The main page's choices (New, and a card that would replace open work) ask once, in the app's own
 * words, in a dialog that can say what happens to the work. A browser confirm cannot carry a name
 * or a highlighted sentence, blocks the whole browser, and reads as a warning from the page rather
 * than a choice in the app. The analyst's fields: no `window.confirm` in this path.
 *
 * Focus starts on Cancel (the safe answer) and Escape cancels; the confirm press is the caller's.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  testId = 'app-confirm',
}: {
  /** The question, one line ("Start a new project?"). */
  title: string;
  /** The honest sentence: what happens to the open work. */
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      data-testid={`${testId}-backdrop`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(6, 9, 13, 0.62)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        style={{
          width: 'min(440px, calc(100vw - 32px))',
          padding: 16,
          background: '#1a1f25',
          border: '1px solid #2a2f36',
          borderRadius: 6,
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 15, color: '#d1d5db' }}>{title}</h2>
        <p data-testid={`${testId}-body`} style={{ margin: '0 0 14px', fontSize: 13, color: '#9aa4b0' }}>
          {body}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button ref={cancelRef} type="button" data-testid={`${testId}-no`} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" data-testid={`${testId}-yes`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
