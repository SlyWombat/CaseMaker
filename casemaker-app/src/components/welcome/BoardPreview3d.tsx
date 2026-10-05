import { Component, Suspense, lazy, type CSSProperties, type ReactNode } from 'react';
import type { BoardProfile } from '@/types';

/**
 * #130 — optional tiny 3D preview for a board that ships a `visualAssets.glb`.
 * Renders the GLB in the detail rail; falls back to whatever `fallback` the
 * caller passes (the synthesised `BoardPreviewSvg`) when the board has no GLB,
 * when the runtime has no WebGL, or when the model fails to load.
 *
 * The three.js renderer lives in `BoardPreview3dCanvas` and is `lazy()`-loaded
 * only when this path is taken, so the welcome screen's main chunk stays free
 * of `three` / react-three. No board carries a GLB yet — every candidate
 * licence in `src/docs/board-assets.md` is still pending, and this repo bundles
 * only licence-cleared assets — so this is the mount point, not a shipped view.
 */

const LazyCanvas = lazy(() =>
  import('./BoardPreview3dCanvas').then((m) => ({ default: m.BoardPreview3dCanvas })),
);

/** Whether the runtime can create a WebGL context — false under jsdom/SSR and
 * on machines with no GPU/software GL. Probed once and cached. */
let webglSupport: boolean | null = null;
function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  // jsdom/SSR declare no WebGLRenderingContext and answer getContext() with a
  // "not implemented" warning, so short-circuit before touching a canvas.
  if (typeof document === 'undefined' || typeof WebGLRenderingContext === 'undefined') {
    return (webglSupport = false);
  }
  try {
    const canvas = document.createElement('canvas');
    webglSupport = Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/** A failed GLB load (bad URL, CORS, no WebGL after all) drops to the caller's
 * fallback rather than blanking the rail. */
class PreviewErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const WRAP_STYLE: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  minHeight: 0,
};
const CANVAS_BOX_STYLE: CSSProperties = { flex: '1 1 auto', width: '100%', minHeight: 0 };
const CREDIT_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 9,
  lineHeight: 1.2,
  opacity: 0.65,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function BoardPreview3d({
  board,
  fallback,
}: {
  board: BoardProfile;
  /** Shown whenever the 3D path is unavailable — pass the synthesised SVG. */
  fallback: ReactNode;
}) {
  const glb = board.visualAssets?.glb;
  if (!glb || !hasWebGL()) return <>{fallback}</>;
  return (
    <PreviewErrorBoundary fallback={fallback}>
      <span style={WRAP_STYLE} data-testid="board-preview-3d">
        <span style={CANVAS_BOX_STYLE}>
          <Suspense fallback={null}>
            <LazyCanvas url={glb} />
          </Suspense>
        </span>
        <span style={CREDIT_STYLE} data-testid="board-preview-credit">
          {board.visualAssets?.license}
          {board.visualAssets?.sourceUrl ? ` · ${board.visualAssets.sourceUrl}` : ''}
        </span>
      </span>
    </PreviewErrorBoundary>
  );
}
