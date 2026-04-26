import { useProjectStore } from '@/store/projectStore';
import { useJobStore } from '@/store/jobStore';
import { exportStl, exportThreeMf } from '@/engine/jobs/workerClient';
import { scheduleImmediate, waitForIdle } from '@/engine/jobs/JobScheduler';
import type { StlMeshInput } from '@/workers/export/stlBinary';

function downloadBlob(buf: ArrayBuffer, filename: string, mime: string): void {
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function triggerExport(format: 'stl' | '3mf'): Promise<void> {
  const project = useProjectStore.getState().project;
  await scheduleImmediate(project);
  await waitForIdle();
  const nodes = useJobStore.getState().nodes;
  const meshes: StlMeshInput[] = [];
  for (const n of nodes.values()) {
    meshes.push({ positions: n.buffer.positions, indices: n.buffer.indices });
  }
  if (meshes.length === 0) throw new Error('No mesh available to export');
  const safeName = project.name.replace(/[^a-z0-9-_]+/gi, '_');
  if (format === 'stl') {
    const buf = await exportStl(meshes);
    downloadBlob(buf, `${safeName}.stl`, 'model/stl');
  } else {
    const buf = await exportThreeMf(meshes);
    downloadBlob(buf, `${safeName}.3mf`, 'model/3mf');
  }
}
