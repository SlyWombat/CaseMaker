import { useEffect } from 'react';
import {
  useViewportStore,
  type ViewportTool,
  type ViewportCameraMode,
  type ViewportViewMode,
  type ShellRenderMode,
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

// Issue #163 — shell/lid shading. Deliberately two states, not a slider:
// the useful answers are "show me the guts" and "show me the object", and a
// continuum just invites hunting for a value the pair already gives. Rendered
// as ONE icon button rather than a labelled pair — the toolbar already runs
// the full width of the viewport at 1024 px and a second text group pushed
// the layout into horizontal overflow.
const RENDER_HINT: Record<ShellRenderMode, string> = {
  xray: 'X-ray: translucent case — interior geometry (board standoffs, ribs) visible. Click for solid.',
  solid: 'Solid: opaque case — judge it as the object it will print as. Click for x-ray.',
};

const VIEW_MODES: { id: ViewportViewMode; label: string; shortcut: string; hint: string }[] = [
  { id: 'complete', label: 'Complete', shortcut: 'Shift+1', hint: 'Lid assembled — no exploded gap' },
  { id: 'exploded', label: 'Exploded', shortcut: 'Shift+2', hint: 'Lid lifted clear of all protrusions' },
  { id: 'base-only', label: 'Base', shortcut: 'Shift+3', hint: 'Hide the lid, show only the case' },
  { id: 'lid-only', label: 'Lid', shortcut: 'Shift+4', hint: 'Hide the case, show only the lid' },
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
  const viewMode = useViewportStore((s) => s.viewMode);
  const showBoard = useViewportStore((s) => s.showBoard);
  const setActiveTool = useViewportStore((s) => s.setActiveTool);
  const setCameraMode = useViewportStore((s) => s.setCameraMode);
  const setViewMode = useViewportStore((s) => s.setViewMode);
  const shellRender = useViewportStore((s) => s.shellRender);
  const setShellRender = useViewportStore((s) => s.setShellRender);

  // Keyboard shortcuts. Skip when the user is typing into a panel field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      // Issue #91 — Shift+1..4 cycle view modes (Complete / Exploded /
      // Base / Lid). Plain 1..4 stay reserved for camera-mode snap.
      if (e.shiftKey) {
        if (k === '1' || e.key === '!') setViewMode('complete');
        else if (k === '2' || e.key === '@') setViewMode('exploded');
        else if (k === '3' || e.key === '#') setViewMode('base-only');
        else if (k === '4' || e.key === '$') setViewMode('lid-only');
        else return;
        e.preventDefault();
        return;
      }
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
      } else if (k === 'x') {
        setShellRender(useViewportStore.getState().shellRender === 'xray' ? 'solid' : 'xray');
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveTool, setCameraMode, setViewMode, setShellRender, showBoard]);

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
      <div
        className="viewport-toolbar__group"
        role="radiogroup"
        aria-label="View mode"
      >
        {VIEW_MODES.map((v) => {
          const active = viewMode === v.id;
          return (
            <button
              key={v.id}
              type="button"
              className={`viewport-toolbar__btn viewport-toolbar__btn--text${active ? ' viewport-toolbar__btn--active' : ''}`}
              onClick={() => setViewMode(v.id)}
              role="radio"
              aria-checked={active}
              aria-label={v.label}
              title={`${v.hint} (${v.shortcut})`}
              data-testid={`viewport-view-${v.id}`}
            >
              {v.label}
            </button>
          );
        })}
      </div>
      <div className="viewport-toolbar__group">
        <button
          type="button"
          className={`viewport-toolbar__btn${shellRender === 'solid' ? ' viewport-toolbar__btn--active' : ''}`}
          onClick={() => setShellRender(shellRender === 'xray' ? 'solid' : 'xray')}
          aria-pressed={shellRender === 'solid'}
          aria-label={shellRender === 'solid' ? 'Solid shading' : 'X-ray shading'}
          title={`${RENDER_HINT[shellRender]} (X)`}
          data-testid="viewport-render-toggle"
          data-mode={shellRender}
        >
          {shellRender === 'solid' ? '◼' : '◻'}
        </button>
      </div>
    </div>
  );
}
