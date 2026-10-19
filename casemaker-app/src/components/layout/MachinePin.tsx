import { useEffect, type JSX } from 'react';
import { MACHINES } from '@/engine/cnc/machine';
import { canDriveMachine } from '@/platform/capabilities';
import { startHeartbeat, stopHeartbeat } from '@/platform/machineHeartbeat';
import { useMachineNoticeStore } from '@/store/machineNoticeStore';
import { useMachineStore } from '@/store/machineStore';
import { formatStamp } from '../manage/display';

/**
 * #556 / #555 — the machine pinned in the left rail at all times.
 *
 * The Manage screen's machine entry (which machine + its dot) lives behind a mode the operator has
 * to navigate to; this is the same fact, pinned at the top of the Sidebar, so it is visible while
 * designing, during a sim/dry-run and during the final cut — the three surfaces where a silent LAN
 * drop otherwise goes unseen until a command times out.
 *
 * It also MOUNTS the heartbeat: the section lives for as long as the shell does, so the poll runs
 * wherever work happens, and unmounting it (Manage takes over the main area) stops the poll. The
 * dot and the "last seen" text are the heartbeat's live conclusion, not the last check's stale one;
 * the notice banner is the transition (#555) surfaced where the operator is already looking.
 */

/** One low-rate reachability poll for the remembered machine, for as long as this section is mounted. */
function useMachineHeartbeat(): void {
  const host = useMachineStore((s) => s.machine?.host ?? null);
  const port = useMachineStore((s) => s.machine?.port ?? null);
  useEffect(() => {
    if (!canDriveMachine || host === null || port === null) {
      stopHeartbeat();
      return;
    }
    startHeartbeat({ host, port });
    return () => stopHeartbeat();
  }, [host, port]);
}

type DotState = 'online' | 'offline' | 'unknown';

const DOT_COLOUR: Record<DotState, string> = {
  online: 'var(--cm-color-secondary)',
  offline: 'var(--cm-color-error)',
  unknown: '#5b6472',
};

export function MachinePin(): JSX.Element {
  useMachineHeartbeat();
  const machine = useMachineStore((s) => s.machine);
  const heartbeat = useMachineStore((s) => s.heartbeat);
  const notice = useMachineNoticeStore((s) => s.notice);
  const dismiss = useMachineNoticeStore((s) => s.dismiss);

  const profile = machine?.profileId != null ? MACHINES[machine.profileId] : undefined;
  const name = profile?.name ?? machine?.name ?? 'A controller';

  let dot: DotState;
  let dotTestId: string;
  let statusText: string;
  if (machine === null) {
    dot = 'unknown';
    dotTestId = 'machine-unknown';
    statusText = 'No machine yet';
  } else if (heartbeat.reachable === true) {
    dot = 'online';
    dotTestId = 'machine-online';
    statusText = 'Online';
  } else if (heartbeat.reachable === false) {
    dot = 'offline';
    dotTestId = 'machine-offline';
    statusText =
      heartbeat.lastSeenAt === null
        ? 'Offline'
        : `Offline · last seen ${formatStamp(heartbeat.lastSeenAt) ?? heartbeat.lastSeenAt}`;
  } else {
    dot = 'unknown';
    dotTestId = 'machine-unknown';
    statusText = 'Checking…';
  }

  const lastSeen = heartbeat.lastSeenAt === null ? null : (formatStamp(heartbeat.lastSeenAt) ?? heartbeat.lastSeenAt);

  return (
    <div
      data-testid="machine-pin"
      data-state={dot}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginBottom: 8,
        padding: '8px 10px',
        background: '#10151b',
        border: '1px solid #2a2f36',
        borderRadius: 4,
        fontSize: 12,
        color: '#d1d5db',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          data-testid={dotTestId}
          data-state={dot}
          role="img"
          aria-label={dot === 'online' ? 'Machine online' : dot === 'offline' ? 'Machine offline' : 'Machine not checked'}
          title={dot === 'online' ? 'reachable — the heartbeat answered' : dot === 'offline' ? 'unreachable — the heartbeat did not answer' : 'not checked yet'}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flex: 'none',
            background: DOT_COLOUR[dot],
            border: '1px solid rgba(0, 0, 0, 0.4)',
          }}
        />
        <span data-testid="machine-pin-name" style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {machine === null ? 'Machine' : name}
        </span>
        {machine !== null && (
          <span data-testid="machine-pin-host" style={{ fontFamily: 'var(--cm-font-mono)', fontSize: 10, color: '#8b95a3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {machine.host}
          </span>
        )}
        <span data-testid="machine-pin-status" style={{ marginLeft: 'auto', flex: 'none', fontSize: 11, color: dot === 'offline' ? 'var(--cm-color-error)' : '#8b95a3' }}>
          {statusText}
        </span>
      </div>

      {notice !== null && (
        <div
          data-testid="machine-notice"
          data-kind={notice.kind}
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            borderRadius: 3,
            fontSize: 11,
            background: notice.kind === 'offline' ? 'color-mix(in srgb, var(--cm-color-error) 14%, transparent)' : 'color-mix(in srgb, var(--cm-color-secondary) 14%, transparent)',
            border: `1px solid ${notice.kind === 'offline' ? 'color-mix(in srgb, var(--cm-color-error) 45%, transparent)' : 'color-mix(in srgb, var(--cm-color-secondary) 45%, transparent)'}`,
            color: notice.kind === 'offline' ? 'var(--cm-color-error)' : 'var(--cm-color-secondary)',
          }}
        >
          <span data-testid="machine-notice-text">
            {notice.kind === 'offline'
              ? `Machine went offline${lastSeen !== null ? ` · last seen ${lastSeen}` : ''}`
              : 'Machine back online'}
          </span>
          <button
            type="button"
            data-testid="machine-notice-dismiss"
            onClick={dismiss}
            aria-label="Dismiss"
            style={{
              marginLeft: 'auto',
              flex: 'none',
              padding: '0 4px',
              background: 'none',
              border: 'none',
              color: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
