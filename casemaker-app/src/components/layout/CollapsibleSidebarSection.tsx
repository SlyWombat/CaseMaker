import { useState, type ReactNode } from 'react';

interface CollapsibleSidebarSectionProps {
  title: string;
  /** Persists collapsed/expanded across reloads under this key. */
  storageKey: string;
  /** Initial state when the storageKey has no saved value. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Sidebar section header that toggles its body content open/closed.
 *  All sections start COLLAPSED by default — click the header chevron
 *  to expand. State persists to localStorage so refreshing the page
 *  keeps the user's chosen-open sections open.
 *
 *  The wrapped panel may render its own title; we add a CSS rule on the
 *  body div that hides the first descendant <h3> so we don't double up. */
export function CollapsibleSidebarSection({
  title,
  storageKey,
  defaultOpen = false,
  children,
}: CollapsibleSidebarSectionProps) {
  const fullKey = `casemaker.sidebar.section.${storageKey}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(fullKey);
      if (stored === 'open') return true;
      if (stored === 'closed') return false;
    } catch {
      // ignore
    }
    return defaultOpen;
  });

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(fullKey, next ? 'open' : 'closed');
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={`sidebar-section sidebar-section--${open ? 'open' : 'closed'}`}
      data-testid={`sidebar-section-${storageKey}`}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="sidebar-section__header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 12px',
          background: '#1a1f25',
          border: '1px solid #2a2f36',
          borderRadius: 4,
          color: '#d1d5db',
          fontSize: 13,
          fontWeight: 600,
          textAlign: 'left',
          cursor: 'pointer',
          marginTop: 6,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 10,
            transition: 'transform 0.15s ease',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
        <span>{title}</span>
      </button>
      {open && (
        <div
          className="sidebar-section__body"
          style={{ paddingTop: 4 }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
