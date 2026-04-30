import { useEffect } from 'react';
import {
  useViewportStore,
  type ViewportTool,
  type ViewportCameraMode,
} from '@/store/viewportStore';

/**
 * Issue #86 — floating toolbar overlay on the viewport. Two groups:
 * Tool selection (Select / Pan / Orbit) and Camera mode (Perspective /
 * Top / Front / Side). Wires keyboard shortcuts (S/P/O for tools,
 * 1/2/3/4 for camera modes) gated against input focus so they don't
 * fire while the user types into a panel.
 *
 * Select is plumbed but inert until #83 lands the actual click-to-pick
 * hit-testing on the board / HAT meshes; in the meantime its `disabled`
 * state mirrors the `showBoard` toggle and surfaces a tooltip explaining
 * why.
 */

const TOOLS: { id: ViewportTool; label: string; shortcut: string; icon: string }[] = [
  { id: 'select', label: 'Select', shortcut: 'S', icon: '◎' },
  { id: 'pan', label: 'Pan', shortcut: 'P', icon: '✥' },
  { id: 'orbit', label: 'Orbit', shortcut: 'O', icon: '↻' },
];

const CAMERAS: { id: ViewportCameraMode; label: string; shortcut: string }[] = [
  { id: 'perspective', label: 'Perspective', shortcut: '1' },
  { id: 'top', label: 'Top', shortcut: '2' },
  { id: 'front', label: 'Front', shortcut: '3' },
  { id: 'side', label: 'Side', shortcut: '4' },
];

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function ViewportToolbar() {
  const activeTool = useViewportStore((s) => s.activeTool);
  const cameraMode = useViewportStore((s) => s.cameraMode);
  const showBoard = useViewportStore((s) => s.showBoard);
  const setActiveTool = useViewportStore((s) => s.setActiveTool);
  const setCameraMode = useViewportStore((s) => s.setCameraMode);

  // Keyboard shortcuts. Skip when the user is typing into a panel field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        if (showBoard) setActiveTool('select');
      } else if (k === 'p') {
        setActiveTool('pan');
      } else if (k === 'o') {
        setActiveTool('orbit');
      } else if (k === '1') {
        setCameraMode('perspective');
      } else if (k === '2') {
        setCameraMode('top');
      } else if (k === '3') {
        setCameraMode('front');
      } else if (k === '4') {
        setCameraMode('side');
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveTool, setCameraMode, showBoard]);

  return (
    <div className="viewport-toolbar" data-testid="viewport-toolbar">
      <div className="viewport-toolbar__group" role="radiogroup" aria-label="Viewport tool">
        {TOOLS.map((t) => {
          const disabled = t.id === 'select' && !showBoard;
          const active = activeTool === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`viewport-toolbar__btn${active ? ' viewport-toolbar__btn--active' : ''}`}
              onClick={() => !disabled && setActiveTool(t.id)}
              disabled={disabled}
              role="radio"
              aria-checked={active}
              aria-disabled={disabled}
              aria-label={t.label}
              title={
                disabled
                  ? 'select a board (showBoard must be on)'
                  : `${t.label} (${t.shortcut})`
              }
              data-testid={`viewport-tool-${t.id}`}
            >
              <span aria-hidden="true">{t.icon}</span>
            </button>
          );
        })}
      </div>
      <div
        className="viewport-toolbar__group"
        role="radiogroup"
        aria-label="Camera mode"
      >
        {CAMERAS.map((c) => {
          const active = cameraMode === c.id;
          return (
            <button
              key={c.id}
              type="button"
              className={`viewport-toolbar__btn viewport-toolbar__btn--text${active ? ' viewport-toolbar__btn--active' : ''}`}
              onClick={() => setCameraMode(c.id)}
              role="radio"
              aria-checked={active}
              aria-label={c.label}
              title={`${c.label} (${c.shortcut})`}
              data-testid={`viewport-camera-${c.id}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
