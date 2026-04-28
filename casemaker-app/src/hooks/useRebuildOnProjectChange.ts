import { useEffect } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { schedule, scheduleImmediate } from '@/engine/jobs/JobScheduler';

export function useRebuildOnProjectChange(): void {
  useEffect(() => {
    // Issue #69 — don't burn worker cycles compiling the placeholder
    // default project before the user has picked anything.
    if (!useProjectStore.getState().welcomeMode) {
      void scheduleImmediate(useProjectStore.getState().project);
    }
    const unsub = useProjectStore.subscribe(
      (s) => s.project,
      (project) => {
        if (useProjectStore.getState().welcomeMode) return;
        schedule(project);
      },
    );
    return unsub;
  }, []);
}
