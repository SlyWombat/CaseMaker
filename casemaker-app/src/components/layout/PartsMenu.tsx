import { useEffect, useRef, useState } from 'react';
import { useJobStore } from '@/store/jobStore';
import { useViewportStore } from '@/store/viewportStore';
import { partsForIds, partsByCategory, type PartCategory } from '@/engine/exporters/parts';

const CATEGORY_LABELS: Record<PartCategory, string> = {
  case: 'Case',
  gasket: 'Gasket',
  fastener: 'Fasteners',
  accessory: 'Accessories',
};

/**
 * Issue #120 — visibility pulldown that lists every top-level node in the
 * current BuildPlan with a checkbox. Replaces the Show-board / Show-lid
 * toggles in the Toolbar. Categories: Case → Gasket → Fasteners →
 * Accessories.
 */
export function PartsMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Subscribe to the Map ref (only changes when nodes are added/removed),
  // then derive the id list in the component body. Selecting an Array.from
  // result inside the selector returns a fresh array every render and
  // triggers React's "max update depth exceeded" infinite loop guard
  // (memory: Zustand `?? []` selector trap).
  const nodes = useJobStore((s) => s.nodes);
  const nodeIds = Array.from(nodes.keys());
  const hiddenParts = useViewportStore((s) => s.hiddenParts);
  const togglePart = useViewportStore((s) => s.togglePartVisible);
  const showAllParts = useViewportStore((s) => s.showAllParts);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  const parts = partsForIds(nodeIds);
  const grouped = partsByCategory(parts);
  const hiddenCount = parts.filter((p) => hiddenParts.has(p.id)).length;
  const total = parts.length;

  return (
    <div className="parts-menu-wrap" ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="parts-menu-toggle"
        title="Show / hide parts in the 3D viewport"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        👁 Parts {hiddenCount > 0 ? `(${total - hiddenCount}/${total})` : ''}
      </button>
      {open && (
        <div
          className="parts-menu-panel"
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 100,
            background: '#14181c',
            border: '1px solid #2a2f36',
            borderRadius: 4,
            padding: '6px 8px',
            minWidth: 200,
            fontSize: 12,
            color: '#d1d5db',
          }}
        >
          {parts.length === 0 ? (
            <div style={{ padding: '4px 6px', color: '#6b7280' }}>(no parts yet)</div>
          ) : (
            <>
              {grouped.map((g) => (
                <div key={g.category} style={{ margin: '4px 0' }}>
                  <div
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      color: '#6b7280',
                      letterSpacing: '0.05em',
                      padding: '2px 4px',
                    }}
                  >
                    {CATEGORY_LABELS[g.category]}
                  </div>
                  {g.parts.map((p) => {
                    const visible = !hiddenParts.has(p.id);
                    return (
                      <label
                        key={p.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 4px',
                          cursor: 'pointer',
                        }}
                        title={p.material === 'flex' ? 'Flex (TPU)' : 'Rigid (PLA/PETG/ABS)'}
                      >
                        <input
                          type="checkbox"
                          checked={visible}
                          onChange={() => togglePart(p.id)}
                          data-testid={`part-visible-${p.id}`}
                        />
                        <span>{p.displayName}</span>
                        {p.material === 'flex' && (
                          <span style={{ fontSize: 9, color: '#d4af37' }}>flex</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              ))}
              {hiddenCount > 0 && (
                <button
                  onClick={showAllParts}
                  style={{
                    marginTop: 4,
                    width: '100%',
                    background: 'transparent',
                    border: '1px solid #2a2f36',
                    color: '#d1d5db',
                    padding: '4px 6px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                  data-testid="parts-show-all"
                >
                  Show all
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
