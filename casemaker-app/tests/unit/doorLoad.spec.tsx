// @vitest-environment jsdom
/**
 * #1122 — THE DOOR'S LOAD ROUTES BY FILE KIND. The maintainer pressed Load with a
 * `.cutjob.json` and got a raw Zod dump across the top bar; the only way to a job was to click
 * through four wizard steps. Load must open a job directly (its blank project, the job, the Job
 * panel), leave a project exactly as it was, and refuse anything else in one sentence — never the
 * schema.
 *
 * Red at the base: the job file goes through `parseProject` and paints the Zod text; the door has
 * no Open-a-job control at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Toolbar } from '@/components/layout/Toolbar';
import { WelcomeOverlay } from '@/components/welcome/WelcomeOverlay';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { serializeJobFile } from '@/engine/cnc/engrave/jobFile';
import { serializeProject } from '@/store/projectFile';
import { resetEngraveJobFileStore } from '@/store/engraveJobFileStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';

vi.mock('@/engine/jobs/JobScheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/jobs/JobScheduler')>();
  return { ...actual, scheduleImmediate: vi.fn(async () => {}) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB = { ...defaultEngraveJob(), name: 'Door-loaded job' };

beforeEach(() => {
  cleanup();
  resetEngraveJobFileStore();
  useEngraveJobStore.getState().reset();
  useProjectStore.getState().showWelcome();
  useViewportStore.getState().setActiveSidebarSection(null);
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
  vi.unstubAllGlobals();
});

function pick(inputId: string, text: string, name: string): void {
  fireEvent.change(screen.getByTestId(inputId), {
    target: { files: [new File([text], name, { type: 'application/json' })] },
  });
}

const ZOD = /invalid_type|ZodError|Unrecognized key|Required/;

async function expectJobOpen(): Promise<void> {
  await waitFor(() => expect(useProjectStore.getState().welcomeMode).toBe(false));
  expect(useEngraveJobStore.getState().job.name).toBe(JOB.name);
  expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  expect(document.body.textContent ?? '').not.toMatch(ZOD);
}

describe('#1122 the door Load opens a cutting job file too', () => {
  it('a .cutjob.json opens as a job — the job set, its blank built, the Job panel active, no schema text', async () => {
    render(<Toolbar />);
    pick('load-project-input', serializeJobFile(JOB), 'door.cutjob.json');
    await expectJobOpen();
  });

  it('a .caseproj.json still opens as a project', async () => {
    const project = useProjectStore.getState().project;
    render(<Toolbar />);
    pick('load-project-input', serializeProject(project), 'door.caseproj.json');
    await waitFor(() => expect(useProjectStore.getState().welcomeMode).toBe(false));
    expect(useProjectStore.getState().project.name).toBe(project.name);
    expect(useEngraveJobStore.getState().job.name).not.toBe(JOB.name);
    expect(document.body.textContent ?? '').not.toMatch(ZOD);
  });

  it('a .txt gets one sentence, never a schema dump', async () => {
    render(<Toolbar />);
    pick('load-project-input', 'this is not JSON at all', 'notes.txt');
    await waitFor(() =>
      expect(document.body.textContent ?? '').toMatch(/neither a project nor a job/i),
    );
    expect(document.body.textContent ?? '').not.toMatch(ZOD);
    expect(document.body.textContent ?? '').not.toMatch(/Unexpected token/i);
  });

  it('Open a job on the door opens a job in one click', async () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByTestId('open-job-door'));
    pick('open-job-door-input', serializeJobFile(JOB), 'door.cutjob.json');
    await expectJobOpen();
  });

  it('a job file dropped on the door opens as a job', async () => {
    render(<WelcomeOverlay />);
    const file = new File([serializeJobFile(JOB)], 'dropped.cutjob.json', {
      type: 'application/json',
    });
    fireEvent.drop(screen.getByTestId('welcome-overlay'), {
      dataTransfer: { files: [file] },
    });
    await expectJobOpen();
  });
});
