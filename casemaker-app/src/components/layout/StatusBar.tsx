import { featureSim } from '@/platform/features';
import { useJobStore } from '@/store/jobStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { DonateButton } from './DonateButton';

/**
 * #311 — what the Manage surface is looking at, in the bar. The mode's own panels say all of this a
 * panel at a time; the bar is the one place that answers "where am I, and what is the house" without
 * the user having to look at whichever scope happens to be open.
 *
 * The count is every definition a job can name, and it is read from the REGISTRY rather than added up
 * from the service's tiers. The built-ins are two definitions no service supplies, the inventory's
 * `inv:` rows are definitions too, and `entries.length + 2` counted neither: it said "4 definitions"
 * while the rail beside it said "5" — two counts of the same thing, disagreeing, on screen at once.
 */
function ManageStatus() {
  const status = useToolRegistryStore((s) => s.status);
  const tools = useToolRegistry().length;
  return (
    <span className="status-bar__manage" data-testid="status-bar-manage">
      manage · house:{' '}
      {status === 'present' ? 'present' : status === 'checking' ? 'checking' : 'absent'} ·{' '}
      {tools} definition{tools === 1 ? '' : 's'}
    </span>
  );
}

export function StatusBar() {
  const status = useJobStore((s) => s.status);
  const stats = useJobStore((s) => s.combinedStats);
  const duration = useJobStore((s) => s.durationMs);
  const error = useJobStore((s) => s.error);
  const manageRequested = useManageModeStore((s) => s.open);
  const manageOpen = featureSim && manageRequested;
  return (
    <footer className="status-bar" data-testid="status-bar" data-status={status}>
      <DonateButton variant="status" />
      {manageOpen && <ManageStatus />}
      <span className="status-bar__version" data-testid="app-version">
        V{__APP_VERSION__}
      </span>
      <span className="status-bar__engine">
        <span>{status === 'rebuilding' ? 'Rebuilding…' : status === 'error' ? `Error: ${error}` : 'Ready'}</span>
        {stats && (
          <span className="status-bar__stats">
            tris: {stats.triangleCount} · verts: {stats.vertexCount} · bbox{' '}
            {stats.bbox.min.map((v) => v.toFixed(1)).join(',')} → {stats.bbox.max.map((v) => v.toFixed(1)).join(',')} ·{' '}
            {duration.toFixed(0)}ms
          </span>
        )}
      </span>
    </footer>
  );
}
