// @vitest-environment jsdom
// #662 — the wizard's first question. A job with nothing to cut opens on "What are you cutting?";
// picking a type CREATES that operation and hands on to the setup questions. An established job
// skips the question, and a pick that needs a file (Surface a mesh) asks the panel that owns the
// input rather than pretending the wizard can read one.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveSetupFlow } from '@/components/panels/EngraveSetupFlow';
import { setOperationIntake } from '@/components/panels/operationIntake';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The default job with every operation removed — a job nobody has said what to cut yet. */
function emptyJob(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    traces: [],
    drills: [],
    threads: [],
    primitives: [],
    cutouts: [],
    vectors: [],
  };
}

beforeEach(() => {
  act(() => {
    useEngraveJobStore.setState({ job: emptyJob() });
  });
});

afterEach(() => {
  cleanup();
  setOperationIntake(null);
});

describe('#662 the wizard’s first question', () => {
  it('opens on what to cut, offers every type, and creates the pick', () => {
    render(<EngraveSetupFlow onClose={() => {}} />);
    expect(screen.getByTestId('engrave-setup-step-title').textContent).toBe('What are you cutting?');

    for (const type of ['engrave', 'v-carve', 'pocket', 'profile', 'hole', 'thread', 'surface']) {
      expect(screen.getByTestId(`engrave-setup-what-${type}`)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId('engrave-setup-what-engrave'));
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(1);
    // The setup questions follow the operation: the first one is the holding question.
    expect(screen.getByTestId('engrave-setup-step-title').textContent).toBe('What is holding the part?');
    expect(screen.queryByTestId('engrave-setup-step-what')).toBeNull();
  });

  it('skips the question for a job that already has an operation', () => {
    act(() => {
      useEngraveJobStore.setState({ job: defaultEngraveJob() });
    });
    render(<EngraveSetupFlow onClose={() => {}} />);
    expect(screen.getByTestId('engrave-setup-step-title').textContent).toBe('What is holding the part?');
    expect(screen.queryByTestId('engrave-setup-step-what')).toBeNull();
  });

  it('asks the panel for the one pick that needs a file, and closes', () => {
    const asked: string[] = [];
    setOperationIntake((type) => asked.push(type));
    const onClose = vi.fn();
    render(<EngraveSetupFlow onClose={onClose} />);
    fireEvent.click(screen.getByTestId('engrave-setup-what-surface'));
    expect(asked).toEqual(['surface']);
    expect(onClose).toHaveBeenCalled();
    // No operation was invented from a pick that could not read a file.
    expect(useEngraveJobStore.getState().job.labels ?? []).toHaveLength(0);
  });
});
