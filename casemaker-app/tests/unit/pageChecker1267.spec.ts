/**
 * #1267 — THE PAGE CHECKER'S OWN TESTS RUN IN THE SUITE. `tools/test_goal_check.py` pins the v8 gate
 * rule the demo page's checker (`tools/goal_check.py`) applies — the plunge, the clean pocket, the
 * boundary-tangent contour, the relief ceiling, the silhouette proof and its witness, the straddling
 * proof, the who gate, the edge break — each with an answer known by hand. #1257's tool copy once
 * overwrote the checker and cut those tests without a red anywhere; this spec is the red.
 *
 * REQUIREMENT: the checker imports numpy and Pillow, which a bare `python3` does not have. The
 * interpreter is `CM_PYTHON` (the interpreter PATH, not a venv directory) when set, else `python3`.
 * dave-1: `CM_PYTHON=~/casemaker-manager/venv/bin/python`; k3: `~/v02-stage/venv/bin/python`.
 * There is no silent skip: when the interpreter cannot import both, the first test FAILS and says
 * how to fix it. The one way out is explicit — `CM_SKIP_PAGE_CHECKER=1` skips both tests and prints
 * why. Gate runs never set it.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOLS = join(__dirname, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'tools');
const PYTHON = process.env.CM_PYTHON || 'python3';
const SKIP = process.env.CM_SKIP_PAGE_CHECKER === '1';

const FIX =
  `The page checker's tests need numpy and Pillow. Point CM_PYTHON at an interpreter that has both ` +
  `(the interpreter path, not the venv directory): dave-1 ~/casemaker-manager/venv/bin/python, ` +
  `k3 ~/v02-stage/venv/bin/python. To run without them deliberately, set CM_SKIP_PAGE_CHECKER=1 ` +
  `(it prints why it skipped; gate runs never set it).`;

/** The interpreter's own failure, if it cannot import both, else null. */
function importProblem(): string | null {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy, PIL'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message: string };
    return err.code === 'ENOENT' ? `${PYTHON}: not found` : String(err.stderr || err.message).trim().split('\n').pop() ?? '';
  }
}

describe('#1267 the page checker and its pinned tests', () => {
  // The explicit opt-out is a RUNNING test that prints why, so a skip is visible in every report
  // (an all-skipped file prints nothing in vitest's summary).
  it.runIf(SKIP)('CM_SKIP_PAGE_CHECKER=1 — the page checker was NOT run', () => {
    console.warn(
      '#1267: CM_SKIP_PAGE_CHECKER=1 — the page checker (tools/goal_check.py) and its pinned tests ' +
        '(tools/test_goal_check.py) were NOT run. A gate run must not set this.',
    );
  });

  it.skipIf(SKIP)('the checker\'s Python can import numpy and Pillow', () => {
    const problem = importProblem();
    expect(problem, `${PYTHON} cannot import numpy/Pillow (${problem}). ${FIX}`).toBeNull();
  });

  it.skipIf(SKIP)('test_goal_check.py passes: every pinned fixture holds', () => {
    const out = execFileSync(PYTHON, [join(TOOLS, 'test_goal_check.py')], {
      cwd: TOOLS,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(out).toContain('all fixtures hold');
    // Each fixture prints "<name>: PASS"; none may print FAIL, and the ladder must not shrink below
    // the 25 fixtures pinned when this spec was written (a deleted test is a red, as in #1257).
    expect(out).not.toMatch(/: FAIL/);
    expect((out.match(/: PASS/g) ?? []).length).toBeGreaterThanOrEqual(25);
  });
});
