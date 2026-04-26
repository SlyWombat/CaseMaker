import { useJobStore } from '@/store/jobStore';

export function StatusBar() {
  const status = useJobStore((s) => s.status);
  const stats = useJobStore((s) => s.combinedStats);
  const duration = useJobStore((s) => s.durationMs);
  const error = useJobStore((s) => s.error);
  return (
    <footer className="status-bar" data-testid="status-bar" data-status={status}>
      <span>{status === 'rebuilding' ? 'Rebuilding…' : status === 'error' ? `Error: ${error}` : 'Ready'}</span>
      {stats && (
        <span>
          tris: {stats.triangleCount} · verts: {stats.vertexCount} · bbox{' '}
          {stats.bbox.min.map((v) => v.toFixed(1)).join(',')} → {stats.bbox.max.map((v) => v.toFixed(1)).join(',')} ·{' '}
          {duration.toFixed(0)}ms
        </span>
      )}
    </footer>
  );
}
