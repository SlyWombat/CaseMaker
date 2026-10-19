import { useEffect, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Issue #558 — the drag handle on the right rail's left edge. A thin, transparent strip that
 * straddles the grid line between the viewport and the context panel. Pointer capture keeps the
 * drag alive once the pointer leaves the 8px strip, and `dx` is fed back as a *delta* so this
 * component never needs to know the current width (no stale-closure window to cross).
 */
export function PanelResizeHandle({ onResize }: { onResize: (dx: number) => void }): JSX.Element {
  const lastX = useRef<number | null>(null);
  const onResizeRef = useRef(onResize);
  // Keep the latest callback without re-binding the pointer handlers each render; a ref may only be
  // written in an effect, not during render (#558 lint).
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return; // left button only
    e.preventDefault();
    lastX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Keep the resize cursor for the whole drag, even once the pointer has left the strip.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (lastX.current === null) return;
    const dx = e.clientX - lastX.current;
    lastX.current = e.clientX;
    if (dx !== 0) onResizeRef.current(dx);
  }

  function endDrag(): void {
    if (lastX.current === null) return;
    lastX.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  return (
    <div
      className="panel-resize-handle"
      data-testid="panel-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize the panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
