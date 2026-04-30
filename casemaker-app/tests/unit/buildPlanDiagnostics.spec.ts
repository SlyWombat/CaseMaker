import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { useJobStore } from '@/store/jobStore';

describe('BuildPlan carries diagnostics (#51)', () => {
  it('compileProject returns smartCutoutDecisions and placementReport on the plan', () => {
    const project = createDefaultProject('rpi-4b');
    const plan = compileProject(project);
    expect(plan.smartCutoutDecisions).toBeDefined();
    expect(Array.isArray(plan.smartCutoutDecisions)).toBe(true);
    expect(plan.placementReport).toBeDefined();
    expect(plan.placementReport!.issues).toBeDefined();
  });

  it('jobStore exposes diagnostics fields (placementReport + smartCutoutDecisions)', () => {
    const s = useJobStore.getState();
    // Default values until first compile + worker round-trip lands.
    expect(s.placementReport).toBeNull();
    expect(s.smartCutoutDecisions).toEqual([]);
    // applyResult accepts the diagnostics payload and stores it.
    s.applyResult(
      1,
      [],
      { vertexCount: 0, triangleCount: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] } },
      0,
      undefined,
      {
        placementReport: { issues: [], errorCount: 0, warningCount: 0 },
        smartCutoutDecisions: [],
      },
    );
    expect(useJobStore.getState().placementReport).toEqual({
      issues: [],
      errorCount: 0,
      warningCount: 0,
    });
  });

  it('compileProject does NOT mutate module-level state (issue #51 root cause)', () => {
    // Each call returns its own plan with its own decisions; nothing leaks
    // across calls. Two compiles with different boards produce two plans
    // with their own decision arrays.
    const a = compileProject(createDefaultProject('rpi-4b'));
    const b = compileProject(createDefaultProject('arduino-giga-r1-wifi'));
    expect(a.smartCutoutDecisions).not.toBe(b.smartCutoutDecisions);
  });
});
