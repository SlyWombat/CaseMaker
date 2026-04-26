import { useEffect } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { schedule, scheduleImmediate } from '@/engine/jobs/JobScheduler';

export function useRebuildOnProjectChange(): void {
  useEffect(() => {
    void scheduleImmediate(useProjectStore.getState().project);
    const unsub = useProjectStore.subscribe(
      (s) => s.project,
      (project) => {
        schedule(project);
      },
    );
    return unsub;
  }, []);
}
