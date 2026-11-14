// #1258 — the tab question is the plan ASKING: it is not an error, and its sentence (written for a
// terminal, with the CLI's flags in it) is never what the run's gate or the preflight reads aloud.
import { describe, expect, it } from 'vitest';

import { firstRunError, runErrorCodes, type EngraveRunView } from '@/store/engraveRunGate';
import { FIXTURE_NEEDED } from '../tools/tabChoiceFixture';

const view = (generated: Record<string, unknown>): EngraveRunView =>
  ({ generated, simDiagnostics: [], phase: 'blocked' }) as unknown as EngraveRunView;

const CLI = 'Choose one: --tab-choice inside-margin or --tab-choice longer-stretch.';

describe('#1258 — the question is not an error', () => {
  it('a result that asks counts no error and has no first error', () => {
    const v = view({ ok: false, stage: 'cam', findings: [], errors: [{ stage: 'cam', message: CLI }], tabChoiceNeeded: FIXTURE_NEEDED });
    expect(runErrorCodes(v)).toEqual([]);
    expect(firstRunError(v)).toBeNull();
  });

  it('a genuine generate error still counts and is read', () => {
    const v = view({ ok: false, stage: 'cam', findings: [], errors: [{ stage: 'cam', message: 'planModelCam refused — nothing can free this part' }] });
    expect(runErrorCodes(v)).toEqual(['cam']);
    expect(firstRunError(v)?.message).toContain('nothing can free this part');
  });
});
