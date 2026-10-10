/**
 * The Manage surface's scopes rail (#311): House (Tools; Materials reserved) and Machines, with the
 * house service's own state in the foot.
 *
 * The foot is the one place in the app that states what the service IS rather than what it served —
 * present or absent, at which origin, how old the catalogue is, and whether the service reported a
 * problem with its own files. That is what someone debugging "why is my cutter not in the list"
 * reads first, so it is drawn rather than hidden behind a hover.
 *
 * MATERIALS IS DRAWN, NOT BUILT. It stays in the rail disabled and tagged `later`, which is what
 * the maintainer approved (#311 decision 3): the slot is reserved, and an empty scope pretending to
 * be a feature is exactly what the issue says not to build.
 */

import type { JSX } from 'react';
import { MACHINES } from '@/engine/cnc/machine';
import { houseBaseUrl, HOUSE_SCHEMA_VERSION } from '@/platform/houseClient';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { useMachineStore } from '@/store/machineStore';
import { useManageModeStore, type ManageScope } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { formatStamp } from './display';

/** The dot beside a rail row: what the app last concluded about that thing. */
function Dot({ state, title }: { state: 'ok' | 'off' | 'warn'; title: string }) {
  return <span className={`dot dot--${state}`} title={title} />;
}

export function ManageRail() {
  const scope = useManageModeStore((s) => s.scope);
  const setScope = useManageModeStore((s) => s.setScope);
  const status = useToolRegistryStore((s) => s.status);
  const health = useToolRegistryStore((s) => s.health);
  const machine = useMachineStore((s) => s.machine);
  const outcome = useMachineStore((s) => s.outcome);
  // The rail's count is every definition a job can name, so it reads the registry rather than the
  // service's tiers — the built-ins are two of them whether or not a service is there.
  const tools = useToolRegistry();

  const profile = machine?.profileId != null ? MACHINES[machine.profileId] : undefined;
  const machineLabel =
    machine === null ? 'No machine yet' : `${profile?.name ?? 'A controller'} · ${machine.host}`;

  const scopeButton = (id: ManageScope, icon: string, label: string, tail: JSX.Element) => (
    <button
      type="button"
      className={`nav${scope === id ? ' nav--active' : ''}`}
      data-testid={`manage-scope-${id}`}
      aria-current={scope === id ? 'page' : undefined}
      onClick={() => setScope(id)}
    >
      <span className="nav__icon">{icon}</span>
      <span>{label}</span>
      {tail}
    </button>
  );

  const syncedAt = formatStamp(health?.catalogueSyncedAt ?? null);

  return (
    <aside className="mrail" data-testid="manage-rail">
      <div className="nav__divider">House</div>
      {scopeButton(
        'tools',
        '🧰',
        'Tools',
        status === 'present' ? (
          <span className="nav__count" data-testid="manage-rail-tools-count">
            {tools.length}
          </span>
        ) : (
          // Absent means "no service reached", which is not a fault — the same quiet grey dot the
          // unchecked machine gets, never the warning colour (see `toolRegistryStore`).
          <Dot
            state={status === 'checking' ? 'warn' : 'off'}
            title={status === 'checking' ? 'asking this origin' : 'no house service'}
          />
        ),
      )}
      <button type="button" className="nav nav--later" disabled data-testid="manage-scope-materials">
        <span className="nav__icon">🧱</span>
        <span>Materials</span>
        <em>later</em>
      </button>

      <div className="nav__divider">Machines</div>
      {scopeButton(
        'machines',
        '🛠️',
        machineLabel,
        <Dot
          state={outcome === 'found' ? 'ok' : 'off'}
          title={
            outcome === null
              ? 'not checked in this build'
              : outcome === 'found'
                ? 'answered the last check'
                : 'did not answer the last check'
          }
        />,
      )}

      <div className="mrail__foot" data-testid="manage-rail-foot">
        house service ·{' '}
        <b data-testid="manage-service-state">
          {status === 'present' ? 'present' : status === 'checking' ? 'checking…' : 'absent'}
        </b>
        <br />
        {houseBaseUrl() || 'no page origin'}
        <br />
        {status === 'present' ? (
          <>
            {syncedAt === null ? 'no catalogue synced yet' : `catalogue synced ${syncedAt}`}
            {health !== null && health.feedRows > 0 ? ` · ${health.feedRows} feed rows` : ''}
            <br />
            schema v{health?.schemaVersion ?? HOUSE_SCHEMA_VERSION} ·{' '}
            {health === null || health.problems.length === 0
              ? 'no problems'
              : `${health.problems.length} problem${health.problems.length === 1 ? '' : 's'}`}
          </>
        ) : (
          <>built-ins only: 2</>
        )}
      </div>
    </aside>
  );
}
