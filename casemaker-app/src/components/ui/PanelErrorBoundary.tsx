import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { PANEL_RENDER_ERROR_CODE } from '@/engine/cnc/engrave/runSheet';
import { useEngraveRunStore } from '@/store/engraveRunStore';

/**
 * The panel's render boundary (#490).
 *
 * Found while gating #488: `validateJob` ran inside the Engrave panel's render, and a cold font
 * cache made `resolveFont` throw. React unmounted the panel — the whole rail went blank, the
 * setup hand-off never appeared, and nothing on screen said what happened. A boundary around the
 * panel body turns that into a sentence plus a way back in; the viewport and header keep working,
 * because only the section's own subtree is lost.
 *
 * The crash is also written to the engrave run store as a `SimDiagnostic`, which is the list the
 * run sheet already reads (#193, #204). That keeps `buildRunSheet` pure and the panel unchanged:
 * the sheet carries the crash with its warnings (`PANEL_RENDER_ERROR_CODE`).
 */

export interface PanelErrorBoundaryProps {
  /** The panel's name in words — used in the sentence, the diagnostic and the console line. */
  name: string;
  children: ReactNode;
  /** Optional seam for a host or a spec: called after the error is logged and recorded. */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

interface PanelErrorBoundaryState {
  error: unknown;
  /** React's component stack — present in dev, and kept out of the production sentence. */
  componentStack: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BOX: CSSProperties = {
  margin: 12,
  padding: 12,
  border: '1px solid #7a2828',
  borderRadius: 6,
  background: '#2a1416',
  color: '#f0b4ad',
  fontSize: 12,
  lineHeight: 1.5,
};

const SENTENCE: CSSProperties = { margin: '4px 0 8px', fontSize: 12 };

const STACK: CSSProperties = {
  maxHeight: 160,
  margin: '0 0 8px',
  overflow: 'auto',
  fontSize: 10,
  lineHeight: 1.35,
  whiteSpace: 'pre-wrap',
};

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  override state: PanelErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<PanelErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = errorMessage(error);
    // The component stack is the "where": React prints it with the error in dev, so the console
    // keeps the full trail even though production sentences only carry the message.
    if (import.meta.env.DEV) {
      console.error(
        `[${PANEL_RENDER_ERROR_CODE}] the ${this.props.name} failed to render: ${message}`,
        info.componentStack,
      );
    }
    this.setState({ componentStack: info.componentStack ?? null });
    // The same list the run sheet reads. `source` is the stage tag the type requires; neither the
    // parser, the runner nor the sweep raised this — the app's own render did — and `runner` is
    // the nearest of the three, with the code naming the real origin.
    useEngraveRunStore.getState().reportDiagnostic({
      source: 'runner',
      severity: 'error',
      code: PANEL_RENDER_ERROR_CODE,
      message: `${message} (${this.props.name})`,
    });
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div style={BOX} role="alert" data-testid="panel-error-boundary">
        <b>{this.props.name} could not be drawn.</b>
        <p style={SENTENCE} data-testid="panel-error-message">
          {errorMessage(this.state.error)}
        </p>
        {import.meta.env.DEV && this.state.componentStack !== null && (
          <details data-testid="panel-error-stack">
            <summary>Where it threw</summary>
            <pre style={STACK}>{this.state.componentStack}</pre>
          </details>
        )}
        <button type="button" data-testid="panel-error-reload" onClick={this.reset}>
          Reload the panel
        </button>
      </div>
    );
  }
}
