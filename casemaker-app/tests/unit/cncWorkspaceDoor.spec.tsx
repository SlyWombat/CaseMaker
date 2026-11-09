// @vitest-environment jsdom
/**
 * #1123 item 2 — ENTERING CNC LANDS IN THE CNC WORKSPACE; THE WIZARD IS AN OVERLAY ON IT.
 *
 * From the door, "Start a cutting job" used to leave the welcome page behind the wizard, so ✕ ("I
 * don't want the wizard, but I still want to CNC") put the operator back on the door with nowhere
 * to go. Entering CNC now makes the CNC workspace (the Job panel, on the last job's blank) the
 * screen, and the wizard opens over it. Closing the wizard leaves the operator on the Job panel,
 * where Open job…, the last jobs and Start a new job live.
 *
 * Red at the base: the click only flips the wizard's own boolean; `welcomeMode` stays true and the
 * door remains the screen behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { StartWizard } from '@/components/welcome/StartWizard';
import { WelcomeOverlay } from '@/components/welcome/WelcomeOverlay';
import { setEngravePreviewClientLoader } from '@/store/engravePreviewStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useProjectStore } from '@/store/projectStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { useViewportStore } from '@/store/viewportStore';

vi.mock('@/engine/jobs/JobScheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/jobs/JobScheduler')>();
  return {
    ...actual,
    scheduleImmediate: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Engrave panel is what AppShell draws for the CNC section; a jsdom test has no worker. */
const NO_PREVIEW = { engravePreview: async () => null };

/** The shell's own choice, reduced to the two screens this rule is about. */
function DoorHost() {
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  const open = useStartWizardStore((s) => s.open);
  return (
    <>
      {welcomeMode ? <WelcomeOverlay /> : <EngravePanel />}
      {open && <StartWizard />}
    </>
  );
}

beforeEach(() => {
  cleanup();
  resetStartWizard();
  useEngraveJobStore.getState().reset();
  useProjectStore.getState().showWelcome();
  useViewportStore.getState().setActiveSidebarSection(null);
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ boards: [] }),
    })),
  );
});

afterEach(() => {
  cleanup();
  setEngravePreviewClientLoader(null);
  vi.unstubAllGlobals();
});

describe('#1123 item 2 — the wizard is an overlay on the CNC workspace', () => {
  it('the CNC door leaves the door behind: the Job panel is under the wizard, and stays after ✕', () => {
    const before = useProjectStore.getState().project;
    render(<DoorHost />);

    fireEvent.click(screen.getByTestId('welcome-start-cnc'));

    // Entering CNC IS entering the workspace…
    expect(useStartWizardStore.getState().open).toBe(true);
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
    expect(screen.queryByTestId('welcome-overlay')).toBeNull();
    expect(screen.getByTestId('engrave-panel')).toBeTruthy();
    // …and the project is the one that was there, object for object: entering CNC never replaces
    // it (the wizard's stock step is where a new job's blank project is made, after its question).
    expect(useProjectStore.getState().project).toBe(before);

    // ✕ puts the wizard away, not the operator: the Job panel remains the screen.
    fireEvent.click(screen.getByTestId('start-wizard-close'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    expect(screen.getByTestId('engrave-panel')).toBeTruthy();
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });

  it('a real project behind the door is kept, not replaced, when CNC is entered', () => {
    // The review's hypothetical: welcomeMode on over an enclosure. No shipped path produces this
    // (New resets the project; boot starts on the placeholder), but entering CNC must not be able
    // to eat an enclosure if one ever is.
    act(() => {
      useProjectStore.getState().loadBuiltinBoard('rpi-4b');
      useProjectStore.setState({ welcomeMode: true });
    });
    const real = useProjectStore.getState().project;
    render(<DoorHost />);

    fireEvent.click(screen.getByTestId('welcome-start-cnc'));

    expect(useProjectStore.getState().project).toBe(real);
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });

  it('a starter takes the same route: the workspace is entered at the press', () => {
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-starter-blank'));
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });
});
